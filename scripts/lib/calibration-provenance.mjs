import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { repoRoot } from '../_repo-root.mjs';

function sha256File(path) {
  return '0x' + createHash('sha256').update(readFileSync(resolve(repoRoot, path))).digest('hex');
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
  return {
    bundle: bundlePath,
    profile: profilePath,
    corpus: corpusPath,
    embeddings: embPath,
    bundleHash: bundle.bundleHash ?? manifest?.bundleHash ?? null,
    corpusRoot: manifest?.corpusRoot ?? null,
    corpusSha256: manifest?.sourceCorpusSha256 ?? sha256File(corpusPath),
    embeddingSha256: manifest?.sourceEmbSha256 ?? sha256File(embPath),
    profileSha256: profilePath ? (manifest?.sourceProfileSha256 ?? sha256File(profilePath)) : null,
    gitCommit,
    gitDirty,
    gitProvenanceSource: process.env.CORETEX_GIT_COMMIT ? 'env' : 'git',
  };
}
