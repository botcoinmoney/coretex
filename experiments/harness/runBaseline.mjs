#!/usr/bin/env node
// Phase 7 harness — run a single baseline over N synthetic epochs and emit
// per-epoch metrics: retrieval accuracy, stale rejection, compression
// survival, latency, patch sensitivity, overfit resistance.
//
// All scoring is against StubCorpusLoader (always 0.5) plus a deterministic
// per-baseline noise term — the goal is harness correctness, not real
// quality. Real scoring requires a corpus loader (Phase 4) with the LoCoMo
// blocker resolved (issue #4).
//
// Usage:
//   node experiments/harness/runBaseline.mjs <baseline_id> <epochs> [--seed <n>]
//
// Output:
//   experiments/results/synthetic-dryrun/{baseline_id}.json

import { exit, argv } from 'node:process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');

const BASELINE_ID = (argv[2] ?? '').toUpperCase();
const EPOCHS = parseInt(argv[3] ?? '5', 10);
const seedIdx = argv.indexOf('--seed');
const SEED = seedIdx >= 0 ? parseInt(argv[seedIdx + 1], 10) : 42;

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
const { merkleizeState, applyPatch, encodePatch, bytesToHex } = mod;

console.log(`[runBaseline] ${BASELINE_ID} (${baseline.BASELINE_NAME}) × ${EPOCHS} epochs (seed=${SEED})`);

let state = baseline.genesisState();
const epochs = [];

for (let e = 1; e <= EPOCHS; e++) {
  const t0 = process.hrtime.bigint();

  const shardDescriptor = { epoch: e, solveIndex: SEED + e };
  const patch = baseline.mineCandidatePatch(state, shardDescriptor);

  let accepted = false, scoreDelta = 0, errorCode = null;
  if (!patch) {
    errorCode = 'no_patch'; // baseline can't mine
  } else {
    patch.parentStateRoot = merkleizeState(state);
    const r = applyPatch(state, patch);
    if (!r.ok) {
      errorCode = r.code;
    } else {
      // Synthetic scoring: seed-derived deterministic improvement.
      const deltaScore = (Number(BigInt(SEED + e) ^ BigInt(BASELINE_ID.charCodeAt(0))) % 1000) / 10000;
      scoreDelta = deltaScore;
      // Accept iff > 0.5% (matches Phase 4 score threshold direction)
      accepted = scoreDelta > 0.005;
      if (accepted) state = r.state;
    }
  }

  const t1 = process.hrtime.bigint();
  const latencyMs = Number(t1 - t0) / 1e6;

  epochs.push({
    epoch: e,
    accepted,
    errorCode,
    scoreDelta,
    latencyMs,
    parentStateRoot: bytesToHex(merkleizeState(state)),
  });
}

const result = {
  baselineId: BASELINE_ID,
  baselineName: baseline.BASELINE_NAME,
  seed: SEED,
  epochs,
  summary: {
    totalEpochs: EPOCHS,
    accepted: epochs.filter((e) => e.accepted).length,
    rejected: epochs.filter((e) => !e.accepted).length,
    avgScoreDelta: epochs.reduce((s, e) => s + e.scoreDelta, 0) / EPOCHS,
    p50LatencyMs: epochs.map(e => e.latencyMs).sort((a,b)=>a-b)[Math.floor(EPOCHS / 2)],
    finalStateRoot: epochs[epochs.length - 1]?.parentStateRoot ?? null,
  },
  generatedAt: new Date().toISOString(),
  caveat: 'Synthetic scoring (StubCorpusLoader). Real scoring requires Phase 4 corpus + LoCoMo resolution.',
};

const outDir = resolve(REPO, 'experiments/results/synthetic-dryrun');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, `${BASELINE_ID}.json`);
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(`[runBaseline] ${BASELINE_ID}: ${result.summary.accepted}/${EPOCHS} accepted`);
console.log(`[runBaseline] avgScoreDelta=${result.summary.avgScoreDelta.toFixed(4)} p50LatencyMs=${result.summary.p50LatencyMs.toFixed(2)}`);
console.log(`[runBaseline] wrote ${outPath}`);
