import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  FORBIDDEN_PRODUCTION_RUNNER_FLAGS,
  churnSearchCandidates,
  estimateWithinBudgets,
  frontierCount,
  metricsRequiredForEpoch,
  mergeCoordinatorEpochMetrics,
  readinessCheckedItems,
  selectBudgetedChurn,
  shouldDeriveParentStateRootFromChain,
  validateCoordinatorEpochMetrics,
} from '../../../../scripts/coretex-coordinator-epoch-runner.mjs';

const runnerPath = resolve(fileURLToPath(import.meta.url), '../../../../../scripts/coretex-coordinator-epoch-runner.mjs');

describe('coretex coordinator epoch runner metrics merge', () => {
  test('missing CLI flags do not erase metrics-file counters', () => {
    const merged = mergeCoordinatorEpochMetrics({
      prevHonestAccepts: 7,
      prevQualityAttempts: 19,
      acceptedFingerprintReusePpm: 780_000,
    }, ['--epoch', '2']);

    assert.equal(merged.prevHonestAccepts, 7);
    assert.equal(merged.prevQualityAttempts, 19);
    assert.equal(merged.acceptedFingerprintReusePpm, 780_000);
  });

  test('explicit CLI flags override metrics-file counters', () => {
    const merged = mergeCoordinatorEpochMetrics({
      prevHonestAccepts: 7,
      prevQualityAttempts: 19,
    }, ['--prev-honest-accepts', '2', '--prev-quality-attempts', '3']);

    assert.equal(merged.prevHonestAccepts, 2);
    assert.equal(merged.prevQualityAttempts, 3);
  });

  test('missing metrics default to zero only when neither file nor flag supplies them', () => {
    const merged = mergeCoordinatorEpochMetrics({}, []);
    assert.equal(merged.prevHonestAccepts, 0);
    assert.equal(merged.prevQualityAttempts, 0);
  });

  test('frontier counts accept current numeric evolve output and old array output', () => {
    assert.equal(frontierCount(17), 17);
    assert.equal(frontierCount(['a', 'b', 'c']), 3);
    assert.equal(frontierCount(undefined), 0);
  });
});

describe('coretex coordinator epoch runner metrics validation (provenance + freshness)', () => {
  const NOW = Date.parse('2026-06-09T12:00:00Z');
  const fresh = (overrides = {}) => ({
    schema: 'coretex.coordinator-epoch-metrics.v1',
    epoch: 1,
    generatedAt: '2026-06-09T11:00:00Z',
    prevHonestAccepts: 3,
    prevQualityAttempts: 17,
    ...overrides,
  });

  test('fresh metrics with pinned schema for the completed epoch pass', () => {
    assert.equal(validateCoordinatorEpochMetrics(fresh(), { epoch: 2, nowMs: NOW }), null);
  });

  test('foreign provenance schema is rejected', () => {
    assert.match(
      validateCoordinatorEpochMetrics(fresh({ schema: 'something-else' }), { epoch: 2, nowMs: NOW }),
      /provenance schema/,
    );
    assert.match(validateCoordinatorEpochMetrics({}, { epoch: 2, nowMs: NOW }), /provenance schema/);
  });

  test('metrics for the wrong epoch are rejected (not silently zeroed)', () => {
    assert.match(
      validateCoordinatorEpochMetrics(fresh({ epoch: 5 }), { epoch: 2, nowMs: NOW }),
      /epoch 5.*completed-epoch 1/,
    );
  });

  test('stale generatedAt outside the freshness window is rejected', () => {
    assert.match(
      validateCoordinatorEpochMetrics(fresh({ generatedAt: '2026-06-07T11:00:00Z' }), { epoch: 2, nowMs: NOW }),
      /stale telemetry/,
    );
  });

  test('missing generatedAt falls back to file mtime; no timestamp at all is rejected', () => {
    const noTimestamp = fresh({ generatedAt: undefined });
    assert.equal(validateCoordinatorEpochMetrics(noTimestamp, { epoch: 2, nowMs: NOW, mtimeMs: NOW - 1000 }), null);
    assert.match(
      validateCoordinatorEpochMetrics(noTimestamp, { epoch: 2, nowMs: NOW, mtimeMs: NOW - 48 * 3600 * 1000 }),
      /stale telemetry/,
    );
    assert.match(
      validateCoordinatorEpochMetrics(noTimestamp, { epoch: 2, nowMs: NOW }),
      /no parseable generatedAt/,
    );
  });
});

