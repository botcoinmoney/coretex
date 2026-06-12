#!/usr/bin/env node
/**
 * Forwarding shim — the CANONICAL setup logic lives in the compiled
 * @botcoin/coretex CLI (packages/coretex/src/validator-setup-cli.ts →
 * dist/validator-setup-cli.js, bin `coretex-validator-setup`). This shim runs
 * it in repo-hydration mode: payloads land at their committed repo-relative
 * paths and the bundle manifest source-tree pins are verified.
 *
 * Same flags as before: --manifest, --artifact-base-url, --verify-only,
 * --no-download. Default use: `npm run setup:validator`.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { repoRoot, distRoot } from './_repo-root.mjs';

const res = spawnSync(
  process.execPath,
  [resolve(distRoot, 'validator-setup-cli.js'), '--repo-root', repoRoot, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(res.status ?? 1);
