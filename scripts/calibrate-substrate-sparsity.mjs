#!/usr/bin/env node
/**
 * Substrate sparsity ablation.
 *
 * The all-cells-on engineered substrate the existing ablation uses is the
 * best-case shape: every pack event is anchored, every truth lives in
 * RetrievalKeys, every anchor-to-anchor edge is populated. Real miner
 * substrates are sparser — anchors may cover only a subset of any given
 * query pack, lens vectors may exist for queries that don't have
 * anchors, relations are partial.
 *
 * This script holds scalars at the profile baseline and sweeps substrate
 * density:
 *
 *   anchorCoverage ∈ {0, 0.25, 0.5, 0.75, 1.0}  (fraction of pack events
 *                                                that get a MemoryIndex slot)
 *   lensCoverage   ∈ {0, 0.5, 1.0}              (fraction of pack events
 *                                                whose truth is placed in
 *                                                RetrievalKeys)
 *
 * Relations are populated only when both anchors and lenses are at full
 * coverage (relation edges reference MemoryIndex slots — degenerate if
 * those slots are empty).
 *
 * Reports composite + nDCG@10 + MRR@10 + Recall@10 per (anchor, lens)
 * cell so the sparse-vs-dense substrate transition is visible. If the
 * anchor-only optimum from the dense ablation degrades smoothly with
 * sparsity, the pin is robust to typical miner substrates. If it
 * collapses or flips ordering, the dense-ablation finding is an artifact.
 *
 * Usage:
 *   node --max-old-space-size=24576 scripts/calibrate-substrate-sparsity.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *     --bundle-profile /etc/coretex/bundle-profile-launch-v3.json \
 *     --reranker env \
 *     --out /var/lib/coretex/reports/substrate-sparsity.json
 */
import { distIndex } from './_repo-root.mjs';
import { profileAttestation } from './lib/profile-attestation.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit, env } from 'node:process';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}
const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const packSize = Number(flag('pack-size', '8'));
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/substrate-sparsity.json');
const seedHex = flag('seed', '0x' + 'b3'.repeat(32));
const anchorHeldOut = argv.includes('--anchor-held-out');

function fail(msg, code = 1) { console.error(`[sparsity] ${msg}`); exit(code); }
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
  getRerankerCacheStats,
} = await import(distIndex);
const { buildProvenance } = await import('./calibration-provenance.mjs');

console.log(`[sparsity] loading corpus ${corpusPath}`);
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
console.log(`[sparsity] reranker: ${reranker.model}`);

const pack = deriveQueryPack(0, seedHex, corpus, { packSize, quotas: [] });
console.log(`[sparsity] pack size=${pack.events.length}${anchorHeldOut ? ' [ANCHOR-HELD-OUT]' : ''}`);

const packEventIds = new Set(pack.events.map((e) => e.id));
const heldOutAnchorEvents = anchorHeldOut
  ? corpus.events.filter((e) => !packEventIds.has(e.id)).slice(0, pack.events.length)
  : null;

const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672 };
const EMPTY = new Array(1024).fill(0n);

