#!/usr/bin/env node
/**
 * Component-rescue probe.
 *
 * NOT calibration. For each substrate component we build the SMALLEST controlled
 * synthetic corpus + state + query where that component MUST be the causal path
 * to the answer:
 *   - stage-1 alone misses or ranks the answer below the reranker cap,
 *   - direct answer anchors are forbidden (anchorMandatory must NOT be the path),
 *   - the target component has a valid path to the answer,
 *   - success = a relevant doc reaches top-10 via that component's source tag
 *     (lens bonus / anchorBFS / categoryLensBFS / temporal), NOT anchorMandatory.
 *
 * If a component cannot show signal in its own idealized rescue probe, it is dead
 * or incorrectly wired. Tuning order (stop at first broken layer):
 *   corpus path exists -> decoder emits structure -> candidate pool includes the
 *   answer via the intended source -> reranker ranks it -> metric credits it.
 *
 * Success bar = ANY causal signal, not big lift.
 *
 * Usage:
 *   node scripts/probe-component-rescue.mjs --component lens --reranker deterministic
 *   node scripts/probe-component-rescue.mjs --component all --reranker env   (Qwen)
 */
import { distIndex } from './_repo-root.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}
const componentArg = flag('component', 'lens');
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/component-rescue.json');

const {
  evaluateRetrievalBenchmarkState,
  createDeterministicReranker,
  rerankerFromEnv,
  biEncoderModelIdHash,
  encodeMemoryIndexSlot,
  encodeRetrievalKeySlot,
  encodeRelationEdge,
  encodeRelationCategoryLens,
  stableRecordIdFor,
  DEFAULT_PROFILE,
} = await import(distIndex);

// Real BGE-M3 layout (matches calibration/launch corpora) so the substrate
// decoder + dequantize behave exactly as in production.
const LAYOUT = { dim: 243, quantization: 'int8', headerBytes: 9 };
const MODEL_ID = 'BAAI/bge-m3';
const REVISION = '5617a9f61b028005a4858fdac845db406aefb181';
const biEncoderHash = biEncoderModelIdHash(MODEL_ID, REVISION, 'dense');
const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672 };

