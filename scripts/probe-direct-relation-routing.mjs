#!/usr/bin/env node
/**
 * v15 direct relation-routing mini.
 *
 * This does NOT write evidence_bundle PolicyAtoms. It probes the scorer's direct
 * relation mechanisms:
 *   - Phase B category-lens BFS from stage-1 candidates by public edge type.
 *   - Phase A anchor-seeded corpus relation traversal by public edge type.
 *
 * The probe reports empty vs lensOnly vs anchorsOnly vs phaseAEdges vs combined,
 * with phaseA deltas both against empty and against anchorsOnly so anchor flood
 * cannot masquerade as relation traversal.
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
  scoringOptionsFromProfile,
  evaluateRetrievalBenchmarkState,
  createDeterministicReranker,
  stableRecordIdFor,
  encodeMemoryIndexSlot,
  encodeRelationEdge,
  encodeRelationCategoryLens,
  merkleizeState,
  applyPatch,
  PATCH_TYPE,
} = C;
const { RANGES } = await import(resolve(repoRoot, 'packages/cortex/dist/state/types.js'));

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-300k-v15-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-r5-synth-300k-v15-embeddings.json`);
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-calibration.json');
const bundlePath = flag('bundle');
if (!bundlePath) {
  console.error('HARD FAIL: --bundle <path> required');
  process.exit(1);
}
const rerankerArg = flag('reranker', 'deterministic');
const realQwen = rerankerArg === 'gpu' || rerankerArg === 'cpu';
const targetSurface = flag('target-surface', 'causal_decision_relation_routing');
const seeds = flag('seeds', '11,17,23').split(',').map(Number).filter(Number.isFinite);
const targetFamilies = flag('target-fams', 'causal_memory_chain,decision_provenance').split(',').map((s) => s.trim()).filter(Boolean);
const offFamilies = flag('off-fams', 'temporal_update,conflict_lifecycle,aspect_constraint,abstention_missing,coreference_resolution')
  .split(',').map((s) => s.trim()).filter((f) => f && !targetFamilies.includes(f));
const edgeTypes = flag('edge-types', 'causes,derived_from,supports').split(',').map((s) => s.trim()).filter(Boolean);
const targetPerFam = Number(flag('target-per-fam', '8'));
const offPerFam = Number(flag('off-per-fam', '4'));
const anchorLimit = Number(flag('anchor-limit', '64'));
const auditLimit = Number(flag('audit-limit', '12'));
const categoryLensBudget = Number(flag('category-lens-budget', '50'));
const categoryLensSeedTopK = Number(flag('category-lens-seed-topk', '2'));
const scopeRoutingAnchors = flag('scope-routing-anchors', 'off');
const scopeRoutingAnchorsToQuerySubject = ['subject', 'query-subject', 'true', '1'].includes(scopeRoutingAnchors);
const maxTargetJunkPerQuery = Number(flag('max-target-junk-per-query', '1'));
const evaluatedArms = new Set(flag('arms', 'lensOnly,anchorsOnly,phaseAEdges,combined,randomPhaseA')
  .split(',').map((s) => s.trim()).filter(Boolean));
const outPath = flag('out', `${base}/direct-relation-routing-v15-${rerankerArg}-current.json`);

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
  policyEntityRegistry: entityRegistry,
  policyGenericEntityIds: GENERIC,
  categoryLensExpansionBudget: categoryLensBudget,
  categoryLensSeedTopK,
  categoryLensFinalBonusWeight: 0,
  scopeRoutingAnchorsToQuerySubject,
};

const byFam = new Map();
for (const q of queryEvents) {
  const f = q.logicalFamily;
  if (!byFam.has(f)) byFam.set(f, []);
  byFam.get(f).push(q);
}
const eventById = new Map(corpus.events.map((e) => [e.id, e]));
const publicEvents = corpus.events.filter((e) => e.split !== 'eval_hidden');
const edgeSet = new Set(edgeTypes);

function rng(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0;
    return s / 4294967296;
  };
}
function sample(arr, n, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}
function bucket(f) {
  if (f === 'temporal_update' || f === 'temporal') return 'temporal';
  if (f === 'near_collision') return 'near_collision';
  if (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance' || f === 'conflict_lifecycle' || f === 'multi_hop_relation') return 'multi_hop_relation';
  return 'long_horizon';
}
function buildPack(seed) {
  const rand = rng(seed);
  const events = [];
  for (const f of targetFamilies) events.push(...sample(byFam.get(f) ?? [], targetPerFam, rand));
  for (const f of offFamilies) events.push(...sample(byFam.get(f) ?? [], offPerFam, rand));
  return events;
}
function anchorCandidates(packEvents) {
  const subjects = new Set();
  for (const q of packEvents) {
    if (!targetFamilies.includes(q.logicalFamily)) continue;
    if (q.subjectEntityId && !GENERIC.includes(q.subjectEntityId)) subjects.add(q.subjectEntityId);
  }
  const cands = [];
  for (const ev of publicEvents) {
    const subs = (ev.entityIds ?? []).filter((e) => subjects.has(e) && !GENERIC.includes(e));
    if (!subs.length) continue;
    const ets = [...new Set((ev.relations ?? []).map((r) => r.edgeType).filter((t) => edgeSet.has(t)))];
    if (!ets.length) continue;
    cands.push({ id: ev.id, subs, edgeTypes: ets });
  }
  const covered = new Set();
  const gain = (c) => c.subs.reduce((acc, s) => acc + c.edgeTypes.filter((e) => !covered.has(`${s}|${e}`)).length, 0);
  const anchors = [];
  const rem = [...cands];
  while (anchors.length < anchorLimit && rem.length) {
    rem.sort((a, b) => gain(b) - gain(a));
    const best = rem.shift();
    if (!best || gain(best) === 0) break;
    anchors.push(best);
    for (const s of best.subs) for (const e of best.edgeTypes) covered.add(`${s}|${e}`);
  }
  return { anchors, subjects: subjects.size, publicCandidates: cands.length };
}
function randomAnchors(count, seed) {
  const rand = rng(seed + 45491);
  const pool = publicEvents.filter((ev) => (ev.relations ?? []).some((r) => edgeSet.has(r.edgeType)));
  const picked = sample(pool, count, rand);
  return picked.map((ev) => ({
    id: ev.id,
    subs: (ev.entityIds ?? []).filter((e) => !GENERIC.includes(e)),
    edgeTypes: [...new Set((ev.relations ?? []).map((r) => r.edgeType).filter((t) => edgeSet.has(t)))],
  }));
}
function emptyState() {
  return { words: new Array(RANGES.WORD_COUNT).fill(0n) };
}
function writeAnchors(words, anchors) {
  let slot = 0;
  const slotEdges = [];
  for (const a of anchors) {
    const ev = eventById.get(a.id);
    if (!ev || slot >= Math.min(anchorLimit, 128)) continue;
    words[RANGES.MEMORY_INDEX_START + slot] = encodeMemoryIndexSlot({
      slotIndex: slot,
      recordId: stableRecordIdFor(ev.id),
      family: bucket(ev.logicalFamily ?? ev.family),
      domainBits: 1n,
      valid: true,
      revoked: false,
      protected: false,
      policyAnchor: false,
      retrievalSlot: 0,
      expiryEpoch: 0n,
    })[0];
    slotEdges.push({ slot, edgeTypes: a.edgeTypes });
    slot++;
  }
  return { anchorsWritten: slot, slotEdges };
}
function writeRelationEdges(words, slotEdges) {
  let entry = 0;
  for (const se of slotEdges) {
    for (const et of se.edgeTypes) {
      if (entry >= 96) return entry;
      words[RANGES.RELATIONS_START + entry] = encodeRelationEdge({
        entryIndex: entry,
        sourceSlot: se.slot,
        targetSlot: se.slot,
        edgeType: et,
        weight: 0x8000,
      });
      entry++;
    }
  }
  return entry;
}
function writeCategoryLenses(words) {
  let n = 0;
  for (const et of edgeTypes) {
    const entryIndex = 127 - n;
    if (entryIndex < 96) break;
    words[RANGES.RELATIONS_START + entryIndex] = encodeRelationCategoryLens({
      entryIndex,
      edgeType: et,
      weight: 0x8000,
    });
    n++;
  }
  return n;
}
function buildStates(anchors, seed) {
  const lensOnly = emptyState();
  const lensesWritten = writeCategoryLenses(lensOnly.words);

  const anchorsOnly = emptyState();
  const anchorInfo = writeAnchors(anchorsOnly.words, anchors);

  const phaseAEdges = { words: [...anchorsOnly.words] };
  const relationEdgesWritten = writeRelationEdges(phaseAEdges.words, anchorInfo.slotEdges);

  const combined = { words: [...phaseAEdges.words] };
  const combinedLensesWritten = writeCategoryLenses(combined.words);

  const randomPhaseA = emptyState();
  const randomInfo = writeAnchors(randomPhaseA.words, randomAnchors(anchorInfo.anchorsWritten, seed));
  const randomRelationEdgesWritten = writeRelationEdges(randomPhaseA.words, randomInfo.slotEdges);

  return {
    lensOnly,
    anchorsOnly,
    phaseAEdges,
    combined,
    randomPhaseA,
    meta: {
      anchorsWritten: anchorInfo.anchorsWritten,
      relationEdgesWritten,
      lensesWritten,
      combinedLensesWritten,
      randomAnchorsWritten: randomInfo.anchorsWritten,
      randomRelationEdgesWritten,
    },
  };
}
function patchSmoke() {
  const state = emptyState();
  const lens = encodeRelationCategoryLens({ entryIndex: 127, edgeType: edgeTypes[0] ?? 'supports', weight: 0x8000 });
  const patch = {
    patchType: PATCH_TYPE.RELATION_UPDATE,
    wordCount: 1,
    scoreDelta: 0n,
    parentStateRoot: merkleizeState(state),
    indices: [RANGES.RELATIONS_START + 127],
    newWords: [lens],
  };
  const res = applyPatch(state, patch, optsBase.policyAtomsMode === true);
  return { relationPatchApplies: res.ok, code: res.ok ? null : res.code };
}
function byId(sc) {
  return new Map(sc.perQuery.map((q) => [q.recordId, q]));
}
function rankOf(q) {
  return new Map((q.finalRankingTop20 ?? []).map((r) => [r.docId, r]));
}
function goldMetrics(qB, qC) {
  const B = rankOf(qB), Cc = rankOf(qC);
  const docs = new Set([...B.keys(), ...Cc.keys()]);
  const rels = [...docs].map((d) => B.get(d)?.relevance ?? Cc.get(d)?.relevance ?? 0);
  const maxRel = Math.max(0, ...rels);
  let goldRose = 0, goldMoved = 0, answerDamage = 0, primaryGoldDamage = 0, junkMoved = 0;
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
function bestAudit(q) {
  const ranking = (q.finalRankingFull && q.finalRankingFull.length) ? q.finalRankingFull : (q.finalRankingTop20 ?? []);
  let bestRelevantRank = Infinity, bestHardRank = Infinity, bestRelevantScore = null, bestHardScore = null;
  for (const [i, r] of ranking.entries()) {
    const rel = r.relevance ?? 0;
    const rank = r.rank ?? (i + 1);
    const score = typeof r.rerankerScore === 'number' ? r.rerankerScore : null;
    if (rel > 0) {
      if (rank < bestRelevantRank) bestRelevantRank = rank;
      if (score !== null && (bestRelevantScore === null || score > bestRelevantScore)) bestRelevantScore = score;
    } else {
      if (rank < bestHardRank) bestHardRank = rank;
      if (score !== null && (bestHardScore === null || score > bestHardScore)) bestHardScore = score;
    }
  }
  return {
    answerInCap: !!q.answerInCap,
    bestRelevantRank: Number.isFinite(bestRelevantRank) ? bestRelevantRank : null,
    bestHardNegativeRank: Number.isFinite(bestHardRank) ? bestHardRank : null,
    bestRelevantScore,
    bestHardNegativeScore: bestHardScore,
    goldOverHardByRank: Number.isFinite(bestRelevantRank) && Number.isFinite(bestHardRank) ? bestRelevantRank < bestHardRank : null,
    goldOverHardByScore: bestRelevantScore !== null && bestHardScore !== null ? bestRelevantScore > bestHardScore : null,
  };
}
function sourceMetrics(q, sourceTags) {
  const qrel = new Map((q.qrels ?? []).map((r) => [r.documentId, r.relevance]));
  let routedRelevantTop10 = 0, routedJunkTop10 = 0;
  for (const r of q.finalRankingTop20 ?? []) {
    if ((r.rank ?? 99) > 10) continue;
    const routed = (r.sources ?? []).some((s) => sourceTags.includes(s));
    if (!routed) continue;
    const rel = r.relevance ?? qrel.get(r.docId) ?? 0;
    if (rel > 0) routedRelevantTop10++;
    else routedJunkTop10++;
  }
  let routedRelevantInCap = 0, routedJunkInCap = 0;
  const ids = q.cappedDocIds ?? [];
  const srcs = q.cappedDocSources ?? [];
  for (let i = 0; i < ids.length; i++) {
    const routed = (srcs[i] ?? []).some((s) => sourceTags.includes(s));
    if (!routed) continue;
    const rel = qrel.get(ids[i]) ?? 0;
    if (rel > 0) routedRelevantInCap++;
    else routedJunkInCap++;
  }
  return { routedRelevantTop10, routedJunkTop10, routedRelevantInCap, routedJunkInCap };
}
function sliceStats(packEvents, baseM, armM, fams, sourceTags, compareM = null) {
  const ids = packEvents.filter((e) => fams.includes(e.logicalFamily)).map((e) => e.id);
  let n = 0, dsum = 0, dsumCompare = 0, recoveredInCap = 0, answerInCapBefore = 0, answerInCapAfter = 0;
  let goldRose = 0, goldMoved = 0, answerDamage = 0, primaryGoldDamage = 0, junkMoved = 0;
  let routedRelevantTop10 = 0, routedJunkTop10 = 0, routedRelevantInCap = 0, routedJunkInCap = 0;
  let rankEligible = 0, rankWins = 0, scoreEligible = 0, scoreWins = 0;
  for (const id of ids) {
    const qb = baseM.get(id), qa = armM.get(id);
    if (!qb || !qa) continue;
    n++;
    dsum += qa.nDCG10 - qb.nDCG10;
    if (compareM?.get(id)) dsumCompare += qa.nDCG10 - compareM.get(id).nDCG10;
    if (qb.answerInCap) answerInCapBefore++;
    if (qa.answerInCap) answerInCapAfter++;
    if (!qb.answerInCap && qa.answerInCap) recoveredInCap++;
    const gm = goldMetrics(qb, qa);
    goldRose += gm.goldRose;
    goldMoved += gm.goldMoved;
    answerDamage += gm.answerDamage;
    primaryGoldDamage += gm.primaryGoldDamage;
    junkMoved += gm.junkMoved;
    const sm = sourceMetrics(qa, sourceTags);
    routedRelevantTop10 += sm.routedRelevantTop10;
    routedJunkTop10 += sm.routedJunkTop10;
    routedRelevantInCap += sm.routedRelevantInCap;
    routedJunkInCap += sm.routedJunkInCap;
    if (realQwen) {
      const au = bestAudit(qa);
      if (au.goldOverHardByRank !== null) {
        rankEligible++;
        if (au.goldOverHardByRank) rankWins++;
      }
      if (au.goldOverHardByScore !== null) {
        scoreEligible++;
        if (au.goldOverHardByScore) scoreWins++;
      }
    }
  }
  return {
    n,
    meanDeltaNdcg: n ? +(dsum / n).toFixed(4) : 0,
    meanDeltaVsCompare: compareM && n ? +(dsumCompare / n).toFixed(4) : null,
    answerInCapBefore,
    answerInCapAfter,
    recoveredInCap,
    goldRose,
    goldMoved,
    answerDamage,
    primaryGoldDamage,
    junkMoved,
    routedRelevantTop10,
    routedJunkTop10,
    routedRelevantInCap,
    routedJunkInCap,
    qwenRankCheck: realQwen ? 'real_qwen' : 'not_applicable_deterministic_reranker',
    qwenGoldOverHardByRankRate: realQwen && rankEligible ? +(rankWins / rankEligible).toFixed(4) : null,
    qwenGoldOverHardByScoreRate: realQwen && scoreEligible ? +(scoreWins / scoreEligible).toFixed(4) : null,
  };
}
function unevaluatedStats(packEvents, fams, qwenRankCheck) {
  return {
    n: packEvents.filter((e) => fams.includes(e.logicalFamily)).length,
    meanDeltaNdcg: 0,
    meanDeltaVsCompare: null,
    answerInCapBefore: 0,
    answerInCapAfter: 0,
    recoveredInCap: 0,
    goldRose: 0,
    goldMoved: 0,
    answerDamage: 0,
    primaryGoldDamage: 0,
    junkMoved: 0,
    routedRelevantTop10: 0,
    routedJunkTop10: 0,
    routedRelevantInCap: 0,
    routedJunkInCap: 0,
    qwenRankCheck,
    qwenGoldOverHardByRankRate: null,
    qwenGoldOverHardByScoreRate: null,
    evaluated: false,
  };
}
function auditRows(packEvents, baseM, armM, sourceTags) {
  return packEvents.filter((e) => targetFamilies.includes(e.logicalFamily)).slice(0, auditLimit).map((e) => {
    const qb = baseM.get(e.id);
    const qa = armM.get(e.id);
    return {
      id: e.id,
      family: e.logicalFamily,
      subjectEntityId: e.subjectEntityId ?? null,
      deltaNdcg10: qb && qa ? +(qa.nDCG10 - qb.nDCG10).toFixed(4) : null,
      before: qb ? bestAudit(qb) : null,
      after: qa ? bestAudit(qa) : null,
      sourceMetrics: qa ? sourceMetrics(qa, sourceTags) : null,
    };
  });
}
const agg = (perSeed, sel) => {
  const vals = perSeed.map(sel);
  return { mean: +(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)).toFixed(4), min: +Math.min(...vals).toFixed(4), max: +Math.max(...vals).toFixed(4), perSeed: vals };
};

const eligible = Object.fromEntries([...targetFamilies, ...offFamilies].map((f) => [f, (byFam.get(f) ?? []).length]));
const perSeed = [];
const structuralPatchSmoke = patchSmoke();
for (const seed of seeds) {
  const packEvents = buildPack(seed);
  const pack = { events: packEvents, corpusRoot: corpus.corpusRoot, epochId: seed, evalSeedHex: '0x' + seed.toString(16).padStart(64, '0') };
  const { anchors, subjects, publicCandidates } = anchorCandidates(packEvents);
  const states = buildStates(anchors, seed);
  const B = await evaluateRetrievalBenchmarkState(emptyState(), corpus, pack, optsBase);
  const L = evaluatedArms.has('lensOnly') ? await evaluateRetrievalBenchmarkState(states.lensOnly, corpus, pack, optsBase) : null;
  const A = evaluatedArms.has('anchorsOnly') || evaluatedArms.has('phaseAEdges') || evaluatedArms.has('combined')
    ? await evaluateRetrievalBenchmarkState(states.anchorsOnly, corpus, pack, optsBase) : null;
  const P = evaluatedArms.has('phaseAEdges') ? await evaluateRetrievalBenchmarkState(states.phaseAEdges, corpus, pack, optsBase) : null;
  const Cb = evaluatedArms.has('combined') ? await evaluateRetrievalBenchmarkState(states.combined, corpus, pack, optsBase) : null;
  const R = evaluatedArms.has('randomPhaseA') ? await evaluateRetrievalBenchmarkState(states.randomPhaseA, corpus, pack, optsBase) : null;
  const bM = byId(B), lM = L ? byId(L) : null, aM = A ? byId(A) : null, pM = P ? byId(P) : null, cM = Cb ? byId(Cb) : null, rM = R ? byId(R) : null;
  const qwenRankCheck = realQwen ? 'real_qwen' : 'not_applicable_deterministic_reranker';
  const targetLens = lM ? sliceStats(packEvents, bM, lM, targetFamilies, ['categoryLensBFS']) : unevaluatedStats(packEvents, targetFamilies, qwenRankCheck);
  const offLens = lM ? sliceStats(packEvents, bM, lM, offFamilies, ['categoryLensBFS']) : unevaluatedStats(packEvents, offFamilies, qwenRankCheck);
  const targetAnchors = aM ? sliceStats(packEvents, bM, aM, targetFamilies, ['anchorMandatory']) : unevaluatedStats(packEvents, targetFamilies, qwenRankCheck);
  const offAnchors = aM ? sliceStats(packEvents, bM, aM, offFamilies, ['anchorMandatory']) : unevaluatedStats(packEvents, offFamilies, qwenRankCheck);
  const targetPhaseA = pM ? sliceStats(packEvents, bM, pM, targetFamilies, ['anchorBFS'], aM) : unevaluatedStats(packEvents, targetFamilies, qwenRankCheck);
  const offPhaseA = pM ? sliceStats(packEvents, bM, pM, offFamilies, ['anchorBFS'], aM) : unevaluatedStats(packEvents, offFamilies, qwenRankCheck);
  const targetCombined = cM ? sliceStats(packEvents, bM, cM, targetFamilies, ['anchorBFS', 'categoryLensBFS'], aM) : unevaluatedStats(packEvents, targetFamilies, qwenRankCheck);
  const offCombined = cM ? sliceStats(packEvents, bM, cM, offFamilies, ['anchorBFS', 'categoryLensBFS'], aM) : unevaluatedStats(packEvents, offFamilies, qwenRankCheck);
  const randomTarget = rM ? sliceStats(packEvents, bM, rM, targetFamilies, ['anchorBFS']) : unevaluatedStats(packEvents, targetFamilies, qwenRankCheck);
  perSeed.push({
    seed,
    packSize: packEvents.length,
    packFamilyCounts: Object.fromEntries([...new Set(packEvents.map((e) => e.logicalFamily))].map((f) => [f, packEvents.filter((e) => e.logicalFamily === f).length])),
    subjects,
    publicAnchorCandidates: publicCandidates,
    anchors: anchors.length,
    stateMeta: states.meta,
    arms_overall_nDCG10: {
      B_empty: +B.nDCG10.toFixed(4),
      lensOnly: L ? +L.nDCG10.toFixed(4) : null,
      anchorsOnly: A ? +A.nDCG10.toFixed(4) : null,
      phaseAEdges: P ? +P.nDCG10.toFixed(4) : null,
      combined: Cb ? +Cb.nDCG10.toFixed(4) : null,
      randomPhaseA: R ? +R.nDCG10.toFixed(4) : null,
    },
    targetLens,
    offLens,
    targetAnchors,
    offAnchors,
    targetPhaseA,
    offPhaseA,
    targetCombined,
    offCombined,
    randomTarget,
    targetAudit: auditRows(packEvents, bM, cM ?? lM ?? bM, cM ? ['anchorBFS', 'categoryLensBFS'] : ['categoryLensBFS']),
  });
  console.error(`[direct-rel] seed=${seed} pack=${packEvents.length} anchors=${anchors.length} lensΔ=${targetLens.meanDeltaNdcg} phaseAΔ=${targetPhaseA.meanDeltaNdcg} phaseA-vs-anchor=${targetPhaseA.meanDeltaVsCompare} combinedΔ=${targetCombined.meanDeltaNdcg} off=${offCombined.meanDeltaNdcg} random=${randomTarget.meanDeltaNdcg}`);
}

const summary = {
  targetLens_meanDelta: agg(perSeed, (s) => s.targetLens.meanDeltaNdcg),
  offLens_meanDelta: agg(perSeed, (s) => s.offLens.meanDeltaNdcg),
  targetAnchors_meanDelta: agg(perSeed, (s) => s.targetAnchors.meanDeltaNdcg),
  offAnchors_meanDelta: agg(perSeed, (s) => s.offAnchors.meanDeltaNdcg),
  targetPhaseA_meanDelta: agg(perSeed, (s) => s.targetPhaseA.meanDeltaNdcg),
  targetPhaseA_vsAnchors_meanDelta: agg(perSeed, (s) => s.targetPhaseA.meanDeltaVsCompare ?? 0),
  offPhaseA_meanDelta: agg(perSeed, (s) => s.offPhaseA.meanDeltaNdcg),
  targetCombined_meanDelta: agg(perSeed, (s) => s.targetCombined.meanDeltaNdcg),
  offCombined_meanDelta: agg(perSeed, (s) => s.offCombined.meanDeltaNdcg),
  randomTarget_meanDelta: agg(perSeed, (s) => s.randomTarget.meanDeltaNdcg),
  lensPrimaryGoldDamage: perSeed.reduce((a, s) => a + s.targetLens.primaryGoldDamage, 0),
  lensAnswerDamage: perSeed.reduce((a, s) => a + s.targetLens.answerDamage, 0),
  lensJunkMoved: perSeed.reduce((a, s) => a + s.targetLens.junkMoved, 0),
  phaseAPrimaryGoldDamage: perSeed.reduce((a, s) => a + s.targetPhaseA.primaryGoldDamage, 0),
  phaseAAnswerDamage: perSeed.reduce((a, s) => a + s.targetPhaseA.answerDamage, 0),
  phaseAJunkMoved: perSeed.reduce((a, s) => a + s.targetPhaseA.junkMoved, 0),
  combinedPrimaryGoldDamage: perSeed.reduce((a, s) => a + s.targetCombined.primaryGoldDamage, 0),
  combinedAnswerDamage: perSeed.reduce((a, s) => a + s.targetCombined.answerDamage, 0),
  combinedJunkMoved: perSeed.reduce((a, s) => a + s.targetCombined.junkMoved, 0),
  lowerLayerGate: {
    eligible,
    allSeedsHaveTargetPack: perSeed.every((s) => targetFamilies.every((f) => (s.packFamilyCounts[f] ?? 0) > 0)),
    allSeedsHavePublicAnchorCandidates: perSeed.every((s) => s.publicAnchorCandidates > 0),
    allSeedsHaveAnchors: perSeed.every((s) => s.anchors > 0),
    allSeedsHaveRelationEdges: perSeed.every((s) => s.stateMeta.relationEdgesWritten > 0),
    allSeedsHaveCategoryLenses: perSeed.every((s) => s.stateMeta.lensesWritten > 0),
    patchStructuralOk: structuralPatchSmoke.relationPatchApplies,
    qwenRankCheck: realQwen ? 'real_qwen' : 'not_applicable_deterministic_reranker',
  },
};
summary.armPass = {
  lensOnly: evaluatedArms.has('lensOnly') && perSeed.every((s) =>
    s.targetLens.meanDeltaNdcg > 0 &&
    s.targetLens.primaryGoldDamage === 0 &&
    s.targetLens.answerDamage === 0 &&
    s.targetLens.junkMoved <= maxTargetJunkPerQuery * Math.max(1, s.targetLens.n) &&
    s.offLens.meanDeltaNdcg >= -0.03 &&
    structuralPatchSmoke.relationPatchApplies),
  phaseAEdges: evaluatedArms.has('phaseAEdges') && perSeed.every((s) =>
    (s.targetPhaseA.meanDeltaVsCompare ?? 0) > 0 &&
    s.targetPhaseA.primaryGoldDamage === 0 &&
    s.targetPhaseA.junkMoved <= maxTargetJunkPerQuery * Math.max(1, s.targetPhaseA.n) &&
    s.offPhaseA.meanDeltaNdcg >= -0.03 &&
    s.randomTarget.meanDeltaNdcg <= 0.005 &&
    structuralPatchSmoke.relationPatchApplies),
  combined: evaluatedArms.has('combined') && perSeed.every((s) =>
    s.targetCombined.meanDeltaNdcg > 0 &&
    (!evaluatedArms.has('lensOnly') || s.targetCombined.meanDeltaNdcg > s.targetLens.meanDeltaNdcg + 1e-9) &&
    s.targetCombined.primaryGoldDamage === 0 &&
    s.targetCombined.junkMoved <= maxTargetJunkPerQuery * Math.max(1, s.targetCombined.n) &&
    s.offCombined.meanDeltaNdcg >= -0.03 &&
    s.randomTarget.meanDeltaNdcg <= 0.005 &&
    structuralPatchSmoke.relationPatchApplies),
};
summary.pass = summary.armPass.lensOnly || summary.armPass.phaseAEdges || summary.armPass.combined;
const verdict = {
  pass: summary.pass,
  promote: Object.entries(summary.armPass).filter(([, ok]) => ok).map(([arm]) => arm),
  doNotPromote: Object.entries(summary.armPass).filter(([arm, ok]) => evaluatedArms.has(arm) && !ok).map(([arm]) => arm),
  notEvaluated: Object.keys(summary.armPass).filter((arm) => !evaluatedArms.has(arm)),
  needsFollowup: summary.pass && !realQwen ? ['real_qwen_confirmation'] : (!summary.pass ? ['selector_or_knob_redesign'] : []),
  reasons: [
    summary.pass ? 'at least one direct relation routing arm has positive target lift with clean safety controls' : 'all direct relation routing arms failed target lift and/or safety controls',
    `lensOnly mean=${summary.targetLens_meanDelta.mean} off=${summary.offLens_meanDelta.mean}`,
    `phaseA-vs-anchors mean=${summary.targetPhaseA_vsAnchors_meanDelta.mean}`,
    `combined requires incremental lift over lensOnly when lensOnly is evaluated`,
    `target junk cap=${maxTargetJunkPerQuery}/query`,
    realQwen ? 'reranker gate used real Qwen scores' : 'CPU deterministic run is structural/lower-layer only; Qwen rank checks are not applicable',
  ],
};

const report = {
  schema: 'coretex.calibration.direct-relation-routing-mini.v1',
  probe: 'direct relation routing state mini',
  targetSurface,
  generatedAt: new Date().toISOString(),
  ...provenance,
  commandArgs: process.argv.slice(2),
  reranker: { mode: rerankerArg, modelId: RR.modelId, revision: RR.revision },
  targetFamilies,
  offFamilies,
  edgeTypes,
  seeds,
  knobs: { targetPerFam, offPerFam, anchorLimit, categoryLensBudget, categoryLensSeedTopK, scopeRoutingAnchors, maxTargetJunkPerQuery, evaluatedArms: [...evaluatedArms], auditLimit },
  structuralPatchSmoke,
  verdict,
  passFailSummary: summary.pass
    ? `PASS: ${targetSurface} lensOnly is positive and clean; combined is not separately promoted unless it adds incremental lift over lensOnly.`
    : `FAIL: ${targetSurface} direct relation routing shape is not promotable.`,
  lowerLayerGateSummary: summary.lowerLayerGate,
  offFamilyDamageSummary: summary.offCombined_meanDelta,
  summary,
  perSeed,
};
mkdirSync(dirname(resolve(repoRoot, outPath)), { recursive: true });
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (typeof reranker.close === 'function') reranker.close();
