import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { hostname } from 'node:os';
import { repoRoot } from '../_repo-root.mjs';

function sha256File(path) {
  return '0x' + createHash('sha256').update(readFileSync(resolve(repoRoot, path))).digest('hex');
}

function sha256Text(text) {
  return '0x' + createHash('sha256').update(text).digest('hex');
}

function gitField(cmd, fallback) {
  try {
    return execSync(cmd, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fallback;
  }
}

export function calibrationProvenance({ bundlePath, corpusPath, embPath, profilePath, manifest }) {
  const bundle = JSON.parse(readFileSync(resolve(repoRoot, bundlePath), 'utf8'));
  const gitCommit = process.env.CORETEX_GIT_COMMIT || gitField('git rev-parse HEAD', 'unknown');
  const gitDirty = process.env.CORETEX_GIT_DIRTY
    ? process.env.CORETEX_GIT_DIRTY === 'true'
    : gitField('git status --short', '') !== '';
  const dirtyDiffText = gitDirty ? gitField('git diff --binary HEAD', '') : '';
  const dirtyStatusText = gitDirty ? gitField('git status --porcelain=v1', '') : '';
  return {
    bundle: bundlePath,
    bundlePath,
    profile: profilePath,
    profilePath,
    corpus: corpusPath,
    corpusPath,
    embeddings: embPath,
    embeddingsPath: embPath,
    bundleHash: bundle.bundleHash ?? manifest?.bundleHash ?? null,
    corpusRoot: manifest?.corpusRoot ?? null,
    bundleSha256: manifest?.sourceBundleSha256 ?? sha256File(bundlePath),
    corpusSha256: manifest?.sourceCorpusSha256 ?? sha256File(corpusPath),
    embeddingSha256: manifest?.sourceEmbSha256 ?? sha256File(embPath),
    profileSha256: profilePath ? (manifest?.sourceProfileSha256 ?? sha256File(profilePath)) : null,
    gitCommit,
    gitDirty,
    gitProvenanceSource: process.env.CORETEX_GIT_COMMIT ? 'env' : 'git',
    dirtyDiffSha256: process.env.CORETEX_DIRTY_DIFF_SHA256 || (dirtyDiffText ? sha256Text(dirtyDiffText) : null),
    dirtyStatusSha256: process.env.CORETEX_DIRTY_STATUS_SHA256 || (dirtyStatusText ? sha256Text(dirtyStatusText) : null),
    host: process.env.CORETEX_HOSTNAME || hostname(),
    a100Host: process.env.CORETEX_A100_HOST || null,
  };
}
