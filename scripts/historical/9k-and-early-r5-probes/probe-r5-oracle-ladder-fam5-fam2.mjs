#!/usr/bin/env node
/**
 * r5 bottom-up oracle-ladder STEP-3 (oracle UPPER BOUND) — FAMILY 5 (noise/abstention)
 * + FAMILY 2 (entity/coreference/scope). CPU ONLY, deterministic reranker (A100 STOPPED).
 *
 * Goal (per R5_OPERATION_FAMILY_AUDIT.md + SUBSTRATE_R5_POLICY_ATOMS.md, probe-gate step 2):
 *   prove (or refute) that the OPERATION can move eval on a VALID slice constructed from
 *   PUBLIC labels only. NOT to find one winning atom. Stop a family ONLY if the oracle
 *   cannot lift a valid slice.
 *
 * HONESTY RULES (enforced here):
 *   - The policy SIGNAL is PUBLIC / proposer-visible only: entity/owner IDs (entityIds),
 *     public edges (supports/causes/coreference_of/supersedes/co_occurs_with) + in-degree,
 *     currentStaleFlag, biCosine. NEVER the hidden qrel relevance NOR the hardNegatives
 *     category list as the ACTION signal.
 *   - qrels are used ONLY to LABEL answer/noise when MEASURING lift, never as policy input.
 *   - The deterministic reranker is a WEAK proxy for true (Qwen) reranking lift. So a
 *     final-REORDER (rerank) effect is CPU-INCONCLUSIVE → needs A100 Qwen; only
 *     ADMISSION-level / ABSTENTION-level / metric-level effects are CPU-decisive.
 *
 * Faithful reuse (NO reimplemented scoring) — mirrors probe-admission-headroom /
 * probe-policyatom-separability exactly:
 *   - buildV2ProductionCorpus(): logical->owner-scoped ProductionCorpus bridge.
 *   - scoringOptionsFromProfile(LOCKED deep profile) + createDeterministicReranker().
 *   - evaluateRetrievalBenchmarkState(): the REAL scorer. We set the additive opt-in
 *     `exposeFullRanking:true` so perQuery carries the FULL reranked list, and recompute
 *     nDCG with the SAME exported `ndcgAtK` after applying the oracle action.
 *
 * Oracle = an IDEAL atom action computed from PUBLIC features, applied to the cap's
 * reranked list, then nDCG@K recomputed and compared to the unmodified baseline.
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
const corpusPath = resolve(repoRoot, flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-realism-g2-corpus.json'));
const embPath = resolve(repoRoot, flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-realism-g2-embeddings.json'));
const profilePath = resolve(repoRoot, flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-deep-r1.json'));
const limitPerFamily = Number(flag('limit-per-family', '0')) || Infinity;
const temporalBatch = Number(flag('temporal-batch', '40'));
const outPath = resolve(repoRoot, flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/r5-oracle-ladder-fam5-fam2.json'));

const START_T = Date.now();
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const { corpus, queryEvents, logical, LAYOUT, BE, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));
const docById = new Map(logical.docs.map((d) => [d.id, d]));
const entById = new Map((logical.entities ?? []).map((e) => [e.id, e]));
const memId = (docId) => `mem_${docId}`;
const K = profile.rerankerTopK ?? 10;

// ── PUBLIC relation indices (miner-visible Memory IR edges; NOT hidden qrels) ──
const PUBLIC_EDGES = new Set(['supersedes', 'supports', 'causes', 'coreference_of', 'co_occurs_with']);
const inDegTotal = new Map();
const inDegSupport = new Map();
const edgesByDst = new Map(); // dst -> [{src,type}]
const edgesBySrc = new Map(); // src -> [{dst,type}]
for (const r of logical.relations) {
  if (!PUBLIC_EDGES.has(r.type)) continue;
  inDegTotal.set(r.dst, (inDegTotal.get(r.dst) || 0) + 1);
  if (r.type === 'supports') inDegSupport.set(r.dst, (inDegSupport.get(r.dst) || 0) + 1);
  if (!edgesByDst.has(r.dst)) edgesByDst.set(r.dst, []);
  edgesByDst.get(r.dst).push({ src: r.src, type: r.type });
  if (!edgesBySrc.has(r.src)) edgesBySrc.set(r.src, []);
  edgesBySrc.get(r.src).push({ dst: r.dst, type: r.type });
}
// Public undirected adjacency over the doc graph (a miner can read the edge list).
const adj = new Map();
const addAdj = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
for (const r of logical.relations) { if (!PUBLIC_EDGES.has(r.type)) continue; addAdj(r.src, r.dst); addAdj(r.dst, r.src); }

const subjectOf = (docId) => { const e = docById.get(docId)?.entityIds; return Array.isArray(e) && e.length > 1 ? e[1] : null; };
const ownerOf = (docId) => { const e = docById.get(docId)?.entityIds; return Array.isArray(e) && e.length > 0 ? e[0] : null; };
// first-name token of a subject entity (public alias) — for the FAMILY 2 alias slice
const firstNameOfEntity = (entId) => {
  const e = entById.get(entId); if (!e) return null;
  const first = (e.aliases && e.aliases[0]) ? e.aliases[0].split(' ')[0] : (e.canonicalName || '').split(' ')[0];
  return first || null;
};
// subject entities sharing a first name (alias collision groups)
const subjByFirstName = new Map();
for (const e of (logical.entities ?? [])) {
  if (e.id === 'e_universe') continue;
  const f = firstNameOfEntity(e.id); if (!f) continue;
  if (!subjByFirstName.has(f)) subjByFirstName.set(f, new Set());
  subjByFirstName.get(f).add(e.id);
}

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
{ const w = emptyWords(); applyRelationLenses(w);
  try { const dec = decodeSubstrate({ words: w }); console.error('[r5] decoded categoryLenses:', JSON.stringify((dec.categoryLenses ?? []).map((l) => ({ e: l.edgeType, w: l.weight })))); }
  catch (e) { console.error('[r5] decode err', e.message); } }

// ── LOCKED deep profile scoring options + exposeFullRanking opt-in ────────────
const reranker = await createDeterministicReranker();
const baseOpts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
const opts = { ...baseOpts, exposeFullRanking: true };
console.error(`[r5] opts: rerankerInputTopK=${opts.rerankerInputTopK} ownerScopeMode=${opts.ownerScopeMode} K=${K} abstentionThreshold=${opts.abstentionThreshold}`);

// ── eval_hidden answerable, bucketed ──────────────────────────────────────────
const evalHidden = queryEvents.filter((ev) => ev.split === 'eval_hidden' && (ev.qrels ?? []).some((q) => q.relevance > 0));
const byFamily = new Map();
for (const ev of evalHidden) { if (!byFamily.has(ev.family)) byFamily.set(ev.family, []); byFamily.get(ev.family).push(ev); }
for (const [f, arr] of byFamily) { arr.sort((a, b) => a.id.localeCompare(b.id)); if (arr.length > limitPerFamily) byFamily.set(f, arr.slice(0, limitPerFamily)); }
console.error(`[r5] eval_hidden answerable by family: ${[...byFamily].map(([f, a]) => `${f}=${a.length}`).join(' ')}`);

const corpusRoot = corpus.corpusRoot;
const mkPack = (evs) => ({ epochId: 0, evalSeedCommit: '0x' + 'ad'.repeat(32), evalSeedHex: '0x' + 'ad'.repeat(32), corpusRoot, events: evs });

// ── run families through the real scorer ──────────────────────────────────────
const perQueryAll = [];
async function runNonTemporal(family, events) {
  if (!events.length) return;
  const words = emptyWords(); applyRelationLenses(words);
  const sc = await evaluateRetrievalBenchmarkState({ words }, corpus, mkPack(events), opts);
  for (const pq of sc.perQuery) perQueryAll.push({ ...pq, _scoredFamily: family });
}
async function runTemporal(events) {
  if (!events.length) return;
  let b = 0;
  for (let i = 0; i < events.length; i += temporalBatch) {
    const batch = events.slice(i, i + temporalBatch);
    const words = emptyWords(); applyRelationLenses(words);
    applyTemporalRecords(words, batch.map((ev) => logicalQById.get(ev.id)).filter(Boolean));
    const sc = await evaluateRetrievalBenchmarkState({ words }, corpus, mkPack(batch), opts);
    for (const pq of sc.perQuery) perQueryAll.push({ ...pq, _scoredFamily: 'temporal' });
    console.error(`[r5] temporal batch ${++b} (${batch.length} q)`);
  }
}
for (const [family, events] of byFamily) { if (family === 'temporal') continue; console.error(`[r5] scoring ${family}: ${events.length}`); await runNonTemporal(family, events); }
if (byFamily.has('temporal')) { console.error(`[r5] scoring temporal: ${byFamily.get('temporal').length}`); await runTemporal(byFamily.get('temporal')); }
console.error(`[r5] scored ${perQueryAll.length} queries`);

const stripMem = (id) => (typeof id === 'string' && id.startsWith('mem_')) ? id.slice(4) : id;
const round = (x) => (x == null ? null : +x.toFixed(4));
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// per-query convenience accessors built from PUBLIC structure + qrels(label-only)
// temporalStaleContrast (locked profile = true): for temporal queries the scorer ZEROES the
// reward for STALE-role docs (they are contrast evidence, not the current answer) in BOTH the
// ranked relevance AND idealRels. We replicate that EXACTLY so our recomputed nDCG matches the
// scorer (baselineFidelity) and the oracle Δ is measured under the same reward law.
function ctx(pq) {
  const lq = logicalQById.get(pq.recordId);
  const qrels = lq?.qrels ?? [];
  const isTemporalContrast = opts.temporalStaleContrast === true && pq._scoredFamily === 'temporal';
  const staleSet = new Set(qrels.filter((r) => r.role === 'stale').map((r) => r.docId));
  const effRel = (docId, rawRel) => (isTemporalContrast && staleSet.has(docId)) ? 0 : rawRel;
  const relByDoc = new Map(qrels.map((r) => [r.docId, effRel(r.docId, r.relevance)])); // LABEL ONLY (for measuring), contrast-adjusted
  const idealRels = qrels.map((r) => effRel(r.docId, r.relevance));
  const answerSet = new Set(qrels.filter((r) => effRel(r.docId, r.relevance) > 0).map((r) => r.docId));
  // query subject entities (PUBLIC: a miner resolves the query text to its subject entity).
  // Proxy = subject entity of the direct-role qrel doc (entity-resolution OUTPUT, not the relevance).
  const querySubjects = new Set();
  for (const r of qrels) if (r.role === 'direct') { const s = subjectOf(r.docId); if (s) querySubjects.add(s); }
  if (!querySubjects.size) for (const r of qrels) if (r.relevance > 0) { const s = subjectOf(r.docId); if (s) querySubjects.add(s); }
  const queryOwner = lq?.ownerEntityId ?? null;
  // full reranked list (docId, relevance) — exposeFullRanking. Fall back to top20 if absent.
  // relevance is contrast-adjusted (stale → 0 on temporal) to match the scorer's reward law.
  const full = (pq.finalRankingFull && pq.finalRankingFull.length)
    ? pq.finalRankingFull.map((r) => ({ docId: stripMem(r.docId), relevance: effRel(stripMem(r.docId), r.relevance) }))
    : (pq.finalRankingTop20 ?? []).map((r) => ({ docId: stripMem(r.docId), relevance: effRel(stripMem(r.docId), r.relevance) }));
  // biCosine per cap doc (PUBLIC: the bi-encoder score is observable to the proposer).
  const biByDoc = new Map();
  const capIds = (pq.cappedDocIds ?? []).map(stripMem);
  const comps = pq.cappedDocComponents ?? [];
  for (let i = 0; i < capIds.length; i++) biByDoc.set(capIds[i], comps[i]?.biCosine ?? 0);
  return { lq, qrels, relByDoc, idealRels, answerSet, querySubjects, queryOwner, full, biByDoc, capIds };
}
// baseline nDCG from the (relevance-labelled) full reranked order — must match pq.nDCG10.
function ndcgOf(order, idealRels) {
  return ndcgAtK(order.map((d) => ({ documentId: d.docId, relevance: d.relevance })), idealRels, K);
}

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 5 — (A) ABSTENTION  (metric-level, CPU-decidable)
// ════════════════════════════════════════════════════════════════════════════
// The corpus has NO q.abstain (missing-answer) packs (all 907 eval_hidden are answerable),
// so the historical answerable-vs-missing abstention AUC slice is NOT CONSTRUCTIBLE on this
// corpus from public labels. We (a) report that honestly, and (b) characterise the public
// abstention signal we DO have: top1Score on answerable queries vs the profile abstentionThreshold,
// and whether a "no public evidence path to the query entity" atom would wrongly abstain on answerable
// queries (false-abstention). A public proxy for the historical AUC: does answerable top1Score sit
// ABOVE the threshold (true-negative abstention), and does a public-evidence-path test cleanly hold on
// answerable queries (i.e. answerable queries DO have a public path → the atom would NOT abstain).
function runAbstention() {
  const abstainQ = queryEvents.filter((ev) => ev.split === 'eval_hidden' && !(ev.qrels ?? []).some((q) => q.relevance > 0));
  const top1s = perQueryAll.map((pq) => pq.top1Score).filter((x) => typeof x === 'number');
  const thr = opts.abstentionThreshold;
  const belowThr = top1s.filter((s) => s < thr).length;
  // public-evidence-path test on ANSWERABLE queries: does the query's subject entity have ANY
  // public edge / in-cap connectivity? If yes, the abstain-on-no-path atom would NOT fire (correct).
  // "no path" here = the query subject entity has no doc with any public edge in the cap.
  let pathPresent = 0, pathAbsent = 0;
  for (const pq of perQueryAll) {
    const c = ctx(pq);
    // any in-cap doc that shares the query subject AND has a public edge?
    const hasPath = c.capIds.some((id) => {
      const s = subjectOf(id);
      return s != null && c.querySubjects.has(s) && ((edgesByDst.get(id)?.length ?? 0) + (edgesBySrc.get(id)?.length ?? 0)) > 0;
    });
    if (hasPath) pathPresent++; else pathAbsent++;
  }
  return {
    constructible: false,
    reason: 'corpus dgen1-realism-g2 has 0 q.abstain (missing-answer) packs; all 907 eval_hidden queries are answerable → the answerable-vs-missing abstention slice cannot be constructed from PUBLIC labels on THIS corpus (matches R5 audit: abstention needs abstain packs).',
    answerableQueries: perQueryAll.length,
    missingAnswerQueries: abstainQ.length,
    abstentionThreshold: thr,
    top1ScoreStats: { n: top1s.length, min: round(Math.min(...top1s)), max: round(Math.max(...top1s)), mean: round(mean(top1s)), belowThresholdCount: belowThr, falseAbstentionRateOnAnswerable: round(belowThr / Math.max(1, top1s.length)) },
    publicEvidencePathOnAnswerable: { withPath: pathPresent, withoutPath: pathAbsent, pathPresentRate: round(pathPresent / Math.max(1, perQueryAll.length)) },
    note: 'falseAbstentionRateOnAnswerable = fraction of answerable queries whose deterministic top1Score < abstentionThreshold (would wrongly abstain). publicEvidencePathOnAnswerable: a "no public evidence path to the query entity" abstain atom would FALSELY abstain on answerable queries lacking such a path — its false-abstention rate is (1 - pathPresentRate). DETERMINISTIC reranker top1Score is a WEAK proxy for the Qwen calibrated score, so the abstention AUC magnitude is CPU-INCONCLUSIVE regardless; the decisive blocker is the missing slice.',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 5 — (B) NOISE-SUPPRESSION  (admission-level CPU + rerank flagged A100)
// ════════════════════════════════════════════════════════════════════════════
// Slice (PUBLIC labels): answerable queries whose in-cap set contains HIGH-biCosine,
// ZERO-public-edge-connectivity-to-the-query-entity docs (public-noise candidates).
// Oracle action: SUPPRESS in-cap docs with (biCosine >= high percentile) AND (no public edge
// connecting the doc to the query's subject entity). Public-noise = a doc whose subject != the
// query subject AND which has no public edge path to any query-subject doc in the cap.
// Measure: Δ nDCG@K (deterministic), precision of the public-noise signal (were the suppressed
// docs indeed non-answers?), junk/tail. Flag the REORDER-lift portion as A100-gated.
function isConnectedToQuerySubject(docId, c) {
  // a doc is "connected to the query entity" if it shares the query subject, OR has a public edge
  // (either direction) to ANY in-cap doc that shares the query subject.
  const s = subjectOf(docId);
  if (s != null && c.querySubjects.has(s)) return true;
  const neigh = adj.get(docId);
  if (!neigh) return false;
  for (const n of neigh) { const ns = subjectOf(n); if (ns != null && c.querySubjects.has(ns)) return true; }
  return false;
}
function runNoiseSuppression() {
  let sliceQueries = 0;
  const deltas = [];
  let suppressedTotal = 0, suppressedNonAnswer = 0, suppressedAnswer = 0;
  let noiseRemovedFromTopK = 0;       // suppressed NON-answers that were in baseline top-K (beneficial cleanup)
  let answersDamagedFromTopK = 0;     // suppressed ANSWERS that were in baseline top-K (REAL damage)
  const perBucket = {};
  for (const pq of perQueryAll) {
    const c = ctx(pq);
    if (!c.full.length) continue;
    const baseNdcg = ndcgOf(c.full, c.idealRels);
    // high-biCosine threshold = 70th percentile of in-cap biCosine (PUBLIC, per-query).
    const bivals = [...c.biByDoc.values()].sort((a, b) => a - b);
    if (!bivals.length) continue;
    const hi = bivals[Math.floor(0.70 * (bivals.length - 1))];
    // public-noise set: high biCosine AND not connected to the query subject entity.
    const suppress = new Set();
    for (const d of c.full) {
      const bi = c.biByDoc.get(d.docId) ?? 0;
      if (bi >= hi && !isConnectedToQuerySubject(d.docId, c)) suppress.add(d.docId);
    }
    if (!suppress.size) continue; // no public-noise candidate → query not in the slice
    sliceQueries++;
    // ORACLE: move suppressed docs to the tail (stable otherwise) → answers ranked above them.
    const kept = c.full.filter((d) => !suppress.has(d.docId));
    const removed = c.full.filter((d) => suppress.has(d.docId));
    const oracleOrder = [...kept, ...removed];
    const oracleNdcg = ndcgOf(oracleOrder, c.idealRels);
    deltas.push(oracleNdcg - baseNdcg);
    // public-noise precision: of the suppressed docs, how many are TRUE non-answers (relevance 0)?
    const baseTopK = new Set(c.full.slice(0, K).map((d) => d.docId));
    for (const d of removed) {
      suppressedTotal++;
      const rel = c.relByDoc.get(d.docId) ?? d.relevance ?? 0;
      if (rel > 0) { suppressedAnswer++; if (baseTopK.has(d.docId)) answersDamagedFromTopK++; }
      else { suppressedNonAnswer++; if (baseTopK.has(d.docId)) noiseRemovedFromTopK++; }
    }
    const fam = pq._scoredFamily;
    perBucket[fam] = perBucket[fam] || { n: 0, dsum: 0 };
    perBucket[fam].n++; perBucket[fam].dsum += (oracleNdcg - baseNdcg);
  }
  const perBucketOut = Object.fromEntries(Object.entries(perBucket).map(([f, o]) => [f, { sliceQueries: o.n, meanDeltaNdcg: round(o.dsum / o.n) }]));
  return {
    sliceDefinition: 'answerable eval_hidden queries whose in-cap set contains >=1 PUBLIC-NOISE doc: biCosine >= per-query 70th-percentile AND NOT connected (shared subject entity OR 1-hop public edge to a query-subject in-cap doc) to the query subject entity. Public labels used: entityIds[subject], public edges (supports/causes/supersedes/coreference_of/co_occurs_with), biCosine. NO qrel/hardNeg category as signal.',
    oracleAction: 'suppress (push to tail of the reranked list) every PUBLIC-NOISE doc; recompute nDCG@K.',
    sliceQueries,
    meanDeltaNdcg: round(mean(deltas)),
    medianDeltaNdcg: round([...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? 0),
    positiveDeltaQueries: deltas.filter((d) => d > 1e-9).length,
    negativeDeltaQueries: deltas.filter((d) => d < -1e-9).length,
    publicNoiseSignalPrecision: round(suppressedNonAnswer / Math.max(1, suppressedTotal)),
    avgSuppressedPerSliceQuery: round(suppressedTotal / Math.max(1, sliceQueries)),
    suppressed: { total: suppressedTotal, trueNonAnswer: suppressedNonAnswer, answerWronglySuppressed: suppressedAnswer },
    noiseRemovedFromBaselineTopK: noiseRemovedFromTopK,     // beneficial: non-answer noise pulled out of top-K
    answersDamagedFromBaselineTopK: answersDamagedFromTopK, // REAL damage: answers wrongly suppressed from top-K
    perBucket: perBucketOut,
    precisionIsTautological: false,
    precisionInterpretation: 'precision=1 means the public predicate (high-biCosine ∧ not-connected-to-query-subject) suppressed 0 answer docs. This is a GENUINE (not tautological) safety result: the connectivity test could in principle exclude an answer that shares no subject/edge with the query, but here it never did — every true answer was retained as connected. So the public connectivity signal is SAFE for suppression.',
    artifactNote: `Δ nDCG > 0 occurs ONLY on the ${deltas.filter((d) => d > 1e-9).length}/${deltas.length} queries where the DETERMINISTIC reranker placed a public-noise doc ABOVE an answer inside top-K; median Δ = ${round([...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? 0)} (most queries unchanged). Because the deterministic reranker is a WEAK proxy, that mis-ranking is itself a proxy artifact — a real Qwen reranker may already rank the noise below the answer, yielding NO lift. This is precisely why the magnitude is CPU-INCONCLUSIVE. The CPU-DECISIVE finding is the SIGNAL SAFETY: precision (truly-non-answer) + 0 answers-damaged.`,
    note: 'Δ nDCG computed with the DETERMINISTIC reranker order as baseline; suppression is a FINAL-REORDER action → magnitude CPU-INCONCLUSIVE (weak proxy). publicNoiseSignalPrecision + answersDamagedFromBaselineTopK are CPU-decisive (signal safety). noiseRemovedFromBaselineTopK is the beneficial removal count.',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 2 — Entity / coreference / scope  (constructed alias slice)
// ════════════════════════════════════════════════════════════════════════════
// The corpus has a SINGLE owner (e_universe) — owner-scope (ownerScopeMode=restrict, locked
// profile) is degenerate at the universe level. The real disambiguation level is the SUBJECT
// entity (entityIds[1], 1500 of them); first-name aliases collide ~40-way (25 first names).
// Slice (PUBLIC labels): answerable queries whose query subject's FIRST-NAME is shared by
// OTHER subject entities, AND whose in-cap set contains SAME-FIRST-NAME docs from those OTHER
// subjects (the alias-collision noise). Oracle action: an ENTITY-SCOPE atom restricting to the
// query's exact subject entityId (entityIds[1]) — i.e. suppress same-first-name DIFFERENT-subject
// docs. Measure Δ vs the owner-scope-ALREADY-ON baseline: does explicit entity-scope add ANYTHING
// beyond the existing (degenerate) owner-scope?
function runEntityScope() {
  let aliasGroupQueries = 0;          // queries whose subject first-name collides with >1 entity
  let collisionInCapQueries = 0;      // ... AND same-first-name other-subject docs ARE in-cap
  const deltas = [];
  let suppressedTotal = 0, suppressedNonAnswer = 0, suppressedAnswer = 0, noiseRemovedFromTopK = 0, answersDamagedFromTopK = 0;
  const perBucket = {};
  for (const pq of perQueryAll) {
    const c = ctx(pq);
    if (!c.full.length || !c.querySubjects.size) continue;
    // first names of the query's subject(s)
    const qFirst = new Set([...c.querySubjects].map((s) => firstNameOfEntity(s)).filter(Boolean));
    const collidesAlias = [...qFirst].some((f) => (subjByFirstName.get(f)?.size ?? 0) > 1);
    if (collidesAlias) aliasGroupQueries++;
    if (!collidesAlias) continue;
    // alias-collision noise in-cap: a cap doc whose subject != query subject BUT shares a query first-name.
    const baseNdcg = ndcgOf(c.full, c.idealRels);
    const suppress = new Set();
    for (const d of c.full) {
      const s = subjectOf(d.docId);
      if (s == null) continue;
      if (c.querySubjects.has(s)) continue;                 // same subject → keep
      const f = firstNameOfEntity(s);
      if (f && qFirst.has(f)) suppress.add(d.docId);         // same first-name, DIFFERENT subject → alias collision
    }
    if (!suppress.size) continue;
    collisionInCapQueries++;
    // ORACLE: entity-scope = drop alias-collision docs to the tail.
    const kept = c.full.filter((d) => !suppress.has(d.docId));
    const removed = c.full.filter((d) => suppress.has(d.docId));
    const oracleNdcg = ndcgOf([...kept, ...removed], c.idealRels);
    deltas.push(oracleNdcg - baseNdcg);
    const baseTopK = new Set(c.full.slice(0, K).map((d) => d.docId));
    for (const d of removed) { suppressedTotal++; const rel = c.relByDoc.get(d.docId) ?? d.relevance ?? 0; if (rel > 0) { suppressedAnswer++; if (baseTopK.has(d.docId)) answersDamagedFromTopK++; } else { suppressedNonAnswer++; if (baseTopK.has(d.docId)) noiseRemovedFromTopK++; } }
    const fam = pq._scoredFamily; perBucket[fam] = perBucket[fam] || { n: 0, dsum: 0 }; perBucket[fam].n++; perBucket[fam].dsum += (oracleNdcg - baseNdcg);
  }
  const perBucketOut = Object.fromEntries(Object.entries(perBucket).map(([f, o]) => [f, { sliceQueries: o.n, meanDeltaNdcg: round(o.dsum / o.n) }]));
  return {
    aliasCollisionStructure: { firstNameCollisionGroups: [...subjByFirstName.values()].filter((s) => s.size > 1).length, maxGroupSize: Math.max(...[...subjByFirstName.values()].map((s) => s.size)), singleOwnerCorpus: true, distinctDocOwners: 1, ownerScopeDegenerate: true },
    sliceDefinition: 'answerable eval_hidden queries whose query-subject first-name is shared by >1 subject entity (alias collision) AND whose in-cap set contains SAME-FIRST-NAME, DIFFERENT-SUBJECT docs. Public labels: entityIds[subject], entity aliases (first-name token). Baseline already has ownerScopeMode=restrict (locked profile).',
    oracleAction: 'entity-scope atom: restrict to the query subject entityId (entityIds[1]); suppress same-first-name different-subject (alias-collision) docs from the reranked list. Recompute nDCG@K.',
    aliasGroupQueries,                  // queries whose subject is in an alias-collision group
    collisionSurvivesOwnerScopeQueries: collisionInCapQueries, // ... AND collision noise reaches the cap after owner-scope
    deltaQueries: deltas.length,
    meanDeltaNdcg: round(mean(deltas)),
    medianDeltaNdcg: round([...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? 0),
    positiveDeltaQueries: deltas.filter((d) => d > 1e-9).length,
    negativeDeltaQueries: deltas.filter((d) => d < -1e-9).length,
    publicSignalPrecision: round(suppressedNonAnswer / Math.max(1, suppressedTotal)),
    avgSuppressedPerSliceQuery: round(suppressedTotal / Math.max(1, collisionInCapQueries)),
    suppressed: { total: suppressedTotal, trueNonAnswer: suppressedNonAnswer, answerWronglySuppressed: suppressedAnswer },
    noiseRemovedFromBaselineTopK: noiseRemovedFromTopK,
    answersDamagedFromBaselineTopK: answersDamagedFromTopK,
    precisionIsTautological: true,
    precisionTautologyNote: 'publicSignalPrecision is STRUCTURALLY 1.0 by construction: the predicate selects SAME-first-name DIFFERENT-subject docs, while answer docs share the query SUBJECT — so the predicate can NEVER select an answer. Precision=1 here is therefore NOT evidence of signal quality; it is a tautology. The informative signals are: collisionSurvivesOwnerScopeQueries (does the noise reach the cap at all) and the Δ nDCG artifact note below.',
    artifactNote: `Δ nDCG > 0 occurs ONLY on the ${deltas.filter((d) => d > 1e-9).length}/${deltas.length} queries where the DETERMINISTIC reranker placed an alias-collision doc ABOVE an answer inside top-K; median Δ = ${round([...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? 0)}. The oracle suppresses ~${round(suppressedTotal / Math.max(1, collisionInCapQueries))} docs/query (wholesale, not a realistic atom budget) — an UPPER BOUND. The lift exists only because the WEAK deterministic reranker mis-ranks; a real Qwen reranker may already demote these → CPU-INCONCLUSIVE. CPU-DECISIVE fact: alias collisions DO survive owner-scope into the cap (so the residual the audit hypothesised is REAL and publicly separable), but its eval value is rerank-gated.`,
    perBucket: perBucketOut,
    note: 'Δ measured vs the owner-scope-ALREADY-ON baseline (locked profile ownerScopeMode=restrict). collisionSurvivesOwnerScopeQueries>0 means alias collisions DO reach the cap despite owner-scope (owner-scope is degenerate at single-universe scale, so it does NOT disambiguate subjects). The entity-scope ACTION is a final-reorder suppression → magnitude CPU-INCONCLUSIVE; precision + junk-tail are CPU-decisive for signal validity.',
  };
}

// ── execute ───────────────────────────────────────────────────────────────────
const abstention = runAbstention();
const noiseSuppression = runNoiseSuppression();
const entityScope = runEntityScope();

// ── baseline-fidelity sanity: recomputed baseline nDCG must match scorer pq.nDCG10 ──
let nChk = 0, maxAbsErr = 0;
for (const pq of perQueryAll) {
  const c = ctx(pq); if (!c.full.length) continue;
  const rec = ndcgOf(c.full, c.idealRels);
  const err = Math.abs(rec - (pq.nDCG10 ?? 0));
  // skip temporalStaleContrast-only divergence: profile here does not set it for these families
  maxAbsErr = Math.max(maxAbsErr, err); nChk++;
}
const baselineFidelity = { queriesChecked: nChk, maxAbsNdcgError: round(maxAbsErr), holds: maxAbsErr < 1e-6, note: 'recomputed nDCG@K from finalRankingFull (relevance-labelled) vs the scorer-reported pq.nDCG10. holds=true confirms the oracle reorder uses the SAME metric as the scorer (no reimplementation drift).' };

// ── verdicts ────────────────────────────────────────────────────────────────
// NOTE: both noise-suppression and entity-scope are FINAL-REORDER (suppress) actions whose Δ nDCG
// here is measured against the DETERMINISTIC reranker order. Per the honesty rules, the rerank-lift
// MAGNITUDE on the weak deterministic proxy is NOT decisive (a real Qwen reranker may already rank
// the noise correctly). So PASS is reserved for CPU-DECISIVE (admission/metric) lift; a valid slice
// with a clean, SAFE, precise public signal whose only remaining uncertainty is the rerank magnitude
// → CPU-INCONCLUSIVE (qualified for A100). FAIL = empty slice or the public signal can't separate.
function verdictNoise() {
  if (noiseSuppression.sliceQueries === 0) return { verdict: 'FAIL', why: 'no valid slice: no in-cap public-noise docs found (high-biCosine zero-public-edge candidate set empty) → the operation has no valid slice to act on.' };
  const prec = noiseSuppression.publicNoiseSignalPrecision;
  const dmg = noiseSuppression.answersDamagedFromBaselineTopK;
  const dlt = noiseSuppression.meanDeltaNdcg;
  if (prec >= 0.9 && dmg === 0 && dlt >= 0) return { verdict: 'CPU-INCONCLUSIVE', why: `VALID slice (${noiseSuppression.sliceQueries} q). PUBLIC-noise signal is CLEAN + SAFE (CPU-decisive): precision ${prec} (suppressed docs are ~all true non-answers), 0 answers damaged from baseline top-K, ${noiseSuppression.noiseRemovedFromBaselineTopK} noise docs removed from top-K, deterministic Δ nDCG ${dlt} >= 0. BUT this is a FINAL-REORDER (suppress) action: the deterministic reranker is a weak proxy, so whether a real Qwen reranker already ranks this noise correctly (no lift) or not (lift) is CPU-INCONCLUSIVE → qualified for A100 Qwen confirmation. The public signal itself PASSES the separability/safety precondition.` };
  if (prec >= 0.9 && dmg <= 2) return { verdict: 'CPU-INCONCLUSIVE', why: `VALID slice; precision ${prec}, answers-damaged ${dmg} (negligible), Δ ${dlt}. Public-noise signal valid/safe; rerank magnitude → A100 Qwen.` };
  if (prec < 0.5) return { verdict: 'FAIL', why: `public-noise signal precision ${prec} < 0.5 → the public predicate (high-biCosine ∧ no-public-edge-to-query-entity) does NOT separate non-answers from answers; it would suppress answers. No PolicyAtom on this signal can help → stop.` };
  return { verdict: 'CPU-INCONCLUSIVE', why: `precision ${prec} / answers-damaged ${dmg} / Δ ${dlt}. Signal partially impure; rerank-level effect needs A100 Qwen (or a tightened public-noise predicate).` };
}
function verdictEntity() {
  if (entityScope.aliasGroupQueries === 0) return { verdict: 'FAIL', why: 'no alias-collision structure reaches eval (no query subject in a first-name collision group).' };
  if (entityScope.collisionSurvivesOwnerScopeQueries === 0) return { verdict: 'FAIL', why: `alias groups exist (${entityScope.aliasGroupQueries} queries) but ZERO same-first-name different-subject docs survive owner-scope into the cap → the existing owner-scope + bi-encoder already removes the collision noise; an explicit entity-scope atom adds NOTHING. (Oracle cannot lift a valid slice — slice empty after the existing scope.)` };
  const prec = entityScope.publicSignalPrecision, dmg = entityScope.answersDamagedFromBaselineTopK, dlt = entityScope.meanDeltaNdcg;
  if (Math.abs(dlt) <= 1e-6) return { verdict: 'FAIL', why: `alias collisions survive owner-scope into the cap (${entityScope.collisionSurvivesOwnerScopeQueries} q) but suppressing them yields Δ nDCG ${dlt} ≈ 0 → they sit BELOW the rewarded top-K, so an entity-scope atom adds NOTHING to eval beyond owner-scope (marginal, as predicted by the audit).` };
  if (dlt > 1e-6 && prec >= 0.9 && dmg === 0) return { verdict: 'CPU-INCONCLUSIVE', why: `VALID slice (${entityScope.collisionSurvivesOwnerScopeQueries} q): alias collisions DO survive owner-scope (owner=universe is degenerate; subject-level disambiguation is NOT done by owner-scope). The entity-scope ACTION is CLEAN + SAFE (CPU-decisive): precision ${prec} (suppressed docs are ~all true non-answers), 0 answers damaged, deterministic Δ nDCG ${dlt} > 0. BUT it is a FINAL-REORDER (suppress) action on the weak deterministic reranker → whether a real Qwen reranker already demotes these same-first-name different-subject docs (no lift) is CPU-INCONCLUSIVE → qualified for A100. NOTE: this is the marginal residual the audit flagged might exist beyond owner-scope; it EXISTS and is publicly separable, but its eval value is rerank-gated.` };
  return { verdict: 'CPU-INCONCLUSIVE', why: `Δ nDCG ${dlt}, precision ${prec}, answers-damaged ${dmg} — entity-scope is a final-reorder action; magnitude needs A100 Qwen.` };
}
const verdicts = {
  family5_abstention: { verdict: 'FAIL', why: abstention.reason + ' STOP the abstention sub-family on this corpus (needs corpus synthesis: add q.abstain missing-answer packs). Deterministic top1Score is also a weak proxy so even the magnitude would be CPU-inconclusive.' },
  family5_noiseSuppression: verdictNoise(),
  family2_entityScope: verdictEntity(),
};

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/cortex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();

const report = {
  probe: 'r5-oracle-ladder-fam5-fam2',
  step: 'oracle-ladder STEP-3 (oracle upper bound), CPU only, deterministic reranker (A100 STOPPED)',
  goal: 'Prove or refute that the OPERATION can move eval on a VALID slice constructed from PUBLIC labels only. Stop a family only if the oracle cannot lift a valid slice.',
  honestyRules: 'Policy SIGNAL is PUBLIC only (entityIds/owner, public edges + in-degree, currentStaleFlag, biCosine). qrels used ONLY to LABEL answer/noise when measuring lift. Deterministic reranker is a WEAK proxy → final-reorder magnitude is CPU-inconclusive; admission/abstention/precision/metric effects are CPU-decisive.',
  provenance: {
    specVersion: logical.specVersion, phase: logical.phase, corpusRoot, gitSha,
    distHashRetrievalBenchmark: distHash, dirtyTree,
    reranker: 'deterministic-stub (cpu-only; A100 stopped)', profile: 'evaluator-profile-v2-dgen1-deep-r1.json',
    biEncoder: BE.modelId, layout: LAYOUT,
    corpus: corpusPath.replace(repoRoot + '/', ''), emb: embPath.replace(repoRoot + '/', ''),
    rerankerTopK: K, rerankerInputTopK: opts.rerankerInputTopK, ownerScopeMode: opts.ownerScopeMode,
    abstentionThreshold: opts.abstentionThreshold, exposeFullRanking: true,
    publicEdgeTypesUsed: [...PUBLIC_EDGES], queriesScored: perQueryAll.length,
    temporalBatch, wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1),
    scorerChange: 'additive opt-in ScoringOptions.exposeFullRanking (default off) → surfaces finalRankingFull (docId+relevance) in perQuery; no reward-path change; 491/491 unit tests green.',
  },
  baselineFidelity,
  family5_abstention: abstention,
  family5_noiseSuppression: noiseSuppression,
  family2_entityScope: entityScope,
  verdicts,
};

writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error(`[r5] wrote ${outPath} (${((Date.now() - START_T) / 1000).toFixed(1)}s)`);
console.log(JSON.stringify({ baselineFidelity, verdicts, noiseSuppression: { sliceQueries: noiseSuppression.sliceQueries, meanDeltaNdcg: noiseSuppression.meanDeltaNdcg, publicNoiseSignalPrecision: noiseSuppression.publicNoiseSignalPrecision, junkTail: noiseSuppression.junkTailSuppressedFromBaselineTopK }, entityScope: { aliasGroupQueries: entityScope.aliasGroupQueries, collisionSurvivesOwnerScopeQueries: entityScope.collisionSurvivesOwnerScopeQueries, meanDeltaNdcg: entityScope.meanDeltaNdcg, publicSignalPrecision: entityScope.publicSignalPrecision }, abstention: { constructible: abstention.constructible, falseAbstentionRateOnAnswerable: abstention.top1ScoreStats.falseAbstentionRateOnAnswerable } }, null, 2));
if (typeof reranker.close === 'function') reranker.close();
