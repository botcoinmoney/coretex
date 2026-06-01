#!/usr/bin/env node
/**
 * r5 bottom-up oracle-ladder STEP-3 (oracle UPPER BOUND) — the THREE newly-synthesized
 * memory-operation families on the r5-synthesis corpus. CPU ONLY, deterministic reranker
 * (A100 STOPPED).
 *
 *   FAMILY 3 — conflict_lifecycle  (current vs contradicting-conflict vs scope_differs)
 *   FAMILY 4 — aspect_constraint   (query intentAspect vs multi-aspect / wrong-aspect docs)
 *   FAMILY 5b — abstention_missing (abstain iff no reliable evidence path / low top1Score)
 *
 * Sibling of scripts/probe-r5-oracle-ladder-fam5-fam2.mjs + probe-admission-headroom.mjs.
 * Faithful reuse (NO reimplemented scoring): buildV2ProductionCorpus + scoringOptionsFromProfile
 * (LOCKED deep profile) + createDeterministicReranker + evaluateRetrievalBenchmarkState, with the
 * additive opt-in `exposeFullRanking:true` so perQuery carries the FULL reranked list; nDCG@K is
 * recomputed faithfully with the SAME exported ndcgAtK.
 *
 * HONESTY RULES (enforced):
 *   - The policy SIGNAL is PUBLIC / proposer-visible only. Public doc fields read DIRECTLY from
 *     the LOGICAL corpus (the production bridge drops them, so per the task we read them from
 *     logical.docs/queries): doc.kind, doc.lifecycleState, doc.lifecycleScope, doc.aspectTags,
 *     doc.currentStaleFlag, doc.timestamp; query.intentAspect; public co_occurs_with edges; and
 *     the scorer-observable top1Score / biCosine. NEVER the qrel `role`
 *     (direct/conflict/scope_differs/wrong_aspect) NOR qrel relevance as the ACTION input — those
 *     are EVAL labels, used ONLY to LABEL/measure.
 *   - The deterministic reranker is a WEAK proxy for the final-reorder magnitude → a final-REORDER
 *     (boost/suppress) lift is reported as CPU-INCONCLUSIVE (needs A100). Admission/abstention/
 *     metric/source-attribution effects are CPU-decisive.
 *   - BOUNDED actions only (boost/suppress the identified docs; not wholesale).
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const {
  scoringOptionsFromProfile, evaluateRetrievalBenchmarkState, createDeterministicReranker,
  encodeRelationCategoryLens, encodeMemoryIndexSlot, encodeTemporalRecord, stableRecordIdFor,
  decodeSubstrate, RANGES, ndcgAtK,
} = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = resolve(repoRoot, flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-corpus.json'));
const embPath = resolve(repoRoot, flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-embeddings.json'));
const profilePath = resolve(repoRoot, flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-deep-r1.json'));
const outPath = resolve(repoRoot, flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/r5-oracle-ladder-fam3-fam4-fam5b.json'));
const temporalBatch = Number(flag('temporal-batch', '40'));

const START_T = Date.now();
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const { corpus, queryEvents, logical, LAYOUT, BE, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));
const docById = new Map(logical.docs.map((d) => [d.id, d]));
const K = profile.rerankerTopK ?? 10;
const memId = (docId) => `mem_${docId}`;
const stripMem = (id) => (typeof id === 'string' && id.startsWith('mem_')) ? id.slice(4) : id;
const round = (x) => (x == null ? null : +x.toFixed(4));
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ── PUBLIC co_occurs_with edges (miner-visible Memory IR; carry label contradicts/scope_differs) ──
const PUBLIC_EDGES = new Set(['supersedes', 'supports', 'causes', 'coreference_of', 'co_occurs_with']);

// ── substrate words (IDENTICAL to the sibling probes) ─────────────────────────
const emptyWords = () => new Array(RANGES.WORD_COUNT).fill(0n);
function applyRelationLenses(words) {
  const edges = ['supports', 'causes', 'supersedes', 'coreference_of'];
  for (let i = 0; i < edges.length; i++) words[RANGES.RELATIONS_START + (128 - 1 - i)] = encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: edges[i], weight: 0x8000 });
}
function applyTemporalRecords(words, temporalLogicalQueries) {
  let slot = 0, rec = 0;
  for (const lq of temporalLogicalQueries) {
    if (rec >= 96 || slot + 1 >= 352) break;
    const cur = (lq.qrels ?? []).find((r) => r.role === 'direct');
    const stale = (lq.qrels ?? []).find((r) => r.role === 'stale');
    if (!cur || !stale) continue;
    const staleSlot = slot++, curSlot = slot++;
    words[RANGES.MEMORY_INDEX_START + staleSlot] = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(memId(stale.docId)), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, retrievalSlot: 0, expiryEpoch: 0n })[0];
    words[RANGES.MEMORY_INDEX_START + curSlot] = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(memId(cur.docId)), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n })[0];
    const tw = encodeTemporalRecord({ recordIndex: rec, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
    for (let j = 0; j < tw.length; j++) words[RANGES.TEMPORAL_START + rec * tw.length + j] = tw[j];
    rec++;
  }
}

// ── LOCKED deep profile scoring options + exposeFullRanking opt-in ────────────
const reranker = await createDeterministicReranker();
const baseOpts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
const opts = { ...baseOpts, exposeFullRanking: true };
console.error(`[r5] opts: rerankerInputTopK=${opts.rerankerInputTopK} ownerScopeMode=${opts.ownerScopeMode} K=${K} abstentionThreshold=${opts.abstentionThreshold} temporalStaleContrast=${opts.temporalStaleContrast}`);

// ── eval_hidden, bucketed by the LOGICAL family (the 3 r5 families + the answerable set) ──
const evalAll = queryEvents.filter((ev) => ev.split === 'eval_hidden');
const byLogical = new Map();
for (const ev of evalAll) { const f = ev.logicalFamily; if (!byLogical.has(f)) byLogical.set(f, []); byLogical.get(f).push(ev); }
for (const [, arr] of byLogical) arr.sort((a, b) => a.id.localeCompare(b.id));
console.error(`[r5] eval_hidden by logicalFamily: ${[...byLogical].map(([f, a]) => `${f}=${a.length}`).join(' ')}`);

const corpusRoot = corpus.corpusRoot;
const mkPack = (evs) => ({ epochId: 0, evalSeedCommit: '0x' + 'ad'.repeat(32), evalSeedHex: '0x' + 'ad'.repeat(32), corpusRoot, events: evs });

// ── run the relevant families through the real scorer ─────────────────────────
// conflict_lifecycle is bucketed to 'temporal' by the bridge → its events carry bucket 'temporal'
// and the scorer applies temporalStaleContrast. conflict qrels use roles direct/conflict/scope_differs
// (NO 'stale' role) → contrast zeroes nothing for them (verified). We still must NOT apply temporal
// substrate records to conflict queries (their qrels have no direct/stale PAIR), so we score them as a
// non-temporal batch with relation lenses only — substrate config matches the sibling probe's policy.
const perQueryAll = [];
async function runBatchNonTemporal(family, events) {
  if (!events.length) return;
  const words = emptyWords(); applyRelationLenses(words);
  const sc = await evaluateRetrievalBenchmarkState({ words }, corpus, mkPack(events), opts);
  for (const pq of sc.perQuery) perQueryAll.push({ ...pq, _logicalFamily: family, _bucket: events[0].family });
}
async function runTemporal(family, events) {
  if (!events.length) return;
  let b = 0;
  for (let i = 0; i < events.length; i += temporalBatch) {
    const batch = events.slice(i, i + temporalBatch);
    const words = emptyWords(); applyRelationLenses(words);
    applyTemporalRecords(words, batch.map((ev) => logicalQById.get(ev.id)).filter(Boolean));
    const sc = await evaluateRetrievalBenchmarkState({ words }, corpus, mkPack(batch), opts);
    for (const pq of sc.perQuery) perQueryAll.push({ ...pq, _logicalFamily: family, _bucket: 'temporal' });
    console.error(`[r5] ${family} temporal batch ${++b} (${batch.length} q)`);
  }
}
// Families we score: the 3 r5 families + the answerable comparison set for abstention (temporal_update,
// multi_session_bridge, decision_provenance, causal_memory_chain, coreference_resolution).
const wantFamilies = new Set(['conflict_lifecycle', 'aspect_constraint', 'abstention_missing',
  'temporal_update', 'multi_session_bridge', 'decision_provenance', 'causal_memory_chain', 'coreference_resolution']);
for (const [family, events] of byLogical) {
  if (!wantFamilies.has(family)) continue;
  console.error(`[r5] scoring ${family}: ${events.length}`);
  if (family === 'temporal_update') await runTemporal(family, events);
  else await runBatchNonTemporal(family, events);
}
console.error(`[r5] scored ${perQueryAll.length} queries`);

// ── per-query ctx built from PUBLIC structure + qrels(label-only) ─────────────
// temporalStaleContrast (locked profile=true) zeroes role:'stale' docs for bucket='temporal' queries
// (in BOTH ranked relevance and idealRels). conflict_lifecycle is bucketed temporal but has NO 'stale'
// role → effRel = rawRel for it. We replicate the scorer's reward law exactly for baseline fidelity.
function ctx(pq) {
  const lq = logicalQById.get(pq.recordId);
  const qrels = lq?.qrels ?? [];
  const isTemporalContrast = opts.temporalStaleContrast === true && pq._bucket === 'temporal';
  const staleSet = new Set(qrels.filter((r) => r.role === 'stale').map((r) => r.docId));
  const effRel = (docId, rawRel) => (isTemporalContrast && staleSet.has(docId)) ? 0 : rawRel;
  const relByDoc = new Map(qrels.map((r) => [r.docId, effRel(r.docId, r.relevance)]));  // LABEL ONLY
  const roleByDoc = new Map(qrels.map((r) => [r.docId, r.role]));                       // LABEL ONLY (for attribution)
  const idealRels = qrels.map((r) => effRel(r.docId, r.relevance));
  const answerSet = new Set(qrels.filter((r) => effRel(r.docId, r.relevance) > 0).map((r) => r.docId));
  const full = (pq.finalRankingFull && pq.finalRankingFull.length)
    ? pq.finalRankingFull.map((r) => ({ docId: stripMem(r.docId), relevance: effRel(stripMem(r.docId), r.relevance) }))
    : (pq.finalRankingTop20 ?? []).map((r) => ({ docId: stripMem(r.docId), relevance: effRel(stripMem(r.docId), r.relevance) }));
  const biByDoc = new Map();
  const capIds = (pq.cappedDocIds ?? []).map(stripMem);
  const comps = pq.cappedDocComponents ?? [];
  for (let i = 0; i < capIds.length; i++) biByDoc.set(capIds[i], comps[i]?.biCosine ?? 0);
  return { lq, qrels, relByDoc, roleByDoc, idealRels, answerSet, full, biByDoc, capIds };
}
function ndcgOf(order, idealRels) { return ndcgAtK(order.map((d) => ({ documentId: d.docId, relevance: d.relevance })), idealRels, K); }
// stable reorder: boostSet to the front (in their current relative order), suppressSet to the tail,
// everything else keeps its relative position. BOUNDED: only docs the public signal selects move.
function reorder(full, boostSet, suppressSet) {
  const boosted = full.filter((d) => boostSet.has(d.docId));
  const middle = full.filter((d) => !boostSet.has(d.docId) && !suppressSet.has(d.docId));
  const tail = full.filter((d) => suppressSet.has(d.docId));
  return [...boosted, ...middle, ...tail];
}

// rank (1-based) of a doc in an order; Infinity if absent.
const rankOf = (order, docId) => { const i = order.findIndex((d) => d.docId === docId); return i < 0 ? Infinity : i + 1; };

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 3 — conflict_lifecycle
// ════════════════════════════════════════════════════════════════════════════
// PUBLIC SIGNAL (read from logical.docs — the bridge drops these fields, so per the task we read
// the public feature from the LOGICAL corpus directly):
//   doc.kind ∈ {lifecycle_conflict, lifecycle_scope}
//   doc.lifecycleState ∈ {conflict_resolved (the CURRENT answer), conflict_candidate (the
//     contradicting/superseded conflict), scope_differs (a different-scope record)}
//   doc.currentStaleFlag, doc.timestamp (the resolved record is the newest of its conflict set)
// NOTE: the task brief assumed doc.kind + currentStaleFlag would separate the current from the
// conflict doc, but BOTH the direct and the conflict doc carry kind=lifecycle_conflict AND
// currentStaleFlag=true (verified) — kind/currentStaleFlag alone CANNOT separate them. The actual
// public separator is doc.lifecycleState (conflict_resolved vs conflict_candidate) + timestamp.
// lifecycleState is a PUBLIC doc field (not a qrel role) → honest to use as the ACTION signal.
// BOUNDED ORACLE: boost lifecycleState=conflict_resolved docs (the current answer); suppress
// lifecycleState=conflict_candidate docs (the contradicting conflict). LEAVE lifecycle_scope
// (scope_differs) docs in place (they carry rel 0.2, partial credit — not to be damaged).
// qrels (LABEL only): direct=1, scope_differs=0.2, conflict=0.
function runConflictLifecycle() {
  const pqs = perQueryAll.filter((pq) => pq._logicalFamily === 'conflict_lifecycle');
  const deltas = [];
  let currentRoseQueries = 0, conflictFellQueries = 0, scopeUndamagedQueries = 0, scopeDamagedQueries = 0;
  let boostedTotal = 0, boostedTrueDirect = 0, suppressedTotal = 0, suppressedTrueConflict = 0, suppressedTrueAnswer = 0;
  let sliceQueries = 0, signalSeparatesQueries = 0;
  for (const pq of pqs) {
    const c = ctx(pq);
    if (!c.full.length) continue;
    const baseNdcg = ndcgOf(c.full, c.idealRels);
    // PUBLIC partition of the in-cap/full docs by lifecycleState (read from logical.docs).
    const boost = new Set(), suppress = new Set();
    for (const d of c.full) {
      const ld = docById.get(d.docId);
      if (!ld) continue;
      if (ld.lifecycleState === 'conflict_resolved') boost.add(d.docId);
      else if (ld.lifecycleState === 'conflict_candidate') suppress.add(d.docId);
      // scope_differs (lifecycle_scope) left untouched
    }
    if (!boost.size && !suppress.size) continue; // public signal selected nothing in this query's list
    sliceQueries++;
    if (boost.size && suppress.size) signalSeparatesQueries++;
    const oracleOrder = reorder(c.full, boost, suppress);
    const oracleNdcg = ndcgOf(oracleOrder, c.idealRels);
    deltas.push(oracleNdcg - baseNdcg);
    // ── source attribution (LABEL-only measurement) ──
    // current = the role:'direct' (rel 1) doc; conflict = role:'conflict' (rel 0) doc; scope = role:'scope_differs'.
    const directDoc = c.qrels.find((r) => r.role === 'direct')?.docId;
    const conflictDoc = c.qrels.find((r) => r.role === 'conflict')?.docId;
    const scopeDoc = c.qrels.find((r) => r.role === 'scope_differs')?.docId;
    if (directDoc) { const r0 = rankOf(c.full, directDoc), r1 = rankOf(oracleOrder, directDoc); if (r1 < r0) currentRoseQueries++; }
    if (conflictDoc) { const r0 = rankOf(c.full, conflictDoc), r1 = rankOf(oracleOrder, conflictDoc); if (r1 > r0) conflictFellQueries++; }
    // scope (rel 0.2) "damage" measured QUERY-LOCALLY: did the scope doc fall BELOW the conflict doc
    // (rel 0), i.e. lose its rightful order over a non-answer? Absolute-rank drop is NOT damage — it is
    // the cross-pack flood (boosting all corpus conflict_resolved docs displaces it) and is corrected
    // for in nDCG (idealRels credits scope @0.2). Query-local damage = scope ranked below a rel-0 doc.
    if (scopeDoc) {
      const scopeRank = rankOf(oracleOrder, scopeDoc);
      const conflictRank = conflictDoc ? rankOf(oracleOrder, conflictDoc) : Infinity;
      if (scopeRank < conflictRank) scopeUndamagedQueries++; else scopeDamagedQueries++;
    }
    // ── bounded-action measurement (LABEL-only) ──
    // boostedTotal/suppressedTotal include SAME-KIND docs from OTHER queries' packs that flood this
    // query's cap (the public kind/lifecycleState signal is corpus-wide, not query-local) → we report
    // these as a REALISM caveat, NOT as precision. The CPU-DECISIVE facts are: was THIS query's gold
    // direct answer boosted (recall), was its conflict suppressed (recall), and was its DIRECT (rel=1)
    // answer EVER wrongly suppressed (damage). The role:scope_differs (rel 0.2) doc is intentionally
    // LEFT in place; the role:conflict (rel 0) doc is intentionally suppressed (not "damage").
    for (const id of boost) { boostedTotal++; if (id === directDoc) boostedTrueDirect++; }
    for (const id of suppress) { suppressedTotal++; if (id === conflictDoc) suppressedTrueConflict++; if (id === directDoc || id === scopeDoc) suppressedTrueAnswer++; }
  }
  return {
    sliceDefinition: 'conflict_lifecycle eval_hidden queries (18). PUBLIC labels used (read from logical.docs — bridge drops them): doc.kind∈{lifecycle_conflict,lifecycle_scope}, doc.lifecycleState∈{conflict_resolved,conflict_candidate,scope_differs}, doc.currentStaleFlag, doc.timestamp. NO qrel role/relevance as signal.',
    publicSignalCorrection: 'TASK-BRIEF DEVIATION (honest): the brief assumed doc.kind + currentStaleFlag separate current-vs-conflict, but BOTH the direct answer and the contradicting conflict doc carry kind=lifecycle_conflict AND currentStaleFlag=true. The real PUBLIC separator is doc.lifecycleState (conflict_resolved=current answer vs conflict_candidate=contradiction) — a public doc field, not a qrel role. Oracle uses lifecycleState (+ kind for the scope class).',
    oracleAction: 'BOUNDED: boost docs with lifecycleState=conflict_resolved (the current answer) to the front; suppress docs with lifecycleState=conflict_candidate (the contradiction) to the tail; LEAVE lifecycle_scope (scope_differs, rel 0.2) docs in place. Recompute nDCG@K.',
    sliceQueries,
    signalSeparatesQueries,
    deltaQueries: deltas.length,
    meanDeltaNdcg: round(mean(deltas)),
    medianDeltaNdcg: round(median(deltas)),
    positiveDeltaQueries: deltas.filter((d) => d > 1e-9).length,
    negativeDeltaQueries: deltas.filter((d) => d < -1e-9).length,
    sourceAttribution: {
      currentRoseQueries, conflictFellQueries,
      scopeUndamagedQueries, scopeDamagedQueries,
      note: 'currentRoseQueries: the role:direct (current) doc moved UP. conflictFellQueries: the role:conflict doc moved DOWN. scopeDamagedQueries: QUERY-LOCAL damage = the role:scope_differs (rel 0.2) doc ranked BELOW the role:conflict (rel 0) doc after the action (i.e. lost its rightful order over a non-answer) — must be ~0. Absolute-rank drop from the cross-pack flood is NOT counted (corrected in nDCG via idealRels@0.2).',
    },
    boundedActionPrecision: {
      goldDirectBoostedQueries: boostedTrueDirect, goldDirectBoostRecall: round(boostedTrueDirect / Math.max(1, sliceQueries)),
      goldConflictSuppressedQueries: suppressedTrueConflict, goldConflictSuppressRecall: round(suppressedTrueConflict / Math.max(1, sliceQueries)),
      answerWronglySuppressed: suppressedTrueAnswer, // role:direct OR role:scope_differs (rel>0) wrongly suppressed
      crossPackFlood: { boostedTotal, suppressedTotal, avgBoostedPerQuery: round(boostedTotal / Math.max(1, sliceQueries)), avgSuppressedPerQuery: round(suppressedTotal / Math.max(1, sliceQueries)) },
      note: 'goldDirectBoostRecall: fraction of slice queries whose role:direct (current) answer was boosted by lifecycleState=conflict_resolved. goldConflictSuppressRecall: fraction whose role:conflict doc was suppressed by lifecycleState=conflict_candidate. answerWronglySuppressed: role:direct(rel1)/role:scope_differs(rel0.2) docs wrongly suppressed (must be 0 — the conflict-candidate predicate must never select an answer). crossPackFlood: the public lifecycleState signal is CORPUS-WIDE (240 lifecycle_conflict docs total), so many SAME-KIND docs from OTHER queries packs are in this query cap and also get boosted/suppressed — a REALISM caveat: a deployable atom must AND lifecycleState with query/conflict-set scope. It does NOT damage THIS query metric (those docs carry rel 0 here).',
    },
    artifactNote: `Δ nDCG > 0 occurs ONLY where the DETERMINISTIC reranker placed the conflict/current docs sub-optimally inside top-K; median Δ = ${round(median(deltas))}. The boost/suppress is a FINAL-REORDER action on the weak deterministic reranker → magnitude is CPU-INCONCLUSIVE. CPU-DECISIVE: the public lifecycleState signal cleanly separates current/conflict/scope (boostPrecision, suppressPrecision, answerWronglySuppressed) and the source-attribution direction (current rises, conflict falls, scope undamaged).`,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 4 — aspect_constraint
// ════════════════════════════════════════════════════════════════════════════
// PUBLIC SIGNAL: query.intentAspect (logical.queries) vs doc.aspectTags (logical.docs).
// BOUNDED ORACLE: boost docs whose aspectTags INCLUDE the query intentAspect; suppress docs whose
// aspectTags are present but do NOT include the intentAspect (only non-matching aspect tags).
// Leave docs with NO aspectTags (non-aspect distractors) in place.
// qrels (LABEL only): direct=1 (aspect_answer, includes intentAspect), wrong_aspect=0.2 (aspect_neighbor, non-matching aspect).
function runAspectConstraint() {
  const pqs = perQueryAll.filter((pq) => pq._logicalFamily === 'aspect_constraint');
  const deltas = [];
  let directRoseQueries = 0, wrongAspectFellQueries = 0;
  let boostedTotal = 0, boostedTrueDirect = 0, suppressedTotal = 0, suppressedTrueWrong = 0, suppressedTrueAnswer = 0;
  let sliceQueries = 0;
  for (const pq of pqs) {
    const c = ctx(pq);
    if (!c.full.length) continue;
    const intent = c.lq?.intentAspect;
    if (!intent) continue;
    const baseNdcg = ndcgOf(c.full, c.idealRels);
    const boost = new Set(), suppress = new Set();
    for (const d of c.full) {
      const ld = docById.get(d.docId);
      const tags = ld?.aspectTags;
      if (!Array.isArray(tags) || !tags.length) continue; // non-aspect doc → leave in place
      if (tags.includes(intent)) boost.add(d.docId);
      else suppress.add(d.docId); // has aspect tags but NONE match the intent → wrong-aspect partial
    }
    if (!boost.size && !suppress.size) continue;
    sliceQueries++;
    const oracleOrder = reorder(c.full, boost, suppress);
    const oracleNdcg = ndcgOf(oracleOrder, c.idealRels);
    deltas.push(oracleNdcg - baseNdcg);
    const directDoc = c.qrels.find((r) => r.role === 'direct')?.docId;
    const wrongDoc = c.qrels.find((r) => r.role === 'wrong_aspect')?.docId;
    if (directDoc) { const r0 = rankOf(c.full, directDoc), r1 = rankOf(oracleOrder, directDoc); if (r1 < r0) directRoseQueries++; }
    if (wrongDoc) { const r0 = rankOf(c.full, wrongDoc), r1 = rankOf(oracleOrder, wrongDoc); if (r1 > r0) wrongAspectFellQueries++; }
    // boostedTotal/suppressedTotal flood with SAME-KIND aspect docs from OTHER queries packs (120
    // aspect_answer + 120 aspect_neighbor corpus-wide) → reported as a realism caveat, not precision.
    // Damage = suppressing the role:direct (rel=1) answer. The role:wrong_aspect (rel 0.2) doc is the
    // INTENDED suppression target (a partial-credit distractor we demote), NOT damage.
    for (const id of boost) { boostedTotal++; if (id === directDoc) boostedTrueDirect++; }
    for (const id of suppress) { suppressedTotal++; if (id === wrongDoc) suppressedTrueWrong++; if (id === directDoc) suppressedTrueAnswer++; }
  }
  return {
    sliceDefinition: 'aspect_constraint eval_hidden queries (17). PUBLIC labels used (logical corpus): query.intentAspect, doc.aspectTags. NO qrel role/relevance as signal.',
    oracleAction: 'BOUNDED: boost docs whose aspectTags INCLUDE query.intentAspect; suppress docs that carry aspectTags but NONE match intentAspect (wrong-aspect partials); leave docs with no aspectTags in place. Recompute nDCG@K.',
    sliceQueries,
    deltaQueries: deltas.length,
    meanDeltaNdcg: round(mean(deltas)),
    medianDeltaNdcg: round(median(deltas)),
    positiveDeltaQueries: deltas.filter((d) => d > 1e-9).length,
    negativeDeltaQueries: deltas.filter((d) => d < -1e-9).length,
    sourceAttribution: {
      directRoseQueries, wrongAspectFellQueries,
      note: 'directRoseQueries: the role:direct (intent-aspect) answer moved UP. wrongAspectFellQueries: the role:wrong_aspect (rel 0.2) doc moved DOWN.',
    },
    boundedActionPrecision: {
      goldDirectBoostedQueries: boostedTrueDirect, goldDirectBoostRecall: round(boostedTrueDirect / Math.max(1, sliceQueries)),
      goldWrongAspectSuppressedQueries: suppressedTrueWrong, goldWrongAspectSuppressRecall: round(suppressedTrueWrong / Math.max(1, sliceQueries)),
      answerWronglySuppressed: suppressedTrueAnswer, // role:direct (rel=1) wrongly suppressed (the wrong_aspect rel0.2 is the INTENDED target, not damage)
      crossPackFlood: { boostedTotal, suppressedTotal, avgBoostedPerQuery: round(boostedTotal / Math.max(1, sliceQueries)), avgSuppressedPerQuery: round(suppressedTotal / Math.max(1, sliceQueries)) },
      note: 'goldDirectBoostRecall: fraction of slice queries whose role:direct answer was boosted by aspectTags⊇intentAspect. goldWrongAspectSuppressRecall: fraction whose role:wrong_aspect doc was suppressed (has aspectTags but none match intent). answerWronglySuppressed: role:direct (rel=1) docs wrongly suppressed (must be 0). crossPackFlood: aspectTags is a CORPUS-WIDE signal (240 aspect docs total) → other queries aspect docs in this cap are also boosted/suppressed; a deployable atom must AND aspectTags with query scope. Those docs carry rel 0 here → no damage to THIS query metric.',
    },
    artifactNote: `Δ nDCG > 0 occurs ONLY where the DETERMINISTIC reranker mis-ordered the aspect docs inside top-K; median Δ = ${round(median(deltas))}. boost/suppress is a FINAL-REORDER action on the weak proxy → magnitude CPU-INCONCLUSIVE. CPU-DECISIVE: the public aspectTags⊇intentAspect signal cleanly separates direct from wrong-aspect (boostPrecision, answerWronglySuppressed) and the attribution direction.`,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 5b — abstention_missing  (metric-level, CPU-DECIDABLE)
// ════════════════════════════════════════════════════════════════════════════
// Slice: abstain:true packs (empty qrels) + a MATCHED set of answerable eval_hidden queries.
// PUBLIC SIGNAL: top1Score (scorer-observable). BOUNDED ORACLE: abstain iff top1Score < threshold.
// Measure: abstention ACCURACY on abstain packs (correctly abstained) + FALSE-abstention RATE on
// answerable queries (wrongly abstained). This is a METRIC-level decision → CPU-DECIDABLE
// (no reranking-magnitude dependence), modulo the deterministic top1Score being a weak proxy for
// the Qwen-calibrated score (flagged). We sweep the threshold to report a separability curve and
// also evaluate the profile's locked abstentionThreshold.
function runAbstention() {
  // abstain packs: eval_hidden abstention_missing (qrels empty)
  const abstainPqs = perQueryAll.filter((pq) => pq._logicalFamily === 'abstention_missing');
  // answerable comparison set: every OTHER eval_hidden family we scored, restricted to queries that
  // actually have a rel>0 qrel (truly answerable).
  const answerablePqs = perQueryAll.filter((pq) => {
    if (pq._logicalFamily === 'abstention_missing') return false;
    const lq = logicalQById.get(pq.recordId);
    return (lq?.qrels ?? []).some((r) => r.relevance > 0);
  });
  const abT = abstainPqs.map((pq) => pq.top1Score).filter((x) => typeof x === 'number');
  const anT = answerablePqs.map((pq) => pq.top1Score).filter((x) => typeof x === 'number');
  const stat = (a) => ({ n: a.length, min: round(Math.min(...a)), max: round(Math.max(...a)), mean: round(mean(a)), median: round(median(a)) });
  // accuracy at the LOCKED profile threshold
  const thr = opts.abstentionThreshold;
  const atThr = (t) => ({
    threshold: round(t),
    abstainAccuracy: round(abT.filter((s) => s < t).length / Math.max(1, abT.length)),       // correctly abstained on missing-answer packs
    falseAbstentionRate: round(anT.filter((s) => s < t).length / Math.max(1, anT.length)),   // wrongly abstained on answerable
  });
  // threshold sweep (public top1Score quantiles) for a separability curve
  const allT = [...abT, ...anT].sort((a, b) => a - b);
  const qs = [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => allT[Math.floor(p * (allT.length - 1))] ?? 0);
  const sweepThresholds = [...new Set([thr, ...qs])].sort((a, b) => a - b);
  const sweep = sweepThresholds.map(atThr);
  // separability: does abstain-pack top1Score sit BELOW answerable top1Score? (AUC-style via rank).
  // Mann-Whitney style: P(answerable top1 > abstain top1).
  let wins = 0, ties = 0;
  for (const a of anT) for (const b of abT) { if (a > b) wins++; else if (a === b) ties++; }
  const auc = round((wins + 0.5 * ties) / Math.max(1, anT.length * abT.length));
  // best achievable separation point (max abstainAccuracy s.t. falseAbstention minimal): pick threshold
  // maximizing (abstainAccuracy - falseAbstentionRate) over candidate split points.
  const cand = [...new Set(allT)].sort((a, b) => a - b);
  let best = { threshold: null, abstainAccuracy: 0, falseAbstentionRate: 1, youden: -Infinity };
  for (let i = 0; i < cand.length; i++) {
    const t = cand[i] + 1e-12;
    const aa = abT.filter((s) => s < t).length / Math.max(1, abT.length);
    const fa = anT.filter((s) => s < t).length / Math.max(1, anT.length);
    const y = aa - fa;
    if (y > best.youden) best = { threshold: round(cand[i]), abstainAccuracy: round(aa), falseAbstentionRate: round(fa), youden: round(y) };
  }
  // AUXILIARY public-kind signal: on abstain packs every in-cap relevant-looking doc is kind=
  // abstain_distractor (a trap that looks relevant but is NOT an answer); answerable packs have a
  // real answer doc of a non-distractor kind in-cap. Diagnostic: does the deterministic TOP-1 doc
  // carry kind=abstain_distractor (abstain packs) vs a real-answer kind (answerable)?
  const top1KindIsDistractor = (pq) => {
    const top = (pq.finalRankingFull && pq.finalRankingFull[0]) ? stripMem(pq.finalRankingFull[0].docId)
      : (pq.finalRankingTop20 && pq.finalRankingTop20[0]) ? stripMem(pq.finalRankingTop20[0].docId) : null;
    return top ? (docById.get(top)?.kind === 'abstain_distractor') : null;
  };
  const abDistractorTop1 = abstainPqs.filter((pq) => top1KindIsDistractor(pq) === true).length;
  const anDistractorTop1 = answerablePqs.filter((pq) => top1KindIsDistractor(pq) === true).length;
  return {
    constructible: true,
    sliceDefinition: `abstain:true missing-answer packs (${abstainPqs.length} eval_hidden, empty qrels) vs a MATCHED set of answerable eval_hidden queries (${answerablePqs.length}: temporal/bridge/decision/causal/coref/aspect/conflict with rel>0). PUBLIC signal: scorer-observable top1Score. NO qrel as signal (qrels only LABEL which pack is abstain vs answerable).`,
    auxiliaryPublicKindSignal: {
      signal: 'doc.kind of the deterministic top-1 result == abstain_distractor (a PUBLIC doc kind, not a qrel role).',
      abstainPackTop1IsDistractor: abDistractorTop1, abstainPackTop1DistractorRate: round(abDistractorTop1 / Math.max(1, abstainPqs.length)),
      answerableTop1IsDistractor: anDistractorTop1, answerableTop1DistractorRate: round(anDistractorTop1 / Math.max(1, answerablePqs.length)),
      note: 'If abstain packs reliably have a kind=abstain_distractor TOP-1 while answerable packs do not, a public-kind abstain atom separates them CPU-decisively WITHOUT the (degenerate) deterministic top1Score. CAVEAT: kind=abstain_distractor is a borderline-label generator field (it directly marks the trap), so this is reported as a DIAGNOSTIC, not the primary honest signal; the primary brief signal is top1Score.',
    },
    oracleAction: 'BOUNDED metric decision: abstain iff top1Score < abstentionThreshold. Measure abstention accuracy on abstain packs + false-abstention on answerable.',
    abstainPackCount: abstainPqs.length,
    answerableCount: answerablePqs.length,
    top1ScoreStats: { abstainPacks: stat(abT), answerable: stat(anT) },
    separationAUC: auc,
    atLockedThreshold: atThr(thr),
    bestSeparationPoint: best,
    thresholdSweep: sweep,
    artifactNote: `separationAUC = P(answerable top1Score > abstain-pack top1Score). The DECISION (abstain iff top1<thr) is metric-level → CPU-DECIDABLE (no reranking-magnitude dependence). CAVEAT: the DETERMINISTIC reranker's top1Score is a WEAK proxy for the Qwen-calibrated abstention score, so the ABSOLUTE accuracy/threshold are proxy values — the CPU-decisive fact is whether the public top1Score SEPARATES abstain packs from answerable (AUC) and whether a threshold exists with high abstainAccuracy AND low falseAbstention. The locked abstentionThreshold (${round(thr)}) is tuned for the Qwen score scale, not this deterministic stub.`,
  };
}

// ── execute ───────────────────────────────────────────────────────────────────
const conflictLifecycle = runConflictLifecycle();
const aspectConstraint = runAspectConstraint();
const abstention = runAbstention();

// ── baseline-fidelity sanity: recomputed baseline nDCG must match scorer pq.nDCG10 ──
let nChk = 0, maxAbsErr = 0;
for (const pq of perQueryAll) {
  const c = ctx(pq); if (!c.full.length) continue;
  if (!(c.qrels ?? []).some((r) => r.relevance > 0)) continue; // abstain packs have no nDCG
  const rec = ndcgOf(c.full, c.idealRels);
  maxAbsErr = Math.max(maxAbsErr, Math.abs(rec - (pq.nDCG10 ?? 0))); nChk++;
}
const baselineFidelity = { queriesChecked: nChk, maxAbsNdcgError: round(maxAbsErr), holds: maxAbsErr < 1e-6, note: 'recomputed nDCG@K from finalRankingFull (relevance-labelled, contrast-adjusted) vs scorer pq.nDCG10. holds=true confirms the oracle reorder uses the SAME metric as the scorer.' };

// ── verdicts ────────────────────────────────────────────────────────────────
function verdictConflict() {
  const s = conflictLifecycle;
  if (s.sliceQueries === 0) return { verdict: 'FAIL', why: 'no valid slice: the public lifecycleState signal selected no docs in any query list.' };
  const bp = s.boundedActionPrecision;
  const separates = s.signalSeparatesQueries > 0 && bp.goldDirectBoostRecall >= 0.9 && bp.goldConflictSuppressRecall >= 0.9 && bp.answerWronglySuppressed === 0;
  if (!separates) return { verdict: 'FAIL', why: `public lifecycleState signal does NOT cleanly separate current/conflict: goldDirectBoostRecall ${bp.goldDirectBoostRecall}, goldConflictSuppressRecall ${bp.goldConflictSuppressRecall}, answerWronglySuppressed ${bp.answerWronglySuppressed}.` };
  const dmgScope = s.sourceAttribution.scopeDamagedQueries;
  if (Math.abs(s.meanDeltaNdcg) <= 1e-6) return { verdict: 'FAIL', why: `lifecycleState cleanly separates current/conflict (boostRecall ${bp.goldDirectBoostRecall}, suppressRecall ${bp.goldConflictSuppressRecall}, 0 answers damaged) BUT the bounded boost/suppress yields Δ nDCG ${s.meanDeltaNdcg} ≈ 0 → the deterministic reranker already orders these correctly inside top-K; the operation cannot lift this slice on CPU. (Reorder-magnitude is A100-gated regardless, but here the CPU oracle shows no headroom.)` };
  return { verdict: 'CPU-INCONCLUSIVE', why: `VALID slice (${s.sliceQueries} q). PUBLIC lifecycleState signal cleanly separates current/conflict/scope (CPU-decisive): goldDirectBoostRecall ${bp.goldDirectBoostRecall}, goldConflictSuppressRecall ${bp.goldConflictSuppressRecall}, 0 answers wrongly suppressed, scope docs damaged on ${dmgScope} q, source-attribution current-rose ${s.sourceAttribution.currentRoseQueries}/conflict-fell ${s.sourceAttribution.conflictFellQueries}. deterministic Δ nDCG ${s.meanDeltaNdcg}. BUT boost/suppress is a FINAL-REORDER action on the weak deterministic reranker → whether a real Qwen reranker already orders current>conflict (no lift) is CPU-INCONCLUSIVE → qualified for A100. The OPERATION (suppress contradiction, surface current) has a valid, publicly-separable, SAFE slice. CAVEAT: the public lifecycleState signal is corpus-wide (crossPackFlood) → a deployable atom must AND it with conflict-set/query scope.` };
}
function verdictAspect() {
  const s = aspectConstraint;
  if (s.sliceQueries === 0) return { verdict: 'FAIL', why: 'no valid slice: query.intentAspect / doc.aspectTags absent on this slice.' };
  const bp = s.boundedActionPrecision;
  const separates = bp.goldDirectBoostRecall >= 0.9 && bp.answerWronglySuppressed === 0;
  if (!separates) return { verdict: 'FAIL', why: `aspectTags⊇intentAspect signal impure: goldDirectBoostRecall ${bp.goldDirectBoostRecall}, answerWronglySuppressed ${bp.answerWronglySuppressed}.` };
  if (Math.abs(s.meanDeltaNdcg) <= 1e-6) return { verdict: 'FAIL', why: `aspect signal cleanly separates direct/wrong-aspect (boostRecall ${bp.goldDirectBoostRecall}, 0 answers damaged) BUT bounded boost/suppress yields Δ nDCG ${s.meanDeltaNdcg} ≈ 0 → the deterministic reranker already orders the intent-aspect answer above the wrong-aspect doc inside top-K; no CPU headroom on this slice.` };
  return { verdict: 'CPU-INCONCLUSIVE', why: `VALID slice (${s.sliceQueries} q). PUBLIC aspectTags⊇intentAspect signal cleanly separates direct/wrong-aspect (CPU-decisive): goldDirectBoostRecall ${bp.goldDirectBoostRecall}, 0 answers wrongly suppressed, direct-rose ${s.sourceAttribution.directRoseQueries}/wrong-fell ${s.sourceAttribution.wrongAspectFellQueries}. deterministic Δ nDCG ${s.meanDeltaNdcg}. BUT boost/suppress is a FINAL-REORDER → whether a real Qwen reranker already orders intent-aspect>wrong-aspect (no lift) is CPU-INCONCLUSIVE → qualified for A100. CAVEAT: aspectTags is corpus-wide (crossPackFlood) → deployable atom must AND it with query scope.` };
}
function verdictAbstention() {
  const s = abstention;
  if (!s.constructible || s.abstainPackCount === 0) return { verdict: 'FAIL', why: 'no abstain packs on this corpus → abstention slice not constructible.' };
  const auc = s.separationAUC, best = s.bestSeparationPoint;
  const ab = s.top1ScoreStats.abstainPacks, an = s.top1ScoreStats.answerable;
  // PROXY-DEGENERACY GUARD: the deterministic reranker returns a near-1 top1Score for BOTH classes
  // (it is a raw-cosine stub, NOT a calibrated relevance score). If both distributions are saturated
  // near the ceiling, top1Score CANNOT express "no good answer" on CPU — the signal is degenerate by
  // construction, distinct from the operation failing. That is CPU-INCONCLUSIVE (needs the calibrated
  // Qwen score), NOT a FAIL of the operation.
  const saturated = (ab.min >= 0.99 && an.min >= 0.95);
  const aux = s.auxiliaryPublicKindSignal;
  const auxSeparates = aux && aux.abstainPackTop1DistractorRate >= 0.9 && aux.answerableTop1DistractorRate <= 0.1;
  if (auc >= 0.9 && best.abstainAccuracy >= 0.9 && best.falseAbstentionRate <= 0.1) {
    return { verdict: 'PASS', why: `VALID abstain slice (${s.abstainPackCount} abstain packs vs ${s.answerableCount} answerable). PUBLIC top1Score SEPARATES them: separationAUC ${auc}; threshold ${best.threshold} gives abstainAccuracy ${best.abstainAccuracy} AND falseAbstention ${best.falseAbstentionRate}. Metric-level → CPU-DECIDABLE.` };
  }
  if (saturated) {
    return { verdict: 'CPU-INCONCLUSIVE', why: `VALID abstain slice IS constructible (${s.abstainPackCount} abstain packs vs ${s.answerableCount} answerable) — UNLIKE the g2 corpus which had 0 abstain packs (so r5-synthesis fixed the missing structure). BUT the primary public signal top1Score is DEGENERATE on the deterministic reranker: it saturates near 1.0 for BOTH abstain packs (min ${ab.min}, mean ${ab.mean}) and answerable (min ${an.min}, mean ${an.mean}); separationAUC ${auc}. The deterministic stub returns raw near-1 cosine for its top doc regardless of whether a real answer exists → it CANNOT express "no reliable evidence path" on CPU. This is a PROXY DEGENERACY (the deterministic reranker is not a calibrated relevance scorer), NOT proof the operation fails. The locked abstentionThreshold (${s.atLockedThreshold.threshold}) is tuned for the Qwen calibrated-score scale and yields abstainAccuracy ${s.atLockedThreshold.abstainAccuracy} on this stub. ${auxSeparates ? `An AUXILIARY public-kind signal (top-1 doc kind=abstain_distractor) DOES separate (abstain ${aux.abstainPackTop1DistractorRate} vs answerable ${aux.answerableTop1DistractorRate}), confirming the abstain slice is structurally separable from PUBLIC features — but abstain_distractor is a borderline-label field, so the honest primary signal (top1Score) needs the Qwen calibrated score.` : `The auxiliary public-kind signal (abstain ${aux?.abstainPackTop1DistractorRate} vs answerable ${aux?.answerableTop1DistractorRate}) does not cleanly separate either.`} → A100 Qwen calibrated-score confirmation required to decide the operation; the SLICE itself is valid and qualifies for the A100 batch (abstention threshold re-pinned on the calibrated score).` };
  }
  if (auc >= 0.7) {
    return { verdict: 'CPU-INCONCLUSIVE', why: `VALID abstain slice; PUBLIC top1Score PARTIALLY separates (separationAUC ${auc}; best threshold ${best.threshold}: abstainAccuracy ${best.abstainAccuracy}, falseAbstention ${best.falseAbstentionRate}). Deterministic top1Score is a weak proxy → achievable accuracy A100-gated.` };
  }
  return { verdict: 'FAIL', why: `PUBLIC top1Score does NOT separate abstain packs from answerable (separationAUC ${auc} < 0.7; best threshold ${best.threshold}: abstainAccuracy ${best.abstainAccuracy}, falseAbstention ${best.falseAbstentionRate}) and the distributions are not merely saturated → no abstention threshold on this public signal cleanly abstains. STOP (or needs a stronger public no-evidence-path signal).` };
}
const verdicts = {
  family3_conflictLifecycle: verdictConflict(),
  family4_aspectConstraint: verdictAspect(),
  family5b_abstentionMissing: verdictAbstention(),
};

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/cortex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();

const report = {
  probe: 'r5-oracle-ladder-fam3-fam4-fam5b',
  step: 'oracle-ladder STEP-3 (oracle upper bound), CPU only, deterministic reranker (A100 STOPPED)',
  goal: 'Prove or refute that each OPERATION (conflict_lifecycle / aspect_constraint / abstention_missing) can move eval on a VALID slice constructed from PUBLIC labels only. Stop a family only if the oracle cannot lift a valid slice or the public signal cannot separate.',
  honestyRules: 'Policy SIGNAL is PUBLIC only: doc.kind/lifecycleState/aspectTags/currentStaleFlag/timestamp (read from logical.docs — the bridge drops them), query.intentAspect (logical.queries), public co_occurs_with edges, scorer-observable top1Score. qrel role/relevance used ONLY to LABEL/measure. Deterministic reranker is a WEAK proxy → final-reorder magnitude is CPU-inconclusive; abstention/metric/source-attribution effects are CPU-decisive. BOUNDED actions only.',
  provenance: {
    specVersion: logical.specVersion, phase: logical.phase, corpusRoot, gitSha,
    distHashRetrievalBenchmark: distHash, dirtyTree,
    reranker: 'deterministic-stub (cpu-only; A100 stopped)', profile: 'evaluator-profile-v2-dgen1-deep-r1.json',
    biEncoder: BE.modelId, layout: LAYOUT,
    corpus: corpusPath.replace(repoRoot + '/', ''), emb: embPath.replace(repoRoot + '/', ''),
    rerankerTopK: K, rerankerInputTopK: opts.rerankerInputTopK, ownerScopeMode: opts.ownerScopeMode,
    abstentionThreshold: opts.abstentionThreshold, temporalStaleContrast: opts.temporalStaleContrast,
    exposeFullRanking: true, publicEdgeTypesUsed: [...PUBLIC_EDGES], queriesScored: perQueryAll.length,
    temporalBatch, wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1),
    scorerChange: 'NONE — exposeFullRanking (additive opt-in) already present in dist; no scorer edit. Public doc fields (lifecycleState/aspectTags/intentAspect) read directly from the LOGICAL corpus because the production bridge does not thread them through.',
  },
  baselineFidelity,
  family3_conflictLifecycle: conflictLifecycle,
  family4_aspectConstraint: aspectConstraint,
  family5b_abstentionMissing: abstention,
  verdicts,
};

writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error(`[r5] wrote ${outPath} (${((Date.now() - START_T) / 1000).toFixed(1)}s)`);
console.log(JSON.stringify({ baselineFidelity, verdicts,
  family3: { sliceQueries: conflictLifecycle.sliceQueries, meanDeltaNdcg: conflictLifecycle.meanDeltaNdcg, goldDirectBoostRecall: conflictLifecycle.boundedActionPrecision.goldDirectBoostRecall, goldConflictSuppressRecall: conflictLifecycle.boundedActionPrecision.goldConflictSuppressRecall, answerWronglySuppressed: conflictLifecycle.boundedActionPrecision.answerWronglySuppressed, currentRose: conflictLifecycle.sourceAttribution.currentRoseQueries, conflictFell: conflictLifecycle.sourceAttribution.conflictFellQueries, scopeDamaged: conflictLifecycle.sourceAttribution.scopeDamagedQueries },
  family4: { sliceQueries: aspectConstraint.sliceQueries, meanDeltaNdcg: aspectConstraint.meanDeltaNdcg, goldDirectBoostRecall: aspectConstraint.boundedActionPrecision.goldDirectBoostRecall, answerWronglySuppressed: aspectConstraint.boundedActionPrecision.answerWronglySuppressed, directRose: aspectConstraint.sourceAttribution.directRoseQueries, wrongFell: aspectConstraint.sourceAttribution.wrongAspectFellQueries },
  family5b: { abstainPacks: abstention.abstainPackCount, answerable: abstention.answerableCount, separationAUC: abstention.separationAUC, top1Saturation: { abstainMin: abstention.top1ScoreStats.abstainPacks.min, answerableMin: abstention.top1ScoreStats.answerable.min }, atLockedThreshold: abstention.atLockedThreshold, bestSeparationPoint: abstention.bestSeparationPoint, auxiliaryPublicKindSignal: { abstainTop1DistractorRate: abstention.auxiliaryPublicKindSignal.abstainPackTop1DistractorRate, answerableTop1DistractorRate: abstention.auxiliaryPublicKindSignal.answerableTop1DistractorRate } },
}, null, 2));
if (typeof reranker.close === 'function') reranker.close();
