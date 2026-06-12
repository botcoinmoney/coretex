#!/usr/bin/env node
/**
 * Coordinator-owned epoch runner.
 *
 * This is the production control-plane wrapper around coretex:epoch-evolve:
 * it chooses bounded churn from prior-epoch telemetry, runs the canonical
 * evolve/sign/publish command, emits validator-sync metadata, and fails closed
 * before any chain call when quality/control/S3 checks are not clean.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { repoRoot } from './_repo-root.mjs';
import {
  parseS3Uri,
  s3UriToHttps,
  verifyS3GetRehash as sharedVerifyS3GetRehash,
} from './lib/s3-get-rehash.mjs';

const DEFAULT_MANIFEST = 'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json';
const COORDINATOR_EPOCH_METRICS_SCHEMA = 'coretex.coordinator-epoch-metrics.v1';
const ZERO32 = `0x${'00'.repeat(32)}`;
/**
 * Dev/test bypasses that must never pass through the production runner.
 * They are rejected outright (hard error, not silent drop); local CPU gates
 * that need them must call coretex-epoch-evolve directly.
 */
export const FORBIDDEN_PRODUCTION_RUNNER_FLAGS = [
  'allow-dev-key',
  'allow-frontier-bootstrap',
  'allow-missing-parent-state-root',
  'skip-previous-root-verify',
  'skip-previous-split-verify',
];
const args = argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

export function mergeCoordinatorEpochMetrics(fileMetrics = {}, cliArgs = args) {
  const cliFlag = (name, fallback = null) => {
    const i = cliArgs.indexOf(`--${name}`);
    return i >= 0 && i + 1 < cliArgs.length ? cliArgs[i + 1] : fallback;
  };
  const cliHas = (name) => cliArgs.includes(`--${name}`);
  const out = { ...fileMetrics };
  if (cliHas('prev-honest-accepts')) {
    out.prevHonestAccepts = asNonNegativeNumber(cliFlag('prev-honest-accepts'));
  } else if (cliHas('previous-honest-accepts')) {
    out.prevHonestAccepts = asNonNegativeNumber(cliFlag('previous-honest-accepts'));
  } else if (out.prevHonestAccepts === undefined) {
    out.prevHonestAccepts = 0;
  }
  if (cliHas('prev-quality-attempts')) {
    out.prevQualityAttempts = asNonNegativeNumber(cliFlag('prev-quality-attempts'));
  } else if (cliHas('previous-quality-attempts')) {
    out.prevQualityAttempts = asNonNegativeNumber(cliFlag('previous-quality-attempts'));
  } else if (out.prevQualityAttempts === undefined) {
    out.prevQualityAttempts = 0;
  }
  return out;
}

/**
 * Provenance + freshness gate for the prior-epoch metrics file. Returns a
 * rejection reason or null. Silent default-to-zero from a missing/stale/foreign
 * metrics file is forbidden — main() hard-fails on any rejection.
 *  - provenance: schema pin + the file must be FOR the completed epoch (epoch-1)
 *  - freshness: embedded generatedAt (or file mtime when absent) within maxAgeMs
 */
export function validateCoordinatorEpochMetrics(metrics, { epoch, nowMs = Date.now(), maxAgeMs = 25 * 3600 * 1000, mtimeMs = null } = {}) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return 'metrics file is not a JSON object';
  if (metrics.schema !== COORDINATOR_EPOCH_METRICS_SCHEMA) {
    return `metrics provenance schema ${JSON.stringify(metrics.schema)} != ${COORDINATOR_EPOCH_METRICS_SCHEMA}`;
  }
  if (Number(metrics.epoch) !== epoch - 1) {
    return `metrics file is for epoch ${metrics.epoch}; runner epoch ${epoch} requires completed-epoch ${epoch - 1} telemetry`;
  }
  const embedded = Date.parse(String(metrics.generatedAt ?? ''));
  const freshnessTs = Number.isFinite(embedded) ? embedded : mtimeMs;
  if (!Number.isFinite(freshnessTs) || freshnessTs === null) return 'metrics file has no parseable generatedAt and no mtime';
  const ageMs = nowMs - freshnessTs;
  if (ageMs > maxAgeMs) {
    return `metrics file is ${Math.round(ageMs / 1000)}s old (max ${Math.round(maxAgeMs / 1000)}s); stale telemetry is forbidden`;
  }
  return null;
}

