#!/usr/bin/env node
// Phase 7 golden vectors — published bundle of (state, patch, expected
// eval-report hash, expected new state root) triples per §9 Phase 7.
//
// The bundle is deterministic and re-runnable. Auditors verify their build
// produces byte-identical roots/hashes from the same inputs.
//
// Output: experiments/results/synthetic-dryrun/golden-vectors.json
// AND a small replay test in test/e2e/phase-7/golden-replay.mjs.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');

let mod;
try {
  mod = await import(`${REPO}/packages/cortex/dist/state/index.js`);
} catch (e) {
  console.error('[goldenVectors] dist not built; run `npm run build` first');
  process.exit(2);
}
const { merkleizeState, applyPatch, encodePatch, decodePatch, keccak256, bytesToHex } = mod;

// Use the frozen CoreTex winner (Baseline A) as the base state.
const baseline = await import(`${REPO}/experiments/baselines/baseline_a_empty/index.mjs`);
const { loadRealCorpus } = await import(`${REPO}/experiments/harness/cortex-bench-eval.mjs`);
const corpus = loadRealCorpus({ repoRoot: REPO });

const triples = [];
let state = baseline.genesisState();

// Build 10 deterministic golden triples by mining real corpus-aware patches
// from the frozen winner.
for (let i = 0; i < 10; i++) {
  const patch = baseline.mineCandidatePatch(state, { epoch: i + 1, solveIndex: i }, { corpus });
  if (!patch) continue;
  patch.parentStateRoot = merkleizeState(state);
  const wire = encodePatch(patch);
  const r = applyPatch(state, patch);
  if (!r.ok) continue;
  const newRoot = merkleizeState(r.state);
  // Synthetic eval-report hash: keccak of canonical JSON of {parentRoot, patchHash, accepted=true}.
  const canonical = JSON.stringify({
    parentRoot: bytesToHex(patch.parentStateRoot),
    patchHash: bytesToHex(keccak256(wire)),
    newRoot: bytesToHex(newRoot),
    accepted: true,
  });
  const reportHash = keccak256(new TextEncoder().encode(canonical));

  triples.push({
    index: i,
    parentStateRoot: bytesToHex(patch.parentStateRoot),
    patchWireHex: bytesToHex(wire),
    expectedNewStateRoot: bytesToHex(newRoot),
    expectedReportHash: bytesToHex(reportHash),
  });
  state = r.state;
}

const bundle = {
  version: 'prelaunch.phase-7',
  baseline: 'A',
  scoring: 'coretex-retrieval-current',
  triples,
  generatedAt: new Date().toISOString(),
  notes: 'Replay any triple: decode the patch wire, applyPatch to the parent, ' +
         'merkleize, compare to expectedNewStateRoot. Recompute the canonical ' +
         'JSON above and keccak256 it; compare to expectedReportHash.',
};

mkdirSync(resolve(REPO, 'experiments/results/synthetic-dryrun'), { recursive: true });
const outPath = resolve(REPO, 'experiments/results/synthetic-dryrun/golden-vectors.json');
writeFileSync(outPath, JSON.stringify(bundle, null, 2));
console.log(`[goldenVectors] wrote ${triples.length} triples to ${outPath}`);
