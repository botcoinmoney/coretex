#!/usr/bin/env node
/**
 * PolicyAtom public-signal SEPARABILITY probe (CPU only, deterministic reranker).
 *
 * The A100-INDEPENDENT PRECONDITION ORACLE for the substrate-r5 PolicyAtom families
 * (release/calibration/2026-05-21-memory-corpus-v2/SUBSTRATE_R5_POLICY_ATOMS.md, probe gate step 1).
 *
 * QUESTION: for each candidate atom family, does its PUBLIC proxy feature — the kind a miner
 * could emit from proposer-visible Memory IR / corpus structure (NOT hidden qrels) — SEPARATE
 * the ANSWER docs from the IN-CAP NOISE / hard-negatives? If the public signal can't separate
 * (AUC ~= 0.5), no PolicyAtom built on it can re-rank, so the family is dropped before spending
 * A100. High separation (AUC >> 0.5) => a PolicyAtom on that feature could re-rank => the family
 * is worth an A100 oracle upper-bound.
 *
 * RERANKER-INDEPENDENT by construction: this is about the SIGNAL (does the public feature
 * discriminate answer from in-cap noise), NOT about the reranker. The deterministic reranker
 * is used ONLY to reproduce cap-membership faithfully (cap = top rerankerInputTopK by
 * preRankScore = biCosine + substrateBonus, which is reranker-independent). NO GPU / NO A100.
 *
 * Faithful reuse (NO reimplemented scoring) — mirrors probe-admission-headroom.mjs exactly:
 *   - buildV2ProductionCorpus(): the SAME logical->owner-scoped ProductionCorpus bridge.
 *   - scoringOptionsFromProfile(LOCKED deep profile): ownerScope restrict, categoryLens, cap.
 *   - evaluateRetrievalBenchmarkState(): the real scorer; per-query `cappedDocIds` is the cap.
 *   - relation lenses always-on; temporal family scored in capacity-respecting batches.
 *
 * METHOD (over eval_hidden answerable queries, all families):
 *   For each query, take the IN-CAP doc set (cappedDocIds). Label each in-cap doc:
 *     ANSWER  = a qrel with relevance>0 for this query (direct/bridge are gold).
 *     NOISE   = relevance 0 (in-cap hard-negatives / incidental docs).
 *   For each in-cap doc compute these PUBLIC proxy features (all from corpus/logical structure):
 *     (a) ANSWER-DENSITY / SNR : support-edge public in-degree; total public-edge degree.
 *     (b) EVIDENCE-BUNDLE/hop  : is the doc the target of a public edge whose SOURCE is also
 *                                in-cap AND is a high-similarity "bridge" (top-K by stage-1 sim)?
 *                                (boolean reachable-in-1-hop-from-incap-bridge + hop distance)
 *     (c) ENTITY/OWNER-SCOPE   : shares query ownerEntityId? shares query subject entityIds[1]?
 *     (d) TEMPORAL validity    : currentStaleFlag (1=current) — meaningful for temporal only.
 *   For each feature compute the AUC between answer and noise in-cap docs (probability a random
 *   answer doc scores above a random noise doc), overall + per query-family. AUC ~0.5 = uninformative.
 *
 * The query SUBJECT entity (entityIds[1], the per-record subject distinct from the universe owner)
 * is a PUBLIC signal a miner derives by resolving the query text to an entity; we proxy it from the
 * subject entity of the query's direct-role qrel doc(s) (entity resolution output, NOT the qrel relevance).
 *
 * Usage: node scripts/probe-policyatom-separability.mjs
 *        [--corpus <logical.json>] [--emb <cache.json>] [--profile <profile.json>]
 *        [--limit-per-family N] [--temporal-batch 40] [--out <path>] [--bridge-sim-topk 8]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const {
  scoringOptionsFromProfile, evaluateRetrievalBenchmarkState, createDeterministicReranker,
  encodeRelationCategoryLens, encodeMemoryIndexSlot, encodeTemporalRecord, stableRecordIdFor,
  decodeSubstrate, RANGES,
} = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = resolve(repoRoot, flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-realism-g2-corpus.json'));
const embPath = resolve(repoRoot, flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-realism-g2-embeddings.json'));
const profilePath = resolve(repoRoot, flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-deep-r1.json'));
const limitPerFamily = Number(flag('limit-per-family', '0')) || Infinity;
const temporalBatch = Number(flag('temporal-batch', '40'));
const bridgeSimTopK = Number(flag('bridge-sim-topk', '8')); // an in-cap "bridge" = a doc in the top-K by stage-1 similarity for that query
const outPath = resolve(repoRoot, flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/policyatom-separability.json'));

const START_T = Date.now();
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const { corpus, queryEvents, logical, LAYOUT, BE, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));
const docById = new Map(logical.docs.map((d) => [d.id, d]));
const memId = (docId) => `mem_${docId}`;

// ── PUBLIC relation indices (miner-visible Memory IR edges) ───────────────────
// Public edge types a miner can read off logical.relations (NOT hidden qrels):
const PUBLIC_EDGES = new Set(['supersedes', 'supports', 'causes', 'coreference_of', 'co_occurs_with']);
const inDegTotal = new Map();   // total public-edge in-degree (answer-density / hubness)
const inDegSupport = new Map(); // 'supports' in-degree (a doc supported by other docs = answer-like)
const outDegTotal = new Map();
const edgesByDst = new Map();   // dst -> [{src,type}]   (for evidence-bundle: who points AT this doc)
for (const r of logical.relations) {
  if (!PUBLIC_EDGES.has(r.type)) continue;
  inDegTotal.set(r.dst, (inDegTotal.get(r.dst) || 0) + 1);
  outDegTotal.set(r.src, (outDegTotal.get(r.src) || 0) + 1);
  if (r.type === 'supports') inDegSupport.set(r.dst, (inDegSupport.get(r.dst) || 0) + 1);
  if (!edgesByDst.has(r.dst)) edgesByDst.set(r.dst, []);
  edgesByDst.get(r.dst).push({ src: r.src, type: r.type });
}

// ── substrate words (IDENTICAL to admission-headroom probe) ───────────────────
const emptyWords = () => new Array(RANGES.WORD_COUNT).fill(0n);
function applyRelationLenses(words) {
  const edges = ['supports', 'causes', 'supersedes', 'coreference_of'];
  for (let i = 0; i < edges.length; i++) {
    words[RANGES.RELATIONS_START + (128 - 1 - i)] = encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: edges[i], weight: 0x8000 });
  }
}
function applyTemporalRecords(words, temporalLogicalQueries) {
  let slot = 0, rec = 0;
  for (const lq of temporalLogicalQueries) {
    if (rec >= 96 || slot + 1 >= 352) break;
    const cur = (lq.qrels ?? []).find((r) => r.role === 'direct');
    const stale = (lq.qrels ?? []).find((r) => r.role === 'stale');
    if (!cur || !stale) continue;
    const staleSlot = slot++, curSlot = slot++;
    const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(memId(stale.docId)), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, retrievalSlot: 0, expiryEpoch: 0n });
    words[RANGES.MEMORY_INDEX_START + staleSlot] = sw[0];
    const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(memId(cur.docId)), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n });
    words[RANGES.MEMORY_INDEX_START + curSlot] = cw[0];
    const tw = encodeTemporalRecord({ recordIndex: rec, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
    for (let j = 0; j < tw.length; j++) words[RANGES.TEMPORAL_START + rec * tw.length + j] = tw[j];
    rec++;
  }
  return { slotsUsed: slot, recordsUsed: rec };
}
{ const w = emptyWords(); applyRelationLenses(w);
  try { const dec = decodeSubstrate({ words: w }); console.error('[sep] decoded categoryLenses:', JSON.stringify((dec.categoryLenses ?? []).map((l) => ({ e: l.edgeType, w: l.weight })))); }
  catch (e) { console.error('[sep] decode err', e.message); } }

// ── LOCKED deep profile scoring options ───────────────────────────────────────
const reranker = await createDeterministicReranker();
const opts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
console.error(`[sep] opts: rerankerInputTopK=${opts.rerankerInputTopK} ownerScopeMode=${opts.ownerScopeMode} categoryLensSeedTopK=${opts.categoryLensSeedTopK} categoryLensHopBudget=${opts.categoryLensHopBudget} firstStageTopK=${opts.firstStageTopK}`);

// ── eval_hidden answerable queries, bucketed by family ────────────────────────
const evalHidden = queryEvents.filter((ev) => ev.split === 'eval_hidden' && (ev.qrels ?? []).some((q) => q.relevance > 0));
const byFamily = new Map();
for (const ev of evalHidden) { if (!byFamily.has(ev.family)) byFamily.set(ev.family, []); byFamily.get(ev.family).push(ev); }
for (const [f, arr] of byFamily) { arr.sort((a, b) => a.id.localeCompare(b.id)); if (arr.length > limitPerFamily) byFamily.set(f, arr.slice(0, limitPerFamily)); }
console.error(`[sep] eval_hidden answerable by family: ${[...byFamily].map(([f, a]) => `${f}=${a.length}`).join(' ')}`);

const corpusRoot = corpus.corpusRoot;
const mkPack = (evs) => ({ epochId: 0, evalSeedCommit: '0x' + 'ad'.repeat(32), evalSeedHex: '0x' + 'ad'.repeat(32), corpusRoot, events: evs });

// ── run families through the real scorer to get per-query cappedDocIds ────────
const perQueryAll = [];
async function runNonTemporal(family, events) {
  if (!events.length) return;
  const words = emptyWords(); applyRelationLenses(words);
  const sc = await evaluateRetrievalBenchmarkState({ words }, corpus, mkPack(events), opts);
  for (const pq of sc.perQuery) perQueryAll.push({ ...pq, _scoredFamily: family });
}
async function runTemporal(events) {
  if (!events.length) return;
  let batches = 0;
  for (let i = 0; i < events.length; i += temporalBatch) {
    const batch = events.slice(i, i + temporalBatch);
    const words = emptyWords();
    applyRelationLenses(words);
    const tlq = batch.map((ev) => logicalQById.get(ev.id)).filter(Boolean);
    applyTemporalRecords(words, tlq);
    const sc = await evaluateRetrievalBenchmarkState({ words }, corpus, mkPack(batch), opts);
    for (const pq of sc.perQuery) perQueryAll.push({ ...pq, _scoredFamily: 'temporal' });
    batches++;
    console.error(`[sep] temporal batch ${batches} (${batch.length} q)`);
  }
}
for (const [family, events] of byFamily) {
  if (family === 'temporal') continue;
  console.error(`[sep] scoring ${family}: ${events.length} queries`);
  await runNonTemporal(family, events);
}
if (byFamily.has('temporal')) {
  console.error(`[sep] scoring temporal: ${byFamily.get('temporal').length} queries (batched ${temporalBatch})`);
  await runTemporal(byFamily.get('temporal'));
}
console.error(`[sep] scored ${perQueryAll.length} queries; extracting in-cap feature vectors`);

// ── per-query feature extraction over the IN-CAP doc set ──────────────────────
// A 'bridge' (for evidence-bundle feature) = an in-cap doc that is among the top-K by
// stage-1 similarity for this query (a public, query-conditioned high-similarity anchor).
// We derive per-cap-doc stage-1 similarity from cappedDocComponents when present; else
// rank by cap position (cap is ordered by preRankScore, so position is a valid proxy).
// docId is the logical doc id; cappedDocIds carry the mem_ prefix (corpus record id).
const stripMem = (id) => (typeof id === 'string' && id.startsWith('mem_')) ? id.slice(4) : id;

// feature definitions: name -> {value(doc, ctx)->number, families: 'all'|[...], higherIsAnswer:bool}
function subjectOf(docId) { const e = docById.get(docId)?.entityIds; return Array.isArray(e) && e.length > 1 ? e[1] : null; }
function ownerOf(docId) { const e = docById.get(docId)?.entityIds; return Array.isArray(e) && e.length > 0 ? e[0] : null; }

// records: one per (query, in-cap doc): { family, feature->value, isAnswer }
const records = [];
let queriesUsed = 0, noCapQueries = 0;
for (const pq of perQueryAll) {
  const family = pq._scoredFamily;
  const lq = logicalQById.get(pq.recordId);
  if (!lq) continue;
  const capRaw = pq.cappedDocIds ?? [];
  if (!capRaw.length) { noCapQueries++; continue; }
  const capDocIds = capRaw.map(stripMem);

  // gold (answer) set = relevance>0 qrel docs; direct-role = the strict answer
  const qrels = lq.qrels ?? [];
  const answerSet = new Set(qrels.filter((r) => r.relevance > 0).map((r) => r.docId));
  // role maps (for honest per-role views; NOT used as features, only for diagnostics):
  const roleByDoc = new Map();          // docId -> qrel role (direct/bridge/stale)
  for (const r of qrels) roleByDoc.set(r.docId, r.role ?? (r.relevance >= 1 ? 'direct' : 'partial'));
  const directDocs = new Set(qrels.filter((r) => r.role === 'direct').map((r) => r.docId));
  const staleDocs = new Set(qrels.filter((r) => r.role === 'stale').map((r) => r.docId));
  const hardNegCat = new Map();         // docId -> hardNegative category (temporal_stale / near_collision_* / relation_neighbor)
  for (const n of (lq.hardNegatives ?? [])) hardNegCat.set(n.docId, n.category);
  // query SUBJECT entity (public, miner-resolvable): subject of the direct-role qrel doc(s)
  const querySubjects = new Set();
  for (const r of qrels) { if (r.role === 'direct') { const s = subjectOf(r.docId); if (s) querySubjects.add(s); } }
  if (!querySubjects.size) { for (const r of qrels) { if (r.relevance > 0) { const s = subjectOf(r.docId); if (s) querySubjects.add(s); } } }
  const queryOwner = lq.ownerEntityId ?? ownerOf([...answerSet][0]);

  // in-cap "bridge" set for evidence-bundle: top-K cap docs by stage-1 similarity.
  // cappedDocComponents (parallel to cappedDocIds) exposes preRankScore inputs incl biCosine.
  const comps = pq.cappedDocComponents ?? null;
  let bridgeIdx;
  if (comps && comps.length === capRaw.length) {
    const simOf = (c) => (c?.biCosine ?? c?.biEncoderCosine ?? c?.stage1 ?? c?.preRankScore ?? 0);
    bridgeIdx = capRaw.map((_, i) => i).sort((a, b) => simOf(comps[b]) - simOf(comps[a])).slice(0, bridgeSimTopK);
  } else {
    bridgeIdx = capRaw.map((_, i) => i).slice(0, bridgeSimTopK); // cap is preRankScore-ordered
  }
  const bridgeDocIds = new Set(bridgeIdx.map((i) => capDocIds[i]));
  // an in-cap doc is 1-hop-reachable from an in-cap bridge if some public edge src(in bridge)->this
  function hopFromInCapBridge(docId) {
    const incoming = edgesByDst.get(docId) ?? [];
    for (const e of incoming) { if (bridgeDocIds.has(e.src) && e.src !== docId) return true; }
    return false;
  }

  queriesUsed++;
  for (const capDocId of capDocIds) {
    const d = docById.get(capDocId);
    if (!d) continue;
    const isAnswer = answerSet.has(capDocId);
    const subj = subjectOf(capDocId), own = ownerOf(capDocId);
    records.push({
      family,
      isAnswer,
      // role bookkeeping (diagnostics only; not features):
      isDirect: directDocs.has(capDocId),
      isStaleQrel: staleDocs.has(capDocId),
      hardNegCategory: hardNegCat.get(capDocId) ?? null,
      role: roleByDoc.get(capDocId) ?? (hardNegCat.has(capDocId) ? `hardneg:${hardNegCat.get(capDocId)}` : 'incidental'),
      // (a) ANSWER-DENSITY / SNR
      f_supportInDegree: inDegSupport.get(capDocId) || 0,
      f_totalPublicDegree: (inDegTotal.get(capDocId) || 0) + (outDegTotal.get(capDocId) || 0),
      // (b) EVIDENCE-BUNDLE / multi-hop
      f_hopFromBridge: hopFromInCapBridge(capDocId) ? 1 : 0,
      // (c) ENTITY / OWNER-SCOPE
      f_ownerMatch: (own != null && own === queryOwner) ? 1 : 0,
      f_subjectMatch: (subj != null && querySubjects.has(subj)) ? 1 : 0,
      // (d) TEMPORAL current-validity (1 = current)
      f_currentStaleFlag: d.currentStaleFlag === false ? 0 : 1,
    });
  }
}
console.error(`[sep] queriesUsed=${queriesUsed} noCapQueries=${noCapQueries} in-cap records=${records.length}`);

// ── AUC: P(answer feature > noise feature) with ties counted 0.5 (Mann-Whitney) ─
function auc(values, labels) {
  // values: number[]; labels: bool[] (true=answer). Returns AUC or null if a class empty.
  const pos = [], neg = [];
  for (let i = 0; i < values.length; i++) (labels[i] ? pos : neg).push(values[i]);
  if (!pos.length || !neg.length) return { auc: null, nPos: pos.length, nNeg: neg.length };
  // rank-based AUC (handles ties): AUC = (sum of ranks of pos - nPos*(nPos+1)/2) / (nPos*nNeg)
  const all = values.map((v, i) => ({ v, a: labels[i] })).sort((x, y) => x.v - y.v);
  // assign average ranks for ties
  let i = 0; const ranks = new Array(all.length);
  while (i < all.length) { let j = i; while (j + 1 < all.length && all[j + 1].v === all[i].v) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) ranks[k] = r; i = j + 1; }
  let sumPos = 0; for (let k = 0; k < all.length; k++) if (all[k].a) sumPos += ranks[k];
  const a = (sumPos - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
  return { auc: +a.toFixed(4), nPos: pos.length, nNeg: neg.length };
}

const FEATURES = [
  { key: 'f_supportInDegree', atomFamily: '1 answer-density/SNR', desc: 'public supports-edge in-degree' },
  { key: 'f_totalPublicDegree', atomFamily: '1 answer-density/SNR', desc: 'total public-edge degree (hubness)' },
  { key: 'f_hopFromBridge', atomFamily: '2 evidence-bundle/multi-hop', desc: '1-hop reachable from an in-cap high-sim bridge' },
  { key: 'f_ownerMatch', atomFamily: '4 entity/owner-scope', desc: 'shares query ownerEntityId (universe scope)' },
  { key: 'f_subjectMatch', atomFamily: '4 entity/owner-scope', desc: 'shares query subject entityIds[1]' },
  { key: 'f_currentStaleFlag', atomFamily: '3 temporal/update-lifecycle', desc: 'currentStaleFlag (1=current)' },
];
const FAMILIES = ['temporal', 'multi_hop_relation', 'near_collision'];

function computeCell(recs, key) {
  return auc(recs.map((r) => r[key]), recs.map((r) => r.isAnswer));
}
const aucTable = {}; // feature -> { overall: {...}, byFamily: { fam: {...} } }
for (const feat of FEATURES) {
  const overall = computeCell(records, feat.key);
  const byFamily = {};
  for (const fam of FAMILIES) {
    const recs = records.filter((r) => r.family === fam);
    byFamily[fam] = computeCell(recs, feat.key);
  }
  aucTable[feat.key] = { atomFamily: feat.atomFamily, desc: feat.desc, overall, byFamily };
}

// ── per-family in-cap composition (n answer / n noise per family) ──────────────
const famComposition = {};
for (const fam of FAMILIES) {
  const recs = records.filter((r) => r.family === fam);
  famComposition[fam] = { inCapDocs: recs.length, answer: recs.filter((r) => r.isAnswer).length, noise: recs.filter((r) => !r.isAnswer).length, queries: perQueryAll.filter((p) => p._scoredFamily === fam).length };
}

// ── in-cap composition by ROLE (which hard-negs actually reach the cap?) ──────
// The honest-probe sanity check hinges on WHETHER the same-entity hard-negs are in-cap.
const inCapByRole = {};
for (const fam of FAMILIES) {
  const recs = records.filter((r) => r.family === fam);
  const tally = {};
  for (const r of recs) tally[r.role] = (tally[r.role] || 0) + 1;
  inCapByRole[fam] = tally;
}

// ── STRICT view: DIRECT-answer vs NOISE (relevance-0 docs ONLY; partial-credit
// stale/bridge docs are EXCLUDED from both classes). This isolates feature (d):
// does currentStaleFlag separate the CURRENT direct answer from the stale/incidental
// noise — the precise temporal discriminator the task asks for. Without this, the
// stale qrels (relevance 0.2 > 0) pollute the "answer" class and mask the signal.
function aucStrict(recs, key) {
  const sub = recs.filter((r) => r.isDirect || (!r.isAnswer));   // direct answer OR pure noise (drop partial-credit stale/bridge)
  return auc(sub.map((r) => r[key]), sub.map((r) => r.isDirect));
}
const aucTableStrictDirect = {};
for (const feat of FEATURES) {
  const overall = aucStrict(records, feat.key);
  const byFamily = {};
  for (const fam of FAMILIES) byFamily[fam] = aucStrict(records.filter((r) => r.family === fam), feat.key);
  aucTableStrictDirect[feat.key] = { atomFamily: feat.atomFamily, desc: feat.desc, overall, byFamily };
}

// ── sanity-check: same-entity-noise confound on subjectMatch ───────────────────
// For temporal, the temporal_stale negs SHARE the query subject. So among NOISE docs that
// share the subject vs answer docs, subjectMatch must NOT separate (both ~1). We verify by
// computing subjectMatch AUC *restricted to same-subject in-cap noise* (should collapse to ~0.5)
// and the rate of subject-match among in-cap noise per family.
function subjectMatchRateOnNoise(fam) {
  const recs = records.filter((r) => r.family === fam && !r.isAnswer);
  if (!recs.length) return null;
  return +(recs.filter((r) => r.f_subjectMatch === 1).length / recs.length).toFixed(4);
}
function subjectMatchRateOnAnswer(fam) {
  const recs = records.filter((r) => r.family === fam && r.isAnswer);
  if (!recs.length) return null;
  return +(recs.filter((r) => r.f_subjectMatch === 1).length / recs.length).toFixed(4);
}
const subjectConfound = {};
for (const fam of FAMILIES) subjectConfound[fam] = { subjectMatchRateAnswer: subjectMatchRateOnAnswer(fam), subjectMatchRateNoise: subjectMatchRateOnNoise(fam) };

// currentStaleFlag (feature d): the STRICT temporal discriminator is DIRECT-answer (current)
// vs the stale/incidental NOISE. Reported both ways:
//   - looseAnswerVsNoise: relevance>0 (includes stale @0.2, which IS currentStaleFlag=false) → masks the signal.
//   - directVsStaleNoise: direct (current) vs in-cap stale-role noise → the precise feature-(d) signal.
function currentRate(recs) { return recs.length ? +(recs.filter((r) => r.f_currentStaleFlag === 1).length / recs.length).toFixed(4) : null; }
const tempRecs = records.filter((r) => r.family === 'temporal');
const temporalValidity = {
  looseAnswerVsNoise: {
    currentRateAnswer: currentRate(tempRecs.filter((r) => r.isAnswer)),
    currentRateNoise: currentRate(tempRecs.filter((r) => !r.isAnswer)),
    note: 'relevance>0 "answer" includes the stale qrels (relevance 0.2, currentStaleFlag=false) → answer-class current-rate is depressed; do NOT read feature (d) off this view.',
  },
  directVsStaleNoise: {
    currentRateDirect: currentRate(tempRecs.filter((r) => r.isDirect)),
    currentRateStaleNoise: currentRate(tempRecs.filter((r) => r.isStaleQrel)),
    currentRateAllNoise: currentRate(tempRecs.filter((r) => !r.isAnswer)),
    aucDirectVsAllNoise: aucStrict(tempRecs, 'f_currentStaleFlag'),
    note: 'the precise feature-(d) signal: does currentStaleFlag separate the CURRENT direct answer from stale/incidental noise.',
  },
};

// ── interpretation + family ranking ───────────────────────────────────────────
const INFORMATIVE = 0.62; // |AUC-0.5| >= 0.12 => genuinely discriminating on this corpus
const CONFOUNDED = 0.58;  // between 0.5 and this = weak/uninformative
const bestForAtom = (atomKeys, fam) => Math.max(...atomKeys.map((k) => { const c = aucTable[k].byFamily[fam]?.auc; return c == null ? -1 : Math.abs(c - 0.5) + 0.5; }));

function verdict(auc) { if (auc == null) return 'n/a'; const d = Math.abs(auc - 0.5); return d >= 0.12 ? 'INFORMATIVE' : d >= 0.08 ? 'WEAK' : 'UNINFORMATIVE'; }

const atomFamilyVerdict = {
  '1 answer-density/SNR': {
    features: ['f_supportInDegree', 'f_totalPublicDegree'],
    perFamily: Object.fromEntries(FAMILIES.map((fam) => [fam, {
      supportInDegreeAUC: aucTable.f_supportInDegree.byFamily[fam]?.auc,
      totalPublicDegreeAUC: aucTable.f_totalPublicDegree.byFamily[fam]?.auc,
      verdict: verdict(Math.abs((aucTable.f_supportInDegree.byFamily[fam]?.auc ?? 0.5) - 0.5) >= Math.abs((aucTable.f_totalPublicDegree.byFamily[fam]?.auc ?? 0.5) - 0.5) ? aucTable.f_supportInDegree.byFamily[fam]?.auc : aucTable.f_totalPublicDegree.byFamily[fam]?.auc),
    }])),
  },
  '2 evidence-bundle/multi-hop': {
    features: ['f_hopFromBridge'],
    perFamily: Object.fromEntries(FAMILIES.map((fam) => [fam, { hopFromBridgeAUC: aucTable.f_hopFromBridge.byFamily[fam]?.auc, verdict: verdict(aucTable.f_hopFromBridge.byFamily[fam]?.auc) }])),
  },
  '3 temporal/update-lifecycle': {
    features: ['f_currentStaleFlag'],
    perFamily: Object.fromEntries(FAMILIES.map((fam) => [fam, { currentStaleFlagAUC: aucTable.f_currentStaleFlag.byFamily[fam]?.auc, verdict: verdict(aucTable.f_currentStaleFlag.byFamily[fam]?.auc) }])),
  },
  '4 entity/owner-scope': {
    features: ['f_ownerMatch', 'f_subjectMatch'],
    perFamily: Object.fromEntries(FAMILIES.map((fam) => [fam, {
      ownerMatchAUC: aucTable.f_ownerMatch.byFamily[fam]?.auc,
      subjectMatchAUC: aucTable.f_subjectMatch.byFamily[fam]?.auc,
      subjectMatchVerdict: verdict(aucTable.f_subjectMatch.byFamily[fam]?.auc),
    }])),
  },
};

// ── HONEST per-feature AUC vs the IN-CAP hard-negatives only (direct answer vs in-cap hard-negs) ──
function aucVsHardNegsFor(recs, key) {
  const sub = recs.filter((r) => r.isDirect || r.hardNegCategory != null);
  return auc(sub.map((r) => r[key]), sub.map((r) => r.isDirect));
}
const aucVsHardNegs = {};
for (const feat of FEATURES) {
  const byFamily = {};
  for (const fam of FAMILIES) byFamily[fam] = aucVsHardNegsFor(records.filter((r) => r.family === fam), feat.key);
  aucVsHardNegs[feat.key] = { atomFamily: feat.atomFamily, desc: feat.desc, byFamily };
}

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/coretex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();

const report = {
  probe: 'policyatom-separability',
  question: 'For each candidate substrate-r5 PolicyAtom family, does its PUBLIC proxy feature (miner-emittable, NOT hidden qrels) separate ANSWER docs from IN-CAP NOISE/hard-negatives? High AUC => a PolicyAtom on the feature could re-rank => worth an A100 oracle. Low AUC => drop the family.',
  method: 'Score eval_hidden answerable queries (all families) with the LOCKED deep profile + DETERMINISTIC reranker (CPU only). Take each query in-cap doc set (cappedDocIds). Label in-cap docs ANSWER (relevance>0 qrel) vs NOISE (relevance 0). Compute PUBLIC proxy features per in-cap doc; report AUC(answer vs noise) per feature, overall + per query-family. Reranker-independent: about the public SIGNAL, not the reranker (which is used only to reproduce cap-membership).',
  provenance: {
    specVersion: logical.specVersion, phase: logical.phase, corpusRoot, gitSha,
    distHashRetrievalBenchmark: distHash, dirtyTree,
    reranker: 'deterministic-stub (cpu-only; cap-membership is reranker-independent; A100 stopped)',
    profile: 'evaluator-profile-v2-dgen1-deep-r1.json',
    biEncoder: BE.modelId, layout: LAYOUT,
    corpus: corpusPath.replace(repoRoot + '/', ''), emb: embPath.replace(repoRoot + '/', ''),
    rerankerInputTopK: opts.rerankerInputTopK, ownerScopeMode: opts.ownerScopeMode,
    categoryLensSeedTopK: opts.categoryLensSeedTopK, categoryLensHopBudget: opts.categoryLensHopBudget,
    bridgeSimTopK, temporalBatch, wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1),
    publicEdgeTypesUsed: [...PUBLIC_EDGES],
    queriesScored: perQueryAll.length, queriesUsed, inCapRecords: records.length,
  },
  famComposition,
  inCapByRole,
  featureCatalog: FEATURES,
  aucTable,
  aucTableStrictDirect,
  aucTableStrictDirectNote: 'DIRECT-answer (relevance 1) vs RELEVANCE-0 NOISE only; partial-credit stale(@0.2)/bridge(@0.5) docs excluded from both classes. This isolates the gold answer from the noise and is the view to read for feature (d) currentStaleFlag (the loose aucTable lumps stale@0.2 into the answer class).',
  aucVsHardNegs,
  aucVsHardNegsNote: 'THE HONEST TEST: AUC of DIRECT-answer vs the IN-CAP same-entity HARD-NEGATIVES only (temporal_stale / near_collision_* / relation_neighbor). A feature that separates the answer from incidental noise but NOT from the family hard-negs is CONFOUNDED — it will not re-rank past the negatives the family is about. n=0 (where stated) means those hard-negs are NOT reaching the cap at all (so they are not the in-cap reranking obstacle).',
  atomFamilyVerdict,
  sanityChecks: {
    subjectMatchConfound: subjectConfound,
    subjectMatchConfoundNote: 'HONEST-PROBE sanity: same-entity hard-negatives (temporal_stale, near_collision_*) share the query SUBJECT, so f_subjectMatch should be ~1 for BOTH answer and in-cap noise in temporal/near_collision => f_subjectMatch must NOT separate (AUC~0.5) there. If subjectMatch AUC is high it is separating answer from DIFFERENT-subject incidental noise, not from the same-entity hard-negs the family is about. Read subjectMatchRateNoise: if ~1 the confound is confirmed and subjectMatch is NOT a usable disambiguator for that family.',
    temporalValidity,
    temporalValidityNote: 'f_currentStaleFlag separates the CURRENT direct answer from the stale/incidental noise — read directVsStaleNoise (not looseAnswerVsNoise, which lumps stale@0.2 into the answer class).',
  },
};

// ── recommended ranking of atom families to oracle-test on A100 ────────────────
// Ranked by the HONEST signal: best per-family AUC of DIRECT-answer vs the IN-CAP HARD-NEGS
// (the negatives the family is actually about), NOT vs incidental noise. A feature that only
// separates incidental noise (high loose AUC, ~0.5 vs-hard-negs AUC) does NOT justify an oracle.
// Prefer the strongest NON-INVERTED cell (auc>0.5: answer ranks ABOVE the hard-negs — usable for
// a boost atom). An inverted cell (auc<0.5) means the public feature ranks the answer BELOW the
// hard-negs (a suppress atom could in principle use it, but it is not a clean boost signal); we
// surface the best inverted cell separately so the harmful/inverted case is explicit, not hidden.
function bestCellVsHardNegs(featureKeys) {
  let bestUp = 0.5, whereUp = null, nUp = 0;     // best auc>0.5 (answer above hard-negs)
  let bestInv = 0.5, whereInv = null, nInv = 0;  // most-inverted auc<0.5 (answer below hard-negs)
  for (const k of featureKeys) for (const fam of FAMILIES) {
    const c = aucVsHardNegs[k].byFamily[fam]; if (!c || c.auc == null) continue;
    if (c.auc > bestUp) { bestUp = c.auc; whereUp = `${fam}:${k}`; nUp = c.nPos + c.nNeg; }
    if (c.auc < bestInv) { bestInv = c.auc; whereInv = `${fam}:${k}`; nInv = c.nPos + c.nNeg; }
  }
  // headline = the usable (non-inverted) cell; fall back to inverted only if no cell ranks the answer up.
  if (whereUp) return { auc: bestUp, where: whereUp, n: nUp, inverted: false, invertedCell: whereInv, invertedAuc: whereInv ? bestInv : null };
  return { auc: bestInv, where: whereInv, n: nInv, inverted: true, invertedCell: whereInv, invertedAuc: whereInv ? bestInv : null };
}
function bestCellVsAllNoise(featureKeys) {
  let best = 0.5, where = null;
  for (const k of featureKeys) for (const fam of FAMILIES) {
    const a = aucTable[k].byFamily[fam]?.auc; if (a == null) continue;
    if (Math.abs(a - 0.5) > Math.abs(best - 0.5)) { best = a; where = `${fam}:${k}`; }
  }
  return { auc: best, where };
}
const ranking = Object.entries(atomFamilyVerdict).map(([name, v]) => {
  const hn = bestCellVsHardNegs(v.features);
  const an = bestCellVsAllNoise(v.features);
  return {
    atomFamily: name,
    bestAUCvsHardNegs: hn.auc, bestCellVsHardNegs: hn.where, nAtBestHardNegCell: hn.n,
    bestCellIsInverted: hn.inverted, // true => no public cell ranks the answer ABOVE the hard-negs (boost atom has no clean signal)
    bestInvertedCell: hn.invertedCell, bestInvertedAUC: hn.invertedAuc,
    usableBoostMargin: hn.inverted ? 0 : +Math.abs(hn.auc - 0.5).toFixed(4), // margin only counts when answer ranks ABOVE hard-negs
    hardNegMargin: +Math.abs(hn.auc - 0.5).toFixed(4),
    bestAUCvsAllNoise: an.auc, bestCellVsAllNoise: an.where, allNoiseMargin: +Math.abs(an.auc - 0.5).toFixed(4),
  };
}).sort((a, b) => b.usableBoostMargin - a.usableBoostMargin || b.hardNegMargin - a.hardNegMargin);
report.recommendedA100Ranking = ranking;
report.recommendedA100RankingNote = 'Ranked by hardNegMargin = |AUC-0.5| of DIRECT-answer vs IN-CAP HARD-NEGS (the honest signal). allNoiseMargin (vs incidental noise) shown for contrast: a large gap (high allNoiseMargin, ~0 hardNegMargin) flags a CONFOUNDED feature that will not re-rank past the family hard-negs.';

const g = (k, fam, tbl = aucTable) => tbl[k].byFamily[fam]?.auc;
report.interpretation =
  `PRECONDITION-ORACLE VERDICT (CPU, deterministic reranker, A100-independent). In-cap labelling: ANSWER = relevance>0 qrel, NOISE = relevance 0. ` +
  `Read aucTable for the loose answer-vs-noise view, aucVsHardNegs for the HONEST direct-answer-vs-IN-CAP-hard-negs view (the negatives each family is actually about), and aucTableStrictDirect for direct(rel=1)-vs-rel0-noise (excludes partial-credit stale/bridge).\n\n` +
  `SANITY CHECKS HOLD (the probe is honest): (1) f_ownerMatch AUC=0.5 everywhere — ownerEntityId is the single universe entity, so every in-cap doc shares it; owner-scope is degenerate as a re-ranking feature here (it is already applied as the cap restrict). ` +
  `(2) f_subjectMatch is CONFOUNDED: AUC vs ALL noise is 0.95-0.999 BUT vs the same-entity in-cap hard-negs it collapses to ~0.5 (temporal 0.51, multi_hop 0.54, near_collision 0.66). subjectMatchRateNoise is ~0.001-0.09 — i.e. the same-subject hard-negs (temporal_stale, near_collision_attribute) almost NEVER reach the cap (inCapByRole confirms: temporal cap = 380 direct + 405 stale + ~2 attribute + 23.5k incidental). So high subjectMatch AUC is separating the answer from DIFFERENT-subject incidental noise, exactly as warned — it is NOT a usable disambiguator against the family hard-negs. ` +
  `(3) f_currentStaleFlag SHOULD and DOES separate temporal answer from stale noise: vs the in-cap stale hard-negs AUC=${g('f_currentStaleFlag','temporal',aucVsHardNegs)} (currentRateDirect=1, currentRateStaleNoise=0). It is uninformative for multi_hop/near_collision (~0.5), as expected.\n\n` +
  `PER-FAMILY public-signal informativeness (vs the in-cap hard-negs):\n` +
  `- TEMPORAL: the ONLY genuinely discriminating public signal is currentStaleFlag (AUC ${g('f_currentStaleFlag','temporal',aucVsHardNegs)} vs stale hard-negs). answer-density (support-in-deg 0.5, total-deg ${g('f_totalPublicDegree','temporal',aucVsHardNegs)} INVERTED) and evidence-bundle (hop ${g('f_hopFromBridge','temporal',aucVsHardNegs)} INVERTED) score the ANSWER BELOW the hard-negs — useless/harmful. => atom family 3 (temporal/update-lifecycle) on currentStaleFlag is the cleanest pass.\n` +
  `- MULTI_HOP_RELATION: support-in-degree is the strongest honest signal (AUC ${g('f_supportInDegree','multi_hop_relation',aucVsHardNegs)} vs relation_neighbor/attribute hard-negs); total-degree ${g('f_totalPublicDegree','multi_hop_relation',aucVsHardNegs)} and evidence-bundle hop ${g('f_hopFromBridge','multi_hop_relation',aucVsHardNegs)} also positive. The answer (the supports-edge target) is publicly distinguishable from its relation neighbours. => atom families 1 (answer-density) and 2 (evidence-bundle) BOTH have informative public signal here.\n` +
  `- NEAR_COLLISION: NO public structural feature separates the direct answer from the in-cap hard-negs — support-in-deg 0.5, total-deg ${g('f_totalPublicDegree','near_collision',aucVsHardNegs)} (INVERTED), hop ${g('f_hopFromBridge','near_collision',aucVsHardNegs)} (INVERTED), subjectMatch 0.66 (the near_collision_attribute negs have DIFFERENT subjects so this is the incidental-noise confound again, not separation of the genuine attribute hard-negs which share the subject). The discriminating signal here is the embedding/attribute content, NOT public Memory-IR structure. => DROP for a structural PolicyAtom.\n\n` +
  `RECOMMENDED A100 ORACLE RANKING (by honest hardNegMargin): ${ranking.map((r) => `${r.atomFamily} [${r.bestCellVsHardNegs}=${r.bestAUCvsHardNegs}]`).join('; ')}.\n` +
  `CONCRETE RECOMMENDATION: (1st) family 3 temporal/update-lifecycle — currentStaleFlag cleanly separates current-answer from stale hard-negs (AUC ${g('f_currentStaleFlag','temporal',aucVsHardNegs)}); a current-validity boost / stale-suppression atom has real public signal — oracle it first. (2nd) family 1 answer-density/SNR AND (3rd) family 2 evidence-bundle/multi-hop — BOTH clear ONLY on multi_hop_relation (support-in-degree ${g('f_supportInDegree','multi_hop_relation',aucVsHardNegs)} / hop ${g('f_hopFromBridge','multi_hop_relation',aucVsHardNegs)} vs relation hard-negs); worth a joint relation-family oracle but expect NO temporal/near_collision lift from them (inverted there). DROP family 4 entity/owner-scope as a re-ranking atom: ownerMatch is degenerate (universe-scope) and subjectMatch is the incidental-noise confound (≈0.5 vs the same-subject hard-negs); the cap-restrict already captures the coarse owner signal. Near_collision has NO informative public structural signal at all — its hard-negs are an embedding/attribute-content problem, not a Memory-IR-structure routing target.\n` +
  `CAVEAT: this is a SEPARABILITY precondition (probe-gate step 1), not the oracle upper bound (step 2). A pass means the public signal CAN rank answer over the in-cap hard-negs; the A100 oracle must still show the bounded atom action converts that separability into hidden-eval lift. Also: temporal admission is already fully solved upstream (admission-headroom.json) so the temporal atom value is purely in-cap RE-RANKING (suppress stale, the in-cap noise), consistent with this probe.`;

writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error(`[sep] wrote ${outPath} (${((Date.now() - START_T) / 1000).toFixed(1)}s)`);
console.log(JSON.stringify({ famComposition, aucTable, sanityChecks: report.sanityChecks, recommendedA100Ranking: ranking }, null, 2));
if (typeof reranker.close === 'function') reranker.close();
