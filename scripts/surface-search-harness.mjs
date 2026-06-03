#!/usr/bin/env node
/**
 * Surface-search harness v2 — explicit oracle-qrel vs miner-public modes, full
 * per-candidate metric set, dense-pack support, top-K compositor.
 *
 * Per the auditor:
 *   - Mode A (oracle-qrel) bounds capability; CANNOT feed promotion claims.
 *   - Mode B (miner-public) uses only public structure; the only mode whose
 *     CLEAN_POSITIVE / TRADEOFF_POSITIVE / COMPENSATED_POSITIVE results can
 *     feed launch evidence — and even then only after A100 confirmation.
 *
 * Reports the FULL metric set per candidate (not just composite):
 *   compositeDeltaPpm, retrievalDeltaPpm, targetFamilyDeltaNdcg,
 *   offFamilyMeanDeltaNdcg, offFamilyWorstDeltaNdcg, stableHeldoutDeltaPpm,
 *   worstStableHeldoutRegressions, junkMoved, goldDamage, qwenRankMovement,
 *   policyTraceFired.
 *
 * Combinations test top-K candidates per surface per class, NOT the first
 * candidate per surface. The combination classifier labels each pair as
 * PASS_THROUGH / SUPER_ADDITIVE / COMPENSATED_POSITIVE / UNSAFE_COMBINATION /
 * NO_SIGNAL.
 *
 * Dense-pack mode (--packs balanced,coref-dense,aspect-dense,...) sweeps
 * each surface against each requested pack via the DENSE_PACKS quota
 * overrides defined in scripts/lib/surface-grammars.mjs.
 *
 * Usage:
 *   # CPU shortlist sweep on all packs:
 *   node scripts/surface-search-harness.mjs \
 *     --packs balanced,coref-dense,aspect-dense,abstention-dense,lifecycle-dense,relation-dense \
 *     --pack-seeds coretex-launch-frontier,coretex-search-2,coretex-search-3 \
 *     --modes oracle-qrel,miner-public \
 *     --out release/calibration/2026-05-21-memory-corpus-v2/surface-search-cpu-v2-2d953b71.json
 *
 *   # A100 confirmation on the shortlist:
 *   node scripts/surface-search-harness.mjs --reranker gpu \
 *     --packs balanced,coref-dense,aspect-dense,lifecycle-dense \
 *     --candidates <id1,id2,...> \
 *     --out release/calibration/2026-05-21-memory-corpus-v2/surface-search-gpu-shortlist-v2-2d953b71.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';
import { SURFACE_GRAMMARS, listAllCandidates, SEMANTIC_COMBINATIONS, DENSE_PACKS } from './lib/surface-grammars.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const BUNDLE_PATH = flag('bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-launch-reduced.json');
const PROFILE_PATH = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-launch-reduced.json');
const CORPUS_PATH = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-corpus.json');
const EMB_PATH = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-embeddings.json');
const PACK_SEEDS = flag('pack-seeds', 'coretex-launch-frontier,coretex-search-2,coretex-search-3').split(',').map((s) => s.trim()).filter(Boolean);
const PACK_NAMES = flag('packs', 'balanced').split(',').map((s) => s.trim()).filter(Boolean);
const RERANKER = flag('reranker', 'deterministic');
const OUT = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/surface-search-v2-cpu-2d953b71.json');
const SURFACES_FILTER = flag('surfaces', null);
const CANDIDATES_FILTER = flag('candidates', null);
const MODES_FILTER = flag('modes', 'oracle-qrel,miner-public').split(',').map((s) => s.trim());
const SKIP_COMBINATIONS = has('skip-combinations');
const TOP_K = Number(flag('top-k', '2'));

const GATE = {
  CLEAN_MIN_COMPOSITE_PPM:    500,
  TRADEOFF_OFF_FAMILY_FLOOR:  -0.03,
  UNSAFE_OFF_FAMILY_FLOOR:    -0.10,
  UNSAFE_HELDOUT_REGRESSIONS: 3,
  COMPENSATED_BEATS_BEST_BY:  500,
  JUNK_MOVED_HARD_FLOOR:      20,
};

console.log('[surface-search v2] loading materialized base corpus ...');
const C = await import(distIndex);
const {
  scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState,
  applyPatch, decodeSubstrate,
  createDeterministicReranker, biEncoderModelIdHash,
  PATCH_TYPE, merkleizeState, RANGES,
} = C;

const baseBundle = loadMaterializedCorpus(BUNDLE_PATH, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH });
const currentProd = baseBundle.corpus;
const { BE, RR, LAYOUT } = baseBundle;
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, CORPUS_PATH), 'utf8'));
const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
const logicalQById = new Map(rawCorpus.queries.map((q) => [q.id, q]));
const eventByDocId = new Map(); for (const ev of currentProd.events) eventByDocId.set(ev.id, ev);
const docById = new Map(rawCorpus.docs.map((d) => [d.id, d]));
console.log(`[surface-search v2] bundle ${baseBundle.manifest.bundleHash} corpus ${currentProd.events.length} events`);

const reranker = RERANKER === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
const rt = () => ({ biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
const policyEntityRegistry = (rawCorpus.entities ?? []).map((e) => ({ id: e.id, names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()) }));
const baseScoringOpts = () => ({ ...scoringOptionsFromProfile(profile, rt()), policyEntityRegistry, policyGenericEntityIds: ['e_universe'], exposeFullRanking: true, policyEmitTraces: true });

// Derive (packName × seed) packs once.
const packs = [];
for (const name of PACK_NAMES) {
  const cfg = DENSE_PACKS[name];
  if (!cfg) { console.error(`[surface-search v2] unknown pack ${name}; available: ${Object.keys(DENSE_PACKS).join(',')}`); process.exit(1); }
  const quotas = cfg.quotas ?? (profile.hiddenPack?.quotas ?? []);
  const packProfile = { ...(profile.hiddenPack ?? {}), packSize: cfg.packSize, quotas };
  for (const seed of PACK_SEEDS) {
    const evalSeedHex = '0x' + createHash('sha256').update(seed).digest('hex');
    try {
      const pack = deriveQueryPack(0, evalSeedHex, currentProd, packProfile);
      packs.push({ name, seed, pack });
    } catch (e) {
      console.log(`  pack=${name} seed=${seed}: derive failed (${e.message?.slice(0,80)}); skipping`);
    }
  }
}
for (const p of packs) {
  const fams = {};
  for (const ev of p.pack.events) { const f = ev.family ?? 'unknown'; fams[f] = (fams[f] ?? 0) + 1; }
  console.log(`  pack=${p.name} seed=${p.seed} → ${p.pack.events.length} events; families=${JSON.stringify(fams)}`);
}

const genesisState = { words: new Array(1024).fill(0n) };
const GENESIS_PARENT_ROOT = merkleizeState(genesisState);

function makeSlotCursor() { return { temporalRecord: 0, conflictSlot: 0, abstentionSlot: 0, evidenceSlot: 0, noiseSlot: 0, aspectSlot: 0 }; }

// Per-surface slot-namespace offsets so a composer pair never collides on the
// same word index. Arm A uses the default cursor (zeros). Arm B starts at the
// offsets below — large enough to clear any reasonable arm A patch.
//
// MemoryIndex layout (352 slots total):
//   temporal arm: slots 0..191  (recordSlot 0..95 maps to 2N, 2N+1)
//   conflict arm: slots 192..223
//   evidence/noise: slots 224..255 (also targetSlot for evidence_bundle atom)
//   aspect arm:   slots 256..287
//
// Policy regions are family-scoped, but the atomIndex must not collide either:
//   conflict atom: POLICY_CONFLICT_START + conflictSlot (0..127)
//   evidence/noise atom: POLICY_EVIDENCE_START + evidenceSlot/noiseSlot (0..127)
//   abstention atom: POLICY_ABSTENTION_START + abstentionSlot (0..31)
//
// We shift arm B's cursor for whichever family it writes to. The compositor below
// applies the shift only when the corresponding cursor field is read by arm B.
function compositorArmBOffsets() {
  return {
    temporalRecord: 16,  // arm A uses recordSlot 0..15 max; arm B starts at 16
    conflictSlot:   32,  // POLICY_CONFLICT + 32 and MemoryIndex 192+32=224 (within 0..255 anchor cap)
    evidenceSlot:   16,  // POLICY_EVIDENCE + 16, MemoryIndex 224+16=240
    noiseSlot:      24,
    aspectSlot:     40,
    abstentionSlot: 4,   // POLICY_ABSTENTION + 4 (32-slot region)
  };
}

function perFamilyMean(perQuery) {
  const buckets = new Map();
  for (const q of (perQuery ?? [])) {
    const fam = q.family ?? q.logicalFamily ?? 'unknown';
    if (!buckets.has(fam)) buckets.set(fam, []);
    buckets.get(fam).push(q.nDCG10);
  }
  const out = {};
  for (const [fam, vals] of buckets) out[fam] = +(vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length)).toFixed(6);
  return out;
}

function targetFamiliesOf(candidate) {
  const map = {
    temporal_update: ['temporal_update', 'temporal'],
    conflict_lifecycle: ['conflict_lifecycle', 'conflict'],
    relation_causal: ['multi_session_bridge', 'causal_memory_chain', 'decision_provenance', 'multi_hop_relation'],
    relation_lifecycle: ['multi_session_bridge', 'causal_memory_chain', 'decision_provenance', 'multi_hop_relation'],
    coreference: ['coreference_resolution', 'coreference'],
    aspect_constraint: ['aspect_constraint'],
    evidence_bundle: ['multi_session_bridge', 'causal_memory_chain', 'decision_provenance'],
    abstention_top1: ['abstention_missing'],
    noise_suppression: [],
  };
  return new Set(map[candidate.surface] ?? []);
}

function classifyPerPack(candidate, before, after) {
  // compositeDeltaPpm
  const compositeDeltaPpm = Math.round(((after.composite ?? 0) - (before.composite ?? 0)) * 1_000_000);
  const retrievalDeltaPpm = Math.round(((after.retrievalCompositeScore ?? after.composite ?? 0) - (before.retrievalCompositeScore ?? before.composite ?? 0)) * 1_000_000);
  // Per-family
  const beforeFams = perFamilyMean(before.perQuery);
  const afterFams = perFamilyMean(after.perQuery);
  const targetFams = targetFamiliesOf(candidate);
  const targetMeansBefore = [...targetFams].map((f) => beforeFams[f]).filter((v) => typeof v === 'number');
  const targetMeansAfter  = [...targetFams].map((f) => afterFams[f]).filter((v) => typeof v === 'number');
  const tb = targetMeansBefore.length ? targetMeansBefore.reduce((s, v) => s + v, 0) / targetMeansBefore.length : null;
  const ta = targetMeansAfter.length  ? targetMeansAfter.reduce((s, v) => s + v, 0)  / targetMeansAfter.length  : null;
  const targetFamilyDeltaNdcg = (tb != null && ta != null) ? +(ta - tb).toFixed(6) : null;
  const offFamsBefore = Object.entries(beforeFams).filter(([k]) => !targetFams.has(k));
  const offFamsAfter  = Object.entries(afterFams).filter(([k]) => !targetFams.has(k));
  const offFamDeltas = offFamsAfter.map(([k, v]) => v - (beforeFams[k] ?? 0));
  const offFamilyMeanDeltaNdcg  = offFamDeltas.length ? +(offFamDeltas.reduce((s, v) => s + v, 0) / offFamDeltas.length).toFixed(6) : 0;
  const offFamilyWorstDeltaNdcg = offFamDeltas.length ? +Math.min(...offFamDeltas).toFixed(6) : 0;
  // junkMoved + goldDamage: PATCH-INDUCED deltas, not absolute counts
  const beforeQ = new Map((before.perQuery ?? []).map((q) => [q.recordId, q]));
  let junkMoved = 0, goldDamage = 0, qwenRankMovement = 0, anyTraceFired = false;
  for (const qa of (after.perQuery ?? [])) {
    const qb = beforeQ.get(qa.recordId);
    if (!qb) continue;
    const topAft = (qa.finalRankingTop20 ?? []).slice(0, 10);
    const topBef = (qb.finalRankingTop20 ?? []).slice(0, 10);
    const beforeIds = new Set(topBef.map((r) => r.docId));
    const afterIds  = new Set(topAft.map((r) => r.docId));
    // junkMoved = junk docs that ARRIVED in top-K under the patch (NOT already there)
    for (const r of topAft) if (r.relevance === 0 && !beforeIds.has(r.docId)) junkMoved++;
    // goldDamage = gold docs that LEFT top-K under the patch
    for (const r of topBef) if (r.relevance > 0 && !afterIds.has(r.docId)) goldDamage++;
    // qwenRankMovement = gold docs whose rank got WORSE under the patch
    for (const r of topBef) if (r.relevance > 0) {
      const ra = topAft.find((x) => x.docId === r.docId);
      if (ra && ra.rank > r.rank) qwenRankMovement++;
    }
    if ((qa.policyTraces ?? []).length > 0) anyTraceFired = true;
  }
  return { compositeDeltaPpm, retrievalDeltaPpm, targetFamilyDeltaNdcg, offFamilyMeanDeltaNdcg, offFamilyWorstDeltaNdcg, junkMoved, goldDamage, qwenRankMovement, policyTraceFired: anyTraceFired, beforeFamilyMeans: beforeFams, afterFamilyMeans: afterFams };
}

function aggregateClassification(candidate, perPack) {
  if (perPack.length === 0) return { label: 'SKIP', reason: 'no_pack_results' };
  const meanOf = (k) => +(perPack.reduce((s, p) => s + (p[k] ?? 0), 0) / perPack.length).toFixed(2);
  const meanComposite = Math.round(meanOf('compositeDeltaPpm'));
  const meanTargetNdcg = perPack.every((p) => p.targetFamilyDeltaNdcg == null) ? null : +(perPack.reduce((s, p) => s + (p.targetFamilyDeltaNdcg ?? 0), 0) / perPack.length).toFixed(6);
  const meanOffFamMean = +(perPack.reduce((s, p) => s + (p.offFamilyMeanDeltaNdcg ?? 0), 0) / perPack.length).toFixed(6);
  const meanOffFamWorst = +(Math.min(...perPack.map((p) => p.offFamilyWorstDeltaNdcg ?? 0))).toFixed(6);
  const sumJunk = perPack.reduce((s, p) => s + (p.junkMoved ?? 0), 0);
  const sumGold = perPack.reduce((s, p) => s + (p.goldDamage ?? 0), 0);
  const anyTrace = perPack.some((p) => p.policyTraceFired);
  // Classifier
  //
  // junkMoved alone is NOT unsafe — see SURFACE_SEARCH_HARNESS_REPORT_V2_CORRECTION.md
  // §2 (relation_causal). The substrate is genuinely admitting plausible docs into
  // top-K; if those don't displace gold and don't drag off-family worst, the composite
  // lift is real and the patch is safe. Require junk-flood AND damage-evidence
  // (goldDamage > 0 OR offFamilyWorst <= -0.05) to trigger UNSAFE on junk alone.
  let label = 'NO_MOVEMENT', reason = `composite ${meanComposite} within noise`;
  const junkFloodWithDamage = sumJunk > GATE.JUNK_MOVED_HARD_FLOOR && (sumGold > 0 || meanOffFamWorst <= -0.05);
  if (meanOffFamWorst <= GATE.UNSAFE_OFF_FAMILY_FLOOR || sumGold > 0 || junkFloodWithDamage) {
    label = 'UNSAFE';
    reason = `offFamWorst ${meanOffFamWorst} | goldDamage ${sumGold} | junkMoved ${sumJunk} | junkFloodWithDamage ${junkFloodWithDamage}`;
  } else if (meanComposite >= GATE.CLEAN_MIN_COMPOSITE_PPM && meanOffFamMean > -0.005) {
    label = (anyTrace || candidate.surface === 'noise_suppression' || candidate.surface === 'abstention_top1') ? 'CLEAN_POSITIVE' : 'UNEXPLAINED_POSITIVE';
    reason = `composite +${meanComposite} ppm, offFamilyMean ${meanOffFamMean}, trace=${anyTrace}`;
  } else if (meanComposite >= GATE.CLEAN_MIN_COMPOSITE_PPM && meanOffFamMean <= -0.005 && meanOffFamWorst > GATE.UNSAFE_OFF_FAMILY_FLOOR) {
    label = 'TRADEOFF_POSITIVE';
    reason = `composite +${meanComposite} but offFamMean ${meanOffFamMean}; compensable?`;
  } else if (meanComposite < -GATE.CLEAN_MIN_COMPOSITE_PPM) {
    label = 'UNSAFE';
    reason = `composite ${meanComposite}`;
  }
  return { label, reason, meanCompositeDeltaPpm: meanComposite, meanTargetFamilyDeltaNdcg: meanTargetNdcg, meanOffFamilyMeanDeltaNdcg: meanOffFamMean, meanOffFamilyWorstDeltaNdcg: meanOffFamWorst, sumJunkMoved: sumJunk, sumGoldDamage: sumGold, anyTraceFired: anyTrace };
}

async function runOneCandidate(candidate) {
  const slotCursor = makeSlotCursor();
  const perPack = [];
  let buildReason = null;
  for (const { name, seed, pack } of packs) {
    const ctx = { pack, logicalQById, eventByDocId, docById, slotCursor, entityRegistry: policyEntityRegistry, genericEntityIds: ['e_universe'], rawDocs: rawCorpus.docs, rawRelations: rawCorpus.relations };
    let finalState = genesisState;
    let applyOk = true, applyReason = null;
    // Candidate can return a single units block OR a `subPatches` array for sequential
    // application — sequential is the only legal path for >4-word total because the
    // canonical patch budget hard-caps each STATE_ADVANCE patch at 4 words.
    const u = candidate.buildUnits(ctx);
    const subPatches = u.subPatches ?? (u.indices?.length ? [{ indices: u.indices, newWords: u.newWords }] : []);
    if (subPatches.length === 0) { perPack.push({ packName: name, seed, skipped: true, reason: u.reason ?? 'no_units' }); continue; }
    for (const sp of subPatches) {
      if (sp.indices.length === 0) continue;
      const patch = { patchType: PATCH_TYPE.MIXED, wordCount: sp.indices.length, scoreDelta: 0, parentStateRoot: merkleizeState(finalState), indices: sp.indices, newWords: sp.newWords };
      const allPolicy = sp.indices.every((i) => i >= RANGES.POLICY_EVIDENCE_START && i <= RANGES.POLICY_ABSTENTION_END);
      if (allPolicy) patch.patchType = PATCH_TYPE.POLICY_UPDATE;
      const applied = applyPatch(finalState, patch, true);
      if (!applied.ok) { applyOk = false; applyReason = `apply_failed:${applied.code}`; break; }
      finalState = applied.state;
    }
    if (!applyOk) { perPack.push({ packName: name, seed, skipped: true, reason: applyReason }); continue; }
    const scoringOpts = { ...baseScoringOpts(), ...candidate.profileOverrides };
    const before = await evaluateRetrievalBenchmarkState(genesisState, currentProd, pack, scoringOpts);
    const after = await evaluateRetrievalBenchmarkState(finalState, currentProd, pack, scoringOpts);
    const metrics = classifyPerPack(candidate, before, after);
    perPack.push({ packName: name, seed, anchored: u.anchored, anchorMode: u.anchorMode, sourceQueryId: u.sourceQueryId, subPatchCount: subPatches.length, ...metrics });
  }
  const validPacks = perPack.filter((p) => !p.skipped);
  if (validPacks.length === 0) return { candidateId: candidate.id, surface: candidate.surface, mode: candidate.mode, skipped: true, skipReasons: [...new Set(perPack.map((p) => p.reason))], packsTested: packs.length };
  const cls = aggregateClassification(candidate, validPacks);
  return {
    candidateId: candidate.id, surface: candidate.surface, mode: candidate.mode, params: candidate.params,
    memoryOperationSignature: candidate.memoryOperationSignature,
    publicSignals: candidate.publicSignals, minerDegreesOfFreedom: candidate.minerDegreesOfFreedom,
    nonIndexerRationale: candidate.nonIndexerRationale, leakageRisks: candidate.leakageRisks ?? [],
    profileOverrides: candidate.profileOverrides,
    expectedRendererEffect: candidate.expectedRendererEffect, expectedRerankerEffect: candidate.expectedRerankerEffect,
    rewardable: candidate.rewardable ?? true,
    packsTested: packs.length, packsScored: validPacks.length, skipReasons: [...new Set(perPack.filter((p) => p.skipped).map((p) => p.reason))],
    perPack, classification: cls,
  };
}

// ─── Surface sweep ───────────────────────────────────────────────────────────

const surfaces = Object.keys(SURFACE_GRAMMARS).filter((s) => !SURFACES_FILTER || SURFACES_FILTER.split(',').includes(s));
const candidateAllowList = CANDIDATES_FILTER ? new Set(CANDIDATES_FILTER.split(',').map((s) => s.trim())) : null;
const modeAllowList = new Set(MODES_FILTER);
const results = { surfaces: {}, combinations: {} };

for (const surface of surfaces) {
  console.log(`\n[surface-search v2] ====== ${surface} ======`);
  const candidates = SURFACE_GRAMMARS[surface].candidates.filter((c) => modeAllowList.has(c.mode));
  const surfaceResults = [];
  for (const candidate of candidates) {
    if (candidateAllowList && !candidateAllowList.has(candidate.id)) continue;
    const r = await runOneCandidate(candidate);
    const tag = r.skipped ? `SKIP (${r.skipReasons.join(',')})` : `${r.classification.label} composite=${r.classification.meanCompositeDeltaPpm}ppm offFamW=${r.classification.meanOffFamilyWorstDeltaNdcg} junk=${r.classification.sumJunkMoved} gold=${r.classification.sumGoldDamage} trace=${r.classification.anyTraceFired}`;
    console.log(`  ${candidate.id} [${candidate.mode}]: ${tag}`);
    surfaceResults.push(r);
  }
  results.surfaces[surface] = surfaceResults;
}

// ─── Top-K compositor + combinations ─────────────────────────────────────────

function rankCandidates(items, classes) {
  return items
    .filter((r) => !r.skipped && classes.includes(r.classification.label))
    .sort((a, b) => (b.classification.meanCompositeDeltaPpm - a.classification.meanCompositeDeltaPpm));
}

function classifyCombination(aSolo, bSolo, combined) {
  const aPpm = aSolo?.classification?.meanCompositeDeltaPpm ?? 0;
  const bPpm = bSolo?.classification?.meanCompositeDeltaPpm ?? 0;
  const cPpm = combined?.classification?.meanCompositeDeltaPpm ?? 0;
  const cWorst = combined?.classification?.meanOffFamilyWorstDeltaNdcg ?? 0;
  const cGold = combined?.classification?.sumGoldDamage ?? 0;
  const cJunk = combined?.classification?.sumJunkMoved ?? 0;
  const bestSolo = Math.max(aPpm, bPpm);
  if (combined.skipped) return { label: 'NO_SIGNAL', reason: 'combined skipped' };
  const comboJunkFloodWithDamage = cJunk > GATE.JUNK_MOVED_HARD_FLOOR && (cGold > 0 || cWorst <= -0.05);
  if (cWorst <= GATE.UNSAFE_OFF_FAMILY_FLOOR || cGold > 0 || comboJunkFloodWithDamage) return { label: 'UNSAFE_COMBINATION', reason: `offFamW=${cWorst} gold=${cGold} junk=${cJunk} junkFloodWithDamage=${comboJunkFloodWithDamage}` };
  if (cPpm < GATE.CLEAN_MIN_COMPOSITE_PPM && bestSolo < GATE.CLEAN_MIN_COMPOSITE_PPM) return { label: 'NO_SIGNAL', reason: `both arms below noise (composite ${cPpm})` };
  if (cPpm > bestSolo + GATE.COMPENSATED_BEATS_BEST_BY) {
    const aBad = aSolo?.classification?.label === 'UNSAFE' || aSolo?.classification?.label === 'TRADEOFF_POSITIVE';
    const bBad = bSolo?.classification?.label === 'UNSAFE' || bSolo?.classification?.label === 'TRADEOFF_POSITIVE';
    if (aBad || bBad) return { label: 'COMPENSATED_POSITIVE', reason: `combined ${cPpm} > bestSolo ${bestSolo}, with one weak arm rehabilitated`, aPpm, bPpm, cPpm };
    return { label: 'SUPER_ADDITIVE', reason: `combined ${cPpm} > bestSolo ${bestSolo}`, aPpm, bPpm, cPpm };
  }
  if (Math.abs(cPpm - bestSolo) <= GATE.COMPENSATED_BEATS_BEST_BY) return { label: 'PASS_THROUGH', reason: `combined ~ bestSolo (${cPpm} vs ${bestSolo})`, aPpm, bPpm, cPpm };
  return { label: 'UNSAFE_COMBINATION', reason: `combined ${cPpm} < bestSolo ${bestSolo} − margin`, aPpm, bPpm, cPpm };
}

if (!SKIP_COMBINATIONS) {
  console.log('\n[surface-search v2] ====== semantic combinations ======');
  for (const [aKey, bKey] of SEMANTIC_COMBINATIONS) {
    const aTopK = rankCandidates(results.surfaces[aKey] ?? [], ['CLEAN_POSITIVE', 'UNEXPLAINED_POSITIVE', 'TRADEOFF_POSITIVE']).slice(0, TOP_K);
    const bTopK = rankCandidates(results.surfaces[bKey] ?? [], ['CLEAN_POSITIVE', 'UNEXPLAINED_POSITIVE', 'TRADEOFF_POSITIVE']).slice(0, TOP_K);
    if (aTopK.length === 0) aTopK.push(...rankCandidates(results.surfaces[aKey] ?? [], ['NO_MOVEMENT']).slice(0, 1));
    if (bTopK.length === 0) bTopK.push(...rankCandidates(results.surfaces[bKey] ?? [], ['NO_MOVEMENT']).slice(0, 1));
    if (aTopK.length === 0 || bTopK.length === 0) { console.log(`  ${aKey}+${bKey}: no top-K available`); continue; }
    const pairResults = [];
    for (const aSolo of aTopK) {
      const aCand = SURFACE_GRAMMARS[aKey].candidates.find((c) => c.id === aSolo.candidateId);
      if (!aCand) continue;
      for (const bSolo of bTopK) {
        const bCand = SURFACE_GRAMMARS[bKey].candidates.find((c) => c.id === bSolo.candidateId);
        if (!bCand) continue;
        const armBOffsets = compositorArmBOffsets();
        const composed = {
          id: `combo_${aCand.id}__${bCand.id}`, surface: `${aKey}+${bKey}`, mode: `${aCand.mode}+${bCand.mode}`,
          params: { a: aCand.id, b: bCand.id, slotPlan: armBOffsets, slotCollisionAvoided: true },
          memoryOperationSignature: `${aKey}: ${aCand.memoryOperationSignature} || ${bKey}: ${bCand.memoryOperationSignature}`,
          publicSignals: [...new Set([...(aCand.publicSignals ?? []), ...(bCand.publicSignals ?? [])])],
          minerDegreesOfFreedom: ['arm a params', 'arm b params'], nonIndexerRationale: 'both arms read public structure',
          leakageRisks: [...(aCand.leakageRisks ?? []), ...(bCand.leakageRisks ?? [])],
          profileOverrides: { ...aCand.profileOverrides, ...bCand.profileOverrides },
          buildUnits: (ctx) => {
            const a = aCand.buildUnits(ctx);
            // Arm B sees a cursor shifted by the slot-namespace plan so it cannot
            // collide with arm A on any MemoryIndex / policy region word.
            const shifted = Object.fromEntries(Object.entries(ctx.slotCursor ?? {}).map(([k, v]) => [k, (v ?? 0) + (armBOffsets[k] ?? 0)]));
            const ctxB = { ...ctx, slotCursor: shifted };
            const b = bCand.buildUnits(ctxB);
            if (!a.indices?.length && !b.indices?.length) return { indices: [], newWords: [], reason: `both_skipped:${a.reason ?? '?'}|${b.reason ?? '?'}` };
            // Combined patches frequently exceed the 4-word patch budget. Apply each
            // arm as its OWN STATE_ADVANCE patch in sequence — that matches how miners
            // would accumulate substrate across epochs. The harness reports it as a
            // single combined candidate but the apply path uses sequential subPatches.
            const subPatches = [];
            if (a.indices?.length) subPatches.push({ indices: a.indices, newWords: a.newWords });
            if (b.indices?.length) subPatches.push({ indices: b.indices, newWords: b.newWords });
            return { subPatches, anchored: { a: a.anchored, b: b.anchored }, anchorMode: `${aCand.mode}+${bCand.mode}`, slotPlan: armBOffsets };
          },
          expectedRendererEffect: 'combined arm effect', expectedRerankerEffect: 'combined',
        };
        const r = await runOneCandidate(composed);
        const comboLabel = r.skipped ? { label: 'NO_SIGNAL', reason: r.skipReasons.join(',') } : classifyCombination(aSolo, bSolo, r);
        console.log(`  ${aCand.id} × ${bCand.id}: ${comboLabel.label} (combined ${r.classification?.meanCompositeDeltaPpm ?? 'n/a'} ppm vs bestSolo ${Math.max(aSolo.classification.meanCompositeDeltaPpm, bSolo.classification.meanCompositeDeltaPpm)})`);
        pairResults.push({ a: aCand.id, b: bCand.id, aLabel: aSolo.classification.label, bLabel: bSolo.classification.label, combined: r, comboLabel });
      }
    }
    results.combinations[`${aKey}+${bKey}`] = pairResults;
  }
}

// ─── Write report ─────────────────────────────────────────────────────────────

const report = {
  schema: 'coretex.surface-search-harness.v2',
  bundle: BUNDLE_PATH, profile: PROFILE_PATH, corpus: CORPUS_PATH,
  bundleHash: baseBundle.manifest.bundleHash, corpusRoot: baseBundle.manifest.corpusRoot,
  reranker: RERANKER, packSeeds: PACK_SEEDS, packNames: PACK_NAMES, modes: MODES_FILTER, topK: TOP_K,
  gate: GATE,
  surfacesScored: surfaces,
  results,
};
const outAbs = resolve(repoRoot, OUT);
mkdirSync(dirname(outAbs), { recursive: true });
writeFileSync(outAbs, JSON.stringify(report, null, 2));
console.log(`\n[surface-search v2] wrote ${outAbs}`);
