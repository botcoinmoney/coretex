#!/usr/bin/env node
/**
 * coretex-eval — miner self-eval harness.
 *
 * Spec: specs/substrate_retrieval_semantics.md and the active evaluator
 * profile pinned by the launch artifact manifest.
 *
 * Runs the production scorer end-to-end against a SPLIT-VISIBLE query pack
 * for a candidate patch. The score breakdown matches what the coordinator
 * computes against the hidden pack — same EvaluatorProfile, same models,
 * same PublicCorpusIndex. Test K (parity) asserts byte-identical
 * CompositeScore output against the coordinator's evaluator on the same
 * (parent, patch, query) triple.
 *
 * Why this and not opening the rejection envelope:
 *   The HTTP shim's opaque rejection envelope stays opaque — every leaked
 *   number is a free gradient sample for hidden-pack triangulation. The
 *   miner can run an identical-bit replay against the visible split and
 *   get the full breakdown locally. Everything they need to learn from
 *   the system is learnable from public data; nothing about the hidden
 *   pack leaks. The asymmetry is by design.
 *
 * Usage:
 *   node --max-old-space-size=16384 scripts/coretex-eval.mjs \
 *     --bundle-manifest /etc/coretex/bundle-manifest.json \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *     --parent-state ./parent-state.bin       # 32 KB packed substrate bytes
 *     --patch ./candidate-patch.json          # canonical patch shape
 *     --split visible                          # visible | calibration
 *     --reranker env                           # env | deterministic
 *
 * Or, equivalently, with no patch — just score the parent on the split:
 *   --score-only --parent-state ./parent.bin
 *
 * Output:
 *   ./eval-report.json with:
 *     - bundleHash, corpusRoot, splitName, packSize
 *     - parent: CompositeScore { composite, nDCG10, ..., perQuery: [...] }
 *     - candidate: CompositeScore (if --patch provided)
 *     - deltaPpm, perFamilyDelta
 *     - envelopeClass: 'rejected' | 'accepted_no_advance' | 'state_advance'
 *
 * Exit codes:
 *   0 = ran cleanly; report written. Envelope class is in the report.
 *   1 = setup / arg error
 *   2 = patch shape invalid (would reject at screener)
 *   3 = patch decode failed (would reject at applyPatch)
 */

import { distIndex } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit, env } from 'node:process';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  if (argv.includes(`--${name}`)) return true;
  return fb;
}

const bundlePath = flag('bundle-manifest');
const profilePath = flag('bundle-profile');
const corpusPath = flag('corpus');
const parentStateArg = flag('parent-state');             // file path
const parentStateRootArg = flag('parent-state-root');    // hex32 (optional sanity)
const patchPath = flag('patch');
const splitArg = flag('split', 'visible');
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', './eval-report.json');
const evalSeedHex = flag('eval-seed', '0x' + 'cc'.repeat(32));
const epochIdArg = Number(flag('epoch-id', '0'));
const scoreOnly = !!flag('score-only', false);

function fail(msg, code = 1) { console.error(`[coretex-eval] ${msg}`); exit(code); }
if (!corpusPath || !existsSync(corpusPath)) fail(`--corpus missing or not found: ${corpusPath}`);
if (!parentStateArg) fail('--parent-state is required (path to 1024-word packed substrate bytes)');
if (!existsSync(parentStateArg)) fail(`--parent-state not found: ${parentStateArg}`);
if (!scoreOnly && !patchPath) fail('--patch is required (or pass --score-only)');
if (patchPath && !existsSync(patchPath)) fail(`--patch not found: ${patchPath}`);

const dist = distIndex;
if (!existsSync(dist)) fail(`@botcoin/coretex dist not built: ${dist}`);

const {
  loadProductionCorpus,
  deriveQueryPack,
  evaluateRetrievalBenchmarkState,
  applyPatch,
  computeAcceptanceThresholdPpm,
  rerankerFromEnv,
  biEncoderFromEnv,
  biEncoderModelIdHash,
  createDeterministicReranker,
  createDeterministicBiEncoder,
  DEFAULT_PROFILE,
} = await import(dist);

const bundle = bundlePath && existsSync(bundlePath) ? JSON.parse(readFileSync(bundlePath, 'utf8')) : null;
const profile = bundle?.evaluator?.profile
  ?? (profilePath && existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, 'utf8')) : DEFAULT_PROFILE);

console.log(`[coretex-eval] loading corpus ${corpusPath}`);
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.log(`  corpusRoot=${corpus.corpusRoot}  events=${corpus.events.length}`);

