#!/usr/bin/env node
// Smoke test for the local model-assisted Cortex evaluator.
//
// Use --mock for deterministic no-download CI/dev smoke.
// Omit --mock to load the pinned open-weight MiniLM model through
// @huggingface/transformers.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const useMock = process.argv.includes('--mock');

const { loadRealCorpus } = await import(`${REPO}/experiments/harness/cortex-bench-eval.mjs`);
const {
  createHashingEmbedder,
  createTransformersEmbedder,
  evaluatePatchWithLocalModel,
} = await import(`${REPO}/experiments/harness/local-model-eval.mjs`);
const baselineA = await import(`${REPO}/experiments/baselines/baseline_a_empty/index.mjs`);
const { applyPatch, merkleizeState } = await import(`${REPO}/packages/cortex/dist/state/index.js`);

const corpus = loadRealCorpus({ repoRoot: REPO });
const state = baselineA.genesisState();
const patch = baselineA.mineCandidatePatch(state, { epoch: 1, solveIndex: 0 }, { corpus });
if (!patch) throw new Error('Baseline A did not produce a patch');
patch.parentStateRoot = merkleizeState(state);

const embedder = useMock
  ? createHashingEmbedder()
  : await createTransformersEmbedder();

const report = await evaluatePatchWithLocalModel(state, patch, {
  applyPatch,
  corpus,
  embedder,
});

console.log(JSON.stringify({
  ok: report.pass,
  model: report.after.model,
  scoreDelta: report.scoreDelta,
  beforeComposite: report.before.composite,
  afterComposite: report.after.composite,
  beforeModelLatencyMs: report.before.modelLatencyMs,
  afterModelLatencyMs: report.after.modelLatencyMs,
  beforeComponents: report.before.components,
  afterComponents: report.after.components,
}, null, 2));

if (!report.pass) process.exit(1);
