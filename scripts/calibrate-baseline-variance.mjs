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
const packSize = Number(flag('pack-size', '32'));
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/baseline-variance-v2.json');

function fail(msg, code = 1) { console.error(`[run2-variance] ${msg}`); exit(code); }
if (!corpusPath || !existsSync(corpusPath)) fail(`--corpus missing or not found: ${corpusPath}`);

const {
  loadProductionCorpus, evaluateRetrievalBenchmarkState,
  biEncoderModelIdHash, rerankerFromEnv, biEncoderFromEnv,
  createDeterministicReranker, createDeterministicBiEncoder,
  DEFAULT_PROFILE,
} = await import('/root/cortex/packages/cortex/dist/index.js');

const profile = profilePath && existsSync(profilePath)
  ? JSON.parse(readFileSync(profilePath, 'utf8'))
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
  lensTopK: profile.lensTopK ?? 36,
  lensWeight: profile.lensWeight ?? 0.10,
  anchorWeight: profile.anchorWeight ?? 0.15,
  relationExpansionBudget: profile.relationExpansionBudget ?? 50,
  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.10,
  temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.10,
};

// Build N packs from the eval_hidden split, each with a different deterministic seed.
function buildPack(seedNum, packSize) {
  const events = corpus.events.filter((e) => e.split === 'eval_hidden');
  // Stratified-deterministic sample
  const seedHex = '0x' + createHash('sha256').update(`baseline-variance:${seedNum}`).digest('hex');
  const scored = events.map((e) => ({
    e,
    s: parseInt(createHash('sha256').update(seedHex + ':' + e.id).digest('hex').slice(0, 8), 16) / 0xffffffff,
  }));
  scored.sort((a, b) => a.s - b.s);
  return {
    epochId: 0,
    evalSeedCommit: seedHex,
    events: scored.slice(0, packSize).map((x) => x.e),
  };
}

const composites = [];
const perPackReports = [];
for (let k = 0; k < numPacks; k++) {
  const pack = buildPack(k, packSize);
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
  console.log(`  pack ${k+1}/${numPacks}: composite=${score.composite.toFixed(4)} (${elapsed} ms)`);
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

const report = {
  schemaVersion: 'coretex.baseline-variance-v2.v1',
  generatedAt: new Date().toISOString(),
  inputs: {
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    bundleProfile: profilePath ?? null,
    rerankerMode: rerankerArg,
    rerankerModel: reranker.model,
    numPacks,
    packSize,
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
