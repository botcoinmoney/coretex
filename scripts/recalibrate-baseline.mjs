#!/usr/bin/env node
/**
 * v16 baseline recalibration report.
 *
 * Computes the empty-parent baseline against the launch materialized corpus using
 * the same profile -> scorer path as the screener and replay gates. This script
 * does not mutate the signed profile or bundle; it writes a proposal artifact for
 * the coordinator signing flow.
 *
 * Usage:
 *   node scripts/recalibrate-baseline.mjs --reranker gpu --samples 3 --out <report.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { createHash } from 'node:crypto';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';
import { makeInstrumentedReranker } from './lib/instrumented-reranker.mjs';
import { calibrationProvenance } from './lib/calibration-provenance.mjs';
import {
  deriveBaselineSampleSeed,
  summarizeBaselineComposites,
} from './lib/baseline-recalibration.mjs';

const C = await import(distIndex);
const {
  canonicalJson,
  RANGES,
  DEFAULT_CORETEX_WORK_POLICY,
  biEncoderModelIdHash,
  computeCoreTexScreenerThresholdPpm,
  createDeterministicReranker,
  deriveQueryPack,
  evaluateRetrievalBenchmarkState,
  hiddenPackProfileFromEvaluatorProfile,
  scoringOptionsFromProfile,
} = C;

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}
const has = (name) => argv.includes(`--${name}`);
const shaFile = (path) => '0x' + createHash('sha256').update(readFileSync(resolve(repoRoot, path))).digest('hex');
// canonicalJson: the package's single canonical serializer (canonical/json.ts).
const queryPackRoot = (pack) => '0x' + createHash('sha256').update(pack.events.map((e) => e.id).sort().join('\n')).digest('hex');

const DEFAULT_ARTIFACT_MANIFEST = 'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json';
const artifactManifestPath = flag('manifest', DEFAULT_ARTIFACT_MANIFEST);
const artifactManifest = JSON.parse(readFileSync(resolve(repoRoot, artifactManifestPath), 'utf8'));
const payloadPath = (role) => artifactManifest.payloads?.find((p) => p.role === role)?.path;
const base = 'release/calibration/2026-06-04-memory-atom-v16';

const rerankerMode = flag('reranker', 'gpu');
const profilePath = flag('profile', flag('bundle-profile', artifactManifest.profilePath));
const bundlePath = flag('bundle', artifactManifest.bundlePath);
const corpusPath = flag('corpus', payloadPath('corpus'));
const embPath = flag('emb', payloadPath('embeddings'));
const materializedRoot = flag('materialized-root', env.CORETEX_MATERIALIZED_ROOT ?? `${base}/materialized`);
const reportPath = flag('out', `${base}/baseline-recalibration-v16.json`);
const samples = Number(flag('samples', '3'));
const epochId = Number(flag('epoch-id', '0'));
const sampleSeedMode = flag('sample-seed-mode', 'fixed');
const evalSeedHexOverride = flag('eval-seed-hex', null);
const clearPackQuotas = has('clear-pack-quotas');
const packSizeOverride = flag('pack-size', null);
const disableQwenCache = has('disable-qwen-cache');

if (!['gpu', 'qwen-cpu', 'deterministic'].includes(rerankerMode)) {
  console.error("--reranker must be one of: gpu, qwen-cpu, deterministic");
  exit(2);
}
if (sampleSeedMode !== 'fixed' && sampleSeedMode !== 'rotating') {
  console.error("--sample-seed-mode must be 'fixed' or 'rotating'");
  exit(2);
}
if (!profilePath || !bundlePath || !corpusPath || !embPath) {
  console.error('artifact manifest/profile/bundle/corpus/embeddings paths are required');
  exit(2);
}
if (!Number.isInteger(samples) || samples < 1) {
  console.error('--samples must be a positive integer');
  exit(2);
}

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const evalSeedHex = evalSeedHexOverride ?? profile.baselineEvalSeedHex ?? '0x' + 'a5'.repeat(32);
if (!profile.hiddenPack) {
  console.error('[recalibrate-baseline] profile.hiddenPack missing; refusing to compute a non-production baseline');
  exit(1);
}
if (artifactManifest.bundleHash && artifactManifest.bundleHash !== JSON.parse(readFileSync(resolve(repoRoot, bundlePath), 'utf8')).bundleHash) {
  console.error('[recalibrate-baseline] bundleHash drift vs artifact manifest');
  exit(1);
}

console.log('[recalibrate-baseline] loading materialized production corpus (NO rebuild) ...');
const loaded = loadMaterializedCorpus(bundlePath, {
  sourceCorpusPath: corpusPath,
  sourceEmbPath: embPath,
  ...(materializedRoot ? { materializedRoot } : {}),
});
const { corpus, BE, RR, LAYOUT, manifest: matManifest } = loaded;
console.log(`[recalibrate-baseline] corpusRoot=${corpus.corpusRoot} events=${corpus.events.length}`);
console.log(`[recalibrate-baseline] bundleHash=${matManifest.bundleHash}`);

const rawReranker = (rerankerMode === 'gpu' || rerankerMode === 'qwen-cpu')
  ? makeStreamReranker({
    model: RR.modelId,
    revision: RR.revision,
    python: env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3',
    allowCuda: rerankerMode === 'gpu',
  })
  : await createDeterministicReranker();

const profileFileHash = shaFile(profilePath);
const profileHash = '0x' + createHash('sha256').update(canonicalJson(profile)).digest('hex');
const qwenCachePath = disableQwenCache ? null : flag('qwen-cache', reportPath.replace(/\.json$/i, '') + '-qwen-score-cache.jsonl');
const reranker = makeInstrumentedReranker({
  reranker: rawReranker,
  modelId: RR.modelId,
  revision: RR.revision,
  profileHash,
  substrateMode: profile.pipelineVersion ?? 'unknown',
  memoryIRVersion: profile.memoryIRSchemaVersion ?? 'raw',
  cachePath: qwenCachePath,
  mode: rerankerMode,
  batchSize: Number(env.RERANKER_INNER_BATCH ?? '8'),
});

const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
const opts = scoringOptionsFromProfile(profile, {
  biEncoder: inertBiEncoder(BE, LAYOUT),
  reranker,
  biEncoderHash,
  retrievalKeyLayout: LAYOUT,
});

const hiddenPackBase = clearPackQuotas
  ? { packSize: Number(packSizeOverride ?? profile.hiddenPack.packSize), quotas: [] }
  : { ...hiddenPackProfileFromEvaluatorProfile(profile), ...(packSizeOverride ? { packSize: Number(packSizeOverride) } : {}) };
const empty = { words: new Array(RANGES.WORD_COUNT ?? 1024).fill(0n) };
const composites = [];
const sampleReports = [];
const started = Date.now();

for (let i = 0; i < samples; i++) {
  const seed = deriveBaselineSampleSeed(evalSeedHex, i, sampleSeedMode);
  const pack = deriveQueryPack(epochId, seed, corpus, hiddenPackBase);
  const sampleStart = Date.now();
  const score = await evaluateRetrievalBenchmarkState(empty, corpus, pack, opts);
  const composite = score.compositeScore ?? score.composite ?? 0;
  const scorePpm = Math.round(composite * 1_000_000);
  composites.push(composite);
  sampleReports.push({
    index: i,
    seed,
    queryPackRoot: queryPackRoot(pack),
    packSize: pack.events.length,
    composite,
    scorePpm,
    elapsedSec: (Date.now() - sampleStart) / 1000,
  });
  console.log(`[recalibrate-baseline] sample[${i}] score=${scorePpm}ppm pack=${pack.events.length} elapsed=${sampleReports.at(-1).elapsedSec.toFixed(1)}s`);
}

const summary = summarizeBaselineComposites(composites);
const currentThresholdPpm = computeCoreTexScreenerThresholdPpm({
  baselineScorePpm: profile.baselineParentScorePpm,
  policy: DEFAULT_CORETEX_WORK_POLICY,
});
const proposedThresholdPpm = computeCoreTexScreenerThresholdPpm({
  baselineScorePpm: summary.baselineParentScorePpm,
  policy: DEFAULT_CORETEX_WORK_POLICY,
});

const report = {
  schemaVersion: 'coretex.baseline-recalibration.v16',
  generatedAt: new Date().toISOString(),
  fidelity: rerankerMode === 'gpu' ? 'PRODUCTION_RERANKER_GPU' : rerankerMode === 'qwen-cpu' ? 'PRODUCTION_RERANKER_CPU' : 'DETERMINISTIC_RERANKER_SMOKE',
  provenance: calibrationProvenance({
    bundlePath,
    corpusPath,
    embPath,
    profilePath,
    manifest: matManifest,
  }),
  artifactManifest: {
    path: artifactManifestPath,
    hash: shaFile(artifactManifestPath),
  },
  inputs: {
    profile: profilePath,
    profileHash,
    profileFileHash,
    bundle: bundlePath,
    bundleHash: matManifest.bundleHash,
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    eventCount: corpus.events.length,
    materializedRoot: materializedRoot ?? null,
    rerankerModel: RR.modelId,
    rerankerRevision: RR.revision,
    rerankerMode,
    qwenCachePath,
    samples,
    sampleSeedMode,
    epochId,
    evalSeedHex,
    hiddenPack: hiddenPackBase,
    pipelineVersion: profile.pipelineVersion,
  },
  samples: sampleReports,
  measurements: {
    composites,
    mean: summary.mean,
    stddev: summary.stddev,
    baselineParentScorePpm: summary.baselineParentScorePpm,
    stddevPpm: summary.stddevPpm,
    totalElapsedSec: (Date.now() - started) / 1000,
  },
  proposal: {
    field: 'profile.baselineParentScorePpm',
    currentValue: profile.baselineParentScorePpm ?? null,
    proposedValue: summary.baselineParentScorePpm,
    currentScreenerThresholdPpm: Number(currentThresholdPpm),
    proposedScreenerThresholdPpm: Number(proposedThresholdPpm),
    note: 'Apply only through the coordinator bundle-profile signing flow; this script does not rewrite the signed profile.',
  },
};

mkdirSync(dirname(resolve(repoRoot, reportPath)), { recursive: true });
writeFileSync(resolve(repoRoot, reportPath), JSON.stringify(report, null, 2) + '\n');
console.log(`[recalibrate-baseline] wrote ${reportPath}`);
console.log(`[recalibrate-baseline] proposed baselineParentScorePpm=${summary.baselineParentScorePpm} stddevPpm=${summary.stddevPpm}`);
await reranker.close?.();
exit(0);
