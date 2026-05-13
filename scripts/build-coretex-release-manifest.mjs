#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const outDir = resolve(process.argv[2] ?? './release-artifacts');
const tag = process.env.GITHUB_REF_NAME ?? process.env.CORETEX_RELEASE_TAG ?? 'dev';
const generatedAt = new Date().toISOString();
const gitCommit = process.env.GITHUB_SHA ?? 'unknown';

const files = readdirSync(outDir)
  .map((name) => join(outDir, name))
  .filter((path) => statSync(path).isFile())
  .map((path) => ({
    name: basename(path),
    bytes: statSync(path).size,
    sha256: sha256File(path),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const manifest = {
  schemaVersion: 'coretex.release-manifest.v1',
  tag,
  generatedAt,
  gitCommit,
  files,
};

writeFileSync(join(outDir, 'coretex-release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
