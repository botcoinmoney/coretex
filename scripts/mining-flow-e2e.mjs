#!/usr/bin/env node
/**
 * Mining-flow e2e — outside-perspective miner client exercising the production
 * CoreTex HTTP shim through createCoreTexCoordinatorRouteHandler.
 *
 * Replaces the previous scripts/scripted-miner.mjs which targeted the removed
 * /coretex/* surface. This script speaks the current /coretex/* surface,
 * uses the canonical opaque rejection envelope semantics, and explicitly
 * partitions miner submissions into three outcome buckets:
 *
 *   - screener_reject:        { status: 'rejected', code: 'rejected' }
 *   - screener_pass_no_advance: { status: 'accepted', patchHash, evalReportHash }
 *                                (no receipt — deltaPpm below minImprovementPpm)
 *   - state_advance:          { status: 'accepted', patchHash, evalReportHash, receipt }
 *                                (deltaPpm above minImprovementPpm; on-chain receipt fires
 *                                 via the host's submit callback)
 *
 * Two modes:
 *   --mode live    Random patch generation seeded by --seed; submits until all
 *                  three buckets are observed at least once. Use --persist-fixtures
 *                  to write the three sample patches to disk for replay use.
 *   --mode replay  Loads fixtures, replays each patch through the shim, asserts
 *                  the observed envelope matches the annotated expected outcome.
 *                  This is the form the CI integration test consumes.
 *
 * Two transports:
 *   --base-url in-process   Calls the route handler directly. No TCP, no port.
 *                           Fastest; most deterministic. Default.
 *   --base-url http://...   Starts a real http.Server bound to the handler;
 *                           drives fetch() calls against it. Closest match to
 *                           production. Use this for the wire-shape acceptance run.
 *
 * Usage (post-bundle build):
 *   node scripts/mining-flow-e2e.mjs \
 *     --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
 *     --mode live \
 *     --max-iterations 200 \
 *     --persist-fixtures benchmark/fixtures/mining-flow/epoch-0.fixtures.json \
 *     --out /var/lib/coretex/reports/mining-flow-fixtures-launch.json
 *
 *   node scripts/mining-flow-e2e.mjs \
 *     --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
 *     --mode replay \
 *     --fixtures benchmark/fixtures/mining-flow/epoch-0.fixtures.json \
 *     --out /var/lib/coretex/reports/mining-flow-e2e-launch.json
 *
 * Exit codes:
 *   0 = success (live: all 3 buckets observed; replay: all 3 envelopes match)
 *   1 = script error (bad args, missing prerequisite, package not built)
 *   2 = live mode exhausted --max-iterations without observing all 3 buckets
 *   3 = replay mode: observed envelope does not match annotated outcome
 */

import { distIndex } from './_repo-root.mjs';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { argv, exit, env } from 'node:process';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  if (argv.includes(`--${name}`)) return true;
  return fallback;
}

const bundlePath = flag('bundle-manifest');
const corpusPath = flag('corpus');
const mode = flag('mode', 'live');
const baseUrl = flag('base-url', 'in-process');
const fixturesPath = flag('fixtures');
const persistFixturesPath = flag('persist-fixtures');
const maxIterations = Number(flag('max-iterations', '200'));
const seedHex = flag('seed', '0x'.padEnd(66, '0'));
const reportPath = flag('out', '/var/lib/coretex/reports/mining-flow-e2e.json');

function fail(msg, code = 1) {
  console.error(`[mining-flow-e2e] ${msg}`);
  exit(code);
}

if (!bundlePath) fail('--bundle-manifest is required');
if (!existsSync(bundlePath)) fail(`bundle manifest not found: ${bundlePath}`);
if (!corpusPath) fail('--corpus is required');
if (!existsSync(corpusPath)) fail(`corpus not found: ${corpusPath}`);
if (mode !== 'live' && mode !== 'replay') fail(`--mode must be 'live' or 'replay', got: ${mode}`);
if (mode === 'replay' && !fixturesPath) fail('replay mode requires --fixtures');
if (mode === 'replay' && !existsSync(fixturesPath)) fail(`fixtures not found: ${fixturesPath}`);

const distEntry = distIndex;
if (!existsSync(distEntry)) {
  fail(`@botcoin/coretex dist not built — run 'npm run build --workspace @botcoin/coretex' first`);
}

