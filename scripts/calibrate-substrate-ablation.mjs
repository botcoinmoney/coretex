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
// Anchor-held-out mode: the engineered substrate anchors point at events
// NOT in the pack. Lens vectors still use pack truth embeddings. This
// isolates the "anchor cannot directly route truth" regime — if lens
// and relation primitives recover here, they're load-bearing
// independent of anchor's direct-bookmark shortcut. If they collapse,
// anchor-mandatory IS the only routing mechanism that works under
// realistic miner conditions where the exact pack queries weren't
// pre-anchored.
const anchorHeldOut = argv.includes('--anchor-held-out');

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
console.log(`[ablation] pack size=${pack.events.length} from ${seedHex}${anchorHeldOut ? ' [ANCHOR-HELD-OUT]' : ''}`);

// In anchor-held-out mode, anchors point at events distinct from the
// pack. Pick deterministic off-pack events sorted by id for repeatability.
const packEventIds = new Set(pack.events.map((e) => e.id));
const heldOutAnchorEvents = anchorHeldOut
  ? corpus.events.filter((e) => !packEventIds.has(e.id)).slice(0, pack.events.length)
  : null;

const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672 };
const EMPTY_WORDS = new Array(1024).fill(0n);

function buildState({ anchors, lenses, relations }) {
  const words = [...EMPTY_WORDS];
  const sharedDomain = 1n;
  for (let i = 0; i < pack.events.length; i++) {
    const evForLens = pack.events[i];
    // Anchor event: pack event in normal mode, OFF-PACK event in
    // anchor-held-out mode. This is the key knob — if the substrate's
    // anchors aren't the answer set, only lens/relations can route.
    const ev = anchorHeldOut ? heldOutAnchorEvents[i] : evForLens;
    if (anchors && ev) {
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
      // Lens vectors ALWAYS use the pack truth embeddings — they're the
      // miner's claim about which docs are relevant. Anchor-held-out only
      // affects which events get a MemoryIndex slot; lens placement is
      // independent.
      const truth = evForLens.truthDocuments.find((t) => t.isCurrent) ?? evForLens.truthDocuments[0];
      const emb = evForLens.embeddings.perTruth.get(truth.id);
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
  categoryLensExpansionBudget: profile.categoryLensExpansionBudget ?? profile.relationExpansionBudget ?? 50,
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

// Aggregate candidate-source attribution across all queries' capped pools
// AND the final ranked top-K. Returns counts per source tag plus
// diagnostics that distinguish:
//   - "in cap" (candidate-pool membership)
//   - "in final top-10 with relevance>0" (mechanism delivering relevant docs)
//   - "in final top-20 with relevance==0" (mechanism injecting hard negatives)
//   - "lens-promoted into cap" (docs whose preRankScore − lensBonus would
//     place them BELOW the K-th-place threshold — i.e., lens flipped them
//     into the reranker pool)
function aggregateSources(perQuery) {
  const blank = () => ({ stage1: 0, anchorMandatory: 0, anchorBFS: 0, categoryLensBFS: 0 });
  const inCap = blank();
  const relevantTop10 = blank();
  const hardNegativeTop20 = blank();
  let docs = 0, multi = 0;
  let lensPromotedIntoCap = 0, lensConsidered = 0;
  let relevantTop10Total = 0, hardNegativeTop20Total = 0;
  for (const q of perQuery) {
    const tagsArr = q.cappedDocSources ?? [];
    const comps = q.cappedDocComponents ?? [];
    // Cap-pool aggregates.
    for (let i = 0; i < tagsArr.length; i++) {
      docs++;
      if (tagsArr[i].length > 1) multi++;
      for (const t of tagsArr[i]) if (t in inCap) inCap[t]++;
    }
    // Lens-promotion-into-cap (COARSE proxy): a doc is in the cap by
    // preRankScore; would it still be in the cap by
    // (preRankScore − lensBonus)? Threshold here is min preRankScore in
    // the current cap. Two caveats:
    //   1. When cap >= pool size (small packs / small corpora), every
    //      doc trivially passes; promotion rate inflates to ~1.
    //   2. Threshold doesn't re-rank after demotion; for proper
    //      counterfactual cap, downstream should re-sort
    //      (preRankScore − lensBonus) desc and take top-K. The raw
    //      cappedDocComponents are written to the artifact for that.
    if (comps.length > 0) {
      let capThreshold = Infinity;
      for (const c of comps) if (c.preRankScore < capThreshold) capThreshold = c.preRankScore;
      for (const c of comps) {
        if (c.lensBonus > 0) {
          lensConsidered++;
          if ((c.preRankScore - c.lensBonus) < capThreshold) lensPromotedIntoCap++;
        }
      }
    }
    // Final ranking aggregates.
    const top = q.finalRankingTop20 ?? [];
    for (const r of top) {
      if (r.rank <= 10 && r.relevance > 0) {
        relevantTop10Total++;
        for (const t of r.sources) if (t in relevantTop10) relevantTop10[t]++;
      }
      if (r.rank <= 20 && r.relevance === 0) {
        hardNegativeTop20Total++;
        for (const t of r.sources) if (t in hardNegativeTop20) hardNegativeTop20[t]++;
      }
    }
  }
  const fracOf = (counts, denom) => denom > 0
    ? Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / denom])) : null;
  return {
    cap: {
      perTagCount: inCap,
      perTagFraction: fracOf(inCap, docs),
      totalDocs: docs,
      multiSourceFraction: docs > 0 ? multi / docs : null,
    },
    relevantTop10: {
      perTagCount: relevantTop10,
      perTagFraction: fracOf(relevantTop10, relevantTop10Total),
      totalDocs: relevantTop10Total,
    },
    hardNegativeTop20: {
      perTagCount: hardNegativeTop20,
      perTagFraction: fracOf(hardNegativeTop20, hardNegativeTop20Total),
      totalDocs: hardNegativeTop20Total,
    },
    lensPromotion: {
      lensConsidered,
      lensPromotedIntoCap,
      promotionRate: lensConsidered > 0 ? lensPromotedIntoCap / lensConsidered : null,
    },
  };
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
    candidateSources: aggregateSources(score.perQuery ?? []),
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
