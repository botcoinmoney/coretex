#!/usr/bin/env node
/**
 * Relation hard-family probe — does Phase B category-lens BFS actually
 * route to truth when stage-1 lands NEAR the answer but misses it?
 *
 * The dense-ablation found relation channel net-harmful (anchor+relation
 * −0.19 MRR vs anchor-only). That cell exposes the substrate to all
 * possible relation expansion at once. The auditor's correction: a real
 * relation diagnostic must construct cases where:
 *   1. stage-1 surfaces events semantically NEAR the truth (high cosine
 *      to the answer's neighborhood), but
 *   2. stage-1 does NOT surface the truth itself,
 *   3. corpus-native relations connect a near-event to the truth.
 *
 * The substrate's anchors are placed on the NEAR events (not the truth),
 * and category-lens entries on the matching edgeTypes. If Phase B BFS
 * follows the corpus-native edges from the near-events to the truth and
 * the reranker scores it well, relation routing is empirically a real
 * primitive — under exactly the condition the design promises.
 *
 * Pack construction:
 *   - Filter corpus to multi_hop_relation family with non-empty
 *     event.relations (i.e., the answer has named relations to other
 *     corpus events).
 *   - For each such event, the "near" candidates are the events
 *     pointed-to by event.relations[*].other_id — themselves anchored,
 *     but NOT carrying lens vectors for the truth.
 *
 * Cells (all use the same multi_hop_relation pack):
 *   empty               — baseline
 *   anchor-on-truth     — control: anchor the truth doc (easy win)
 *   anchor-on-near      — anchors on related-but-not-truth events;
 *                         relations off; category-lens off
 *   anchor-on-near +
 *     relation+catLens  — anchors on related events PLUS corpus-relation
 *                         anchor-to-anchor edges PLUS category-lens
 *                         entries on the matching edgeTypes. This is
 *                         the cell that tests relation/category routing.
 *
 * A POSITIVE result requires the relation cell to beat anchor-on-near
 * (which has the same anchor coverage but no expansion mechanism).
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/calibrate-relation-hard-family.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0-calibration.json \
 *     --bundle-profile /etc/coretex/bundle-profile-launch-v3.json \
 *     --reranker deterministic \
 *     --out /var/lib/coretex/reports/relation-hard-family.json
 */
import { distIndex } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}
const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const packSize = Number(flag('pack-size', '8'));
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/relation-hard-family.json');
const seedHex = flag('seed', '0x' + 'b9'.repeat(32));
const targetFamily = flag('family', 'multi_hop_relation');

if (!corpusPath || !existsSync(corpusPath)) { console.error('--corpus missing'); exit(1); }

const {
  loadProductionCorpus,
  evaluateRetrievalBenchmarkState,
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

console.log(`[relhard] loading corpus`);
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.log(`  ${corpus.events.length} events`);

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
console.log(`[relhard] reranker: ${reranker.model}`);

// Build event index by id.
const eventById = new Map(corpus.events.map((e) => [e.id, e]));

// Filter to events of the target family with non-empty relations.
const candidates = corpus.events.filter((e) =>
  e.family === targetFamily && Array.isArray(e.relations) && e.relations.length > 0,
);
console.log(`[relhard] target family=${targetFamily}; ${candidates.length} events with non-empty relations`);
if (candidates.length === 0) {
  console.error(`[relhard] no events of family=${targetFamily} have outgoing relations in this corpus`);
  exit(2);
}

// Deterministic sample of packSize events for the pack.
function shaIdx(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
  return h >>> 0;
}
const scored = candidates.map((e) => ({ e, s: shaIdx(seedHex + ':' + e.id) }));
scored.sort((a, b) => a.s - b.s);
const pack = { epochId: 0, evalSeedCommit: seedHex, events: scored.slice(0, packSize).map((x) => x.e) };
console.log(`[relhard] pack size=${pack.events.length}`);

// For each pack event, gather its related events (the "near" set).
const relatedByPackIndex = pack.events.map((ev) => {
  const related = [];
  for (const rel of ev.relations) {
    const tgt = eventById.get(rel.other_id);
    if (tgt && tgt.id !== ev.id) related.push({ event: tgt, edgeType: rel.edgeType });
  }
  return related;
});
const relatedEdgeTypes = new Set();
for (const rels of relatedByPackIndex) {
  for (const r of rels) relatedEdgeTypes.add(r.edgeType);
}
console.log(`[relhard] edgeTypes spanning pack relations: ${[...relatedEdgeTypes].join(',')}`);

function relationAliasStatsFor(events) {
  const stats = {
    relationBearingEvents: 0,
    relationEdges: 0,
    targetTruthDocs: 0,
    relevantAliasQrels: 0,
    fullCreditAliasQrels: 0,
    missingAliasQrels: [],
  };
  for (const ev of events) {
    if (!ev.relations || ev.relations.length === 0) continue;
    stats.relationBearingEvents++;
    const qrelsById = new Map(ev.qrels.map((q) => [q.documentId, q.relevance]));
    for (const rel of ev.relations) {
      stats.relationEdges++;
      const target = eventById.get(rel.other_id);
      if (!target) continue;
      for (const truth of target.truthDocuments) {
        if (!truth.isCurrent) continue;
        stats.targetTruthDocs++;
        const relevance = qrelsById.get(truth.id) ?? 0;
        if (relevance > 0) stats.relevantAliasQrels++;
        if (relevance === 1) stats.fullCreditAliasQrels++;
        if (relevance <= 0) {
          stats.missingAliasQrels.push({ eventId: ev.id, targetEventId: target.id, targetTruthDocId: truth.id });
        }
      }
    }
  }
  return stats;
}

const relationAliasStats = relationAliasStatsFor(pack.events);
console.log(
  `[relhard] relation target qrel aliases: relevant=${relationAliasStats.relevantAliasQrels}/` +
  `${relationAliasStats.targetTruthDocs} full=${relationAliasStats.fullCreditAliasQrels}`,
);
if (relationAliasStats.targetTruthDocs === 0 || relationAliasStats.relevantAliasQrels === 0) {
  console.error('[relhard] relation-bearing pack has no relevant target-truth alias qrels; corpus is invalid for relation conclusions');
  exit(3);
}

const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672 };
const EMPTY = new Array(1024).fill(0n);

