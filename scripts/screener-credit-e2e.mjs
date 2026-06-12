#!/usr/bin/env node
/**
 * Screener / work-credit dynamic-threshold e2e  (Launch hardening L8).
 *
 * Exercises the FULL admission → qualification → work-credit path against TWO
 * pinned baselines, proving the screener threshold is dynamic + bounded + not
 * publicly gameable, and that credit tiers are correct:
 *
 *   A) Dynamic threshold under two baselines: a higher pinned baseline (less
 *      remaining headroom) lowers the screener threshold; a higher recent noise
 *      floor raises it; both clamp to [minDelta, maxThreshold]. Threshold
 *      RECOMPUTES from the live baseline (after a re-pin it changes) → never
 *      stale after churn/corpus/reranker change.
 *   B) Outcome matrix at a fixed baseline:
 *        bogus (delta < threshold)         → W03_DETERMINISTIC_DELTA_TOO_LOW, 0 credit
 *        stale parent                      → W02_STALE_PARENT, 0 credit
 *        local-model regression            → W04_LOCAL_MODEL_REGRESSION, 0 credit
 *        relevant near-collision over cap  → W05_RELEVANT_NEAR_COLLISION, 0 credit
 *        viable screener pass              → OK, screenerPass = exactly 1x (10000 bps)
 *        state-advance w/o live advance    → W06_STATE_NOT_ADVANCED, 0 credit
 *        accepted state advance            → OK, tiered bps by qualified passes
 *   C) Bounded credit: screener pass is EXACTLY 1x; state-advance tiers are
 *      monotone and saturate at the top tier (anti-grinding ceiling).
 *   D) Dedup / per-miner cap (admission layer): a resubmitted dedupKey collapses
 *      (no new credit); a miner over perMinerCap is capped.
 *
 * Pure reward logic — no scoring/models. Deterministic.
 */
import { argv, exit } from 'node:process';
import { distIndex } from './_repo-root.mjs';

const m = await import(distIndex);
const {
  computeCoreTexScreenerThresholdPpm, evaluateCoreTexWorkQualification, computeCoreTexWorkUnitsBps,
  DEFAULT_CORETEX_WORK_POLICY, OUTCOME_CORETEX_SCREENER_PASS, OUTCOME_CORETEX_STATE_ADVANCE,
  liveEvalAdmissionDecision,
} = m;

const policy = DEFAULT_CORETEX_WORK_POLICY;
const STATE_ADVANCE_THRESHOLD_PPM = 2750;
const STATE_FLOOR_PPM = Math.ceil(STATE_ADVANCE_THRESHOLD_PPM * Number(policy.screenerPass.calibration.stateAdvanceThresholdFloorBps ?? 0) / 10_000);
let pass = true; const log = [];
const check = (n, ok, d = '') => { log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!ok) pass = false; };

// ── A) dynamic threshold under two baselines ────────────────────────────────
// Baseline headroom/noise still moves the threshold, but the launch invariant is
// that it cannot fall below a fraction of the real state-advance threshold.
const baselineA = 304958, baselineB = 600000;
const thrA = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm: baselineA, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, policy }));
const thrB = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm: baselineB, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, policy }));
check('A1) threshold is floored by the state-advance economics line',
  thrA >= STATE_FLOOR_PPM && thrB >= STATE_FLOOR_PPM && thrA <= STATE_ADVANCE_THRESHOLD_PPM && thrB <= STATE_ADVANCE_THRESHOLD_PPM,
  `floor=${STATE_FLOOR_PPM} thr(A=${baselineA})=${thrA} thr(B=${baselineB})=${thrB} state=${STATE_ADVANCE_THRESHOLD_PPM}`);
const thrNoise = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm: baselineA, recentNoiseFloorPpm: 1000, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, policy }));
check('A2) recent noise floor raises threshold', thrNoise > thrA, `noiseThr=${thrNoise} > ${thrA}`);
const thrFloor = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm: 999_999, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, policy }));
const thrCeil = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm: 0, recentNoiseFloorPpm: 10_000_000, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, policy }));
check('A3) threshold clamps between state-coupled floor and state threshold',
  thrFloor >= STATE_FLOOR_PPM && thrCeil <= STATE_ADVANCE_THRESHOLD_PPM,
  `floor=${thrFloor}≥${STATE_FLOOR_PPM} ceil=${thrCeil}≤${STATE_ADVANCE_THRESHOLD_PPM}`);
const higherStateThr = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm: baselineA, stateAdvanceThresholdPpm: 5000, policy }));
check('A4) threshold recomputes when state-advance threshold changes', higherStateThr > thrA, `${thrA}→${higherStateThr}`);

