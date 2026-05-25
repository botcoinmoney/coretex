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

const r4Profile = JSON.parse(readFileSync(resolve(repoRoot, r4ProfilePath), 'utf8'));
const r5Profile = JSON.parse(readFileSync(resolve(repoRoot, r5ProfilePath), 'utf8'));
const { corpus, logical, LAYOUT, BE, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const reranker = await createDeterministicReranker();
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const optsR4 = scoringOptionsFromProfile(r4Profile, rt);
const optsR5 = scoringOptionsFromProfile(r5Profile, rt);
// emit traces for the honest arm
const optsR5Trace = { ...optsR5, exposeFullRanking: true };

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
const eventPoolFreq = new Map();      // eventId -> # of query pools its truth docs appear in
for (const q of B.perQuery) {
  const evs = new Set();
  for (const d of q.cappedDocIds ?? []) { const e = docToEvent.get(d); if (e) evs.add(e); }
  for (const e of evs) eventPoolFreq.set(e, (eventPoolFreq.get(e) ?? 0) + 1);
}
const POOL_FREQ_MAX = Number(flag('pool-freq-max', '4'));   // query-local: ≤4 pools
const MAX_ANCHORS = Number(flag('max-anchors', '48'));
// candidate anchors: evidence events (≥1 public supports-edge target OR have outgoing public edges)
// that are query-LOCAL (low pool-frequency) — the opposite of global hubs.
const candidates = [...eventPoolFreq.entries()]
  .filter(([id, freq]) => freq >= 1 && freq <= POOL_FREQ_MAX)
  .filter(([id]) => { const ev = eventById.get(id); return ev && ((ev.relations ?? []).length > 0 || (inDeg.get(id) ?? 0) >= 1); })
  .sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : 1))   // lowest pool-freq first (most query-local)
  .slice(0, MAX_ANCHORS)
  .map(([id]) => id);

function buildHonestState(anchorEventIds) {
  const words = new Array(1024).fill(0n);
  let slot = 0;
  for (const evId of anchorEventIds) {
    const ev = eventById.get(evId); if (!ev || slot >= 256) continue;
    words[RANGES.MEMORY_INDEX_START + slot] = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: bucket(ev.family), domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n })[0];
    words[RANGES.POLICY_EVIDENCE_START + slot] = encodePolicyAtom({ atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY, evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'bundle', scope: 'relation_path', targetSlot: slot, budget: 1000, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
    slot++;
  }
  words[RANGES.POLICY_ABSTENTION_START] = encodePolicyAtom({ atomIndex: 0, family: 'abstention', selector: POLICY_SELECTOR.MISSING_EVIDENCE, evidenceFeature: POLICY_EVIDENCE_FEATURE.NO_PUBLIC_EVIDENCE_PATH, action: 'abstain', scope: 'entity', targetSlot: POLICY_TARGET_NONE, budget: 0, flags: 0x01, validFromEpoch: 0n, expiryEpoch: 0n });
  return { state: { words }, anchors: slot };
}

const honest = buildHonestState(candidates);
const dh = decodeSubstrate(honest.state, { policyAtomsMode: true });
console.error(`[r5-bench] query-selective substrate: candidateAnchors=${candidates.length} (poolFreq<=${POOL_FREQ_MAX}) anchors=${honest.anchors} evidenceAtoms=${dh.evidenceBundleAtoms.length} abstentionAtoms=${dh.abstentionAtoms.length} decodeFailures=${dh.decodeFailures}`);

const Cc = await evaluateRetrievalBenchmarkState(honest.state, corpus, pack, optsR5Trace);

// no-op gate: per-query nDCG A vs B
const byId = (sc) => new Map(sc.perQuery.map((q) => [q.recordId, q]));
const aQ = byId(A), bQ = byId(B), cQ = byId(Cc);
let maxNoOpDelta = 0;
for (const [id, qa] of aQ) { const qb = bQ.get(id); if (qb) maxNoOpDelta = Math.max(maxNoOpDelta, Math.abs(qa.nDCG10 - qb.nDCG10)); }
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

const report = {
  probe: 'r5-cpu-benchmark (deterministic; wiring/no-op/attribution/damage — magnitude is a PROXY)',
  generatedAt: new Date().toISOString(),
  corpus: corpusPath, packSize: pack.events.length, reranker: 'deterministic-stub',
  arms: { A_r4_baseline_ndcg: +A.nDCG10.toFixed(4), B_r5_noatoms_ndcg: +B.nDCG10.toFixed(4), C_r5_honest_ndcg: +Cc.nDCG10.toFixed(4) },
  noOpGate: { maxPerQueryNdcgDelta: maxNoOpDelta, holds: noOpHolds, note: 'B (r5 no-atoms) MUST equal A (r4 baseline)' },
  honestSubstrate: { generator: 'query-selective (pool-freq<=' + POOL_FREQ_MAX + ', max ' + MAX_ANCHORS + ' anchors)', anchors: honest.anchors, evidenceAtoms: dh.evidenceBundleAtoms.length, abstentionAtoms: dh.abstentionAtoms.length, decodeFailures: dh.decodeFailures },
  atomEffect_BtoC_perFamily: perFamily,
  floodGate,
  attribution: { totalAtomTraces: totalTraces, totalDocsMoved },
  abstention: { abstainProbes, abstainCorrect, answerable, falseAbstain, falseAbstentionRate: answerable ? +(falseAbstain / answerable).toFixed(4) : 0 },
};
mkdirSync(resolve(repoRoot, base), { recursive: true });
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\nNO-OP GATE: ${noOpHolds ? 'PASS' : 'FAIL'} (maxDelta=${maxNoOpDelta})`);
if (typeof reranker.close === 'function') reranker.close();
