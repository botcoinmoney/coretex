// Unit tests for the local model-assisted memory evaluator.
//
// These use the deterministic hashing embedder so CI does not download model
// weights. Production/elevated-proposal runs should use
// createTransformersEmbedder() with the pinned open-weight MiniLM model.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..', '..');

const modelEval = await import(`${REPO}/experiments/harness/local-model-eval.mjs`);
const structuralEval = await import(`${REPO}/experiments/harness/cortex-bench-eval.mjs`);
const baselineA = await import(`${REPO}/experiments/baselines/baseline_a_empty/index.mjs`);
const baselineE = await import(`${REPO}/experiments/baselines/baseline_e_revocation_aware/index.mjs`);
const stateMod = await import(`${REPO}/packages/cortex/dist/state/index.js`);

const { loadRealCorpus } = structuralEval;
const { applyPatch, merkleizeState } = stateMod;
const {
  createHashingEmbedder,
  evaluatePatchWithLocalModel,
  evaluateStateWithLocalModel,
  extractStateMemoryView,
} = modelEval;

const corpus = loadRealCorpus({ repoRoot: REPO });
const embedder = createHashingEmbedder();

test('extractStateMemoryView sees memory-index additions from a Baseline A patch', () => {
  const state = baselineA.genesisState();
  const patch = baselineA.mineCandidatePatch(state, { epoch: 1, solveIndex: 0 }, { corpus });
  assert.ok(patch);
  patch.parentStateRoot = merkleizeState(state);
  const applied = applyPatch(state, patch);
  assert.ok(applied.ok);

  const before = extractStateMemoryView(state, corpus);
  const after = extractStateMemoryView(applied.state, corpus);
  assert.equal(before.activeMemoryEvents.length, 0);
  assert.ok(after.activeMemoryEvents.length > before.activeMemoryEvents.length);
});

test('local model evaluator score increases when long-horizon memories become retrievable', async () => {
  const state = baselineA.genesisState();
  const patch = baselineA.mineCandidatePatch(state, { epoch: 1, solveIndex: 0 }, { corpus });
  assert.ok(patch);
  patch.parentStateRoot = merkleizeState(state);

  const report = await evaluatePatchWithLocalModel(state, patch, { applyPatch, corpus, embedder });
  assert.equal(report.pass, true);
  assert.equal(report.noRegression, true);
  assert.deepEqual(report.regressions, []);
  assert.ok(report.after.components.compressionSurvival > report.before.components.compressionSurvival);
  assert.ok(report.scoreDelta > 0);
});

test('local model evaluator rewards temporal current/stale memory structure', async () => {
  const state = baselineE.genesisState();
  const patch = baselineE.mineCandidatePatch(state, { epoch: 1, solveIndex: 0 }, { corpus });
  assert.ok(patch);
  patch.parentStateRoot = merkleizeState(state);

  const before = await evaluateStateWithLocalModel(state, corpus, { embedder });
  const applied = applyPatch(state, patch);
  assert.ok(applied.ok);
  const after = await evaluateStateWithLocalModel(applied.state, corpus, { embedder });

  const temporalBefore =
    before.components.staleMemoryRejection + before.components.temporalUpdateCorrectness;
  const temporalAfter =
    after.components.staleMemoryRejection + after.components.temporalUpdateCorrectness;
  assert.ok(temporalAfter > temporalBefore);
});
