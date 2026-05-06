#!/usr/bin/env node
// Phase 7 harness — run all 5 baselines over the same seeds + corpus and
// emit a comparison report (markdown + CSV) under experiments/results/synthetic-dryrun/.
//
// Usage: node experiments/harness/compareBaselines.mjs [--epochs N] [--seed N]

import { spawnSync } from 'node:child_process';
import { exit as procExit, argv } from 'node:process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');

const epochsIdx = argv.indexOf('--epochs');
const EPOCHS = epochsIdx >= 0 ? argv[epochsIdx + 1] : '5';
const seedIdx = argv.indexOf('--seed');
const SEED = seedIdx >= 0 ? argv[seedIdx + 1] : '42';

const BASELINES = ['A', 'B', 'C', 'D', 'E'];
const results = {};

for (const id of BASELINES) {
  const r = spawnSync('node', ['experiments/harness/runBaseline.mjs', id, EPOCHS, '--seed', SEED], {
    cwd: REPO, stdio: 'inherit',
  });
  if (r.status !== 0) { console.error(`baseline ${id} failed`); procExit(2); }
  const json = JSON.parse(readFileSync(resolve(REPO, `experiments/results/synthetic-dryrun/${id}.json`), 'utf8'));
  results[id] = json;
}

// Markdown report.
let md = `# Baselines comparison — synthetic dry-run

Seed: ${SEED}  Epochs per baseline: ${EPOCHS}  Generated: ${new Date().toISOString()}

> **Caveat**: scoring is synthetic (StubCorpusLoader). Real scoring requires Phase 4
> corpus + LoCoMo license resolution (issue #4). Use this report to validate harness
> correctness, not to pick a real winner.

| Baseline | Name | Accepted/Total | avgΔ | p50 latency (ms) | Final state root |
|----------|------|---------------:|-----:|-----------------:|------------------|
`;

for (const id of BASELINES) {
  const r = results[id];
  md += `| ${id} | ${r.baselineName} | ${r.summary.accepted}/${r.summary.totalEpochs} | ${r.summary.avgScoreDelta.toFixed(4)} | ${r.summary.p50LatencyMs.toFixed(2)} | ${r.summary.finalStateRoot?.slice(0, 16) ?? '—'}... |\n`;
}

md += `

## Placeholder winner

**Baseline E (revocation-aware)** is the placeholder winner per §9 Phase 7. The user runs real iteration with a Phase 4 corpus and \`experiments/PHASE_7_USER_ACTIONS.md\` to confirm or override.

## Files

- \`experiments/results/synthetic-dryrun/{A..E}.json\` — per-baseline metrics
- \`experiments/results/synthetic-dryrun/comparison.csv\` — machine-readable
- \`experiments/results/synthetic-dryrun/comparison.md\` — this file
`;

mkdirSync(resolve(REPO, 'experiments/results/synthetic-dryrun'), { recursive: true });
writeFileSync(resolve(REPO, 'experiments/results/synthetic-dryrun/comparison.md'), md);

// CSV.
let csv = 'baseline,name,accepted,total,avgScoreDelta,p50LatencyMs,finalStateRoot\n';
for (const id of BASELINES) {
  const r = results[id];
  csv += `${id},${r.baselineName},${r.summary.accepted},${r.summary.totalEpochs},${r.summary.avgScoreDelta},${r.summary.p50LatencyMs},${r.summary.finalStateRoot}\n`;
}
writeFileSync(resolve(REPO, 'experiments/results/synthetic-dryrun/comparison.csv'), csv);

console.log('\n[compareBaselines] markdown: experiments/results/synthetic-dryrun/comparison.md');
console.log('[compareBaselines] csv:      experiments/results/synthetic-dryrun/comparison.csv');
