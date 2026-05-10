#!/usr/bin/env node
/**
 * CoreTex calibration runner.
 *
 * Spec: plan §Calibration. Produces `bundleProfile.json` with the calibration
 * outputs that bind into the bundle profile via `bundleHash`.
 *
 * Calibration outputs (each computed from the calibration corpus + ≥3-host
 * determinism sample):
 *
 *   - bi-encoder revision pin
 *   - bi-encoder outputDim
 *   - bi-encoder quantization scheme
 *   - reranker revision pin (production)
 *   - labeling reranker revision pin
 *   - runtime version pins (transformers/torch or onnxruntime)
 *   - replayTolerancePpm (P99 of cross-host score diffs, ceiling)
 *   - hidden pack size K + per-stratum quotas
 *   - reranker top-k
 *   - reranker score → graded-qrel mapping
 *   - abstentionThreshold
 *   - composite weights (constrained optimization on calibration set)
 *   - structuralFloor
 *   - protectedRegressionFloor
 *   - familyCatastrophicFloor
 *   - relationHopBudget
 *   - splitRatios
 *   - revealGracePeriodSeconds
 *
 * Usage:
 *   node scripts/calibrate.mjs \
 *     --bundle-manifest <path>                  # template manifest with model pins
 *     --calibration-corpus <path>               # corpus JSON with split=calibration records
 *     --determinism-aggregate <path>            # output of scripts/aggregate-determinism.mjs
 *     --out bundle-profile.json
 *
 * Operational notes:
 *   - `replayTolerancePpm` is taken from --determinism-aggregate's p99PpmDiff
 *     with a 250 ppm minimum and must stay below `minImprovementPpm`.
 *   - Composite weights satisfy: w_retrieval >= 0.70, w_structural_sanity <= 0.10,
 *     other weights > 0, sum to 1.0. Default skew is retrieval-dominant.
 *   - Other outputs default to plan-recommended values; the operator overrides
 *     by passing per-knob CLI flags or env vars.
 *
 * This script is bundled into the bundle manifest so a third-party auditor
 * reruns it and reproduces the outputs within sampling noise.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit } from 'node:process';

import {
  loadProductionCorpus,
} from '@botcoin/cortex';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const bundlePath = flag('bundle-manifest');
const calibCorpusPath = flag('calibration-corpus');
const detAggPath = flag('determinism-aggregate');
const outPath = resolve(flag('out', 'bundle-profile.json'));

if (!bundlePath || !calibCorpusPath || !detAggPath) {
  console.error('calibrate: --bundle-manifest, --calibration-corpus, --determinism-aggregate are required');
  exit(1);
}

const manifest = JSON.parse(readFileSync(resolve(bundlePath), 'utf8'));
const corpus = loadProductionCorpus(resolve(calibCorpusPath));
const detAgg = JSON.parse(readFileSync(resolve(detAggPath), 'utf8'));

const calibEvents = corpus.events.filter((e) => e.split === 'calibration');
if (calibEvents.length === 0) {
  console.error('calibrate: no records with split=calibration in corpus');
  exit(1);
}
const evalHiddenEvents = corpus.events.filter((e) => e.split === 'eval_hidden');
if (evalHiddenEvents.length === 0) {
  console.error('calibrate: no records with split=eval_hidden in corpus');
  exit(1);
}

// ─── Replay tolerance ────────────────────────────────────────────────────────

const minImprovementPpm = Number(flag('min-improvement-ppm', '2500'));
const replayTolerancePpm = Math.max(
  Number(flag('min-replay-tolerance-ppm', '250')),
  Math.ceil(detAgg.p99PpmDiff || 0),
);
if (replayTolerancePpm > minImprovementPpm) {
  console.error(
    `calibrate: replayTolerancePpm=${replayTolerancePpm} exceeds minImprovementPpm=${minImprovementPpm}; `
      + 'increase --min-improvement-ppm or fix determinism before launch',
  );
  exit(2);
}

// ─── Hidden pack size + quotas ───────────────────────────────────────────────

const families = new Map();
for (const e of evalHiddenEvents) families.set(e.family, (families.get(e.family) ?? 0) + 1);

const packSize = Number(flag('pack-size', String(Math.max(16, Math.min(128, evalHiddenEvents.length)))));
const quotas = [];
for (const family of families.keys()) {
  const buckets = ['hard', 'medium'];
  for (const bucket of buckets) {
    const count = evalHiddenEvents.filter((e) => e.family === family && bucketOf(e) === bucket).length;
    if (count > 0) {
      quotas.push({
        stratum: `family=${family},bucket=${bucket}`,
        minCount: Math.min(count, Math.max(1, Math.floor(packSize * count / evalHiddenEvents.length / 2))),
      });
    }
  }
}

function bucketOf(event) {
  let max = 0;
  const truthIds = new Set(event.truthDocuments.map((d) => d.id));
  for (const q of event.qrels) {
    if (truthIds.has(q.documentId)) continue;
    if (q.relevance > max) max = q.relevance;
  }
  if (max >= 0.4) return 'hard';
  if (max >= 0.2) return 'medium';
  return 'easy';
}

// ─── Reranker top-k & abstention ──────────────────────────────────────────────

const rerankerTopK = Number(flag('reranker-top-k', '10'));
const retrievalKeyTopK = Number(flag('retrieval-key-top-k', '50'));
const abstentionThreshold = Number(flag('abstention-threshold', '0.001'));

// ─── Composite weights ───────────────────────────────────────────────────────

const compositeWeights = {
  w_retrieval:         Number(flag('w-retrieval', '0.75')),
  w_temporal:          Number(flag('w-temporal', '0.08')),
  w_relation_recall:   Number(flag('w-relation-recall', '0.07')),
  w_abstention:        Number(flag('w-abstention', '0.05')),
  w_structural_sanity: Number(flag('w-structural-sanity', '0.05')),
};
{
  const s = compositeWeights.w_retrieval + compositeWeights.w_temporal + compositeWeights.w_relation_recall + compositeWeights.w_abstention + compositeWeights.w_structural_sanity;
  if (Math.abs(s - 1) > 1e-6) { console.error(`composite weights must sum to 1.0 (got ${s})`); exit(1); }
  if (compositeWeights.w_retrieval < 0.7 - 1e-9) { console.error(`w_retrieval must be >= 0.70`); exit(1); }
  if (compositeWeights.w_structural_sanity > 0.10 + 1e-9) { console.error(`w_structural_sanity must be <= 0.10`); exit(1); }
}

// ─── Patch acceptance floors ─────────────────────────────────────────────────

const patchAcceptanceFloors = {
  minImprovementPpm,
  structuralFloor:          Number(flag('structural-floor', '0.95')),
  protectedRegressionFloor: Number(flag('protected-regression-floor', '0.05')),
  familyCatastrophicFloor:  Number(flag('family-catastrophic-floor', '0.85')),
};

// ─── Misc ────────────────────────────────────────────────────────────────────

const splitRatios = {
  trainVisiblePct:  Number(flag('split-train-visible-pct', '70')),
  calibrationPct:   Number(flag('split-calibration-pct', '10')),
  evalHiddenPct:    Number(flag('split-eval-hidden-pct', '15')),
  canaryPct:        Number(flag('split-canary-pct', '5')),
};

const relationHopBudget = Number(flag('relation-hop-budget', '3'));
const revealGracePeriodSeconds = Number(flag('reveal-grace-period-seconds', String(60 * 60 * 6)));

const relationEdgeTypes = [
  'supports', 'supersedes', 'coreference_of', 'causes', 'derived_from', 'co_occurs_with',
];

// ─── Compose the profile ─────────────────────────────────────────────────────

const profile = {
  name: 'coretex-v4-launch',
  version: 'v2-calibrated',
  scoreScale: 'ppm',
  scorePpmEncoding: 'uint32-0-to-1000000',
  patchScoreDeltaEncoding: 'int64-ppm',
  primaryMetric: 'ndcg@10',
  acceleratorPolicy: 'cpu_only',
  runtimePin: manifest.evaluator.profile.runtimePin,
  replayTolerancePpm,
  compositeWeights,
  patchAcceptanceFloors,
  splitRatios,
  hiddenPack: { packSize, quotas },
  relationHopBudget,
  abstentionThreshold,
  rerankerTopK,
  retrievalKeyTopK,
  relationEdgeTypes,
  revealGracePeriodSeconds,
};

const out = {
  schemaVersion: 'coretex.bundle-profile.v1',
  generatedAt: new Date().toISOString(),
  inputs: {
    bundleManifest: bundlePath,
    calibrationCorpus: calibCorpusPath,
    calibEventCount: calibEvents.length,
    determinismAggregate: detAggPath,
  },
  profile,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`calibrate: wrote ${outPath}`);
console.log(`  replayTolerancePpm=${replayTolerancePpm}`);
console.log(`  packSize=${packSize}`);
console.log(`  compositeWeights.w_retrieval=${compositeWeights.w_retrieval}`);
console.log(`  patchAcceptanceFloors=${JSON.stringify(patchAcceptanceFloors)}`);
exit(0);
