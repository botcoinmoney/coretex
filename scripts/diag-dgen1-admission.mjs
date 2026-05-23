#!/usr/bin/env node
/**
 * Direct admission diagnostic: does categoryLensBFS actually admit the bridge ANSWER
 * into the rerank cap for DGEN-1 relation queries? Builds the production corpus, encodes
 * the relation substrate (supports/causes/supersedes/coreference_of lenses), runs the
 * real scorer with a deterministic reranker, and for each relation query dumps:
 *   - is the bridge SEED in stage-1 / cap? at what rank?
 *   - is the ANSWER in the cap? via which sources? preRankScore?
 * Isolates: lens decoded? bridge seed a BFS seed? edge followed? answer admitted to cap?
 */
import { distIndex } from './_repo-root.mjs';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const { scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState, createDeterministicReranker,
  encodeRelationCategoryLens, decodeSubstrate, RANGES } = await import(distIndex);

const args = process.argv.slice(2);
const corpusPath = args[0] ?? 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-smoke-corpus.json';
const embPath = (() => { const i = args.indexOf('--emb'); return i >= 0 ? args[i + 1] : 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-smoke-embeddings.json'; })();
const seedTopK = (() => { const i = args.indexOf('--seed-topk'); return i >= 0 ? Number(args[i + 1]) : 8; })();
const alpha = (() => { const i = args.indexOf('--alpha'); return i >= 0 ? Number(args[i + 1]) : 0.3; })();
const profile = JSON.parse(readFileSync('release/bundle/evaluator-profile-v2-ownerscope-r1.json', 'utf8'));
const { corpus, logical, LAYOUT, BE, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));

// relation substrate (same as p05 relationSubstrate)
const words = new Array(1024).fill(0n);
['supports', 'causes', 'supersedes', 'coreference_of'].forEach((et, i) => {
  words[RANGES.RELATIONS_START + (128 - 1 - i)] = encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: et, weight: 0x8000 });
});
const state = { words };
// sanity: decode the lenses
try { const dec = decodeSubstrate(state); console.log('decoded categoryLenses:', JSON.stringify((dec.categoryLenses ?? []).map((l) => ({ e: l.edgeType, w: l.weight })))); } catch (e) { console.log('decode err', e.message); }

const reranker = await createDeterministicReranker();
const opts = { ...scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT }),
  rerankerInputTopK: 64, ownerScopeMode: 'restrict', categoryLensExpansionBudget: 50, categoryLensTraversalDirection: 'bidirectional',
  categoryLensSeedTopK: seedTopK, categoryLensFinalBonusWeight: 0, categoryLensScoreInheritance: alpha, categoryLensBonusWeight: 4.0, firstStageTopK: 3200 };

const seedHex = '0x' + createHash('sha256').update('adm:diag').digest('hex');
const ac = { ...corpus, byId: corpus.byId };
const pack = deriveQueryPack(1, seedHex, ac, { ...profile.hiddenPack, packSize: 24 });
const cs = await evaluateRetrievalBenchmarkState(state, ac, pack, opts);

let n = 0, seedInStage1 = 0, seedInCap = 0, ansInCap = 0, ansViaLens = 0;
const samples = [];
for (const pq of cs.perQuery) {
  const lq = logicalQById.get(pq.recordId); if (!lq) continue;
  const bridgeId = (lq.qrels ?? []).find((r) => r.role === 'bridge')?.docId;
  const ansId = (lq.qrels ?? []).find((r) => r.role === 'direct')?.docId;
  if (!bridgeId || !ansId) continue;
  n++;
  const capIds = pq.cappedDocIds ?? [];
  const capSrc = pq.cappedDocSources ?? [];
  const capComp = pq.cappedDocComponents ?? [];
  const bridgeMem = bridgeId, ansMem = ansId;
  const bIdx = capIds.indexOf(bridgeMem), aIdx = capIds.indexOf(ansMem);
  if (bIdx >= 0) seedInCap++;
  if (aIdx >= 0) { ansInCap++; if ((capSrc[aIdx] ?? []).includes('categoryLensBFS')) ansViaLens++; }
  // answer's FINAL ranking position (does inheritance lift it?). finalRankingTop20 carries rank.
  const ansFinal = (pq.finalRankingTop20 ?? []).find((r) => r.docId === ansMem);
  const ansFinalRank = ansFinal ? ansFinal.rank : '>20';
  if (samples.length < 6) samples.push({ q: pq.recordId, answerInCap: aIdx >= 0 ? `cap-rank${aIdx}` : 'NO', answerFinalRank: ansFinalRank });
}
let ansTop10 = 0; for (const pq of cs.perQuery) { const lq = logicalQById.get(pq.recordId); if (!lq) continue; const ansId = (lq.qrels ?? []).find((r) => r.role === 'direct')?.docId; if (!ansId) continue; const af = (pq.finalRankingTop20 ?? []).find((r) => r.docId === ansId); if (af && af.rank <= 10) ansTop10++; }
console.log(JSON.stringify({ relationQueries: n, seedTopK, alpha, bridgeSeedInCapRate: +(seedInCap / n).toFixed(3), answerInCapRate: +(ansInCap / n).toFixed(3), answerInCapViaLensRate: +(ansViaLens / n).toFixed(3), answerFinalTop10Rate: +(ansTop10 / n).toFixed(3), samples }, null, 2));
if (typeof reranker.close === 'function') reranker.close();
