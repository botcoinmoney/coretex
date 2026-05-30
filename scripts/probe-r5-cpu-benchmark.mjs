#!/usr/bin/env node
/**
 * r5 CPU benchmark validation (deterministic reranker). Three arms on the same eval pack:
 *   A  r4 baseline        — r4 profile, empty substrate
 *   B  r5 no-atoms        — r5 profile, empty substrate  (MUST equal A: the no-op safety gate)
 *   C  r5 honest atoms    — r5 profile, substrate carrying PROPOSER-VISIBLE atoms compiled from
 *                           PUBLIC corpus structure only (support-in-degree hubs → evidence-bundle;
 *                           abstain atom for missing-evidence). No qrels / answer ids touched.
 *
 * Stop conditions checked (per the r5 guidance):
 *   - B == A per-query nDCG  → r5 no-atoms does not change the r4 score (profile gating correct).
 *   - C vs B: source attribution (traces) shows atoms moved docs; junk/flood tail measured;
 *     primary-answer damage measured; abstention does not overfire (false-abstention rate).
 * Deterministic-reranker MAGNITUDE is a PROXY (the real verdict is the A100 arm); this gate
 * validates WIRING + no-op + attribution + no-damage, exactly like the CPU oracle ladder.
 *
 * Usage: node scripts/probe-r5-cpu-benchmark.mjs [--corpus ..] [--emb ..] [--pack-size 64] [--out ..]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const C = await import(distIndex);
const {
  scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState, createDeterministicReranker,
  stableRecordIdFor, encodeMemoryIndexSlot, encodePolicyAtom, decodeSubstrate,
  POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE, POLICY_TARGET_NONE,
} = C;
const { RANGES } = await import(resolve(repoRoot, 'packages/cortex/dist/state/types.js'));

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-r5-synth-embeddings.json`);
const r4ProfilePath = flag('r4-profile', 'release/bundle/evaluator-profile-v2-dgen1-deep-r1.json');
const r5ProfilePath = flag('r5-profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json');
const packSize = Number(flag('pack-size', '96'));
const outPath = flag('out', `${base}/r5-cpu-benchmark.json`);

const rerankerArg = flag('reranker', 'deterministic');
const r4Profile = JSON.parse(readFileSync(resolve(repoRoot, r4ProfilePath), 'utf8'));
const r5Profile = JSON.parse(readFileSync(resolve(repoRoot, r5ProfilePath), 'utf8'));
const { corpus, logical, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const reranker = rerankerArg === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const optsR4 = scoringOptionsFromProfile(r4Profile, rt);
const optsR5 = scoringOptionsFromProfile(r5Profile, rt);
// r5.1: public entity registry (id -> lowercased canonicalName+aliases) for the entity-parse selector.
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const GENERIC_ENTITY_IDS = ['e_universe'];
const policyEntityRegistry = (rawCorpus.entities ?? []).map((e) => ({ id: e.id, names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()) }));
const ADMISSION = flag('admission', '1') === '1';   // r5.1 query-conditioned admission (on by default)
// emit traces for the honest arm; arm C = r5.1 admission ON
const optsR5Trace = { ...optsR5, exposeFullRanking: true, ...(ADMISSION ? { policyQueryConditionedAdmission: true, policyEntityRegistry, policyGenericEntityIds: GENERIC_ENTITY_IDS } : {}) };

// Pack: a fixed eval_hidden pack (deterministic).
const seedHex = '0x' + createHash('sha256').update('r5-cpu-benchmark').digest('hex');
const pack = deriveQueryPack(1, seedHex, corpus, { ...r5Profile.hiddenPack, packSize, quotas: [] });
console.error(`[r5-bench] corpus=${corpus.events.length} evt | pack=${pack.events.length} q | families=${[...new Set(pack.events.map((e) => e.family))].join(',')}`);

const empty = { words: new Array(1024).fill(0n) };
const bucket = (f) => (f === 'temporal_update' ? 'temporal' : f === 'near_collision' ? 'near_collision' : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance' || f === 'conflict_lifecycle') ? 'multi_hop_relation' : 'long_horizon');
const eventById = new Map(corpus.events.map((e) => [e.id, e]));
// doc -> owning event (over all truth docs), for pool-frequency of candidate anchors.
const docToEvent = new Map();
for (const ev of corpus.events) for (const td of ev.truthDocuments ?? []) docToEvent.set(td.id, ev.id);

// ── Score the no-op arms FIRST (A r4 baseline, B r5 no-atoms) ─────────────────
const A = await evaluateRetrievalBenchmarkState(empty, corpus, pack, optsR4);
const B = await evaluateRetrievalBenchmarkState(empty, corpus, pack, optsR5);

// ── QUERY-SELECTIVE honest generator (PUBLIC structure only) ──────────────────
// Anchor at SPECIFIC evidence events that appear in FEW query pools (query-local by
// construction), NOT global support hubs. Pool-frequency is read from B's PUBLIC candidate
// pools (cappedDocIds → owning event); support-in-degree + public edges are corpus structure.
// No qrels / answer ids. This enforces the design rule (query-local scope, per-query budget).
const inDeg = new Map();
for (const ev of corpus.events) for (const rel of ev.relations ?? []) if (rel.edgeType === 'supports') inDeg.set(rel.other_id, (inDeg.get(rel.other_id) ?? 0) + 1);
// Align anchor selection to the SCORER GATE: an atom fires iff its anchor is in the query's
// top-K stage-1 by biCosine. With no atoms (arm B) the cap pool is ordered by biCosine, so
// cappedDocIds[:TOPK] ≈ the query's top-K. Count an anchor's frequency over THAT window so a
// low-frequency anchor is genuinely query-local under the gate (not the broad cap-64 / 3200-tail).
const GATE_TOPK = Number(flag('local-topk', '24'));
const BUDGET = Number(flag('budget', '250'));   // beta*1000; 250 = beta 0.25 (<< the flooding beta 1.0)
const eventPoolFreq = new Map();      // eventId -> # of queries with it in their top-K stage-1
for (const q of B.perQuery) {
  const evs = new Set();
  for (const d of (q.cappedDocIds ?? []).slice(0, GATE_TOPK)) { const e = docToEvent.get(d); if (e) evs.add(e); }
  for (const e of evs) eventPoolFreq.set(e, (eventPoolFreq.get(e) ?? 0) + 1);
}
const POOL_FREQ_MAX = Number(flag('pool-freq-max', '2'));   // query-local: ≤2 top-K windows
const MAX_ANCHORS = Number(flag('max-anchors', '48'));
const GEN = flag('gen', ADMISSION ? 'admission' : 'answer-density');   // admission(r5.1) | answer-density | conflict | lowfreq
const ATOM_ACTION = (GEN === 'answer-density' || GEN === 'admission') ? 'include' : 'bundle';
let candidates;
const roleByEvent = new Map();   // conflict: eventId -> 'boost'(resolved/head) | 'suppress'(candidate/superseded)
if (GEN === 'admission') {
  // r5.1 ADMISSION generator: anchor at SUBJECT-BEARING BRIDGE events (a non-generic entity + public
  // edges) whose subject is mentioned by some eval query. The scorer's query-conditioned admission
  // (entity-parse selector) routes each anchor's evidence into the matching queries' pool — so the
  // anchor need NOT already be retrieved (it routes the MISS). Public: query text + entity registry
  // + event structure; no qrels. Bounded by MAX_ANCHORS; per-query selectivity is the admission's job.
  const evalSubjects = new Set();
  for (const q of B.perQuery) {
    const qt = (logical.queries.find((lq) => lq.id === q.recordId)?.queryText ?? '').toLowerCase();
    for (const ent of policyEntityRegistry) { if (GENERIC_ENTITY_IDS.includes(ent.id)) continue; if (ent.names.some((n) => n && qt.includes(n))) evalSubjects.add(ent.id); }
  }
  // one BRIDGE anchor per eval subject = the subject's event with the most PUBLIC edges (maximizes
  // coverage so admission can fire for every query about a covered subject). Bounded by MAX_ANCHORS.
  const bridgeBySubject = new Map();
  for (const ev of corpus.events) {
    const deg = (ev.relations ?? []).length; if (deg === 0) continue;
    for (const e of (ev.entityIds ?? [])) {
      if (GENERIC_ENTITY_IDS.includes(e) || !evalSubjects.has(e)) continue;
      const cur = bridgeBySubject.get(e);
      if (!cur || deg > cur.deg) bridgeBySubject.set(e, { id: ev.id, deg });
    }
  }
  candidates = [...bridgeBySubject.values()].map((b) => b.id).slice(0, MAX_ANCHORS);
  console.error(`[r5-bench] admission: evalSubjects=${evalSubjects.size} bridgeAnchors=${candidates.length}`);
} else if (GEN === 'conflict') {
  // CONFLICT_LIFECYCLE generator (per-query, PUBLIC supersedes structure): among the query's
  // top-K retrieved events, a supersedes edge A->B means A is the RESOLVED/current head and B the
  // superseded CANDIDATE. Boost A, suppress B (both query-local, in top-K). Honest: supersedes is
  // public corpus structure; resolved-vs-candidate is the public head/tail of the chain, no qrels.
  for (const q of B.perQuery) {
    const topK = new Set();
    for (const d of (q.cappedDocIds ?? []).slice(0, GATE_TOPK)) { const e = docToEvent.get(d); if (e) topK.add(e); }
    for (const evId of topK) {
      const ev = eventById.get(evId); if (!ev) continue;
      for (const rel of ev.relations ?? []) {
        if (rel.edgeType === 'supersedes' && topK.has(rel.other_id)) {
          if (!roleByEvent.has(evId)) roleByEvent.set(evId, 'boost');
          if (!roleByEvent.has(rel.other_id)) roleByEvent.set(rel.other_id, 'suppress');
        }
      }
    }
  }
  candidates = [...roleByEvent.keys()].slice(0, MAX_ANCHORS);
} else if (GEN === 'answer-density') {
  const anchorByQuery = new Map();
  for (const q of B.perQuery) {
    let best = null, bestDeg = -1;
    for (const d of (q.cappedDocIds ?? []).slice(0, GATE_TOPK)) { const e = docToEvent.get(d); if (!e) continue; const deg = inDeg.get(e) ?? 0; if (deg > bestDeg) { bestDeg = deg; best = e; } }
    if (best && bestDeg >= 1) anchorByQuery.set(q.recordId, best);
  }
  candidates = [...new Set(anchorByQuery.values())].slice(0, MAX_ANCHORS);
} else {
  candidates = [...eventPoolFreq.entries()]
    .filter(([id, freq]) => freq >= 1 && freq <= POOL_FREQ_MAX)
    .filter(([id]) => { const ev = eventById.get(id); return ev && ((ev.relations ?? []).length > 0 || (inDeg.get(id) ?? 0) >= 1); })
    .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_ANCHORS)
    .map(([id]) => id);
}

function buildHonestState(anchorEventIds, atomsOn = true) {
  const words = new Array(1024).fill(0n);
  let slot = 0;
  for (const evId of anchorEventIds) {
    const ev = eventById.get(evId); if (!ev || slot >= 256) continue;
    words[RANGES.MEMORY_INDEX_START + slot] = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: bucket(ev.family), domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
    if (atomsOn) {
      if (GEN === 'conflict') {
        words[RANGES.POLICY_CONFLICT_START + slot] = encodePolicyAtom({ atomIndex: slot, family: 'conflict_lifecycle', selector: POLICY_SELECTOR.CONFLICT_SET_MEMBER, evidenceFeature: POLICY_EVIDENCE_FEATURE.LIFECYCLE_STATE, action: roleByEvent.get(evId) ?? 'boost', scope: 'conflict_set', targetSlot: slot, budget: BUDGET, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
      } else {
        words[RANGES.POLICY_EVIDENCE_START + slot] = encodePolicyAtom({ atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY, evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: ATOM_ACTION, scope: 'relation_path', targetSlot: slot, budget: BUDGET, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
      }
    }
    slot++;
  }
  if (atomsOn) words[RANGES.POLICY_ABSTENTION_START] = encodePolicyAtom({ atomIndex: 0, family: 'abstention', selector: POLICY_SELECTOR.MISSING_EVIDENCE, evidenceFeature: POLICY_EVIDENCE_FEATURE.NO_PUBLIC_EVIDENCE_PATH, action: 'abstain', scope: 'entity', targetSlot: POLICY_TARGET_NONE, budget: 0, flags: 0x01, validFromEpoch: 0n, expiryEpoch: 0n });
  return { state: { words }, anchors: slot };
}

const honest = buildHonestState(candidates, true);
const dh = decodeSubstrate(honest.state, { policyAtomsMode: true });
console.error(`[r5-bench] query-selective substrate: candidateAnchors=${candidates.length} (poolFreq<=${POOL_FREQ_MAX}) anchors=${honest.anchors} evidenceAtoms=${dh.evidenceBundleAtoms.length} abstentionAtoms=${dh.abstentionAtoms.length} decodeFailures=${dh.decodeFailures}`);

// ARM B' (anchors-only, NO policy atoms): isolates the anchor-mandatory injection cost from the
// policy-atom effect. B->B' = cost of placing the MemoryIndex anchor scaffolding; B'->C = the
// ISOLATED policy-atom effect (the actual question).
const anchorsOnly = buildHonestState(candidates, false);
const Bp = await evaluateRetrievalBenchmarkState(anchorsOnly.state, corpus, pack, optsR5);

const Cc = await evaluateRetrievalBenchmarkState(honest.state, corpus, pack, optsR5Trace);

// ── RANDOM-CONTROL arm (anti-cheat): anchor at RANDOM events, not evidence structure ──
// Must NOT lift (a routing surface that rewards random atoms is gameable). Same atom count.
let rng = 0x9e3779b9 >>> 0;
const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 0x100000000; };
const allEvIds = corpus.events.map((e) => e.id);
const randomAnchors = [];
const usedR = new Set();
while (randomAnchors.length < candidates.length && usedR.size < allEvIds.length) {
  const id = allEvIds[Math.floor(rand() * allEvIds.length)];
  if (!usedR.has(id)) { usedR.add(id); randomAnchors.push(id); }
}
const randomState = buildHonestState(randomAnchors);
const E = await evaluateRetrievalBenchmarkState(randomState.state, corpus, pack, optsR5);

// no-op gate: per-query nDCG A vs B
const byId = (sc) => new Map(sc.perQuery.map((q) => [q.recordId, q]));
const aQ = byId(A), bQ = byId(B), cQ = byId(Cc), bpQ = byId(Bp);
// DECOMPOSITION: separate the anchor-mandatory injection cost (B->B') from the ISOLATED
// policy-atom effect (B'->C), and the atom effect restricted to the queries that actually fired.
const firedQ = new Set();
for (const q of Cc.perQuery) for (const t of q.policyTraces ?? []) if (t.atomFamily !== 'abstention') firedQ.add(q.recordId);
let anchorCostSum = 0, anchorCostN = 0, atomSum = 0, atomN = 0, atomFiredSum = 0, atomFiredN = 0;
for (const [id, qb] of bQ) {
  const qbp = bpQ.get(id), qc = cQ.get(id); if (!qbp || !qc) continue;
  anchorCostSum += qbp.nDCG10 - qb.nDCG10; anchorCostN++;
  atomSum += qc.nDCG10 - qbp.nDCG10; atomN++;
  if (firedQ.has(id)) { atomFiredSum += qc.nDCG10 - qbp.nDCG10; atomFiredN++; }
}
const decomposition = {
  Bprime_anchorsOnly_ndcg: +Bp.nDCG10.toFixed(4),
  anchorInjectionCost_BtoBprime: anchorCostN ? +(anchorCostSum / anchorCostN).toFixed(4) : 0,
  isolatedAtomEffect_BprimeToC_all: atomN ? +(atomSum / atomN).toFixed(4) : 0,
  isolatedAtomEffect_BprimeToC_firedQueriesOnly: atomFiredN ? +(atomFiredSum / atomFiredN).toFixed(4) : 0,
  firedQueries: firedQ.size,
  note: 'B->B\' = anchor-mandatory injection cost (scaffolding); B\'->C = ISOLATED policy-atom effect',
};
// Aggregate r4 vs r5-noatoms identity (launch invariant in aggregate sense).
const aggregateR4VsR5AbsDelta = Math.abs(A.nDCG10 - B.nDCG10);
// ATOM-LOCALITY gate (same r5 scoring engine): C vs B per query restricted to OFF-target
// family queries — isolates atom contribution from r4-vs-r5 dense-lens-vs-policy-atom
// decoder drift (see release/calibration/2026-05-30-noOp-gate-root-cause.md).
const targetFams = new Set(pack.events.filter((e) => firedQ.has(e.recordId ?? e.id)).map((e) => e.family));
let maxNoOpDelta = 0, noOpSamples = 0;
for (const [id, qb] of bQ) {
  const ev = pack.events.find((e) => (e.recordId ?? e.id) === id);
  if (!ev || targetFams.has(ev.family)) continue;
  const qc = cQ.get(id);
  if (!qc) continue;
  noOpSamples++;
  maxNoOpDelta = Math.max(maxNoOpDelta, Math.abs(qc.nDCG10 - qb.nDCG10));
}
const noOpHolds = maxNoOpDelta < 1e-9;

// atom effect B → C (per family)
const fams = [...new Set(pack.events.map((e) => e.family))];
const perFamily = {};
for (const f of fams) {
  const ids = pack.events.filter((e) => e.family === f).map((e) => e.recordId ?? e.id);
  let dSum = 0, n = 0, moved = 0, damaged = 0;
  for (const id of ids) {
    const qb = bQ.get(id), qc = cQ.get(id); if (!qb || !qc) continue;
    n++; const d = qc.nDCG10 - qb.nDCG10; dSum += d;
    if (Math.abs(d) > 1e-9) moved++;
    if (d < -1e-9) damaged++;
  }
  perFamily[f] = { n, meanDeltaNdcg: n ? +(dSum / n).toFixed(4) : 0, queriesMoved: moved, queriesDamaged: damaged };
}

// junk/flood tail + traces from C
let totalTraces = 0, totalDocsMoved = 0, falseAbstain = 0, abstainProbes = 0, abstainCorrect = 0;
const movesPerQuery = [];
let queriesFired = 0;
for (const q of Cc.perQuery) {
  let qMoved = 0, qFired = 0;
  if (q.policyTraces) { totalTraces += q.policyTraces.length; for (const t of q.policyTraces) { totalDocsMoved += t.docsMoved; qMoved += t.docsMoved; if (t.atomFamily !== 'abstention') qFired++; } }
  movesPerQuery.push(qMoved);
  if (qFired > 0) queriesFired++;
  if (q.policyFalseAbstain) falseAbstain++;
  const isAbstain = (logical.queries.find((lq) => lq.id === q.recordId)?.family) === 'abstention_missing';
  if (isAbstain) { abstainProbes++; if (q.policyAbstain) abstainCorrect++; }
}
const answerable = Cc.perQuery.length - abstainProbes;
// random-control arm: overall + per-family mean nDCG delta vs B (must be ≈0 / negative, not a lift)
const eQ = byId(E);
let rDSum = 0, rN = 0;
for (const [id, qb] of bQ) { const qe = eQ.get(id); if (qe) { rDSum += qe.nDCG10 - qb.nDCG10; rN++; } }
const randomControl = { meanDeltaNdcg: rN ? +(rDSum / rN).toFixed(4) : 0, n: rN, note: 'random anchors — must NOT lift (anti-cheat)' };
const maxMovesPerQuery = movesPerQuery.length ? Math.max(...movesPerQuery) : 0;
const meanMovesPerQuery = movesPerQuery.length ? +(movesPerQuery.reduce((a, b) => a + b, 0) / movesPerQuery.length).toFixed(2) : 0;
// PER-ATOM firing = the right query-locality metric: how many distinct queries each atom fires on.
// A query-local atom fires on a HANDFUL of queries (its genuine stage-1 retrieval slice), not all.
const atomFireQueries = new Map();
for (const q of Cc.perQuery) for (const t of q.policyTraces ?? []) { if (t.atomFamily === 'abstention') continue; const s = atomFireQueries.get(t.atomId) ?? new Set(); s.add(q.recordId); atomFireQueries.set(t.atomId, s); }
const perAtomFireCounts = [...atomFireQueries.values()].map((s) => s.size);
const maxAtomFireQueries = perAtomFireCounts.length ? Math.max(...perAtomFireCounts) : 0;
const meanAtomFireQueries = perAtomFireCounts.length ? +(perAtomFireCounts.reduce((a, b) => a + b, 0) / perAtomFireCounts.length).toFixed(2) : 0;
// flood gate: a query-local generator => each atom fires on FEW queries (≤ ~2× the pool-freq bound).
const floodGate = { queriesFired, totalQueries: Cc.perQuery.length, maxMovesPerQuery, meanMovesPerQuery, maxAtomFireQueries, meanAtomFireQueries, atomsFired: perAtomFireCounts.length, queryLocal: maxAtomFireQueries <= POOL_FREQ_MAX * 2 };
// per-anchor diagnostic: pool-freq (from B) vs ACTUAL fire-count (from C). Exposes gate behavior.
const anchorDiag = [];
for (const [atomId, qset] of atomFireQueries) {
  const slot = Number(String(atomId).replace('eb#', ''));
  const evId = candidates[slot];
  anchorDiag.push({ atomId, anchorEvent: evId, poolFreqB: eventPoolFreq.get(evId) ?? 0, fireCountC: qset.size });
}
anchorDiag.sort((a, b) => b.fireCountC - a.fireCountC);
const anchorDiagTop = anchorDiag.slice(0, 6);

const report = {
  probe: 'r5-cpu-benchmark (deterministic; wiring/no-op/attribution/damage — magnitude is a PROXY)',
  generatedAt: new Date().toISOString(),
  corpus: corpusPath, packSize: pack.events.length, reranker: rerankerArg === 'gpu' ? ('Qwen3-Reranker-0.6B (gpu)') : 'deterministic-stub',
  arms: { A_r4_baseline_ndcg: +A.nDCG10.toFixed(4), B_r5_noatoms_ndcg: +B.nDCG10.toFixed(4), C_r5_honest_ndcg: +Cc.nDCG10.toFixed(4) },
  noOpGate: { maxPerQueryNdcgDelta: maxNoOpDelta, holds: noOpHolds, offTargetSamples: noOpSamples, note: 'C vs B per-query, off-target family only (atom-locality on r5 engine)' },
  aggregateR4VsR5Noatoms: { absDelta: aggregateR4VsR5AbsDelta, holds: aggregateR4VsR5AbsDelta < 1e-9, note: 'r4 vs r5-noatoms aggregate-mean nDCG identity (launch invariant sense)' },
  honestSubstrate: { generator: 'query-selective (pool-freq<=' + POOL_FREQ_MAX + ', max ' + MAX_ANCHORS + ' anchors)', anchors: honest.anchors, evidenceAtoms: dh.evidenceBundleAtoms.length, abstentionAtoms: dh.abstentionAtoms.length, decodeFailures: dh.decodeFailures },
  atomEffect_BtoC_perFamily: perFamily,
  decomposition,
  randomControl_BtoE: randomControl,
  floodGate,
  anchorDiagTop,
  attribution: { totalAtomTraces: totalTraces, totalDocsMoved },
  abstention: { abstainProbes, abstainCorrect, answerable, falseAbstain, falseAbstentionRate: answerable ? +(falseAbstain / answerable).toFixed(4) : 0 },
};
mkdirSync(resolve(repoRoot, base), { recursive: true });
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\nNO-OP GATE: ${noOpHolds ? 'PASS' : 'FAIL'} (maxDelta=${maxNoOpDelta})`);
if (typeof reranker.close === 'function') reranker.close();
