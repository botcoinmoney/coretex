#!/usr/bin/env node
/**
 * Category-B relation-typed admission — LAUNCH validation (multi-seed, larger routing-family pack).
 *
 * Builds a stratified validation pack (routing families oversampled + off-intent families kept in the
 * SAME pack), 3 seeds. For each seed runs 4 arms on the SAME substrate:
 *   A  r4 baseline (r4 profile, empty substrate)
 *   B  r5 no-atoms (r5 profile, empty substrate)            — no-op gate (== A)
 *   C1 ENTITY admission   (query-conditioned, all-edge reach)
 *   C2 TYPED admission    (Category B: query relation-intent → intent-typed reach only)
 *   E  RANDOM-typed       (typed admission, anchors at random events) — anti-cheat (must NOT lift)
 *
 * Reports per seed + aggregate: overall / routing-slice / off-family nDCG; goldMoved/goldRose;
 * answerDamage; junkMoved; docsAdded/query; maxAtomFire; random-control delta; no-op maxAbsDelta.
 * PUBLIC only: query text + entity registry + corpus relation structure. Family/qrels = ATTRIBUTION
 * only (pack stratification + slice tagging), NEVER in selector logic.
 *
 * Usage: node scripts/probe-r5-relation-typed-validate.mjs [--seeds 1,2,3] [--reranker gpu] [--route-per-fam 18] [--off-per-fam 14] [--out ..]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const C = await import(distIndex);
const {
  scoringOptionsFromProfile, evaluateRetrievalBenchmarkState, createDeterministicReranker,
  stableRecordIdFor, encodeMemoryIndexSlot, encodePolicyAtom, parseQueryRelationIntent,
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
const seeds = flag('seeds', '1,2,3').split(',').map(Number);
const routePerFam = Number(flag('route-per-fam', '18'));
const offPerFam = Number(flag('off-per-fam', '14'));
const outPath = flag('out', `${base}/r5-relation-typed-validate.json`);
const rerankerArg = flag('reranker', 'deterministic');

const r4Profile = JSON.parse(readFileSync(resolve(repoRoot, r4ProfilePath), 'utf8'));
const r5Profile = JSON.parse(readFileSync(resolve(repoRoot, r5ProfilePath), 'utf8'));
const { corpus, queryEvents, logical, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const reranker = rerankerArg === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const optsR4 = scoringOptionsFromProfile(r4Profile, rt);
const optsR5 = scoringOptionsFromProfile(r5Profile, rt);
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const GENERIC = ['e_universe'];
const policyEntityRegistry = (rawCorpus.entities ?? []).map((e) => ({ id: e.id, names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()) }));
const admitOpts = { policyQueryConditionedAdmission: true, policyEntityRegistry, policyGenericEntityIds: GENERIC };
const optsEntity = { ...optsR5, exposeFullRanking: true, ...admitOpts };
const optsTyped = { ...optsR5, exposeFullRanking: true, ...admitOpts, policyRelationTypedAdmission: true };

const ROUTING_FAMS = ['multi_session_bridge', 'decision_provenance', 'causal_memory_chain', 'coreference_resolution'];
const OFF_FAMS = ['temporal_update', 'aspect_constraint', 'conflict_lifecycle', 'abstention_missing'];
const ROUTING_EDGES = new Set(['supports', 'causes', 'coreference_of', 'derived_from']);
const byFam = new Map();
for (const q of queryEvents) { const f = q.logicalFamily; if (!byFam.has(f)) byFam.set(f, []); byFam.get(f).push(q); }
const eventById = new Map(corpus.events.map((e) => [e.id, e]));
const bucket = (f) => (f === 'temporal_update' ? 'temporal' : f === 'near_collision' ? 'near_collision' : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance' || f === 'conflict_lifecycle') ? 'multi_hop_relation' : 'long_horizon');

function rng(seed) { let s = (seed * 2654435761) >>> 0; return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0; return s / 4294967296; }; }
function sample(arr, n, rand) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, Math.min(n, a.length)); }

function buildPack(seed) {
  const rand = rng(seed);
  const pack = [];
  for (const f of ROUTING_FAMS) pack.push(...sample(byFam.get(f) ?? [], routePerFam, rand));
  for (const f of OFF_FAMS) pack.push(...sample(byFam.get(f) ?? [], offPerFam, rand));
  return pack;
}

function buildAnchors(pack) {
  const evalSubjects = new Set();
  for (const e of pack) { const qt = (e.queryText ?? '').toLowerCase(); for (const ent of policyEntityRegistry) { if (GENERIC.includes(ent.id)) continue; if (ent.names.some((n) => n && qt.includes(n))) evalSubjects.add(ent.id); } }
  const cand = [];
  for (const ev of corpus.events) {
    const ets = new Set((ev.relations ?? []).map((r) => r.edgeType).filter((t) => ROUTING_EDGES.has(t)));
    if (ets.size === 0) continue;
    const subs = (ev.entityIds ?? []).filter((e) => !GENERIC.includes(e) && evalSubjects.has(e));
    if (subs.length === 0) continue;
    cand.push({ id: ev.id, subs, ets: [...ets] });
  }
  const covered = new Set();
  const cov = (a) => a.subs.reduce((acc, s) => acc + a.ets.filter((t) => !covered.has(`${s}|${t}`)).length, 0);
  const anchors = []; const rem = [...cand];
  while (anchors.length < 128 && rem.length) { rem.sort((a, b) => cov(b) - cov(a)); const best = rem.shift(); if (cov(best) === 0) break; anchors.push(best.id); for (const s of best.subs) for (const t of best.ets) covered.add(`${s}|${t}`); }
  return anchors;
}

function buildState(anchorIds) {
  const words = new Array(1024).fill(0n); let slot = 0;
  for (const evId of anchorIds) { const ev = eventById.get(evId); if (!ev || slot >= 128) continue;
    words[RANGES.MEMORY_INDEX_START + slot] = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: bucket(ev.family), domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
    words[RANGES.POLICY_EVIDENCE_START + slot] = encodePolicyAtom({ atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY, evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'include', scope: 'relation_path', targetSlot: slot, budget: 250, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
    slot++;
  }
  return { words };
}

// per-query gold-movement metrics from finalRankingTop20 (relevance carried per ranked doc)
function goldMetrics(qB, qC) {
  const rankOf = (q) => { const m = new Map(); for (const r of q.finalRankingTop20 ?? []) m.set(r.docId, r); return m; };
  const B = rankOf(qB), Cc = rankOf(qC);
  const docs = new Set([...B.keys(), ...Cc.keys()]);
  let goldRose = 0, goldMoved = 0, answerDamage = 0, junkMoved = 0;
  const top10 = (m, docId) => { const r = m.get(docId); return r && r.rank <= 10; };
  for (const d of docs) {
    const rb = B.get(d), rc = Cc.get(d);
    const rel = (rb?.relevance ?? rc?.relevance ?? 0);
    const rankB = rb ? rb.rank : 99, rankC = rc ? rc.rank : 99;
    if (rel >= 1) { if (rankC < rankB) goldRose = 1; if (rankC !== rankB) goldMoved = 1; }
    if (rel > 0 && top10(B, d) && !top10(Cc, d)) answerDamage++;
    if (rel === 0 && !top10(B, d) && top10(Cc, d)) junkMoved++;
  }
  return { goldRose, goldMoved, answerDamage, junkMoved };
}

const empty = { words: new Array(1024).fill(0n) };
const perSeed = [];
for (const seed of seeds) {
  const packEvents = buildPack(seed);
  const pack = { events: packEvents, corpusRoot: corpus.corpusRoot, epochId: seed, evalSeedHex: '0x' + seed.toString(16).padStart(64, '0') };
  const anchors = buildAnchors(packEvents);
  // random-control anchors
  const rand = rng(seed + 7919); const allEv = corpus.events.map((e) => e.id); const used = new Set(); const randA = [];
  while (randA.length < anchors.length && used.size < allEv.length) { const id = allEv[Math.floor(rand() * allEv.length)]; if (!used.has(id)) { used.add(id); randA.push(id); } }
  const honest = buildState(anchors); const randState = buildState(randA);

  const A = await evaluateRetrievalBenchmarkState(empty, corpus, pack, optsR4);
  const Bv = await evaluateRetrievalBenchmarkState(empty, corpus, pack, optsR5);
  const C1 = await evaluateRetrievalBenchmarkState(honest, corpus, pack, optsEntity);
  const C2 = await evaluateRetrievalBenchmarkState(honest, corpus, pack, optsTyped);
  const E = await evaluateRetrievalBenchmarkState(randState, corpus, pack, optsTyped);

  const id = (q) => q.recordId;
  const famOf = new Map(packEvents.map((q) => [q.id, q.logicalFamily]));
  const bMap = new Map(Bv.perQuery.map((q) => [id(q), q]));
  const mk = (sc) => new Map(sc.perQuery.map((q) => [id(q), q]));
  const c1M = mk(C1), c2M = mk(C2), eM = mk(E), aM = mk(A);

  let noOp = 0; for (const [k, qa] of aM) { const qb = bMap.get(k); if (qb) noOp = Math.max(noOp, Math.abs(qa.nDCG10 - qb.nDCG10)); }

  function sliceStats(fams, cM) {
    const ks = packEvents.filter((q) => fams.includes(q.logicalFamily)).map((q) => q.id);
    let dsum = 0, n = 0, rose = 0, moved = 0, dmg = 0, junk = 0, admittedSum = 0, admittedMax = 0;
    for (const k of ks) { const qb = bMap.get(k), qc = cM.get(k); if (!qb || !qc) continue; n++; dsum += qc.nDCG10 - qb.nDCG10;
      const gm = goldMetrics(qb, qc); rose += gm.goldRose; moved += gm.goldMoved; dmg += gm.answerDamage; junk += gm.junkMoved;
      const adm = (qc.cappedDocSources ?? []).filter((s) => (s ?? []).includes('policyAdmitted')).length; admittedSum += adm; admittedMax = Math.max(admittedMax, adm);
    }
    return { n, meanDeltaNdcg: n ? +(dsum / n).toFixed(4) : 0, goldRose: rose, goldMoved: moved, answerDamage: dmg, junkMoved: junk, admittedMeanPerQ: n ? +(admittedSum / n).toFixed(2) : 0, admittedMaxPerQ: admittedMax };
  }
  // maxAtomFire (typed)
  const fire = new Map();
  for (const q of C2.perQuery) for (const t of q.policyTraces ?? []) { if (t.atomFamily === 'abstention') continue; const s = fire.get(t.atomId) ?? new Set(); s.add(id(q)); fire.set(t.atomId, s); }
  const fireCounts = [...fire.values()].map((s) => s.size);
  // random control overall delta
  let rs = 0, rn = 0; for (const [k, qb] of bMap) { const qe = eM.get(k); if (qe) { rs += qe.nDCG10 - qb.nDCG10; rn++; } }

  perSeed.push({
    seed, packSize: packEvents.length, anchors: anchors.length,
    arms: { A_r4: +A.nDCG10.toFixed(4), B_noatoms: +Bv.nDCG10.toFixed(4), C1_entity: +C1.nDCG10.toFixed(4), C2_typed: +C2.nDCG10.toFixed(4), E_random: +E.nDCG10.toFixed(4) },
    noOpMaxAbsDelta: noOp,
    routingSlice_typed: sliceStats(ROUTING_FAMS, c2M),
    offFamily_typed: sliceStats(OFF_FAMS, c2M),
    routingSlice_entity: sliceStats(ROUTING_FAMS, c1M),
    offFamily_entity: sliceStats(OFF_FAMS, c1M),
    maxAtomFire: fireCounts.length ? Math.max(...fireCounts) : 0,
    meanAtomFire: fireCounts.length ? +(fireCounts.reduce((a, b) => a + b, 0) / fireCounts.length).toFixed(2) : 0,
    randomControlDelta: rn ? +(rs / rn).toFixed(4) : 0,
  });
  console.error(`[val] seed=${seed} pack=${packEvents.length} anchors=${anchors.length} | A=${A.nDCG10.toFixed(3)} B=${Bv.nDCG10.toFixed(3)} C1=${C1.nDCG10.toFixed(3)} C2=${C2.nDCG10.toFixed(3)} E=${E.nDCG10.toFixed(3)} | route-typed Δ=${perSeed.at(-1).routingSlice_typed.meanDeltaNdcg} off-typed Δ=${perSeed.at(-1).offFamily_typed.meanDeltaNdcg} noOp=${noOp}`);
}

const agg = (sel) => { const v = perSeed.map(sel); return { mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4), min: +Math.min(...v).toFixed(4), max: +Math.max(...v).toFixed(4), perSeed: v }; };
const summary = {
  noOp_holds_allSeeds: perSeed.every((s) => s.noOpMaxAbsDelta < 1e-9),
  routingSlice_typed_meanDelta: agg((s) => s.routingSlice_typed.meanDeltaNdcg),
  offFamily_typed_meanDelta: agg((s) => s.offFamily_typed.meanDeltaNdcg),
  overall_C2_minus_B: agg((s) => +(s.arms.C2_typed - s.arms.B_noatoms).toFixed(4)),
  overall_C1_minus_B: agg((s) => +(s.arms.C1_entity - s.arms.B_noatoms).toFixed(4)),
  randomControlDelta: agg((s) => s.randomControlDelta),
  maxAtomFire: agg((s) => s.maxAtomFire),
  routing_typed_positive_allSeeds: perSeed.every((s) => s.routingSlice_typed.meanDeltaNdcg > 0),
  offFamily_typed_damageApproxZero_allSeeds: perSeed.every((s) => Math.abs(s.offFamily_typed.meanDeltaNdcg) < 0.005),
  typed_beats_entity_routing_allSeeds: perSeed.every((s) => s.routingSlice_typed.meanDeltaNdcg >= s.routingSlice_entity.meanDeltaNdcg),
};
const report = { probe: 'r5-relation-typed-validate (Category B launch validation, multi-seed)', generatedAt: new Date().toISOString(), corpus: corpusPath, reranker: rerankerArg === 'gpu' ? 'Qwen3-Reranker-0.6B (gpu)' : 'deterministic-stub', seeds, routePerFam, offPerFam, perSeed, summary };
mkdirSync(resolve(repoRoot, base), { recursive: true });
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (typeof reranker.close === 'function') reranker.close();
