#!/usr/bin/env node
/**
 * Validator epoch-delta sync.
 *
 * Fetches/reads a signed EpochRotationManifest + signed CorpusDelta, verifies
 * signatures/hashes/root continuity, applies the delta to the local validator
 * corpus cache, checks the on-chain/pinned next corpus root, then writes a
 * current-epoch materialized snapshot. Fails closed on every missing or
 * unverifiable input.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

import { distIndex, repoRoot } from './_repo-root.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { writeMaterializedCorpusSnapshot } from './lib/write-materialized-corpus.mjs';

const C = await import(distIndex);
const {
  applyCorpusDelta,
  hashCorpusDelta,
  hashJson,
  loadProductionCorpus,
  parseCorpusDelta,
  verifyCorpusDeltaSignature,
  verifyEpochRotationManifestSignature,
} = C;

const DEFAULT_MANIFEST = 'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json';
const DEFAULT_STATE = '.local-wip/coretex-validator-sync-state.json';
const args = argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

function fail(msg) {
  console.error(`HARD FAIL: ${msg}`);
  exit(1);
}
function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}
function sha256File(path) {
  return `0x${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function downloadHttp(url, redirects = 0) {
  return new Promise((resolveDone, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        if (!res.headers.location || redirects >= 5) return reject(new Error(`redirect failed for ${url}`));
        return resolveDone(downloadHttp(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; });
      res.on('end', () => resolveDone(out));
    });
    req.on('error', reject);
  });
}

async function readJsonUri(uri) {
  if (!uri) fail('missing URI/path');
  if (uri.startsWith('file://')) return JSON.parse(readFileSync(fileURLToPath(uri), 'utf8'));
  if (uri.startsWith('http://') || uri.startsWith('https://')) return JSON.parse(await downloadHttp(uri));
  if (uri.startsWith('s3://')) fail('s3:// sync requires a presigned/public HTTP URL or a local path for validators');
  return readJson(uri);
}

function payloadPath(manifest, role) {
  return manifest.payloads?.find((p) => p.role === role)?.path ?? null;
}

function loadPreviousCorpus({ statePath, launchManifest, bundlePath, corpusPayload, embPayload }) {
  if (existsSync(resolve(repoRoot, statePath))) {
    const state = readJson(statePath);
    if (state.currentCorpusJson && existsSync(resolve(repoRoot, state.currentCorpusJson))) {
      const corpus = loadProductionCorpus(resolve(repoRoot, state.currentCorpusJson), {
        verifyCorpusRoot: !has('skip-current-root-verify'),
        verifySplits: !has('skip-current-split-verify'),
      });
      return { corpus, source: 'validator-state', state };
    }
  }
  const loaded = loadMaterializedCorpus(bundlePath, {
    sourceCorpusPath: corpusPayload,
    sourceEmbPath: embPayload,
    verifyCorpusRoot: !has('skip-current-root-verify'),
    materializedRoot: launchManifest.materializedRoot,
  });
  return { corpus: loaded.corpus, source: 'launch-materialized', state: null };
}

async function main() {
  const launchManifestPath = flag('manifest', DEFAULT_MANIFEST);
  const launchManifest = readJson(launchManifestPath);
  if (launchManifest.schema !== 'coretex.launch-artifacts.v1') fail(`unsupported launch manifest schema ${launchManifest.schema}`);
  const coordinatorStatusUri = flag('from-coordinator', null);
  const coordinatorStatus = coordinatorStatusUri ? await readJsonUri(coordinatorStatusUri) : null;
  if (coordinatorStatus && coordinatorStatus.schema !== 'coretex.coordinator-epoch-status.v1') {
    fail(`unsupported coordinator status schema ${coordinatorStatus.schema}`);
  }
  if (coordinatorStatus && coordinatorStatus.nextEpochReadiness?.ready === false) {
    fail(`coordinator status is not ready: ${JSON.stringify(coordinatorStatus.nextEpochReadiness.blockers ?? [])}`);
  }
  const rotationUri = flag('rotation-manifest', coordinatorStatus?.rotationManifestUrl ?? null);
  const deltaUri = flag('corpus-delta', coordinatorStatus?.corpusDeltaUrl ?? null);
  if (!rotationUri || !deltaUri) fail('--rotation-manifest and --corpus-delta are required');
  const publicKeyPath = flag('public-key', null);
  if (!publicKeyPath) fail('--public-key is required');
  const publicKeyPem = readFileSync(resolve(repoRoot, publicKeyPath), 'utf8');
  const rotation = await readJsonUri(rotationUri);
  const delta = parseCorpusDelta(await readJsonUri(deltaUri));

  if (!verifyEpochRotationManifestSignature(rotation, publicKeyPem)) fail('rotation manifest signature verification failed');
  if (!verifyCorpusDeltaSignature(delta, publicKeyPem)) fail('corpus delta signature verification failed');
  const computedDeltaHash = hashCorpusDelta(delta);
  if (computedDeltaHash.toLowerCase() !== rotation.corpusDeltaHash.toLowerCase()) {
    fail(`corpusDeltaHash mismatch ${computedDeltaHash} != ${rotation.corpusDeltaHash}`);
  }
  if (delta.previousRoot.toLowerCase() !== rotation.previousCorpusRoot.toLowerCase()) {
    fail(`delta.previousRoot ${delta.previousRoot} != rotation.previousCorpusRoot ${rotation.previousCorpusRoot}`);
  }
  if (delta.nextRoot.toLowerCase() !== rotation.nextCorpusRoot.toLowerCase()) {
    fail(`delta.nextRoot ${delta.nextRoot} != rotation.nextCorpusRoot ${rotation.nextCorpusRoot}`);
  }
  const rotationManifestHash = hashJson(rotation);
  const expectedRotationManifestHash = flag(
    'rotation-manifest-hash',
    flag('baseline-manifest-hash', coordinatorStatus?.rotationManifestHash ?? coordinatorStatus?.baselineManifestHash ?? null),
  );
  if (!expectedRotationManifestHash && !has('allow-unpinned-rotation-manifest')) {
    fail('--baseline-manifest-hash/--rotation-manifest-hash is required to bind off-chain rotation provenance');
  }
  if (expectedRotationManifestHash && rotationManifestHash.toLowerCase() !== expectedRotationManifestHash.toLowerCase()) {
    fail(`rotation manifest hash ${rotationManifestHash} != expected ${expectedRotationManifestHash}`);
  }

  const expectedEpochCorpusRoot = flag(
    'epoch-corpus-root',
    coordinatorStatus?.corpusRoot ?? coordinatorStatus?.startEpochParams?.corpusRoot ?? rotation.nextCorpusRoot,
  );
  if (expectedEpochCorpusRoot.toLowerCase() !== rotation.nextCorpusRoot.toLowerCase()) {
    fail(`on-chain epoch corpus root ${expectedEpochCorpusRoot} != rotation.nextCorpusRoot ${rotation.nextCorpusRoot}`);
  }
  if (rotation.bundleHash.toLowerCase() !== launchManifest.bundleHash.toLowerCase()) {
    fail(`rotation bundleHash ${rotation.bundleHash} != launch bundleHash ${launchManifest.bundleHash}`);
  }
  const statePath = flag('state', DEFAULT_STATE);
  const bundlePath = flag('bundle', launchManifest.bundlePath);
  const profilePath = flag('profile', launchManifest.profilePath);
  const corpusPayload = payloadPath(launchManifest, 'corpus');
  const embPayload = payloadPath(launchManifest, 'embeddings');
  const { corpus: previousCorpus, source: previousSource } = loadPreviousCorpus({
    statePath,
    launchManifest,
    bundlePath,
    corpusPayload,
    embPayload,
  });
  if (previousCorpus.corpusRoot.toLowerCase() !== delta.previousRoot.toLowerCase()) {
    fail(`local previous corpus root ${previousCorpus.corpusRoot} != delta.previousRoot ${delta.previousRoot}`);
  }
  const nextCorpus = applyCorpusDelta(previousCorpus, delta, {
    rootCache: previousCorpus.corpusRootCache,
    attachRootCache: true,
  });
  if (nextCorpus.corpusRoot.toLowerCase() !== expectedEpochCorpusRoot.toLowerCase()) {
    fail(`applied next root ${nextCorpus.corpusRoot} != expected epoch corpus root ${expectedEpochCorpusRoot}`);
  }

  const epoch = Number(rotation.epoch);
  const bundleTag = launchManifest.bundleHash.slice(2, 10);
  const materializedRoot = flag('materialized-root', launchManifest.materializedRoot ?? 'release/calibration/2026-06-04-memory-atom-v16/materialized');
  const outDir = resolve(repoRoot, flag('out-dir', `${materializedRoot}/${bundleTag}/epoch-${epoch}`));
  const written = await writeMaterializedCorpusSnapshot({
    corpus: nextCorpus,
    outDir,
    bundleHash: launchManifest.bundleHash,
    bundlePath,
    profilePath,
    source: {
      syncSource: previousSource,
      epoch,
      rotationManifestHash,
      corpusDeltaHash: computedDeltaHash,
      rotationManifestUri: rotationUri,
      corpusDeltaUri: deltaUri,
      ...(coordinatorStatusUri ? { coordinatorStatusUri } : {}),
      launchManifestPath,
      sourceProfileSha256: profilePath ? sha256File(resolve(repoRoot, profilePath)) : null,
      sourceBundleSha256: bundlePath ? sha256File(resolve(repoRoot, bundlePath)) : null,
    },
  });
  const state = {
    schema: 'coretex.validator-sync-state.v1',
    updatedAt: new Date().toISOString(),
    epoch,
    bundleHash: launchManifest.bundleHash,
    corpusRoot: nextCorpus.corpusRoot,
    rotationManifestHash,
    corpusDeltaHash: computedDeltaHash,
    ...(coordinatorStatusUri ? { coordinatorStatusUri } : {}),
    currentCorpusJson: written.corpusJson.replace(`${repoRoot}/`, ''),
    currentManifest: written.manifestPath.replace(`${repoRoot}/`, ''),
  };
  mkdirSync(dirname(resolve(repoRoot, statePath)), { recursive: true });
  writeFileSync(resolve(repoRoot, statePath), JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, command: 'validator:sync', ...state }, null, 2));
}

main().catch((e) => fail(e?.stack ?? e?.message ?? String(e)));