// ── Embedding helpers: controlled cosine geometry ──────────────────────────
// Quantize a float vector to the int8 corpus byte format: [f32 BE scale][codes].
function quantize(vec) {
  const dim = LAYOUT.dim;
  let maxAbs = 0;
  for (const x of vec) maxAbs = Math.max(maxAbs, Math.abs(x));
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const out = new Uint8Array(4 + dim);
  new DataView(out.buffer).setFloat32(0, scale, false);
  for (let i = 0; i < dim; i++) {
    let c = Math.round((vec[i] ?? 0) / scale);
    c = Math.max(-127, Math.min(127, c));
    out[4 + i] = c & 0xff;
  }
  return out;
}
// Deterministic near-unit direction from a seed string. Independent seeds give
// near-orthogonal vectors in 243-D (|cos| ~ 0.06), our "stage-1 miss".
function dir(seed) {
  const v = new Float64Array(LAYOUT.dim);
  let hi = 0, ci = 0;
  let h = createHash('sha256').update(`${seed}|${hi}`).digest();
  for (let i = 0; i < LAYOUT.dim; i++) {
    if (ci >= h.length) { hi++; h = createHash('sha256').update(`${seed}|${hi}`).digest(); ci = 0; }
    v[i] = (h[ci++] - 128) / 128;
  }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
// Weighted, renormalized combination of directions -> set controlled cosines.
function combine(parts) {
  const out = new Float64Array(LAYOUT.dim);
  for (const { v, w } of parts) for (let i = 0; i < out.length; i++) out[i] += w * v[i];
  let n = 0; for (const x of out) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}
function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ── Corpus / state builders ────────────────────────────────────────────────
function mkEvent({ id, family = 'multi_hop_relation', queryText, queryVec, truths = [], negs = [], relations }) {
  const perTruth = new Map();
  const perNegative = new Map();
  const truthDocuments = truths.map((t) => {
    perTruth.set(t.id, quantize(t.vec));
    return { id: t.id, text: t.text, isCurrent: t.isCurrent ?? true };
  });
  const hardNegatives = negs.map((n) => {
    perNegative.set(n.id, quantize(n.vec));
    return { id: n.id, text: n.text };
  });
  const qrels = [
    ...truths.map((t) => ({ documentId: t.id, relevance: t.relevance ?? 1 })),
    ...negs.map((n) => ({ documentId: n.id, relevance: n.relevance ?? 0 })),
  ];
  return {
    id, family, domain: 'rescue', split: 'eval_hidden',
    queryText, truthDocuments, hardNegatives, qrels, protected: false,
    ...(relations ? { relations } : {}),
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) },
    embeddings: { modelId: MODEL_ID, revision: REVISION, layout: LAYOUT, query: quantize(queryVec), perTruth, perNegative },
  };
}
function mkCorpus(events) {
  return {
    events,
    byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot: '0x' + '00'.repeat(32),
    corpusEpoch: 0,
    biEncoderModelId: MODEL_ID,
    biEncoderRevision: REVISION,
    biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'IAAR-Shanghai/MemReranker-4B',
    labelingModelRevision: 'rescue',
  };
}
function emptyWords() { return new Array(1024).fill(0n); }
function writeRetrievalKey(words, slot, vec) {
  const w = encodeRetrievalKeySlot(
    { slotIndex: slot, modelIdHash: biEncoderHash, l2Norm: 1.0, versionTag: 1, quantizedBytes: quantize(vec) },
    { retrievalKeyHeaderBytes: LAYOUT.headerBytes },
  );
  const base = RANGES.RETRIEVAL_KEYS_START + slot * 8;
  for (let j = 0; j < 8; j++) words[base + j] = w[j];
}
function writeAnchor(words, slot, ev) {
  const w = encodeMemoryIndexSlot({
    slotIndex: slot, recordId: stableRecordIdFor(ev.id), family: ev.family,
    domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: slot, expiryEpoch: 0n,
  });
  const base = RANGES.MEMORY_INDEX_START + slot * 8;
  for (let j = 0; j < 8; j++) words[base + j] = w[j];
}
function writeCategoryLens(words, entry, edgeType, weight = 0x8000) {
  words[RANGES.RELATIONS_START + entry] = encodeRelationCategoryLens({ entryIndex: entry, edgeType, weight });
}
function writeRelationEdge(words, entryIndex, sourceSlot, targetSlot, edgeType) {
  words[RANGES.RELATIONS_START + entryIndex] = encodeRelationEdge({ entryIndex, sourceSlot, targetSlot, edgeType, weight: 1 });
}

// ── Scoring driver ─────────────────────────────────────────────────────────
let reranker;
async function getReranker() {
  if (!reranker) reranker = rerankerArg === 'env' ? await rerankerFromEnv() : await createDeterministicReranker();
  return reranker;
}
function baseOpts(overrides = {}) {
  return {
    weights: DEFAULT_PROFILE.compositeWeights,
    biEncoder: null, // never called (corpus embeddings pre-baked)
    reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
    relationHopBudget: 3, abstentionThreshold: 0.001, rerankerTopK: 10, retrievalKeyTopK: 50,
    firstStageTopK: 3200, rerankerInputTopK: 3, lensTopK: 36, lensWeight: 0.4, anchorWeight: 0.6,
    relationExpansionBudget: 12, categoryLensExpansionBudget: 0,
    temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1,
    lensDiversityFloor: undefined, pipelineVersion: DEFAULT_PROFILE.pipelineVersion,
    ...overrides,
  };
}
async function score(words, corpus, queryEvent, opts) {
  const pack = { epochId: 0, evalSeedCommit: '0x' + 'c7'.repeat(32), events: [queryEvent] };
  const r = await evaluateRetrievalBenchmarkState({ words }, corpus, pack, opts);
  const pq = r.perQuery?.[0];
  return { composite: r.composite, nDCG10: r.nDCG10, recall10: r.recall10, mrr10: r.mrr10, perQuery: pq };
}
// Find a relevant doc's rank + source set in the final ranking.
function relevantRows(pq) {
  return (pq?.finalRankingTop20 ?? []).filter((r) => r.relevance > 0)
    .map((r) => ({ rank: r.rank, docId: r.docId, sources: r.sources, lensBonus: +r.lensBonus.toFixed(4), categoryLensBonus: +r.categoryLensBonus.toFixed(4), anchorBonus: +r.anchorBonus.toFixed(4), temporalBonus: +r.temporalBonus.toFixed(4), rerankerScore: +r.rerankerScore.toFixed(4) }));
}
function inCap(pq, docId) { return (pq?.cappedDocIds ?? []).includes(docId); }

