#!/usr/bin/env node
/**
 * Category-B (relation-typed admission) CPU probe.
 *
 * Same substrate (policy anchors at subject-bearing ROUTING-edge events), two scorer arms:
 *   A   r4 baseline           — r4 profile, empty substrate
 *   B   r5 no-atoms           — r5 profile, empty substrate          (MUST equal A: no-op gate)
 *   C1  r5.1 ENTITY admission — query entity → admit ALL public-edge reach of matched anchors
 *   C2  r5-B  TYPED admission — query entity + PUBLIC relation-intent parse → admit ONLY the
 *                               intent-matched edge type's reach (the Category-B refinement)
 *   E   random-selector ctrl  — typed admission, anchors at RANDOM events (must NOT lift)
 *
 * The deterministic reranker MAGNITUDE is a PROXY (the real verdict is the A100/Qwen arm). This
 * gate validates: no-op (B==A), bounded query-local firing, random control ≈ 0, and — the point of
 * Category B — that TYPED admission injects FAR fewer docs/query than ENTITY admission (the
 * selectivity that should stop the r5.1 −0.14 displacement). Public only: query text + entity
 * registry + corpus relation structure; NO qrels/gold/answer/family fed to the scorer.
 *
 * Usage: node scripts/probe-r5-relation-typed.mjs [--pack-size 96] [--reranker deterministic|gpu] [--out ..]
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
  stableRecordIdFor, encodeMemoryIndexSlot, encodePolicyAtom, decodeSubstrate, parseQueryRelationIntent,
  POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE,
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
const outPath = flag('out', `${base}/r5-relation-typed.json`);
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

const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const GENERIC_ENTITY_IDS = ['e_universe'];
const policyEntityRegistry = (rawCorpus.entities ?? []).map((e) => ({ id: e.id, names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()) }));
const admitOpts = { policyQueryConditionedAdmission: true, policyEntityRegistry, policyGenericEntityIds: GENERIC_ENTITY_IDS };
const optsEntity = { ...optsR5, exposeFullRanking: true, ...admitOpts };                                   // C1
const optsTyped = { ...optsR5, exposeFullRanking: true, ...admitOpts, policyRelationTypedAdmission: true }; // C2

const seedHex = '0x' + createHash('sha256').update('r5-relation-typed').digest('hex');
const pack = deriveQueryPack(1, seedHex, corpus, { ...r5Profile.hiddenPack, packSize, quotas: [] });
const famOf = new Map(logical.queries.map((q) => [q.id, q.family]));
const qtextOf = new Map(logical.queries.map((q) => [q.id, q.queryText]));
console.error(`[rt] corpus=${corpus.events.length} evt | pack=${pack.events.length} q | families=${[...new Set(pack.events.map((e) => famOf.get(e.recordId ?? e.id)))].join(',')}`);

const bucket = (f) => (f === 'temporal_update' ? 'temporal' : f === 'near_collision' ? 'near_collision' : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance' || f === 'conflict_lifecycle') ? 'multi_hop_relation' : 'long_horizon');
const ROUTING_EDGES = new Set(['supports', 'causes', 'coreference_of', 'derived_from']);

// ── ANCHOR PLACEMENT (public): every subject-bearing event carrying ≥1 routing edge whose subject is
//    mentioned by some eval query. Honest: subject parse + corpus edge structure; no qrels/gold. The
//    same anchor set serves BOTH arms; only the scorer's admission filter differs.
// PUBLIC subject grounding (exact id), not name matching — at 300k canonical names collide 112-way so
// name parse fans a query out to 100+ subjects and floods admission. subjectEntityId is collision-proof.
const subjById = new Map(logical.queries.map((q) => [q.id, q.subjectEntityId]));
const evalSubjects = new Set();
for (const e of pack.events) { const sid = subjById.get(e.recordId ?? e.id); if (sid && !GENERIC_ENTITY_IDS.includes(sid)) evalSubjects.add(sid); }
if (evalSubjects.size === 0) console.error('[rt] WARNING: 0 eval subjects — corpus lacks subjectEntityId; regenerate before trusting this probe.');
// The POLICY_EVIDENCE region holds 128 atom slots, so cap anchors at 128. Select GREEDILY to cover
// as many (subject, routing-edge-type) pairs as possible → every covered query's intent has a matching
// anchor. Honest: subject parse + corpus edge structure; no qrels/gold.
const ANCHOR_CAP = 128;
const candAnchors = [];
for (const ev of corpus.events) {
  const edgeTypes = new Set((ev.relations ?? []).map((r) => r.edgeType).filter((t) => ROUTING_EDGES.has(t)));
  if (edgeTypes.size === 0) continue;
  const subs = (ev.entityIds ?? []).filter((e) => !GENERIC_ENTITY_IDS.includes(e) && evalSubjects.has(e));
  if (subs.length === 0) continue;
  candAnchors.push({ id: ev.id, subs, edgeTypes: [...edgeTypes] });
}
const coveredPairs = new Set();
const newCoverage = (a) => a.subs.reduce((acc, s) => acc + a.edgeTypes.filter((t) => !coveredPairs.has(`${s}|${t}`)).length, 0);
const anchorEvents = [];
const remaining = [...candAnchors];
while (anchorEvents.length < ANCHOR_CAP && remaining.length) {
  remaining.sort((a, b) => newCoverage(b) - newCoverage(a));
  const best = remaining.shift();
  if (newCoverage(best) === 0) break; // no anchor adds coverage → stop (rest are redundant)
  anchorEvents.push(best.id);
  for (const s of best.subs) for (const t of best.edgeTypes) coveredPairs.add(`${s}|${t}`);
}
console.error(`[rt] evalSubjects=${evalSubjects.size} routing-edge candidates=${candAnchors.length} selected anchors=${anchorEvents.length} coveredPairs=${coveredPairs.size}`);

const eventById = new Map(corpus.events.map((e) => [e.id, e]));
function buildState(anchorIds, atomsOn = true) {
  const words = new Array(1024).fill(0n);
  let slot = 0;
  for (const evId of anchorIds) {
    const ev = eventById.get(evId); if (!ev || slot >= 256) continue;
    words[RANGES.MEMORY_INDEX_START + slot] = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: bucket(ev.family), domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
    if (atomsOn) words[RANGES.POLICY_EVIDENCE_START + slot] = encodePolicyAtom({ atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY, evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'include', scope: 'relation_path', targetSlot: slot, budget: 250, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
    slot++;
  }
  return { state: { words }, anchors: slot };
}

const empty = { words: new Array(1024).fill(0n) };
const honest = buildState(anchorEvents, true);
const dh = decodeSubstrate(honest.state, { policyAtomsMode: true });
console.error(`[rt] substrate anchors=${honest.anchors} evidenceAtoms=${dh.evidenceBundleAtoms.length} decodeFailures=${dh.decodeFailures}`);

// random-control anchors (anti-cheat)
let rng = 0x9e3779b9 >>> 0; const rand = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 0x100000000; };
const allEvIds = corpus.events.map((e) => e.id);
const randAnchors = []; const usedR = new Set();
while (randAnchors.length < anchorEvents.length && usedR.size < allEvIds.length) { const id = allEvIds[Math.floor(rand() * allEvIds.length)]; if (!usedR.has(id)) { usedR.add(id); randAnchors.push(id); } }
const randomState = buildState(randAnchors, true);

const A = await evaluateRetrievalBenchmarkState(empty, corpus, pack, optsR4);
const B = await evaluateRetrievalBenchmarkState(empty, corpus, pack, optsR5);
const C1 = await evaluateRetrievalBenchmarkState(honest.state, corpus, pack, optsEntity);
const C2 = await evaluateRetrievalBenchmarkState(honest.state, corpus, pack, optsTyped);
const E = await evaluateRetrievalBenchmarkState(randomState.state, corpus, pack, optsTyped);

const byId = (sc) => new Map(sc.perQuery.map((q) => [q.recordId, q]));
const aQ = byId(A), bQ = byId(B), c1Q = byId(C1), c2Q = byId(C2), eQ = byId(E);

// no-op gate
let maxNoOp = 0; for (const [id, qa] of aQ) { const qb = bQ.get(id); if (qb) maxNoOp = Math.max(maxNoOp, Math.abs(qa.nDCG10 - qb.nDCG10)); }

// admitted docs/query (selectivity) + per-family deltas + gold-direct rank movement
function analyze(cQ, label) {
  const fams = [...new Set(pack.events.map((e) => famOf.get(e.recordId ?? e.id)))];
  const per = {};
  let admittedSum = 0, admittedN = 0, admittedMax = 0;
  for (const f of fams) {
    const ids = pack.events.filter((e) => famOf.get(e.recordId ?? e.id) === f).map((e) => e.recordId ?? e.id);
    let dSum = 0, n = 0, moved = 0, damaged = 0, rose = 0;
    for (const id of ids) {
      const qb = bQ.get(id), qc = cQ.get(id); if (!qb || !qc) continue;
      n++; const d = qc.nDCG10 - qb.nDCG10; dSum += d;
      if (Math.abs(d) > 1e-9) moved++; if (d < -1e-9) damaged++; if (d > 1e-9) rose++;
    }
    per[f] = { n, meanDeltaNdcg: n ? +(dSum / n).toFixed(4) : 0, moved, rose, damaged };
  }
  for (const q of cQ.values()) {
    const admitted = (q.cappedDocSources ?? []).filter((s) => (s ?? []).includes('policyAdmitted')).length;
    admittedSum += admitted; admittedN++; admittedMax = Math.max(admittedMax, admitted);
  }
  return { label, ndcg: +cQ === cQ ? cQ : undefined, perFamily: per, admittedDocsPerQuery: { mean: admittedN ? +(admittedSum / admittedN).toFixed(2) : 0, max: admittedMax } };
}
const entityAnalysis = analyze(c1Q, 'entity');
const typedAnalysis = analyze(c2Q, 'typed');

// random control overall delta vs B
let rSum = 0, rN = 0; for (const [id, qb] of bQ) { const qe = eQ.get(id); if (qe) { rSum += qe.nDCG10 - qb.nDCG10; rN++; } }

// per-anchor fire counts (locality) from typed arm
const fireByAtom = new Map();
for (const q of C2.perQuery) for (const t of q.policyTraces ?? []) { if (t.atomFamily === 'abstention') continue; const s = fireByAtom.get(t.atomId) ?? new Set(); s.add(q.recordId); fireByAtom.set(t.atomId, s); }
const fireCounts = [...fireByAtom.values()].map((s) => s.size);
const maxFire = fireCounts.length ? Math.max(...fireCounts) : 0;
const meanFire = fireCounts.length ? +(fireCounts.reduce((a, b) => a + b, 0) / fireCounts.length).toFixed(2) : 0;

const report = {
  probe: 'r5-relation-typed (Category B). Deterministic magnitude is a PROXY; A100/Qwen is the verdict.',
  generatedAt: new Date().toISOString(),
  corpus: corpusPath, packSize: pack.events.length, reranker: rerankerArg === 'gpu' ? 'Qwen3-Reranker-0.6B (gpu)' : 'deterministic-stub',
  anchors: honest.anchors, evalSubjects: evalSubjects.size,
  arms: { A_r4: +A.nDCG10.toFixed(4), B_r5_noatoms: +B.nDCG10.toFixed(4), C1_entity: +C1.nDCG10.toFixed(4), C2_typed: +C2.nDCG10.toFixed(4), E_random_typed: +E.nDCG10.toFixed(4) },
  noOpGate: { maxPerQueryNdcgDelta: maxNoOp, holds: maxNoOp < 1e-9 },
  selectivity: { entity_admittedDocsPerQuery: entityAnalysis.admittedDocsPerQuery, typed_admittedDocsPerQuery: typedAnalysis.admittedDocsPerQuery },
  entity_BtoC1_perFamily: entityAnalysis.perFamily,
  typed_BtoC2_perFamily: typedAnalysis.perFamily,
  randomControl_typed_BtoE: { meanDeltaNdcg: rN ? +(rSum / rN).toFixed(4) : 0, n: rN, note: 'must NOT lift' },
  locality_typed: { atomsFired: fireCounts.length, maxAtomFireQueries: maxFire, meanAtomFireQueries: meanFire },
};
mkdirSync(resolve(repoRoot, base), { recursive: true });
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\nNO-OP GATE: ${maxNoOp < 1e-9 ? 'PASS' : 'FAIL'} (maxDelta=${maxNoOp})`);
if (typeof reranker.close === 'function') reranker.close();
