#!/usr/bin/env node
/**
 * DEV / MANUAL epoch evolve/publish command.
 *
 * Builds a signed CorpusDelta and signed EpochRotationManifest from the launch
 * corpus/evolve path, optionally uploads both to S3, and emits the exact V4
 * CoreTex epoch context pins.
 *
 * NOT the production publish path. The ONLY production cutover/publish path is
 * the orchestrated coordinator epoch runner (scripts/coretex-coordinator-epoch-runner.mjs),
 * which adds telemetry-bounded churn selection and the full fail-closed cutover
 * orchestration around this command. Use this script directly only for local
 * CPU gates / manual dev runs. S3 uploads here are verified to the SAME hardened
 * standard as the runner: GET-over-public-URL + sha256 byte rehash (not a mere
 * head-object existence check).
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, exit, pid } from 'node:process';

import { distIndex, repoRoot } from './_repo-root.mjs';
import { evolveCorpusDelta } from './lib/evolve-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { verifyS3GetRehash } from './lib/s3-get-rehash.mjs';

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
  isMajorDelta,
  liveTailQueryId,
  loadProductionCorpus,
  logicalQueryIdFromProductionEventId,
  makeEpochFrontier,
  nextMinImprovementPpm,
  productionEventIdForLogicalDoc,
  productionEventIdForLogicalQuery,
  pruneEpochFrontierState,
  serializeCorpusDelta,
  signCorpusDelta,
  signEpochRotationManifest,
  splitForRecord,
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
let atomicWriteCounter = 0;
/** All state/artifact writes go through tmp-file + atomic rename — never a plain write to the final path. */
function writeFileAtomic(absPath, data) {
  const tmp = `${absPath}.tmp-${pid}-${atomicWriteCounter++}`;
  writeFileSync(tmp, data);
  renameSync(tmp, absPath);
}
function sha256OfFile(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}
/** Checkpoint sibling path for a logical-state file: <name>.checkpoint.json next to <name>.json. */
function checkpointPathFor(logicalStatePath) {
  return logicalStatePath.replace(/\.json$/, '') + '.checkpoint.json';
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
function optionalNonNegativeIntegerFlag(name, fallback = undefined) {
  const raw = flag(name, null);
  if (raw === null && fallback === undefined) return undefined;
  const n = raw === null ? Number(fallback) : Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
}
function optionalPositiveIntegerFlag(name, fallback = undefined) {
  const raw = flag(name, null);
  if (raw === null && fallback === undefined) return undefined;
  const n = raw === null ? Number(fallback) : Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) fail(`--${name} must be a positive integer`);
  return n;
}
function normalizeS3Prefix(prefix) {
  return prefix?.replace(/\/+$/, '') ?? null;
}
function s3Join(prefix, fileName) {
  return `${normalizeS3Prefix(prefix)}/${fileName}`;
}
async function uploadS3(localPath, s3Uri) {
  const res = spawnSync('aws', ['s3', 'cp', localPath, s3Uri], { cwd: repoRoot, stdio: 'inherit', env });
  if (res.status !== 0) fail(`aws s3 cp failed for ${localPath} -> ${s3Uri}`);
  // Hardened verify (matches the production runner): head-object existence is NOT
  // verification — fetch the uploaded object back over its PUBLIC https url and
  // rehash the bytes against the local file, failing loudly on any mismatch.
  try {
    await verifyS3GetRehash(localPath, s3Uri, { env });
  } catch (e) {
    fail(e?.message ?? String(e));
  }
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

async function realEmbeddingBytes(items, bundlePath, layout, { maxWallMs = undefined } = {}) {
  const bundle = readJson(bundlePath);
  const be = bundle.model?.biEncoder;
  if (!be?.modelId || !be?.revision) fail(`bundle ${bundlePath} missing biEncoder pins`);
  const device = (env.CORETEX_BIENCODER_DEVICE ?? 'cpu').trim().toLowerCase();
  if (device !== 'cpu' && device !== 'cuda') fail('CORETEX_BIENCODER_DEVICE must be cpu or cuda');
  if (device === 'cuda') {
    if (env.CORETEX_BIENCODER_ALLOW_CUDA !== '1') {
      fail('CORETEX_BIENCODER_DEVICE=cuda requires CORETEX_BIENCODER_ALLOW_CUDA=1');
    }
    if (env.CUDA_VISIBLE_DEVICES === '') {
      fail('CORETEX_BIENCODER_DEVICE=cuda cannot run with CUDA_VISIBLE_DEVICES empty');
    }
  }
  const py = env.CORETEX_BIENCODER_PYTHON ?? resolve(repoRoot, '.venv/bin/python');
  const childEnv = {
    ...env,
    HF_HUB_CACHE: env.CORTEX_LOCAL_MODEL_CACHE ?? env.HF_HUB_CACHE ?? '/var/lib/coretex/model-cache',
    HF_HUB_OFFLINE: env.HF_HUB_OFFLINE ?? '1',
    BIENCODER_NUM_THREADS: env.BIENCODER_NUM_THREADS ?? '8',
    BIENCODER_INNER_BATCH: env.BIENCODER_INNER_BATCH ?? '64',
    CORETEX_BIENCODER_DEVICE: device,
    CORETEX_BIENCODER_STREAM_MODEL_ID: be.modelId,
    CORETEX_BIENCODER_STREAM_REVISION: be.revision,
    CORETEX_BIENCODER_STREAM_LAYOUT_JSON: JSON.stringify({ dim: layout.dim, quantization: layout.quantization }),
  };
  if (device === 'cpu') childEnv.CUDA_VISIBLE_DEVICES = '';
  const proc = spawn(py, [resolve(repoRoot, 'scripts/bi_encoder_runner.py'), '--stream'], {
    cwd: repoRoot,
    env: childEnv,
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
  const deadline = maxWallMs !== undefined ? t0 + maxWallMs : undefined;
  while (!ready) {
    await new Promise((r) => setTimeout(r, 50));
    if (deadline !== undefined && Date.now() > deadline) {
      try { proc.kill('SIGKILL'); } catch {}
      fail(`bi_encoder_runner exceeded --max-wall-ms=${maxWallMs} before ready`);
    }
    if (Date.now() - t0 > 5 * 60_000) fail('bi_encoder_runner did not become ready within 5 minutes');
  }
  const corr = `epoch-delta-${Date.now()}`;
  const embeddings = await new Promise((resolveDone, rejectDone) => {
    const timeout = deadline === undefined
      ? null
      : setTimeout(() => {
          pending.delete(corr);
          try { proc.kill('SIGKILL'); } catch {}
          rejectDone(new Error(`bi_encoder_runner exceeded --max-wall-ms=${maxWallMs}`));
        }, Math.max(1, deadline - Date.now()));
    pending.set(corr, {
      resolve: (value) => {
        if (timeout) clearTimeout(timeout);
        resolveDone(value);
      },
      reject: (err) => {
        if (timeout) clearTimeout(timeout);
        rejectDone(err);
      },
    });
    proc.stdin.write(JSON.stringify({ id: corr, inputs: items.map((x) => ({ text: x.text })) }) + '\n');
  });
  try { proc.stdin.end(); } catch {}
  if (!Array.isArray(embeddings) || embeddings.length !== items.length) {
    fail(`bi_encoder_runner returned ${embeddings?.length} embeddings; expected ${items.length}`);
  }
  return new Map(items.map((item, i) => [item.id, new Uint8Array(Buffer.from(embeddings[i], 'hex'))]));
}

async function embedLogicalDelta(logicalDelta, bundlePath, layout, mock, opts = {}) {
  const docs = logicalDelta.addedDocs.map((d) => ({ id: d.id, text: d.text ?? '' }));
  const queries = logicalDelta.addedQueries.map((q) => ({ id: q.id, text: q.queryText ?? '' }));
  if (mock) {
    return {
      addedDocEmbeddings: new Map(docs.map((d) => [d.id, deterministicEmbeddingBytes(d.text, layout)])),
      addedQueryEmbeddings: new Map(queries.map((q) => [q.id, deterministicEmbeddingBytes(q.text, layout)])),
      embeddingMode: 'deterministic-mock',
    };
  }
  const all = await realEmbeddingBytes([...docs, ...queries], bundlePath, layout, opts);
  const device = (env.CORETEX_BIENCODER_DEVICE ?? 'cpu').trim().toLowerCase();
  return {
    addedDocEmbeddings: new Map(docs.map((d) => [d.id, all.get(d.id)])),
    addedQueryEmbeddings: new Map(queries.map((q) => [q.id, all.get(q.id)])),
    embeddingMode: device === 'cuda' ? 'pinned-bge-m3-cuda' : 'pinned-bge-m3',
  };
}

function planLogicalDeltaRemovals({ logicalDelta, logical, previousCorpus, maxRootDeltaPerEpoch }) {
  const logicalDocsById = new Map(logical.docs.map((d) => [d.id, d]));
  const logicalQueriesById = new Map(logical.queries.map((q) => [q.id, q]));
  const removedIds = [];
  const removedIdSet = new Set();
  const removedEvalHiddenIds = [];
  const removedEvalHiddenSet = new Set();
  const pushRemoved = (id) => {
    if (removedIdSet.has(id)) return;
    removedIdSet.add(id);
    removedIds.push(id);
  };
  const pushRemovedEvalHidden = (id) => {
    pushRemoved(id);
    if (!removedEvalHiddenSet.has(id)) {
      removedEvalHiddenSet.add(id);
      removedEvalHiddenIds.push(id);
    }
  };
  const retractedProdDocIds = new Set();
  const retractedQrelDocIds = new Set(logicalDelta.retractedDocIds);
  for (const docId of logicalDelta.retractedDocIds) {
    const prodId = productionEventIdForLogicalDoc(previousCorpus, logicalDocsById.get(docId) ?? { id: docId });
    if (!prodId) fail(`retracted doc ${docId} does not resolve to a production corpus event — logical/production state divergence`);
    pushRemoved(prodId);
    retractedProdDocIds.add(prodId);
    const prodEvent = previousCorpus.byId.get(prodId);
    for (const truth of prodEvent?.truthDocuments ?? []) {
      if (truth?.id) retractedQrelDocIds.add(String(truth.id));
    }
  }
  if (retractedProdDocIds.size > 0 || retractedQrelDocIds.size > 0) {
    const retiredLogicalQuerySet = new Set(logicalDelta.retiredQueryIds);
    for (const event of previousCorpus.events) {
      if (event.split !== 'eval_hidden') continue;
      const qrels = Array.isArray(event.qrels) ? event.qrels : [];
      const broken = qrels.some((qrel) => {
        if (Number(qrel?.relevance ?? 0) <= 0) return false;
        const docId = String(qrel?.documentId ?? '');
        return retractedProdDocIds.has(docId) || retractedQrelDocIds.has(docId);
      });
      if (!broken) continue;
      pushRemovedEvalHidden(event.id);
      retiredLogicalQuerySet.add(logicalQueryIdFromProductionEventId(event.id));
    }
    logicalDelta.retiredQueryIds = [...retiredLogicalQuerySet];
  }
  for (const queryId of logicalDelta.retiredQueryIds) {
    const prodId = productionEventIdForLogicalQuery(previousCorpus, logicalQueriesById.get(queryId) ?? { id: queryId });
    if (!prodId) fail(`retired hidden query ${queryId} does not resolve to a production corpus event — logical/production state divergence`);
    pushRemovedEvalHidden(prodId);
  }
  return { removedIds, removedEvalHiddenIds, retractedProdDocIds, retractedQrelDocIds };
}

function buildEvolveEstimate({ epoch, seed, churnFraction, retractionFraction, logicalDelta, removalPlan, minFreshEvalHidden, hiddenRetireHorizon, maxRootDeltaPerEpoch }) {
  const freshEvalHidden = Array.isArray(logicalDelta.freshEvalHiddenQueryIds)
    ? logicalDelta.freshEvalHiddenQueryIds.length
    : 0;
  return {
    schema: 'coretex.epoch-evolve-estimate.v1',
    epoch,
    seed,
    churnFraction,
    retractionFraction,
    churnedSubjects: logicalDelta.churnedSubjects.length,
    addedDocs: logicalDelta.addedDocs.length,
    addedQueries: logicalDelta.addedQueries.length,
    addedRelations: logicalDelta.addedRelations.length,
    estimatedEmbeddings: logicalDelta.addedDocs.length + logicalDelta.addedQueries.length,
    retractedDocs: logicalDelta.retractedDocIds.length,
    retiredHiddenQueries: logicalDelta.retiredQueryIds.length,
    removedIds: removalPlan.removedIds.length,
    removedEvalHiddenIds: removalPlan.removedEvalHiddenIds.length,
    freshEvalHidden,
    minFreshEvalHidden,
    hiddenRetireHorizon,
    maxRootDeltaPerEpoch,
    rootDeltaPressure: Math.max(freshEvalHidden, removalPlan.removedEvalHiddenIds.length),
  };
}

function enforceEvolveBudgets(estimate, { maxEmbeddings, maxRemovals, targetFreshHidden, maxRootDeltaPerEpoch }) {
  if (maxEmbeddings !== undefined && estimate.estimatedEmbeddings > maxEmbeddings) {
    fail(`estimate requires ${estimate.estimatedEmbeddings} embeddings > --max-embeddings ${maxEmbeddings}`);
  }
  if (maxRemovals !== undefined && estimate.removedIds > maxRemovals) {
    fail(`estimate removes ${estimate.removedIds} ids > --max-removals ${maxRemovals}`);
  }
  if (maxRootDeltaPerEpoch !== undefined && estimate.rootDeltaPressure > maxRootDeltaPerEpoch) {
    fail(
      `estimate root-delta pressure ${estimate.rootDeltaPressure} exceeds --max-root-delta-per-epoch ${maxRootDeltaPerEpoch} ` +
      `(freshEvalHidden=${estimate.freshEvalHidden}, removedEvalHiddenIds=${estimate.removedEvalHiddenIds})`,
    );
  }
  if (targetFreshHidden !== undefined && estimate.freshEvalHidden < targetFreshHidden) {
    fail(`estimate mints ${estimate.freshEvalHidden} fresh eval_hidden queries < --target-fresh-hidden ${targetFreshHidden}`);
  }
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

function loadPreviousCorpus({ manifest, bundlePath, corpusPayload, embPayload, launchGenesis }) {
  const previousCorpusPath = flag('previous-corpus', null);
  if (previousCorpusPath && (!launchGenesis || existsSync(resolve(repoRoot, previousCorpusPath)))) {
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

function makeFrontier(profile, previousCorpus, nextCorpus, additions, outDir, { initialStateRaw, launchGenesis, maxRootDeltaPerEpoch }) {
  const fp = profile.epochFrontier;
  if (!fp || fp.mode === 'off') fail('profile epochFrontier is off; cannot emit nonzero activeFrontierRoot');
  const statePath = flag('frontier-state', null);
  const epoch = Number(flag('epoch'));
  // Hidden rows retired via removedIds this epoch are no longer in nextCorpus; the persisted
  // frontier state MUST be pruned to the surviving ids before re-hydration (makeEpochFrontier
  // hard-rejects unknown ids). Pruned ACTIVE ids are forced activeFrontierRoot changes and are
  // charged against maxRootDeltaPerEpoch below.
  let initialState = null;
  let pruned = null;
  if (initialStateRaw) {
    pruned = pruneEpochFrontierState(initialStateRaw, (id) => nextCorpus.byId.has(id));
    initialState = pruned.state;
  } else if (epoch > 1 && !launchGenesis) {
    fail('frontier state is required after epoch 1; epoch >= 2 must thread the previous epoch frontier state unless --launch-genesis is explicitly bootstrapping CoreTex');
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
  // Root-delta cap enforcement (defense in depth over the frontier's internal clamp): the
  // per-epoch activeFrontierRoot churn — activations, retirements, and forced prunes — must
  // not exceed maxRootDeltaPerEpoch. The genesis bootstrap activation (window fill) is exempt.
  if (initialState) {
    const prunedActive = pruned?.prunedActiveIds.length ?? 0;
    const rootDelta = Math.max(snapshot.activated, snapshot.retired + prunedActive);
    if (rootDelta > maxRootDeltaPerEpoch) {
      fail(`active frontier root delta ${rootDelta} (activated=${snapshot.activated} retired=${snapshot.retired} prunedActive=${prunedActive}) exceeds maxRootDeltaPerEpoch ${maxRootDeltaPerEpoch}; refusing to emit the epoch rotation`);
    }
  }
  const nextState = frontier.exportState();
  const nextStateJson = JSON.stringify(nextState, null, 2) + '\n';
  const outStatePath = statePath ? resolve(repoRoot, statePath) : resolve(outDir, 'frontier-state.json');
  writeFileAtomic(outStatePath, nextStateJson);
  return {
    snapshot,
    statePath: outStatePath.replace(`${repoRoot}/`, ''),
    stateJson: nextStateJson,
    injected,
    addedEvalIds,
    prunedActiveIds: pruned?.prunedActiveIds ?? [],
    prunedOrderIds: pruned?.prunedOrderIds ?? [],
  };
}

async function main() {
  const manifestPath = flag('manifest', DEFAULT_MANIFEST);
  const epoch = Number(flag('epoch'));
  if (!Number.isInteger(epoch) || epoch < 1) fail('--epoch must be a positive integer');
  const maxWallMs = optionalPositiveIntegerFlag('max-wall-ms');
  const wallStartedAtMs = Date.now();
  const assertWallBudget = (stage) => {
    if (maxWallMs === undefined) return;
    const elapsed = Date.now() - wallStartedAtMs;
    if (elapsed > maxWallMs) fail(`epoch evolve exceeded --max-wall-ms=${maxWallMs} at ${stage} (elapsed ${elapsed}ms)`);
  };
  const remainingWallMs = () => {
    if (maxWallMs === undefined) return undefined;
    return Math.max(1, maxWallMs - (Date.now() - wallStartedAtMs));
  };
  const manifest = readJson(manifestPath);
  if (manifest.schema !== 'coretex.launch-artifacts.v1') fail(`unsupported launch manifest schema ${manifest.schema}`);
  const bundlePath = flag('bundle', manifest.bundlePath);
  const profilePath = flag('profile', manifest.profilePath);
  const corpusPayload = flag('source-corpus', payloadPath(manifest, 'corpus'));
  const embPayload = payloadPath(manifest, 'embeddings');
  if (!bundlePath || !profilePath || !corpusPayload) fail('manifest/profile/bundle/source corpus paths are required');

  // ── Mandatory state threading (epoch continuity) ────────────────────────────
  // Production must NEVER silently evolve from the genesis launch corpus. A chain can launch
  // CoreTex after contract epoch 1, so genesis defaults are allowed ONLY via the explicit
  // --launch-genesis flag; all non-genesis epochs hard-fail unless the previous epoch's
  // checkpoint (logical state + frontier state + materialized corpus root) is supplied and
  // internally consistent.
  const launchGenesis = has('launch-genesis');
  const logicalStateFlag = flag('logical-state', null);
  if (!logicalStateFlag && !launchGenesis) {
    fail('--logical-state is required: pass the previous epoch evolved logical state, or --launch-genesis to bootstrap CoreTex from the launch corpus');
  }
  const frontierStateFlag = flag('frontier-state', null);
  let checkpoint = null;
  if (epoch >= 2 && !launchGenesis) {
    if (has('allow-frontier-bootstrap')) fail('--allow-frontier-bootstrap is no longer permitted for epoch >= 2; thread the previous epoch frontier state');
    if (!frontierStateFlag) fail('--frontier-state is required for epoch >= 2 (mandatory state threading)');
    if (!flag('previous-corpus', null)) fail('--previous-corpus is required for epoch >= 2: the manifest materialized corpus is the GENESIS corpus and must not be re-used after epoch 1');
    const checkpointPath = flag('checkpoint', checkpointPathFor(logicalStateFlag));
    const absCheckpoint = resolve(repoRoot, checkpointPath);
    if (!existsSync(absCheckpoint)) {
      fail(`previous epoch checkpoint not found at ${checkpointPath}; epoch ${epoch} requires epoch ${epoch - 1}'s checkpoint (logical state + frontier state + materialized corpus root)`);
    }
    checkpoint = JSON.parse(readFileSync(absCheckpoint, 'utf8'));
    if (checkpoint.schema !== 'coretex.epoch-evolve-checkpoint.v1') fail(`unsupported checkpoint schema ${checkpoint.schema} at ${checkpointPath}`);
    if (checkpoint.epoch !== epoch - 1) fail(`checkpoint at ${checkpointPath} is for epoch ${checkpoint.epoch}; epoch ${epoch} requires the epoch ${epoch - 1} checkpoint`);
    const logicalSha = sha256OfFile(resolve(repoRoot, logicalStateFlag));
    if (logicalSha !== checkpoint.logicalStateSha256) {
      fail(`--logical-state ${logicalStateFlag} sha256 ${logicalSha} does not match checkpoint.logicalStateSha256 ${checkpoint.logicalStateSha256}`);
    }
    const absFrontier = resolve(repoRoot, frontierStateFlag);
    if (!existsSync(absFrontier)) fail(`--frontier-state ${frontierStateFlag} not found; epoch >= 2 requires the previous epoch frontier state`);
    const frontierSha = sha256OfFile(absFrontier);
    if (frontierSha !== checkpoint.frontierStateSha256) {
      fail(`--frontier-state ${frontierStateFlag} sha256 ${frontierSha} does not match checkpoint.frontierStateSha256 ${checkpoint.frontierStateSha256}`);
    }
  }
  const frontierInitialStateRaw = !launchGenesis && frontierStateFlag && existsSync(resolve(repoRoot, frontierStateFlag))
    ? readJson(frontierStateFlag)
    : null;

  const outDir = resolve(repoRoot, flag('out-dir', `release/calibration/2026-06-04-memory-atom-v16/epoch-rotations/epoch-${epoch}`));
  mkdirSync(outDir, { recursive: true });
  const { keyId, privateKeyPem, devPublicKeyPem } = readSigningKey(outDir);
  const bundle = readJson(bundlePath);
  const profile = readJson(profilePath);
  const previousCorpus = loadPreviousCorpus({ manifest, bundlePath, corpusPayload, embPayload, launchGenesis });
  if (launchGenesis && manifest.corpusRoot && previousCorpus.corpusRoot.toLowerCase() !== manifest.corpusRoot.toLowerCase()) {
    fail(`launch genesis must evolve from launch corpus root ${manifest.corpusRoot}; got ${previousCorpus.corpusRoot}`);
  }
  const expectedPrevRoot = flag('previous-root', previousCorpus.corpusRoot);
  if (previousCorpus.corpusRoot.toLowerCase() !== expectedPrevRoot.toLowerCase()) {
    fail(`previous corpus root ${previousCorpus.corpusRoot} != expected ${expectedPrevRoot}`);
  }
  if (checkpoint && previousCorpus.corpusRoot.toLowerCase() !== checkpoint.corpusRoot.toLowerCase()) {
    fail(`previous corpus root ${previousCorpus.corpusRoot} != checkpoint corpus root ${checkpoint.corpusRoot} — epoch ${epoch} must evolve from epoch ${epoch - 1}'s materialized corpus, not genesis`);
  }

  const logicalPath = launchGenesis ? corpusPayload : flag('logical-state', corpusPayload);
  const logical = readJson(logicalPath);
  logical.docs ??= [];
  logical.relations ??= [];
  logical.queries ??= [];
  const seed = flag('seed', profile.epochFrontier?.seed ?? 'coretex-launch-frontier');
  const churnFraction = Number(flag('churn', '0.1'));
  const retractionFraction = numberFlag('retraction-fraction', profile.evolve?.retractionFraction ?? 0.02);
  const configuredMinFreshEvalHidden = numberFlag('min-fresh-eval-hidden', profile.evolve?.minFreshEvalHiddenPerEpoch ?? 8);
  const targetFreshHidden = optionalNonNegativeIntegerFlag('target-fresh-hidden');
  const minFreshEvalHidden = Math.max(configuredMinFreshEvalHidden, targetFreshHidden ?? 0);
  const hiddenRetireHorizon = numberFlag('hidden-retire-horizon', profile.evolve?.evalHiddenRetireHorizonEpochs ?? 6);
  const maxRootDeltaPerEpoch = numberFlag('max-root-delta-per-epoch', profile.epochFrontier?.maxRootDeltaPerEpoch ?? 24);
  const maxEmbeddings = optionalNonNegativeIntegerFlag('max-embeddings');
  const maxRemovals = optionalNonNegativeIntegerFlag('max-removals');
  // Canonical split assignment over the PRODUCTION event id — injected so the generator stays pure.
  const splitOf = (logicalQueryId, liveUpdateEpoch) => splitForRecord(
    liveUpdateEpoch !== undefined && liveUpdateEpoch !== null ? liveTailQueryId(logicalQueryId, liveUpdateEpoch) : logicalQueryId,
    previousCorpus.corpusEpoch,
  );
  // Hidden rows currently ACTIVE in the frontier must not be retired out from under miners.
  const activeFrontierLogicalIds = new Set(
    (frontierInitialStateRaw?.active ?? []).map(([id]) => logicalQueryIdFromProductionEventId(id)),
  );
  const logicalDelta = evolveCorpusDelta({
    baseLogical: logical,
    epoch,
    seed,
    churnFraction,
    retractionFraction,
    evalHiddenPolicy: {
      splitOf,
      minFreshPerEpoch: minFreshEvalHidden,
      retireAfterEpochs: hiddenRetireHorizon,
      maxRetiredPerEpoch: maxRootDeltaPerEpoch,
      maxMintedPerEpoch: maxRootDeltaPerEpoch,
      excludeRetireIds: activeFrontierLogicalIds,
    },
  });
  if (logicalDelta.addedDocs.length === 0 && logicalDelta.addedQueries.length === 0) {
    fail('evolve generated empty delta; refusing to publish empty epoch rotation');
  }
  assertWallBudget('logical-delta');
  const removalPlan = planLogicalDeltaRemovals({ logicalDelta, logical, previousCorpus, maxRootDeltaPerEpoch });
  const estimate = buildEvolveEstimate({
    epoch,
    seed,
    churnFraction,
    retractionFraction,
    logicalDelta,
    removalPlan,
    minFreshEvalHidden,
    hiddenRetireHorizon,
    maxRootDeltaPerEpoch,
  });
  const estimatePath = resolve(outDir, `epoch-evolve-estimate-${epoch}.json`);
  writeFileAtomic(estimatePath, JSON.stringify(estimate, null, 2) + '\n');
  assertWallBudget('estimate');
  if (has('estimate-only') || has('estimate-report-only')) {
    if (!has('estimate-report-only')) {
      enforceEvolveBudgets(estimate, { maxEmbeddings, maxRemovals, targetFreshHidden, maxRootDeltaPerEpoch });
    }
    console.log(JSON.stringify({
      ok: true,
      command: 'coretex:epoch-evolve-estimate',
      reportOnly: has('estimate-report-only'),
      estimate,
      estimatePath: estimatePath.replace(`${repoRoot}/`, ''),
    }, null, 2));
    return;
  }
  enforceEvolveBudgets(estimate, { maxEmbeddings, maxRemovals, targetFreshHidden, maxRootDeltaPerEpoch });
  const embeddingModeMock = has('mock-embeddings');
  const { addedDocEmbeddings, addedQueryEmbeddings, embeddingMode } = await embedLogicalDelta(
    logicalDelta,
    bundlePath,
    previousCorpus.biEncoderRetrievalKeyLayout,
    embeddingModeMock,
    { maxWallMs: remainingWallMs() },
  );
  assertWallBudget('embedding');
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
  // ── Fresh hidden-eval quota (security gate: public-qrels memorization decay) ──
  const freshEvalHiddenAdded = additions.filter((e) => e.split === 'eval_hidden').map((e) => e.id);
  if (freshEvalHiddenAdded.length < minFreshEvalHidden) {
    fail(`delta mints ${freshEvalHiddenAdded.length} fresh eval_hidden queries < pinned quota ${minFreshEvalHidden}; refusing to publish the epoch rotation`);
  }
  const { removedIds, removedEvalHiddenIds, retractedProdDocIds, retractedQrelDocIds } = removalPlan;

  const generatedAt = flag('generated-at', new Date().toISOString());
  const unsignedDelta = buildCorpusDelta({
    previousCorpus,
    previousRootCache: previousCorpus.corpusRootCache,
    additions,
    removals: removedIds,
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
        removed: removedIds,
      })),
    },
  });
  const delta = signCorpusDelta(unsignedDelta, privateKeyPem, keyId);
  assertWallBudget('corpus-delta');
  const publicKeyPath = flag('public-key', null);
  if (!devPublicKeyPem && !publicKeyPath) fail('delta signature verification requires --public-key when not using --allow-dev-key');
  const publicKeyPem = devPublicKeyPem ?? readFileSync(resolve(repoRoot, publicKeyPath), 'utf8');
  if (!verifyCorpusDeltaSignature(delta, publicKeyPem)) fail('delta signature self-check failed');
  const nextCorpus = applyCorpusDelta(previousCorpus, delta, { rootCache: previousCorpus.corpusRootCache, attachRootCache: true });
  if (nextCorpus.corpusRoot.toLowerCase() !== delta.nextRoot.toLowerCase()) {
    fail(`applyCorpusDelta root ${nextCorpus.corpusRoot} != delta.nextRoot ${delta.nextRoot}`);
  }
  const missingPositiveQrels = [];
  const availableQrelDocIds = new Set();
  for (const event of nextCorpus.events) {
    availableQrelDocIds.add(event.id);
    for (const truth of event.truthDocuments ?? []) if (truth?.id) availableQrelDocIds.add(String(truth.id));
  }
  for (const event of nextCorpus.events) {
    if (event.split !== 'eval_hidden') continue;
    for (const qrel of event.qrels ?? []) {
      if (Number(qrel.relevance ?? 0) <= 0) continue;
      if (!availableQrelDocIds.has(qrel.documentId) || retractedQrelDocIds.has(qrel.documentId) || retractedProdDocIds.has(qrel.documentId)) {
        missingPositiveQrels.push(`${event.id}->${qrel.documentId}`);
      }
    }
  }
  if (missingPositiveQrels.length > 0) {
    fail(`post-delta invariant failed: eval_hidden positive qrels reference missing docs (${missingPositiveQrels.slice(0, 8).join(', ')})`);
  }
  const frontier = makeFrontier(profile, previousCorpus, nextCorpus, additions, outDir, {
    initialStateRaw: frontierInitialStateRaw,
    launchGenesis,
    maxRootDeltaPerEpoch,
  });
  assertWallBudget('frontier');
  const challengeBook = {
    schema: 'coretex.epoch-challenge-book.v1',
    epoch,
    previousCorpusRoot: delta.previousRoot,
    nextCorpusRoot: delta.nextRoot,
    activeFrontierRoot: frontier.snapshot.activeRoot,
    addedEvalHiddenIds: frontier.addedEvalIds,
    removedEvalHiddenIds,
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
  const currentMinImprovementPpm = numberFlag('current-min-improvement-ppm', profile.patchAcceptanceFloors?.minImprovementPpm ?? bundle.scoring?.minImprovementPpm ?? 500);
  const targetAdvances = numberFlag('target-advances', profile.epochFrontier?.targetAccepts ?? 3);
  const previousEvalHiddenCount = previousCorpus.events.filter((e) => e.split === 'eval_hidden').length;
  const nextEvalHiddenCount = nextCorpus.events.filter((e) => e.split === 'eval_hidden').length;
  const majorDeltaThreshold = profile.majorDeltaThreshold;
  const majorDeltaActive = Number.isInteger(majorDeltaThreshold)
    ? isMajorDelta(nextEvalHiddenCount, previousEvalHiddenCount, majorDeltaThreshold)
    : false;
  const controllerInputs = {
    current: BigInt(Math.round(currentMinImprovementPpm)),
    observedAdvances: advancesObserved,
    targetAdvances,
    qualityAttempts: qualityAttemptsObserved,
    majorDeltaActive,
    ...controllerParamsFromProfile(profile, targetAdvances),
  };
  const controllerOutput = nextMinImprovementPpm(controllerInputs);
  const minImprovementPpm = numberFlag('min-improvement-ppm', controllerOutput.next.toString());
  const stateAdvanceThresholdPpm = minImprovementPpm
    + (profile.replayTolerancePpm ?? 0)
    + (baselineVariancePpm ?? 0);
  const screenerThresholdPpm = numberFlag('screener-threshold-ppm', computeCoreTexScreenerThresholdPpm({
    baselineScorePpm: baselineParentScorePpm,
    recentNoiseFloorPpm,
    stateAdvanceThresholdPpm,
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
    majorDelta: {
      active: majorDeltaActive,
      previousEvalHiddenCount,
      nextEvalHiddenCount,
      threshold: majorDeltaThreshold ?? null,
    },
  };
  const hiddenSeedCommit = flag('hidden-seed-commit', bytes32FromString(`coretex:hidden:${epoch}:${seed}:${delta.nextRoot}`));
  let rotation = buildEpochRotationManifest({
    epoch,
    delta,
    challengeBook,
    bundleHash: bundle.bundleHash,
    minImprovementPpm,
    stateAdvanceThresholdPpm,
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
  writeFileAtomic(deltaPath, JSON.stringify(serializeCorpusDelta(delta), null, 2) + '\n');
  writeFileAtomic(rotationPath, JSON.stringify(rotation, null, 2) + '\n');
  writeFileAtomic(logicalDeltaPath, JSON.stringify(logicalDelta, null, 2) + '\n');
  // Thread the evolved logical state: retracted docs and retired hidden queries are REMOVED
  // (mirrors CorpusDelta.removedIds) before this epoch's additions are appended.
  const retractedSet = new Set(logicalDelta.retractedDocIds);
  const retiredQuerySet = new Set(logicalDelta.retiredQueryIds);
  logical.docs = logical.docs.filter((d) => !retractedSet.has(d.id));
  logical.relations = logical.relations.filter((r) => !retractedSet.has(r.src) && !retractedSet.has(r.dst));
  logical.queries = logical.queries.filter((q) => !retiredQuerySet.has(q.id));
  logical.docs.push(...logicalDelta.addedDocs);
  logical.relations.push(...logicalDelta.addedRelations);
  logical.queries.push(...logicalDelta.addedQueries);
  const logicalStateJson = JSON.stringify(logical, null, 2) + '\n';
  writeFileAtomic(logicalStatePath, logicalStateJson);

  // ── Epoch checkpoint: the mandatory continuity handle for epoch N+1 ──────────
  // Binds the evolved logical state + frontier state + materialized corpus root. Written
  // LAST so a crash mid-epoch leaves the previous checkpoint authoritative (fail-closed:
  // the next epoch's sha256 checks then reject any partially-threaded state).
  const checkpointOut = {
    schema: 'coretex.epoch-evolve-checkpoint.v1',
    epoch,
    corpusRoot: delta.nextRoot,
    previousCorpusRoot: delta.previousRoot,
    logicalStateSha256: createHash('sha256').update(logicalStateJson).digest('hex'),
    frontierStateSha256: createHash('sha256').update(frontier.stateJson).digest('hex'),
    frontierStatePath: frontier.statePath,
    generatedAt,
  };
  const checkpointJson = JSON.stringify(checkpointOut, null, 2) + '\n';
  const checkpointPath = resolve(outDir, `epoch-checkpoint-${epoch}.json`);
  writeFileAtomic(checkpointPath, checkpointJson);
  writeFileAtomic(checkpointPathFor(logicalStatePath), checkpointJson);
  // Mandatory threading back to the STABLE logical-state path (tmp + atomic rename): the next
  // epoch reads the same --logical-state path and its sibling checkpoint.
  let stableLogicalStatePath = null;
  if (logicalStateFlag) {
    stableLogicalStatePath = resolve(repoRoot, logicalStateFlag);
    writeFileAtomic(stableLogicalStatePath, logicalStateJson);
    writeFileAtomic(checkpointPathFor(stableLogicalStatePath), checkpointJson);
  }

  const s3Prefix = flag('s3-prefix', null);
  const published = {};
  if (s3Prefix) {
    const deltaS3 = s3Join(s3Prefix, `corpus-delta-epoch-${epoch}.json`);
    const rotationS3 = s3Join(s3Prefix, `epoch-rotation-${epoch}.json`);
    await uploadS3(deltaPath, deltaS3);
    await uploadS3(rotationPath, rotationS3);
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
      estimate: estimatePath.replace(`${repoRoot}/`, ''),
      logicalDelta: logicalDeltaPath.replace(`${repoRoot}/`, ''),
      logicalState: logicalStatePath.replace(`${repoRoot}/`, ''),
      checkpoint: checkpointPath.replace(`${repoRoot}/`, ''),
      ...(stableLogicalStatePath ? {
        stableLogicalState: stableLogicalStatePath.replace(`${repoRoot}/`, ''),
        stableCheckpoint: checkpointPathFor(stableLogicalStatePath).replace(`${repoRoot}/`, ''),
      } : {}),
      frontierState: frontier.statePath,
      ...(devPublicKeyPem ? { devPublicKey: resolve(outDir, 'dev-epoch-public-key.pem').replace(`${repoRoot}/`, '') } : {}),
      ...published,
    },
    evolve: {
      seed,
      churnFraction,
      retractionFraction,
      launchGenesis,
      addedDocs: logicalDelta.addedDocs.length,
      addedQueries: logicalDelta.addedQueries.length,
      estimatedEmbeddings: estimate.estimatedEmbeddings,
      churnedSubjects: logicalDelta.churnedSubjects.length,
      retractedDocs: logicalDelta.retractedDocIds.length,
      retiredHiddenQueries: logicalDelta.retiredQueryIds.length,
      removedIds: removedIds.length,
      freshEvalHidden: freshEvalHiddenAdded.length,
      minFreshEvalHidden,
      hiddenRetireHorizon,
      maxRootDeltaPerEpoch,
      embeddingMode,
      baselineParentScorePpm,
      ...(baselineVariancePpm !== undefined ? { baselineVariancePpm } : {}),
      baselineVarianceSource,
      fixedPackRepeatabilityPpm,
      screenerThresholdPpm,
      stateAdvanceThresholdPpm,
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
      prunedActiveIds: frontier.prunedActiveIds,
      prunedOrderIds: frontier.prunedOrderIds.length,
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
  writeFileAtomic(outPath, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => fail(e?.stack ?? e?.message ?? String(e)));
