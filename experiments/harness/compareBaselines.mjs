#!/usr/bin/env node
// Phase 7 harness — run all 5 baselines over the same seed + corpus and emit
// a comparison report (markdown + CSV). Defaults to the real CortexBench V0
// scorer wired in cortex-bench-eval.mjs; pass --label synthetic-dryrun to
// reproduce the legacy synthetic dry-run for backwards compatibility (still
// uses the real scorer now — but writes to the legacy directory).
//
// Usage: node experiments/harness/compareBaselines.mjs [--epochs N] [--seed N] [--label tag]

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
const labelIdx = argv.indexOf('--label');
const LABEL = labelIdx >= 0 ? argv[labelIdx + 1] : 'synthetic-dryrun';

const BASELINES = ['A', 'B', 'C', 'D', 'E'];
const results = {};

for (const id of BASELINES) {
  const r = spawnSync(
    'node',
    [
      'experiments/harness/runBaseline.mjs',
      id, EPOCHS,
      '--seed', SEED,
      '--label', LABEL,
    ],
    { cwd: REPO, stdio: 'inherit' },
  );
  if (r.status !== 0) { console.error(`baseline ${id} failed`); procExit(2); }
  const json = JSON.parse(readFileSync(resolve(REPO, `experiments/results/${LABEL}/${id}.json`), 'utf8'));
  results[id] = json;
}

let winner = BASELINES[0];
for (const id of BASELINES) {
  if (results[id].summary.finalComposite > results[winner].summary.finalComposite) winner = id;
}

let md = `# Baselines comparison — CortexBench V0 (${LABEL})

Seed: ${SEED}  Epochs per baseline: ${EPOCHS}  Generated: ${new Date().toISOString()}

> Scorer: real CortexBench V0 (\`experiments/harness/cortex-bench-eval.mjs\`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See \`experiments/PHASE_7_USER_ACTIONS.md\` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
`;

for (const id of BASELINES) {
  const r = results[id];
  md += `| ${id}${id === winner ? ' ★' : ''} | ${r.baselineName} | ${r.summary.genesisComposite.toFixed(4)} | ${r.summary.finalComposite.toFixed(4)} | ${r.summary.netImprovement.toFixed(4)} | ${r.summary.accepted}/${r.summary.totalEpochs} | ${r.summary.p50LatencyMs.toFixed(2)} | ${r.summary.finalStateRoot.slice(0, 16)}... |\n`;
}

md += `\n## Winner\n\n**Baseline ${winner} (${results[winner].baselineName})** — final composite ${results[winner].summary.finalComposite.toFixed(6)}.\n\n`;

md += `## Component breakdown (final state)\n\n`;
md += `| Baseline | exact | stale | current | compression | routing |\n`;
md += `|----------|------:|------:|--------:|------------:|--------:|\n`;
for (const id of BASELINES) {
  const c = results[id].summary.finalComponents;
  md += `| ${id} | ${c.exactRetrieval.toFixed(3)} | ${c.staleMemoryRejection.toFixed(3)} | ${c.temporalUpdateCorrectness.toFixed(3)} | ${c.compressionSurvival.toFixed(3)} | ${c.routingAccuracy.toFixed(3)} |\n`;
}

md += `\n## Family contribution (sum of accepted Δ per family)\n\n`;
md += `| Baseline | exact | stale | current | compression | routing |\n`;
md += `|----------|------:|------:|--------:|------------:|--------:|\n`;
for (const id of BASELINES) {
  const f = results[id].summary.familyContribution;
  md += `| ${id} | ${f.exact.toFixed(3)} | ${f.stale.toFixed(3)} | ${f.current.toFixed(3)} | ${f.long_horizon.toFixed(3)} | ${f.routing.toFixed(3)} |\n`;
}

md += `\n## Files\n\n`;
md += `- \`experiments/results/${LABEL}/{A..E}.json\` — per-baseline metrics\n`;
md += `- \`experiments/results/${LABEL}/comparison.csv\` — machine-readable\n`;
md += `- \`experiments/results/${LABEL}/comparison.md\` — this file\n`;

mkdirSync(resolve(REPO, `experiments/results/${LABEL}`), { recursive: true });
writeFileSync(resolve(REPO, `experiments/results/${LABEL}/comparison.md`), md);

let csv = 'baseline,name,genesis_composite,final_composite,net_improvement,accepted,total,p50_ms,p99_ms,final_state_root\n';
for (const id of BASELINES) {
  const r = results[id];
  csv += `${id},${r.baselineName},${r.summary.genesisComposite},${r.summary.finalComposite},${r.summary.netImprovement},${r.summary.accepted},${r.summary.totalEpochs},${r.summary.p50LatencyMs},${r.summary.p99LatencyMs},${r.summary.finalStateRoot}\n`;
}
writeFileSync(resolve(REPO, `experiments/results/${LABEL}/comparison.csv`), csv);

writeFileSync(resolve(REPO, `experiments/results/${LABEL}/winner.json`), JSON.stringify({
  winner,
  finalComposite: results[winner].summary.finalComposite,
  finalStateRoot: results[winner].summary.finalStateRoot,
  genesisStateRoot: results[winner].summary.genesisStateRoot,
  selectedAt: new Date().toISOString(),
  scoring: 'real-cortexbench-v0',
  seed: SEED,
  epochs: EPOCHS,
  label: LABEL,
}, null, 2));

console.log('');
console.log(`[compareBaselines] winner: Baseline ${winner} (${results[winner].baselineName}) composite=${results[winner].summary.finalComposite.toFixed(6)}`);
console.log(`[compareBaselines] markdown: experiments/results/${LABEL}/comparison.md`);
console.log(`[compareBaselines] csv:      experiments/results/${LABEL}/comparison.csv`);
console.log(`[compareBaselines] winner:   experiments/results/${LABEL}/winner.json`);