// Parent state bytes (1024 words × 32 bytes = 32 KiB). Stored as packed-32-byte
// big-endian; decode to bigint[1024].
const parentBytes = readFileSync(parentStateArg);
if (parentBytes.length !== 32 * 1024) {
  fail(`--parent-state has ${parentBytes.length} bytes; expected ${32 * 1024} (1024 words × 32 bytes)`);
}
const parentWords = new Array(1024);
for (let i = 0; i < 1024; i++) {
  let v = 0n;
  for (let j = 0; j < 32; j++) v = (v << 8n) | BigInt(parentBytes[i * 32 + j]);
  parentWords[i] = v;
}
const parentState = { words: parentWords };

const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);

// Reranker + bi-encoder (env-driven or deterministic).
let reranker;
let biEncoder;
if (rerankerArg === 'env') {
  reranker = await rerankerFromEnv();
  biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });
} else {
  reranker = await createDeterministicReranker();
  biEncoder = createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT });
}

// Build a pack from the chosen non-hidden split. `deriveQueryPack` is
// hardcoded to the `eval_hidden` filter (that's the production semantics —
// the hidden pack feeds the coordinator's scoring). For miner self-eval we
// want the same shape over the visible / calibration split. Implementation
// mirrors deriveQueryPack but on a different split filter: deterministic
// keccak-derived stratified sample by the same evalSeed.
async function buildPackForSplit(splitName) {
  const events = corpus.events.filter((e) => e.split === splitName);
  if (events.length === 0) throw new Error(`split "${splitName}" has no events`);
  const targetSize = Math.min(profile.hiddenPack?.packSize ?? 32, events.length);

  // Deterministic stratified sampling — hashScore(seed, id) → uniform [0,1).
  const crypto = await import('node:crypto');
  const score = (id) => {
    const h = crypto.createHash('sha256').update(`${evalSeedHex}:${epochIdArg}:${id}`).digest('hex');
    return parseInt(h.slice(0, 8), 16) / 0xffffffff;
  };
  // Sort by hash score, take first `targetSize`.
  const scored = events.map((e) => ({ e, s: score(e.id) }));
  scored.sort((a, b) => a.s - b.s);
  const picked = scored.slice(0, targetSize).map((x) => x.e);

  return {
    epochId: epochIdArg,
    evalSeedCommit: evalSeedHex,
    events: picked,
  };
}

const pack = await buildPackForSplit(splitArg);
console.log(`[coretex-eval] pack split=${splitArg}  size=${pack.events.length}  evalSeed=${evalSeedHex}`);

const scoringOpts = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  biEncoder,
  reranker,
  retrievalKeyLayout: LAYOUT,
  biEncoderHash,
  relationHopBudget: profile.relationHopBudget ?? 3,
  abstentionThreshold: profile.abstentionThreshold ?? 0.001,
  rerankerTopK: profile.rerankerTopK ?? 10,
  retrievalKeyTopK: profile.retrievalKeyTopK ?? 50,
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

// Score parent.
console.log(`[coretex-eval] scoring parent substrate against ${pack.events.length}-query pack`);
const t0 = Date.now();
const parentScore = await evaluateRetrievalBenchmarkState(parentState, corpus, pack, scoringOpts);
console.log(`  parent.composite=${parentScore.composite.toFixed(4)}  nDCG10=${parentScore.nDCG10.toFixed(4)}  (${Date.now() - t0} ms)`);

let candidateScore = null;
let deltaPpm = null;
let perFamilyDelta = null;
let envelopeClass = null;
let patchApplyError = null;