function buildState({ anchorOnTruth, anchorOnNear, relations, categoryLenses }) {
  const words = [...EMPTY];
  const sharedDomain = 1n;
  // Anchor placement: in anchorOnTruth mode the pack event itself is
  // anchored (bookmarking baseline). In anchorOnNear mode the FIRST
  // related event for each pack item is anchored (so anchor-mandatory
  // does NOT directly inject truth; only Phase B BFS via category-lens
  // can reach the answer).
  for (let i = 0; i < pack.events.length; i++) {
    const ev = pack.events[i];
    let anchorEv = null;
    if (anchorOnTruth) anchorEv = ev;
    else if (anchorOnNear) anchorEv = relatedByPackIndex[i][0]?.event ?? null;
    if (!anchorEv) continue;
    const memSlot = {
      slotIndex: i,
      recordId: stableRecordIdFor(anchorEv.id),
      family: anchorEv.family,
      domainBits: sharedDomain,
      valid: true, revoked: false, protected: anchorEv.protected ?? false,
      retrievalSlot: i, expiryEpoch: 0n,
    };
    const memWords = encodeMemoryIndexSlot(memSlot);
    const base = RANGES.MEMORY_INDEX_START + i * 8;
    for (let j = 0; j < 8; j++) words[base + j] = memWords[j];
  }
  // Anchor-to-anchor relation edges. Only meaningful if anchors exist.
  if (relations && (anchorOnTruth || anchorOnNear)) {
    const nEdges = Math.min(8, pack.events.length - 1);
    for (let i = 0; i < nEdges; i++) {
      const edge = { entryIndex: i, sourceSlot: i, targetSlot: (i + 1) % pack.events.length, edgeType: 'supports', weight: 1 };
      words[RANGES.RELATIONS_START + i] = encodeRelationEdge(edge);
    }
  }
  // Category-lens entries on the edgeTypes that span the pack's
  // relations. This is the lever that lets Phase B BFS follow corpus-
  // native relations from any anchored "near" event to its truth.
  if (categoryLenses) {
    let entry = 128 - 1;
    for (const edgeType of relatedEdgeTypes) {
      const lens = { entryIndex: entry, edgeType, weight: 0x8000 };
      words[RANGES.RELATIONS_START + entry] = encodeRelationCategoryLens(lens);
      entry--;
      if (entry < pack.events.length) break;
    }
  }
  return { words };
}

const opts = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  biEncoder, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
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
  { name: 'empty',                anchorOnTruth: false, anchorOnNear: false, relations: false, categoryLenses: false },
  { name: 'anchor-on-truth',      anchorOnTruth: true,  anchorOnNear: false, relations: false, categoryLenses: false },
  { name: 'anchor-on-near',       anchorOnTruth: false, anchorOnNear: true,  relations: false, categoryLenses: false },
  { name: 'anchor-on-near+rels',  anchorOnTruth: false, anchorOnNear: true,  relations: true,  categoryLenses: false },
  { name: 'anchor-on-near+catLens', anchorOnTruth: false, anchorOnNear: true, relations: false, categoryLenses: true },
  { name: 'anchor-on-near+full',  anchorOnTruth: false, anchorOnNear: true,  relations: true,  categoryLenses: true },
];

