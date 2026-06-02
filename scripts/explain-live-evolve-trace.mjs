#!/usr/bin/env node
/**
 * Extract concrete query→candidate→Qwen trace examples from a trace-enabled
 * live-evolve artifact.
 *
 * Example:
 *   node scripts/explain-live-evolve-trace.mjs \
 *     --artifact release/calibration/.../V2_LIVE_EVOLVE_LONG_HORIZON_...json \
 *     --epoch 2 --patch 1 --query-id q_...
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { repoRoot } from './_repo-root.mjs';

const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const artifactPath = flag('artifact');
const epochFilter = flag('epoch') === null ? null : Number(flag('epoch'));
const patchFilter = flag('patch') === null ? null : (flag('patch') === 'frontier' ? null : Number(flag('patch')));
const queryFilter = flag('query-id');
const outPath = flag('out');

if (!artifactPath) {
  console.error('HARD FAIL: --artifact <live-evolve-json> required');
  exit(2);
}

const artifact = JSON.parse(readFileSync(resolve(repoRoot, artifactPath), 'utf8'));
const traces = [];
for (const ep of artifact.perEpoch ?? []) {
  if (epochFilter !== null && ep.epoch !== epochFilter) continue;
  for (const bucket of ['worstHeldoutRegressions', 'heldoutNonRegressions', 'activeImprovements']) {
    for (const tr of ep.frontierTraceDiagnostics?.[bucket] ?? []) {
      if (queryFilter && tr.query?.recordId !== queryFilter) continue;
      traces.push({ source: `epoch:${ep.epoch}:frontier:${bucket}`, ...tr });
    }
  }
  for (const hp of ep.honestPerPatch ?? []) {
    if (patchFilter !== null && hp.h !== patchFilter) continue;
    for (const bucket of ['worstHeldoutRegressions', 'heldoutNonRegressions', 'activeImprovements']) {
      for (const tr of hp.traceDiagnostics?.[bucket] ?? []) {
        if (queryFilter && tr.query?.recordId !== queryFilter) continue;
        traces.push({ source: `epoch:${ep.epoch}:patch:${hp.h}:${bucket}`, ...tr });
      }
    }
  }
}

if (traces.length === 0) {
  const hasTraceFlag = artifact.traceDiagnosticsEnabled === true;
  const msg = hasTraceFlag
    ? 'No traces matched the supplied filters.'
    : 'Artifact has no trace diagnostics. Re-run live-evolve with --trace-diagnostics to emit per-query rankings, rendered candidates, Qwen scores, and document snapshots.';
  console.error(`HARD FAIL: ${msg}`);
  exit(2);
}

const summary = {
  artifact: artifactPath,
  bundleHash: artifact.bundleHash ?? null,
  corpusRoot: artifact.corpusRoot ?? null,
  finalCorpusRoot: artifact.finalCorpusRoot ?? null,
  traceCount: traces.length,
  classificationCounts: traces.reduce((m, t) => {
    const k = t.explanationClassification ?? 'unknown';
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {}),
};
const out = { summary, traces };
if (outPath) {
  writeFileSync(resolve(repoRoot, outPath), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(JSON.stringify(out, null, 2));
}
