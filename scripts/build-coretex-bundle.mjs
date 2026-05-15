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

const evaluatorProfile = profilePath
  ? JSON.parse(readFileSync(resolve(profilePath), 'utf8')).profile
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