describe('coretex coordinator epoch runner readiness honesty', () => {
  test('root_continuity_verified is only reported when the parent root was chain-verified', () => {
    const unchecked = readinessCheckedItems({
      baselineBindsRotation: true,
      parentRootChainVerified: false,
      s3GetRehashVerified: false,
    });
    assert.ok(!unchecked.includes('root_continuity_verified'));
    assert.ok(!unchecked.includes('parent_state_root_chain_verified'));
    assert.ok(!unchecked.includes('s3_upload_get_rehash_verified'));
    assert.ok(!unchecked.some((item) => item.includes('head_verified')));

    const checked = readinessCheckedItems({
      baselineBindsRotation: true,
      parentRootChainVerified: true,
      s3GetRehashVerified: true,
    });
    assert.ok(checked.includes('root_continuity_verified'));
    assert.ok(checked.includes('parent_state_root_chain_verified'));
    assert.ok(checked.includes('s3_upload_get_rehash_verified'));
  });

  test('baseline binding is only reported when the hashes actually bind', () => {
    const items = readinessCheckedItems({
      baselineBindsRotation: false,
      parentRootChainVerified: true,
      s3GetRehashVerified: false,
    });
    assert.ok(!items.includes('baseline_manifest_hash_binds_rotation_manifest'));
  });
});

describe('coretex coordinator epoch runner evolve budget planner', () => {
  test('churn candidates descend from telemetry choice to minimum', () => {
    assert.deepEqual(churnSearchCandidates({
      chosenChurnFraction: 0.1,
      minChurnFraction: 0.05,
    }, 2), [0.1, 0.075, 0.05]);
  });

  test('default churn search is capped for hot cutover preflight', () => {
    assert.deepEqual(churnSearchCandidates({
      chosenChurnFraction: 0.1,
      minChurnFraction: 0.04,
    }), [0.1, 0.08, 0.06, 0.04]);
  });

  test('single-candidate churn search estimates only the chosen churn', () => {
    assert.deepEqual(churnSearchCandidates({
      chosenChurnFraction: 0.1,
      minChurnFraction: 0.04,
    }, 0), [0.1]);
  });

  test('planner lowers churn when the telemetry choice exceeds embedding budget', () => {
    const plans = [
      { churnFraction: 0.1, estimate: { estimatedEmbeddings: 420, removedIds: 2, freshEvalHidden: 8 } },
      { churnFraction: 0.075, estimate: { estimatedEmbeddings: 280, removedIds: 2, freshEvalHidden: 8 } },
      { churnFraction: 0.05, estimate: { estimatedEmbeddings: 180, removedIds: 1, freshEvalHidden: 8 } },
    ];

    assert.equal(estimateWithinBudgets(plans[0].estimate, { maxEmbeddings: 300, targetFreshHidden: 8 }), false);
    const selected = selectBudgetedChurn(plans, { maxEmbeddings: 300, maxRemovals: 4, maxRootDeltaPerEpoch: 8, targetFreshHidden: 8 });

    assert.equal(selected.ok, true);
    assert.equal(selected.plan.churnFraction, 0.075);
  });

  test('planner rejects estimates that exceed hidden root-delta budget', () => {
    assert.equal(estimateWithinBudgets(
      { estimatedEmbeddings: 10, removedIds: 2, removedEvalHiddenIds: 25, freshEvalHidden: 8, rootDeltaPressure: 25 },
      { maxEmbeddings: 100, maxRemovals: 10, maxRootDeltaPerEpoch: 24, targetFreshHidden: 8 },
    ), false);
  });

  test('planner skips first root-delta overbudget candidate and selects the next candidate', () => {
    const plans = [
      {
        churnFraction: 0.02,
        estimate: {
          estimatedEmbeddings: 220,
          removedIds: 8,
          removedEvalHiddenIds: 32,
          freshEvalHidden: 8,
          rootDeltaPressure: 32,
        },
      },
      {
        churnFraction: 0.002,
        estimate: {
          estimatedEmbeddings: 113,
          removedIds: 0,
          removedEvalHiddenIds: 0,
          freshEvalHidden: 8,
          rootDeltaPressure: 8,
        },
      },
    ];

    const selected = selectBudgetedChurn(plans, {
      maxEmbeddings: 240,
      maxRemovals: 12,
      maxRootDeltaPerEpoch: 24,
      targetFreshHidden: 8,
    });

    assert.equal(selected.ok, true);
    assert.equal(selected.plan.churnFraction, 0.002);
  });
});

