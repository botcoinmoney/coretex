#!/usr/bin/env node
/**
 * Track B — conflict_state as a MINER-MALLEABLE Memory-IR field (substrate-earned, eval-proven).
 *
 * The conflict_lifecycle PolicyAtom MECHANISM already exists (POLICY_CONFLICT region 512–639; scorer
 * boost@resolved / suppress@candidate on the anchor's OWN docs, query-local top-K gate, bounded ±β·UNIT,
 * scope=conflict_set). What was missing: an HONEST generator that decides resolved-vs-candidate from
 * PUBLIC conflict structure (contradicts/scope_differs edge DIRECTION + entity scope) — NOT the corpus
 * `lifecycleState` label, NOT qrels/answer-ids. This probe builds that generator and runs the control ladder.
 *
 * Arms (same pack/seed; only substrate+atoms differ):
 *   A  r4 baseline            (r4 profile, empty)            — reference
 *   B  r5 no-atoms            (r5 profile, empty)            — MUST equal A on conflict family (no-op gate)
 *   H  honest conflict atoms  (boost contradicts-SRC=resolved, suppress contradicts-DST=candidate + scope_differs)
 *   R  random conflict atoms  (same count, random anchors + random action) — must NOT lift
 *   W  wrong-direction atoms  (flip: boost candidate, suppress resolved)    — must HURT
 *
 * Honest source signal: a `contradicts` edge's SRC is the asserting/resolving doc, its DST the contradicted
 * candidate (public relation direction). The wrong-direction arm proves it is the DIRECTION that carries the
 * lift, not mere movement. CPU (deterministic) validates no-op/locality/selectivity/direction; real Qwen is
 * the nDCG verdict. conflict_state must NOT collapse to temporal current/stale — only contradicts/scope edges drive it.
 *
 * Usage: node scripts/probe-conflict-state-malleability.mjs [--pack-size 120] [--reranker deterministic|gpu] [--out ..]
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
  stableRecordIdFor, encodeMemoryIndexSlot, encodePolicyAtom, decodeSubstrate, POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE,
} = C;
const { RANGES } = await import(resolve(repoRoot, 'packages/cortex/dist/state/types.js'));

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-r5-synth-embeddings.json`);
const r4ProfilePath = flag('r4-profile', 'release/bundle/evaluator-profile-v2-dgen1-deep-r1.json');
const r5ProfilePath = flag('r5-profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json');
const packSize = Number(flag('pack-size', '120'));
const outPath = flag('out', `${base}/conflict-state-malleability.json`);
const rerankerArg = flag('reranker', 'deterministic');

const r4Profile = JSON.parse(readFileSync(resolve(repoRoot, r4ProfilePath), 'utf8'));
const r5Profile = JSON.parse(readFileSync(resolve(repoRoot, r5ProfilePath), 'utf8'));
const { corpus, logical, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const reranker = rerankerArg === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const docById = new Map(rawCorpus.docs.map((d) => [d.id, d]));
const GENERIC = new Set(['e_universe']);
const entityRegistry = (rawCorpus.entities ?? []).map((e) => ({ id: e.id, names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()) }));

const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const optsR4 = scoringOptionsFromProfile(r4Profile, rt);
const optsR5base = scoringOptionsFromProfile(r5Profile, rt);
// conflict atoms ON, traces ON (source attribution), bounded budget. HONEST query-local selector =
// CONFLICT_SET_MEMBER: query-conditioned ENTITY admission (the query's subject has a public conflict set) —
// NOT relation-typed (conflict is not relation-routing). An anchor fires only when its subject is the
// query's subject. With an empty substrate this admits nothing → B == A no-op holds.
const optsR5 = { ...optsR5base, exposeFullRanking: true, enableConflictLifecycleAtoms: true, policyEmitTraces: true,
  policyMaxBudgetConflict: 300, policyQueryConditionedAdmission: true, policyEntityRegistry: entityRegistry, policyGenericEntityIds: ['e_universe'] };
const eventById = new Map(corpus.events.map((e) => [e.id, e]));
const bucket = (f) => (f === 'temporal_update' ? 'temporal' : f === 'near_collision' ? 'near_collision' : 'multi_hop_relation');

const seedHex = '0x' + createHash('sha256').update('conflict-state-malleability').digest('hex');
const pack = deriveQueryPack(1, seedHex, corpus, { ...r5Profile.hiddenPack, packSize, quotas: [] });
const famOf = new Map(logical.queries.map((q) => [q.id, q.family]));
const qtextOf = new Map(logical.queries.map((q) => [q.id, q.queryText]));
const packFams = [...new Set(pack.events.map((e) => famOf.get(e.recordId ?? e.id)))];
console.error(`[conflict] pack=${pack.events.length} q | families=${packFams.join(',')}`);

// eval subjects (public): entities mentioned by pack query text. Subjects of CONFLICT-family pack queries
// (family is public query metadata) are prioritized when the 128-slot region can't cover every conflict set.
const subjectsOf = (qid) => { const s = new Set(); const qt = (qtextOf.get(qid) ?? '').toLowerCase(); for (const ent of entityRegistry) { if (GENERIC.has(ent.id)) continue; if (ent.names.some((n) => n && qt.includes(n))) s.add(ent.id); } return s; };
const evalSubjects = new Set(); const conflictQuerySubjects = new Set();
for (const e of pack.events) { const qid = e.recordId ?? e.id; const subs = subjectsOf(qid); for (const s of subs) { evalSubjects.add(s); if (famOf.get(qid) === 'conflict_lifecycle') conflictQuerySubjects.add(s); } }

// ── HONEST conflict-state derivation from PUBLIC edges (contradicts direction + scope_differs). No qrels. ──
// contradicts SRC = asserting/resolving doc → 'resolved' (boost); DST = contradicted → 'candidate' (suppress).
// scope_differs SRC = out-of-scope doc → 'candidate' (suppress). Only docs of an eval subject are anchored.
const touchesEvalSubject = (docId) => { const d = docById.get(docId); return d && (d.entityIds ?? []).some((e) => !GENERIC.has(e) && evalSubjects.has(e)); };
const subjectOfDoc = (docId) => { const d = docById.get(docId); return (d?.entityIds ?? []).find((e) => !GENERIC.has(e)); };
const conflictDocs = new Map();  // docId -> 'resolved' | 'candidate' (honest public judgment)
const setVote = (docId, state) => { if (!touchesEvalSubject(docId)) return; const cur = conflictDocs.get(docId); if (cur === 'resolved') return; conflictDocs.set(docId, state === 'resolved' ? 'resolved' : (cur ?? 'candidate')); };
for (const r of rawCorpus.relations ?? []) {
  if (r.label === 'contradicts') { setVote(r.src, 'resolved'); setVote(r.dst, 'candidate'); }
  else if (r.label === 'scope_differs') { setVote(r.src, 'candidate'); }   // SRC is the out-of-scope answer
}
// Anchor conflict atoms ONLY on docs whose subject is a CONFLICT-family pack-query subject (public query
// text + public family metadata). This keeps the conflict atoms query-LOCAL to conflict queries — a subject
// that only appears in non-conflict queries does not get conflict atoms, which avoids off-family firing on
// queries that merely share a subject. Cap at the 128-slot POLICY_CONFLICT region.
const ANCHOR_CAP = 128;
const ordered = [...conflictDocs.entries()].filter(([docId]) => conflictQuerySubjects.has(subjectOfDoc(docId))).sort((a, b) => a[0].localeCompare(b[0]));
const honestAnchors = [];
for (const [docId, state] of ordered) {
  if (honestAnchors.length >= ANCHOR_CAP) break;
  const evId = `mem_${docId}`; if (!eventById.has(evId)) continue;
  honestAnchors.push({ evId, action: state === 'resolved' ? 'boost' : 'suppress' });
}
console.error(`[conflict] evalSubjects=${evalSubjects.size} conflictQuerySubjects=${conflictQuerySubjects.size} conflictDocs=${conflictDocs.size} honestAnchors=${honestAnchors.length} (boost=${honestAnchors.filter((a) => a.action === 'boost').length} suppress=${honestAnchors.filter((a) => a.action === 'suppress').length})`);

// substrate builder: MemoryIndex anchor (policyAnchor) + conflict atom per anchor.
function buildState(anchors) {
  const words = new Array(1024).fill(0n);
  let slot = 0;
  for (const a of anchors) {
    const ev = eventById.get(a.evId); if (!ev || slot >= 256) continue;
    words[RANGES.MEMORY_INDEX_START + slot] = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(a.evId), family: bucket(ev.family), domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
    words[RANGES.POLICY_CONFLICT_START + slot] = encodePolicyAtom({ atomIndex: slot, family: 'conflict_lifecycle', selector: POLICY_SELECTOR.CONFLICT_SET_MEMBER, evidenceFeature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE, action: a.action, scope: 'conflict_set', targetSlot: slot, budget: 300, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
    slot++;
  }
  return { state: { words }, atoms: slot };
}

// random control: same count, random events, random action.
let rng = 0x9e3779b9 >>> 0; const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 0x100000000; };
const allEvIds = corpus.events.map((e) => e.id);
const randAnchors = []; const usedR = new Set();
while (randAnchors.length < honestAnchors.length && usedR.size < allEvIds.length) { const id = allEvIds[Math.floor(rand() * allEvIds.length)]; if (!usedR.has(id)) { usedR.add(id); randAnchors.push({ evId: id, action: rand() < 0.5 ? 'boost' : 'suppress' }); } }
// wrong-direction: flip honest action.
const wrongAnchors = honestAnchors.map((a) => ({ evId: a.evId, action: a.action === 'boost' ? 'suppress' : 'boost' }));

const empty = { words: new Array(1024).fill(0n) };
const honest = buildState(honestAnchors);
const dh = decodeSubstrate(honest.state, { policyAtomsMode: true });
console.error(`[conflict] substrate atoms=${honest.atoms} conflictLifecycleAtoms=${dh.conflictLifecycleAtoms.length} decodeFailures=${dh.decodeFailures ?? 0}`);
const random = buildState(randAnchors);
const wrong = buildState(wrongAnchors);

const A = await evaluateRetrievalBenchmarkState(empty, corpus, pack, optsR4);
const B = await evaluateRetrievalBenchmarkState(empty, corpus, pack, optsR5);
const H = await evaluateRetrievalBenchmarkState(honest.state, corpus, pack, optsR5);
const R = await evaluateRetrievalBenchmarkState(random.state, corpus, pack, optsR5);
const W = await evaluateRetrievalBenchmarkState(wrong.state, corpus, pack, optsR5);

const byId = (sc) => new Map(sc.perQuery.map((q) => [q.recordId, q]));
const aQ = byId(A), bQ = byId(B), hQ = byId(H), rQ = byId(R), wQ = byId(W);

// no-op gate: r5 no-atoms == r4, per query.
let maxNoOp = 0; for (const [id, qa] of aQ) { const qb = bQ.get(id); if (qb) maxNoOp = Math.max(maxNoOp, Math.abs(qa.nDCG10 - qb.nDCG10)); }

// per-family delta vs B (no-atoms). Conflict family is the target; others are the off-family damage check.
function perFamilyDelta(cQ) {
  const per = {};
  for (const f of packFams) {
    const ids = pack.events.filter((e) => famOf.get(e.recordId ?? e.id) === f).map((e) => e.recordId ?? e.id);
    let dSum = 0, n = 0, moved = 0, damaged = 0, rose = 0;
    for (const id of ids) { const qb = bQ.get(id), qc = cQ.get(id); if (!qb || !qc) continue; n++; const d = qc.nDCG10 - qb.nDCG10; dSum += d; if (Math.abs(d) > 1e-9) moved++; if (d < -1e-9) damaged++; if (d > 1e-9) rose++; }
    per[f] = { n, meanDeltaNdcg: n ? +(dSum / n).toFixed(4) : 0, moved, rose, damaged };
  }
  return per;
}
const conflictDelta = (per) => per.conflict_lifecycle?.meanDeltaNdcg ?? 0;
const offFamilyMax = (per) => Math.max(0, ...Object.entries(per).filter(([f]) => f !== 'conflict_lifecycle').map(([, v]) => -v.meanDeltaNdcg)); // worst regression magnitude
const hPer = perFamilyDelta(hQ), rPer = perFamilyDelta(rQ), wPer = perFamilyDelta(wQ);

// locality + source attribution from the honest arm's conflict traces.
const fireByAtom = new Map(); let conflictTraceMoves = 0;
for (const q of H.perQuery) for (const t of q.policyTraces ?? []) { if (t.atomFamily !== 'conflict_lifecycle') continue; const s = fireByAtom.get(t.atomId) ?? new Set(); s.add(q.recordId); fireByAtom.set(t.atomId, s); conflictTraceMoves += t.docsMoved ?? 0; }
const fireCounts = [...fireByAtom.values()].map((s) => s.size);
const maxFire = fireCounts.length ? Math.max(...fireCounts) : 0;

const honestConflict = conflictDelta(hPer), randomConflict = conflictDelta(rPer), wrongConflict = conflictDelta(wPer);
const honestOffFamilyWorst = +offFamilyMax(hPer).toFixed(4);
// CPU (deterministic) gate = QUALITATIVE: no-op holds, atoms fire+trace (source attribution), and DIRECTION
// is correct (honest beats random AND wrong-direction). Magnitude + off-family are a deterministic PROXY
// (constant scores exaggerate rank flips) — the real verdict is the GPU arm, which adds honest>0 + bounded
// off-family damage. This mirrors the Category-B probe's "deterministic magnitude is a proxy" discipline.
const isGpu = rerankerArg === 'gpu';
const directionOk = honestConflict > randomConflict && honestConflict > wrongConflict && wrongConflict < 0;
const cpuGate = maxNoOp < 1e-9 && conflictTraceMoves > 0 && directionOk;
const pass = isGpu
  ? (cpuGate && honestConflict > 0 && honestOffFamilyWorst <= 0.03)
  : cpuGate;

const report = {
  probe: 'conflict_state malleability (Track B). Honest public-edge generator; deterministic magnitude is a PROXY, Qwen is the verdict.',
  generatedAt: new Date().toISOString(), corpus: corpusPath, reranker: rerankerArg === 'gpu' ? `Qwen3-Reranker-0.6B@${RR.revision} (gpu)` : 'deterministic-stub',
  packSize: pack.events.length, families: packFams, evalSubjects: evalSubjects.size,
  honestAnchors: honest.atoms, conflictAtomsDecoded: dh.conflictLifecycleAtoms.length,
  arms_overall_nDCG10: { A_r4: +A.nDCG10.toFixed(4), B_r5_noatoms: +B.nDCG10.toFixed(4), H_honest: +H.nDCG10.toFixed(4), R_random: +R.nDCG10.toFixed(4), W_wrong: +W.nDCG10.toFixed(4) },
  noOpGate: { maxPerQueryNdcgDelta: maxNoOp, holds: maxNoOp < 1e-9 },
  conflictFamily_meanDeltaNdcg_vsNoAtoms: { honest: honestConflict, random: randomConflict, wrong: wrongConflict },
  honest_perFamily_vsNoAtoms: hPer,
  offFamily_worstRegression_honest: honestOffFamilyWorst,
  locality: { conflictAtomsFired: fireCounts.length, maxAtomFireQueries: maxFire, conflictTraceDocsMoved: conflictTraceMoves },
  sourceAttribution: conflictTraceMoves > 0 ? 'conflict_lifecycle traces moved candidate docs (path confirmed)' : 'NO conflict traces fired',
  verdict: { pass, gate: isGpu ? 'gpu (full)' : 'cpu (qualitative)', cpuGate, directionOk,
    criteria: isGpu ? 'no-op AND traces AND direction(honest>random,honest>wrong<0) AND honest>0 AND offFamilyWorst<=0.03' : 'no-op AND traces fired AND direction(honest>random AND honest>wrong<0)' },
};
mkdirSync(resolve(repoRoot, base), { recursive: true });
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\nNO-OP GATE: ${maxNoOp < 1e-9 ? 'PASS' : 'FAIL'} | CONFLICT MALLEABILITY (${rerankerArg}): ${pass ? 'PASS' : 'not-yet'} (honest ${honestConflict} vs random ${randomConflict} vs wrong ${wrongConflict})`);
if (typeof reranker.close === 'function') reranker.close();