if (!scoreOnly) {
  const patchJson = JSON.parse(readFileSync(patchPath, 'utf8'));
  // Normalize patch field types: indices/newWords stay as arrays; scoreDelta
  // and parentStateRoot stay as their string forms; numeric fields cast.
  const patch = {
    patchType: Number(patchJson.patchType),
    wordCount: Number(patchJson.wordCount),
    scoreDelta: BigInt(patchJson.scoreDelta ?? 0),
    parentStateRoot: patchJson.parentStateRoot,
    indices: (patchJson.indices ?? []).map(Number),
    newWords: (patchJson.newWords ?? []).map((w) =>
      typeof w === 'bigint' ? w : BigInt(w),
    ),
  };

  console.log(`[coretex-eval] applying patch (${patch.wordCount} words at ${patch.indices.length} indices)`);
  const applied = applyPatch(parentState, patch);
  if (!applied.ok) {
    patchApplyError = applied.code;
    envelopeClass = 'rejected';
    console.error(`  applyPatch FAILED: ${applied.code} — envelope=rejected`);
  } else {
    const t1 = Date.now();
    candidateScore = await evaluateRetrievalBenchmarkState(applied.state, corpus, pack, scoringOpts);
    console.log(`  candidate.composite=${candidateScore.composite.toFixed(4)}  nDCG10=${candidateScore.nDCG10.toFixed(4)}  (${Date.now() - t1} ms)`);

    // deltaPpm — same convention as patchAcceptanceFloors uses.
    const PPM = 1_000_000;
    deltaPpm = Math.round((candidateScore.composite - parentScore.composite) * PPM);

    // Per-family delta from perQuery breakdown.
    perFamilyDelta = {};
    const familySumBefore = {};
    const familyCountBefore = {};
    for (const q of parentScore.perQuery) {
      familySumBefore[q.family] = (familySumBefore[q.family] ?? 0) + q.nDCG10;
      familyCountBefore[q.family] = (familyCountBefore[q.family] ?? 0) + 1;
    }
    const familySumAfter = {};
    const familyCountAfter = {};
    for (const q of candidateScore.perQuery) {
      familySumAfter[q.family] = (familySumAfter[q.family] ?? 0) + q.nDCG10;
      familyCountAfter[q.family] = (familyCountAfter[q.family] ?? 0) + 1;
    }
    for (const fam of new Set([...Object.keys(familySumBefore), ...Object.keys(familySumAfter)])) {
      const meanBefore = (familySumBefore[fam] ?? 0) / Math.max(1, familyCountBefore[fam] ?? 1);
      const meanAfter = (familySumAfter[fam] ?? 0) / Math.max(1, familyCountAfter[fam] ?? 1);
      perFamilyDelta[fam] = Math.round((meanAfter - meanBefore) * PPM);
    }

    // Envelope class prediction
    const threshold = computeAcceptanceThresholdPpm({
      patchAcceptanceFloors: profile.patchAcceptanceFloors,
      replayTolerancePpm: profile.replayTolerancePpm,
      baselineVariancePpm: profile.baselineVariancePpm ?? 0,
      baselineVarianceSource: profile.baselineVarianceSource ?? 'unavailable',
      fixedPackRepeatabilityPpm: profile.fixedPackRepeatabilityPpm,
    });
    if (deltaPpm >= threshold) envelopeClass = 'state_advance';
    else envelopeClass = 'accepted_no_advance';
    console.log(`  deltaPpm=${deltaPpm}  threshold=${threshold}  predicted envelope=${envelopeClass}`);
  }
}

const report = {
  schemaVersion: 'coretex.miner-self-eval.v1',
  generatedAt: new Date().toISOString(),
  inputs: {
    bundleManifest: bundlePath ?? null,
    bundleHash: bundle?.bundleHash ?? null,
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    split: splitArg,
    evalSeedHex,
    epochId: epochIdArg,
    rerankerMode: rerankerArg,
    parentStateFile: parentStateArg,
    parentStateRootHint: parentStateRootArg ?? null,
    patchFile: patchPath ?? null,
  },
  pack: {
    size: pack.events.length,
    familyHistogram: pack.events.reduce((h, e) => { h[e.family] = (h[e.family] ?? 0) + 1; return h; }, {}),
  },
  parent: {
    composite: parentScore.composite,
    nDCG10: parentScore.nDCG10,
    mrr10: parentScore.mrr10,
    recall10: parentScore.recall10,
    temporal: parentScore.temporal,
    multiHopRecall10: parentScore.multiHopRecall10,
    abstention: parentScore.abstention,
    structuralValidity: parentScore.structuralValidity,
  },
  candidate: candidateScore ? {
    composite: candidateScore.composite,
    nDCG10: candidateScore.nDCG10,
    mrr10: candidateScore.mrr10,
    recall10: candidateScore.recall10,
    temporal: candidateScore.temporal,
    multiHopRecall10: candidateScore.multiHopRecall10,
    abstention: candidateScore.abstention,
    structuralValidity: candidateScore.structuralValidity,
  } : null,
  deltaPpm,
  perFamilyDelta,
  envelopeClass,
  patchApplyError,
};

mkdirSync(dirname(resolve(reportPath)), { recursive: true });
writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2));
console.log(`[coretex-eval] report → ${reportPath}`);

if (envelopeClass === 'rejected' && patchApplyError) exit(3);
exit(0);
