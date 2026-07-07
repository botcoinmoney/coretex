/**
 * Track-A2 unbrick bundle + bounded age-based retirement.
 *
 * Covers:
 *  - epoch-frontier: finite maxAge retirement is a BOUNDED per-epoch drain
 *    (oldest-first, capped at maxRootDeltaPerEpoch) that shares the root-delta
 *    budget with churn — never a whole-cohort spike; Infinity/absent maxAge is
 *    byte-identical to the historical law.
 *  - bundle validation: epochFrontier.maxAge accepts null / positive integers
 *    and fails closed on zero, negatives, and non-integers.
 *  - the committed A2 candidate bundle: identical to the live liveeval8 bundle
 *    except the three sanctioned fields (liveEvalPack.limit 8->12,
 *    familyPriority opened to all four quota families' logicalFamily names,
 *    maxAge null->32) plus the recomputed bundleHash; limit sits exactly at the
 *    validated ceiling packSize - quota reservation.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeEpochFrontier,
  verifyBundleManifest,
  withRecomputedBundleHash,
} from '../../dist/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CAL_DIR = 'release/calibration/2026-06-04-memory-atom-v16';
const SRC_BUNDLE = resolve(REPO_ROOT, CAL_DIR,
  'bundle-manifest-v2-dgen1-policy-r5-atom-v16-300k-enabled-mirfull-temporal-conflict-motif-liveeval8.json');
const A2_BUNDLE = resolve(REPO_ROOT, CAL_DIR,
  'bundle-manifest-v2-dgen1-policy-r5-atom-v16-300k-enabled-mirfull-temporal-conflict-motif-liveeval12-allfam-age32.json');

const familyOf = (id) => id.split(':')[0];

function frontierWith({ maxAge, maxRootDeltaPerEpoch = 4, n = 40, activeWindow = 30 }) {
  const ids = [];
  for (let i = 0; i < n; i += 1) ids.push(`fam${i % 4}:${String(i).padStart(3, '0')}`);
  return makeEpochFrontier({
    evalHiddenIds: ids,
    familyOf,
    mode: 'C3',
    activeWindow,
    minChurn: 2,
    maxChurn: 12,
    maxRootDeltaPerEpoch,
    maxAge,
    seed: 'a2-test',
  });
}

describe('epoch frontier: bounded age-based retirement (A2)', () => {
  test('a shared-activation cohort past maxAge drains at <= maxRootDeltaPerEpoch per epoch, not in one spike', () => {
    const f = frontierWith({ maxAge: 5, maxRootDeltaPerEpoch: 4, n: 40, activeWindow: 30 });
    const s0 = f.stepEpoch(0, null, null); // activates 30 rows at epoch 0
    assert.equal(s0.activeEvalHiddenCount, 30);
    // Jump far past maxAge: ALL 30 active rows are age-eligible at once.
    const s = f.stepEpoch(100, 0, 0);
    assert.equal(s.retired, 4, 'aged retirement must be capped at maxRootDeltaPerEpoch');
    assert.equal(s.activeEvalHiddenCount, 30 - 4 + s.activated);
    const s2 = f.stepEpoch(101, 0, 0);
    assert.equal(s2.retired, 4, 'drain continues at the bounded rate on subsequent epochs');
  });

  test('aged rows leave within maxAge epochs when the aged backlog is under the per-epoch cap', () => {
    const f = frontierWith({ maxAge: 3, maxRootDeltaPerEpoch: 24, n: 12, activeWindow: 4 });
    const s0 = f.stepEpoch(0, null, null);
    const cohort = [...s0.activeIds];
    assert.equal(cohort.length, 4);
    f.stepEpoch(1, 0, 0);
    f.stepEpoch(2, 0, 0);
    const s3 = f.stepEpoch(3, 0, 0); // cohort age = 3 = maxAge; backlog 4 < cap 24
    assert.equal(s3.retired, 4, 'every aged row retires the epoch it reaches maxAge');
    for (const id of cohort) assert.ok(!s3.activeIds.has(id), `${id} must have left the active window`);
    assert.equal(s3.activated, 4, 'retirements are backfilled from the reserve');
  });

  test('aged retirement consumes the churn budget: total retirements never exceed maxRootDeltaPerEpoch', () => {
    const f = frontierWith({ maxAge: 5, maxRootDeltaPerEpoch: 4, n: 40, activeWindow: 20 });
    f.stepEpoch(0, null, null);
    // Inject reserve work so C3 wants churn in the same epoch the age drain bites.
    assert.equal(f.addReserveIds(['fresh:a', 'fresh:b', 'fresh:c'], familyOf), 3);
    const s = f.stepEpoch(100, 0, 0);
    assert.ok(s.retired <= 4, `aged+churn retirements ${s.retired} must fit the shared budget 4`);
    assert.ok(s.activated <= 4, `activations ${s.activated} must fit the shared budget 4`);
  });

  test('oldest activation epochs retire first (deterministic drain order)', () => {
    const f = frontierWith({ maxAge: 3, maxRootDeltaPerEpoch: 2, n: 12, activeWindow: 4 });
    const s0 = f.stepEpoch(0, null, null);
    const cohort0 = new Set(s0.activeIds);
    // Epoch 3: all 4 epoch-0 rows are aged; cap 2 => exactly 2 retire, 2 fresh
    // reserve rows activate at epoch 3.
    const s3 = f.stepEpoch(3, 0, 0);
    assert.equal(s3.retired, 2);
    const survivors0 = [...s3.activeIds].filter((id) => cohort0.has(id));
    assert.equal(survivors0.length, 2, 'exactly half the aged cohort drains under cap 2');
    // Epoch 4: the epoch-0 survivors (age 4) drain BEFORE the epoch-3 rows (age 1).
    const s4 = f.stepEpoch(4, 0, 0);
    assert.equal(s4.retired, 2);
    assert.equal([...s4.activeIds].filter((id) => cohort0.has(id)).length, 0,
      'oldest cohort fully drained before any younger row is age-retired');
  });

  test('forced active prunes get headroom: evolve with 1 pruned id + full aged backlog still fits the runner root-delta check', () => {
    // Mirrors scripts/coretex-epoch-evolve.mjs makeFrontier defense-in-depth:
    // rootDelta = max(activated, retired + prunedActive) must be <= maxRootDeltaPerEpoch,
    // or the rotation is REFUSED. During a saturated aged drain the step must
    // therefore leave prunes headroom instead of spending the whole budget.
    const maxRootDeltaPerEpoch = 4;
    const f = frontierWith({ maxAge: 5, maxRootDeltaPerEpoch, n: 40, activeWindow: 30 });
    f.stepEpoch(0, null, null); // 30 rows active at epoch 0 => full aged backlog at epoch 100
    // Injected reserve work so churn ALSO wants budget in the same evolve.
    assert.equal(f.addReserveIds(['fresh:a', 'fresh:b'], familyOf), 2);
    const prunedActive = 1;
    const s = f.stepEpoch(100, 0, 0, prunedActive);
    const runnerRootDelta = Math.max(s.activated, s.retired + prunedActive);
    assert.ok(s.retired <= maxRootDeltaPerEpoch - prunedActive,
      `retired ${s.retired} must leave headroom for ${prunedActive} pruned active id(s)`);
    assert.ok(runnerRootDelta <= maxRootDeltaPerEpoch,
      `runner check max(activated=${s.activated}, retired=${s.retired}+pruned=${prunedActive}) = ${runnerRootDelta} must pass`);
    // Drain still progresses (bounded, not stalled).
    assert.ok(s.retired > 0, 'aged drain must still progress under prune headroom');
    // prunedActive >= budget: no further retirement (never negative); prune
    // backfill is capped at the budget — the runner check refuses such a
    // rotation anyway (the prune count alone exceeds maxRootDeltaPerEpoch).
    const s2 = f.stepEpoch(101, 0, 0, maxRootDeltaPerEpoch + 3);
    assert.equal(s2.retired, 0);
    assert.equal(s2.activated, maxRootDeltaPerEpoch);
  });

  test('pruned active rows are backfilled from the reserve (prune-to-empty hole closed)', () => {
    // Pruning happens OUTSIDE stepEpoch (pruneEpochFrontierState), so pruned
    // actives used to vanish without a paired activation: prune away the whole
    // active window and the frontier stayed permanently EMPTY despite a full
    // reserve (observed in the evolve continuity fixture at epoch 2). The step
    // now backfills the pruned count from the reserve.
    const ids = [];
    for (let i = 0; i < 10; i += 1) ids.push(`fam${i % 4}:${String(i).padStart(3, '0')}`);
    const prunedState = {
      schemaVersion: 'coretex.epoch-frontier-state.v1',
      order: ids,
      reservePtr: 0,
      active: [], // both previously-active rows were pruned out of the state
      retired: [],
      cumulativeActivated: 2,
      cumulativeRetired: 0,
      initialized: true,
      injectedSinceLastStep: 0,
      ewmaAccepts: null,
    };
    const f = makeEpochFrontier({
      evalHiddenIds: ids,
      familyOf,
      mode: 'C3',
      activeWindow: 2,
      minChurn: 2,
      maxChurn: 12,
      maxRootDeltaPerEpoch: 4,
      maxAge: Infinity,
      seed: 'a2-test',
      initialState: prunedState,
    });
    const prunedActive = 2;
    const s = f.stepEpoch(1, 0, 0, prunedActive);
    assert.equal(s.activated, prunedActive, 'pruned actives are backfilled from the reserve');
    assert.equal(s.activeEvalHiddenCount, 2, 'active window restored after the prune');
    assert.ok(Math.max(s.activated, s.retired + prunedActive) <= 4, 'runner root-delta check still passes');
  });

  test('maxAge Infinity (historical law) never age-retires', () => {
    const f = frontierWith({ maxAge: Infinity, maxRootDeltaPerEpoch: 4, n: 20, activeWindow: 10 });
    f.stepEpoch(0, null, null);
    const s = f.stepEpoch(1000, 0, 0);
    assert.equal(s.retired, 0);
    assert.equal(s.activeEvalHiddenCount, 10);
  });
});

describe('bundle validation: epochFrontier.maxAge (A2)', () => {
  const baseManifest = () => JSON.parse(readFileSync(A2_BUNDLE, 'utf8'));
  const maxAgeErrors = (manifest) =>
    verifyBundleManifest(manifest, REPO_ROOT).filter((e) => /maxAge/i.test(e));

  test('accepts the committed finite maxAge', () => {
    assert.deepEqual(maxAgeErrors(baseManifest()), []);
  });

  test('accepts null (retirement disabled, the liveeval8 law)', () => {
    const m = baseManifest();
    m.evaluator.profile.epochFrontier.maxAge = null;
    assert.deepEqual(maxAgeErrors(m), []);
  });

  for (const bad of [0, -1, 1.5, '32']) {
    test(`fails closed on maxAge ${JSON.stringify(bad)}`, () => {
      const m = baseManifest();
      m.evaluator.profile.epochFrontier.maxAge = bad;
      const errs = maxAgeErrors(m);
      assert.equal(errs.length, 1, `expected one maxAge error, got ${JSON.stringify(errs)}`);
    });
  }
});

describe('A2 unbrick candidate bundle — identical except the three sanctioned fields', () => {
  const src = JSON.parse(readFileSync(SRC_BUNDLE, 'utf8'));
  const a2 = JSON.parse(readFileSync(A2_BUNDLE, 'utf8'));

  test('bundleHash is recomputed and self-consistent', () => {
    assert.notEqual(a2.bundleHash, src.bundleHash);
    assert.equal(withRecomputedBundleHash(a2).bundleHash, a2.bundleHash);
  });

  test('liveEvalPack.limit sits exactly at the validated ceiling (packSize - quota reservation)', () => {
    const hp = a2.evaluator.profile.hiddenPack;
    const quotaSum = hp.quotas.reduce((acc, q) => acc + q.minCount, 0);
    assert.equal(quotaSum, 52);
    assert.equal(hp.packSize - quotaSum, 12);
    assert.equal(a2.evaluator.profile.epochFrontier.liveEvalPack.limit, 12);
    const errs = verifyBundleManifest(a2, REPO_ROOT).filter((e) => /liveEvalPack/i.test(e));
    assert.deepEqual(errs, []);
  });

  test('familyPriority covers all four quota families via logicalFamily names', () => {
    const fp = a2.evaluator.profile.epochFrontier.liveEvalPack.familyPriority;
    assert.deepEqual(fp, [
      'temporal_update',
      'conflict_lifecycle',
      'multi_session_bridge',
      'abstention_missing',
      'causal_memory_chain',
      'entity_resolution_atom',
      'decision_provenance',
      'scope_atom',
      'validity_atom',
    ]);
  });

  test('every field outside the three sanctioned pins is byte-identical to liveeval8', () => {
    const norm = (m) => {
      const c = JSON.parse(JSON.stringify(m));
      delete c.bundleHash;
      delete c.evaluator.profile.epochFrontier.maxAge;
      delete c.evaluator.profile.epochFrontier.liveEvalPack;
      return c;
    };
    assert.deepEqual(norm(a2), norm(src));
    assert.equal(a2.evaluator.profile.epochFrontier.maxAge, 32);
    assert.equal(src.evaluator.profile.epochFrontier.maxAge, null);
  });
});

describe('arm-liveeval-bundle guard: finite maxAge requires a nonzero fresh-mint floor', () => {
  const ARM = resolve(REPO_ROOT, 'scripts/arm-liveeval-bundle.mjs');
  const A2_FAMILY_PRIORITY = 'temporal_update,conflict_lifecycle,multi_session_bridge,abstention_missing,causal_memory_chain,entity_resolution_atom,decision_provenance,scope_atom,validity_atom';
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'a2-arm-guard-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  const runArm = (args) => spawnSync(process.execPath, [ARM, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  const doctored = (name, mutate) => {
    const m = JSON.parse(readFileSync(SRC_BUNDLE, 'utf8'));
    mutate(m.evaluator.profile);
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
    return p;
  };

  test('refuses --max-age when the source profile pins minFreshEvalHiddenPerEpoch = 0', () => {
    const src = doctored('zero-floor.json', (p) => { p.evolve = { minFreshEvalHiddenPerEpoch: 0 }; });
    const r = runArm(['--bundle', src, '--out', join(dir, 'zero-floor-armed.json'), '--limit', '12', '--family-priority', 'temporal_update', '--max-age', '32']);
    assert.equal(r.status, 1, `expected refusal, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /zero fresh-mint floor|minFreshEvalHiddenPerEpoch=0/);
  });

  test('refuses a source bundle that ALREADY pins finite maxAge + zero mint floor, even without --max-age', () => {
    const src = doctored('inherited-finite-maxage-zero-floor.json', (p) => {
      p.epochFrontier = { ...p.epochFrontier, maxAge: 32 };
      p.evolve = { minFreshEvalHiddenPerEpoch: 0 };
    });
    const r = runArm(['--bundle', src, '--out', join(dir, 'inherited-armed.json'), '--limit', '12', '--family-priority', 'temporal_update']);
    assert.equal(r.status, 1, `expected refusal, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /zero fresh-mint floor|minFreshEvalHiddenPerEpoch=0/);
  });

  test('finite maxAge + an explicit mint floor >= 1 is allowed', () => {
    const src = doctored('floor-8.json', (p) => { p.evolve = { minFreshEvalHiddenPerEpoch: 8 }; });
    const out = join(dir, 'floor-8-armed.json');
    const r = runArm(['--bundle', src, '--out', out, '--limit', '12', '--family-priority', 'temporal_update', '--max-age', '32']);
    assert.equal(r.status, 0, `expected success, got ${r.status}\n${r.stderr}`);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).evaluator.profile.epochFrontier.maxAge, 32);
  });

  test('normal path unaffected: regenerating from the pristine source reproduces the committed A2 bundleHash', () => {
    const out = join(dir, 'regen-a2.json');
    const r = runArm(['--bundle', SRC_BUNDLE, '--out', out, '--limit', '12', '--family-priority', A2_FAMILY_PRIORITY, '--max-age', '32']);
    assert.equal(r.status, 0, `expected success, got ${r.status}\n${r.stderr}`);
    const committed = JSON.parse(readFileSync(A2_BUNDLE, 'utf8'));
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).bundleHash, committed.bundleHash,
      'deterministic regeneration must reproduce the committed bundleHash');
  });
});