const {
  createCoreTexCoordinatorRouteHandler,
  createRetrievalDataSource,
} = await import(distEntry);

if (typeof createCoreTexCoordinatorRouteHandler !== 'function'
    || typeof createRetrievalDataSource !== 'function') {
  fail('@botcoin/coretex dist missing required exports — rebuild');
}

const bundleManifest = JSON.parse(readFileSync(bundlePath, 'utf8'));
const bundleHash = bundleManifest.bundleHash;
if (typeof bundleHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(bundleHash)) {
  fail(`bundle manifest missing bundleHash: ${bundlePath}`);
}

/**
 * Coordinator state — the in-memory store the data-source callbacks operate on.
 * In production this is a real coordinator process; for the e2e it's a single
 * in-process map. The shape mirrors production exactly so the shim sees the
 * same response envelopes either way.
 */
const coordinator = {
  epochId: 0,
  stateRoot: bundleManifest.evaluator?.profile?.baselineStateRoot
    ?? `0x${'0'.repeat(64)}`,
  wordCount: bundleManifest.substrate?.wordCount ?? 1024,
  transitionCount: 0,
  minImprovementPpm: bundleManifest.evaluator?.profile?.minImprovementPpm ?? 500,
  rulesVersion: bundleManifest.rulesVersion ?? 0,
  workPolicyHash: bundleManifest.workPolicyHash ?? `0x${'0'.repeat(64)}`,
  corpusRoot: bundleManifest.corpusRoot ?? `0x${'0'.repeat(64)}`,
  evalSeedCommit: bundleManifest.evalSeedCommit ?? `0x${'0'.repeat(64)}`,
  currentChallengeId: null,
  buckets: { screener_reject: null, screener_pass_no_advance: null, state_advance: null },
  iterations: 0,
};

function sha256hex(s) {
  return `0x${createHash('sha256').update(s).digest('hex')}`;
}

function freshChallenge() {
  const ch = sha256hex(`challenge:${coordinator.epochId}:${coordinator.transitionCount}:${Date.now()}`);
  coordinator.currentChallengeId = ch;
  return {
    lane: 'coretex',
    challengeId: ch,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    epochId: coordinator.epochId,
    parentStateRoot: coordinator.stateRoot,
    coreVersionHash: bundleHash,
    bundleHash,
    substrate: { encoding: 'coretex-packed-substrate-v1', uri: `/coretex/substrate/${coordinator.stateRoot}` },
  };
}

/**
 * The submit callback. In live mode this is a deterministic stub-evaluator:
 *
 *   - Empty / oversized newWords or wrong patchType → screener-reject
 *   - Valid shape, scoreDelta < minImprovementPpm → accepted-no-advance
 *   - Valid shape, scoreDelta ≥ minImprovementPpm → accepted-with-receipt
 *
 * This stands in for evaluateRetrievalBenchmarkPatch + liveEvalAdmissionDecision
 * until step 12 wires the real evaluator. The shim's sanitizer is what's actually
 * under test — the eval logic is not. When the real evaluator lands, replace
 * this function body; the surrounding harness does not change.
 */
async function submit(body) {
  coordinator.iterations += 1;
  const patch = body && typeof body === 'object' ? body.patch : null;
  if (!patch || typeof patch !== 'object') {
    return { status: 'rejected', reason: 'malformed' };
  }
  const newWords = Array.isArray(patch.newWords) ? patch.newWords : null;
  if (!newWords || newWords.length === 0 || newWords.length > 4) {
    return { status: 'rejected', reason: 'screener:newWords' };
  }
  if (patch.patchType !== 'KEY_UPDATE' && patch.patchType !== 'RELATION_UPDATE') {
    return { status: 'rejected', reason: 'screener:patchType' };
  }
  if (typeof patch.parentStateRoot !== 'string' || patch.parentStateRoot !== coordinator.stateRoot) {
    return { status: 'rejected', reason: 'screener:parentStateRoot' };
  }
  const scoreDeltaPpm = Number(patch.scoreDeltaPpm ?? 0);
  if (!Number.isFinite(scoreDeltaPpm) || scoreDeltaPpm < 0) {
    return { status: 'rejected', reason: 'screener:scoreDelta' };
  }
  const patchHash = sha256hex(JSON.stringify(patch));
  const evalReportHash = sha256hex(`evalReport:${patchHash}:${coordinator.epochId}`);
  if (scoreDeltaPpm < coordinator.minImprovementPpm) {
    return { status: 'accepted', patchHash, evalReportHash };
  }
  const receipt = {
    keyId: 'coordinator-v4',
    algorithm: 'ECDSA-SHA256',
    signature: `0x${randomBytes(64).toString('hex')}`,
    signedFields: ['patchHash', 'evalReportHash', 'parentStateRoot', 'newStateRoot'],
  };
  const newStateRoot = sha256hex(`state:${coordinator.stateRoot}:${patchHash}`);
  coordinator.stateRoot = newStateRoot;
  coordinator.transitionCount += 1;
  return { status: 'accepted', patchHash, evalReportHash, receipt };
}