// ════════════════════════════════════════════════════════════════════════════
// COMPONENT: retrieval keys / lens vectors
// Build: query orthogonal to its answer doc (stage-1 miss); several distractors
// with modest query-cosine fill the small cap. A lens vector aligned with the
// answer must promote the answer into the cap and lift its rank. Lens-only,
// no anchors. Success: relevant doc in top-10 with source=stage1 (NOT
// anchorMandatory) and a positive lensBonus; rank improves vs lens-off.
// ════════════════════════════════════════════════════════════════════════════
async function probeLens() {
  const qDir = dir('lens:query');
  const aDir = dir('lens:answer');           // ~orthogonal to qDir => stage-1 miss
  const answer = { id: 'rescue:lens:answer::truth', text: 'Paris is the capital city of France.', vec: aDir, relevance: 1 };
  // distractors: modest query-cosine (0.32), so they fill the cap by biCosine
  // and the answer (cos~0) is excluded UNTIL the lens promotes it.
  const negs = [];
  for (let i = 0; i < 5; i++) {
    // modest query-cosine (~0.2): fills the cap by biCosine, but low enough
    // that the lens bonus (0.4) decisively promotes the answer past it.
    const v = combine([{ v: qDir, w: 0.2 }, { v: dir('lens:neg' + i), w: 0.98 }]);
    negs.push({ id: `rescue:lens:neg${i}`, text: `Unrelated trivia number ${i} about rivers and weather.`, vec: v, relevance: 0 });
  }
  const ev = mkEvent({ id: 'rescue:lens:q', queryText: 'What is the capital of France?', queryVec: qDir, truths: [answer], negs });
  const corpus = mkCorpus([ev]);
  const geom = { 'cos(query,answer)': +cos(qDir, aDir).toFixed(3), 'cos(query,neg0)': +cos(qDir, combine([{ v: qDir, w: 0.34 }, { v: dir('lens:neg0'), w: 0.94 }])).toFixed(3), 'cos(answer,lens=answer)': 1 };
  await getReranker();

  // lens-OFF (empty state): answer should be below cap, rank low.
  const off = await score(emptyWords(), corpus, ev, baseOpts());
  // lens-ON: retrieval key slot 0 = answer direction.
  const wOn = emptyWords(); writeRetrievalKey(wOn, 0, aDir);
  const on = await score(wOn, corpus, ev, baseOpts());

  const offRel = relevantRows(off.perQuery), onRel = relevantRows(on.perQuery);
  const offRank = offRel[0]?.rank ?? null, onRank = onRel[0]?.rank ?? null;
  const answerInCapOff = inCap(off.perQuery, answer.id), answerInCapOn = inCap(on.perQuery, answer.id);
  const onSrc = onRel[0]?.sources ?? [];
  // Mechanism pass (reranker-agnostic): the lens promotes the answer into the
  // cap via a non-anchor source. Rank pass (needs real relevance => Qwen):
  // the answer reaches top-10 and the composite lifts. The deterministic
  // reranker emits ~random scores, so it can only validate the mechanism.
  const promotedIntoCap = answerInCapOn && !answerInCapOff;
  const nonAnchor = onSrc.length > 0 && !onSrc.includes('anchorMandatory');
  const lensActive = (onRel[0]?.lensBonus ?? 0) > 0;
  const rankOk = onRank !== null && onRank <= 10;
  const liftOk = on.composite > off.composite + 1e-9;
  const mechanismPass = promotedIntoCap && nonAnchor && lensActive;
  const pass = mechanismPass && (rerankerArg === 'env' ? (rankOk && liftOk) : true);
  return {
    component: 'lens', pass, mechanismPass, rankOk, liftOk, geom,
    layerCheck: {
      corpusPathExists: true,
      decoderEmitsLens: lensActive,
      poolIncludesAnswerViaSource: promotedIntoCap,
      rerankerRanksIt: rankOk,
      metricCredits: liftOk,
    },
    off: { composite: +off.composite.toFixed(4), nDCG10: +off.nDCG10.toFixed(4), answerRank: offRank, answerInCap: answerInCapOff, relevant: offRel },
    on: { composite: +on.composite.toFixed(4), nDCG10: +on.nDCG10.toFixed(4), answerRank: onRank, answerInCap: answerInCapOn, relevant: onRel },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// COMPONENT: temporal hints
// Build: one temporal query whose event carries a CURRENT truth (the answer)
// and a STALE truth (outdated), with near-identical embeddings + comparable
// text so stage-1/reranker ~tie them. Anchor the event so BOTH truths are
// equally surfaced (no answer-biased anchoring). The temporal boost(+) /
// suppression(-) must order current ABOVE stale. Compare family=temporal vs
// family=multi_hop_relation (temporal off). Success: temporal flips/creates
// the correct current>stale ordering.
// ════════════════════════════════════════════════════════════════════════════
async function probeTemporal() {
  const qDir = dir('temporal:query');
  // IDENTICAL embedding + text for current & stale so the reranker and biCosine
  // score them equally — temporal boost/suppression is then the ONLY
  // differentiator. docIds are chosen so the lexicographic tie-break favors the
  // STALE doc (a_ < z_): without temporal, stale ranks ABOVE current (wrong);
  // temporal must flip it. Both anchored (equally surfaced, no answer bias).
  const v = combine([{ v: qDir, w: 0.7 }, { v: dir('temporal:topic'), w: 0.7 }]);
  const sameText = 'Acme Corp leadership record for the requested role.';
  const current = { id: 'rescue:temporal:z_current::truth', text: sameText, vec: v, isCurrent: true, relevance: 1 };
  const stale = { id: 'rescue:temporal:a_stale::truth', text: sameText, vec: v, isCurrent: false, relevance: 0 };
  await getReranker();

  async function run(family) {
    const ev = mkEvent({ id: 'rescue:temporal:q', family, queryText: 'Who is the current CEO of Acme Corp right now?', queryVec: qDir, truths: [current, stale] });
    const corpus = mkCorpus([ev]);
    const words = emptyWords(); writeAnchor(words, 0, ev); // anchor event => both truths mandatory, flags set
    const r = await score(words, corpus, ev, baseOpts({ rerankerInputTopK: 10 }));
    const rows = (r.perQuery?.finalRankingTop20 ?? []);
    const rowOf = (id) => rows.find((x) => x.docId === id);
    return { composite: +r.composite.toFixed(4), curRow: rowOf(current.id), staleRow: rowOf(stale.id), rows };
  }
  const on = await run('temporal');
  const off = await run('multi_hop_relation');
  const onCurRank = on.curRow?.rank ?? null, onStaleRank = on.staleRow?.rank ?? null;
  const offCurRank = off.curRow?.rank ?? null, offStaleRank = off.staleRow?.rank ?? null;
  const temporalApplied = (on.curRow?.temporalBonus ?? 0) > 0 && (on.staleRow?.temporalBonus ?? 0) < 0;
  const orderingCorrectOn = onCurRank !== null && onStaleRank !== null && onCurRank < onStaleRank;
  const staleAboveCurrentOff = offCurRank !== null && offStaleRank !== null && offStaleRank < offCurRank;
  // Clean causal proof: identical docs => without temporal, stale ranks above
  // current (tie-break); temporal must FLIP to current-above-stale.
  const temporalFlipped = staleAboveCurrentOff && orderingCorrectOn;
  const pass = temporalApplied && temporalFlipped;
  return {
    component: 'temporal', pass, mechanismPass: pass,
    layerCheck: {
      corpusPathExists: true,
      decoderEmitsTemporal: temporalApplied,
      poolIncludesAnswerViaSource: (on.curRow?.sources ?? []).length > 0,
      rerankerRanksIt: orderingCorrectOn,
      metricCredits: temporalFlipped, // temporal CHANGED the order (causal)
    },
    detail: {
      temporal_on: { curRank: onCurRank, staleRank: onStaleRank, curTemporalBonus: +(on.curRow?.temporalBonus ?? 0).toFixed(3), staleTemporalBonus: +(on.staleRow?.temporalBonus ?? 0).toFixed(3), composite: on.composite },
      temporal_off: { curRank: offCurRank, staleRank: offStaleRank, composite: off.composite },
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// COMPONENT: Phase A relations (anchor-to-anchor BFS through decoded.relations)
// Build: anchor a NON-answer bridge slot; substrate relation edge bridge->answer
// slot; the answer must enter via anchorBFS, NOT direct mandatory. Tested in two
// configs to localize wiring:
//   (a) answer slot ALSO anchored -> answer is anchorMandatory (BFS only re-tags)
//   (b) answer slot NOT anchored  -> Phase A skips it (anchorSlotToEvent miss)
// Success: a relevant doc reaches top-10 with anchorBFS in sources and WITHOUT
// anchorMandatory.
// ════════════════════════════════════════════════════════════════════════════
async function probePhaseA() {
  const qDir = dir('phaseA:query');
  const bridgeVec = combine([{ v: qDir, w: 0.6 }, { v: dir('phaseA:bridge'), w: 0.8 }]); // query-close
  const ansVec = dir('phaseA:answer'); // query-far => stage-1 miss
  const bridge = mkEvent({ id: 'rescue:phaseA:bridge', queryText: 'bridge', queryVec: bridgeVec, truths: [{ id: 'rescue:phaseA:bridge::truth', text: 'Intermediate bridge fact linking the topic to its derivation.', vec: bridgeVec, relevance: 0 }] });
  const answer = mkEvent({ id: 'rescue:phaseA:answer', queryText: 'What does the bridge derive to?', queryVec: qDir, truths: [{ id: 'rescue:phaseA:answer::truth', text: 'The derived answer entity is Zeta Industries, headquartered in Oslo.', vec: ansVec, relevance: 1 }] });
  const answerId = 'rescue:phaseA:answer::truth';
  await getReranker();

  async function run(anchorAnswerSlot) {
    const corpus = mkCorpus([answer, bridge]);
    const words = emptyWords();
    writeAnchor(words, 0, bridge);                 // slot 0 = bridge (non-answer)
    if (anchorAnswerSlot) writeAnchor(words, 1, answer); // optionally anchor answer at slot 1
    writeRelationEdge(words, 0, 0, 1, 'derived_from'); // substrate edge slot0 -> slot1
    // firstStageTopK=1 so stage-1 surfaces ONLY the query-close bridge and MISSES
    // the query-far answer — Phase A must be the causal path if it works at all.
    const r = await score(words, corpus, answer, baseOpts({ firstStageTopK: 1, rerankerInputTopK: 10, relationExpansionBudget: 12 }));
    const row = (r.perQuery?.finalRankingTop20 ?? []).find((x) => x.docId === answerId);
    return { composite: +r.composite.toFixed(4), row, inCap: inCap(r.perQuery, answerId) };
  }
  const anchored = await run(true);   // (a)
  const unanchored = await run(false); // (b) the proper non-mandatory test
  const srcA = anchored.row?.sources ?? [], srcB = unanchored.row?.sources ?? [];
  const passUnanchored = unanchored.row != null && (unanchored.row.rank <= 10) && srcB.includes('anchorBFS') && !srcB.includes('anchorMandatory');
  const pass = passUnanchored;
  return {
    component: 'phaseA', pass, mechanismPass: pass,
    layerCheck: {
      corpusPathExists: true,
      decoderEmitsRelationEdge: true,
      poolIncludesAnswerViaSource: srcB.includes('anchorBFS'),
      rerankerRanksIt: (unanchored.row?.rank ?? 99) <= 10,
      metricCredits: passUnanchored,
    },
    detail: {
      config_a_answerAlsoAnchored: { answerSources: srcA, answerRank: anchored.row?.rank ?? null },
      config_b_answerNotAnchored: { answerSources: srcB, answerRank: unanchored.row?.rank ?? null, answerInPool: unanchored.row != null },
      localization: !unanchored.row
        ? 'Phase A could NOT add the answer: edge target slot is not in anchorSlotToEvent — relation edges only traverse ANCHORED slots, so a non-anchored answer event is unreachable. anchorBFS-only signal is structurally impossible without seeding corpus-relation expansion from anchors.'
        : (srcB.includes('anchorBFS') && !srcB.includes('anchorMandatory') ? 'answer reached via anchorBFS (non-mandatory) — Phase A works'
          : `answer present via ${JSON.stringify(srcB)} (not anchorBFS-only)`),
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// COMPONENT: selective Phase B (corpus-native category-lens BFS)
// Build: stage-1 lands on a true BRIDGE event (query-close), NOT the answer.
// The bridge has a FORWARD corpus relation bridge->answer (edgeType derived_from)
// matching a substrate category-lens. Answer is query-FAR (stage-1 misses it;
// firstStageTopK kept small). No anchors, forward-only, budget 2, bonus OFF
// initially, large cap so the Phase-B-added answer is reranked. Success: answer
// in top-10 via categoryLensBFS, no anchorMandatory, no hard-neg flood.
// ════════════════════════════════════════════════════════════════════════════
async function probeSelectivePhaseB() {
  const qDir = dir('phaseB:query');
  const bridgeVec = combine([{ v: qDir, w: 0.75 }, { v: dir('phaseB:bridge'), w: 0.66 }]); // query-close
  const ansVec = dir('phaseB:answer'); // query-far
  const answer = mkEvent({
    id: 'rescue:phaseB:answer', queryText: 'Which company did the flagship project derive from?', queryVec: qDir,
    truths: [{ id: 'rescue:phaseB:answer::truth', text: 'The flagship project derived from Helios Robotics, founded 2014 in Turin.', vec: ansVec, relevance: 1 }],
  });
  const bridge = mkEvent({
    id: 'rescue:phaseB:bridge', queryText: 'bridge', queryVec: bridgeVec,
    truths: [{ id: 'rescue:phaseB:bridge::truth', text: 'The flagship project is a robotics initiative under review.', vec: bridgeVec, relevance: 0 }],
    relations: [{ other_id: 'rescue:phaseB:answer', edgeType: 'derived_from' }],
  });
  const distractors = [];
  for (let i = 0; i < 3; i++) {
    const v = combine([{ v: qDir, w: 0.3 }, { v: dir('phaseB:d' + i), w: 0.95 }]);
    distractors.push(mkEvent({ id: `rescue:phaseB:d${i}`, queryText: 'd', queryVec: v, truths: [{ id: `rescue:phaseB:d${i}::truth`, text: `Tangential note ${i} about logistics.`, vec: v, relevance: 0 }] }));
  }
  const answerId = 'rescue:phaseB:answer::truth';
  const corpus = mkCorpus([answer, bridge, ...distractors]);
  await getReranker();
  // category-lens for derived_from, forward-only, budget 2, bonus OFF.
  const words = emptyWords(); writeCategoryLens(words, 127, 'derived_from', 0x8000);
  // firstStageTopK small so stage-1 surfaces the bridge + distractors but MISSES the query-far answer.
  const opts = baseOpts({
    firstStageTopK: 3, rerankerInputTopK: 20, categoryLensExpansionBudget: 2,
    categoryLensTraversalDirection: 'forward', categoryLensBonusEnabled: false,
  });
  const off = await score(emptyWords(), corpus, answer, baseOpts({ firstStageTopK: 3, rerankerInputTopK: 20, categoryLensExpansionBudget: 0 }));
  const on = await score(words, corpus, answer, opts);
  const onRows = on.perQuery?.finalRankingTop20 ?? [];
  const ansRow = onRows.find((x) => x.docId === answerId);
  const offRows = off.perQuery?.finalRankingTop20 ?? [];
  const ansOff = offRows.find((x) => x.docId === answerId);
  const src = ansRow?.sources ?? [];
  // hard-neg flood: count categoryLensBFS-sourced hard negatives (rel 0) in top-20
  const floodCatLens = onRows.filter((x) => x.relevance === 0 && (x.sources ?? []).includes('categoryLensBFS')).length;
  const reachedViaPhaseB = src.includes('categoryLensBFS') && !src.includes('anchorMandatory');
  const pass = ansRow != null && ansRow.rank <= 10 && reachedViaPhaseB && floodCatLens === 0;
  return {
    component: 'selective-phaseB', pass, mechanismPass: pass,
    layerCheck: {
      corpusPathExists: true,
      decoderEmitsCategoryLens: true,
      poolIncludesAnswerViaSource: src.includes('categoryLensBFS'),
      rerankerRanksIt: (ansRow?.rank ?? 99) <= 10,
      metricCredits: pass,
    },
    detail: {
      off_answerRank: ansOff?.rank ?? null, off_answerInResults: ansOff != null,
      on_answerRank: ansRow?.rank ?? null, on_answerSources: src, hardNegCatLensFlood: floodCatLens,
      composite_off: +off.composite.toFixed(4), composite_on: +on.composite.toFixed(4),
    },
  };
}

const PROBES = { lens: probeLens, temporal: probeTemporal, phaseA: probePhaseA, 'selective-phaseB': probeSelectivePhaseB };

const components = componentArg === 'all' ? Object.keys(PROBES) : [componentArg];
const results = [];
for (const c of components) {
  if (!PROBES[c]) { console.error(`[rescue] unknown component ${c} (have: ${Object.keys(PROBES).join(',')})`); exit(2); }
  console.log(`[rescue] component=${c} reranker=${rerankerArg}`);
  const r = await PROBES[c]();
  results.push(r);
  console.log(`  PASS=${r.pass}`);
  console.log(`  layers: ${Object.entries(r.layerCheck).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (r.on || r.off) {
    console.log(`  off: rank=${r.off.answerRank} inCap=${r.off.answerInCap} composite=${r.off.composite}`);
    console.log(`  on : rank=${r.on.answerRank} inCap=${r.on.answerInCap} composite=${r.on.composite} src=${JSON.stringify(r.on.relevant[0]?.sources ?? [])} lensBonus=${r.on.relevant[0]?.lensBonus ?? 0}`);
  }
  if (r.detail) console.log(`  detail: ${JSON.stringify(r.detail)}`);
}
await reranker?.close?.();

const report = {
  schemaVersion: 'coretex.component-rescue.v1',
  generatedAt: new Date().toISOString(),
  reranker: rerankerArg,
  layout: LAYOUT,
  results,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[rescue] report -> ${reportPath}`);
const allPass = results.every((r) => r.pass);
console.log(`[rescue] ALL PASS=${allPass}`);
exit(0);
