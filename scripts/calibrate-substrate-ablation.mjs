#!/usr/bin/env node
/**
 * Substrate channel ablation matrix.
 *
 * Stage-2 sweeps one scalar at a time while the others remain at the
 * profile baseline. That cannot answer "which substrate channel is
 * actually doing the work?" — anchor, lens, and relation contributions
 * interact, and a large composite gap may be entirely anchor-driven
 * even when the lens scalar is non-zero.
 *
 * This script holds the scalars fixed (at the profile baseline) and
 * varies which CHANNELS the engineered substrate populates. Seven cells
 * plus an empty control:
 *
 *   empty                — control (no substrate)
 *   anchor-only          — MemoryIndex slots only
 *   lens-only            — RetrievalKeys slots only
 *   relation-only        — Relations region only (degenerate without anchors;
 *                          included so the no-op baseline is measured)
 *   anchor+lens
 *   anchor+relation
 *   lens+relation
 *   all-on               — full engineered substrate (parity with stage-2)
 *
 * Reports composite AND ranking-quality metrics (nDCG@10, MRR@10,
 * Recall@10) per cell. A large composite lift with mediocre ranking
 * quality means the substrate bonus is overpowering the reranker;
 * pinning that configuration would mask reasoning ability rather than
 * surface it.
 *
 * Usage:
 *   node --max-old-space-size=24576 scripts/calibrate-substrate-ablation.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *     --bundle-profile /etc/coretex/bundle-profile-launch-v3.json \
 *     --reranker env \
 *     --out /var/lib/coretex/reports/substrate-ablation.json
 *
 * Exit codes:
 *   0 = report written
 *   1 = harness/input error
 *   2 = no cell produced a measurable gap (substrate has no lever)
 */
import { distIndex } from './_repo-root.mjs';
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
const packSize = Number(flag('pack-size', '8'));
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/substrate-ablation.json');
const seedHex = flag('seed', '0x' + 'a7'.repeat(32));

function fail(msg, code = 1) { console.error(`[ablation] ${msg}`); exit(code); }
if (!corpusPath || !existsSync(corpusPath)) fail(`--corpus missing or not found: ${corpusPath}`);

const {
  loadProductionCorpus,
  evaluateRetrievalBenchmarkState,
  deriveQueryPack,
  biEncoderModelIdHash,
  createDeterministicBiEncoder,
  createDeterministicReranker,
  rerankerFromEnv,
  biEncoderFromEnv,
  encodeMemoryIndexSlot,
  encodeRetrievalKeySlot,
  encodeRelationEdge,
  encodeRelationCategoryLens,
  stableRecordIdFor,
  DEFAULT_PROFILE,
} = await import(distIndex);
const { buildProvenance } = await import('./calibration-provenance.mjs');

