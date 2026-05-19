#!/usr/bin/env node
/**
 * Calibration Run 2 — baseline variance under the v2-lens pipeline.
 *
 * Spec: docs/CORETEX_SUBSTRATE_EXPANSION_HARDENING.md §5 Run 2.
 *
 * Pins `baselineVariancePpm` — the launch acceptance noise floor that
 * miners' deltaPpm must clear in addition to `minImprovementPpm` +
 * `replayTolerancePpm`. Measured by scoring an empty substrate against
 * N≥50 independent hidden packs (different eval-seeds), computing σ of
 * composite, and converting to ppm.
 *
 * The May-15 calibration's value was measured against the v1 bookmark
 * scorer and is incorrect for v2-lens. This run overwrites it.
 *
 * Usage:
 *   CORETEX_RERANKER=qwen3 CORETEX_RERANKER_PRODUCTION=1 \
 *   CORETEX_RERANKER_MODE=streaming \
 *   CORETEX_RERANKER_PYTHON=/root/cortex/.venv/bin/python \
 *   HF_HUB_CACHE=/var/lib/coretex/model-cache HF_HUB_OFFLINE=1 \
 *     node --max-old-space-size=16384 scripts/calibrate-baseline-variance.mjs \
 *       --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *       --bundle-profile /etc/coretex/bundle-profile.json \
 *       --num-packs 50 --pack-size 32 \
 *       --reranker env \
 *       --out /var/lib/coretex/reports/baseline-variance-v2.json
 *
 * Exit codes:
 *   0 = sweep completed; report written with σ and 95% CI
 *   1 = setup error
 */

import { distIndex } from './_repo-root.mjs';
import { profileAttestation } from './lib/profile-attestation.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const numPacks = Number(flag('num-packs', '50'));
// pack-size flag is an OVERRIDE; default is to use profile.hiddenPack.packSize
// for production-faithful variance measurement against the same pack shape
// the coordinator will use.
const packSizeOverride = argv.indexOf('--pack-size') >= 0 ? Number(flag('pack-size', '128')) : null;
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/baseline-variance-v2.json');

function fail(msg, code = 1) { console.error(`[run2-variance] ${msg}`); exit(code); }
if (!corpusPath || !existsSync(corpusPath)) fail(`--corpus missing or not found: ${corpusPath}`);

const {
  loadProductionCorpus, evaluateRetrievalBenchmarkState,
  biEncoderModelIdHash, rerankerFromEnv, biEncoderFromEnv,
  createDeterministicReranker, createDeterministicBiEncoder,
  deriveQueryPack,
  DEFAULT_PROFILE,
} = await import(distIndex);
const { buildProvenance } = await import('./calibration-provenance.mjs');

const profile = profilePath && existsSync(profilePath)
  ? (() => {
      const raw = JSON.parse(readFileSync(profilePath, 'utf8'));
      // Profile JSON has nested shape `{ inputs, profile: {...} }`; unwrap.
      return raw.profile ?? raw;
    })()
  : DEFAULT_PROFILE;

console.log(`[run2-variance] loading corpus`);
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.log(`  ${corpus.events.length} events, corpusRoot=${corpus.corpusRoot}`);

const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);
const ZERO_STATE = { words: new Array(1024).fill(0n) };

let reranker;
let biEncoder;
if (rerankerArg === 'env') {
  console.log(`[run2-variance] spinning reranker via env (CORETEX_RERANKER=${process.env.CORETEX_RERANKER ?? ''})`);
  reranker = await rerankerFromEnv();
  biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });
} else {
  reranker = await createDeterministicReranker();
  biEncoder = createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT });
}
console.log(`[run2-variance] reranker: ${reranker.model}`);

const opts = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  biEncoder, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: profile.relationHopBudget ?? 2,
  abstentionThreshold: profile.abstentionThreshold ?? 0.001,
  rerankerTopK: profile.rerankerTopK ?? 10,
  retrievalKeyTopK: profile.retrievalKeyTopK ?? 50,
  firstStageTopK: profile.firstStageTopK ?? 3200,
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