function buildState({ anchorN, lensN, relations }) {
  const words = [...EMPTY];
  const sharedDomain = 1n;
  for (let i = 0; i < pack.events.length; i++) {
    const evForLens = pack.events[i];
    const evForAnchor = anchorHeldOut ? heldOutAnchorEvents[i] : evForLens;
    if (i < anchorN && evForAnchor) {
      const memSlot = {
        slotIndex: i,
        recordId: stableRecordIdFor(evForAnchor.id),
        family: evForAnchor.family,
        domainBits: sharedDomain,
        valid: true, revoked: false, protected: evForAnchor.protected ?? false,
        retrievalSlot: i, expiryEpoch: 0n,
      };
      const memWords = encodeMemoryIndexSlot(memSlot);
      const base = RANGES.MEMORY_INDEX_START + i * 8;
      for (let j = 0; j < 8; j++) words[base + j] = memWords[j];
    }
    if (i < lensN) {
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
  if (relations && anchorN >= 2) {
    const nEdges = Math.min(8, anchorN - 1);
    for (let i = 0; i < nEdges; i++) {
      const edge = { entryIndex: i, sourceSlot: i, targetSlot: (i + 1) % anchorN, edgeType: 'supports', weight: 1 };
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

const N = pack.events.length;
// Anchor / lens coverage cells. Fractions are quantized to integer slot counts.
const fracs = [0, 0.25, 0.5, 0.75, 1.0];
const cells = [];
for (const a of fracs) {
  for (const l of fracs) {
    cells.push({
      name: `anchor${a.toFixed(2)}_lens${l.toFixed(2)}`,
      anchorN: Math.round(a * N),
      lensN: Math.round(l * N),
      relations: false,
    });
  }
}
// Plus the dense + relation cells for direct comparison to the previous ablation.
cells.push({ name: 'anchor1.00_lens1.00_relations', anchorN: N, lensN: N, relations: true });

function aggregateSources(perQuery) {
  const blank = () => ({ stage1: 0, anchorMandatory: 0, anchorBFS: 0, categoryLensBFS: 0 });
  const inCap = blank(), relevantTop10 = blank(), hardNegativeTop20 = blank();
  let docs = 0, multi = 0, lensPromotedIntoCap = 0, lensConsidered = 0;
  let relevantTop10Total = 0, hardNegativeTop20Total = 0;
  for (const q of perQuery) {
    const tagsArr = q.cappedDocSources ?? [];
    const comps = q.cappedDocComponents ?? [];
    for (let i = 0; i < tagsArr.length; i++) {
      docs++;
      if (tagsArr[i].length > 1) multi++;
      for (const t of tagsArr[i]) if (t in inCap) inCap[t]++;
    }
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
    for (const r of (q.finalRankingTop20 ?? [])) {
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
    cap: { perTagCount: inCap, perTagFraction: fracOf(inCap, docs), totalDocs: docs,
      multiSourceFraction: docs > 0 ? multi / docs : null },
    relevantTop10: { perTagCount: relevantTop10, perTagFraction: fracOf(relevantTop10, relevantTop10Total),
      totalDocs: relevantTop10Total },
    hardNegativeTop20: { perTagCount: hardNegativeTop20, perTagFraction: fracOf(hardNegativeTop20, hardNegativeTop20Total),
      totalDocs: hardNegativeTop20Total },
    lensPromotion: { lensConsidered, lensPromotedIntoCap,
      promotionRate: lensConsidered > 0 ? lensPromotedIntoCap / lensConsidered : null },
  };
}

const results = [];
for (const cell of cells) {
  const tStart = Date.now();
  const state = buildState(cell);
  const score = await evaluateRetrievalBenchmarkState(state, corpus, pack, opts);
  const elapsedMs = Date.now() - tStart;
  const sources = aggregateSources(score.perQuery ?? []);
  console.log(
    `  ${cell.name.padEnd(38)} anchorN=${cell.anchorN} lensN=${cell.lensN} rel=${cell.relations ? 'on' : 'off'} ` +
    `composite=${score.composite.toFixed(4)} nDCG=${score.nDCG10.toFixed(3)} MRR=${score.mrr10.toFixed(3)} R=${score.recall10.toFixed(3)} ` +
    `srcAnchorM=${(sources.perTagFraction?.anchorMandatory ?? 0).toFixed(2)} srcAnchorBFS=${(sources.perTagFraction?.anchorBFS ?? 0).toFixed(2)} ` +
    `(${(elapsedMs / 1000).toFixed(1)}s)`,
  );
  results.push({
    cell: cell.name,
    anchorN: cell.anchorN,
    lensN: cell.lensN,
    relations: cell.relations,
    composite: score.composite,
    nDCG10: score.nDCG10,
    mrr10: score.mrr10,
    recall10: score.recall10,
    structuralValidity: score.structuralValidity,
    candidateSources: sources,
    elapsedMs,
  });
}

const cacheStats = getRerankerCacheStats?.(reranker);
const report = {
  schemaVersion: 'coretex.substrate-sparsity.v1',
  generatedAt: new Date().toISOString(),
  provenance: buildProvenance(),
  fidelity: rerankerArg === 'env' ? 'PRODUCTION_RERANKER' : 'DETERMINISTIC_SMOKE',
  inputs: {
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    eventCount: corpus.events.length,
    bundleProfile: profilePath ?? null,
    profileAttestation: profileAttestation(profile, profilePath),
    rerankerMode: rerankerArg,
    rerankerModel: reranker.model,
    biEncoderModelId: BI.modelId,
    biEncoderRevision: BI.revision,
    packSeedHex: seedHex,
    packSize: pack.events.length,
    pipelineVersion: profile.pipelineVersion,
    rerankerInputTopK: opts.rerankerInputTopK,
    firstStageTopK: opts.firstStageTopK,
    lensWeight: opts.lensWeight,
    anchorWeight: opts.anchorWeight,
    relationExpansionBudget: opts.relationExpansionBudget,
  },
  results,
  cacheStats: cacheStats ? {
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    evictions: cacheStats.evictions,
    finalSize: cacheStats.size(),
    hitRate: cacheStats.hits / Math.max(1, cacheStats.hits + cacheStats.misses),
  } : null,
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[sparsity] report → ${reportPath}`);
if (cacheStats) {
  console.log(`[sparsity] reranker cache: hits=${cacheStats.hits} misses=${cacheStats.misses} evictions=${cacheStats.evictions} size=${cacheStats.size()} hit_rate=${(report.cacheStats.hitRate * 100).toFixed(1)}%`);
}
exit(0);
