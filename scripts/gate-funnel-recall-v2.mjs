#!/usr/bin/env node
/**
 * Gate G1+G2 v2 — candidate-funnel recall using the FULL canonical scorer.
 *
 * v1 of this script re-implemented stage-1 + anchor BFS locally and forgot
 * Phase B's category-lens BFS expansion (the substrate's corpus-scale
 * routing lever). Result: engineered substrate produced near-zero lift
 * for hard families because Phase B never fired.
 *
 * v2 calls evaluateRetrievalBenchmarkState directly with a deterministic
 * reranker (constant-time hash scores; no Qwen3 inference needed because
 * we're measuring candidate POOL composition, not final ranking quality).
 * This activates the production pipeline INCLUDING:
 *   - stage-1 BGE-M3 cosine top-K
 *   - anchor BFS expansion (relation edges in substrate)
 *   - Phase B category-lens BFS (bidirectional, edgeType-filtered, BFS
 *     from stage-1 candidates following corpus-native relations whose
 *     edgeType matches a substrate category-lens entry)
 *   - lens-bonus / anchor-bonus / temporal modulation
 *   - §6.5 reranker-input cap at `rerankerInputTopK`
 *
 * For each query, we check whether the truth doc's `rerankerScore !== 0`
 * in the ranked output — non-reranked docs (those past the cap) get
 * sentinel rerankerScore=0 per the §6.5 implementation.
 *
 * Engineered substrate v2:
 *   - 30 anchors at pack events (MemoryIndex)
 *   - 30 lens vectors = truth embeddings (RetrievalKeys)
 *   - 8 anchor-to-anchor relation edges (Relations entries 0..7)
 *   - 3 category-lens entries at the end of Relations region (entries 125-127):
 *     "supports", "supersedes", "derived_from" — all three corpus edgeTypes
 *
 * PASS criteria (per family):
 *   long_horizon / multi_hop_relation:  engineered_recall@cap >= 0.50
 *   near_collision / temporal:          engineered_recall@cap >= max(empty, 0.80)
 */
import { distIndex } from './_repo-root.mjs';
import { profileAttestation } from './lib/profile-attestation.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit, env } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const queriesPerFamily = Number(flag('queries-per-family', '30'));
const reportPath = flag('out', '/var/lib/coretex/reports/gate-g1-g2-v2-funnel-recall.json');
const seedHex = flag('seed', '0x' + 'bb'.repeat(32));

function fail(msg, code = 1) { console.error(`[gate-v2] ${msg}`); exit(code); }
if (!corpusPath || !existsSync(corpusPath)) fail(`--corpus missing or not found: ${corpusPath}`);

const {
  loadProductionCorpus,
  evaluateRetrievalBenchmarkState,
  biEncoderModelIdHash,
  biEncoderFromEnv,
  createDeterministicReranker,
  encodeMemoryIndexSlot,
  encodeRetrievalKeySlot,
  encodeRelationEdge,
  encodeRelationCategoryLens,
  stableRecordIdFor,
  DEFAULT_PROFILE,
} = await import(distIndex);

