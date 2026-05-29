#!/usr/bin/env node
/**
 * Build the production CoreTex client bundle manifest from the pinned default
 * model manifests and a retrieval corpus file.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { argv, exit } from 'node:process';

import {
  buildBundleManifest,
  verifyBundleManifest,
  bgeM3DenseManifest,
  qwen3Reranker06BManifest,
  memReranker4BManifest,
  loadProductionCorpus,
} from '@botcoin/cortex';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const repoRoot = resolve(flag('repo-root', process.cwd()));
const corpusPath = flag('corpus');
const corpusRootArg = flag('corpus-root');
const corpusFilesArg = flag('corpus-files');
const profilePath = flag('profile');
const outPath = resolve(flag('out', 'bundle/coretex-bundle-manifest.json'));

if (!corpusPath && (!corpusRootArg || !corpusFilesArg)) {
  console.error('build-coretex-bundle: provide --corpus <path> or --corpus-root plus --corpus-files');
  exit(1);
}

let corpusRoot = corpusRootArg;
let corpusFiles = corpusFilesArg?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
if (corpusPath) {
  const corpus = loadProductionCorpus(resolve(corpusPath), { verifyCorpusRoot: false, verifySplits: false });
  corpusRoot = corpus.corpusRoot;
  corpusFiles = [relative(repoRoot, resolve(corpusPath)).replaceAll('\\', '/')];
}

// The evaluator-profile-*.json file IS the profile object (not a wrapper with a `.profile` key).
// Reading `.profile` silently yielded undefined → the bundle dropped the profile. Load the object
// itself; tolerate a legacy `{profile:{...}}` wrapper only if explicitly present.
const evaluatorProfile = profilePath
  ? (() => {
      const j = JSON.parse(readFileSync(resolve(profilePath), 'utf8'));
      const p = (j && typeof j === 'object' && j.profile && j.pipelineVersion === undefined) ? j.profile : j;
      if (!p || typeof p !== 'object' || !p.pipelineVersion) throw new Error(`build-coretex-bundle: ${profilePath} is not a valid evaluator profile (no pipelineVersion)`);
      return p;
    })()
  : undefined;

const manifest = buildBundleManifest({
  repoRoot,
  corpusRoot,
  corpusFiles,
  biEncoder: bgeM3DenseManifest(),
  reranker: qwen3Reranker06BManifest(),
  labelingReranker: memReranker4BManifest(),
  ...(evaluatorProfile ? { evaluatorProfile } : {}),
});

const errors = verifyBundleManifest(manifest, repoRoot);
if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  exit(2);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ok: true, out: outPath, bundleHash: manifest.bundleHash, corpusRoot: manifest.corpus.root }, null, 2));
