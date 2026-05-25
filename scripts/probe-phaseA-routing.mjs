#!/usr/bin/env node
/**
 * Phase A relation-routing compile-check (teacher -> substrate -> source attribution).
 *
 * Teacher trace (proposer-visible): "answer event A is reachable from a non-answer
 * bridge B via a corpus relation edgeType T". Compiler writes: anchor B (a NON-answer
 * memory) + a substrate relation edge from B's slot carrying edgeType T. The fixed
 * Phase A then follows B's corpus relations of type T -> A and injects A's truth via
 * anchorBFS. We verify A's relevant truth enters TOP-10 via anchorBFS — NOT
 * anchorMandatory, and with NO direct answer-alias anchoring.
 *
 *   --mode oracle   : pick bridge B from the full corpus graph (mechanism test).
 *   --mode visible  : bridge B must be train_visible/calibration (proposer-visible).
 *
 * Pass: relevant top-10 via anchorBFS > 0, and the answer is NOT carried by anchorMandatory.
 */
import { distIndex } from './_repo-root.mjs';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';

function flag(n, fb) { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; }
const corpusPath = flag('corpus', '/var/lib/coretex/corpus-epoch-0-calibration-relation-qrels.json');
const profilePath = flag('bundle-profile', 'release/bundle/evaluator-profile-v2-dgen1-deep-r1.json');
const packSplit = flag('split', 'eval_hidden');
const packSize = Number(flag('pack-size', '10'));
const family = flag('family', 'multi_hop_relation');
const seedHex = flag('seed', '0x' + 'c7'.repeat(32));
const rerankerArg = flag('reranker', 'deterministic');
const mode = flag('mode', 'oracle');
const reportPath = flag('out', `/var/lib/coretex/reports/phaseA-routing-${family}-${mode}.json`);
if (!existsSync(corpusPath)) { console.error('corpus missing'); exit(1); }

const {
  loadProductionCorpus, evaluateRetrievalBenchmarkState, biEncoderModelIdHash,
  createDeterministicBiEncoder, createDeterministicReranker, rerankerFromEnv,
  encodeMemoryIndexSlot, encodeRelationEdge, stableRecordIdFor, DEFAULT_PROFILE,
} = await import(distIndex);

const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(corpus.biEncoderModelId, corpus.biEncoderRevision, 'dense');
const prof = profilePath && existsSync(profilePath)
  ? (() => { const r = JSON.parse(readFileSync(profilePath, 'utf8')); return r.profile ?? r; })()
  : DEFAULT_PROFILE;

const eventById = new Map(corpus.events.map((e) => [e.id, e]));
const docOwner = new Map();
for (const e of corpus.events) for (const t of e.truthDocuments) docOwner.set(t.id, e.id);
// inbound[targetEventId] = [{src, edgeType}]
const inbound = new Map();
for (const e of corpus.events) for (const r of (e.relations ?? [])) {
  if (!inbound.has(r.other_id)) inbound.set(r.other_id, []);
  inbound.get(r.other_id).push({ src: e.id, edgeType: r.edgeType });
}

function shaIdx(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff; return h >>> 0; }
const cands = corpus.events.filter((e) => e.family === family && Array.isArray(e.relations) && e.relations.length > 0 && (!packSplit || e.split === packSplit));
const pack = cands.map((e) => ({ e, s: shaIdx(seedHex + ':' + e.id) })).sort((a, b) => a.s - b.s).slice(0, packSize).map((x) => x.e);
console.log(`[phaseA] corpus ${corpus.events.length}; family=${family} split=${packSplit}; pack=${pack.length}; mode=${mode}`);

// For a query, pick a NON-answer bridge B with B --edgeType--> A (A a relevant event).
function pickBridge(q) {
  const relset = new Set(q.qrels.filter((r) => r.relevance === 1).map((r) => r.documentId));
  const relevantEvents = new Set([...relset].map((d) => docOwner.get(d)).filter(Boolean));
  for (const A of relevantEvents) {
    for (const { src, edgeType } of (inbound.get(A) ?? [])) {
      if (src === q.id) continue; // exclude the query's own edge (would be a direct answer route)
      const B = eventById.get(src);
      if (!B) continue;
      // B must be a NON-answer event (its truths not relevant to q)
      if (B.truthDocuments.some((t) => relset.has(t.id))) continue;
      if (mode === 'visible' && !(B.split === 'train_visible' || B.split === 'calibration' || B.split === 'canary')) continue;
      return { B, A, edgeType, relset };
    }
  }
  return null;
}