function aggregateSources(perQuery) {
  const blank = () => ({ stage1: 0, anchorMandatory: 0, anchorBFS: 0, categoryLensBFS: 0 });
  const cap = blank(), rel = blank(), hardNeg = blank();
  let docs = 0, relTotal = 0, hardNegTotal = 0;
  for (const q of perQuery) {
    for (const tags of q.cappedDocSources ?? []) {
      docs++;
      for (const t of tags) if (t in cap) cap[t]++;
    }
    for (const r of q.finalRankingTop20 ?? []) {
      if (r.rank <= 10 && r.relevance > 0) {
        relTotal++;
        for (const t of r.sources) if (t in rel) rel[t]++;
      }
      if (r.rank <= 20 && r.relevance === 0) {
        hardNegTotal++;
        for (const t of r.sources) if (t in hardNeg) hardNeg[t]++;
      }
    }
  }
  const frac = (counts, denom) => denom > 0
    ? Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / denom])) : null;
  return {
    cap: { count: cap, fraction: frac(cap, docs), totalDocs: docs },
    relevantTop10: { count: rel, fraction: frac(rel, relTotal), totalDocs: relTotal },
    hardNegativeTop20: { count: hardNeg, fraction: frac(hardNeg, hardNegTotal), totalDocs: hardNegTotal },
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
    `  ${cell.name.padEnd(28)} composite=${score.composite.toFixed(4)} ` +
    `nDCG=${score.nDCG10.toFixed(3)} MRR=${score.mrr10.toFixed(3)} R=${score.recall10.toFixed(3)} ` +
    `multiHop=${score.multiHopRecall10.toFixed(3)} catHit=${score.categoryLensRelationHit10.toFixed(3)} ` +
    `relTop10[anchorMandatory=${sources.relevantTop10.count.anchorMandatory}, categoryLensBFS=${sources.relevantTop10.count.categoryLensBFS}] ` +
    `hardNegTop20[categoryLensBFS=${sources.hardNegativeTop20.count.categoryLensBFS}] ` +
    `(${(elapsedMs / 1000).toFixed(1)}s)`,
  );
  results.push({
    cell: cell.name, cellConfig: cell,
    composite: score.composite,
    nDCG10: score.nDCG10, mrr10: score.mrr10, recall10: score.recall10,
    multiHopRecall10: score.multiHopRecall10,
    categoryLensRelationHit10: score.categoryLensRelationHit10,
    candidateSources: sources,
    elapsedMs,
  });
}

const report = {
  schemaVersion: 'coretex.relation-hard-family.v2',
  generatedAt: new Date().toISOString(),
  provenance: buildProvenance(),
  fidelity: rerankerArg === 'env' ? 'PRODUCTION_RERANKER' : 'DETERMINISTIC_SMOKE',
  inputs: {
    corpus: corpusPath, corpusRoot: corpus.corpusRoot, eventCount: corpus.events.length,
    bundleProfile: profilePath, rerankerMode: rerankerArg, rerankerModel: reranker.model,
    packSize: pack.events.length, packSeedHex: seedHex, targetFamily,
    edgeTypesSpanningPack: [...relatedEdgeTypes],
    pipelineVersion: profile.pipelineVersion,
    rerankerInputTopK: opts.rerankerInputTopK, firstStageTopK: opts.firstStageTopK,
    lensWeight: opts.lensWeight, anchorWeight: opts.anchorWeight,
    relationExpansionBudget: opts.relationExpansionBudget,
    relationAliasStats,
  },
  results,
  interpretation: {
    anchorBookmarkLift: results.find((r) => r.cell === 'anchor-on-truth').composite
      - results.find((r) => r.cell === 'empty').composite,
    anchorOnNearLift: results.find((r) => r.cell === 'anchor-on-near').composite
      - results.find((r) => r.cell === 'empty').composite,
    relationContribution: results.find((r) => r.cell === 'anchor-on-near+rels').composite
      - results.find((r) => r.cell === 'anchor-on-near').composite,
    categoryLensContribution: results.find((r) => r.cell === 'anchor-on-near+catLens').composite
      - results.find((r) => r.cell === 'anchor-on-near').composite,
    fullExpansionContribution: results.find((r) => r.cell === 'anchor-on-near+full').composite
      - results.find((r) => r.cell === 'anchor-on-near').composite,
  },
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[relhard] report → ${reportPath}`);
console.log(`[relhard] anchor-on-near baseline composite=${results.find((r) => r.cell === 'anchor-on-near').composite.toFixed(4)}`);
console.log(`[relhard] relation lift over anchor-on-near: ${report.interpretation.relationContribution.toFixed(4)}`);
console.log(`[relhard] category-lens lift over anchor-on-near: ${report.interpretation.categoryLensContribution.toFixed(4)}`);
console.log(`[relhard] full expansion (rel+catLens) lift over anchor-on-near: ${report.interpretation.fullExpansionContribution.toFixed(4)}`);
await reranker.close?.();
exit(0);
