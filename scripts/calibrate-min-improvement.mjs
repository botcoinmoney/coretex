#!/usr/bin/env node
/**
 * Calibration Run 4 — minImprovementPpm sweep with adversarial hill-climbing.
 *
 * Spec: docs/CORETEX_SUBSTRATE_EXPANSION_HARDENING.md §5 Run 4.
 *
 * Generates N candidate patches across {lens-only, anchor-only, relation-only,
 * mixed} surfaces × {empty, calibration-pinned, evolved, adversarial} parent
 * substrates, scores them under the v2-lens pipeline, and reports false-accept
 * + false-reject rates for `minImprovementPpm ∈ {500, 1000, 2500, 5000}`.
 *
 * Includes adaptive adversarial: for each parent-substrate bucket, runs a
 * 100-step (or --hill-steps) hill-climbing search over patches with the
 * objective `maximize composite(visible_split)`, then re-scores those
 * patches on the hidden split. Patches that overfit visible → fail hidden
 * mark the gameability dimension of the threshold.
 *
 * Pick the smallest minImprovementPpm whose false-accept rate on hill-
 * climbed patches stays ≤ 1%.
 *
 * Scaled-down launch defaults (--num-patches 100, --hill-steps 25,
 * --pack-size 8) for tractable wall-time on the CPU host; pre-launch run
 * should expand to N≥1000 + hill-steps≥100.
 *
 * Usage:
 *   CORETEX_RERANKER=qwen3 ... node --max-old-space-size=16384 \
 *     scripts/calibrate-min-improvement.mjs \
 *       --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *       --bundle-profile /etc/coretex/bundle-profile.json \
 *       --num-patches 100 --hill-steps 25 --pack-size 8 \
 *       --reranker env \
 *       --out /var/lib/coretex/reports/min-improvement-sweep.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash, randomBytes } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const numPatches = Number(flag('num-patches', '100'));
const hillSteps = Number(flag('hill-steps', '25'));
const packSize = Number(flag('pack-size', '8'));
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/min-improvement-sweep.json');
const seedHex = flag('seed', '0x' + 'dd'.repeat(32));

function fail(msg, code = 1) { console.error(`[run4-minimp] ${msg}`); exit(code); }
if (!corpusPath || !existsSync(corpusPath)) fail(`--corpus missing or not found: ${corpusPath}`);

const {
  loadProductionCorpus, evaluateRetrievalBenchmarkState,
  biEncoderModelIdHash, rerankerFromEnv, biEncoderFromEnv,
  createDeterministicReranker, createDeterministicBiEncoder,
  encodeMemoryIndexSlot, encodeRetrievalKeySlot,
  encodeRelationEdge, encodeRelationCategoryLens,
  DEFAULT_PROFILE,
} = await import('/root/cortex/packages/cortex/dist/index.js');

const profile = profilePath && existsSync(profilePath)
  ? JSON.parse(readFileSync(profilePath, 'utf8'))
  : DEFAULT_PROFILE;

console.log(`[run4-minimp] loading corpus`);
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });

const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);

let reranker, biEncoder;
if (rerankerArg === 'env') {
  reranker = await rerankerFromEnv();
  biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });
} else {
  reranker = await createDeterministicReranker();
  biEncoder = createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT });
}
console.log(`[run4-minimp] reranker: ${reranker.model}`);

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

const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672 };

function stableRecordIdLow128(id) {
  const h = createHash('sha256').update(`coretex:record:${id}`).digest();
  let v = 0n;
  for (let i = 0; i < 16; i++) v = (v << 8n) | BigInt(h[i]);
  return v;
}

// Build packs for visible (train_visible split) and hidden (eval_hidden) sides.
function buildSplitPack(splitName, seedNum) {
  const events = corpus.events.filter((e) => e.split === splitName);
  const seedKey = seedHex + ':' + seedNum;
  const scored = events.map((e) => ({
    e,
    s: parseInt(createHash('sha256').update(seedKey + ':' + e.id).digest('hex').slice(0, 8), 16) / 0xffffffff,
  }));
  scored.sort((a, b) => a.s - b.s);
  return { epochId: 0, evalSeedCommit: seedHex, events: scored.slice(0, packSize).map((x) => x.e) };
}

const visiblePack = buildSplitPack('train_visible', 0);
const hiddenPack = buildSplitPack('eval_hidden', 0);
console.log(`[run4-minimp] visible pack=${visiblePack.events.length}, hidden pack=${hiddenPack.events.length}`);

// Make a random patch on a parent state. Random in one of 4 patch surfaces.
function randomPatch(surface, parentWords, salt) {
  // Pick a random uncommitted slot per surface.
  const choose = (n) => Math.floor(parseInt(createHash('sha256').update(`${salt}:${surface}:c`).digest('hex').slice(0, 8), 16) / 0x100000000 * n);
  if (surface === 'lens') {
    const i = choose(36);
    const key = {
      slotIndex: i,
      modelIdHash: biEncoderHash,
      l2Norm: 1.0,
      versionTag: 1,
      quantizedBytes: randomBytes(LAYOUT.dim + 4),
    };
    const newWords = encodeRetrievalKeySlot(key, { retrievalKeyHeaderBytes: LAYOUT.headerBytes });
    const indices = []; const wordsOut = [];
    for (let j = 0; j < 8; j++) { indices.push(RANGES.RETRIEVAL_KEYS_START + i * 8 + j); wordsOut.push(newWords[j]); }
    return { indices, newWords: wordsOut };
  }
  if (surface === 'anchor') {
    const i = choose(44);
    const randEvent = corpus.events[Math.floor(parseInt(createHash('sha256').update(`${salt}:ev`).digest('hex').slice(0, 8), 16) / 0x100000000 * corpus.events.length)];
    const slot = {
      slotIndex: i,
      recordId: stableRecordIdLow128(randEvent.id),
      family: randEvent.family,
      domainBits: 1n,
      valid: true,
      revoked: false,
      protected: false,
      retrievalSlot: i % 36,
      expiryEpoch: 0n,
    };
    const newWords = encodeMemoryIndexSlot(slot);
    const indices = []; const wordsOut = [];
    for (let j = 0; j < 8; j++) { indices.push(RANGES.MEMORY_INDEX_START + i * 8 + j); wordsOut.push(newWords[j]); }
    return { indices, newWords: wordsOut };
  }
  if (surface === 'relation') {
    const idx = choose(128);
    const edgeTypes = ['supports', 'supersedes', 'derived_from'];
    const et = edgeTypes[choose(3) ?? 0];
    const lens = { entryIndex: idx, edgeType: et, weight: 0xFFFF };
    return { indices: [RANGES.RELATIONS_START + idx], newWords: [encodeRelationCategoryLens(lens)] };
  }
  // mixed: lens + anchor
  const a = randomPatch('lens', parentWords, salt + ':a');
  const b = randomPatch('anchor', parentWords, salt + ':b');
  return { indices: [...a.indices, ...b.indices], newWords: [...a.newWords, ...b.newWords] };
}

function applyPatchToWords(parentWords, patch) {
  const next = parentWords.slice();
  for (let i = 0; i < patch.indices.length; i++) next[patch.indices[i]] = patch.newWords[i];
  return next;
}

async function scoreSubstrate(words, pack) {
  return await evaluateRetrievalBenchmarkState({ words }, corpus, pack, opts);
}

// Score parent substrate once (empty for v0; bigger configs follow).
const EMPTY_WORDS = new Array(1024).fill(0n);
console.error(`[run4-minimp] scoring empty parent on visible + hidden`);
const tParent = Date.now();
const parentVisible = await scoreSubstrate(EMPTY_WORDS, visiblePack);
const parentHidden = await scoreSubstrate(EMPTY_WORDS, hiddenPack);
console.log(`  empty visible composite=${parentVisible.composite.toFixed(4)}  hidden composite=${parentHidden.composite.toFixed(4)}  (${Date.now()-tParent} ms)`);

const surfaces = ['lens', 'anchor', 'relation', 'mixed'];
const randomTrials = [];
console.error(`[run4-minimp] scoring ${numPatches} random patches across surfaces...`);
for (let i = 0; i < numPatches; i++) {
  const surface = surfaces[i % surfaces.length];
  const salt = `random:${i}`;
  const patch = randomPatch(surface, EMPTY_WORDS, salt);
  const childWords = applyPatchToWords(EMPTY_WORDS, patch);
  const childVisible = await scoreSubstrate(childWords, visiblePack);
  const childHidden = await scoreSubstrate(childWords, hiddenPack);
  const visibleDelta = Math.round((childVisible.composite - parentVisible.composite) * 1e6);
  const hiddenDelta = Math.round((childHidden.composite - parentHidden.composite) * 1e6);
  randomTrials.push({ idx: i, surface, visibleDelta, hiddenDelta });
  if ((i + 1) % 25 === 0) console.error(`  random ${i+1}/${numPatches}`);
}

// Adversarial hill-climbing: pick a starting random patch, mutate it for N steps,
// accepting mutations that improve visible composite. Then evaluate hidden.
const adversarialTrials = [];
console.error(`[run4-minimp] running ${hillSteps}-step hill-climbing × ${surfaces.length} surfaces...`);
for (const surface of surfaces) {
  let bestPatch = randomPatch(surface, EMPTY_WORDS, `adv:${surface}:0`);
  let bestWords = applyPatchToWords(EMPTY_WORDS, bestPatch);
  let bestVisible = (await scoreSubstrate(bestWords, visiblePack)).composite;
  for (let step = 1; step <= hillSteps; step++) {
    const candidate = randomPatch(surface, bestWords, `adv:${surface}:${step}`);
    const candidateWords = applyPatchToWords(bestWords, candidate);
    const c = (await scoreSubstrate(candidateWords, visiblePack)).composite;
    if (c > bestVisible) {
      bestVisible = c;
      bestWords = candidateWords;
      bestPatch = candidate;
    }
  }
  // Final hidden score for the best visible patch.
  const hidden = (await scoreSubstrate(bestWords, hiddenPack)).composite;
  const visibleDelta = Math.round((bestVisible - parentVisible.composite) * 1e6);
  const hiddenDelta = Math.round((hidden - parentHidden.composite) * 1e6);
  console.error(`  hill[${surface}] visibleΔ=${visibleDelta} hiddenΔ=${hiddenDelta}`);
  adversarialTrials.push({ surface, visibleDelta, hiddenDelta });
}

const thresholds = [500, 1000, 2500, 5000];
function sweep(trials, label) {
  return thresholds.map((T) => {
    // False-accept: visible above T but hidden below T
    let fa = 0, fr = 0, tp = 0, tn = 0;
    for (const t of trials) {
      const passVisible = t.visibleDelta >= T;
      const passHidden = t.hiddenDelta >= T;
      if (passVisible && passHidden) tp++;
      else if (passVisible && !passHidden) fa++;
      else if (!passVisible && passHidden) fr++;
      else tn++;
    }
    return { threshold: T, falseAccept: fa, falseReject: fr, truePos: tp, trueNeg: tn };
  });
}

const report = {
  schemaVersion: 'coretex.min-improvement-sweep.v1',
  generatedAt: new Date().toISOString(),
  inputs: {
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    bundleProfile: profilePath ?? null,
    rerankerMode: rerankerArg,
    rerankerModel: reranker.model,
    numPatches,
    hillSteps,
    packSize,
  },
  parent: { visibleComposite: parentVisible.composite, hiddenComposite: parentHidden.composite },
  random: { trials: randomTrials, sweep: sweep(randomTrials, 'random') },
  adversarial: { trials: adversarialTrials, sweep: sweep(adversarialTrials, 'adversarial') },
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[run4-minimp] report → ${reportPath}`);
console.log(`Random sweep:`);
for (const r of report.random.sweep) console.log(`  T=${r.threshold} FA=${r.falseAccept} FR=${r.falseReject} TP=${r.truePos} TN=${r.trueNeg}`);
console.log(`Adversarial (hill-climbed) sweep:`);
for (const r of report.adversarial.sweep) console.log(`  T=${r.threshold} FA=${r.falseAccept} FR=${r.falseReject} TP=${r.truePos} TN=${r.trueNeg}`);
exit(0);