describe('coretex coordinator epoch runner launch genesis guards', () => {
  test('prior-epoch metrics are required after genesis except for explicit launch genesis', () => {
    assert.equal(metricsRequiredForEpoch(1, false), false);
    assert.equal(metricsRequiredForEpoch(2, false), true);
    assert.equal(metricsRequiredForEpoch(112, false), true);
    assert.equal(metricsRequiredForEpoch(112, true), false);
  });

  test('explicit launch parent root is not replaced by a previous chain epoch read', () => {
    assert.equal(shouldDeriveParentStateRootFromChain({
      rpcUrl: 'https://example.invalid',
      registry: '0x' + '11'.repeat(20),
      parentStateRoot: '0x' + '22'.repeat(32),
      launchGenesis: true,
    }), false);
    assert.equal(shouldDeriveParentStateRootFromChain({
      rpcUrl: 'https://example.invalid',
      registry: '0x' + '11'.repeat(20),
      parentStateRoot: '0x' + '22'.repeat(32),
      launchGenesis: false,
    }), true);
    assert.equal(shouldDeriveParentStateRootFromChain({
      rpcUrl: 'https://example.invalid',
      registry: '0x' + '11'.repeat(20),
      parentStateRoot: null,
      launchGenesis: true,
    }), true);
  });
});

describe('coretex coordinator epoch runner production dev-flag rejection', () => {
  test('every forbidden dev flag is rejected outright (hard error, not silent drop)', () => {
    assert.deepEqual(FORBIDDEN_PRODUCTION_RUNNER_FLAGS, [
      'allow-dev-key',
      'allow-frontier-bootstrap',
      'allow-missing-parent-state-root',
      'skip-previous-root-verify',
      'skip-previous-split-verify',
    ]);
    for (const name of FORBIDDEN_PRODUCTION_RUNNER_FLAGS) {
      const r = spawnSync(process.execPath, [runnerPath, `--${name}`, '--epoch', '2'], { encoding: 'utf8' });
      assert.equal(r.status, 1, `--${name} must hard-fail`);
      assert.match(r.stderr, new RegExp(`--${name} is forbidden`));
    }
  });

  test('--mock-embeddings without --allow-mock-embeddings is rejected', () => {
    const r = spawnSync(process.execPath, [runnerPath, '--mock-embeddings', '--epoch', '2'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--mock-embeddings requires --allow-mock-embeddings/);
  });

  test('production runner requires explicit evolve budgets', () => {
    const r = spawnSync(process.execPath, [
      runnerPath,
      '--epoch', '1',
      '--parent-state-root', '0x' + '11'.repeat(32),
    ], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires explicit evolve budgets/);
  });

  test('production runner rejects zero wall-clock budget', () => {
    const r = spawnSync(process.execPath, [
      runnerPath,
      '--epoch', '1',
      '--parent-state-root', '0x' + '11'.repeat(32),
      '--max-embeddings', '1',
      '--max-removals', '0',
      '--target-fresh-hidden', '0',
      '--max-wall-ms', '0',
      '--retraction-fraction', '0',
      '--hidden-retire-horizon', '999999',
      '--max-root-delta-per-epoch', '24',
    ], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--max-wall-ms must be a positive integer/);
  });
});