/**
 * Readiness `checked` items must only claim what was ACTUALLY verified —
 * root continuity is reported iff the parent state root was derived/verified
 * from chain, and S3 publication iff every uploaded artifact was fetched back
 * over its public URL and byte-rehashed.
 */
export function readinessCheckedItems({ baselineBindsRotation, parentRootChainVerified, s3GetRehashVerified }) {
  return [
    'signed_corpus_delta',
    'signed_epoch_rotation_manifest',
    ...(baselineBindsRotation ? ['baseline_manifest_hash_binds_rotation_manifest'] : []),
    ...(parentRootChainVerified ? ['parent_state_root_chain_verified', 'root_continuity_verified'] : []),
    ...(s3GetRehashVerified ? ['s3_upload_get_rehash_verified'] : []),
  ];
}

export function metricsRequiredForEpoch(epochNum, launchGenesis = false) {
  return epochNum >= 2 && !launchGenesis;
}

export function shouldDeriveParentStateRootFromChain({ rpcUrl, registry, parentStateRoot, launchGenesis }) {
  return Boolean(rpcUrl && registry && !(launchGenesis && parentStateRoot));
}

function fail(msg) {
  console.error(`HARD FAIL: ${msg}`);
  exit(1);
}
function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}
function maybeReadJson(path) {
  if (!path) return {};
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}
function rel(path) {
  return path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path;
}
function bytes32FromString(s) {
  return `0x${createHash('sha256').update(s).digest('hex')}`;
}
function bytes32FromBytes(bytes) {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}
function asNonNegativeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
export function frontierCount(v) {
  if (Array.isArray(v)) return v.length;
  if (Number.isSafeInteger(v) && v >= 0) return v;
  return 0;
}
function asPpm(v, fallback = null) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.max(0, Math.min(1_000_000, n));
}
function normalizeS3Prefix(prefix) {
  return prefix?.replace(/\/+$/, '') ?? null;
}
function s3Join(prefix, fileName) {
  return `${normalizeS3Prefix(prefix)}/${fileName}`;
}
// S3 GET-and-rehash verification is factored into a shared lib so the direct
// dev/manual evolve script (scripts/coretex-epoch-evolve.mjs) verifies uploads
// byte-identically to this orchestrated production path.
function s3ToHttps(uri, manifest) {
  return s3UriToHttps(uri, { manifest, env });
}

/** Head-object existence is NOT verification: every uploaded artifact is
 *  fetched back over its PUBLIC url and the bytes are rehashed against the
 *  local file. Any mismatch is a hard failure before any chain call. */
async function verifyS3GetRehash(localPath, s3Uri, manifest) {
  try {
    await sharedVerifyS3GetRehash(localPath, s3Uri, { manifest, env });
  } catch (e) {
    fail(e?.message ?? String(e));
  }
}

async function uploadS3(localPath, s3Uri, manifest) {
  const parsed = parseS3Uri(s3Uri);
  if (!parsed) fail(`invalid s3 URI ${s3Uri}`);
  const cp = spawnSync('aws', ['s3', 'cp', localPath, s3Uri], { cwd: repoRoot, stdio: 'inherit', env });
  if (cp.status !== 0) fail(`aws s3 cp failed for ${localPath} -> ${s3Uri}`);
  await verifyS3GetRehash(localPath, s3Uri, manifest);
}

