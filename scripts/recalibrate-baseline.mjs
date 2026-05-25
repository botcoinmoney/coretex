#!/usr/bin/env node
/**
 * Baseline-recalibration skeleton.
 *
 * Operational intent: cron-driven daily/epoch recompute of
 * `baselineParentScorePpm` from a rolling sample of empty-state evaluations
 * against the active corpus + bundle profile. The current single-sample
 * pin gets stale quickly as the corpus grows; this script is what the
 * launch-day cron eventually wires up.
 *
 * Status: SKELETON. The sample-and-write loop is implemented; the
 * bundle-profile rewrite + signing flow is intentionally a TODO so the
 * coordinator team can layer their signing infra without this script
 * making policy decisions on its own.
 *
 * Usage:
 *   node scripts/recalibrate-baseline.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *     --bundle-profile release/bundle/evaluator-profile-v2-dgen1-deep-r1.json \
 *     --samples 30 \
 *     --eval-seed-hex 0x...32-bytes \
 *     --out /var/lib/coretex/reports/baseline-recalibration.json
 *
 * Operating notes:
 * - `--eval-seed-hex` is the genesis-baseline seed for the rolling
 *   sample. Production should rotate this on a documented cadence; the
 *   seed governs which pack subset is averaged.
 * - With cache active each parent eval is ~99 min cold + ~5s warm
 *   (same seed → same pack → all reranker pairs cached after the
 *   first). N=30 samples cold ≈ 49h on CPU; with the same seed all
 *   30 samples reuse the same pack → ~99 min total. The cron should
 *   use a single seed per cron tick and rotate seeds over time so the
 *   30-sample mean stays statistically meaningful.
 * - Writing a new pinned value requires bundle-profile rewrite + a new
 *   `bundleHash` + signature. That flow lives at the coordinator level
 *   and is intentionally NOT performed here.
 */
import { distIndex } from './_repo-root.mjs';
import { profileAttestation } from './lib/profile-attestation.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit, env } from 'node:process';
import {
  deriveBaselineSampleSeed,
  summarizeBaselineComposites,
} from './lib/baseline-recalibration.mjs';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}
const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const samples = Number(flag('samples', '5'));
const evalSeedHex = flag('eval-seed-hex', '0x' + 'babe'.repeat(16));
const reportPath = flag('out', '/var/lib/coretex/reports/baseline-recalibration.json');
const epochId = Number(flag('epoch-id', '0'));
const sampleSeedMode = flag('sample-seed-mode', 'fixed');
if (sampleSeedMode !== 'fixed' && sampleSeedMode !== 'rotating') {
  console.error("--sample-seed-mode must be 'fixed' or 'rotating'");
  exit(1);
}

if (!corpusPath || !existsSync(corpusPath)) { console.error('--corpus missing'); exit(1); }

const {
  loadProductionCorpus, evaluateRetrievalBenchmarkState, deriveQueryPack,
  biEncoderModelIdHash, rerankerFromEnv, biEncoderFromEnv,
  DEFAULT_PROFILE, RANGES, getRerankerCacheStats,
} = await import(distIndex);
const { buildProvenance } = await import('./calibration-provenance.mjs');