console.error(`[gate-v2] loading corpus ${corpusPath}`);
const t0 = Date.now();
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.error(`  loaded ${corpus.events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const profile = profilePath && existsSync(profilePath)
  ? JSON.parse(readFileSync(profilePath, 'utf8')).profile
  : DEFAULT_PROFILE;

const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);

const biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });
const reranker = await createDeterministicReranker();

console.error(`[gate-v2] cap=${profile.rerankerInputTopK} firstStageTopK=${profile.firstStageTopK} lensW=${profile.lensWeight} anchorW=${profile.anchorWeight}`);

const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672 };
const ZERO_STATE = { words: new Array(1024).fill(0n) };

// Use canonical stableRecordIdFor (keccak256-based) — NOT a local sha256 copy.
// The scorer's anchorSlotToEvent map keys on stableRecordIdFor(event.id);
// using a different hash makes engineered anchors invisible.
function buildEngineeredState(pack) {
  if (pack.length > 36) throw new Error(`pack ${pack.length} > 36`);
  const words = new Array(1024).fill(0n);
  const sharedDomain = 1n;

  for (let i = 0; i < pack.length; i++) {
    const ev = pack[i];
    const memSlot = {
      slotIndex: i,
      recordId: stableRecordIdFor(ev.id),
      family: ev.family,
      domainBits: sharedDomain,
      valid: true, revoked: false, protected: ev.protected ?? false,
      retrievalSlot: i, expiryEpoch: 0n,
    };
    const memWords = encodeMemoryIndexSlot(memSlot);
    const base = RANGES.MEMORY_INDEX_START + i * 8;
    for (let j = 0; j < 8; j++) words[base + j] = memWords[j];

    const truth = ev.truthDocuments.find((t) => t.isCurrent) ?? ev.truthDocuments[0];
    const emb = ev.embeddings.perTruth.get(truth.id);
    if (!emb) continue;
    const keySlot = { slotIndex: i, modelIdHash: biEncoderHash, l2Norm: 1.0, versionTag: 1, quantizedBytes: emb };
    const keyWords = encodeRetrievalKeySlot(keySlot, { retrievalKeyHeaderBytes: LAYOUT.headerBytes });
    const kbase = RANGES.RETRIEVAL_KEYS_START + i * 8;
    for (let j = 0; j < 8; j++) words[kbase + j] = keyWords[j];
  }

  // Anchor-to-anchor relation edges (entries 0..7)
  const nEdges = Math.min(8, pack.length - 1);
  for (let i = 0; i < nEdges; i++) {
    const edge = { entryIndex: i, sourceSlot: i, targetSlot: (i + 1) % pack.length, edgeType: 'supports', weight: 1 };
    words[RANGES.RELATIONS_START + i] = encodeRelationEdge(edge);
  }
  // Phase B category-lens entries (placed at end of Relations region 125..127)
  const CATEGORY_EDGES = ['supports', 'supersedes', 'derived_from'];
  for (let i = 0; i < CATEGORY_EDGES.length; i++) {
    const lens = { entryIndex: 128 - 1 - i, edgeType: CATEGORY_EDGES[i], weight: 0x8000 };
    words[RANGES.RELATIONS_START + (128 - 1 - i)] = encodeRelationCategoryLens(lens);
  }
  return { words };
}

function familyPack(family, packSize) {
  const events = corpus.events.filter((e) => e.family === family && e.split === 'calibration');
  if (events.length === 0) return [];
  const scored = events.map((e) => ({
    e, s: parseInt(createHash('sha256').update(seedHex + ':' + e.id).digest('hex').slice(0, 8), 16) / 0xffffffff,
  }));
  scored.sort((a, b) => a.s - b.s);
  return scored.slice(0, packSize).map((x) => x.e);
}

// Use the full scorer (deterministic reranker, fast).
const opts = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  biEncoder, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: profile.relationHopBudget ?? 2,
  abstentionThreshold: profile.abstentionThreshold ?? 0.001,
  rerankerTopK: profile.rerankerTopK ?? 10,
  retrievalKeyTopK: profile.retrievalKeyTopK ?? 50,
  firstStageTopK: profile.firstStageTopK ?? 3200,
  rerankerInputTopK: profile.rerankerInputTopK ?? 128,
  lensTopK: profile.lensTopK ?? 36,
  lensWeight: profile.lensWeight ?? 0.025,
  anchorWeight: profile.anchorWeight ?? 0.0375,
  relationExpansionBudget: profile.relationExpansionBudget ?? 12,
  categoryLensExpansionBudget: profile.categoryLensExpansionBudget ?? profile.relationExpansionBudget ?? 50,
  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.1,
  temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.1,
  lensDiversityFloor: profile.lensDiversityFloor,
  pipelineVersion: profile.pipelineVersion,
};

async function recallForPack(state, pack) {
  let truthsHit = 0, truthsTotal = 0;
  for (let i = 0; i < pack.length; i++) {
    const ev = pack[i];
    const singlePack = { epochId: 0, evalSeedCommit: seedHex, events: [ev] };
    const score = await evaluateRetrievalBenchmarkState(state, corpus, singlePack, opts);
    const pq = score.perQuery?.[0];
    if (!pq) { console.error(`  query ${ev.id}: no perQuery`); continue; }
    const capSet = new Set(pq.cappedDocIds ?? []);
    for (const t of ev.truthDocuments) {
      truthsTotal++;
      if (capSet.has(t.id)) truthsHit++;
    }
    if ((i + 1) % 10 === 0) console.error(`  pack ${i + 1}/${pack.length} done`);
  }
  return { truthsHit, truthsTotal };
}

const FAMILIES = ['temporal', 'near_collision', 'multi_hop_relation', 'long_horizon'];
const results = [];
for (const family of FAMILIES) {
  const pack = familyPack(family, queriesPerFamily);
  if (pack.length === 0) { console.error(`  skip ${family}`); continue; }
  console.error(`[gate-v2] === family=${family} (${pack.length} queries) ===`);

  const tG1 = Date.now();
  const g1 = await recallForPack(ZERO_STATE, pack);
  const g1_recall = g1.truthsTotal > 0 ? g1.truthsHit / g1.truthsTotal : 0;
  console.error(`  G1 empty       recall@cap = ${(g1_recall*100).toFixed(1)}% (${g1.truthsHit}/${g1.truthsTotal}, ${((Date.now()-tG1)/1000).toFixed(1)}s)`);

  const engState = buildEngineeredState(pack);
  const tG2 = Date.now();
  const g2 = await recallForPack(engState, pack);
  const g2_recall = g2.truthsTotal > 0 ? g2.truthsHit / g2.truthsTotal : 0;
  console.error(`  G2 engineered  recall@cap = ${(g2_recall*100).toFixed(1)}% (${g2.truthsHit}/${g2.truthsTotal}, ${((Date.now()-tG2)/1000).toFixed(1)}s)`);

  let pass;
  if (family === 'long_horizon' || family === 'multi_hop_relation') pass = g2_recall >= 0.50;
  else pass = g2_recall >= Math.max(g1_recall, 0.80);
  console.error(`  PASS=${pass}\n`);
  results.push({
    family, queriesScored: pack.length,
    emptySubstrate: { recall: g1_recall, ...g1 },
    engineeredSubstrate: { recall: g2_recall, ...g2 },
    lift: g2_recall - g1_recall, pass,
  });
}

const allPass = results.every((r) => r.pass);
const report = {
  schemaVersion: 'coretex.gate-g1-g2-funnel-recall.v2',
  generatedAt: new Date().toISOString(),
  inputs: {
    corpus: corpusPath, corpusRoot: corpus.corpusRoot, eventCount: corpus.events.length,
    bundleProfile: profilePath,
    profileAttestation: profileAttestation(profile, profilePath),
    rerankerInputTopK: opts.rerankerInputTopK, firstStageTopK: opts.firstStageTopK,
    lensWeight: opts.lensWeight, anchorWeight: opts.anchorWeight,
    relationExpansionBudget: opts.relationExpansionBudget,
    queriesPerFamily, seedHex,
    rerankerKind: 'deterministic-mock',
    note: 'Uses full evaluateRetrievalBenchmarkState pipeline (stage-1 + anchor BFS + Phase B category-lens BFS) with a deterministic reranker. We check whether the truth doc made the rerankerInputTopK cap, not the final reranker score.',
  },
  perFamily: results,
  allFamiliesPass: allPass,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.error(`[gate-v2] report → ${reportPath}`);
console.error(`[gate-v2] OVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
exit(allPass ? 0 : 2);
