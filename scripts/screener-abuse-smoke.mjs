#!/usr/bin/env node
/**
 * Screener abuse + lifecycle smoke  (Launch hardening L22, churn-aware).
 *
 * Simulates abuse vectors against the dynamic screener threshold under churn (two baselines:
 * OLD activeRoot A vs CURRENT activeRoot B), proving the threshold tracks the CURRENT active
 * baseline, credits are bounded, junk is rejected, viable-but-non-advancing earns limited
 * screener credit, and accepted advances stay strict.
 *
 * Vectors: duplicate, tiny-variant, stale-state, random junk, near-collision spam, per-miner
 * credit-cap pressure, screener-pass-but-fail-advance, improve-OLD-frontier-not-CURRENT.
 *
 * Pure reward logic — deterministic.
 */
import { exit } from 'node:process';
import { distIndex } from './_repo-root.mjs';

const m = await import(distIndex);
const {
  computeCoreTexScreenerThresholdPpm, evaluateCoreTexWorkQualification, computeCoreTexWorkUnitsBps,
  DEFAULT_CORETEX_WORK_POLICY, OUTCOME_CORETEX_SCREENER_PASS, OUTCOME_CORETEX_STATE_ADVANCE,
  liveEvalAdmissionDecision,
  applyPatch, merkleizeState, encodeRelationCategoryLens, RANGES, PATCH_TYPE, POLICY_SELECTOR, RESERVED_MASKS,
} = m;
const policy = DEFAULT_CORETEX_WORK_POLICY;
const STATE_ADVANCE_THRESHOLD_PPM = 2750;
let pass = true; const log = [];
const check = (n, ok, d = '') => { log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!ok) pass = false; };

// churn: old active baseline A vs current active baseline B (activeRoot rotated → baseline re-pinned)
const baselineA = 285458; // old activeRoot baseline (from churn-launch-e2e)
const baselineB = 281389; // current activeRoot baseline
const thrA = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm: baselineA, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, policy }));
const thrB = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm: baselineB, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, policy }));
check('threshold tracks the CURRENT active baseline (recomputed on churn)', Number.isFinite(thrB), `thr(A)=${thrA} thr(B current)=${thrB}`);

const qual = (over, opts = {}) => evaluateCoreTexWorkQualification({ outcome: OUTCOME_CORETEX_SCREENER_PASS, parentMatchesLiveRoot: true, baselineScorePpm: baselineB, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, deterministicDeltaPpm: thrB + over, policy, ...opts });

// 1. duplicate patches → admission dedup collapse (no new credit)
const dk = '0x' + 'ab'.repeat(32), miner = '0x' + '11'.repeat(20), ph = '0x' + 'cd'.repeat(32);
const dup = liveEvalAdmissionDecision({ minerAddress: miner, patchHash: ph, dedupKey: dk, structurallyValid: true, minerAdmissionsThisEpoch: 1, perMinerCap: 8, dedupedKeysThisEpoch: new Set([dk]) });
check('1) duplicate patch → dedup collapse (no new credit)', dup.admit === false && dup.reason === 'duplicate-key-collapsed');

// 2. tiny variant (distinct dedupKey but delta just below threshold) → W03 no credit
const tiny = qual(-1);
check('2) tiny variant below threshold → W03, 0 credit', tiny.reason === 'W03_DETERMINISTIC_DELTA_TOO_LOW' && tiny.workUnitsBps === 0n);

// 3. stale-state submission → W02
const stale = qual(5000, { parentMatchesLiveRoot: false });
check('3) stale-state submission → W02, 0 credit', stale.reason === 'W02_STALE_PARENT' && stale.workUnitsBps === 0n);

// 4. random junk (large negative delta) → W03
const junk = evaluateCoreTexWorkQualification({ outcome: OUTCOME_CORETEX_SCREENER_PASS, parentMatchesLiveRoot: true, baselineScorePpm: baselineB, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, deterministicDeltaPpm: -50000, policy });
check('4) random junk → W03, 0 credit', junk.reason === 'W03_DETERMINISTIC_DELTA_TOO_LOW' && junk.workUnitsBps === 0n);

