#!/usr/bin/env node
/**
 * Hydrate and verify launch validator artifacts from a committed manifest.
 *
 * Default use:
 *   npm run setup:validator
 *
 * Payloads are deliberately not stored in plain git. This script makes fresh validator setup
 * explicit and reproducible: download/copy missing payloads, verify SHA256/size, verify bundle
 * manifests, and materialize the active production corpus cache.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit, env } from 'node:process';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { distValidator, repoRoot } from './_repo-root.mjs';

const DEFAULT_MANIFEST = 'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json';
const args = argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const manifestPath = flag('manifest', DEFAULT_MANIFEST);
const verifyOnly = has('verify-only');
const noDownload = has('no-download');
const artifactBaseUrlOverride = flag('artifact-base-url', null);

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(h.digest('hex')));
  });
}

async function verifyPath(path, expected) {
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  const st = statSync(path);
  if (expected.bytes != null && st.size !== expected.bytes) {
    return { ok: false, reason: `size ${st.size} != ${expected.bytes}` };
  }
  const actual = await sha256File(path);
  if (actual !== expected.sha256) {
    return { ok: false, reason: `sha256 ${actual} != ${expected.sha256}` };
  }
  return { ok: true, bytes: st.size, sha256: actual };
}

function artifactUrl(manifest, payload) {
  const base = artifactBaseUrlOverride
    ?? (manifest.artifactBaseUrlEnv ? env[manifest.artifactBaseUrlEnv] : null)
    ?? manifest.defaultBaseUrl
    ?? null;
  if (!base) return null;
  const suffix = payload.fileName ?? payload.path.split('/').pop();
  return `${base.replace(/\/$/, '')}/${suffix}`;
}

function downloadHttp(url, outPath, redirects = 0) {
  return new Promise((resolveDone, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        if (!res.headers.location || redirects >= 5) return reject(new Error(`redirect failed for ${url}`));
        return resolveDone(downloadHttp(new URL(res.headers.location, url).toString(), outPath, redirects + 1));
      }
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = createWriteStream(outPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolveDone));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function downloadArtifact(url, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp-${process.pid}`;
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
  if (url.startsWith('file://')) {
    copyFileSync(fileURLToPath(url), tmp);
  } else if (url.startsWith('http://') || url.startsWith('https://')) {
    await downloadHttp(url, tmp);
  } else {
    copyFileSync(resolve(repoRoot, url), tmp);
  }
  renameSync(tmp, outPath);
}

async function ensurePayload(manifest, payload) {
  const abs = resolve(repoRoot, payload.path);
  const existing = await verifyPath(abs, payload);
  if (existing.ok) {
    console.log(`[setup] OK ${payload.role}: ${payload.path}`);
    return;
  }
  if (verifyOnly || noDownload) {
    throw new Error(`HARD FAIL: ${payload.path} ${existing.reason}; download disabled`);
  }
  const url = artifactUrl(manifest, payload);
  if (!url) {
    throw new Error(`HARD FAIL: ${payload.path} ${existing.reason}; set ${manifest.artifactBaseUrlEnv ?? 'CORETEX_ARTIFACT_BASE_URL'} or pass --artifact-base-url`);
  }
  console.log(`[setup] FETCH ${payload.role}: ${url}`);
  await downloadArtifact(url, abs);
  const after = await verifyPath(abs, payload);
  if (!after.ok) throw new Error(`HARD FAIL: downloaded ${payload.path} failed verification: ${after.reason}`);
  console.log(`[setup] OK ${payload.role}: ${payload.path}`);
}

async function verifyStaticFile(label, path, sha256) {
  const abs = resolve(repoRoot, path);
  if (!existsSync(abs)) throw new Error(`HARD FAIL: missing ${label}: ${path}`);
  const actual = await sha256File(abs);
  if (actual !== sha256) throw new Error(`HARD FAIL: ${label} sha drift ${path}: ${actual} != ${sha256}`);
  console.log(`[setup] OK ${label}: ${path}`);
}

async function verifyBundles(manifest) {
  const C = await import(distValidator);
  await verifyStaticFile('bundle', manifest.bundlePath, manifest.bundleSha256);
  await verifyStaticFile('profile', manifest.profilePath, manifest.profileSha256);
  const bundle = readJson(manifest.bundlePath);
  if (bundle.bundleHash !== manifest.bundleHash) {
    throw new Error(`HARD FAIL: bundleHash drift ${bundle.bundleHash} != ${manifest.bundleHash}`);
  }
  if ((bundle.corpus?.root ?? '').toLowerCase() !== manifest.corpusRoot.toLowerCase()) {
    throw new Error(`HARD FAIL: corpusRoot drift ${bundle.corpus?.root} != ${manifest.corpusRoot}`);
  }
  const errors = C.verifyBundleManifest(bundle, repoRoot);
  if (errors.length) throw new Error(`HARD FAIL: bundle manifest invalid:\n  - ${errors.join('\n  - ')}`);
  console.log(`[setup] OK bundleHash: ${bundle.bundleHash}`);
}

function materialize(manifest) {
  const corpus = manifest.payloads.find((x) => x.role === 'corpus').path;
  const emb = manifest.payloads.find((x) => x.role === 'embeddings').path;
  const cmd = [
    'scripts/materialize-production-corpus.mjs',
    '--profile', manifest.profilePath,
    '--bundle', manifest.bundlePath,
    '--corpus', corpus,
    '--emb', emb,
    '--materialized-root', manifest.materializedRoot,
  ];
  console.log(`[setup] MATERIALIZE: node ${cmd.join(' ')}`);
  const res = spawnSync(process.execPath, cmd, { cwd: repoRoot, stdio: 'inherit', env: process.env });
  if (res.status !== 0) throw new Error(`HARD FAIL: materialize exited ${res.status}`);
  const tag = manifest.bundleHash.slice(2, 10);
  const matManifestPath = `${manifest.materializedRoot}/${tag}/manifest.json`;
  const mat = readJson(matManifestPath);
  if ((mat.corpusRoot ?? '').toLowerCase() !== manifest.corpusRoot.toLowerCase()) {
    throw new Error(`HARD FAIL: materialized root ${mat.corpusRoot} != ${manifest.corpusRoot}`);
  }
  console.log(`[setup] OK materialized: ${matManifestPath}`);
}

function verifyMaterialized(manifest) {
  const corpus = manifest.payloads.find((x) => x.role === 'corpus');
  const emb = manifest.payloads.find((x) => x.role === 'embeddings');
  const tag = manifest.bundleHash.slice(2, 10);
  const matManifestPath = `${manifest.materializedRoot}/${tag}/manifest.json`;
  const corpusJson = `${manifest.materializedRoot}/${tag}/corpus.json`;
  const ndjson = `${corpusJson}.events.ndjson`;
  if (!existsSync(resolve(repoRoot, matManifestPath))) {
    throw new Error(`HARD FAIL: materialized cache missing: ${matManifestPath}. Run npm run setup:validator.`);
  }
  if (!existsSync(resolve(repoRoot, corpusJson)) || !existsSync(resolve(repoRoot, ndjson))) {
    throw new Error(`HARD FAIL: materialized corpus files missing under ${manifest.materializedRoot}/${tag}`);
  }
  const mat = readJson(matManifestPath);
  const checks = [
    ['bundleHash', mat.bundleHash, manifest.bundleHash],
    ['corpusRoot', mat.corpusRoot, manifest.corpusRoot],
    ['sourceCorpusSha256', mat.sourceCorpusSha256, `0x${corpus.sha256}`],
    ['sourceEmbSha256', mat.sourceEmbSha256, `0x${emb.sha256}`],
    ['sourceProfileSha256', mat.sourceProfileSha256, `0x${manifest.profileSha256}`],
    ['sourceBundleSha256', mat.sourceBundleSha256, `0x${manifest.bundleSha256}`],
  ];
  for (const [label, actual, expected] of checks) {
    if ((actual ?? '').toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`HARD FAIL: materialized ${label} drift ${actual} != ${expected}`);
    }
  }
  if (typeof mat.eventCount !== 'number' || mat.eventCount <= 0) {
    throw new Error(`HARD FAIL: materialized eventCount invalid: ${mat.eventCount}`);
  }
  console.log(`[setup] OK materialized: ${matManifestPath}`);
}

async function main() {
  const manifest = readJson(manifestPath);
  if (manifest.schema !== 'coretex.launch-artifacts.v1') {
    throw new Error(`HARD FAIL: unsupported artifact manifest schema ${manifest.schema}`);
  }
  console.log(`[setup] manifest: ${manifestPath}`);
  console.log(`[setup] launch artifact: ${manifest.name}`);
  for (const payload of manifest.payloads ?? []) await ensurePayload(manifest, payload);
  await verifyBundles(manifest);
  if (verifyOnly) {
    verifyMaterialized(manifest);
  } else {
    materialize(manifest);
  }
  console.log(`[setup] READY corpusRoot=${manifest.corpusRoot} bundleHash=${manifest.bundleHash}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  exit(1);
});
