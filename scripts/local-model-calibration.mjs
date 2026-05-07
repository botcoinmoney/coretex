#!/usr/bin/env node
// Preliminary calibration for the elevated local-model gate.
//
// This is intentionally not a consensus test. It answers the operator question:
// does the pinned lightweight model show useful signal on known-good memory
// proposals before we use it as a production no-regression gate?

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
  prewarmLocalModelEmbedder,
} = await import(`${REPO}/experiments/harness/local-model-eval.mjs`);
const baselineA = await import(`${REPO}/experiments/baselines/baseline_a_empty/index.mjs`);
const baselineB = await import(`${REPO}/experiments/baselines/baseline_b_dense_key/index.mjs`);
const baselineE = await import(`${REPO}/experiments/baselines/baseline_e_revocation_aware/index.mjs`);
const { applyPatch, merkleizeState } = await import(`${REPO}/packages/cortex/dist/state/index.js`);

const corpus = loadRealCorpus({ repoRoot: REPO });
const embedder = useMock
  ? createHashingEmbedder()
  : await createTransformersEmbedder();

const warm = await prewarmLocalModelEmbedder(embedder, corpus);
const cases = [
  {
    name: 'long-horizon-memory-index',
    baseline: baselineA,
    state: baselineA.genesisState(),
    solveIndex: 0,
    minComponent: 'compressionSurvival',
  },
  {
    name: 'near-collision-retrieval-key',
    baseline: baselineB,
    state: baselineB.genesisState(),
    solveIndex: 0,
    minComponent: 'exactRetrieval',
  },
  {
    name: 'temporal-current-stale',
    baseline: baselineE,
    state: baselineE.genesisState(),
    solveIndex: 0,
    minComponent: 'temporalUpdateCorrectness',
    alternateComponent: 'staleMemoryRejection',
  },
];

const results = [];
let ok = true;
for (const c of cases) {
  const patch = c.baseline.mineCandidatePatch(c.state, { epoch: 1, solveIndex: c.solveIndex }, { corpus });
  if (!patch) throw new Error(`${c.name}: baseline did not produce a patch`);
  patch.parentStateRoot = merkleizeState(c.state);
  const report = await evaluatePatchWithLocalModel(c.state, patch, {
    applyPatch,
    corpus,
    embedder,
  });
  const before = report.before.components[c.minComponent] ?? 0;
  const after = report.after.components[c.minComponent] ?? 0;
  const altBefore = c.alternateComponent ? (report.before.components[c.alternateComponent] ?? 0) : 0;
  const altAfter = c.alternateComponent ? (report.after.components[c.alternateComponent] ?? 0) : 0;
  const componentMoved = after > before || altAfter > altBefore;
  const caseOk = report.pass && report.noRegression && componentMoved;
  ok = ok && caseOk;
  results.push({
    name: c.name,
    ok: caseOk,
    scoreDelta: report.scoreDelta,
    noRegression: report.noRegression,
    regressions: report.regressions,
    beforeComposite: report.before.composite,
    afterComposite: report.after.composite,
    beforeComponents: report.before.components,
    afterComponents: report.after.components,
    afterModelLatencyMs: report.after.modelLatencyMs,
  });
}

console.log(JSON.stringify({
  ok,
  model: embedder.model,
  prewarm: warm,
  cases: results,
}, null, 2));

if (!ok) process.exit(1);