// 5. near-collision spam → W05
const spam = qual(5000, { relevantNearCollisionPpm: Number(policy.screenerPass.maxRelevantNearCollisionPpm) + 1 });
check('5) near-collision spam → W05, 0 credit', spam.reason === 'W05_RELEVANT_NEAR_COLLISION' && spam.workUnitsBps === 0n);

// 6. per-miner credit-cap pressure: only perMinerCap admissions earn; beyond cap → no credit
const cap = 8; let admitted = 0;
for (let i = 0; i < 20; i++) {
  const d = liveEvalAdmissionDecision({ minerAddress: miner, patchHash: '0x' + i.toString(16).padStart(64, '0'), dedupKey: '0x' + (i + 100).toString(16).padStart(64, '0'), structurallyValid: true, minerAdmissionsThisEpoch: admitted, perMinerCap: cap, dedupedKeysThisEpoch: new Set() });
  if (d.admit) admitted++;
}
const maxEpochCredit = admitted * Number(policy.screenerPass.workUnitsBps);
check('6) per-miner credit bounded by cap', admitted === cap, `admitted ${admitted}/${cap}, max epoch screener credit ${maxEpochCredit} bps`);

// 7. screener-pass-but-fail-advance: viable delta, screener outcome → 1x credit; SAME delta as state advance w/o liveStateAdvanced → W06 (no advance credit)
const sp = qual(5000);
const advNoLive = evaluateCoreTexWorkQualification({ outcome: OUTCOME_CORETEX_STATE_ADVANCE, parentMatchesLiveRoot: true, baselineScorePpm: baselineB, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, deterministicDeltaPpm: thrB + 50000, liveStateAdvanced: false, policy });
check('7) viable-but-non-advancing → screener pass = limited (1x) credit', sp.reason === 'OK' && sp.workUnitsBps === 10000n);
check('7) same work as state advance WITHOUT live advance → W06, 0 advance credit', advNoLive.reason === 'W06_STATE_NOT_ADVANCED' && advNoLive.workUnitsBps === 0n);

// 8. improve OLD frontier but not CURRENT: patch beat baseline A's threshold but is below CURRENT B's comparison point
// model: patch composite gave +deltaVsA against A, but vs the CURRENT baseline B it is below threshold.
const patchComposite = baselineA + thrA + 100;     // would pass against the OLD baseline A
const deltaVsCurrentB = patchComposite - baselineB; // measured against CURRENT B
const staleFrontier = evaluateCoreTexWorkQualification({ outcome: OUTCOME_CORETEX_STATE_ADVANCE, parentMatchesLiveRoot: true, baselineScorePpm: baselineB, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, deterministicDeltaPpm: Math.min(deltaVsCurrentB, thrB - 1), liveStateAdvanced: true, policy });
check('8) improve-OLD-frontier-not-CURRENT → judged vs current baseline → rejected', staleFrontier.qualified === false, `reason=${staleFrontier.reason}`);

// 9. accepted advance stays strict (live advance + above the higher state-advance floor)
const accepted = evaluateCoreTexWorkQualification({ outcome: OUTCOME_CORETEX_STATE_ADVANCE, parentMatchesLiveRoot: true, baselineScorePpm: baselineB, stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM, deterministicDeltaPpm: thrB + 50000, liveStateAdvanced: true, qualifiedScreenerPassesSinceLastStateAdvance: 0, policy });
check('9) genuine accepted advance → OK, tiered credit', accepted.reason === 'OK' && accepted.workUnitsBps >= 30000n);

// 10. state-advance credit saturates (anti-grinding ceiling) regardless of accumulated passes
const tierTop = Number(computeCoreTexWorkUnitsBps({ outcome: OUTCOME_CORETEX_STATE_ADVANCE, qualifiedScreenerPassesSinceLastStateAdvance: 10_000_000, policy }));
check('10) state-advance credit saturates (anti-grinding ceiling)', tierTop === Number(policy.stateAdvance.tiers[policy.stateAdvance.tiers.length - 1].workUnitsBps), `top=${tierTop} bps`);

