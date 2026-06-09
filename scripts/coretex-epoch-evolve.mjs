#!/usr/bin/env node
/**
 * Production epoch evolve/publish command.
 *
 * Builds a signed CorpusDelta and signed EpochRotationManifest from the launch
 * corpus/evolve path, optionally uploads both to S3, and emits the exact V4
 * CoreTex epoch context pins. This is coordinator-side operational wiring, not
 * a stress harness.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, exit } from 'node:process';

import { distIndex, repoRoot } from './_repo-root.mjs';
import { evolveCorpusDelta } from './lib/evolve-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';

const C = await import(distIndex);
const {
  applyCorpusDelta,
  bridgeLogicalDeltaToProductionEvents,
  buildCorpusDelta,
  buildEpochRotationManifest,
  computeCoreTexScreenerThresholdPpm,
  controllerParamsFromProfile,
  DEFAULT_CORETEX_WORK_POLICY,
  hashJson,
  loadProductionCorpus,
  makeEpochFrontier,
  nextMinImprovementPpm,
  serializeCorpusDelta,
  signCorpusDelta,
  signEpochRotationManifest,
  verifyCorpusDeltaSignature,
  verifyEpochRotationManifestSignature,
} = C;

const DEFAULT_MANIFEST = 'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json';
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
function bytes32FromString(s) {
  return `0x${createHash('sha256').update(s).digest('hex')}`;
}
function numberFlag(name, fallback) {
  const raw = flag(name, null);
  const n = raw === null ? Number(fallback) : Number(raw);
  if (!Number.isFinite(n)) fail(`--${name} must be numeric`);
  return n;
}
function optionalNumberFlag(name, fallback = undefined) {
  const raw = flag(name, null);
  if (raw === null && fallback === undefined) return undefined;
  const n = raw === null ? Number(fallback) : Number(raw);
  if (!Number.isFinite(n)) fail(`--${name} must be numeric`);
  return n;
}
function normalizeS3Prefix(prefix) {
  return prefix?.replace(/\/+$/, '') ?? null;
}
function s3Join(prefix, fileName) {
  return `${normalizeS3Prefix(prefix)}/${fileName}`;
}
function uploadS3(localPath, s3Uri) {
  const res = spawnSync('aws', ['s3', 'cp', localPath, s3Uri], { cwd: repoRoot, stdio: 'inherit', env });
  if (res.status !== 0) fail(`aws s3 cp failed for ${localPath} -> ${s3Uri}`);
  const verify = spawnSync('aws', ['s3api', 'head-object', '--bucket', s3Uri.split('/')[2], '--key', s3Uri.split('/').slice(3).join('/')], {
    cwd: repoRoot, stdio: 'pipe', encoding: 'utf8', env,
  });
  if (verify.status !== 0) fail(`aws s3api head-object failed for ${s3Uri}: ${verify.stderr || verify.stdout}`);
}

function deterministicEmbeddingBytes(text, layout) {
  const dim = layout.dim;
  const out = new Uint8Array(4 + dim);
  new DataView(out.buffer).setFloat32(0, 1 / 127, false);
  let cursor = Buffer.alloc(0);
  for (let i = 0; i < dim; i++) {
    if (i % 32 === 0) cursor = createHash('sha256').update(`${text}:${i / 32}`).digest();
    const raw = cursor[i % 32] - 128;
    out[4 + i] = Math.max(-127, Math.min(127, raw)) & 0xff;
  }
  return out;
}

async function realEmbeddingBytes(items, bundlePath, layout) {
  const bundle = readJson(bundlePath);
  const be = bundle.model?.biEncoder;
  if (!be?.modelId || !be?.revision) fail(`bundle ${bundlePath} missing biEncoder pins`);
  const py = env.CORETEX_BIENCODER_PYTHON ?? resolve(repoRoot, '.venv/bin/python');
  const proc = spawn(py, [resolve(repoRoot, 'scripts/bi_encoder_runner.py'), '--stream'], {
    cwd: repoRoot,
    env: {
      ...env,
      HF_HUB_CACHE: env.CORTEX_LOCAL_MODEL_CACHE ?? env.HF_HUB_CACHE ?? '/var/lib/coretex/model-cache',
      HF_HUB_OFFLINE: env.HF_HUB_OFFLINE ?? '1',
      CUDA_VISIBLE_DEVICES: '',
      BIENCODER_NUM_THREADS: env.BIENCODER_NUM_THREADS ?? '8',
      BIENCODER_INNER_BATCH: env.BIENCODER_INNER_BATCH ?? '64',
      CORETEX_BIENCODER_STREAM_MODEL_ID: be.modelId,
      CORETEX_BIENCODER_STREAM_REVISION: be.revision,
      CORETEX_BIENCODER_STREAM_LAYOUT_JSON: JSON.stringify({ dim: layout.dim, quantization: layout.quantization }),
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let ready = false;
  const pending = new Map();
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.ready) { ready = true; return; }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.embeddings);
  });
  proc.on('error', (e) => {
    for (const [, p] of pending) p.reject(e);
  });
  const t0 = Date.now();
  while (!ready) {
    await new Promise((r) => setTimeout(r, 50));
    if (Date.now() - t0 > 5 * 60_000) fail('bi_encoder_runner did not become ready within 5 minutes');
  }
  const corr = `epoch-delta-${Date.now()}`;
  const embeddings = await new Promise((resolveDone, rejectDone) => {
    pending.set(corr, { resolve: resolveDone, reject: rejectDone });
    proc.stdin.write(JSON.stringify({ id: corr, inputs: items.map((x) => ({ text: x.text })) }) + '\n');
  });
  try { proc.stdin.end(); } catch {}
  if (!Array.isArray(embeddings) || embeddings.length !== items.length) {
    fail(`bi_encoder_runner returned ${embeddings?.length} embeddings; expected ${items.length}`);
  }
  return new Map(items.map((item, i) => [item.id, new Uint8Array(Buffer.from(embeddings[i], 'hex'))]));
}

async function embedLogicalDelta(logicalDelta, bundlePath, layout, mock) {
  const docs = logicalDelta.addedDocs.map((d) => ({ id: d.id, text: d.text ?? '' }));
  const queries = logicalDelta.addedQueries.map((q) => ({ id: q.id, text: q.queryText ?? '' }));
  if (mock) {
    return {
      addedDocEmbeddings: new Map(docs.map((d) => [d.id, deterministicEmbeddingBytes(d.text, layout)])),
      addedQueryEmbeddings: new Map(queries.map((q) => [q.id, deterministicEmbeddingBytes(q.text, layout)])),
      embeddingMode: 'deterministic-mock',
    };
  }
  const all = await realEmbeddingBytes([...docs, ...queries], bundlePath, layout);
  return {
    addedDocEmbeddings: new Map(docs.map((d) => [d.id, all.get(d.id)])),
    addedQueryEmbeddings: new Map(queries.map((q) => [q.id, all.get(q.id)])),
    embeddingMode: 'pinned-bge-m3',
  };
}

function readSigningKey(outDir) {
  const keyId = flag('key-id', env.CORETEX_EPOCH_SIGNING_KEY_ID ?? 'coretex-epoch-operator');
  const keyPath = flag('private-key', null);
  const keyEnv = flag('private-key-env', 'CORETEX_EPOCH_SIGNING_PRIVATE_KEY');
  if (keyPath) return { keyId, privateKeyPem: readFileSync(resolve(repoRoot, keyPath), 'utf8'), devPublicKeyPem: null };
  if (env[keyEnv]) return { keyId, privateKeyPem: env[keyEnv], devPublicKeyPem: null };
  if (!has('allow-dev-key')) fail(`missing signing key; pass --private-key, set ${keyEnv}, or use --allow-dev-key for local CPU gates only`);
  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeFileSync(resolve(outDir, 'dev-epoch-public-key.pem'), publicKeyPem);
  return { keyId: `${keyId}-dev`, privateKeyPem, devPublicKeyPem: publicKeyPem };
}

function payloadPath(manifest, role) {
  return manifest.payloads?.find((p) => p.role === role)?.path ?? null;
}

function loadPreviousCorpus({ manifest, bundlePath, corpusPayload, embPayload }) {
  const previousCorpusPath = flag('previous-corpus', null);
  if (previousCorpusPath) {
    return loadProductionCorpus(resolve(repoRoot, previousCorpusPath), {
      verifyCorpusRoot: !has('skip-previous-root-verify'),
      verifySplits: !has('skip-previous-split-verify'),
    });
  }
  return loadMaterializedCorpus(bundlePath, {
    sourceCorpusPath: corpusPayload,
    sourceEmbPath: embPayload,
    verifyCorpusRoot: !has('skip-previous-root-verify'),
    materializedRoot: manifest.materializedRoot,
  }).corpus;
}

function makeFrontier(profile, previousCorpus, nextCorpus, additions, outDir) {
  const fp = profile.epochFrontier;
  if (!fp || fp.mode === 'off') fail('profile epochFrontier is off; cannot emit nonzero activeFrontierRoot');
  const statePath = flag('frontier-state', null);
  const epoch = Number(flag('epoch'));
  let initialState = null;
  if (statePath && existsSync(resolve(repoRoot, statePath))) {
    initialState = readJson(statePath);
  } else if (epoch > 1 && !has('allow-frontier-bootstrap')) {
    fail('frontier state is required after epoch 1; pass --frontier-state or --allow-frontier-bootstrap');
  }
  const ids = initialState
    ? nextCorpus.events.filter((e) => e.split === 'eval_hidden').map((e) => e.id)
    : previousCorpus.events.filter((e) => e.split === 'eval_hidden').map((e) => e.id);
  const byId = new Map(nextCorpus.events.map((e) => [e.id, e]));
  const familyOf = (id) => {
    const e = byId.get(id);
    return e?.logicalFamily ?? e?.family ?? 'unknown';
  };
  const frontier = makeEpochFrontier({
    evalHiddenIds: ids,
    familyOf,
    mode: fp.mode,
    activeWindow: fp.activeWindow,
    minChurn: fp.minChurn,
    maxChurn: fp.maxChurn,
    headroomLowWatermark: fp.headroomLowWatermark,
    headroomHighWatermark: fp.headroomHighWatermark,
    ewmaHalfLife: fp.ewmaHalfLife,
    targetAccepts: fp.targetAccepts,
    expectedYieldPerUnit: fp.expectedYieldPerUnit,
    maxRootDeltaPerEpoch: fp.maxRootDeltaPerEpoch,
    maxAge: fp.maxAge ?? Infinity,
    seed: fp.seed,
    initialState,
  });
  if (!initialState) frontier.stepEpoch(0, null, null);
  const addedEvalIds = additions.filter((e) => e.split === 'eval_hidden').map((e) => e.id);
  const injected = frontier.addReserveIds(addedEvalIds, familyOf);
  const prevHonestAccepts = Number(flag('prev-honest-accepts', '0'));
  const prevQualityAttempts = Number(flag('prev-quality-attempts', '0'));
  const snapshot = frontier.stepEpoch(epoch, prevHonestAccepts, prevQualityAttempts);
  const nextState = frontier.exportState();
  const outStatePath = statePath ? resolve(repoRoot, statePath) : resolve(outDir, 'frontier-state.json');
  writeFileSync(outStatePath, JSON.stringify(nextState, null, 2) + '\n');
  return { snapshot, statePath: outStatePath.replace(`${repoRoot}/`, ''), injected, addedEvalIds };
}

async function main() {
  const manifestPath = flag('manifest', DEFAULT_MANIFEST);
  const epoch = Number(flag('epoch'));
  if (!Number.isInteger(epoch) || epoch < 1) fail('--epoch must be a positive integer');
  const manifest = readJson(manifestPath);
  if (manifest.schema !== 'coretex.launch-artifacts.v1') fail(`unsupported launch manifest schema ${manifest.schema}`);
  const bundlePath = flag('bundle', manifest.bundlePath);
  const profilePath = flag('profile', manifest.profilePath);
  const corpusPayload = flag('source-corpus', payloadPath(manifest, 'corpus'));
  const embPayload = payloadPath(manifest, 'embeddings');
  if (!bundlePath || !profilePath || !corpusPayload) fail('manifest/profile/bundle/source corpus paths are required');
  const outDir = resolve(repoRoot, flag('out-dir', `release/calibration/2026-06-04-memory-atom-v16/epoch-rotations/epoch-${epoch}`));
  mkdirSync(outDir, { recursive: true });
  const { keyId, privateKeyPem, devPublicKeyPem } = readSigningKey(outDir);
  const bundle = readJson(bundlePath);
  const profile = readJson(profilePath);
  const previousCorpus = loadPreviousCorpus({ manifest, bundlePath, corpusPayload, embPayload });
  const expectedPrevRoot = flag('previous-root', previousCorpus.corpusRoot);
  if (previousCorpus.corpusRoot.toLowerCase() !== expectedPrevRoot.toLowerCase()) {
    fail(`previous corpus root ${previousCorpus.corpusRoot} != expected ${expectedPrevRoot}`);
  }

  const logicalPath = flag('logical-state', corpusPayload);
  const logical = readJson(logicalPath);
  logical.docs ??= [];
  logical.relations ??= [];
  logical.queries ??= [];
  const seed = flag('seed', profile.epochFrontier?.seed ?? 'coretex-launch-frontier');
  const churnFraction = Number(flag('churn', '0.1'));
  const logicalDelta = evolveCorpusDelta({ baseLogical: logical, epoch, seed, churnFraction });
  if (logicalDelta.addedDocs.length === 0 && logicalDelta.addedQueries.length === 0) {
    fail('evolve generated empty delta; refusing to publish empty epoch rotation');
  }
  const embeddingModeMock = has('mock-embeddings');
  const { addedDocEmbeddings, addedQueryEmbeddings, embeddingMode } = await embedLogicalDelta(
    logicalDelta,
    bundlePath,
    previousCorpus.biEncoderRetrievalKeyLayout,
    embeddingModeMock,
  );
  const additions = bridgeLogicalDeltaToProductionEvents({
    previousCorpus,
    logicalDelta,
    addedDocEmbeddings,
    addedQueryEmbeddings,
    biEncoder: {
      modelId: previousCorpus.biEncoderModelId,
      revision: previousCorpus.biEncoderRevision,
      layout: previousCorpus.biEncoderRetrievalKeyLayout,
    },
  });
  const generatedAt = flag('generated-at', new Date().toISOString());
  const unsignedDelta = buildCorpusDelta({
    previousCorpus,
    previousRootCache: previousCorpus.corpusRootCache,
    additions,
    removals: [],
    epoch,
    generatedAt,
    labelingProvenance: {
      modelId: previousCorpus.labelingModelId,
      revision: previousCorpus.labelingModelRevision,
      runtime: embeddingMode,
      batchHash: bytes32FromString(JSON.stringify({
        epoch,
        seed,
        docs: logicalDelta.addedDocs.map((d) => d.id),
        queries: logicalDelta.addedQueries.map((q) => q.id),
      })),
    },
  });
  const delta = signCorpusDelta(unsignedDelta, privateKeyPem, keyId);
  const publicKeyPath = flag('public-key', null);
  if (!devPublicKeyPem && !publicKeyPath) fail('delta signature verification requires --public-key when not using --allow-dev-key');
  const publicKeyPem = devPublicKeyPem ?? readFileSync(resolve(repoRoot, publicKeyPath), 'utf8');
  if (!verifyCorpusDeltaSignature(delta, publicKeyPem)) fail('delta signature self-check failed');
  const nextCorpus = applyCorpusDelta(previousCorpus, delta, { rootCache: previousCorpus.corpusRootCache, attachRootCache: true });
  if (nextCorpus.corpusRoot.toLowerCase() !== delta.nextRoot.toLowerCase()) {
    fail(`applyCorpusDelta root ${nextCorpus.corpusRoot} != delta.nextRoot ${delta.nextRoot}`);
  }
  const frontier = makeFrontier(profile, previousCorpus, nextCorpus, additions, outDir);
  const challengeBook = {
    schema: 'coretex.epoch-challenge-book.v1',
    epoch,
    previousCorpusRoot: delta.previousRoot,
    nextCorpusRoot: delta.nextRoot,
    activeFrontierRoot: frontier.snapshot.activeRoot,
    addedEvalHiddenIds: frontier.addedEvalIds,
  };
  const advancesObserved = numberFlag('advances-observed', 0);
  const qualityAttemptsObserved = numberFlag('quality-attempts-observed', flag('prev-quality-attempts', '0'));
  const baselineParentScorePpm = numberFlag('baseline-parent-score-ppm', profile.baselineParentScorePpm ?? 0);
  const baselineVarianceSource = flag('baseline-variance-source', profile.baselineVarianceSource ?? 'unavailable');
  if (!['rotating_pack', 'broad_sampling', 'unavailable'].includes(baselineVarianceSource)) {
    fail('--baseline-variance-source must be rotating_pack, broad_sampling, or unavailable');
  }
  const baselineVariancePpm = baselineVarianceSource === 'rotating_pack' || baselineVarianceSource === 'broad_sampling'
    ? optionalNumberFlag('baseline-variance-ppm', profile.baselineVariancePpm)
    : undefined;
  const fixedPackRepeatabilityPpm = optionalNumberFlag('fixed-pack-repeatability-ppm', profile.fixedPackRepeatabilityPpm ?? profile.baselineVariancePpm);
  const recentNoiseFloorPpm = numberFlag('recent-noise-floor-ppm', 0);
  const currentMinImprovementPpm = numberFlag('current-min-improvement-ppm', profile.patchAcceptanceFloors?.minImprovementPpm ?? bundle.scoring?.minImprovementPpm ?? 2500);
  const targetAdvances = numberFlag('target-advances', profile.epochFrontier?.targetAccepts ?? 3);
  const controllerInputs = {
    current: BigInt(Math.round(currentMinImprovementPpm)),
    observedAdvances: advancesObserved,
    targetAdvances,
    qualityAttempts: qualityAttemptsObserved,
    ...controllerParamsFromProfile(profile, targetAdvances),
  };
  const controllerOutput = nextMinImprovementPpm(controllerInputs);
  const minImprovementPpm = numberFlag('min-improvement-ppm', controllerOutput.next.toString());
  const screenerThresholdPpm = numberFlag('screener-threshold-ppm', computeCoreTexScreenerThresholdPpm({
    baselineScorePpm: baselineParentScorePpm,
    recentNoiseFloorPpm,
    policy: DEFAULT_CORETEX_WORK_POLICY,
  }).toString());
  const controllerForManifest = {
    inputs: Object.fromEntries(Object.entries(controllerInputs).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
    output: {
      next: controllerOutput.next.toString(),
      reason: controllerOutput.reason,
      ratioApplied: controllerOutput.ratioApplied,
      clamped: controllerOutput.clamped,
    },
    reason: controllerOutput.reason,
  };
  const hiddenSeedCommit = flag('hidden-seed-commit', bytes32FromString(`coretex:hidden:${epoch}:${seed}:${delta.nextRoot}`));
  let rotation = buildEpochRotationManifest({
    epoch,
    delta,
    challengeBook,
    bundleHash: bundle.bundleHash,
    minImprovementPpm,
    baselineParentScorePpm,
    ...(baselineVariancePpm !== undefined ? { baselineVariancePpm } : {}),
    baselineVarianceSource,
    fixedPackRepeatabilityPpm,
    screenerThresholdPpm,
    recentNoiseFloorPpm,
    controller: controllerForManifest,
    activeFrontierRoot: frontier.snapshot.activeRoot,
    hiddenSeedCommit,
    advancesObserved,
    qualityAttemptsObserved,
    generatedAt,
  });
  rotation = signEpochRotationManifest(rotation, privateKeyPem, keyId);
  if (!verifyEpochRotationManifestSignature(rotation, publicKeyPem)) fail('rotation manifest signature self-check failed');
  const rotationManifestHash = hashJson(rotation);
  const baselineManifestHash = flag('baseline-manifest-hash', rotationManifestHash);
  const parentStateRoot = flag('parent-state-root', null);
  if (!parentStateRoot && !has('allow-missing-parent-state-root')) fail('--parent-state-root is required for V4 CoreTex epoch context');

  const deltaPath = resolve(outDir, `corpus-delta-epoch-${epoch}.json`);
  const rotationPath = resolve(outDir, `epoch-rotation-${epoch}.json`);
  const logicalDeltaPath = resolve(outDir, `logical-delta-epoch-${epoch}.json`);
  const logicalStatePath = resolve(outDir, `logical-state-epoch-${epoch}.json`);
  writeFileSync(deltaPath, JSON.stringify(serializeCorpusDelta(delta), null, 2) + '\n');
  writeFileSync(rotationPath, JSON.stringify(rotation, null, 2) + '\n');
  writeFileSync(logicalDeltaPath, JSON.stringify(logicalDelta, null, 2) + '\n');
  logical.docs.push(...logicalDelta.addedDocs);
  logical.relations.push(...logicalDelta.addedRelations);
  logical.queries.push(...logicalDelta.addedQueries);
  writeFileSync(logicalStatePath, JSON.stringify(logical, null, 2) + '\n');

  const s3Prefix = flag('s3-prefix', null);
  const published = {};
  if (s3Prefix) {
    const deltaS3 = s3Join(s3Prefix, `corpus-delta-epoch-${epoch}.json`);
    const rotationS3 = s3Join(s3Prefix, `epoch-rotation-${epoch}.json`);
    uploadS3(deltaPath, deltaS3);
    uploadS3(rotationPath, rotationS3);
    published.delta = deltaS3;
    published.rotationManifest = rotationS3;
  }

  const out = {
    ok: true,
    command: 'coretex:epoch-evolve',
    epoch,
    previousCorpusRoot: delta.previousRoot,
    nextCorpusRoot: delta.nextRoot,
    corpusDeltaHash: rotation.corpusDeltaHash,
    rotationManifestHash,
    artifacts: {
      corpusDelta: deltaPath.replace(`${repoRoot}/`, ''),
      rotationManifest: rotationPath.replace(`${repoRoot}/`, ''),
      logicalDelta: logicalDeltaPath.replace(`${repoRoot}/`, ''),
      logicalState: logicalStatePath.replace(`${repoRoot}/`, ''),
      frontierState: frontier.statePath,
      ...(devPublicKeyPem ? { devPublicKey: resolve(outDir, 'dev-epoch-public-key.pem').replace(`${repoRoot}/`, '') } : {}),
      ...published,
    },
    evolve: {
      seed,
      churnFraction,
      addedDocs: logicalDelta.addedDocs.length,
      addedQueries: logicalDelta.addedQueries.length,
      churnedSubjects: logicalDelta.churnedSubjects.length,
      embeddingMode,
      baselineParentScorePpm,
      ...(baselineVariancePpm !== undefined ? { baselineVariancePpm } : {}),
      baselineVarianceSource,
      fixedPackRepeatabilityPpm,
      screenerThresholdPpm,
      minImprovementPpm,
      recentNoiseFloorPpm,
      controller: controllerForManifest,
    },
    frontier: {
      activeFrontierRoot: frontier.snapshot.activeRoot,
      activeEvalHiddenCount: frontier.snapshot.activeEvalHiddenCount,
      injectedLiveEvalIds: frontier.injected,
      activated: frontier.snapshot.activated,
      retired: frontier.snapshot.retired,
      reserveRemaining: frontier.snapshot.reserveRemaining,
    },
    coreTexEpochContext: {
      epoch,
      parentStateRoot: parentStateRoot ?? '0x' + '00'.repeat(32),
      coreVersionHash: bundle.bundleHash,
      corpusRoot: delta.nextRoot,
      activeFrontierRoot: frontier.snapshot.activeRoot,
      baselineManifestHash,
      hiddenSeedCommit,
    },
  };
  const outPath = resolve(outDir, `epoch-evolve-output-${epoch}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => fail(e?.stack ?? e?.message ?? String(e)));