async function status() {
  return {
    lane: 'coretex',
    epochId: coordinator.epochId,
    stateRoot: coordinator.stateRoot,
    wordCount: coordinator.wordCount,
    transitionCount: coordinator.transitionCount,
    rulesVersion: coordinator.rulesVersion,
    workPolicyHash: coordinator.workPolicyHash,
    corpusRoot: coordinator.corpusRoot,
    coreVersionHash: bundleHash,
    bundleHash,
    minImprovementPpm: coordinator.minImprovementPpm,
    evalSeedCommit: coordinator.evalSeedCommit,
    substrate: { uri: `/coretex/substrate/${coordinator.stateRoot}` },
    bundle: { uri: `/coretex/bundle/${bundleHash}` },
  };
}

const dataSource = createRetrievalDataSource({
  bundleManifest,
  bundleHash,
  getChallenge: () => freshChallenge(),
  submit,
  getStatus: status,
});

const handle = createCoreTexCoordinatorRouteHandler(dataSource);

/** Transport — either direct handler call, or via a real http.Server. */
let httpClient;
let httpServer;
async function startTransport() {
  if (baseUrl === 'in-process') {
    httpClient = async (method, path, body) => {
      const r = await handle({ method, path, body, headers: {} });
      return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body };
    };
    return;
  }
  const u = new URL(baseUrl);
  httpServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let parsed = null;
    if (chunks.length > 0) {
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
    }
    const r = await handle({ method: req.method, path: req.url.split('?')[0], body: parsed, headers: req.headers });
    res.statusCode = r.status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(r.body));
  });
  await new Promise((res, rej) => httpServer.listen(Number(u.port), u.hostname, () => res()).on('error', rej));
  httpClient = async (method, path, body) => {
    const r = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
  };
}
function stopTransport() {
  if (httpServer) httpServer.close();
}

/** Classify the envelope returned by the shim into a bucket. */
function classifyEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  if (envelope.status === 'rejected') return 'screener_reject';
  if (envelope.status === 'accepted' && envelope.receipt) return 'state_advance';
  if (envelope.status === 'accepted') return 'screener_pass_no_advance';
  return null;
}

/** Patch generators for live mode — one per intended bucket. */
function* livePatchSeries() {
  // 1) intentional screener rejects (varied malformed shapes)
  yield { patch: { /* missing newWords */ patchType: 'KEY_UPDATE', parentStateRoot: coordinator.stateRoot, scoreDeltaPpm: 0 } };
  yield { patch: { newWords: [], patchType: 'KEY_UPDATE', parentStateRoot: coordinator.stateRoot, scoreDeltaPpm: 0 } };
  yield { patch: { newWords: new Array(10).fill('0x0'), patchType: 'KEY_UPDATE', parentStateRoot: coordinator.stateRoot, scoreDeltaPpm: 0 } };
  yield { patch: { newWords: ['0x01'], patchType: 'INVALID_TYPE', parentStateRoot: coordinator.stateRoot, scoreDeltaPpm: 0 } };
  // 2) valid patches with random scoreDelta — partition into pass-no-advance + state-advance
  let i = 0;
  while (true) {
    i += 1;
    const scoreDeltaPpm = (i % 7 === 0)
      ? coordinator.minImprovementPpm + 1500 + (i * 73 % 5000)  // state_advance
      : (i * 257) % coordinator.minImprovementPpm;              // pass_no_advance
    yield {
      patch: {
        newWords: [`0x${(i).toString(16).padStart(64, '0')}`],
        patchType: 'KEY_UPDATE',
        parentStateRoot: coordinator.stateRoot,
        scoreDeltaPpm,
        targetIndices: [400 + (i % 256)],
        nonce: sha256hex(`${seedHex}:${i}`),
      },
    };
  }
}

