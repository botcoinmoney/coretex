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

// Pre-compute an irrelevant-anchor pool: events that are NOT in the
// pack and that NO pack event has a corpus relation to. Anchoring such
// an event places an off-topic record in MemoryIndex — anchor-mandatory
// would inject its truth, but that truth is NOT qrel-credited for any
// pack query. Lift over empty in this cell would mean the substrate is
// boosting something via incidental cosine similarity rather than via
// real routing — useful as a sanity floor.
function buildIrrelevantAnchorPool() {
  const excluded = new Set(pack.events.map((e) => e.id));
  for (const rels of relatedByPackIndex) for (const r of rels) excluded.add(r.event.id);
  // Allow any non-excluded corpus event. Deterministic selection.
  const candidates = corpus.events
    .filter((e) => !excluded.has(e.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return candidates.slice(0, pack.events.length);
}
const irrelevantAnchorPool = buildIrrelevantAnchorPool();

// Returns an array describing which event sits in each MemoryIndex slot
// for the cell's anchor configuration. Used for audit + corpus-attested
// edge derivation. Slots NOT assigned are null. Convention:
//   slots 0..(packSize-1)        — primary anchor positions per cell
//   slots packSize..(2*packSize-1) — pack event ("answer") positions when
//                                    anchorBoth is set
function slotAssignmentFor(cellConfig) {
  const assignments = new Array(44).fill(null);
  if (cellConfig.anchorOnTruth) {
    for (let i = 0; i < pack.events.length; i++) assignments[i] = pack.events[i];
  } else if (cellConfig.anchorOnAnswerAlias) {
    // After qrel alias repair, relations[*].other_id targets are
    // qrel-credited for the pack query. Anchoring them is NOT
    // "anchoring a near non-truth" — it IS anchoring an answer-alias.
    // Cell name reflects that.
    for (let i = 0; i < pack.events.length; i++) assignments[i] = relatedByPackIndex[i][0]?.event ?? null;
    if (cellConfig.anchorBoth) {
      for (let i = 0; i < pack.events.length; i++) assignments[pack.events.length + i] = pack.events[i];
    }
  } else if (cellConfig.anchorOnIrrelevant) {
    // Clean-control: anchor an event with no corpus path to any pack
    // query and no qrel relevance. Lift over empty here is unmoored
    // from the test's intended routing surface.
    for (let i = 0; i < pack.events.length; i++) assignments[i] = irrelevantAnchorPool[i] ?? null;
  }
  return assignments;
}

// Walk slot-pairs and emit the corpus-native relations BETWEEN them.
// Returns { edges: [{ sourceSlot, targetSlot, edgeType }], audit: { ... } }
function corpusAttestedAnchorEdges(assignments) {
  const edges = [];
  const audit = {
    pairsConsidered: 0,
    pairsWithCorpusRelation: 0,
    edgeTypeBreakdown: {},
  };
  for (let s = 0; s < assignments.length; s++) {
    const src = assignments[s];
    if (!src || !src.relations) continue;
    for (let t = 0; t < assignments.length; t++) {
      if (s === t) continue;
      const tgt = assignments[t];
      if (!tgt) continue;
      audit.pairsConsidered++;
      for (const rel of src.relations) {
        if (rel.other_id === tgt.id) {
          edges.push({ sourceSlot: s, targetSlot: t, edgeType: rel.edgeType });
          audit.pairsWithCorpusRelation++;
          audit.edgeTypeBreakdown[rel.edgeType] = (audit.edgeTypeBreakdown[rel.edgeType] ?? 0) + 1;
        }
      }
    }
  }
  return { edges, audit };
}

function buildState(cellConfig) {
  const { relations, categoryLenses } = cellConfig;
  const words = [...EMPTY];
  const sharedDomain = 1n;
  const assignments = slotAssignmentFor(cellConfig);
  // Anchor placement.
  for (let s = 0; s < assignments.length; s++) {
    const ev = assignments[s];
    if (!ev) continue;
    const memSlot = {
      slotIndex: s,
      recordId: stableRecordIdFor(ev.id),
      family: ev.family,
      domainBits: sharedDomain,
      valid: true, revoked: false, protected: ev.protected ?? false,
      retrievalSlot: s, expiryEpoch: 0n,
    };
    const memWords = encodeMemoryIndexSlot(memSlot);
    const base = RANGES.MEMORY_INDEX_START + s * 8;
    for (let j = 0; j < 8; j++) words[base + j] = memWords[j];
  }
  // Anchor-to-anchor relation edges — CORPUS-ATTESTED ONLY. No synthetic
  // sequential edges; if the corpus does not have a relation between two
  // anchored events, no substrate edge is added. The auditor's correction
  // to the original version: synthetic edges measure substrate-graph
  // reachability, not corpus-relation routing — they cannot be read as
  // evidence of relation utility. If 0 corpus-attested edges, this cell
  // collapses to its anchor-only equivalent.
  const edgeAudit = { pairsConsidered: 0, pairsWithCorpusRelation: 0, edgeTypeBreakdown: {}, written: 0 };
  if (relations) {
    const { edges, audit } = corpusAttestedAnchorEdges(assignments);
    Object.assign(edgeAudit, audit);
    let entryIndex = 0;
    for (const e of edges) {
      if (entryIndex >= 8) break; // small substrate edge budget; first 8 entries
      const edge = { entryIndex, sourceSlot: e.sourceSlot, targetSlot: e.targetSlot, edgeType: e.edgeType, weight: 1 };
      words[RANGES.RELATIONS_START + entryIndex] = encodeRelationEdge(edge);
      entryIndex++;
      edgeAudit.written++;
    }
  }
  if (categoryLenses) {
    let entry = 128 - 1;
    for (const edgeType of relatedEdgeTypes) {
      const lens = { entryIndex: entry, edgeType, weight: 0x8000 };
      words[RANGES.RELATIONS_START + entry] = encodeRelationCategoryLens(lens);
      entry--;
      if (entry < 8) break;
    }
  }
  return { words, slotAssignments: assignments, edgeAudit };
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

// Cell config conventions:
//   anchorOnTruth           — anchor pack event itself (bookmark baseline)
//   anchorOnAnswerAlias     — anchor relations[*].other_id; AFTER qrel alias
//                             repair, this is anchoring an answer-alias
//                             (NOT a "near non-truth"). Re-labeled to make
//                             the actual semantic content explicit.
//   anchorOnIrrelevant      — clean-control: anchor an event with no
//                             corpus path to any pack query and no qrel
//                             relevance. Lift here implies the substrate
//                             is producing signal outside the intended
//                             routing surface.
//   anchorBoth              — anchor BOTH the answer-alias AND the pack
//                             event itself, in distinct slots, with
//                             corpus-attested edges connecting them.
//   relations               — only corpus-attested edges between anchored
//                             slots (no synthetic sequential edges).
//   categoryLenses          — substrate-controlled Phase B BFS via
//                             category-lens entries on the edgeTypes
//                             spanning pack relations.
const cells = [
  { name: 'empty',                          anchorOnTruth: false, anchorOnAnswerAlias: false, anchorOnIrrelevant: false, anchorBoth: false, relations: false, categoryLenses: false },
  { name: 'anchor-on-truth',                anchorOnTruth: true,  anchorOnAnswerAlias: false, anchorOnIrrelevant: false, anchorBoth: false, relations: false, categoryLenses: false },
  // Clean control: anchor an event with no qrel credit and no corpus
  // path. Lift over empty here is unmoored from intended routing.
  { name: 'anchor-on-irrelevant',           anchorOnTruth: false, anchorOnAnswerAlias: false, anchorOnIrrelevant: true,  anchorBoth: false, relations: false, categoryLenses: false },
  { name: 'anchor-on-irrelevant+catLens',   anchorOnTruth: false, anchorOnAnswerAlias: false, anchorOnIrrelevant: true,  anchorBoth: false, relations: false, categoryLenses: true },
  // Re-labeled formerly "anchor-on-near": these cells anchor the
  // qrel-aliased answer-target event.
  { name: 'anchor-on-answer-alias',         anchorOnTruth: false, anchorOnAnswerAlias: true,  anchorOnIrrelevant: false, anchorBoth: false, relations: false, categoryLenses: false },
  // Corpus-attested-only anchor edges between answer-alias slots. If
  // those alias events don't have relations to each other, edges = 0
  // and this cell collapses to anchor-on-answer-alias.
  { name: 'anchor-on-answer-alias+rels',    anchorOnTruth: false, anchorOnAnswerAlias: true,  anchorOnIrrelevant: false, anchorBoth: false, relations: true,  categoryLenses: false },
  { name: 'anchor-on-answer-alias+catLens', anchorOnTruth: false, anchorOnAnswerAlias: true,  anchorOnIrrelevant: false, anchorBoth: false, relations: false, categoryLenses: true },
  { name: 'anchor-on-answer-alias+full',    anchorOnTruth: false, anchorOnAnswerAlias: true,  anchorOnIrrelevant: false, anchorBoth: false, relations: true,  categoryLenses: true },
  // anchor-both (no relations): anchor both pack event AND answer-alias
  // in distinct slots, NO substrate edges. Isolates the "endpoint
  // coverage" effect — what does anchoring two endpoints add over
  // anchoring just one? Compared with anchor-both+rels, the delta gives
  // the actual anchor-graph relation-edge contribution, separated from
  // the second-anchor effect.
  { name: 'anchor-both',                    anchorOnTruth: false, anchorOnAnswerAlias: true,  anchorOnIrrelevant: false, anchorBoth: true,  relations: false, categoryLenses: false },
  // anchor-both+rels: same anchoring as anchor-both, plus corpus-attested
  // edges between the two anchored slots. Auditor's clean decomposition:
  //   anchor-both          - anchor-on-answer-alias  = endpoint-coverage effect
  //   anchor-both+rels     - anchor-both             = anchor-graph relation-edge effect
  { name: 'anchor-both+rels',               anchorOnTruth: false, anchorOnAnswerAlias: true,  anchorOnIrrelevant: false, anchorBoth: true,  relations: true,  categoryLenses: false },
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

// Per-cell SLOT AUDIT — printed BEFORE running any scoring so an
// operator can see which event sits in which slot, whether the
// anchor-to-anchor edges encode any real corpus relations, and
// whether the relation-cell setup is answer-path-valid (i.e., a
// near-anchor's substrate edges actually point at the pack event's
// answer anchor).
function answerPathReport(cellConfig, assignments) {
  // For each pack item i: which slot holds the near event N_i? Which
  // slot, if any, holds the pack event X_i (the answer)? Does the
  // corpus have a relation from N_i → X_i (or X_i → N_i) that the
  // substrate's anchor-to-anchor edges can express?
  const rows = [];
  for (let i = 0; i < pack.events.length; i++) {
    const X = pack.events[i];
    const N = relatedByPackIndex[i][0]?.event ?? null;
    const xSlot = assignments.findIndex((e) => e && e.id === X.id);
    const nSlot = N ? assignments.findIndex((e) => e && e.id === N.id) : -1;
    // Corpus-attested direction either way.
    let corpusEdgeNtoX = false, corpusEdgeXtoN = false;
    if (N) {
      for (const rel of (N.relations ?? [])) if (rel.other_id === X.id) corpusEdgeNtoX = true;
      for (const rel of (X.relations ?? [])) if (rel.other_id === N.id) corpusEdgeXtoN = true;
    }
    rows.push({
      packIndex: i, packEventId: X.id, nearEventId: N?.id ?? null,
      xSlot, nSlot,
      corpusEdgeNtoX, corpusEdgeXtoN,
      anchorPathConnects: xSlot >= 0 && nSlot >= 0,
    });
  }
  return rows;
}

const results = [];
for (const cell of cells) {
  const tStart = Date.now();
  const state = buildState(cell);
  const pathRows = answerPathReport(cell, state.slotAssignments);
  const xSlotPresent = pathRows.filter((r) => r.xSlot >= 0).length;
  const nSlotPresent = pathRows.filter((r) => r.nSlot >= 0).length;
  const anchorPathConnects = pathRows.filter((r) => r.anchorPathConnects).length;
  // For cells that claim to test relation routing, flag if the setup
  // cannot possibly route near → answer because the answer event isn't
  // anchored. Synthetic edges between anchored events have no path to
  // an un-anchored answer.
  const isRelationCell = cell.relations === true;
  const answerPathValid = !isRelationCell || anchorPathConnects > 0;
  if (isRelationCell && !answerPathValid) {
    console.warn(`  [audit] ${cell.name}: NO near→answer anchor path possible (answer event not anchored). Substrate edges decorative.`);
  }
  const score = await evaluateRetrievalBenchmarkState(state, corpus, pack, opts);
  const elapsedMs = Date.now() - tStart;
  const sources = aggregateSources(score.perQuery ?? []);
  console.log(
    `  ${cell.name.padEnd(28)} composite=${score.composite.toFixed(4)} ` +
    `nDCG=${score.nDCG10.toFixed(3)} MRR=${score.mrr10.toFixed(3)} R=${score.recall10.toFixed(3)} ` +
    `multiHop=${score.multiHopRecall10.toFixed(3)} catHit=${score.categoryLensRelationHit10.toFixed(3)} ` +
    `corpusEdges=${state.edgeAudit.written}/${state.edgeAudit.pairsConsidered} ` +
    `answerPath=${anchorPathConnects}/${pack.events.length} ` +
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
    edgeAudit: state.edgeAudit,
    answerPathAudit: {
      xSlotPresent, nSlotPresent, anchorPathConnects,
      anchorPathPossible: answerPathValid,
      rows: pathRows,
    },
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
  interpretation: (() => {
    const c = (n) => results.find((r) => r.cell === n)?.composite ?? null;
    const m = (n) => results.find((r) => r.cell === n)?.mrr10 ?? null;
    const baseline = c('anchor-on-answer-alias');
    // Clean decomposition (auditor):
    //   endpoint-coverage effect  = anchor-both - anchor-on-answer-alias
    //   anchor-graph relation-edge = anchor-both+rels - anchor-both
    //   catLens contribution       = answer-alias+catLens - answer-alias
    //   catLens noise floor        = irrelevant+catLens - irrelevant
    return {
      anchorBookmarkLift: c('anchor-on-truth') - c('empty'),
      anchorOnAnswerAliasLift: c('anchor-on-answer-alias') - c('empty'),
      anchorOnIrrelevantLift: c('anchor-on-irrelevant') - c('empty'),
      catLensNoiseFloor: c('anchor-on-irrelevant+catLens') - c('anchor-on-irrelevant'),
      catLensContribution: c('anchor-on-answer-alias+catLens') - baseline,
      // (No edges yet) — relations cell collapses to baseline when
      // anchored events have no corpus relations to each other.
      relationContribution_aliasOnly: c('anchor-on-answer-alias+rels') - baseline,
      fullExpansionContribution: c('anchor-on-answer-alias+full') - baseline,
      // Auditor's clean two-step:
      endpointCoverageEffect: c('anchor-both') - baseline,
      anchorGraphEdgeContribution: c('anchor-both+rels') - c('anchor-both'),
      // Per-metric for completeness.
      mrr: {
        empty: m('empty'), anchorOnTruth: m('anchor-on-truth'),
        answerAlias: m('anchor-on-answer-alias'),
        anchorBoth: m('anchor-both'), anchorBothRels: m('anchor-both+rels'),
      },
    };
  })(),
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[relhard] report → ${reportPath}`);
const ip = report.interpretation;
console.log(`[relhard] anchor-on-answer-alias baseline composite=${results.find((r) => r.cell === 'anchor-on-answer-alias').composite.toFixed(4)}`);
console.log(`[relhard] endpoint-coverage effect (anchor-both − answer-alias): ${ip.endpointCoverageEffect.toFixed(4)}`);
console.log(`[relhard] anchor-graph relation-edge contribution (anchor-both+rels − anchor-both): ${ip.anchorGraphEdgeContribution.toFixed(4)}`);
console.log(`[relhard] catLens contribution (alias+catLens − answer-alias): ${ip.catLensContribution.toFixed(4)}`);
console.log(`[relhard] catLens noise floor (irrelevant+catLens − irrelevant): ${ip.catLensNoiseFloor.toFixed(4)}`);
console.log(`[relhard] sanity (anchor-on-irrelevant − empty): ${ip.anchorOnIrrelevantLift.toFixed(4)}`);
await reranker.close?.();
exit(0);
