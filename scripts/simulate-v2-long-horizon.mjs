#!/usr/bin/env node
/**
 * V2 owner-scoped long-horizon harness (Layer 9, items 6+7) — production-faithful.
 *
 * Drives the difficulty controller over the owner-scoped V2 corpus's owner-growth
 * trajectory with REAL scoring, using the PRODUCTION acceptance rule and the
 * SIGNED-profile-derived scoring options (no bespoke opts). Two cleanly-separated
 * populations per epoch:
 *   - HONEST: the positive-control relation-lever patch (+ small variants) from
 *     the current BEST accepted state. Accepted honest patches FEED the controller
 *     (`observedAdvances`) so the RAMP branch is exercised, and update bestState.
 *   - ADVERSARIAL: RANDOM patches (from empty) + HILLCLIMB patches (mutate the
 *     current bestState — an adaptive miner). Acceptance is measured as the
 *     anti-cheat / gameability rate; it does NOT feed the controller.
 *
 * Production acceptance threshold = minImprovementPpm + variancePpm +
 * replayTolerancePpm. Baseline is recomputed on major-delta (owner-growth) epochs.
 *
 * CPU smoke (mechanics; deterministic reranker can't reward routing → honest
 * accepts ~0, but threshold/population/baseline-recompute plumbing is exercised):
 *   node scripts/simulate-v2-long-horizon.mjs --reranker deterministic --epochs 4 \
 *     --random-probes 4 --hillclimb-probes 2 --honest-per-epoch 1
 * A100 real signal:
 *   HF_HUB_CACHE=... CORETEX_RERANKER_PYTHON=/usr/bin/python3 \
 *   node scripts/simulate-v2-long-horizon.mjs --reranker gpu --epochs 12 \
 *     --random-probes 12 --hillclimb-probes 6 --honest-per-epoch 2 --out <dir>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const {
  scoringOptionsFromProfile, deriveQueryPack, evaluateBaseline, evaluateRetrievalBenchmarkPatch,
  applyPatch, merkleizeState, nextMinImprovementPpm, isMajorDelta, createDeterministicReranker,
  encodeRelationCategoryLens, PATCH_TYPE, RANGES, RESERVED_MASKS, MIN_IMPROVEMENT_PPM, MAX_IMPROVEMENT_PPM,
} = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p1-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/p1-embeddings.json');
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-ownerscope-r1.json');
const epochs = Number(flag('epochs', '12'));
const randomProbes = Number(flag('random-probes', '12'));
const hillclimbProbes = Number(flag('hillclimb-probes', '6'));
const honestPerEpoch = Number(flag('honest-per-epoch', '2'));
const baselineSamples = Number(flag('baseline-samples', '1'));
const targetAdvances = Number(flag('target-advances', '2'));
const rerankerArg = flag('reranker', 'deterministic');
const masterSeed = flag('seed', 'v2-lh-2026-05-22');
const ownerFractions = String(flag('owner-fractions', '0.34,0.67,1.0')).split(',').map(Number);
const epochsPerFraction = Number(flag('epochs-per-fraction', String(Math.ceil(epochs / ownerFractions.length))));
// Bounded-run overrides (keep A100 Qwen-pair budget tractable). 0 = use profile.
const packSizeOverride = Number(flag('pack-size', '0'));
const rerankCapOverride = Number(flag('rerank-cap', '0'));
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2');
const START_T = Date.now();

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const { corpus, queryEvents, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const reranker = rerankerArg === 'gpu' || rerankerArg === 'cpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : await createDeterministicReranker();
// CANONICAL: scoring options from the signed profile (no bespoke opts). Bounded-run
// cap override only narrows the reranker pool (compute), not substrate expressivity.
const opts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
if (rerankCapOverride > 0) opts.rerankerInputTopK = rerankCapOverride;
const hiddenPack = packSizeOverride > 0 ? { ...profile.hiddenPack, packSize: packSizeOverride } : profile.hiddenPack;
const replayTol = Number(profile.replayTolerancePpm ?? 250);
const structFloors = {
  structuralFloor: profile.patchAcceptanceFloors.structuralFloor,
  protectedRegressionFloor: -50000, familyCatastrophicFloor: -100000,
};

// owner-growth: activate the first `frac` of owners (deterministic order).
const owners = [...new Set(queryEvents.filter((e) => e.ownerScoped === true && e.ownerEntityId).map((e) => e.ownerEntityId))];
function hseed(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const ownerOrder = [...owners].map((o) => [o, hseed(`${masterSeed}:${o}`)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
// Active subset corpus: eval_hidden restricted to active owners (+ pooled families always on); all mem docs kept.
function activeCorpus(frac) {
  const k = Math.max(1, Math.floor(ownerOrder.length * frac));
  const active = new Set(ownerOrder.slice(0, k));
  const events = corpus.events.filter((e) => e.split !== 'eval_hidden' || e.ownerScoped !== true || active.has(e.ownerEntityId));
  return { ...corpus, events, byId: new Map(events.map((e) => [e.id, e])),
    evalHiddenCount: events.filter((e) => e.split === 'eval_hidden').length };
}

// ── patches ──
const empty = () => ({ words: new Array(1024).fill(0n) });
function positiveControlPatch(state) { const indices = [], newWords = []; ['supports', 'causes', 'supersedes', 'coreference_of'].forEach((et, i) => { indices.push(RANGES.RELATIONS_START + (128 - 1 - i)); newWords.push(encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: et, weight: 0x8000 })); }); return { patchType: PATCH_TYPE.MIXED, wordCount: 4, scoreDelta: 0n, parentStateRoot: merkleizeState(state), indices, newWords }; }
function mulberry32(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function randomWord(rand, mask) { let v = 0n; for (let i = 0; i < 4; i++) v = (v << 64n) | (BigInt(Math.floor(rand() * 0x100000000)) << 32n) | BigInt(Math.floor(rand() * 0x100000000)); return v & (~mask); }
function randomPatch(state, rand) { const n = 1 + Math.floor(rand() * 4); const used = new Set(); const indices = [], newWords = []; while (indices.length < n) { const idx = Math.floor(rand() * RANGES.WORD_COUNT); if (used.has(idx)) continue; used.add(idx); const mask = RESERVED_MASKS[idx] ?? 0n; let w = randomWord(rand, mask); if (w === (state.words[idx] ?? 0n)) w = (w + 1n) & (~mask); indices.push(idx); newWords.push(w); } return { patchType: PATCH_TYPE.MIXED, wordCount: n, scoreDelta: 0n, parentStateRoot: merkleizeState(state), indices, newWords }; }

async function evalPatch(state, patch, corpus_, pack, acceptanceThresholdPpm, minImprovementPpm) {
  return evaluateRetrievalBenchmarkPatch(state, patch, corpus_, pack, opts, { ...structFloors, minImprovementPpm, acceptanceThresholdPpm });
}

let current = BigInt(Number(profile.patchAcceptanceFloors.minImprovementPpm) || 5000);
let bestState = empty();
let prevEH = 0, clampHits = 0, maxClampWhileAdvancing = 0, baselineRecomputes = 0;
let cachedVariance = null, cachedFrac = null;
const rows = [];
console.error(`[v2-lh] corpus=${corpus.events.length} evt, scopedOwners=${owners.length}, reranker=${rerankerArg}, profile=${profilePath}, epochs=${epochs}`);
for (let epoch = 1; epoch <= epochs; epoch++) {
  const fracIdx = Math.min(ownerFractions.length - 1, Math.floor((epoch - 1) / Math.max(1, epochsPerFraction)));
  const frac = ownerFractions[fracIdx] ?? 1;
  const ac = activeCorpus(frac);
  const majorDeltaActive = isMajorDelta(ac.evalHiddenCount, prevEH, Number(profile.majorDeltaThreshold ?? 0.1)); prevEH = ac.evalHiddenCount;
  const seedHex = '0x' + createHash('sha256').update(`${masterSeed}:${epoch}`).digest('hex');
  const pack = deriveQueryPack(epoch, seedHex, ac, hiddenPack);

  // Baseline + variance: recompute on first epoch or major-delta (owner-growth).
  if (cachedVariance === null || majorDeltaActive || frac !== cachedFrac) {
    const base = await evaluateBaseline(bestState, ac, pack, opts, { samples: baselineSamples });
    cachedVariance = base.variancePpm; cachedFrac = frac; baselineRecomputes++;
  }
  const acceptanceThresholdPpm = Number(current) + cachedVariance + replayTol;

  // HONEST population: positive-control lever (+ variants) from bestState. Major-delta
  // epochs are a controller grace freeze, but we still measure advances honestly.
  let honestAccepts = 0, honestAttempts = 0; let pcDelta = null;
  for (let h = 0; h < honestPerEpoch; h++) {
    const r = await evalPatch(bestState, positiveControlPatch(bestState), ac, pack, acceptanceThresholdPpm, Number(current));
    honestAttempts++; if (h === 0) pcDelta = r.deltaPpm;
    if (r.accepted) { honestAccepts++; const ap = applyPatch(bestState, positiveControlPatch(bestState)); if (ap.ok) bestState = ap.state; }
  }

  // ADVERSARIAL population: random (from empty) + hillclimb (mutate bestState).
  const rand = mulberry32(hseed(`${masterSeed}:adv:${epoch}`));
  let randAccepts = 0, hillAccepts = 0; const randDeltas = [], hillDeltas = [];
  for (let i = 0; i < randomProbes; i++) { const r = await evalPatch(empty(), randomPatch(empty(), rand), ac, pack, acceptanceThresholdPpm, Number(current)); randDeltas.push(r.deltaPpm); if (r.accepted) randAccepts++; }
  for (let i = 0; i < hillclimbProbes; i++) { const r = await evalPatch(bestState, randomPatch(bestState, rand), ac, pack, acceptanceThresholdPpm, Number(current)); hillDeltas.push(r.deltaPpm); if (r.accepted) hillAccepts++; }

  // Controller: ONLY honest advances feed observedAdvances.
  const d = nextMinImprovementPpm({ current, observedAdvances: honestAccepts, targetAdvances, qualityAttempts: honestAttempts, majorDeltaActive });
  if (d.clamped) clampHits++;
  if (Number(d.next) === Number(MAX_IMPROVEMENT_PPM) && honestAccepts > targetAdvances) maxClampWhileAdvancing++;
  rows.push({ epoch, ownerFraction: frac, activeEvalHidden: ac.evalHiddenCount, majorDeltaActive, packN: pack.events.length,
    acceptanceThresholdPpm, variancePpm: cachedVariance,
    honestAccepts, honestAttempts, positiveControlDeltaPpm: pcDelta,
    randomProbes, randomAccepts: randAccepts, randomAcceptanceRate: +(randAccepts / Math.max(1, randomProbes)).toFixed(4), randomDeltaPpmMax: randDeltas.length ? Math.max(...randDeltas) : null,
    hillclimbProbes, hillclimbAccepts: hillAccepts, hillclimbAcceptanceRate: +(hillAccepts / Math.max(1, hillclimbProbes)).toFixed(4), hillclimbDeltaPpmMax: hillDeltas.length ? Math.max(...hillDeltas) : null,
    minImprBefore: Number(current), minImprAfter: Number(d.next), reason: d.reason });
  current = d.next;
  console.error(`[v2-lh] ep ${epoch}/${epochs} frac=${frac} packN=${pack.events.length} thr=${acceptanceThresholdPpm} | honest ${honestAccepts}/${honestAttempts}(Δ${pcDelta}) rand ${randAccepts}/${randomProbes} hill ${hillAccepts}/${hillclimbProbes} | minImpr ${Number(current === d.next ? rows.at(-1).minImprBefore : current)}→${rows.at(-1).minImprAfter} [${d.reason}]`);
}
const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/cortex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const out = {
  generatedAt: new Date().toISOString(),
  provenance: { corpus: corpusPath, corpusRoot: corpus.corpusRoot, profile: profilePath, gitSha, distHashRetrievalBenchmark: distHash, dirtyTree,
    reranker: rerankerArg === 'gpu' || rerankerArg === 'cpu' ? `Qwen/Qwen3-Reranker-0.6B@${RR.revision} (${rerankerArg})` : 'deterministic-stub',
    seed: masterSeed, replayTolerancePpm: replayTol, clampBounds: { minPpm: Number(MIN_IMPROVEMENT_PPM), maxPpm: Number(MAX_IMPROVEMENT_PPM) },
    acceptanceRule: 'delta > minImprovementPpm + variancePpm + replayTolerancePpm' },
  summary: {
    epochs, scopedOwners: owners.length, baselineRecomputes,
    honestAcceptedEpochs: rows.filter((r) => r.honestAccepts > 0).length,
    meanRandomAcceptanceRate: +mean(rows.map((r) => r.randomAcceptanceRate)).toFixed(4),
    maxRandomAcceptanceRate: Math.max(...rows.map((r) => r.randomAcceptanceRate)),
    meanHillclimbAcceptanceRate: +mean(rows.map((r) => r.hillclimbAcceptanceRate)).toFixed(4),
    maxHillclimbAcceptanceRate: Math.max(...rows.map((r) => r.hillclimbAcceptanceRate)),
    clampHits, plateauRiskAtMax: maxClampWhileAdvancing,
    minImprFirst: rows[0]?.minImprBefore, minImprLast: rows.at(-1)?.minImprAfter,
    approxQwenPairs: rows.reduce((s, r) => s + r.packN * opts.rerankerInputTopK * 2 * (r.honestAttempts + r.randomProbes + r.hillclimbProbes + 1), 0),
    wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1),
    // EVIDENCE (not launch proof): anti-cheat = random+hillclimb acceptance ~0;
    // advance signal = honest accepts present; plateau = MAX-clamp-while-advancing.
    antiCheatCleanRandom: mean(rows.map((r) => r.randomAcceptanceRate)) <= 0.01,
    antiCheatCleanHillclimb: mean(rows.map((r) => r.hillclimbAcceptanceRate)) <= 0.01,
    advanceSignalPresent: rows.some((r) => r.honestAccepts > 0),
  },
  epochs: rows,
};
const suffix = rerankerArg === 'gpu' || rerankerArg === 'cpu' ? 'qwen' : 'det';
mkdirSync(resolve(outDir), { recursive: true });
const path = resolve(outDir, `V2_LONG_HORIZON_${(profile.name || 'p').toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${suffix}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log(`wrote ${path}`);
if (typeof reranker.close === 'function') reranker.close();