async function runLive() {
  const series = livePatchSeries();
  const observed = { screener_reject: null, screener_pass_no_advance: null, state_advance: null };
  for (let iter = 0; iter < maxIterations; iter += 1) {
    const chRes = await httpClient('GET', '/coretex/challenge');
    if (!chRes.ok) fail(`/coretex/challenge → ${chRes.status}`);
    const submission = series.next().value;
    submission.challenge = chRes.body;
    const subRes = await httpClient('POST', '/coretex/submit', submission);
    const bucket = classifyEnvelope(subRes.body);
    if (bucket && !observed[bucket]) {
      observed[bucket] = {
        bucket,
        iteration: iter,
        request: submission,
        envelope: subRes.body,
        envelopeSha256: sha256hex(JSON.stringify(subRes.body)),
      };
    }
    const remaining = Object.entries(observed).filter(([, v]) => v == null).map(([k]) => k);
    if (remaining.length === 0) {
      const out = {
        mode: 'live',
        bundleHash,
        iterations: iter + 1,
        fixtures: Object.values(observed).map(({ bucket, request, envelope, envelopeSha256 }) =>
          ({ bucket, expectedEnvelope: envelope, expectedEnvelopeSha256: envelopeSha256, request })),
      };
      writeReport(out);
      if (persistFixturesPath) {
        mkdirSync(dirname(persistFixturesPath), { recursive: true });
        writeFileSync(persistFixturesPath, JSON.stringify({
          schemaVersion: 'coretex.mining-flow-fixtures.v1',
          bundleHash,
          generatedAt: new Date().toISOString(),
          fixtures: out.fixtures,
        }, null, 2));
        console.log(`[mining-flow-e2e] persisted fixtures → ${persistFixturesPath}`);
      }
      console.log(`[mining-flow-e2e] all 3 buckets observed in ${iter + 1} iterations`);
      return 0;
    }
  }
  console.error(`[mining-flow-e2e] exhausted ${maxIterations} iterations; missing buckets: ${
    Object.entries({ screener_reject: 0, screener_pass_no_advance: 0, state_advance: 0 })
      .filter(([k]) => observed[k] == null).map(([k]) => k).join(', ')
  }`);
  writeReport({ mode: 'live', bundleHash, iterations: maxIterations, observed });
  return 2;
}

async function runReplay() {
  const fx = JSON.parse(readFileSync(fixturesPath, 'utf8'));
  if (fx.schemaVersion !== 'coretex.mining-flow-fixtures.v1') {
    fail(`unexpected fixtures schemaVersion: ${fx.schemaVersion}`);
  }
  const results = [];
  let exitCode = 0;
  for (const f of fx.fixtures) {
    const chRes = await httpClient('GET', '/coretex/challenge');
    if (!chRes.ok) fail(`/coretex/challenge → ${chRes.status}`);
    const subRes = await httpClient('POST', '/coretex/submit', f.request);
    const bucket = classifyEnvelope(subRes.body);
    const envelopeSha256 = sha256hex(JSON.stringify(subRes.body));
    const matches = bucket === f.bucket;
    results.push({
      bucket: f.bucket,
      observedBucket: bucket,
      matches,
      envelope: subRes.body,
      envelopeSha256,
    });
    if (!matches) {
      console.error(`[mining-flow-e2e] replay MISMATCH ${f.bucket}: got bucket=${bucket}, envelope=${JSON.stringify(subRes.body)}`);
      exitCode = 3;
    }
  }
  writeReport({ mode: 'replay', bundleHash, fixtures: results });
  if (exitCode === 0) console.log(`[mining-flow-e2e] replay PASS — ${results.length} fixtures match annotated outcomes`);
  return exitCode;
}

function writeReport(payload) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    schemaVersion: 'coretex.mining-flow-report.v1',
    generatedAt: new Date().toISOString(),
    ...payload,
  }, null, 2));
  console.log(`[mining-flow-e2e] report → ${reportPath}`);
}

try {
  await startTransport();
  const rc = mode === 'live' ? await runLive() : await runReplay();
  stopTransport();
  exit(rc);
} catch (err) {
  stopTransport();
  console.error('[mining-flow-e2e] unhandled:', err);
  exit(1);
}