console.log(`[ablation] loading corpus ${corpusPath}`);
const t0 = Date.now();
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.log(`  loaded ${corpus.events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const profile = profilePath && existsSync(profilePath)
  ? (() => { const r = JSON.parse(readFileSync(profilePath, 'utf8')); return r.profile ?? r; })()
  : DEFAULT_PROFILE;

const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);

let reranker, biEncoder;
if (rerankerArg === 'env') {
  reranker = await rerankerFromEnv();
  biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });
} else {
  reranker = await createDeterministicReranker();
  biEncoder = createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT });
}
console.log(`[ablation] reranker: ${reranker.model}`);

// Same pack derivation as stage-2 sweep so cells are directly
// comparable to that report.
const pack = deriveQueryPack(0, seedHex, corpus, { packSize, quotas: [] });
console.log(`[ablation] pack size=${pack.events.length} from ${seedHex}`);

const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672 };
const EMPTY_WORDS = new Array(1024).fill(0n);

function buildState({ anchors, lenses, relations }) {
  const words = [...EMPTY_WORDS];
  const sharedDomain = 1n;
  for (let i = 0; i < pack.events.length; i++) {
    const ev = pack.events[i];
    if (anchors) {
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
    }
    if (lenses) {
      const truth = ev.truthDocuments.find((t) => t.isCurrent) ?? ev.truthDocuments[0];
      const emb = ev.embeddings.perTruth.get(truth.id);
      if (emb) {
        const keySlot = { slotIndex: i, modelIdHash: biEncoderHash, l2Norm: 1.0, versionTag: 1, quantizedBytes: emb };
        const keyWords = encodeRetrievalKeySlot(keySlot, { retrievalKeyHeaderBytes: LAYOUT.headerBytes });
        const kbase = RANGES.RETRIEVAL_KEYS_START + i * 8;
        for (let j = 0; j < 8; j++) words[kbase + j] = keyWords[j];
      }
    }
  }
  if (relations) {
    const nEdges = Math.min(8, pack.events.length - 1);
    for (let i = 0; i < nEdges; i++) {
      const edge = { entryIndex: i, sourceSlot: i, targetSlot: (i + 1) % pack.events.length, edgeType: 'supports', weight: 1 };
      words[RANGES.RELATIONS_START + i] = encodeRelationEdge(edge);
    }
    const CATEGORY_EDGES = ['supports', 'supersedes', 'derived_from'];
    for (let i = 0; i < CATEGORY_EDGES.length; i++) {
      const lens = { entryIndex: 128 - 1 - i, edgeType: CATEGORY_EDGES[i], weight: 0x8000 };
      words[RANGES.RELATIONS_START + (128 - 1 - i)] = encodeRelationCategoryLens(lens);
    }
  }
  return { words };
}

const opts = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  biEncoder, reranker,
  retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: profile.relationHopBudget ?? 3,
  abstentionThreshold: profile.abstentionThreshold ?? 0.001,
  rerankerTopK: profile.rerankerTopK ?? 10,
  retrievalKeyTopK: profile.retrievalKeyTopK ?? 50,
  firstStageTopK: profile.firstStageTopK ?? 3200,
  rerankerInputTopK: profile.rerankerInputTopK ?? 128,
  lensTopK: profile.lensTopK ?? 36,
  lensWeight: profile.lensWeight ?? 0.4,
  anchorWeight: profile.anchorWeight ?? 0.6,
  relationExpansionBudget: profile.relationExpansionBudget ?? 12,
  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.1,
  temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.1,
  lensDiversityFloor: profile.lensDiversityFloor,
  pipelineVersion: profile.pipelineVersion,
};

const cells = [
  { name: 'empty',           anchors: false, lenses: false, relations: false },
  { name: 'anchor-only',     anchors: true,  lenses: false, relations: false },
  { name: 'lens-only',       anchors: false, lenses: true,  relations: false },
  { name: 'relation-only',   anchors: false, lenses: false, relations: true  },
  { name: 'anchor+lens',     anchors: true,  lenses: true,  relations: false },
  { name: 'anchor+relation', anchors: true,  lenses: false, relations: true  },
  { name: 'lens+relation',   anchors: false, lenses: true,  relations: true  },
  { name: 'all-on',          anchors: true,  lenses: true,  relations: true  },
];

function perFamilyMeans(perQuery) {
  const buckets = {};
  for (const q of perQuery) {
    const fam = q.family ?? 'unknown';
    if (!buckets[fam]) buckets[fam] = { ndcg: [], mrr: [], rec: [] };
    buckets[fam].ndcg.push(q.nDCG10 ?? 0);
    buckets[fam].mrr.push(q.mrr10 ?? 0);
    buckets[fam].rec.push(q.recall10 ?? 0);
  }
  const out = {};
  for (const [fam, b] of Object.entries(buckets)) {
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    out[fam] = { nDCG10: mean(b.ndcg), mrr10: mean(b.mrr), recall10: mean(b.rec), n: b.ndcg.length };
  }
  return out;
}

const results = [];
let emptyComposite = null;
for (const cell of cells) {
  const tStart = Date.now();
  const state = buildState(cell);
  const score = await evaluateRetrievalBenchmarkState(state, corpus, pack, opts);
  const elapsedMs = Date.now() - tStart;
  if (cell.name === 'empty') emptyComposite = score.composite;
  const gap = score.composite - (emptyComposite ?? score.composite);
  console.log(
    `  ${cell.name.padEnd(18)} composite=${score.composite.toFixed(4)} gap=${gap.toFixed(4)} ` +
    `nDCG10=${score.nDCG10.toFixed(3)} MRR10=${score.mrr10.toFixed(3)} R10=${score.recall10.toFixed(3)} ` +
    `(${(elapsedMs / 1000).toFixed(1)}s)`,
  );
  results.push({
    cell: cell.name,
    channels: { anchors: cell.anchors, lenses: cell.lenses, relations: cell.relations },
    composite: score.composite,
    gap,
    nDCG10: score.nDCG10,
    mrr10: score.mrr10,
    recall10: score.recall10,
    structuralValidity: score.structuralValidity,
    perFamily: perFamilyMeans(score.perQuery ?? []),
    elapsedMs,
  });
}

const anyGap = results.some((r) => Math.abs(r.gap) > 1e-4);
const report = {
  schemaVersion: 'coretex.substrate-ablation.v1',
  generatedAt: new Date().toISOString(),
  provenance: buildProvenance(),
  fidelity: rerankerArg === 'env' ? 'PRODUCTION_RERANKER' : 'DETERMINISTIC_SMOKE',
  inputs: {
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    eventCount: corpus.events.length,
    bundleProfile: profilePath ?? null,
    rerankerMode: rerankerArg,
    rerankerModel: reranker.model,
    packSeedHex: seedHex,
    packSize: pack.events.length,
    pipelineVersion: profile.pipelineVersion,
    rerankerInputTopK: opts.rerankerInputTopK,
    firstStageTopK: opts.firstStageTopK,
    lensWeight: opts.lensWeight,
    anchorWeight: opts.anchorWeight,
    relationExpansionBudget: opts.relationExpansionBudget,
  },
  cells: cells.map((c) => c.name),
  results,
  interpretation: {
    anchorContribution: deriveDelta('anchor-only', 'empty'),
    lensContribution: deriveDelta('lens-only', 'empty'),
    relationContribution: deriveDelta('relation-only', 'empty'),
    anchorPlusLensContribution: deriveDelta('anchor+lens', 'anchor-only'),
    anchorPlusRelationContribution: deriveDelta('anchor+relation', 'anchor-only'),
    allOnVsAnchorOnly: deriveDelta('all-on', 'anchor-only'),
  },
  notes: !anyGap
    ? 'WARNING: no cell produced a measurable composite gap. Substrate has no lever at the configured baseline scalars, or reranker is hash-blind.'
    : null,
};

function deriveDelta(a, b) {
  const ra = results.find((r) => r.cell === a);
  const rb = results.find((r) => r.cell === b);
  if (!ra || !rb) return null;
  return {
    composite: ra.composite - rb.composite,
    nDCG10: ra.nDCG10 - rb.nDCG10,
    mrr10: ra.mrr10 - rb.mrr10,
    recall10: ra.recall10 - rb.recall10,
  };
}

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[ablation] report → ${reportPath}`);
exit(anyGap ? 0 : 2);
