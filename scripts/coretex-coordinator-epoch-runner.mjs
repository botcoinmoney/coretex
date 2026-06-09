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
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

import { repoRoot } from './_repo-root.mjs';

const DEFAULT_MANIFEST = 'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json';
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
function parseS3Uri(uri) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  return m ? { bucket: m[1], key: m[2] } : null;
}
function s3ToHttps(uri, manifest) {
  const parsed = parseS3Uri(uri);
  if (!parsed) return uri;
  const s3 = manifest.s3 ?? {};
  if (s3.bucket === parsed.bucket && s3.prefix && parsed.key.startsWith(`${s3.prefix}/`) && s3.publicBaseUrl) {
    return `${s3.publicBaseUrl.replace(/\/+$/, '')}/${parsed.key.slice(s3.prefix.length + 1)}`;
  }
  const region = s3.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-2';
  return `https://${parsed.bucket}.s3.${region}.amazonaws.com/${parsed.key}`;
}
function uploadS3(localPath, s3Uri) {
  const parsed = parseS3Uri(s3Uri);
  if (!parsed) fail(`invalid s3 URI ${s3Uri}`);
  const cp = spawnSync('aws', ['s3', 'cp', localPath, s3Uri], { cwd: repoRoot, stdio: 'inherit', env });
  if (cp.status !== 0) fail(`aws s3 cp failed for ${localPath} -> ${s3Uri}`);
  const head = spawnSync('aws', ['s3api', 'head-object', '--bucket', parsed.bucket, '--key', parsed.key], {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
    env,
  });
  if (head.status !== 0) fail(`aws s3api head-object failed for ${s3Uri}: ${head.stderr || head.stdout}`);
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

function runEpochEvolve({ manifestPath, outDir, decision, s3Prefix }) {
  const epoch = flag('epoch');
  if (!epoch) fail('--epoch is required');
  const parentStateRoot = flag('parent-state-root', null);
  if (!parentStateRoot && !has('allow-missing-parent-state-root')) fail('--parent-state-root is required');
  const cmd = [
    resolve(repoRoot, 'scripts/coretex-epoch-evolve.mjs'),
    '--manifest', manifestPath,
    '--epoch', epoch,
    '--out-dir', outDir,
    '--churn', String(decision.chosenChurnFraction),
  ];
  for (const name of [
    'bundle',
    'profile',
    'source-corpus',
    'previous-corpus',
    'logical-state',
    'frontier-state',
    'private-key',
    'private-key-env',
    'public-key',
    'key-id',
    'parent-state-root',
    'previous-root',
    'seed',
    'generated-at',
    'baseline-manifest-hash',
    'hidden-seed-commit',
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
  for (const name of [
    'mock-embeddings',
    'allow-dev-key',
    'allow-frontier-bootstrap',
    'allow-missing-parent-state-root',
    'skip-previous-root-verify',
    'skip-previous-split-verify',
  ]) {
    if (has(name)) cmd.push(`--${name}`);
  }
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
  let signerKeyId = flag('key-id', null);
  try {
    const rotation = JSON.parse(readFileSync(rotationPath, 'utf8'));
    signerKeyId = rotation.signer?.keyId ?? signerKeyId;
  } catch {
    // The evolve command already verified the signature; metadata is best-effort for public status.
  }
  return {
    ...(signerKeyId ? { epochSigningPublicKeyId: signerKeyId } : {}),
    ...(publicKeyPem ? { epochSigningPublicKeyFingerprint: bytes32FromBytes(publicKeyPem) } : {}),
  };
}

function buildStatus({ manifest, manifestPath, outDir, evolveOut, decision, awsIdentity }) {
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
    nextEpochReadiness: {
      ready: true,
      blockers: [],
      checked: [
        'signed_corpus_delta',
        'signed_epoch_rotation_manifest',
        'root_continuity_verified',
        'baseline_manifest_hash_binds_rotation_manifest',
        ...(parseS3Uri(rotationRef) || parseS3Uri(deltaRef) ? ['s3_upload_head_verified'] : []),
      ],
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
  const manifestPath = flag('manifest', DEFAULT_MANIFEST);
  const manifest = readJson(manifestPath);
  if (manifest.schema !== 'coretex.launch-artifacts.v1') fail(`unsupported launch manifest schema ${manifest.schema}`);
  if (manifest.s3RepublishRequired !== false && !has('allow-s3-republish-required')) {
    fail('launch manifest has s3RepublishRequired!=false; refusing coordinator epoch runner');
  }
  if (has('mock-embeddings') && !has('allow-mock-embeddings')) {
    fail('--mock-embeddings requires --allow-mock-embeddings and is forbidden in production');
  }
  const epoch = flag('epoch', null);
  if (!epoch || !Number.isInteger(Number(epoch)) || Number(epoch) < 1) fail('--epoch must be a positive integer');
  const outDir = resolve(repoRoot, flag('out-dir', `release/calibration/2026-06-04-memory-atom-v16/epoch-rotations/epoch-${epoch}`));
  mkdirSync(outDir, { recursive: true });

  const metrics = mergeCoordinatorEpochMetrics(maybeReadJson(flag('metrics', null)), args);
  const decision = chooseChurn(metrics);
  const s3Prefix = flag('s3-prefix', env.CORETEX_EPOCH_S3_PREFIX ?? null);
  let awsIdentity = null;
  if (s3Prefix || flag('status-s3-prefix', env.CORETEX_COORDINATOR_STATUS_S3_PREFIX ?? null)) {
    awsIdentity = requireAwsIdentity();
  }
  const evolveOut = runEpochEvolve({ manifestPath, outDir, decision, s3Prefix });
  const logicalStatePath = flag('logical-state', null);
  if (logicalStatePath && evolveOut.artifacts.logicalState && !has('no-persist-logical-state')) {
    const dst = resolve(repoRoot, logicalStatePath);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(resolve(repoRoot, evolveOut.artifacts.logicalState), dst);
  }
  const { status, localPath } = buildStatus({ manifest, manifestPath, outDir, evolveOut, decision, awsIdentity });

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
    uploadS3(localPath, statusS3Uri);
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