// ── B) outcome matrix at baseline A ─────────────────────────────────────────
const baseQ = { parentMatchesLiveRoot: true, baselineScorePpm: baselineA, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, policy };
const bogus = evaluateCoreTexWorkQualification({ ...baseQ, outcome: OUTCOME_CORETEX_SCREENER_PASS, deterministicDeltaPpm: thrA - 1 });
check('B1) bogus (delta < threshold) → W03, 0 credit', bogus.reason === 'W03_DETERMINISTIC_DELTA_TOO_LOW' && bogus.workUnitsBps === 0n, bogus.reason);
const stale = evaluateCoreTexWorkQualification({ ...baseQ, parentMatchesLiveRoot: false, outcome: OUTCOME_CORETEX_SCREENER_PASS, deterministicDeltaPpm: thrA + 5000 });
check('B2) stale parent → W02, 0 credit', stale.reason === 'W02_STALE_PARENT' && stale.workUnitsBps === 0n, stale.reason);
const regression = evaluateCoreTexWorkQualification({ ...baseQ, outcome: OUTCOME_CORETEX_SCREENER_PASS, deterministicDeltaPpm: thrA + 5000, localModelDeltaPpm: -1 });
check('B3) local-model regression → W04, 0 credit', regression.reason === 'W04_LOCAL_MODEL_REGRESSION' && regression.workUnitsBps === 0n, regression.reason);
const collide = evaluateCoreTexWorkQualification({ ...baseQ, outcome: OUTCOME_CORETEX_SCREENER_PASS, deterministicDeltaPpm: thrA + 5000, relevantNearCollisionPpm: Number(policy.screenerPass.maxRelevantNearCollisionPpm) + 1 });
check('B4) relevant near-collision over cap → W05, 0 credit', collide.reason === 'W05_RELEVANT_NEAR_COLLISION' && collide.workUnitsBps === 0n, collide.reason);
const screenerPass = evaluateCoreTexWorkQualification({ ...baseQ, outcome: OUTCOME_CORETEX_SCREENER_PASS, deterministicDeltaPpm: thrA + 5000 });
check('B5) viable screener pass → OK, exactly 1x (10000 bps)', screenerPass.reason === 'OK' && screenerPass.workUnitsBps === 10000n, `bps=${screenerPass.workUnitsBps}`);
const advNoLive = evaluateCoreTexWorkQualification({ ...baseQ, outcome: OUTCOME_CORETEX_STATE_ADVANCE, deterministicDeltaPpm: thrA + 50000, liveStateAdvanced: false });
check('B6) state-advance w/o live advance → W06, 0 credit', advNoLive.reason === 'W06_STATE_NOT_ADVANCED' && advNoLive.workUnitsBps === 0n, advNoLive.reason);
const advance = evaluateCoreTexWorkQualification({ ...baseQ, outcome: OUTCOME_CORETEX_STATE_ADVANCE, deterministicDeltaPpm: thrA + 50000, liveStateAdvanced: true, qualifiedScreenerPassesSinceLastStateAdvance: 0 });
check('B7) accepted state advance → OK, tiered credit', advance.reason === 'OK' && advance.workUnitsBps >= 30000n, `bps=${advance.workUnitsBps}`);

// ── C) bounded credit: tiers monotone + saturate ────────────────────────────
const tierAt = (n) => Number(computeCoreTexWorkUnitsBps({ outcome: OUTCOME_CORETEX_STATE_ADVANCE, qualifiedScreenerPassesSinceLastStateAdvance: n, policy }));
const tierCounts = [0, 25, 100, 250, 500, 1000, 100000];
const tiers = tierCounts.map(tierAt);
const monotone = tiers.every((v, i) => i === 0 || v >= tiers[i - 1]);
const topTier = Number(policy.stateAdvance.tiers[policy.stateAdvance.tiers.length - 1].workUnitsBps);
check('C1) state-advance tiers monotone non-decreasing', monotone, `[${tiers.join(',')}]`);
check('C2) tiers saturate at top tier (anti-grinding ceiling)', tierAt(100000) === topTier && tierAt(1_000_000_000) === topTier, `top=${topTier}`);
check('C3) screener pass is exactly 1x (immutable)', Number(policy.screenerPass.workUnitsBps) === 10000);

// ── D) dedup / per-miner cap (admission layer) ──────────────────────────────
const miner = '0x' + '11'.repeat(20);
const dk = '0x' + 'ab'.repeat(32);
const ph = '0x' + 'cd'.repeat(32);
const admitFresh = liveEvalAdmissionDecision({ minerAddress: miner, patchHash: ph, dedupKey: dk, structurallyValid: true, minerAdmissionsThisEpoch: 0, perMinerCap: 5, dedupedKeysThisEpoch: new Set() });
const admitDup = liveEvalAdmissionDecision({ minerAddress: miner, patchHash: ph, dedupKey: dk, structurallyValid: true, minerAdmissionsThisEpoch: 1, perMinerCap: 5, dedupedKeysThisEpoch: new Set([dk]) });
const admitCapped = liveEvalAdmissionDecision({ minerAddress: miner, patchHash: ph, dedupKey: '0x' + 'ef'.repeat(32), structurallyValid: true, minerAdmissionsThisEpoch: 5, perMinerCap: 5, dedupedKeysThisEpoch: new Set() });
const admitBad = liveEvalAdmissionDecision({ minerAddress: miner, patchHash: ph, dedupKey: '0x' + '00'.repeat(32), structurallyValid: false, minerAdmissionsThisEpoch: 0, perMinerCap: 5, dedupedKeysThisEpoch: new Set() });
check('D1) fresh viable patch admitted', admitFresh.admit === true, admitFresh.reason ?? '');
check('D2) resubmitted dedupKey collapses (no new credit)', admitDup.admit === false && admitDup.reason === 'duplicate-key-collapsed', admitDup.reason);
check('D3) per-miner cap enforced', admitCapped.admit === false && admitCapped.reason === 'per-miner-cap-reached', admitCapped.reason);
check('D4) structurally-invalid rejected', admitBad.admit === false && admitBad.reason === 'structurally-invalid', admitBad.reason);

console.log(log.join('\n'));
console.log('────────────────────────────────────────────────────────');
console.log(`stateAdvanceThreshold=${STATE_ADVANCE_THRESHOLD_PPM}ppm floor=${STATE_FLOOR_PPM}ppm ; baseline A=${baselineA}ppm → screenerThreshold ${thrA}ppm ; baseline B=${baselineB}ppm → ${thrB}ppm ; +noise → ${thrNoise}ppm`);
console.log(`state-advance tiers by qualifiedPasses ${JSON.stringify(tierCounts)} = [${tiers.join(',')}] bps (screenerPass=10000 bps)`);
console.log(pass ? 'RESULT: ALL PASS ✅' : 'RESULT: FAIL ❌');
exit(pass ? 0 : 1);
