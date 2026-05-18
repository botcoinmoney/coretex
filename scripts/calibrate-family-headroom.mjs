#!/usr/bin/env node
/**
 * Calibration Run 3 — per-family lift curve, feasible-upper-bound substrate.
 *
 * Spec: docs/CORETEX_SUBSTRATE_EXPANSION_HARDENING.md §5 Run 3.
 *
 * For each query family, measures the composite gap between an empty
 * substrate and a feasibly-best substrate (anchors + lenses + relations
 * within the actual slot inventory: 44 MemoryIndex + 36 RetrievalKey +
 * 128 Relations + Phase B category-lens). The gap is the per-family
 * HEADROOM the substrate can realistically fill at launch — if it's
 * smaller than 2 × baselineVariancePpm, the family weight is too small
 * relative to noise.
 *
 * Feasible-upper-bound substrate construction:
 *   1. From the calibration pack, identify the top-44 most-frequently-
 *      referenced ENTITIES (events that questions point at via
 *      event.relations). Anchor each in a MemoryIndex slot with shared
 *      domainBits so anchor-to-anchor edges survive §6.4.
 *   2. Set 36 retrieval-key lens vectors to those 36 anchors' truth-doc
 *      embeddings (diverse entities span the BGE-M3 manifold; passes
 *      §6.4 lens-diversity floor).
 *   3. 3 category-lens entries (derived_from, supports, supersedes) +
 *      anchor-to-anchor edges for the rest of the 128-entry budget,
 *      domain-share-share-valid.
 *
 * Usage:
 *   CORETEX_RERANKER=qwen3 CORETEX_RERANKER_PRODUCTION=1 \
 *   CORETEX_RERANKER_MODE=streaming \
 *   CORETEX_RERANKER_PYTHON=/root/cortex/.venv/bin/python \
 *   HF_HUB_CACHE=/var/lib/coretex/model-cache HF_HUB_OFFLINE=1 \
 *     node --max-old-space-size=16384 scripts/calibrate-family-headroom.mjs \
 *       --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *       --bundle-profile /etc/coretex/bundle-profile.json \
 *       --pack-size 32 \
 *       --reranker env \
 *       --out /var/lib/coretex/reports/family-headroom.json
 */

import { distIndex } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const packSize = Number(flag('pack-size', '32'));
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/family-headroom.json');
const seedHex = flag('seed', '0x' + 'cc'.repeat(32));

function fail(msg, code = 1) { console.error(`[run3-headroom] ${msg}`); exit(code); }
if (!corpusPath || !existsSync(corpusPath)) fail(`--corpus missing or not found: ${corpusPath}`);

const {
  loadProductionCorpus, evaluateRetrievalBenchmarkState,
  biEncoderModelIdHash, rerankerFromEnv, biEncoderFromEnv,
  createDeterministicReranker, createDeterministicBiEncoder,
  encodeMemoryIndexSlot, encodeRetrievalKeySlot,
  encodeRelationEdge, encodeRelationCategoryLens,
  stableRecordIdFor,
  DEFAULT_PROFILE,
} = await import(distIndex);

const profile = profilePath && existsSync(profilePath)
  ? JSON.parse(readFileSync(profilePath, 'utf8'))
  : DEFAULT_PROFILE;

console.log(`[run3-headroom] loading corpus`);
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });

const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);
const ZERO_STATE = { words: new Array(1024).fill(0n) };

let reranker, biEncoder;
if (rerankerArg === 'env') {
  console.log(`[run3-headroom] reranker from env...`);
  reranker = await rerankerFromEnv();
  biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });
} else {
  reranker = await createDeterministicReranker();
  biEncoder = createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT });
}
console.log(`[run3-headroom] reranker: ${reranker.model}`);

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
  lensWeight: profile.lensWeight ?? 0.10,
  anchorWeight: profile.anchorWeight ?? 0.15,
  relationExpansionBudget: profile.relationExpansionBudget ?? 50,
  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.10,
  temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.10,
  lensDiversityFloor: profile.lensDiversityFloor,
  pipelineVersion: profile.pipelineVersion,
};

const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672 };

// Use canonical stableRecordIdFor imported below — NOT a sha256 local copy.