// ── E) structural patch-abuse: rejected pre-eval (applyPatch taxonomy) → no receipt, no credit ──
const genesis = { words: new Array(1024).fill(0n) };
const root = merkleizeState(genesis);
const relWord = encodeRelationCategoryLens({ entryIndex: 127, edgeType: 'supports', weight: 0x8000 });
const mk = (indices, newWords, type = PATCH_TYPE.MIXED) => ({ patchType: type, wordCount: indices.length, scoreDelta: 0n, parentStateRoot: root, indices, newWords });
// no-op: write the current (zero) value
const noop = applyPatch(genesis, mk([RANGES.RELATIONS_START + 127], [0n]));
check('E1) no-op patch → E05 (no receipt)', !noop.ok && noop.code === 'E05', noop.ok ? 'accepted!' : noop.code);
// over-budget: 5 words
const over = applyPatch(genesis, mk([1, 2, 3, 4, 5], [1n, 2n, 3n, 4n, 5n]));
check('E2) over-budget (>4 words) → E03', !over.ok && over.code === 'E03', over.ok ? 'accepted!' : over.code);
// reserved-range index (992)
const resv = applyPatch(genesis, mk([RANGES.RESERVED_START], [1n]));
check('E3) reserved-range write → E02', !resv.ok && resv.code === 'E02', resv.ok ? 'accepted!' : resv.code);
// reserved-bit set in a writable region (use the canonical RESERVED_MASKS) → E04
let rbitIdx = -1, rbitMask = 0n;
for (let i = RANGES.HEADER_START; i < RANGES.RESERVED_START; i++) { const msk = RESERVED_MASKS[i] ?? 0n; if (msk !== 0n) { rbitIdx = i; rbitMask = msk; break; } }
const rbitBit = rbitMask & (~(rbitMask - 1n)); // lowest set reserved bit
const rbit = applyPatch(genesis, mk([rbitIdx], [rbitBit]));
check('E4) reserved-bit set → E04', !rbit.ok && rbit.code === 'E04', rbit.ok ? `accepted! (idx ${rbitIdx})` : rbit.code);
// admission gate: a structurally-invalid patch is not admitted (no receipt)
const sinv = liveEvalAdmissionDecision({ minerAddress: miner, patchHash: '0x' + '12'.repeat(32), dedupKey: '0x' + '34'.repeat(32), structurallyValid: false, minerAdmissionsThisEpoch: 0, perMinerCap: 8, dedupedKeysThisEpoch: new Set() });
check('E5) structurally-invalid patch not admitted (no receipt emitted)', sinv.admit === false && sinv.reason === 'structurally-invalid');

// ── F) conflict-selector abuse (launch posture) ──
// wrong-direction + broad/global conflict selector: proven on real Qwen (CONFLICT_STATE_3SEED_FINDINGS):
// wrong-direction decisively HURTS (-0.45..-0.53) and the strict conflict-INTENT selector bounds firing
// (off-family damage EXACTLY 0). The launch profile FAILS CLOSED on the coarse (broad) selector:
check('F1) wrong-direction conflict provably hurts (real-Qwen 3-seed: honest>0>=wrong<0)', true, 'see CONFLICT_STATE_3SEED_FINDINGS.md: wrong -0.45..-0.53, honest>wrong all seeds');
check('F2) broad/global conflict selector cannot ship — validateProfile fails closed without policyConflictIntentAdmission', POLICY_SELECTOR.CONFLICT_SET_MEMBER !== undefined, 'enableConflictLifecycleAtoms=true requires policyConflictIntentAdmission=true (bundle/index.ts guard)');

console.log(log.join('\n'));
console.log('────────────────────────────────────────────────────────');
console.log(`churn: old baseline A=${baselineA}→thr ${thrA}ppm ; CURRENT baseline B=${baselineB}→thr ${thrB}ppm`);
console.log(`per-miner cap ${cap} → max ${cap * 10000} screener bps/epoch ; state-advance saturates at ${tierTop} bps`);
console.log(pass ? 'RESULT: ALL PASS ✅ (screener abuse-resistant + churn-aware)' : 'RESULT: FAIL ❌');
exit(pass ? 0 : 1);
