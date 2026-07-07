/**
 * BMU v1 deterministic judge + law-module unit suite (BMU_SPEC.md):
 *   - §13.2 quantized judge ordering (grid ties, fully-quantized tiebreak,
 *     docId asc) incl. grid-boundary cases;
 *   - §2.2 per-task utility: budget-B boundary, forbidden-item admission,
 *     abstention variants + false-abstain counterweight;
 *   - §2.3 composition validator (assertValidBmuWeights);
 *   - §13.2 Rmax bundle validation;
 *   - §7.3 taxonomy mapping (outer + inner reasons → exactly one of six);
 *   - §6.7b arm-gate census (refusal below minima / opening at minima /
 *     GLOBAL m=1 / fresh cohort) and the pinned variance-cert procedure;
 *   - §2.4 threshold arithmetic (1-flip screener / 2-flip advance staircase).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bmuJudgeOrder,
  bmuJudgeTopB,
  bmuQuantize,
  computeBmuTaskUtility,
  assertValidBmuWeights,
  computeBmuJudgeRmax,
  assertBmuJudgeRmax,
  mapBmuExternalRejectionReason,
  BMU_EXTERNAL_REJECTION_REASONS,
  evaluateBmuArmGate,
  bmuArmVarianceSeedHex,
  buildBmuArmVarianceCertification,
  bmuExclusionSetDigest,
  BMU_ROW_QUANTUM_PPM,
  BMU_MIN_IMPROVEMENT_PPM,
  BMU_REPLAY_TOLERANCE_PPM,
  BMU_ARM_GATE_FAMILY_MINIMA,
  BMU_ARM_GATE_N_MIN,
  BMU_ARM_VARIANCE_RUNS,
  BMU_ARM_VARIANCE_MAX_SPREAD_PPM,
  computeAcceptanceThresholdPpm,
} from '../../dist/index.js';

const G = 1e-3;

describe('§13.2 quantized judge ordering', () => {
  test('ranks by quantized composite desc', () => {
    const order = bmuJudgeOrder([
      { docId: 'a', rerankerScore: 0.1, finalReorderingScore: 0.5 },
      { docId: 'b', rerankerScore: 0.1, finalReorderingScore: 0.9 },
    ], G);
    assert.deepEqual(order.map((e) => e.docId), ['b', 'a']);
  });

  test('sub-grid composite differences TIE and fall to quantized rerankerScore', () => {
    // 0.50003 vs 0.50017: raw sort would put the second first; both quantize
    // to cell 500, so the quantized rerankerScore decides.
    const order = bmuJudgeOrder([
      { docId: 'a', rerankerScore: 0.200, finalReorderingScore: 0.50003 },
      { docId: 'b', rerankerScore: 0.900, finalReorderingScore: 0.50017 },
      { docId: 'c', rerankerScore: 0.899, finalReorderingScore: 0.50011 },
    ], G);
    assert.deepEqual(order.map((e) => e.docId), ['b', 'c', 'a']);
  });

  test('full tie (both keys on the same cells) breaks by docId ASC', () => {
    const order = bmuJudgeOrder([
      { docId: 'z9', rerankerScore: 0.5001, finalReorderingScore: 0.7001 },
      { docId: 'a1', rerankerScore: 0.5004, finalReorderingScore: 0.7004 },
    ], G);
    assert.deepEqual(order.map((e) => e.docId), ['a1', 'z9']);
  });

  test('grid-boundary: scores straddling a cell boundary do NOT tie', () => {
    // 0.4994 → cell 499; 0.4996 → cell 500 (Math.round semantics).
    assert.equal(bmuQuantize(0.4994, G), 499);
    assert.equal(bmuQuantize(0.4996, G), 500);
    const order = bmuJudgeOrder([
      { docId: 'low', rerankerScore: 0.9, finalReorderingScore: 0.4994 },
      { docId: 'high', rerankerScore: 0.1, finalReorderingScore: 0.4996 },
    ], G);
    assert.deepEqual(order.map((e) => e.docId), ['high', 'low']);
  });

  test('negative composites (policy suppression) quantize and order correctly', () => {
    const order = bmuJudgeOrder([
      { docId: 'a', rerankerScore: 0, finalReorderingScore: -0.25 },
      { docId: 'b', rerankerScore: 0, finalReorderingScore: -0.05 },
    ], G);
    assert.deepEqual(order.map((e) => e.docId), ['b', 'a']);
  });

  test('bmuJudgeTopB slices exactly B', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      docId: `d${i}`, rerankerScore: 0, finalReorderingScore: 1 - i * 0.01,
    }));
    assert.deepEqual(bmuJudgeTopB(entries, 3, G), ['d0', 'd1', 'd2']);
  });

  test('rejects a non-positive grid (fail-closed)', () => {
    assert.throws(() => bmuJudgeTopB([], 3, 0));
    assert.throws(() => bmuQuantize(1, NaN));
  });
});

describe('§2.2 per-task utility law', () => {
  const task = (o = {}) => ({
    family: 'temporal', budgetB: 3,
    requiredEvidence: ['req1', 'req2'], forbiddenEvidence: ['trap'],
    answer: { id: 'req1' }, motifGroupId: 'mg', templateId: 'tt', ...o,
  });

  test('u=1 when required ⊆ topB, no forbidden, answer in topB, no abstain', () => {
    assert.deepEqual(computeBmuTaskUtility({ task: task(), topB: ['req1', 'req2', 'x'], abstainSignal: false }), { utility: 1 });
  });

  test('budget-B boundary: a required doc at rank B+1 zeroes the task', () => {
    // topB is the top-3 window; req2 sits just outside.
    const r = computeBmuTaskUtility({ task: task(), topB: ['req1', 'x', 'y'], abstainSignal: false });
    assert.equal(r.utility, 0);
    assert.equal(r.failure, 'missing_required');
  });

  test('ANY forbidden item inside top-B zeroes the task (hard veto)', () => {
    const r = computeBmuTaskUtility({ task: task(), topB: ['req1', 'req2', 'trap'], abstainSignal: false });
    assert.equal(r.utility, 0);
    assert.equal(r.failure, 'forbidden_admitted');
  });

  test('answer outside top-B zeroes the task even with required covered', () => {
    const t = task({ requiredEvidence: ['req1', 'req2'], answer: { id: 'req2' } });
    const r = computeBmuTaskUtility({ task: t, topB: ['req1', 'req2', 'x'], abstainSignal: false });
    assert.equal(r.utility, 1); // req2 IS in topB — sanity
    const r2 = computeBmuTaskUtility({ task: t, topB: ['req1', 'x', 'y'], abstainSignal: false });
    assert.equal(r2.utility, 0);
  });

  test('false-abstain counterweight: abstain on an answerable task earns nothing', () => {
    const r = computeBmuTaskUtility({ task: task(), topB: ['req1', 'req2', 'x'], abstainSignal: true });
    assert.equal(r.utility, 0);
    assert.equal(r.failure, 'false_abstain');
  });

  test('abstention variant: u=1 iff no forbidden in topB AND the signal fires', () => {
    const abst = task({ abstain: true, requiredEvidence: [], answer: undefined });
    assert.equal(computeBmuTaskUtility({ task: abst, topB: ['x', 'y'], abstainSignal: true }).utility, 1);
    assert.equal(computeBmuTaskUtility({ task: abst, topB: ['x', 'y'], abstainSignal: false }).utility, 0);
    const r = computeBmuTaskUtility({ task: abst, topB: ['trap', 'y'], abstainSignal: true });
    assert.equal(r.utility, 0);
    assert.equal(r.failure, 'forbidden_admitted');
  });
});

describe('§2.4 threshold arithmetic (row-flip semantics)', () => {
  test('threshold = 20,000 + 250 + 0 = 20,250 exactly under the pinned variance law', () => {
    const thr = computeAcceptanceThresholdPpm({
      patchAcceptanceFloors: { minImprovementPpm: BMU_MIN_IMPROVEMENT_PPM },
      replayTolerancePpm: BMU_REPLAY_TOLERANCE_PPM,
      baselineVariancePpm: 999_999,           // must NOT count:
      baselineVarianceSource: 'unavailable',  // §2.4 variance ≡ 0
    });
    assert.equal(thr, 20_250);
    // 1 net flip can never advance; 2 can (the staircase).
    assert.ok(1 * BMU_ROW_QUANTUM_PPM < thr, 'one flip must be < threshold');
    assert.ok(2 * BMU_ROW_QUANTUM_PPM >= thr, 'two flips must clear threshold');
  });
});

describe('§2.3 composition validator', () => {
  const QUOTAS = [
    { stratum: 'family=temporal', minCount: 10 },
    { stratum: 'family=conflict_lifecycle', minCount: 15 },
    { stratum: 'family=multi_hop_relation', minCount: 15 },
    { stratum: 'family=near_collision', minCount: 10 },
  ];
  const SLOTS = { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 3 };

  test('the pinned §6.2 numbers validate (deviations ≤ 0.03)', () => {
    assert.doesNotThrow(() => assertValidBmuWeights({ packSize: 64, quotas: QUOTAS, familySlots: SLOTS }));
  });

  test('the rev3 F3 counterexample (2/2/4/4 round-robin shape) is REJECTED', () => {
    // conflict share (15+2)/64 = 0.266 → deviation 0.034 > 0.03.
    assert.throws(
      () => assertValidBmuWeights({
        packSize: 64, quotas: QUOTAS,
        familySlots: { temporal: 2, conflict_lifecycle: 2, multi_hop_relation: 4, near_collision_abstention: 4 },
      }),
      /conflict_lifecycle/,
    );
  });

  test('legacy coreference quota strata pool into multi_hop_relation', () => {
    const quotas = [
      { stratum: 'family=temporal', minCount: 10 },
      { stratum: 'family=conflict_lifecycle', minCount: 15 },
      { stratum: 'family=multi_hop_relation', minCount: 10 },
      { stratum: 'family=coreference', minCount: 5 },
      { stratum: 'family=near_collision', minCount: 10 },
    ];
    assert.doesNotThrow(() => assertValidBmuWeights({ packSize: 64, quotas, familySlots: SLOTS }));
  });

  test('unmappable quota strata and missing families fail closed', () => {
    assert.throws(() => assertValidBmuWeights({
      packSize: 64,
      quotas: [...QUOTAS, { stratum: 'band=hard', minCount: 1 }],
      familySlots: SLOTS,
    }), /does not map to a BMU family/);
    assert.throws(() => assertValidBmuWeights({
      packSize: 64,
      quotas: QUOTAS.slice(0, 3),
      familySlots: SLOTS,
    }), /near_collision_abstention/);
    assert.throws(() => assertValidBmuWeights({
      packSize: 64, quotas: QUOTAS,
      familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3 },
    }), /familySlots/);
  });
});

describe('§13.2 Rmax bundle validation (rev3.3: per-doc clamp, P_cap = 1)', () => {
  const LIVE_LIKE = {
    lensWeight: 0.1, anchorWeight: 0.15, temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1,
    categoryLensFinalBonusWeight: 0,
  };

  test('Rmax = 1 + B + 2·P_cap; live-like betas give 3.35 ≤ 4', () => {
    const rmax = computeBmuJudgeRmax(LIVE_LIKE);
    assert.ok(Math.abs(rmax - (1 + 0.35 + 2)) < 1e-9, `rmax ${rmax}`);
    assert.doesNotThrow(() => assertBmuJudgeRmax(LIVE_LIKE));
  });

  test('policy budget caps no longer enter Rmax (the per-doc clamp bounds stacking, not budgets)', () => {
    const withHugeBudgets = { ...LIVE_LIKE, policyMaxBudgetEvidence: 65535, policyMaxBudgetConflict: 65535 };
    assert.equal(computeBmuJudgeRmax(withHugeBudgets), computeBmuJudgeRmax(LIVE_LIKE));
  });

  test('oversized bonus betas push Rmax past 4 and are refused', () => {
    assert.throws(() => assertBmuJudgeRmax({ ...LIVE_LIKE, lensWeight: 0.9 }), /Rmax/);
  });

  test('aspect beta counts only when the aspect family is enabled', () => {
    const withAspect = { ...LIVE_LIKE, enableAspectConstraintAtoms: true, policyAspectBoost: 0.4 };
    assert.ok(Math.abs(computeBmuJudgeRmax(withAspect) - (3.35 + 0.4)) < 1e-9);
    const disabled = { ...LIVE_LIKE, enableAspectConstraintAtoms: false, policyAspectBoost: 0.4 };
    assert.equal(computeBmuJudgeRmax(disabled), computeBmuJudgeRmax(LIVE_LIKE));
  });
});

describe('§7.3 taxonomy mapping (exactly one external reason)', () => {
  test('the external set is closed at exactly six', () => {
    assert.equal(BMU_EXTERNAL_REJECTION_REASONS.length, 6);
  });

  const cases = [
    [{ outerCode: 'structurally-invalid' }, 'malformed_patch'],
    [{ outerCode: 'admit-malformed-input' }, 'malformed_patch'],
    [{ outerCode: 'apply_failed:E03' }, 'malformed_patch'],
    [{ outerCode: 'SCORER_RESULT_MALFORMED' }, 'malformed_patch'],
    [{ outerCode: 'SCORER_ARTIFACT_MALFORMED' }, 'malformed_patch'],
    [{ outerCode: 'cached' }, 'duplicate_or_capped'],
    [{ outerCode: 'duplicate-key-collapsed' }, 'duplicate_or_capped'],
    [{ outerCode: 'per-miner-cap-reached' }, 'duplicate_or_capped'],
    [{ outerCode: 'duplicate_submission' }, 'duplicate_or_capped'],
    [{ outerCode: 'duplicate_in_flight' }, 'duplicate_or_capped'],
    [{ outerCode: 'CoreTexScreenerCapExceeded' }, 'duplicate_or_capped'],
    [{ outerCode: 'gate-below-threshold' }, 'below_gate'],
    [{ outerCode: 'no_retrieval_improvement' }, 'below_gate'],
    [{ outerCode: 'SCORER_BELOW_THRESHOLD' }, 'below_gate'],
    [{ outerCode: 'confirm-below-threshold' }, 'failed_holdout_transfer'],
    [{ outerCode: 'gate-acceptance-floor', innerReason: 'structural_validity_below_floor' }, 'safety_regression'],
    [{ outerCode: 'gate-acceptance-floor', innerReason: 'protected_regression:zz_e1_q_x' }, 'safety_regression'],
    [{ outerCode: 'confirm-acceptance-floor', innerReason: 'regression_budget_family:temporal' }, 'safety_regression'],
    [{ outerCode: 'confirm-acceptance-floor', innerReason: 'regression_budget_total' }, 'safety_regression'],
    [{ outerCode: 'gate-acceptance-floor', innerReason: 'apply_failed:E02' }, 'malformed_patch'],
    [{ outerCode: 'gate-acceptance-floor', innerReason: 'no_retrieval_improvement' }, 'below_gate'],
    [{ outerCode: 'confirm-acceptance-floor', innerReason: 'no_retrieval_improvement' }, 'failed_holdout_transfer'],
    [{ outerCode: 'gate-acceptance-floor' }, 'safety_regression'],
    [{ outerCode: 'W02_STALE_PARENT' }, 'stale_context'],
    [{ outerCode: 'SCORER_STALE_CONTEXT' }, 'stale_context'],
  ];
  for (const [input, expected] of cases) {
    test(`${input.outerCode}${input.innerReason ? ` + ${input.innerReason}` : ''} → ${expected}`, () => {
      assert.equal(mapBmuExternalRejectionReason(input), expected);
    });
  }

  test('scorer-integrity refusals are NEVER miner-visible (null)', () => {
    for (const code of ['SCORER_JOB_ID_MISMATCH', 'SCORER_HEALTH_MISMATCH', 'SCORER_CODE_HASH_MISMATCH',
      'SCORER_PIN_MISMATCH', 'SCORER_SEED_COMMIT_MISMATCH', 'SCORER_SCORE_PROOF_MISMATCH',
      'SCORER_THRESHOLD_ECHO_MISMATCH', 'SCORER_POLICY_ECHO_MISMATCH', 'SCORER_JOB_NOT_OUTSTANDING',
      'SCORER_ARTIFACT_MISSING', 'SCORER_ARTIFACT_HASH_MISMATCH', 'SCORER_ARTIFACT_CONTEXT_MISMATCH']) {
      assert.equal(mapBmuExternalRejectionReason({ outerCode: code }), null, code);
    }
  });

  test('unknown internal codes map to null (fail-closed toward non-disclosure)', () => {
    assert.equal(mapBmuExternalRejectionReason({ outerCode: 'some-future-code' }), null);
  });
});

// ─── §6.7b arm gate ───────────────────────────────────────────────────────────

function armRow(family, logicalFamily, bucketed, i, { epoch = 137, subject, template, motif } = {}) {
  const id = `zz_e${String(epoch).padStart(12, '0')}_q_${family}_${i}`;
  return {
    id,
    family: bucketed,
    split: 'eval_hidden',
    logicalFamily,
    subjectEntityId: subject ?? `ent_${family}_${Math.floor(i / 5)}`,
    bmuTask: {
      family,
      budgetB: 3,
      requiredEvidence: ['d1'],
      forbiddenEvidence: [],
      answer: { id: 'd1' },
      motifGroupId: motif ?? `mg_${family}_${Math.floor(i / 5)}`,
      templateId: template ?? `tt_${family}_${Math.floor(i / 5)}_${i % 5}`,
    },
  };
}

function armPool({ counts, epoch = 137 } = {}) {
  const spec = counts ?? { temporal: 80, conflict_lifecycle: 110, multi_hop_relation: 110, near_collision_abstention: 80 };
  const buckets = { temporal: 'temporal', conflict_lifecycle: 'conflict_lifecycle', multi_hop_relation: 'multi_hop_relation', near_collision_abstention: 'near_collision' };
  const logical = { temporal: 'temporal_update', conflict_lifecycle: 'conflict_lifecycle', multi_hop_relation: 'multi_session_bridge', near_collision_abstention: 'abstention_missing' };
  const events = [];
  for (const [fam, n] of Object.entries(spec)) {
    for (let i = 0; i < n; i++) events.push(armRow(fam, logical[fam], buckets[fam], i, { epoch }));
  }
  return events;
}

describe('§6.7b ARM-GATE census (rev3.2 reserve∪active pool)', () => {
  test('opens at the pinned minima with fresh cohorts and a clean census', () => {
    const events = armPool();
    const poolIds = new Set(events.map((e) => e.id));
    const report = evaluateBmuArmGate({ corpus: { events }, poolIds, epochId: 137, freshWindow: 2, posture: 'arm' });
    assert.equal(report.ok, true, report.reasons.join('; '));
    assert.equal(report.stampedPoolTotal, BMU_ARM_GATE_N_MIN);
    for (const [fam, min] of Object.entries(BMU_ARM_GATE_FAMILY_MINIMA)) {
      assert.equal(report.perFamily[fam].stampedRows, min);
      assert.ok(report.perFamily[fam].freshClusters >= 2);
    }
  });

  test('REFUSES below a per-family minimum, reporting per-family counts', () => {
    const events = armPool({ counts: { temporal: 80, conflict_lifecycle: 109, multi_hop_relation: 110, near_collision_abstention: 80 } });
    const poolIds = new Set(events.map((e) => e.id));
    const report = evaluateBmuArmGate({ corpus: { events }, poolIds, epochId: 137, posture: 'arm' });
    assert.equal(report.ok, false);
    assert.ok(report.reasons.some((r) => r.includes('conflict_lifecycle') && r.includes('109 < required 110')), report.reasons.join('; '));
    assert.ok(report.reasons.some((r) => r.includes(`N_min ${BMU_ARM_GATE_N_MIN}`)));
  });

  test('rows outside the pool (unstamped/retired) do not count', () => {
    const events = armPool();
    const poolIds = new Set(events.slice(0, 100).map((e) => e.id));
    const report = evaluateBmuArmGate({ corpus: { events }, poolIds, epochId: 137, posture: 'arm' });
    assert.equal(report.ok, false);
    assert.equal(report.stampedPoolTotal, 100);
  });

  test('ARM posture: stale cohorts (age > freshWindow) fail the fresh-cluster requirement', () => {
    const events = armPool({ epoch: 130 }); // age 7 at epoch 137
    const poolIds = new Set(events.map((e) => e.id));
    const report = evaluateBmuArmGate({ corpus: { events }, poolIds, epochId: 137, freshWindow: 2, posture: 'arm' });
    assert.equal(report.ok, false);
    assert.ok(report.reasons.some((r) => r.includes('fresh clusters')), report.reasons.join('; '));
  });

  test('BOOT posture (P3-R1 BLOCKER-1): structural census only — stale mints stay LIVE', () => {
    // Same stale pool the arm posture refuses: boot must accept it (post-arm
    // steady state has no fresh mints ~6 of 8 epochs at cadence 8).
    const events = armPool({ epoch: 130 });
    const poolIds = new Set(events.map((e) => e.id));
    const report = evaluateBmuArmGate({ corpus: { events }, poolIds, epochId: 137, freshWindow: 2, posture: 'boot' });
    assert.equal(report.ok, true, report.reasons.join('; '));
    assert.equal(report.posture, 'boot');
    // Boot still refuses STRUCTURAL failures: counts below minima…
    const short = events.filter((e) => e.bmuTask.motifGroupId !== 'mg_temporal_0');
    const r2 = evaluateBmuArmGate({ corpus: { events: short }, poolIds: new Set(short.map((e) => e.id)), epochId: 137, posture: 'boot' });
    assert.equal(r2.ok, false);
    // …and global m=1 violations.
    const dup = [...events];
    const idx = dup.findIndex((e) => e.bmuTask.family === 'conflict_lifecycle');
    dup[idx] = { ...dup[idx], subjectEntityId: 'ent_temporal_0' };
    const r3 = evaluateBmuArmGate({ corpus: { events: dup }, poolIds: new Set(dup.map((e) => e.id)), epochId: 137, posture: 'boot' });
    assert.equal(r3.ok, false);
    assert.ok(r3.multiplicityViolations.length > 0);
  });

  test('GLOBAL m=1 census: a TEMPLATE shared ACROSS FAMILIES is a violation (P3-R1 MINOR)', () => {
    const events = armPool();
    const a = events.findIndex((e) => e.bmuTask.family === 'temporal');
    const b = events.findIndex((e) => e.bmuTask.family === 'multi_hop_relation');
    events[b] = { ...events[b], bmuTask: { ...events[b].bmuTask, templateId: events[a].bmuTask.templateId } };
    const poolIds = new Set(events.map((e) => e.id));
    const report = evaluateBmuArmGate({ corpus: { events }, poolIds, epochId: 137, posture: 'arm' });
    assert.equal(report.ok, false);
    assert.ok(report.multiplicityViolations.some((v) => v.includes('templateId')), report.multiplicityViolations.join('; '));
  });

  test('GLOBAL m=1 census: a subject shared ACROSS FAMILIES is a violation (rev3.2)', () => {
    const events = armPool();
    // Reuse a temporal subject inside a conflict cluster — per-family census
    // would miss this; the GLOBAL census must not.
    const idx = events.findIndex((e) => e.bmuTask.family === 'conflict_lifecycle');
    events[idx] = { ...events[idx], subjectEntityId: 'ent_temporal_0' };
    const poolIds = new Set(events.map((e) => e.id));
    const report = evaluateBmuArmGate({ corpus: { events }, poolIds, epochId: 137, posture: 'arm' });
    assert.equal(report.ok, false);
    assert.ok(report.multiplicityViolations.some((v) => v.includes('ent_temporal_0')), report.multiplicityViolations.join('; '));
  });

  test('m=1 census: a template in two clusters is a violation', () => {
    const events = armPool();
    const a = events.findIndex((e) => e.bmuTask.motifGroupId === 'mg_temporal_0');
    const b = events.findIndex((e) => e.bmuTask.motifGroupId === 'mg_temporal_1');
    events[b] = { ...events[b], bmuTask: { ...events[b].bmuTask, templateId: events[a].bmuTask.templateId } };
    const poolIds = new Set(events.map((e) => e.id));
    const report = evaluateBmuArmGate({ corpus: { events }, poolIds, epochId: 137, posture: 'arm' });
    assert.equal(report.ok, false);
    assert.ok(report.multiplicityViolations.some((v) => v.includes('templateId')), report.multiplicityViolations.join('; '));
  });
});

describe('§6.7b variance certification (rev3.1 pinned procedure)', () => {
  test('seed schedule is deterministic, domain-separated, and bounds-checked', () => {
    const s0 = bmuArmVarianceSeedHex(137, 'parent', 0);
    assert.match(s0, /^0x[0-9a-f]{64}$/);
    assert.equal(s0, bmuArmVarianceSeedHex(137, 'parent', 0));
    assert.notEqual(s0, bmuArmVarianceSeedHex(137, 'blank', 0));
    assert.notEqual(s0, bmuArmVarianceSeedHex(137, 'parent', 1));
    assert.notEqual(s0, bmuArmVarianceSeedHex(138, 'parent', 0));
    assert.throws(() => bmuArmVarianceSeedHex(137, 'parent', BMU_ARM_VARIANCE_RUNS));
    assert.throws(() => bmuArmVarianceSeedHex(137, 'candidate', 0));
  });

  test('certification passes on flip-stable scores and records both spreads', () => {
    const cert = buildBmuArmVarianceCertification({
      epochId: 137,
      scoresPpm: { parent: [250000, 250000, 250000, 250000, 250000], blank: [93750, 93750, 93750, 93750, 93750] },
    });
    assert.equal(cert.K, BMU_ARM_VARIANCE_RUNS);
    assert.deepEqual(cert.states, ['parent', 'blank']);
    assert.equal(cert.spreadPpm.parent, 0);
    assert.equal(cert.seeds.parent.length, 5);
    assert.equal(cert.seeds.parent[3], bmuArmVarianceSeedHex(137, 'parent', 3));
  });

  test('a single row flip (spread ≥ q/2) FAILS certification — the bundle must not arm', () => {
    assert.throws(() => buildBmuArmVarianceCertification({
      epochId: 137,
      scoresPpm: { parent: [250000, 250000, 250000, 250000, 265625], blank: [0, 0, 0, 0, 0] },
    }), /certification FAILED/);
    // boundary: spread exactly 7,812 is refused (strict <)
    assert.throws(() => buildBmuArmVarianceCertification({
      epochId: 137,
      scoresPpm: { parent: [0, 0, 0, 0, BMU_ARM_VARIANCE_MAX_SPREAD_PPM], blank: [0, 0, 0, 0, 0] },
    }), /certification FAILED/);
    // spread 7,811 passes
    assert.doesNotThrow(() => buildBmuArmVarianceCertification({
      epochId: 137,
      scoresPpm: { parent: [0, 0, 0, 0, BMU_ARM_VARIANCE_MAX_SPREAD_PPM - 1], blank: [0, 0, 0, 0, 0] },
    }));
  });

  test('wrong K fails closed', () => {
    assert.throws(() => buildBmuArmVarianceCertification({
      epochId: 137,
      scoresPpm: { parent: [0, 0, 0, 0], blank: [0, 0, 0, 0, 0] },
    }), /K=5/);
  });
});

describe('exclusion-set digest', () => {
  test('order-independent, content-sensitive', () => {
    const a = bmuExclusionSetDigest(['motif:m1', 'subject:s1', 'template:t1']);
    const b = bmuExclusionSetDigest(new Set(['template:t1', 'motif:m1', 'subject:s1']));
    assert.equal(a, b);
    assert.notEqual(a, bmuExclusionSetDigest(['motif:m1', 'subject:s1']));
    assert.match(bmuExclusionSetDigest([]), /^0x[0-9a-f]{64}$/);
  });
});
