#!/usr/bin/env node
/**
 * Phase H2 — pin baselineParentScorePpm + fixedPackRepeatabilityPpm into the
 * final bundle manifest.
 *
 * Runs after `scripts/build-coretex-bundle.mjs` produces the canonical
 * bundleHash. This script:
 *   1. Loads the canonical bundle manifest
 *   2. Loads the launch corpus
 *   3. Derives the genesis hidden query pack (epoch 0, eval seed of
 *      coordinator's choice)
 *   4. Runs `evaluateBaseline` against the empty/genesis substrate on
 *      that pack — this gives the parent score the next epoch's
 *      acceptance rule normalizes against
 *   5. Re-writes the bundle profile with `baselineParentScorePpm` and
 *      `fixedPackRepeatabilityPpm` populated
 *   6. Recomputes the bundle hash (it WILL change — that's the point;
 *      the baseline values are part of the canonical bundle)
 *
 * Usage:
 *   node scripts/pin-baseline-into-bundle.mjs \
 *     --bundle-manifest /etc/coretex/bundle-manifest.json \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
 *     --eval-seed-hex <hex>                     # from openssl rand -hex 32
 *     --epoch-id 0 \
 *     --samples 1                               # ≥3 on heterogeneous calibration
 *     --out /etc/coretex/bundle-manifest.json   # in-place rewrite OK
 *
 * Environment:
 *   CORETEX_BIENCODER_PYTHON=/opt/coretex-venv/bin/python (or .venv/bin/python)
 *   CORETEX_RERANKER_PYTHON=…
 *   HF_HUB_CACHE=/var/lib/coretex/model-cache
 *   HF_HUB_OFFLINE=1
 *
 * Exit codes:
 *   0 — baseline pinned, bundle re-written, new bundleHash printed
 *   1 — script error or required inputs missing
 *   2 — baseline computation failed (model load / scorer error)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';

import {
  loadProductionCorpus,
  deriveQueryPack,
  evaluateBaseline,
  biEncoderFromEnv,
  rerankerFromEnv,
  biEncoderModelIdHash,
  buildBundleManifest,
  bgeM3DenseManifest,
  qwen3Reranker06BManifest,
  memReranker4BManifest,
  verifyBundleManifest,
  hiddenPackProfileFromEvaluatorProfile,
} from '@botcoin/coretex';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const bundlePath = flag('bundle-manifest');
const corpusPath = flag('corpus');
const evalSeedHex = flag('eval-seed-hex');
const epochId = Number(flag('epoch-id', '0'));
const samples = Number(flag('samples', '1'));
const outPath = flag('out', bundlePath);
const repoRoot = flag('repo-root', '/root/coretex');

if (!bundlePath || !corpusPath || !evalSeedHex) {
  console.error('pin-baseline-into-bundle: --bundle-manifest, --corpus, --eval-seed-hex required');
  exit(1);
}

const bundle = JSON.parse(readFileSync(resolve(bundlePath), 'utf8'));
const profile = bundle.evaluator.profile;
if (!profile) { console.error('pin-baseline: bundle has no evaluator.profile'); exit(1); }

console.log(`pin-baseline: loading corpus ${corpusPath}`);
const corpus = loadProductionCorpus(resolve(corpusPath), { verifyCorpusRoot: false, verifySplits: false });

console.log(`pin-baseline: deriving query pack epoch=${epochId} packSize=${profile.hiddenPack.packSize}`);
const pack = deriveQueryPack(epochId, evalSeedHex, corpus, hiddenPackProfileFromEvaluatorProfile(profile));
console.log(`  pack derived: ${pack.events.length} events`);

console.log(`pin-baseline: spawning streaming bi-encoder + reranker (this is real model work)`);
env.CORETEX_BIENCODER ??= 'pinned';
env.CORETEX_BIENCODER_MODE ??= 'streaming';
env.CORETEX_BIENCODER_REVISION ??= bundle.model.biEncoder.revision;
env.CORETEX_RERANKER ??= 'qwen3';
env.CORETEX_RERANKER_MODE ??= 'streaming';
env.CORETEX_RERANKER_REVISION ??= bundle.model.reranker.revision;
env.CORETEX_RERANKER_PRODUCTION ??= '1';
env.CORTEX_REAL_EVAL ??= '1';

const biEncoder = biEncoderFromEnv(bundle.model.biEncoder.retrievalKeyLayout, {
  modelId: bundle.model.biEncoder.modelId,
  revision: bundle.model.biEncoder.revision,
});
const reranker = await rerankerFromEnv();

const scoringOpts = {
  weights: profile.compositeWeights,
  biEncoder,
  reranker,
  retrievalKeyLayout: bundle.model.biEncoder.retrievalKeyLayout,
  biEncoderHash: biEncoderModelIdHash(
    bundle.model.biEncoder.modelId,
    bundle.model.biEncoder.revision,
    bundle.model.biEncoder.mode,
  ),
  relationHopBudget: profile.relationHopBudget,
  abstentionThreshold: profile.abstentionThreshold,
  rerankerTopK: profile.rerankerTopK,
  retrievalKeyTopK: profile.retrievalKeyTopK,
  // v2-lens pipeline params — fall back to defaults pre-Run-0/1 calibration.
  firstStageTopK: profile.firstStageTopK ?? 200,
  rerankerInputTopK: profile.rerankerInputTopK ?? 128,
  lensTopK: profile.lensTopK ?? 36,
  lensWeight: profile.lensWeight ?? 0.10,
  anchorWeight: profile.anchorWeight ?? 0.15,
  relationExpansionBudget: profile.relationExpansionBudget ?? 50,
  categoryLensExpansionBudget: profile.categoryLensExpansionBudget ?? profile.relationExpansionBudget ?? 50,
  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.10,
  temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.10,
  lensDiversityFloor: profile.lensDiversityFloor,
  pipelineVersion: profile.pipelineVersion,
};

// Genesis / empty parent substrate — all-zero 1024-word state.
const parentSubstrate = { words: new Array(1024).fill(0n) };

console.log(`pin-baseline: running evaluateBaseline (samples=${samples})`);
let baseline;
try {
  baseline = await evaluateBaseline(parentSubstrate, corpus, pack, scoringOpts, { samples });
} catch (err) {
  console.error(`pin-baseline: evaluateBaseline failed: ${err.message}`);
  exit(2);
}
console.log(`  parentScorePpm=${baseline.parentScorePpm}`);
console.log(`  variancePpm=${baseline.variancePpm}`);
console.log(`  samples=${baseline.samples}`);

// Patch the profile and rebuild the bundle manifest so the bundleHash
// reflects the pinned baseline values. Same-shape rebuild — every other
// pin (model revisions, files, runtimePin, replayTolerancePpm, weights,
// floors, quotas, negCategoryRelevanceMap, majorDeltaThreshold) is
// preserved verbatim from the input bundle.
const updatedProfile = {
  ...profile,
  baselineParentScorePpm: baseline.parentScorePpm,
  baselineVarianceSource: profile.baselineVarianceSource ?? 'unavailable',
  fixedPackRepeatabilityPpm: baseline.variancePpm,
  baselineSamples: baseline.samples,
  baselineEvalSeedHex: evalSeedHex.toLowerCase().startsWith('0x') ? evalSeedHex.toLowerCase() : `0x${evalSeedHex.toLowerCase()}`,
};
if (updatedProfile.baselineVarianceSource !== 'rotating_pack' && updatedProfile.baselineVarianceSource !== 'broad_sampling') {
  delete updatedProfile.baselineVariancePpm;
}

const rebuilt = buildBundleManifest({
  repoRoot,
  corpusRoot: bundle.corpus.root,
  corpusFiles: bundle.corpus.files.map((f) => f.path),
  biEncoder: bundle.model.biEncoder,
  reranker: bundle.model.reranker,
  labelingReranker: bundle.model.labelingReranker,
  evaluatorProfile: updatedProfile,
  bundleName: bundle.bundleName,
  generatedAt: new Date().toISOString(),
});

// Manifest verification before commit — refuses to ship if any pinned
// file's SHA-256 has drifted vs the input bundle.
const errs = verifyBundleManifest(rebuilt, repoRoot);
if (errs.length) {
  console.error(`pin-baseline: rebuilt bundle failed verification: ${errs.join(', ')}`);
  exit(2);
}

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), JSON.stringify(rebuilt, null, 2));
console.log(`pin-baseline: rewrote ${outPath}`);
console.log(`  bundleHash (was): ${bundle.bundleHash}`);
console.log(`  bundleHash (now): ${rebuilt.bundleHash}`);
console.log(`  baselineParentScorePpm: ${baseline.parentScorePpm}`);
console.log(`  fixedPackRepeatabilityPpm: ${baseline.variancePpm}`);

if (typeof reranker.close === 'function') await reranker.close();
if (typeof biEncoder.close === 'function') await biEncoder.close();

exit(0);
