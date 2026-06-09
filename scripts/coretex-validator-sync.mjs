#!/usr/bin/env node
/**
 * Validator epoch-delta sync.
 *
 * DEPRECATED: `npm run validator:sync` now invokes the compiled CLI
 * (packages/cortex/dist/validator-sync-cli.js), which performs BOTH halves —
 * on-chain log replay AND corpus-delta continuity — with mandatory signature
 * verification, TOFU key pinning, and a bundle-version self-check. This script
 * remains runnable directly (`node scripts/coretex-validator-sync.mjs`) as the
 * corpus-materializing legacy path and as the home of the exported pin helpers
 * until they are fully migrated.
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

import { distValidator, repoRoot } from './_repo-root.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { writeMaterializedCorpusSnapshot } from './lib/write-materialized-corpus.mjs';

const C = await import(distValidator);
const {
  applyCorpusDelta,
  bytesToHex,
  hashCorpusDelta,
  hashJson,
  keccak256,
  loadProductionCorpus,
  parseCorpusDelta,
  verifyCorpusDeltaSignature,
  verifyEpochRotationManifestSignature,
} = C;

export const ZERO_BYTES32 = '0x' + '00'.repeat(32);

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
function sha256Text(text) {
  return `0x${createHash('sha256').update(text).digest('hex')}`;
}

function isBytes32Hex(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isAddressHex(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function normalizeBytes32(value, label) {
  if (!isBytes32Hex(value)) throw new Error(`${label} must be bytes32 hex`);
  return value.toLowerCase();
}

function normalizeAddress(value, label) {
  if (!isAddressHex(value)) throw new Error(`${label} must be address hex`);
  return value.toLowerCase();
}

function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function epochSecretCommit(epochSecret) {
  return bytesToHex(keccak256(hexToBytes(normalizeBytes32(epochSecret, 'epochSecret')))).toLowerCase();
}

function selector(signature) {
  return bytesToHex(keccak256(new TextEncoder().encode(signature))).slice(0, 10).toLowerCase();
}

function encodeUint64Arg(value) {
  const n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error(`uint64 argument out of range: ${value}`);
  return n.toString(16).padStart(64, '0');
}

function callData(signature, args = []) {
  return `${selector(signature)}${args.map(encodeUint64Arg).join('')}`;
}

function decodeBytes32(result, label) {
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64,}$/.test(result)) {
    throw new Error(`${label} eth_call returned malformed bytes32`);
  }
  return `0x${result.slice(2, 66).toLowerCase()}`;
}

function decodeAddress(result, label) {
  const word = decodeBytes32(result, label);
  return `0x${word.slice(-40)}`;
}

export async function rpcEthCall({ rpcUrl, to, data }) {
  const payload = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] };
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`RPC eth_call HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC error: ${j.error.message ?? JSON.stringify(j.error)}`);
  if (typeof j.result !== 'string') throw new Error('RPC eth_call missing result');
  return j.result;
}

async function callView({ rpcUrl, to, signature, args: callArgs = [], ethCall }) {
  return ethCall({ rpcUrl, to, signature, args: callArgs, data: callData(signature, callArgs) });
}

export function verifyEpochSecretRevealBinding({
  hiddenSeedCommit,
  miningEpochCommit,
  epochSecret,
  requireReveal = false,
}) {
  const hidden = normalizeBytes32(hiddenSeedCommit, 'registry hiddenSeedCommit');
  const commit = normalizeBytes32(miningEpochCommit, 'mining epochCommit');
  const secret = normalizeBytes32(epochSecret, 'mining epochSecret');
  if (commit !== hidden) {
    throw new Error(`mining epochCommit ${commit} != registry hiddenSeedCommit ${hidden}`);
  }
  if (secret === ZERO_BYTES32) {
    if (requireReveal) throw new Error('awaiting_epoch_secret_reveal: mining epochSecret is zero/unrevealed');
    return { evalReplayStatus: 'awaiting_epoch_secret_reveal', epochSecretRevealed: false };
  }
  const recomputed = epochSecretCommit(secret);
  if (recomputed !== hidden) {
    throw new Error(`mining epochSecret commit ${recomputed} != registry hiddenSeedCommit ${hidden}`);
  }
  return { evalReplayStatus: 'epoch_secret_revealed', epochSecretRevealed: true };
}

export async function readOnChainEpochPins({
  rpcUrl,
  registry,
  miningContract,
  epoch,
  requireReveal = false,
  ethCall = rpcEthCall,
}) {
  const registryAddress = normalizeAddress(registry, 'registry');
  const miningAddress = normalizeAddress(miningContract, 'miningContract');
  const epochNumber = Number(epoch);
  if (!Number.isSafeInteger(epochNumber) || epochNumber < 0) throw new Error('epoch must be a non-negative safe integer');
  const call = (to, signature, callArgs = []) => callView({ rpcUrl, to, signature, args: callArgs, ethCall });
  const chainRegistry = decodeAddress(await call(miningAddress, 'coreTexRegistry()'), 'mining.coreTexRegistry');
  if (chainRegistry !== registryAddress) {
    throw new Error(`mining coreTexRegistry ${chainRegistry} != configured registry ${registryAddress}`);
  }
  const pins = {
    parentStateRoot: decodeBytes32(await call(registryAddress, 'epochParentStateRoot(uint64)', [epochNumber]), 'registry.epochParentStateRoot'),
    liveStateRoot: decodeBytes32(await call(registryAddress, 'liveStateRoot(uint64)', [epochNumber]), 'registry.liveStateRoot'),
    coreVersionHash: decodeBytes32(await call(registryAddress, 'epochCoreVersionHash(uint64)', [epochNumber]), 'registry.epochCoreVersionHash'),
    corpusRoot: decodeBytes32(await call(registryAddress, 'epochCorpusRoot(uint64)', [epochNumber]), 'registry.epochCorpusRoot'),
    activeFrontierRoot: decodeBytes32(await call(registryAddress, 'epochActiveFrontierRoot(uint64)', [epochNumber]), 'registry.epochActiveFrontierRoot'),
    baselineManifestHash: decodeBytes32(await call(registryAddress, 'epochBaselineManifestHash(uint64)', [epochNumber]), 'registry.epochBaselineManifestHash'),
    hiddenSeedCommit: decodeBytes32(await call(registryAddress, 'epochHiddenSeedCommit(uint64)', [epochNumber]), 'registry.epochHiddenSeedCommit'),
  };
  const transitionCount = Number(BigInt(await call(registryAddress, 'transitionCount(uint64)', [epochNumber])));
  const miningEpochCommit = decodeBytes32(await call(miningAddress, 'epochCommit(uint64)', [epochNumber]), 'mining.epochCommit');
  const epochSecret = decodeBytes32(await call(miningAddress, 'epochSecret(uint64)', [epochNumber]), 'mining.epochSecret');
  const reveal = verifyEpochSecretRevealBinding({
    hiddenSeedCommit: pins.hiddenSeedCommit,
    miningEpochCommit,
    epochSecret,
    requireReveal,
  });
  return {
    ...pins,
    miningEpochCommit,
    transitionCount,
    registryAddress,
    miningContractAddress: miningAddress,
    evalReplayStatus: reveal.evalReplayStatus,
    epochSecretRevealed: reveal.epochSecretRevealed,
  };
}

export function mergeChainPins(offlinePins = {}, chainPins = {}) {
  const out = { ...offlinePins };
  for (const key of ['parentStateRoot', 'liveStateRoot', 'coreVersionHash', 'corpusRoot', 'activeFrontierRoot', 'baselineManifestHash', 'hiddenSeedCommit']) {
    if (!chainPins[key]) continue;
    if (out[key] && String(out[key]).toLowerCase() !== String(chainPins[key]).toLowerCase()) {
      throw new Error(`registry pin mismatch ${key}: offline=${out[key]} chain=${chainPins[key]}`);
    }
    out[key] = chainPins[key];
  }
  return out;
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

async function readTextUri(uri) {
  if (!uri) fail('missing URI/path');
  if (uri.startsWith('file://')) return readFileSync(fileURLToPath(uri), 'utf8');
  if (uri.startsWith('http://') || uri.startsWith('https://')) return downloadHttp(uri);
  if (uri.startsWith('s3://')) fail('s3:// public-key sync requires a presigned/public HTTP URL or a local path');
  return readFileSync(resolve(repoRoot, uri), 'utf8');
}

function payloadPath(manifest, role) {
  return manifest.payloads?.find((p) => p.role === role)?.path ?? null;
}

function joinUrl(base, path) {
  if (!base) return null;
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
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

function loadRegistryPins() {
  const pinsPath = flag('registry-pins', null);
  const pins = pinsPath ? readJson(pinsPath) : {};
  for (const [flagName, key] of [
    ['registry-core-version-hash', 'coreVersionHash'],
    ['registry-corpus-root', 'corpusRoot'],
    ['registry-active-frontier-root', 'activeFrontierRoot'],
    ['registry-baseline-manifest-hash', 'baselineManifestHash'],
    ['registry-hidden-seed-commit', 'hiddenSeedCommit'],
  ]) {
    const v = flag(flagName, null);
    if (v) pins[key] = v;
  }
  return pins;
}

function chainPinConfig() {
  const rpcUrl = flag('rpc-url', env.BASE_RPC_URL ?? null);
  const registry = flag('registry', env.CORETEX_REGISTRY_ADDRESS ?? null);
  const miningContract = flag('mining-contract', env.BOTCOIN_MINING_CONTRACT_ADDRESS ?? env.BOTCOIN_MINING_V4 ?? null);
  if (!rpcUrl && !registry && !miningContract) return null;
  if (!rpcUrl) fail('--rpc-url or BASE_RPC_URL is required when chain pins are configured');
  if (!registry) fail('--registry or CORETEX_REGISTRY_ADDRESS is required when chain pins are configured');
  if (!miningContract) fail('--mining-contract or BOTCOIN_MINING_CONTRACT_ADDRESS is required when chain pins are configured');
  return {
    rpcUrl,
    registry: normalizeAddress(registry, 'registry'),
    miningContract: normalizeAddress(miningContract, 'miningContract'),
    requireReveal: has('require-epoch-secret-reveal') || has('post-reveal') || has('verify-epoch-secret-reveal'),
  };
}

function comparePin(label, actual, expected) {
  if (!expected) return;
  if (!actual) fail(`registry pin ${label} is available but coordinator/sync artifact is missing that field`);
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    fail(`registry pin mismatch ${label}: actual=${actual} expected=${expected}`);
  }
}

async function main() {
  const launchManifestPath = flag('manifest', DEFAULT_MANIFEST);
  const launchManifest = readJson(launchManifestPath);
  if (launchManifest.schema !== 'coretex.launch-artifacts.v1') fail(`unsupported launch manifest schema ${launchManifest.schema}`);
  const coordinatorStatusUri = flag('from-coordinator', env.CORETEX_COORDINATOR_STATUS_URL ?? null);
  const coordinatorStatus = coordinatorStatusUri ? await readJsonUri(coordinatorStatusUri) : null;
  if (coordinatorStatus && coordinatorStatus.schema !== 'coretex.coordinator-epoch-status.v1') {
    fail(`unsupported coordinator status schema ${coordinatorStatus.schema}`);
  }
  if (coordinatorStatus && coordinatorStatus.nextEpochReadiness?.ready === false) {
    fail(`coordinator status is not ready: ${JSON.stringify(coordinatorStatus.nextEpochReadiness.blockers ?? [])}`);
  }
  let registryPins = loadRegistryPins();
  let chainPins = null;
  let evalReplayStatus = 'offline_pins_only';
  const artifactBase = flag(
    'artifact-base-url',
    (launchManifest.artifactBaseUrlEnv ? env[launchManifest.artifactBaseUrlEnv] : null)
      ?? env.CORETEX_ARTIFACT_BASE_URL
      ?? launchManifest.defaultBaseUrl
      ?? null,
  );
  const epochHint = flag('epoch', coordinatorStatus?.epoch ?? coordinatorStatus?.currentEpoch ?? env.EPOCH_ID ?? null);
  const inferredRotationUri = epochHint ? joinUrl(artifactBase, `epoch-rotations/epoch-rotation-${epochHint}.json`) : null;
  const inferredDeltaUri = epochHint ? joinUrl(artifactBase, `epoch-rotations/corpus-delta-epoch-${epochHint}.json`) : null;
  const rotationUri = flag('rotation-manifest', coordinatorStatus?.rotationManifestUrl ?? inferredRotationUri);
  const deltaUri = flag('corpus-delta', coordinatorStatus?.corpusDeltaUrl ?? inferredDeltaUri);
  if (!rotationUri || !deltaUri) fail('--rotation-manifest and --corpus-delta are required');
  const publicKeyPath = flag('public-key', null);
  const publicKeyUri = publicKeyPath ?? coordinatorStatus?.epochSigningPublicKeyUrl ?? null;
  if (!publicKeyUri) {
    fail('missing epoch signing public key: pass --public-key or provide coordinator status epochSigningPublicKeyUrl');
  }
  const publicKeyPem = await readTextUri(publicKeyUri);
  const expectedFingerprint = flag('public-key-fingerprint', coordinatorStatus?.epochSigningPublicKeyFingerprint ?? null);
  if (expectedFingerprint && sha256Text(publicKeyPem).toLowerCase() !== expectedFingerprint.toLowerCase()) {
    fail(`public key fingerprint mismatch ${sha256Text(publicKeyPem)} != ${expectedFingerprint}`);
  }
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
  const epoch = Number(rotation.epoch);
  const chainConfig = chainPinConfig();
  if (chainConfig) {
    try {
      chainPins = await readOnChainEpochPins({ ...chainConfig, epoch });
      registryPins = mergeChainPins(registryPins, chainPins);
      evalReplayStatus = chainPins.evalReplayStatus;
    } catch (e) {
      fail(e?.message ?? String(e));
    }
  }
  if (coordinatorStatus) {
    const ctx = coordinatorStatus.coreTexEpochContext;
    comparePin('coreVersionHash', ctx?.coreVersionHash ?? coordinatorStatus.coreVersionHash ?? coordinatorStatus.bundleHash, registryPins.coreVersionHash);
    comparePin('corpusRoot', ctx?.corpusRoot ?? coordinatorStatus.corpusRoot, registryPins.corpusRoot);
    comparePin('activeFrontierRoot', ctx?.activeFrontierRoot ?? coordinatorStatus.activeFrontierRoot, registryPins.activeFrontierRoot);
    comparePin('baselineManifestHash', ctx?.baselineManifestHash ?? coordinatorStatus.baselineManifestHash, registryPins.baselineManifestHash);
    comparePin('hiddenSeedCommit', ctx?.hiddenSeedCommit ?? coordinatorStatus.hiddenSeedCommit, registryPins.hiddenSeedCommit);
  }
  comparePin('coreVersionHash', rotation.bundleHash ?? launchManifest.bundleHash, registryPins.coreVersionHash);
  comparePin('baselineManifestHash', rotationManifestHash, registryPins.baselineManifestHash);
  comparePin('activeFrontierRoot', rotation.activeFrontierRoot, registryPins.activeFrontierRoot);

  const expectedEpochCorpusRoot = registryPins.corpusRoot ?? flag(
    'epoch-corpus-root',
    coordinatorStatus?.corpusRoot ?? coordinatorStatus?.coreTexEpochContext?.corpusRoot ?? rotation.nextCorpusRoot,
  );
  comparePin('corpusRoot', expectedEpochCorpusRoot, registryPins.corpusRoot);
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
      chainPinSource: chainPins ? 'rpc' : 'offline',
      evalReplayStatus,
      ...(chainPins ? {
        registryAddress: chainPins.registryAddress,
        miningContractAddress: chainPins.miningContractAddress,
        parentStateRoot: chainPins.parentStateRoot,
        liveStateRoot: chainPins.liveStateRoot,
        transitionCount: chainPins.transitionCount,
        epochSecretRevealed: chainPins.epochSecretRevealed,
      } : {}),
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
    chainPinSource: chainPins ? 'rpc' : 'offline',
    evalReplayStatus,
    ...(chainPins ? {
      registryAddress: chainPins.registryAddress,
      miningContractAddress: chainPins.miningContractAddress,
      parentStateRoot: chainPins.parentStateRoot,
      liveStateRoot: chainPins.liveStateRoot,
      transitionCount: chainPins.transitionCount,
      epochSecretRevealed: chainPins.epochSecretRevealed,
    } : {}),
    ...(coordinatorStatusUri ? { coordinatorStatusUri } : {}),
    currentCorpusJson: written.corpusJson.replace(`${repoRoot}/`, ''),
    currentManifest: written.manifestPath.replace(`${repoRoot}/`, ''),
  };
  mkdirSync(dirname(resolve(repoRoot, statePath)), { recursive: true });
  writeFileSync(resolve(repoRoot, statePath), JSON.stringify(state, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, command: 'validator:sync', ...state }, null, 2));
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  console.error('DEPRECATED: scripts/coretex-validator-sync.mjs is the legacy sync path; prefer `npm run validator:sync` (packages/cortex/dist/validator-sync-cli.js)');
  main().catch((e) => fail(e?.stack ?? e?.message ?? String(e)));
}
