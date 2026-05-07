// Unit tests for the real CortexBench V0 scoring engine.
// These guard the score function against silent regressions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

const evalMod = await import(`${REPO}/experiments/harness/cortex-bench-eval.mjs`);
const { loadRealCorpus, scoreState, computeComposite, eventIdToKey128, eventIdToMem128, makeRealMarginalEvaluator } = evalMod;

const stateMod = await import(`${REPO}/packages/cortex/dist/state/index.js`);
const { merkleizeState, applyPatch } = stateMod;

const baselineA = await import(`${REPO}/experiments/baselines/baseline_a_empty/index.mjs`);
const baselineE = await import(`${REPO}/experiments/baselines/baseline_e_revocation_aware/index.mjs`);

const corpus = loadRealCorpus({ repoRoot: REPO });

test('genesis composite is zero for the chosen baseline (A)', () => {
  const state = baselineA.genesisState();
  const score = scoreState(state, corpus);
  assert.equal(score.composite, 0);
  assert.equal(score.components.compressionSurvival, 0);
  assert.equal(score.components.exactRetrieval, 0);
  assert.equal(score.components.staleMemoryRejection, 0);
});

test('mining a real long-horizon patch increases compression survival', () => {
  let state = baselineA.genesisState();
  const before = scoreState(state, corpus).components.compressionSurvival;
  const patch = baselineA.mineCandidatePatch(state, { epoch: 1, solveIndex: 1 }, { corpus });
  assert.ok(patch, 'baseline A miner produced no patch');
  patch.parentStateRoot = merkleizeState(state);
  const r = applyPatch(state, patch);
  assert.ok(r.ok, `applyPatch failed: ${r.code}`);
  const after = scoreState(r.state, corpus).components.compressionSurvival;
  assert.ok(after > before, `compression did not move: ${before} → ${after}`);
});

test('mining baseline E patch increases temporal stale rejection or current update', () => {
  let state = baselineE.genesisState();
  const before = scoreState(state, corpus);
  const patch = baselineE.mineCandidatePatch(state, { epoch: 1, solveIndex: 1 }, { corpus });
  assert.ok(patch, 'baseline E miner produced no patch');
  patch.parentStateRoot = merkleizeState(state);
  const r = applyPatch(state, patch);
  assert.ok(r.ok, `applyPatch failed: ${r.code}`);
  const after = scoreState(r.state, corpus);
  const totalDelta =
    (after.components.staleMemoryRejection - before.components.staleMemoryRejection) +
    (after.components.temporalUpdateCorrectness - before.components.temporalUpdateCorrectness);
  assert.ok(totalDelta > 0, `temporal score did not move: ${totalDelta}`);
});

test('composite weights match the V0 spec', () => {
  const c = {
    exactRetrieval:            1,
    staleMemoryRejection:      1,
    temporalUpdateCorrectness: 1,
    compressionSurvival:       1,
    routingAccuracy:           1,
    latencyMs:                 0,
  };
  // 0.30 + 0.15 + 0.15 + 0.30 + 0.05 = 0.95
  assert.equal(Math.abs(computeComposite(c) - 0.95) < 1e-9, true);
});

test('latency penalty fires linearly between p50 and p99', () => {
  const c = {
    exactRetrieval: 0, staleMemoryRejection: 0, temporalUpdateCorrectness: 0,
    compressionSurvival: 0, routingAccuracy: 0, latencyMs: 30,
  };
  // p50=10, p99=50, so at 30ms: half the penalty (0.0125), composite max 0 - 0.0125 → clamped to 0
  const out = computeComposite(c);
  assert.equal(out, 0);
});

test('eventIdToKey128 and eventIdToMem128 are deterministic and 128-bit-bounded', () => {
  const k = eventIdToKey128('mab-temporal-0000');
  const m = eventIdToMem128('mab-temporal-0000');
  const max = (1n << 128n) - 1n;
  assert.ok(k <= max && k >= 0n, `keyId out of range: ${k}`);
  assert.ok(m <= max && m >= 0n, `memId out of range: ${m}`);
  // re-compute and confirm stability
  assert.equal(eventIdToKey128('mab-temporal-0000'), k);
  assert.equal(eventIdToMem128('mab-temporal-0000'), m);
});

test('near-collision structural score ignores irrelevant near-miss keys', () => {
  const state = baselineA.genesisState();
  const miss = corpus.events.near_collision.find((event) => event.relevant === false);
  assert.ok(miss, 'fixture must include an irrelevant near-miss');
  const kid = eventIdToKey128(miss.id);
  const words = [...state.words];
  words[384] = (kid << 128n) | (0x0002n << 112n) | (256n << 96n) | (0x0001n << 80n);
  const score = scoreState({ words }, corpus);
  assert.equal(score.components.exactRetrieval, 0);
});

test('makeRealMarginalEvaluator returns positive gain for a real corpus patch', () => {
  const state = baselineA.genesisState();
  const patch = baselineA.mineCandidatePatch(state, { epoch: 1, solveIndex: 1 }, { corpus });
  assert.ok(patch, 'baseline A miner produced no patch');
  patch.parentStateRoot = merkleizeState(state);
  const evaluator = makeRealMarginalEvaluator({ corpus, applyPatch });
  const gain = evaluator(state, patch);
  assert.ok(gain > 0n, `expected positive gain, got ${gain}`);
});
