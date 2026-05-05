#!/usr/bin/env node
// Phase-scoped E2E runner. Usage:
//   npm run test:e2e                       # runs every phase tagged in test/e2e
//   npm run test:e2e -- --filter phase-1   # runs only phase-1 fixtures
//
// Each phase owns a directory test/e2e/phase-N/ with a run.mjs entrypoint that
// exits non-zero on failure. The aggregator just walks the directory.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const E2E = join(ROOT, 'test/e2e');

const args = process.argv.slice(2);
const filterIdx = args.indexOf('--filter');
const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;

if (!existsSync(E2E)) {
  console.error(`No test/e2e directory at ${E2E}. Phase fixtures not yet scaffolded.`);
  process.exit(0);
}

const phases = readdirSync(E2E)
  .filter((d) => d.startsWith('phase-'))
  .filter((d) => statSync(join(E2E, d)).isDirectory())
  .sort();

const target = filter ? phases.filter((p) => p === filter) : phases;

if (filter && target.length === 0) {
  console.error(`No phase directory matched filter "${filter}".`);
  process.exit(1);
}

let failed = 0;
for (const phase of target) {
  const entry = join(E2E, phase, 'run.mjs');
  if (!existsSync(entry)) {
    console.log(`[SKIP] ${phase}: no run.mjs entry yet.`);
    continue;
  }
  console.log(`\n=== ${phase} ===`);
  const r = spawnSync(process.execPath, [entry], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error(`[FAIL] ${phase}`);
  } else {
    console.log(`[PASS] ${phase}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
