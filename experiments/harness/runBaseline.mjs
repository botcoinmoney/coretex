#!/usr/bin/env node
// Phase 7 harness — run a single baseline over N epochs, mining candidate
// patches against the real Phase 4 corpus and scoring with the real
// CoreTex pre-launch evaluator (no synthetic SEED-XOR).
//
// Per-epoch outputs: real composite + per-component scores, marginalGain,
// stable family deltas, latency, accept/reject reasons. Per-baseline output
// summarises trajectory.
//
// Usage:
//   node experiments/harness/runBaseline.mjs <baseline_id> <epochs> [--seed <n>] [--out <dir>] [--label <tag>]
//
// Output:
//   experiments/results/<label or 'real'>/{baseline_id}.json

import { exit, argv } from 'node:process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRealCorpus, scoreState, computeComposite } from './cortex-bench-eval.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');

const BASELINE_ID = (argv[2] ?? '').toUpperCase();
const EPOCHS = parseInt(argv[3] ?? '5', 10);
const seedIdx = argv.indexOf('--seed');
const SEED = seedIdx >= 0 ? parseInt(argv[seedIdx + 1], 10) : 42;
const outIdx = argv.indexOf('--out');
const labelIdx = argv.indexOf('--label');
const LABEL = labelIdx >= 0 ? argv[labelIdx + 1] : 'real';
const OUTDIR = outIdx >= 0 ? argv[outIdx + 1] : `experiments/results/${LABEL}`;
const thresholdIdx = argv.indexOf('--threshold');
const THRESHOLD = thresholdIdx >= 0 ? Number(argv[thresholdIdx + 1]) : 0;

const baselineDir = {
  A: 'baseline_a_empty',
  B: 'baseline_b_dense_key',
  C: 'baseline_c_binary_key',
  D: 'baseline_d_late_interaction',
  E: 'baseline_e_revocation_aware',
}[BASELINE_ID];

if (!baselineDir) { console.error(`unknown baseline: ${BASELINE_ID}`); exit(1); }

const baseline = await import(`${REPO}/experiments/baselines/${baselineDir}/index.mjs`);

let mod;
try {
  mod = await import(`${REPO}/packages/cortex/dist/state/index.js`);
} catch (e) {
  console.error('[runBaseline] dist not built; run `npm run build` first');
  exit(2);
}
const { merkleizeState, applyPatch, encodePatch, bytesToHex, keccak256 } = mod;

console.log(`[runBaseline] ${BASELINE_ID} (${baseline.BASELINE_NAME}) × ${EPOCHS} epochs (seed=${SEED}) [real corpus]`);

const corpus = loadRealCorpus({ repoRoot: REPO });
const corpusSummary = Object.fromEntries(
  Object.entries(corpus.sources).map(([k, v]) => [k, v.count]),
);
console.log(`[runBaseline] corpus events:`, corpusSummary);

let state = baseline.genesisState();
function scoreOf(s) {
  return scoreState(s, corpus);
}
const genesisRoot = bytesToHex(merkleizeState(state));
const genesisScore = scoreOf(state);
console.log(`[runBaseline] genesis composite=${genesisScore.composite.toFixed(6)} root=${genesisRoot.slice(0, 18)}…`);

const epochs = [];
const familySensitivity = { near_collision: 0, temporal: 0, long_horizon: 0, routing: 0, exact: 0, stale: 0, current: 0 };
let prevScore = genesisScore;

for (let e = 1; e <= EPOCHS; e++) {
  const t0 = process.hrtime.bigint();
  const shardDescriptor = { epoch: e, solveIndex: SEED + e };
  const patch = baseline.mineCandidatePatch(state, shardDescriptor, { corpus });

  let accepted = false, marginalDelta = 0, errorCode = null;
  let beforeComposite = prevScore.composite, afterComposite = beforeComposite;
  let afterScore = prevScore;

  if (!patch) {
    errorCode = 'no_patch';
  } else {
    patch.parentStateRoot = merkleizeState(state);
    const r = applyPatch(state, patch);
    if (!r.ok) {
      errorCode = r.code;
    } else {
      afterScore = scoreOf(r.state);
      afterComposite = afterScore.composite;
      marginalDelta = afterComposite - beforeComposite;
      accepted = marginalDelta > THRESHOLD;
      if (accepted) {
        state = r.state;
        familySensitivity.exact += afterScore.components.exactRetrieval - prevScore.components.exactRetrieval;
        familySensitivity.stale += afterScore.components.staleMemoryRejection - prevScore.components.staleMemoryRejection;
        familySensitivity.current += afterScore.components.temporalUpdateCorrectness - prevScore.components.temporalUpdateCorrectness;
        familySensitivity.long_horizon += afterScore.components.compressionSurvival - prevScore.components.compressionSurvival;
        familySensitivity.routing += afterScore.components.routingAccuracy - prevScore.components.routingAccuracy;
        prevScore = afterScore;
      }
    }
  }

  const t1 = process.hrtime.bigint();
  const latencyMs = Number(t1 - t0) / 1e6;

  epochs.push({
    epoch: e,
    accepted,
    errorCode,
    beforeComposite,
    afterComposite,
    marginalDelta,
    latencyMs,
    components: accepted ? afterScore.components : prevScore.components,
    parentStateRoot: bytesToHex(merkleizeState(state)),
    patchHashHex: patch ? bytesToHex(keccak256(encodePatch(patch))) : null,
  });
}

const finalScore = scoreOf(state);
const finalRoot = bytesToHex(merkleizeState(state));
const acceptedCount = epochs.filter((e) => e.accepted).length;
const result = {
  baselineId: BASELINE_ID,
  baselineName: baseline.BASELINE_NAME,
  seed: SEED,
  epochs,
  summary: {
    totalEpochs: EPOCHS,
    accepted: acceptedCount,
    rejected: EPOCHS - acceptedCount,
    genesisComposite: genesisScore.composite,
    finalComposite: finalScore.composite,
    netImprovement: finalScore.composite - genesisScore.composite,
    avgScoreDelta: epochs.reduce((s, e) => s + e.marginalDelta, 0) / EPOCHS,
    p50LatencyMs: epochs.map((e) => e.latencyMs).sort((a, b) => a - b)[Math.floor(EPOCHS / 2)],
    p99LatencyMs: epochs.map((e) => e.latencyMs).sort((a, b) => a - b)[Math.max(0, Math.floor(EPOCHS * 0.99) - 1)],
    finalStateRoot: finalRoot,
    genesisStateRoot: genesisRoot,
    familyContribution: familySensitivity,
    finalComponents: finalScore.components,
    finalFamilyScores: finalScore.familyScores,
    finalHits: finalScore.hits,
    finalTotals: finalScore.totals,
  },
  generatedAt: new Date().toISOString(),
  corpusSources: corpus.sources,
  scoring: 'coretex-retrieval-current',
};

const outDir = resolve(REPO, OUTDIR);
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `${BASELINE_ID}.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(`[runBaseline] ${BASELINE_ID}: ${result.summary.accepted}/${EPOCHS} accepted, netΔ=${result.summary.netImprovement.toFixed(6)} composite ${genesisScore.composite.toFixed(4)}→${finalScore.composite.toFixed(4)}`);
console.log(`[runBaseline] wrote ${outPath}`);
