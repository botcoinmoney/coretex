#!/usr/bin/env node
/**
 * Produce the ARMED live-eval-overlay bundle manifest from an existing bundle:
 * a deep copy whose `evaluator.profile.epochFrontier.liveEvalPack` is set and
 * whose bundleHash is recomputed (the scorer-law transition is attested by the
 * hash move — see EpochFrontierPin.liveEvalPack).
 *
 * The output manifest still carries the SOURCE bundle's baselineParentScorePpm.
 * Before pinning it at a cutover you MUST rebaseline under the new pack law:
 *   node scripts/pin-baseline-into-bundle.mjs --bundle-manifest <armed> \
 *     --corpus <materialized> --eval-seed-hex <seed> \
 *     --active-frontier-ids <active-frontier-ids.json> --active-frontier-root <0x…>
 *
 * Usage:
 *   node scripts/arm-liveeval-bundle.mjs --bundle <src.json> --out <dst.json> \
 *     [--limit 16] [--family-priority temporal_update[,fam2…]]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';

import { distIndex, repoRoot } from './_repo-root.mjs';

const { withRecomputedBundleHash } = await import(distIndex);

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb;
}

const srcPath = flag('bundle');
const outPath = flag('out');
const limit = Number(flag('limit', '16'));
const familyPriority = flag('family-priority', 'temporal_update').split(',').map((s) => s.trim()).filter(Boolean);
if (!srcPath || !outPath) {
  console.error('usage: --bundle <src manifest> --out <dst manifest> [--limit 16] [--family-priority temporal_update]');
  exit(2);
}
if (!Number.isInteger(limit) || limit < 1) {
  console.error(`--limit must be a positive integer (got ${limit})`);
  exit(2);
}

const src = JSON.parse(readFileSync(resolve(repoRoot, srcPath), 'utf8'));
const profile = src.evaluator?.profile;
if (!profile?.epochFrontier) {
  console.error('source bundle has no evaluator.profile.epochFrontier — cannot arm liveEvalPack');
  exit(1);
}
const quotaSum = profile.hiddenPack.quotas.reduce((acc, q) => acc + q.minCount, 0);
if (limit > profile.hiddenPack.packSize - quotaSum) {
  console.error(`--limit ${limit} exceeds packSize - quota reservation (${profile.hiddenPack.packSize - quotaSum})`);
  exit(1);
}

const armed = {
  ...src,
  evaluator: {
    ...src.evaluator,
    profile: {
      ...profile,
      epochFrontier: {
        ...profile.epochFrontier,
        liveEvalPack: { limit, familyPriority },
      },
    },
  },
};
const rehashed = withRecomputedBundleHash(armed);
if (rehashed.bundleHash === src.bundleHash) {
  console.error('bundleHash did not move — the pin was already present?');
  exit(1);
}
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(rehashed, null, 2) + '\n');
console.log(JSON.stringify({
  ok: true,
  out: outPath,
  sourceBundleHash: src.bundleHash,
  armedBundleHash: rehashed.bundleHash,
  liveEvalPack: { limit, familyPriority },
  note: 'rebaseline under the new pack law (pin-baseline-into-bundle with --active-frontier-ids/--active-frontier-root) before pinning at a cutover',
}, null, 2));