const RANGES = { MEMORY_INDEX_START: 32, RELATIONS_START: 672 };
function buildState(B) {
  const words = new Array(1024).fill(0n);
  // anchor B at slot 0
  const mw = encodeMemoryIndexSlot({ slotIndex: 0, recordId: stableRecordIdFor(B.id), family: B.family, domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n });
  for (let j = 0; j < 8; j++) words[RANGES.MEMORY_INDEX_START + j] = mw[j];
  return words;
}
function addEdge(words, edgeType) { words[RANGES.RELATIONS_START + 0] = encodeRelationEdge({ entryIndex: 0, sourceSlot: 0, targetSlot: 0, edgeType, weight: 1 }); }

const biEncoder = createDeterministicBiEncoder({ modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, layout: LAYOUT });
const reranker = rerankerArg === 'env' ? await rerankerFromEnv() : await createDeterministicReranker();
const baseOpts = {
  weights: prof.compositeWeights ?? DEFAULT_PROFILE.compositeWeights, biEncoder, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: prof.relationHopBudget ?? 2, abstentionThreshold: prof.abstentionThreshold ?? 0.001, rerankerTopK: prof.rerankerTopK ?? 10,
  retrievalKeyTopK: prof.retrievalKeyTopK ?? 50, firstStageTopK: prof.firstStageTopK ?? 3200, rerankerInputTopK: prof.rerankerInputTopK ?? 128,
  lensTopK: prof.lensTopK ?? 36, lensWeight: prof.lensWeight ?? 0.4, anchorWeight: prof.anchorWeight ?? 0.6,
  relationExpansionBudget: prof.relationExpansionBudget ?? 12, categoryLensExpansionBudget: 0,
  temporalCurrentBoost: prof.temporalCurrentBoost ?? 0.1, temporalStaleSuppression: prof.temporalStaleSuppression ?? 0.1,
  lensDiversityFloor: prof.lensDiversityFloor, pipelineVersion: prof.pipelineVersion,
};

let withBridge = 0, routedAnchorBFS = 0, routedTop10ViaAnchorBFS = 0, mandatoryCarried = 0;
const rows = [];
for (const q of pack) {
  const bridge = pickBridge(q);
  if (!bridge) { rows.push({ q: q.id.slice(-36), bridge: null }); continue; }
  withBridge++;
  const { B, A, edgeType, relset } = bridge;
  const pack1 = { epochId: 0, evalSeedCommit: seedHex, events: [q] };
  // OFF: anchor B only (no relation edge). ON: anchor B + relation edge edgeType.
  const wOff = buildState(B);
  const wOn = buildState(B); addEdge(wOn, edgeType);
  const off = await evaluateRetrievalBenchmarkState({ words: wOff }, corpus, pack1, baseOpts);
  const on = await evaluateRetrievalBenchmarkState({ words: wOn }, corpus, pack1, baseOpts);
  const onTop = (on.perQuery?.[0]?.finalRankingTop20 ?? []);
  // relevant docs in top-10 reached via anchorBFS but NOT anchorMandatory
  const relViaBFS = onTop.filter((r) => r.rank <= 10 && r.relevance === 1 && (r.sources ?? []).includes('anchorBFS') && !(r.sources ?? []).includes('anchorMandatory'));
  const relViaMandatory = onTop.filter((r) => r.rank <= 10 && r.relevance === 1 && (r.sources ?? []).includes('anchorMandatory'));
  const anyBFS = onTop.some((r) => (r.sources ?? []).includes('anchorBFS'));
  if (anyBFS) routedAnchorBFS++;
  if (relViaBFS.length > 0) routedTop10ViaAnchorBFS++;
  if (relViaMandatory.length > 0) mandatoryCarried++;
  rows.push({ q: q.id.slice(-36), bridge: B.id.slice(-30), edgeType, A: A.slice(-30),
    relViaAnchorBFS_top10: relViaBFS.map((r) => ({ docId: r.docId.slice(-28), rank: r.rank })),
    relViaMandatory_top10: relViaMandatory.length, off_composite: +off.composite.toFixed(4), on_composite: +on.composite.toFixed(4) });
}
await reranker.close?.();
console.log(`[phaseA] queries with a non-answer bridge: ${withBridge}/${pack.length}`);
console.log(`[phaseA] queries where anchorBFS fired: ${routedAnchorBFS}`);
console.log(`[phaseA] queries with RELEVANT top-10 via anchorBFS (not mandatory): ${routedTop10ViaAnchorBFS}`);
console.log(`[phaseA] queries where mandatory carried a relevant top-10: ${mandatoryCarried}`);
for (const r of rows) console.log('  ' + JSON.stringify(r));
const report = { schemaVersion: 'coretex.phaseA-routing.v1', generatedAt: new Date().toISOString(), mode, reranker: rerankerArg,
  family, split: packSplit, packSize: pack.length, withBridge, routedAnchorBFS, routedTop10ViaAnchorBFS, mandatoryCarried, rows };
mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[phaseA] report -> ${reportPath}`);
exit(0);