console.log(`[recalibrate-baseline] loading corpus`);
const t0 = Date.now();
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.log(`  loaded ${corpus.events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const profile = profilePath && existsSync(profilePath)
  ? (() => { const r = JSON.parse(readFileSync(profilePath, 'utf8')); return r.profile ?? r; })()
  : DEFAULT_PROFILE;

if (!profile.hiddenPack) {
  console.error('[recalibrate-baseline] profile.hiddenPack missing — refusing to compute non-production baseline');
  exit(1);
}

const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);
const reranker = await rerankerFromEnv();
const biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });
console.log(`[recalibrate-baseline] reranker: ${reranker.model}`);

const opts = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  biEncoder, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: profile.relationHopBudget ?? 3,
  abstentionThreshold: profile.abstentionThreshold ?? 0.001,
  rerankerTopK: profile.rerankerTopK ?? 10,
  retrievalKeyTopK: profile.retrievalKeyTopK ?? 50,
  firstStageTopK: profile.firstStageTopK ?? 3200,
  rerankerInputTopK: profile.rerankerInputTopK ?? 128,
  lensTopK: profile.lensTopK ?? 36,
  lensWeight: profile.lensWeight ?? 0.4,
  anchorWeight: profile.anchorWeight ?? 0.6,
  relationExpansionBudget: profile.relationExpansionBudget ?? 12,
  categoryLensExpansionBudget: profile.categoryLensExpansionBudget ?? profile.relationExpansionBudget ?? 50,
  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.1,
  temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.1,
  lensDiversityFloor: profile.lensDiversityFloor,
  pipelineVersion: profile.pipelineVersion,
};

const EMPTY = { words: new Array(RANGES.WORD_COUNT).fill(0n) };
const composites = [];
const tStart = Date.now();
for (let i = 0; i < samples; i++) {
  // Default `fixed` mode intentionally evaluates one hidden pack repeatedly
  // inside a cron tick: it measures runtime/noise without burning N cold
  // packs. Operators who explicitly want cross-pack sampling can pass
  // `--sample-seed-mode rotating`.
  const seedI = deriveBaselineSampleSeed(evalSeedHex, i, sampleSeedMode);
  const pack = deriveQueryPack(epochId, seedI, corpus, profile.hiddenPack);
  const t = Date.now();
  const score = await evaluateRetrievalBenchmarkState(EMPTY, corpus, pack, opts);
  const elapsedMs = Date.now() - t;
  composites.push(score.composite);
  console.log(`  sample[${i}] composite=${score.composite.toFixed(6)} elapsed=${(elapsedMs / 1000).toFixed(1)}s`);
}

const { mean, stddev, baselineParentScorePpm, stddevPpm } = summarizeBaselineComposites(composites);

const cacheStats = getRerankerCacheStats?.(reranker);
const report = {
  schemaVersion: 'coretex.baseline-recalibration.v1-skeleton',
  generatedAt: new Date().toISOString(),
  provenance: buildProvenance(),
  fidelity: 'PRODUCTION_RERANKER',
  inputs: {
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    eventCount: corpus.events.length,
    bundleProfile: profilePath,
    profileAttestation: profileAttestation(profile, profilePath),
    rerankerModel: reranker.model,
    samples,
    sampleSeedMode,
    epochId,
    evalSeedHex,
    pipelineVersion: profile.pipelineVersion,
    hiddenPackSize: profile.hiddenPack.packSize,
  },
  measurements: {
    composites,
    mean,
    stddev,
    baselineParentScorePpm,
    stddevPpm,
    totalElapsedSec: (Date.now() - tStart) / 1000,
  },
  cacheStats: cacheStats ? {
    hits: cacheStats.hits, misses: cacheStats.misses,
    evictions: cacheStats.evictions, finalSize: cacheStats.size(),
    hitRate: cacheStats.hits / Math.max(1, cacheStats.hits + cacheStats.misses),
  } : null,
  // TODO(coordinator): bundle-profile rewrite + new bundleHash + signature.
  // The numeric proposal below is intentionally NOT applied; downstream
  // signing infra picks it up.
  proposal: {
    field: 'profile.baselineParentScorePpm',
    currentValue: profile.baselineParentScorePpm ?? null,
    proposedValue: baselineParentScorePpm,
    note: 'apply via coordinator bundle-profile signing flow; do not hand-edit.',
  },
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[recalibrate-baseline] report → ${reportPath}`);
console.log(`[recalibrate-baseline] proposed baselineParentScorePpm = ${baselineParentScorePpm} (mean ${mean.toFixed(6)}, stddev ${stddev.toFixed(6)})`);
await reranker.close?.();
exit(0);