function castCall(rpcUrl, to, sig, ...params) {
  const r = spawnSync('cast', ['call', '--rpc-url', rpcUrl, to, sig, ...params.map(String)], {
    cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 16 << 20,
  });
  if (r.status !== 0) fail(`cast call ${sig} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
}

/** The parent state root is derived FROM CHAIN: the registry's live state root
 *  of the completed epoch (falling back to the completed epoch's pinned parent
 *  when no transition landed). Never config/CLI-only when chain is reachable. */
function deriveParentStateRootFromChain({ rpcUrl, registry, completedEpoch }) {
  const live = castCall(rpcUrl, registry, 'liveStateRoot(uint64)(bytes32)', completedEpoch).toLowerCase();
  if (live && live !== ZERO32) return live;
  return castCall(rpcUrl, registry, 'epochParentStateRoot(uint64)(bytes32)', completedEpoch).toLowerCase();
}
function requireAwsIdentity() {
  const sts = spawnSync('aws', ['sts', 'get-caller-identity'], { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8', env });
  if (sts.status !== 0) fail(`aws sts get-caller-identity failed: ${sts.stderr || sts.stdout}`);
  return JSON.parse(sts.stdout);
}

function chooseChurn(metrics) {
  const min = Number(flag('min-churn', '0.05'));
  const base = Number(flag('base-churn', '0.1'));
  const max = Number(flag('max-churn', '0.3'));
  if (![min, base, max].every(Number.isFinite) || min < 0 || max < min || base < min || base > max) {
    fail('--min-churn/--base-churn/--max-churn must be finite and ordered');
  }

  const randomAccepts = asNonNegativeNumber(metrics.randomControlAccepts)
    + asNonNegativeNumber(metrics.noopControlAccepts)
    + asNonNegativeNumber(metrics.hillControlAccepts);
  const acceptedDamage = asNonNegativeNumber(metrics.acceptedOldCorpusDamageCount)
    + asNonNegativeNumber(metrics.acceptedGoldDamageCount);
  if (randomAccepts > 0) fail(`control accepts are nonzero (${randomAccepts}); refusing epoch evolve`);
  if (acceptedDamage > 0) fail(`accepted old/gold damage is nonzero (${acceptedDamage}); refusing epoch evolve`);

  let churn = base;
  const reasons = ['base_churn'];
  const reuse = asPpm(metrics.acceptedFingerprintReusePpm, null);
  const minable = asPpm(metrics.strictMinableRatioPpm, null);
  const entropy = asPpm(metrics.acceptedFamilyEntropyPpm, null);
  if (reuse !== null && reuse >= 750_000) {
    churn += 0.05;
    reasons.push('high_fingerprint_reuse');
  }
  if (minable !== null && minable < 500_000) {
    churn += 0.05;
    reasons.push('low_minable_ratio');
  }
  if (entropy !== null && entropy < 500_000) {
    churn += 0.025;
    reasons.push('low_family_entropy');
  }
  if (asNonNegativeNumber(metrics.prevHonestAccepts) === 0 && asNonNegativeNumber(metrics.prevQualityAttempts) > 0) {
    churn += 0.025;
    reasons.push('no_recent_accepts');
  }
  churn = Math.max(min, Math.min(max, Number(churn.toFixed(4))));
  return {
    chosenChurnFraction: churn,
    minChurnFraction: min,
    baseChurnFraction: base,
    maxChurnFraction: max,
    reasons,
    metrics: sanitizeDecisionMetrics(metrics),
  };
}

function sanitizeDecisionMetrics(metrics) {
  const out = {};
  for (const key of [
    'prevHonestAccepts',
    'prevQualityAttempts',
    'strictMinableRatioPpm',
    'alreadySolvedRatioPpm',
    'tooHardRatioPpm',
    'acceptedFamilyEntropyPpm',
    'acceptedFingerprintReusePpm',
    'acceptedSelectorReusePpm',
    'randomControlAccepts',
    'randomControlAttempts',
    'noopControlAccepts',
    'noopControlAttempts',
    'hillControlAccepts',
    'hillControlAttempts',
    'acceptedOldCorpusDamageCount',
    'acceptedGoldDamageCount',
    'oldCorpusDamageRejects',
    'goldDamageRejects',
    'reserveRemaining',
    'reserveAdded',
    'activeChurn',
    'baselineParentScorePpm',
    'fixedPackRepeatabilityPpm',
    'recentNoiseFloorPpm',
    'currentMinImprovementPpm',
    'targetAdvances',
    'screenerThresholdPpm',
  ]) {
    if (metrics[key] !== undefined) out[key] = asNonNegativeNumber(metrics[key]);
  }
  if (['rotating_pack', 'broad_sampling', 'unavailable'].includes(metrics.baselineVarianceSource)) {
    out.baselineVarianceSource = metrics.baselineVarianceSource;
    if (metrics.baselineVariancePpm !== undefined && metrics.baselineVarianceSource !== 'unavailable') {
      out.baselineVariancePpm = asNonNegativeNumber(metrics.baselineVariancePpm);
    }
  }
  return out;
}

function runEpochEvolve({ manifestPath, outDir, decision, s3Prefix, parentStateRoot }) {
  const epoch = flag('epoch');
  if (!epoch) fail('--epoch is required');
  if (!parentStateRoot) fail('--parent-state-root is required (chain-derived or explicitly verified)');
  const cmd = [
    resolve(repoRoot, 'scripts/coretex-epoch-evolve.mjs'),
    '--manifest', manifestPath,
    '--epoch', epoch,
    '--out-dir', outDir,
    '--churn', String(decision.chosenChurnFraction),
    '--parent-state-root', parentStateRoot,
  ];
  for (const name of [
    'bundle',
    'profile',
    'source-corpus',
    'previous-corpus',
    'logical-state',
    'frontier-state',
    'checkpoint',
    'private-key',
    'private-key-env',
    'public-key',
    'key-id',
    'previous-root',
    'seed',
    'generated-at',
    'baseline-manifest-hash',
    'hidden-seed-commit',
    'retraction-fraction',
    'min-fresh-eval-hidden',
    'hidden-retire-horizon',
    'max-root-delta-per-epoch',
  ]) {
    const v = flag(name, null);
    if (v !== null) cmd.push(`--${name}`, v);
  }
  if (!flag('previous-root', null) && flag('current-corpus-root', null)) {
    cmd.push('--previous-root', flag('current-corpus-root'));
  }
  if (s3Prefix) cmd.push('--s3-prefix', s3Prefix);
  cmd.push('--prev-honest-accepts', String(decision.metrics.prevHonestAccepts ?? flag('prev-honest-accepts', '0')));
  cmd.push('--prev-quality-attempts', String(decision.metrics.prevQualityAttempts ?? flag('prev-quality-attempts', '0')));
  cmd.push('--quality-attempts-observed', String(decision.metrics.prevQualityAttempts ?? flag('prev-quality-attempts', '0')));
  cmd.push('--advances-observed', String(decision.metrics.prevHonestAccepts ?? flag('prev-honest-accepts', '0')));
  const varianceSource = flag('baseline-variance-source', decision.metrics.baselineVarianceSource ?? 'unavailable');
  cmd.push('--baseline-variance-source', varianceSource);
  const explicitVariance = flag('baseline-variance-ppm', null);
  if (varianceSource !== 'unavailable' && (explicitVariance !== null || decision.metrics.baselineVariancePpm !== undefined)) {
    cmd.push('--baseline-variance-ppm', explicitVariance ?? String(decision.metrics.baselineVariancePpm));
  }
  const fixedRepeatability = flag('fixed-pack-repeatability-ppm', decision.metrics.fixedPackRepeatabilityPpm !== undefined
    ? String(decision.metrics.fixedPackRepeatabilityPpm)
    : null);
  if (fixedRepeatability !== null) cmd.push('--fixed-pack-repeatability-ppm', fixedRepeatability);
  for (const [flagName, metricKey] of [
    ['baseline-parent-score-ppm', 'baselineParentScorePpm'],
    ['recent-noise-floor-ppm', 'recentNoiseFloorPpm'],
    ['current-min-improvement-ppm', 'currentMinImprovementPpm'],
    ['target-advances', 'targetAdvances'],
    ['screener-threshold-ppm', 'screenerThresholdPpm'],
  ]) {
    const explicit = flag(flagName, null);
    const metric = decision.metrics[metricKey];
    if (explicit !== null) cmd.push(`--${flagName}`, explicit);
    else if (metric !== undefined) cmd.push(`--${flagName}`, String(metric));
  }
  // Production dev bypasses are rejected in main(); the ONLY booleans the
  // runner forwards are the documented genesis bootstrap and the explicitly
  // allowed CPU-gate mock embeddings.
  if (has('launch-genesis')) cmd.push('--launch-genesis');
  if (has('mock-embeddings')) cmd.push('--mock-embeddings');
  const r = spawnSync(process.execPath, cmd, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    fail(`coretex:epoch-evolve failed with exit ${r.status}`);
  }
  return JSON.parse(readFileSync(resolve(outDir, `epoch-evolve-output-${epoch}.json`), 'utf8'));
}

function publicKeyMetadata({ outDir, evolveOut }) {
  const publicKeyPath = flag('public-key', evolveOut.artifacts?.devPublicKey ?? null);
  const publicKeyPem = publicKeyPath ? readFileSync(resolve(repoRoot, publicKeyPath)) : null;
  const rotationPath = resolve(outDir, `epoch-rotation-${evolveOut.epoch}.json`);
  // OPTIONAL public URL where the operator publishes the epoch signing key (PEM).
  // When set it flows into the launch manifest status so validator-sync can
  // auto-discover `--public-key`. Omitted when neither flag nor env is provided.
  const publicKeyUrl = flag('public-key-url', env.CORETEX_EPOCH_SIGNING_PUBLIC_KEY_URL ?? null);
  let signerKeyId = flag('key-id', null);
  try {
    const rotation = JSON.parse(readFileSync(rotationPath, 'utf8'));
    signerKeyId = rotation.signer?.keyId ?? signerKeyId;
  } catch {
    // The evolve command already verified the signature; metadata is best-effort for public status.
  }
  return {
    ...(publicKeyUrl ? { epochSigningPublicKeyUrl: publicKeyUrl } : {}),
    ...(signerKeyId ? { epochSigningPublicKeyId: signerKeyId } : {}),
    ...(publicKeyPem ? { epochSigningPublicKeyFingerprint: bytes32FromBytes(publicKeyPem) } : {}),
  };
}

function buildStatus({ manifest, manifestPath, outDir, evolveOut, decision, awsIdentity, verification }) {
  const ctx = evolveOut.coreTexEpochContext;
  const rotationRef = evolveOut.artifacts.rotationManifest;
  const deltaRef = evolveOut.artifacts.delta ?? evolveOut.artifacts.corpusDelta;
  const rotationUrl = s3ToHttps(rotationRef, manifest);
  const deltaUrl = s3ToHttps(deltaRef, manifest);
  const status = {
    schema: 'coretex.coordinator-epoch-status.v1',
    generatedAt: new Date().toISOString(),
    status: 'ready_for_coretex_context_pin',
    currentEpoch: Number(evolveOut.epoch),
    epoch: Number(evolveOut.epoch),
    launchManifestPath: manifestPath,
    bundleHash: ctx.coreVersionHash,
    baselineManifestHash: ctx.baselineManifestHash,
    corpusRoot: ctx.corpusRoot,
    activeFrontierRoot: ctx.activeFrontierRoot,
    rotationManifestHash: evolveOut.rotationManifestHash,
    corpusDeltaHash: evolveOut.corpusDeltaHash,
    rotationManifestUrl: rotationUrl,
    corpusDeltaUrl: deltaUrl,
    rotationManifestRef: rotationRef,
    corpusDeltaRef: deltaRef,
    ...publicKeyMetadata({ outDir, evolveOut }),
    hiddenSeedCommit: ctx.hiddenSeedCommit,
    baselineParentScorePpm: evolveOut.evolve?.baselineParentScorePpm,
    ...(evolveOut.evolve?.baselineVariancePpm !== undefined ? { baselineVariancePpm: evolveOut.evolve.baselineVariancePpm } : {}),
    baselineVarianceSource: evolveOut.evolve?.baselineVarianceSource ?? 'unavailable',
    fixedPackRepeatabilityPpm: evolveOut.evolve?.fixedPackRepeatabilityPpm,
    screenerThresholdPpm: evolveOut.evolve?.screenerThresholdPpm,
    minImprovementPpm: evolveOut.evolve?.minImprovementPpm,
    recentNoiseFloorPpm: evolveOut.evolve?.recentNoiseFloorPpm,
    difficultyController: evolveOut.evolve?.controller,
    thresholds: {
      baselineParentScorePpm: evolveOut.evolve?.baselineParentScorePpm,
      ...(evolveOut.evolve?.baselineVariancePpm !== undefined ? { baselineVariancePpm: evolveOut.evolve.baselineVariancePpm } : {}),
      baselineVarianceSource: evolveOut.evolve?.baselineVarianceSource ?? 'unavailable',
      screenerThresholdPpm: evolveOut.evolve?.screenerThresholdPpm,
      minImprovementPpm: evolveOut.evolve?.minImprovementPpm,
      recentNoiseFloorPpm: evolveOut.evolve?.recentNoiseFloorPpm,
    },
    coreTexEpochContext: ctx,
    parentStateRootSource: verification.parentRootChainVerified ? 'chain' : 'explicit-unverified',
    nextEpochReadiness: {
      ready: true,
      blockers: [],
      checked: readinessCheckedItems({
        baselineBindsRotation:
          String(ctx.baselineManifestHash).toLowerCase() === String(evolveOut.rotationManifestHash).toLowerCase(),
        parentRootChainVerified: verification.parentRootChainVerified,
        s3GetRehashVerified: verification.s3GetRehashVerified,
      }),
    },
    lastEvolveDecision: decision,
    evolve: evolveOut.evolve,
    updatedLogicalStatePath: evolveOut.artifacts.logicalState,
    updatedFrontierStatePath: evolveOut.artifacts.frontierState,
    frontier: {
      activeFrontierRoot: evolveOut.frontier.activeFrontierRoot,
      activeEvalHiddenCount: evolveOut.frontier.activeEvalHiddenCount,
      reserveRemaining: evolveOut.frontier.reserveRemaining,
      activatedCount: frontierCount(evolveOut.frontier.activated),
      retiredCount: frontierCount(evolveOut.frontier.retired),
      injectedLiveEvalCount: frontierCount(evolveOut.frontier.injectedLiveEvalIds),
    },
    ...(awsIdentity ? { awsAccount: awsIdentity.Account, awsArnHash: bytes32FromString(awsIdentity.Arn ?? '') } : {}),
  };
  const localPath = resolve(outDir, `coordinator-epoch-status-${evolveOut.epoch}.json`);
  writeFileSync(localPath, JSON.stringify(status, null, 2) + '\n');
  return { status, localPath };
}

async function main() {
  // Production dev bypasses are rejected outright — never forwarded, never
  // silently dropped. Run coretex-epoch-evolve directly for local dev gates.
  for (const name of FORBIDDEN_PRODUCTION_RUNNER_FLAGS) {
    if (has(name)) fail(`--${name} is forbidden in the production coordinator epoch runner (rejected, not forwarded)`);
  }
  if (has('mock-embeddings') && !has('allow-mock-embeddings')) {
    fail('--mock-embeddings requires --allow-mock-embeddings and is forbidden in production');
  }
  const manifestPath = flag('manifest', DEFAULT_MANIFEST);
  const manifest = readJson(manifestPath);
  if (manifest.schema !== 'coretex.launch-artifacts.v1') fail(`unsupported launch manifest schema ${manifest.schema}`);
  if (manifest.s3RepublishRequired !== false && !has('allow-s3-republish-required')) {
    fail('launch manifest has s3RepublishRequired!=false; refusing coordinator epoch runner');
  }
  const epoch = flag('epoch', null);
  if (!epoch || !Number.isInteger(Number(epoch)) || Number(epoch) < 1) fail('--epoch must be a positive integer');
  const epochNum = Number(epoch);
  const outDir = resolve(repoRoot, flag('out-dir', `release/calibration/2026-06-04-memory-atom-v16/epoch-rotations/epoch-${epoch}`));
  mkdirSync(outDir, { recursive: true });

  // ── Metrics: provenance + freshness before use; default-to-zero forbidden ──
  const launchGenesis = has('launch-genesis');
  const metricsPath = flag('metrics', null);
  if (!metricsPath && metricsRequiredForEpoch(epochNum, launchGenesis)) {
    fail('--metrics is required for epoch >= 2 (silent default-to-zero is forbidden); only explicit launch genesis may omit prior-epoch telemetry');
  }
  let fileMetrics = {};
  if (metricsPath) {
    fileMetrics = maybeReadJson(metricsPath);
    const maxAgeHours = Number(flag('metrics-max-age-hours', '25'));
    if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) fail('--metrics-max-age-hours must be a positive number');
    const problem = validateCoordinatorEpochMetrics(fileMetrics, {
      epoch: epochNum,
      maxAgeMs: maxAgeHours * 3600 * 1000,
      mtimeMs: statSync(resolve(repoRoot, metricsPath)).mtimeMs,
    });
    if (problem) fail(`metrics file ${metricsPath} rejected: ${problem}`);
  }
  const metrics = mergeCoordinatorEpochMetrics(fileMetrics, args);
  const decision = chooseChurn(metrics);

  // ── Parent state root: derive from chain when reachable, else explicit ──
  const rpcUrl = flag('rpc-url', env.BASE_RPC_URL ?? null);
  const registry = flag('registry', env.CORETEX_REGISTRY_ADDRESS ?? null);
  let parentStateRoot = flag('parent-state-root', null)?.toLowerCase() ?? null;
  let parentRootChainVerified = false;
  if (shouldDeriveParentStateRootFromChain({ rpcUrl, registry, parentStateRoot, launchGenesis })) {
    const chainRoot = deriveParentStateRootFromChain({ rpcUrl, registry, completedEpoch: epochNum - 1 });
    if (!chainRoot || chainRoot === ZERO32) {
      fail(`stale parent state root: chain returned no parent state root for completed epoch ${epochNum - 1}`);
    }
    if (parentStateRoot && parentStateRoot !== chainRoot) {
      fail(`stale parent state root: --parent-state-root ${parentStateRoot} != chain-derived ${chainRoot}`);
    }
    parentStateRoot = chainRoot;
    parentRootChainVerified = true;
  }
  if (!parentStateRoot) fail('--parent-state-root is required (or provide --rpc-url/--registry to derive it from chain)');

  const s3Prefix = flag('s3-prefix', env.CORETEX_EPOCH_S3_PREFIX ?? null);
  let awsIdentity = null;
  if (s3Prefix || flag('status-s3-prefix', env.CORETEX_COORDINATOR_STATUS_S3_PREFIX ?? null)) {
    awsIdentity = requireAwsIdentity();
  }
  const evolveOut = runEpochEvolve({ manifestPath, outDir, decision, s3Prefix, parentStateRoot });
  // NOTE: evolve updates the stable --logical-state path atomically itself
  // (tmp + rename, plus the sibling checkpoint); the runner must not re-copy.

  // ── S3 verification: GET every uploaded artifact back + byte rehash ──
  const rotationRef = evolveOut.artifacts.rotationManifest;
  const deltaRef = evolveOut.artifacts.delta ?? evolveOut.artifacts.corpusDelta;
  let s3GetRehashVerified = false;
  if (parseS3Uri(rotationRef) || parseS3Uri(deltaRef)) {
    const rotationLocal = resolve(outDir, `epoch-rotation-${evolveOut.epoch}.json`);
    const deltaLocal = resolve(repoRoot, evolveOut.artifacts.corpusDelta);
    if (parseS3Uri(rotationRef)) await verifyS3GetRehash(rotationLocal, rotationRef, manifest);
    if (parseS3Uri(deltaRef)) await verifyS3GetRehash(deltaLocal, deltaRef, manifest);
    s3GetRehashVerified = true;
  }

  const { status, localPath } = buildStatus({
    manifest, manifestPath, outDir, evolveOut, decision, awsIdentity,
    verification: { parentRootChainVerified, s3GetRehashVerified },
  });

  const statusOut = flag('coordinator-status-out', null);
  if (statusOut) {
    const p = resolve(repoRoot, statusOut);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(status, null, 2) + '\n');
  }
  const statusS3Prefix = flag('status-s3-prefix', env.CORETEX_COORDINATOR_STATUS_S3_PREFIX ?? null);
  const statusS3Uri = flag('status-s3-uri', statusS3Prefix ? s3Join(statusS3Prefix, `coordinator-epoch-status-${evolveOut.epoch}.json`) : null);
  if (statusS3Uri) {
    status.coordinatorStatusUrl = s3ToHttps(statusS3Uri, manifest);
    status.coordinatorStatusRef = statusS3Uri;
    writeFileSync(localPath, JSON.stringify(status, null, 2) + '\n');
    if (statusOut) writeFileSync(resolve(repoRoot, statusOut), JSON.stringify(status, null, 2) + '\n');
    await uploadS3(localPath, statusS3Uri, manifest);
  }
  console.log(JSON.stringify({
    ok: true,
    command: 'coordinator:epoch-runner',
    statusPath: rel(localPath),
    ...(status.coordinatorStatusUrl ? { coordinatorStatusUrl: status.coordinatorStatusUrl } : {}),
    epoch: status.epoch,
    chosenChurnFraction: decision.chosenChurnFraction,
    coreTexEpochContext: status.coreTexEpochContext,
    validatorSync: {
      fromCoordinator: status.coordinatorStatusUrl ?? rel(localPath),
      publicKeyRequired: true,
    },
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e?.stack ?? e?.message ?? String(e)));
}
