#!/usr/bin/env node
/**
 * v15 evidence_bundle canonical state/patch mini.
 *
 * This is NOT the bounded oracle. It writes canonical MemoryIndex policy anchors
 * and POLICY_EVIDENCE PolicyAtom words, then scores with the package scorer via
 * evaluateRetrievalBenchmarkState/evaluateRetrievalBenchmarkPatch.
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadV2CompatBundle } from './lib/load-materialized-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';
import { calibrationProvenance } from './lib/calibration-provenance.mjs';

const C = await import(distIndex);
const {
  scoringOptionsFromProfile, evaluateRetrievalBenchmarkState, evaluateRetrievalBenchmarkPatch,
  createDeterministicReranker, stableRecordIdFor, encodeMemoryIndexSlot, encodePolicyAtom,
  merkleizeState, PATCH_TYPE, POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE, computeAcceptanceThresholdPpm,
} = C;
const { RANGES } = await import(resolve(repoRoot, 'packages/cortex/dist/state/types.js'));

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-300k-v15-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-r5-synth-300k-v15-embeddings.json`);
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-calibration.json');
const bundlePath = flag('bundle');
if (!bundlePath) { console.error('HARD FAIL: --bundle <path> required'); process.exit(1); }
const seeds = flag('seeds', '11,17,23').split(',').map(Number);
const targetPerFam = Number(flag('target-per-fam', '10'));
const offPerFam = Number(flag('off-per-fam', '6'));
const actionReach = flag('reach-action', 'boost');
const actionBundle = flag('bundle-action', 'bundle');
const targetSurface = flag('target-surface', 'evidence_bundle');
const targetFamiliesArg = flag('target-fams', 'multi_session_bridge,decision_provenance,causal_memory_chain');
const offFamiliesArg = flag('off-fams', 'temporal_update,conflict_lifecycle,aspect_constraint,abstention_missing,coreference_resolution');
const evidenceEdgesArg = flag('evidence-edges', 'supports,causes,derived_from');
const auditLimit = Math.max(0, Number(flag('audit-limit', has('audit') ? '25' : '0')));
const outPath = flag('out', `${base}/evidence-bundle-canonical-v15-${flag('reranker', 'deterministic')}-current.json`);
const rerankerArg = flag('reranker', 'deterministic');
const realQwen = rerankerArg === 'gpu' || rerankerArg === 'cpu';
const respectProfileEvidence = has('respect-profile-evidence');
const expectDisabled = has('expect-disabled');

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const { corpus, queryEvents, LAYOUT, BE, RR, biEncoderHash, manifest } = loadV2CompatBundle(bundlePath, corpusPath, embPath);
const provenance = calibrationProvenance({ bundlePath, corpusPath, embPath, profilePath, manifest });
const reranker = rerankerArg === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();

const GENERIC = ['e_universe'];
const entityRegistry = (rawCorpus.entities ?? []).map((e) => ({
  id: e.id,
  names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()),
}));
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const optsBase = {
  ...scoringOptionsFromProfile(profile, rt),
  exposeFullRanking: true,
  policyEmitTraces: true,
  ...(!respectProfileEvidence ? {
    enableEvidenceBundleAtoms: true,
    policyQueryConditionedAdmission: true,
    policyRelationTypedAdmission: true,
  } : {}),
  policyEntityRegistry: entityRegistry,
  policyGenericEntityIds: GENERIC,
};
const accOpts = {
  structuralFloor: profile.patchAcceptanceFloors.structuralFloor,
  protectedRegressionFloor: profile.patchAcceptanceFloors.protectedRegressionFloor,
  familyCatastrophicFloor: profile.patchAcceptanceFloors.familyCatastrophicFloor,
  minImprovementPpm: profile.patchAcceptanceFloors.minImprovementPpm,
  acceptanceThresholdPpm: computeAcceptanceThresholdPpm(profile),
};

const TARGET_FAMS = targetFamiliesArg.split(',').map((s) => s.trim()).filter(Boolean);
const OFF_FAMS = offFamiliesArg.split(',').map((s) => s.trim()).filter((f) => f && !TARGET_FAMS.includes(f));
const EVIDENCE_EDGES = new Set(evidenceEdgesArg.split(',').map((s) => s.trim()).filter(Boolean));
const byFam = new Map();
for (const q of queryEvents) {
  const f = q.logicalFamily;
  if (!byFam.has(f)) byFam.set(f, []);
  byFam.get(f).push(q);
}
const eventById = new Map(corpus.events.map((e) => [e.id, e]));
const evidenceAnchorFamily = 'multi_hop_relation';

function rng(seed) { let s = (seed * 2654435761) >>> 0; return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0; return s / 4294967296; }; }
function sample(arr, n, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(n, a.length));
}
function buildPack(seed) {
  const rand = rng(seed);
  const events = [];
  for (const f of TARGET_FAMS) events.push(...sample(byFam.get(f) ?? [], targetPerFam, rand));
  for (const f of OFF_FAMS) events.push(...sample(byFam.get(f) ?? [], offPerFam, rand));
  return events;
}

function buildAnchorIds(packEvents) {
  const subjects = new Set();
  for (const e of packEvents) {
    if (!TARGET_FAMS.includes(e.logicalFamily)) continue;
    if (e.subjectEntityId && !GENERIC.includes(e.subjectEntityId)) subjects.add(e.subjectEntityId);
  }
  const cands = [];
  for (const ev of corpus.events) {
    const subs = (ev.entityIds ?? []).filter((e) => !GENERIC.includes(e) && subjects.has(e));
    if (!subs.length) continue;
    const edges = (ev.relations ?? []).filter((r) => EVIDENCE_EDGES.has(r.edgeType));
    if (!edges.length) continue;
    cands.push({ id: ev.id, subs, edges: edges.map((e) => e.edgeType) });
  }
  const covered = new Set();
  const gain = (a) => a.subs.reduce((acc, s) => acc + a.edges.filter((e) => !covered.has(`${s}|${e}`)).length, 0);
  const anchors = [];
  while (anchors.length < 128 && cands.length) {
    cands.sort((a, b) => gain(b) - gain(a));
    const best = cands.shift();
    if (!best || gain(best) === 0) break;
    anchors.push(best.id);
    for (const s of best.subs) for (const e of best.edges) covered.add(`${s}|${e}`);
  }
  return { anchors, subjects: subjects.size };
}

function emptyState() { return { words: new Array(RANGES.WORD_COUNT).fill(0n) }; }
function buildState(anchorIds, { action = 'bundle', random = false, seed = 0 } = {}) {
  const words = new Array(RANGES.WORD_COUNT).fill(0n);
  const rand = rng(seed + 9001);
  const allIds = corpus.events.map((e) => e.id);
  const ids = random ? [] : anchorIds;
  if (random) {
    const used = new Set();
    while (ids.length < anchorIds.length && used.size < allIds.length) {
      const id = allIds[Math.floor(rand() * allIds.length)];
      if (!used.has(id)) { used.add(id); ids.push(id); }
    }
  }
  let slot = 0;
  for (const id of ids) {
    const ev = eventById.get(id);
    if (!ev || slot >= 128) continue;
    words[RANGES.MEMORY_INDEX_START + slot] = encodeMemoryIndexSlot({
      slotIndex: slot, recordId: stableRecordIdFor(ev.id), family: evidenceAnchorFamily,
      domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n,
    })[0];
    words[RANGES.POLICY_EVIDENCE_START + slot] = encodePolicyAtom({
      atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY,
      evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action, scope: 'relation_path',
      targetSlot: slot, budget: 250, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n,
    });
    slot++;
  }
  return { words, anchorsWritten: slot };
}
function buildAnchorsOnlyState(anchorIds) {
  const words = new Array(RANGES.WORD_COUNT).fill(0n);
  let slot = 0;
  for (const id of anchorIds) {
    const ev = eventById.get(id);
    if (!ev || slot >= 128) continue;
    words[RANGES.MEMORY_INDEX_START + slot] = encodeMemoryIndexSlot({
      slotIndex: slot, recordId: stableRecordIdFor(ev.id), family: evidenceAnchorFamily,
      domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n,
    })[0];
    slot++;
  }
  return { words, anchorsWritten: slot };
}
function patchForFirstAnchor(anchorIds, action = 'bundle') {
  const state = emptyState();
  const ev = eventById.get(anchorIds[0]);
  if (!ev) return null;
  const m = encodeMemoryIndexSlot({
    slotIndex: 0, recordId: stableRecordIdFor(ev.id), family: evidenceAnchorFamily,
    domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n,
  })[0];
  const a = encodePolicyAtom({
    atomIndex: 0, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action, scope: 'relation_path',
    targetSlot: 0, budget: 250, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n,
  });
  return {
    state,
    patch: { patchType: PATCH_TYPE.MIXED, wordCount: 2, scoreDelta: 0n, parentStateRoot: merkleizeState(state), indices: [RANGES.MEMORY_INDEX_START, RANGES.POLICY_EVIDENCE_START], newWords: [m, a] },
  };
}

function byId(sc) { return new Map(sc.perQuery.map((q) => [q.recordId, q])); }
function goldMetrics(qB, qC) {
  const rankOf = (q) => new Map((q.finalRankingTop20 ?? []).map((r) => [r.docId, r]));
  const B = rankOf(qB), Cc = rankOf(qC);
  const docs = new Set([...B.keys(), ...Cc.keys()]);
  let goldRose = 0, goldMoved = 0, answerDamage = 0, primaryGoldDamage = 0, junkMoved = 0;
  const rels = [...docs].map((d) => B.get(d)?.relevance ?? Cc.get(d)?.relevance ?? 0);
  const maxRel = Math.max(0, ...rels);
  const top10 = (m, d) => (m.get(d)?.rank ?? 99) <= 10;
  for (const d of docs) {
    const rb = B.get(d), rc = Cc.get(d);
    const rel = rb?.relevance ?? rc?.relevance ?? 0;
    const rankB = rb?.rank ?? 99, rankC = rc?.rank ?? 99;
    if (rel > 0) {
      if (rankC < rankB) goldRose = 1;
      if (rankC !== rankB) goldMoved = 1;
      if (top10(B, d) && !top10(Cc, d)) {
        answerDamage++;
        if (rel >= maxRel - 1e-9) primaryGoldDamage++;
      }
    } else if (!top10(B, d) && top10(Cc, d)) {
      junkMoved++;
    }
  }
  return { goldRose, goldMoved, answerDamage, primaryGoldDamage, junkMoved };
}
function rankAudit(q) {
  const ranking = (q.finalRankingFull && q.finalRankingFull.length) ? q.finalRankingFull : (q.finalRankingTop20 ?? []);
  let bestRelevantRank = Infinity;
  let bestRelevantScore = null;
  let bestHardNegativeRank = Infinity;
  let bestHardNegativeScore = null;
  for (const [i, r] of ranking.entries()) {
    const rel = r.relevance ?? 0;
    const rank = r.rank ?? (i + 1);
    const score = typeof r.rerankerScore === 'number' ? r.rerankerScore : null;
    if (rel > 0) {
      if (rank < bestRelevantRank) bestRelevantRank = rank;
      if (score !== null && (bestRelevantScore === null || score > bestRelevantScore)) bestRelevantScore = score;
    } else {
      if (rank < bestHardNegativeRank) bestHardNegativeRank = rank;
      if (score !== null && (bestHardNegativeScore === null || score > bestHardNegativeScore)) bestHardNegativeScore = score;
    }
  }
  const rankComparable = Number.isFinite(bestRelevantRank) && Number.isFinite(bestHardNegativeRank);
  const scoreComparable = bestRelevantScore !== null && bestHardNegativeScore !== null;
  return {
    answerInCap: !!q.answerInCap,
    bestRelevantRank: Number.isFinite(bestRelevantRank) ? bestRelevantRank : null,
    bestHardNegativeRank: Number.isFinite(bestHardNegativeRank) ? bestHardNegativeRank : null,
    bestRelevantScore,
    bestHardNegativeScore,
    goldOverHardNegativeByRank: rankComparable ? bestRelevantRank < bestHardNegativeRank : null,
    goldOverHardNegativeByScore: scoreComparable ? bestRelevantScore > bestHardNegativeScore : null,
  };
}
function sliceStats(packEvents, bM, cM, fams) {
  const ids = packEvents.filter((e) => fams.includes(e.logicalFamily)).map((e) => e.id);
  let n = 0, dsum = 0, rose = 0, moved = 0, answerDamage = 0, primaryGoldDamage = 0, junkMoved = 0, admitted = 0, admittedMax = 0, traces = 0, answerInCapBefore = 0, answerInCapAfter = 0;
  let qwenRankEligible = 0, qwenGoldOverHardByRank = 0, qwenScoreEligible = 0, qwenGoldOverHardByScore = 0;
  for (const id of ids) {
    const qb = bM.get(id), qc = cM.get(id);
    if (!qb || !qc) continue;
    n++; dsum += qc.nDCG10 - qb.nDCG10;
    if (qb.answerInCap) answerInCapBefore++;
    if (qc.answerInCap) answerInCapAfter++;
    const gm = goldMetrics(qb, qc);
    rose += gm.goldRose; moved += gm.goldMoved; answerDamage += gm.answerDamage; primaryGoldDamage += gm.primaryGoldDamage; junkMoved += gm.junkMoved;
    const adm = (qc.cappedDocSources ?? []).filter((s) => (s ?? []).includes('policyAdmitted')).length;
    admitted += adm; admittedMax = Math.max(admittedMax, adm);
    traces += (qc.policyTraces ?? []).filter((t) => t.atomFamily === 'evidence_bundle').length;
    if (realQwen) {
      const qa = rankAudit(qc);
      if (qa.goldOverHardNegativeByRank !== null) {
        qwenRankEligible++;
        if (qa.goldOverHardNegativeByRank) qwenGoldOverHardByRank++;
      }
      if (qa.goldOverHardNegativeByScore !== null) {
        qwenScoreEligible++;
        if (qa.goldOverHardNegativeByScore) qwenGoldOverHardByScore++;
      }
    }
  }
  return {
    n,
    meanDeltaNdcg: n ? +(dsum / n).toFixed(4) : 0,
    goldRose: rose,
    goldMoved: moved,
    answerDamage,
    primaryGoldDamage,
    junkMoved,
    admittedMeanPerQ: n ? +(admitted / n).toFixed(2) : 0,
    admittedMaxPerQ: admittedMax,
    evidenceTraceCount: traces,
    answerInCapBefore,
    answerInCapAfter,
    qwenRankCheck: realQwen ? 'real_qwen' : 'not_applicable_deterministic_reranker',
    qwenRankEligible: realQwen ? qwenRankEligible : null,
    qwenGoldOverHardByRank: realQwen ? qwenGoldOverHardByRank : null,
    qwenGoldOverHardByRankRate: realQwen && qwenRankEligible ? +(qwenGoldOverHardByRank / qwenRankEligible).toFixed(4) : null,
    qwenScoreEligible: realQwen ? qwenScoreEligible : null,
    qwenGoldOverHardByScore: realQwen ? qwenGoldOverHardByScore : null,
    qwenGoldOverHardByScoreRate: realQwen && qwenScoreEligible ? +(qwenGoldOverHardByScore / qwenScoreEligible).toFixed(4) : null,
  };
}
function perFamilyStats(packEvents, bM, cM) {
  const out = {};
  for (const f of [...new Set(packEvents.map((e) => e.logicalFamily))]) out[f] = sliceStats(packEvents, bM, cM, [f]);
  return out;
}
function targetAuditRows(packEvents, bM, cM) {
  return packEvents.filter((e) => TARGET_FAMS.includes(e.logicalFamily)).slice(0, auditLimit).map((e) => {
    const qb = bM.get(e.id);
    const qc = cM.get(e.id);
    return {
      id: e.id,
      family: e.logicalFamily,
      subjectEntityId: e.subjectEntityId ?? null,
      deltaNdcg10: qb && qc ? +(qc.nDCG10 - qb.nDCG10).toFixed(4) : null,
      before: qb ? rankAudit(qb) : null,
      after: qc ? rankAudit(qc) : null,
      rankAuditKind: realQwen ? 'real_qwen' : 'deterministic_structural_only',
      policyAdmittedDocs: qc ? (qc.cappedDocSources ?? []).filter((s) => (s ?? []).includes('policyAdmitted')).length : 0,
      evidenceTraceCount: qc ? (qc.policyTraces ?? []).filter((t) => t.atomFamily === 'evidence_bundle').length : 0,
    };
  });
}

const eligible = Object.fromEntries([...TARGET_FAMS, ...OFF_FAMS].map((f) => [f, (byFam.get(f) ?? []).length]));
const perSeed = [];
for (const seed of seeds) {
  const packEvents = buildPack(seed);
  const pack = { events: packEvents, corpusRoot: corpus.corpusRoot, epochId: seed, evalSeedHex: '0x' + seed.toString(16).padStart(64, '0') };
  const { anchors, subjects } = buildAnchorIds(packEvents);
  const states = {
    anchorsOnly: buildAnchorsOnlyState(anchors),
    reach: buildState(anchors, { action: actionReach }),
    bundle: buildState(anchors, { action: actionBundle }),
    randomBundle: buildState(anchors, { action: actionBundle, random: true, seed }),
  };
  const empty = emptyState();
  const B = await evaluateRetrievalBenchmarkState(empty, corpus, pack, optsBase);
  const AO = await evaluateRetrievalBenchmarkState(states.anchorsOnly, corpus, pack, optsBase);
  const R = await evaluateRetrievalBenchmarkState(states.reach, corpus, pack, optsBase);
  const H = await evaluateRetrievalBenchmarkState(states.bundle, corpus, pack, optsBase);
  const X = await evaluateRetrievalBenchmarkState(states.randomBundle, corpus, pack, optsBase);
  const bM = byId(B), aoM = byId(AO), rM = byId(R), hM = byId(H), xM = byId(X);
  const patchSmokeSrc = patchForFirstAnchor(anchors, actionBundle);
  const patchSmoke = patchSmokeSrc ? await evaluateRetrievalBenchmarkPatch(patchSmokeSrc.state, patchSmokeSrc.patch, corpus, pack, optsBase, accOpts) : null;
  const targetBundle = sliceStats(packEvents, bM, hM, TARGET_FAMS);
  const targetReach = sliceStats(packEvents, bM, rM, TARGET_FAMS);
  const offBundle = sliceStats(packEvents, bM, hM, OFF_FAMS);
  const randomTarget = sliceStats(packEvents, bM, xM, TARGET_FAMS);
  const anchorsOnlyTarget = sliceStats(packEvents, bM, aoM, TARGET_FAMS);
  perSeed.push({
    seed,
    packSize: packEvents.length,
    packFamilyCounts: Object.fromEntries([...new Set(packEvents.map((e) => e.logicalFamily))].map((f) => [f, packEvents.filter((e) => e.logicalFamily === f).length])),
    evalSubjects: subjects,
    anchors: anchors.length,
    arms_overall_nDCG10: { B_noatoms: +B.nDCG10.toFixed(4), anchorsOnly: +AO.nDCG10.toFixed(4), reach: +R.nDCG10.toFixed(4), bundle: +H.nDCG10.toFixed(4), randomBundle: +X.nDCG10.toFixed(4) },
    noOpAnchorsOnlyDelta: +(AO.nDCG10 - B.nDCG10).toFixed(6),
    targetReach,
    targetBundle,
    offFamilyBundle: offBundle,
    randomTarget,
    anchorsOnlyTarget,
    perFamilyBundle: perFamilyStats(packEvents, bM, hM),
    lowerLayer: {
      targetAnswerInCapBefore: targetBundle.answerInCapBefore,
      targetAnswerInCapAfter: targetBundle.answerInCapAfter,
      policyAdmittedMeanPerTargetQ: targetBundle.admittedMeanPerQ,
      evidenceTraceCount: targetBundle.evidenceTraceCount,
      qwenRankCheck: targetBundle.qwenRankCheck,
      qwenGoldOverHardByRankRate: targetBundle.qwenGoldOverHardByRankRate,
      qwenGoldOverHardByScoreRate: targetBundle.qwenGoldOverHardByScoreRate,
    },
    patchSmoke: patchSmoke ? { accepted: patchSmoke.accepted, reason: patchSmoke.reason ?? null, deltaPpm: patchSmoke.deltaPpm, applyStructurallyOk: !String(patchSmoke.reason ?? '').startsWith('apply_failed') } : { applyStructurallyOk: false, reason: 'no_anchor' },
    audit: { enabled: auditLimit > 0, auditLimit, targetRowsEmitted: auditLimit > 0 ? Math.min(auditLimit, targetBundle.n) : 0 },
    targetAudit: auditLimit > 0 ? targetAuditRows(packEvents, bM, hM) : [],
  });
  console.error(`[evidence] seed=${seed} pack=${packEvents.length} anchors=${anchors.length} targetΔ bundle=${targetBundle.meanDeltaNdcg} reach=${targetReach.meanDeltaNdcg} offΔ=${offBundle.meanDeltaNdcg} randomΔ=${randomTarget.meanDeltaNdcg}`);
}

const agg = (sel) => {
  const vals = perSeed.map(sel);
  return { mean: +(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)).toFixed(4), min: +Math.min(...vals).toFixed(4), max: +Math.max(...vals).toFixed(4), perSeed: vals };
};
const enabledExpectedPass = perSeed.every((s) =>
  Math.abs(s.noOpAnchorsOnlyDelta) < 1e-9
  && s.targetBundle.meanDeltaNdcg > 0
  && s.targetBundle.primaryGoldDamage === 0
  && s.offFamilyBundle.meanDeltaNdcg >= -0.03
  && s.randomTarget.meanDeltaNdcg <= 0.005
  && s.patchSmoke.applyStructurallyOk);
const disabledExpectedPass = perSeed.every((s) =>
  Math.abs(s.noOpAnchorsOnlyDelta) < 1e-9
  && s.targetBundle.meanDeltaNdcg === 0
  && s.targetReach.meanDeltaNdcg === 0
  && s.offFamilyBundle.meanDeltaNdcg === 0
  && s.randomTarget.meanDeltaNdcg === 0
  && s.targetBundle.evidenceTraceCount === 0
  && s.targetReach.evidenceTraceCount === 0
  && s.offFamilyBundle.evidenceTraceCount === 0
  && s.patchSmoke.applyStructurallyOk);
const summary = {
  pass: expectDisabled ? disabledExpectedPass : enabledExpectedPass,
  expectedMode: expectDisabled ? 'disabled_inert' : 'enabled_positive',
  targetBundle_meanDelta: agg((s) => s.targetBundle.meanDeltaNdcg),
  targetReach_meanDelta: agg((s) => s.targetReach.meanDeltaNdcg),
  offFamilyBundle_meanDelta: agg((s) => s.offFamilyBundle.meanDeltaNdcg),
  randomTarget_meanDelta: agg((s) => s.randomTarget.meanDeltaNdcg),
  primaryGoldDamage: perSeed.reduce((a, s) => a + s.targetBundle.primaryGoldDamage, 0),
  answerDamage: perSeed.reduce((a, s) => a + s.targetBundle.answerDamage, 0),
  junkMoved: perSeed.reduce((a, s) => a + s.targetBundle.junkMoved, 0),
  lowerLayerGate: {
    eligible,
    allSeedsHaveTargetPack: perSeed.every((s) => TARGET_FAMS.every((f) => (s.packFamilyCounts[f] ?? 0) > 0)),
    allSeedsHaveAnchors: perSeed.every((s) => s.anchors > 0),
    allSeedsPolicyAdmitted: perSeed.every((s) => s.lowerLayer.policyAdmittedMeanPerTargetQ > 0),
    allSeedsEvidenceTraces: perSeed.every((s) => s.lowerLayer.evidenceTraceCount > 0),
    patchStructuralOk: perSeed.every((s) => s.patchSmoke.applyStructurallyOk),
    qwenRankCheck: realQwen ? 'real_qwen' : 'not_applicable_deterministic_reranker',
    qwenGoldOverHardByRankRate: realQwen ? agg((s) => s.targetBundle.qwenGoldOverHardByRankRate ?? 0) : null,
    qwenGoldOverHardByScoreRate: realQwen ? agg((s) => s.targetBundle.qwenGoldOverHardByScoreRate ?? 0) : null,
  },
};
const reachArmPromotable = realQwen && summary.targetReach_meanDelta.mean > 0 && summary.targetReach_meanDelta.min > 0;
const verdict = {
  pass: summary.pass,
  promote: summary.pass && !expectDisabled ? ['bundle'] : [],
  doNotPromote: [...(expectDisabled ? ['evidence_bundle_policy_atoms'] : []), ...(reachArmPromotable ? [] : ['reach'])],
  needsFollowup: realQwen && summary.pass ? [] : ['real_qwen_confirmation'],
  reasons: [
    expectDisabled
      ? (summary.pass ? 'evidence PolicyAtoms are disabled and inert under this profile' : 'evidence PolicyAtoms produced movement despite disabled profile')
      : (summary.pass ? 'bundle arm has positive target lift with clean random/off-family controls' : 'bundle arm failed lift/safety controls'),
    reachArmPromotable ? 'reach arm is positive across seeds' : 'reach arm is not positive across seeds; do not promote reach-only',
    realQwen ? 'reranker gate used real Qwen scores' : 'CPU deterministic run is structural only; Qwen rank checks are not applicable',
  ],
};
const report = {
  schema: 'coretex.calibration.canonical-routing-policy-mini.v1',
  probe: 'canonical routing policy state/patch mini',
  targetSurface,
  generatedAt: new Date().toISOString(),
  ...provenance,
  commandArgs: process.argv.slice(2),
  reranker: { mode: rerankerArg, modelId: RR.modelId, revision: RR.revision },
  targetFamilies: TARGET_FAMS,
  offFamilies: OFF_FAMS,
  evidenceEdges: [...EVIDENCE_EDGES],
  seeds,
  actions: { reach: actionReach, bundle: actionBundle },
  audit: { enabled: auditLimit > 0, auditLimit },
  criteria: {
    pass: 'anchors-only no-op, target bundle lift > 0, primaryGoldDamage=0, offFamily mean >= -0.03, random target <= 0.005, patch applies structurally',
    patchAcceptanceNote: 'patchSmoke.accepted is an improvement/floor verdict; patchSmoke.applyStructurallyOk is the structural apply gate.',
  },
  verdict,
  passFailSummary: expectDisabled
    ? (summary.pass
      ? `PASS: ${targetSurface} PolicyAtom arms are disabled/inert under the supplied profile.`
      : `FAIL: ${targetSurface} PolicyAtom arms moved rankings despite disabled profile.`)
    : (summary.pass
      ? `PASS: ${targetSurface} bundle arm has target lift with clean random/off-family controls.`
      : `FAIL: ${targetSurface} did not satisfy target lift and safety controls.`),
  lowerLayerGateSummary: summary.lowerLayerGate,
  offFamilyDamageSummary: summary.offFamilyBundle_meanDelta,
  summary,
  perSeed,
};
mkdirSync(dirname(resolve(repoRoot, outPath)), { recursive: true });
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (typeof reranker.close === 'function') reranker.close();
