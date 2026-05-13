#!/usr/bin/env node
/**
 * Pins client version policy into an existing bundle manifest and recomputes
 * bundleHash deterministically.
 *
 * Usage:
 *   node scripts/pin-client-version-policy-into-bundle.mjs \
 *     --bundle-manifest /etc/coretex/bundle-manifest.json \
 *     --minimum-version 0.7.0 \
 *     [--recommended-version 0.7.2] \
 *     [--hard-fail-outdated true] \
 *     --out /etc/coretex/bundle-manifest.with-client-policy.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { withRecomputedBundleHash } from '../packages/cortex/dist/bundle/index.js';

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function must(name) {
  const value = flag(name);
  if (!value) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(1);
  }
  return value;
}

function parseBool(value, fallback) {
  if (value === undefined) return fallback;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  process.stderr.write(`invalid boolean: ${value}\n`);
  process.exit(1);
}

const inPath = resolve(must('--bundle-manifest'));
const outPath = resolve(must('--out'));
const minimumVersion = must('--minimum-version');
const recommendedVersion = flag('--recommended-version');
const hardFailOutdated = parseBool(flag('--hard-fail-outdated'), true);

const raw = JSON.parse(readFileSync(inPath, 'utf8'));
const next = {
  ...raw,
  evaluator: {
    ...raw.evaluator,
    profile: {
      ...raw.evaluator?.profile,
      clientVersionPolicy: {
        minimumVersion,
        ...(recommendedVersion ? { recommendedVersion } : {}),
        hardFailOutdated,
      },
    },
  },
};

const pinned = withRecomputedBundleHash(next);
writeFileSync(outPath, JSON.stringify(pinned, null, 2) + '\n', 'utf8');

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      bundleManifest: inPath,
      out: outPath,
      clientVersionPolicy: pinned.evaluator.profile.clientVersionPolicy,
      bundleHash: pinned.bundleHash,
    },
    null,
    2,
  ) + '\n',
);
