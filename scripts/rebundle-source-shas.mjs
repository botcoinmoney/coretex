#!/usr/bin/env node
/**
 * Re-pin source SHAs in a bundle manifest after a canonical-code change (e.g. tuning
 * packages/cortex/src/coordinator/epoch-frontier.ts during calibration). Updates the
 * sha256 of every pinned file in substrate.{specs,implementation} + evaluator.files +
 * corpus.files + replay.snapshots, then recomputes bundleHash via the canonical
 * `withRecomputedBundleHash`. CORPUS content + bi-encoder/reranker pins are NOT
 * touched — only the source-code provenance lists.
 *
 * Calibration discipline: this is the normal post-canonical-fix step. After running
 * this, the materialized cache may need a sibling-copy (the materializer detects
 * content-equivalence and copies under the new bundleHash dir rather than rebuilding).
 *
 * Usage:
 *   node scripts/rebundle-source-shas.mjs \
 *     --in  release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-calibration.json \
 *     --out release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-calibration.json
 *
 * Override --out only when you want the re-pinned manifest written to a different
 * path (e.g. for diffing against the original).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { argv, exit } from 'node:process';
import { repoRoot } from './_repo-root.mjs';
import { withRecomputedBundleHash } from '../packages/cortex/dist/bundle/index.js';

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const IN = flag('in');
const OUT = flag('out', IN);
if (!IN) { console.error('HARD FAIL: --in <bundle-manifest> required'); exit(1); }

const inPath = resolve(repoRoot, IN);
const outPath = resolve(repoRoot, OUT);
if (!existsSync(inPath)) { console.error(`HARD FAIL: ${IN} does not exist`); exit(1); }

const manifest = JSON.parse(readFileSync(inPath, 'utf8'));
const oldHash = manifest.bundleHash;

function streamSha256(p) {
  const abs = resolve(repoRoot, p);
  if (!existsSync(abs)) throw new Error(`pinned file missing: ${p}`);
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

const updated = { changed: [], unchanged: [] };
function repinList(list, label) {
  if (!Array.isArray(list)) return list;
  return list.map((file) => {
    if (typeof file !== 'object' || !file.path || !file.sha256) return file;
    const got = streamSha256(file.path);
    const oldSha = file.sha256.toLowerCase();
    if (got !== oldSha) updated.changed.push({ list: label, path: file.path, oldSha, newSha: got });
    else updated.unchanged.push(file.path);
    return { ...file, sha256: got };
  });
}

const next = {
  ...manifest,
  substrate: {
    ...manifest.substrate,
    specs: repinList(manifest.substrate?.specs, 'substrate.specs'),
    implementation: repinList(manifest.substrate?.implementation, 'substrate.implementation'),
  },
  corpus: { ...manifest.corpus, files: repinList(manifest.corpus?.files, 'corpus.files') },
  evaluator: { ...manifest.evaluator, files: repinList(manifest.evaluator?.files, 'evaluator.files') },
  replay: { ...manifest.replay, snapshots: repinList(manifest.replay?.snapshots, 'replay.snapshots') },
};

const pinned = withRecomputedBundleHash(next);
writeFileSync(outPath, JSON.stringify(pinned, null, 2));

console.log(JSON.stringify({
  ok: true,
  in: relative(repoRoot, inPath),
  out: relative(repoRoot, outPath),
  oldBundleHash: oldHash,
  newBundleHash: pinned.bundleHash,
  changedFiles: updated.changed,
  unchangedFileCount: updated.unchanged.length,
}, null, 2));