// Build feasible-upper-bound substrate from a family's pack.
function buildFeasibleUpperBound(packEvents, family) {
  const words = new Array(1024).fill(0n);
  // Identify top-N referenced entities from the pack's event.relations
  const refCounts = new Map();
  for (const ev of packEvents) {
    if (!ev.relations) continue;
    for (const rel of ev.relations) refCounts.set(rel.other_id, (refCounts.get(rel.other_id) ?? 0) + 1);
  }
  const topEntities = Array.from(refCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 44)
    .map(([id]) => id);

  // Find the entity events in the corpus
  const entityEvents = topEntities.map((id) => corpus.byId.get(id)).filter(Boolean).slice(0, 44);

  // Encode anchors (MemoryIndex slots 0..n-1)
  const sharedDomain = 1n; // domain-share for relation-edge predicate
  for (let i = 0; i < entityEvents.length; i++) {
    const ev = entityEvents[i];
    const slot = {
      slotIndex: i,
      recordId: stableRecordIdFor(ev.id),
      family: ev.family,
      domainBits: sharedDomain,
      valid: true,
      revoked: false,
      protected: ev.protected ?? false,
      retrievalSlot: i % 36,
      expiryEpoch: 0n,
    };
    const w = encodeMemoryIndexSlot(slot);
    const base = RANGES.MEMORY_INDEX_START + i * 8;
    for (let j = 0; j < 8; j++) words[base + j] = w[j];
  }

  // Encode retrieval keys (truth-doc embeddings of the first 36 entities)
  for (let i = 0; i < Math.min(36, entityEvents.length); i++) {
    const ev = entityEvents[i];
    const truth = ev.truthDocuments.find((t) => t.isCurrent) ?? ev.truthDocuments[0];
    if (!truth) continue;
    const emb = ev.embeddings.perTruth.get(truth.id);
    if (!emb) continue;
    const key = {
      slotIndex: i,
      modelIdHash: biEncoderHash,
      l2Norm: 1.0,
      versionTag: 1,
      quantizedBytes: emb,
    };
    const w = encodeRetrievalKeySlot(key, { retrievalKeyHeaderBytes: LAYOUT.headerBytes });
    const base = RANGES.RETRIEVAL_KEYS_START + i * 8;
    for (let j = 0; j < 8; j++) words[base + j] = w[j];
  }

  // Encode 3 category-lens entries (one per edgeType seen in the corpus)
  const lenses = [
    { entryIndex: 0, edgeType: 'derived_from', weight: 0xFFFF },
    { entryIndex: 1, edgeType: 'supports', weight: 0xFFFF },
    { entryIndex: 2, edgeType: 'supersedes', weight: 0xFFFF },
  ];
  for (const l of lenses) words[RANGES.RELATIONS_START + l.entryIndex] = encodeRelationCategoryLens(l);

  // Use the remaining 125 relation entries as a chain of anchor-to-anchor
  // 'supports' edges so the anchor BFS also activates.
  for (let i = 0; i < Math.min(125, entityEvents.length - 1); i++) {
    const edge = {
      entryIndex: 3 + i,
      sourceSlot: i,
      targetSlot: (i + 1) % entityEvents.length,
      edgeType: 'supports',
      weight: 100,
    };
    words[RANGES.RELATIONS_START + edge.entryIndex] = encodeRelationEdge(edge);
  }

  return { words };
}

function buildPackForFamily(fam) {
  const events = corpus.events.filter((e) => e.family === fam && e.split === 'eval_hidden');
  if (events.length === 0) return null;
  const scored = events.map((e) => ({
    e,
    s: parseInt(createHash('sha256').update(seedHex + ':' + e.id).digest('hex').slice(0, 8), 16) / 0xffffffff,
  }));
  scored.sort((a, b) => a.s - b.s);
  return {
    epochId: 0,
    evalSeedCommit: seedHex,
    events: scored.slice(0, packSize).map((x) => x.e),
  };
}

const families = ['near_collision', 'temporal', 'long_horizon', 'multi_hop_relation'];
const results = [];
for (const fam of families) {
  const pack = buildPackForFamily(fam);
  if (!pack) { console.log(`  skip ${fam} (no events)`); continue; }
  console.error(`\n[run3-headroom] family=${fam} pack=${pack.events.length}`);

  const tEmpty = Date.now();
  const emptyScore = await evaluateRetrievalBenchmarkState(ZERO_STATE, corpus, pack, opts);
  const tEmptyMs = Date.now() - tEmpty;
  console.error(`  empty: composite=${emptyScore.composite.toFixed(4)} nDCG=${emptyScore.nDCG10.toFixed(4)} (${tEmptyMs} ms)`);

  const featState = buildFeasibleUpperBound(pack.events, fam);
  const tFeat = Date.now();
  const featScore = await evaluateRetrievalBenchmarkState(featState, corpus, pack, opts);
  const tFeatMs = Date.now() - tFeat;
  console.error(`  feasible: composite=${featScore.composite.toFixed(4)} nDCG=${featScore.nDCG10.toFixed(4)} (${tFeatMs} ms)`);

  const headroomPpm = Math.round((featScore.composite - emptyScore.composite) * 1_000_000);
  console.error(`  HEADROOM = ${headroomPpm} ppm`);

  results.push({
    family: fam,
    packSize: pack.events.length,
    emptyComposite: emptyScore.composite,
    feasibleComposite: featScore.composite,
    headroomPpm,
    emptyNDCG10: emptyScore.nDCG10,
    feasibleNDCG10: featScore.nDCG10,
    elapsedMs: { empty: tEmptyMs, feasible: tFeatMs },
  });
}

const report = {
  schemaVersion: 'coretex.family-headroom.v1',
  generatedAt: new Date().toISOString(),
  inputs: {
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    bundleProfile: profilePath ?? null,
    rerankerMode: rerankerArg,
    rerankerModel: reranker.model,
    packSize,
  },
  perFamily: results,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\n[run3-headroom] report → ${reportPath}`);
for (const r of results) {
  console.log(`  ${r.family.padEnd(22)} headroom=${r.headroomPpm} ppm  (empty=${r.emptyComposite.toFixed(4)} → feasible=${r.feasibleComposite.toFixed(4)})`);
}
exit(0);