// PRODUCTION-FAITHFUL pack derivation: use the same `deriveQueryPack` that
// the coordinator uses to derive hidden packs from on-chain eval seeds. This
// applies the bundle profile's strict family-stratification quotas (e.g.
// near_collision medium ≥ 35, long_horizon medium ≥ 20). Pack size comes
// from the profile's `hiddenPack.packSize` (production pin: 128), not from
// the CLI flag — the flag is now an override for the override-rare case.
// Without this fix, Run 2's variance estimate was for a non-production pack
// shape (raw eval_hidden, no quotas, smaller packSize) and overstated σ.
function buildPack(seedNum) {
  const seedHex = '0x' + createHash('sha256').update(`baseline-variance:${seedNum}`).digest('hex');
  const hiddenProfile = profile.hiddenPack ?? { packSize, quotas: [] };
  // If user supplied a pack-size override, respect it but keep quotas.
  const useProfile = packSizeOverride
    ? { packSize: packSizeOverride, quotas: hiddenProfile.quotas ?? [] }
    : hiddenProfile;
  return deriveQueryPack(0, seedHex, corpus, useProfile);
}

const composites = [];
const perPackReports = [];
for (let k = 0; k < numPacks; k++) {
  const pack = buildPack(k);
  const t = Date.now();
  const score = await evaluateRetrievalBenchmarkState(ZERO_STATE, corpus, pack, opts);
  const elapsed = Date.now() - t;
  composites.push(score.composite);
  perPackReports.push({
    seedHex: pack.evalSeedCommit,
    composite: score.composite,
    nDCG10: score.nDCG10,
    temporal: score.temporal,
    multiHopRecall10: score.multiHopRecall10,
    elapsedMs: elapsed,
  });
  console.error(`  pack ${k+1}/${numPacks}: composite=${score.composite.toFixed(4)} (${elapsed} ms)`);
}

// Compute σ and 95% CI on σ.
const mean = composites.reduce((a, b) => a + b, 0) / composites.length;
const ss = composites.reduce((a, b) => a + (b - mean) ** 2, 0);
const sigma = Math.sqrt(ss / Math.max(1, composites.length - 1));
const sigmaPpm = Math.round(sigma * 1_000_000);

// 95% CI on σ: chi-squared with N-1 dof; for large N approximated by
// σ × (1 ± 1.96/sqrt(2(N-1)))
const ciHalfWidth = 1.96 / Math.sqrt(2 * (composites.length - 1));
const sigmaPpmLow = Math.round(sigmaPpm * (1 - ciHalfWidth));
const sigmaPpmHigh = Math.round(sigmaPpm * (1 + ciHalfWidth));

// Re-derive a sample pack to report effective packSize (after quotas).
const samplePack = buildPack(0);
const effectivePackSize = samplePack.events.length;

const report = {
  schemaVersion: 'coretex.baseline-variance-v2.v2',
  generatedAt: new Date().toISOString(),
  provenance: buildProvenance(),
  fidelity: 'PRODUCTION_FAITHFUL',
  fidelityNotes: 'Uses deriveQueryPack with profile.hiddenPack.packSize + family-stratification quotas — exactly the pack shape the coordinator derives per-patch from on-chain eval seeds. Variance estimate represents production per-patch acceptance noise.',
  inputs: {
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    bundleProfile: profilePath ?? null,
    profileAttestation: profileAttestation(profile, profilePath),
    rerankerMode: rerankerArg,
    rerankerModel: reranker.model,
    numPacks,
    packSize: effectivePackSize,
    packSizeFromProfile: profile.hiddenPack?.packSize ?? null,
    packSizeOverride,
    hiddenPackQuotas: profile.hiddenPack?.quotas ?? null,
    pipelineVersion: profile.pipelineVersion ?? null,
  },
  meanComposite: mean,
  sigmaComposite: sigma,
  baselineVariancePpm: sigmaPpm,
  baselineVariancePpm95CI: [sigmaPpmLow, sigmaPpmHigh],
  perPack: perPackReports,
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[run2-variance] report → ${reportPath}`);
console.log(`[run2-variance] baselineVariancePpm = ${sigmaPpm}  (95% CI [${sigmaPpmLow}, ${sigmaPpmHigh}], mean composite ${mean.toFixed(4)})`);
exit(0);
