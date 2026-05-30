#!/usr/bin/env node
/**
 * CoreTex-only screener threshold calibration. NOT the miner / V4 / wallet / chain harness.
 *
 * Goal: measure how cleanly the canonical screener threshold separates the patch classes the
 * launch contract cares about — junk, structurally-valid-irrelevant, exact-duplicate,
 * near-duplicate, stale-parent, weak-positive, viable-non-advancing, true-state-advance.
 *
 * Uses ONLY canonical CoreTex exports:
 *   evaluateRetrievalBenchmarkPatch — applies + scores a patch against a (corpus, pack) pair
 *   computeCoreTexScreenerThresholdPpm — derives the screener threshold from baseline + noise floor
 *   evaluateCoreTexWorkQualification — classifies an outcome as REJECT / SCREENER_PASS / STATE_ADVANCE
 *
 * Real Qwen via canonical streaming reranker (--reranker gpu). No miner driver, no V4, no chain.
 *
 * Output report:
 *   threshold inputs:    baseline, recentNoiseFloorPpm, replayTolerancePpm, minImprovementPpm, screenerThresholdPpm, minStateAdvancePpm
 *   per class:           n, mean deltaPpm, p10/p50/p90 deltaPpm, outcomeCounts {REJECT, SCREENER_PASS, STATE_ADVANCE}
 *   summary metrics:     false_screener_rate_by_class, viable_screener_recall, true_advance_as_screener_count,
 *                        state_advance_acceptance_rate, duplicate_stale_rejection_rate, junk_rejection_rate
 *
 * Usage:
 *   node scripts/screener-threshold-calibration.mjs --reranker gpu
 *     --profile <p> --bundle <b> --corpus <c> --emb <e> --out <outfile>
 *     [--per-class 8] [--pack-size 64] [--clear-pack-quotas]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, env, exit } from 'node:process';
import { createHash } from 'node:crypto';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const C = await import(distIndex);
const {
  RANGES, PATCH_TYPE,
  buildBundleManifest, verifyBundleManifest,
  evaluateRetrievalBenchmarkPatch,
  computeCoreTexScreenerThresholdPpm, evaluateCoreTexWorkQualification, DEFAULT_CORETEX_WORK_POLICY,
  scoringOptionsFromProfile, deriveQueryPack, biEncoderModelIdHash,
  createDeterministicReranker,
  encodePolicyAtom, POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE,
} = C;

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const RERANKER = flag('reranker', 'gpu');
const PROFILE_PATH = flag('profile');
const BUNDLE_PATH = flag('bundle');
const CORPUS_PATH = flag('corpus');
const EMB_PATH = flag('emb');
const OUT_PATH = flag('out');
const PER_CLASS = Number(flag('per-class', '8'));
const PACK_SIZE = Number(flag('pack-size', '64'));
const CLEAR_PACK_QUOTAS = has('clear-pack-quotas');

if (!PROFILE_PATH || !BUNDLE_PATH || !CORPUS_PATH || !EMB_PATH || !OUT_PATH) {
  console.error('HARD FAIL: --profile, --bundle, --corpus, --emb, --out required');
  exit(1);
}

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
const bundle = JSON.parse(readFileSync(resolve(repoRoot, BUNDLE_PATH), 'utf8'));
const verr = verifyBundleManifest(bundle, repoRoot);
if (verr.length > 0) { console.error('HARD FAIL: bundle verify dirty:', verr.join('; ')); exit(1); }

console.log('[screener-threshold] building production corpus ...');
const { corpus, BE, RR, LAYOUT } = buildV2ProductionCorpus({ corpusPath: CORPUS_PATH, embPath: EMB_PATH, bundlePath: BUNDLE_PATH });
console.log(`[screener-threshold] corpus root=${corpus.corpusRoot.slice(0, 18)}… events=${corpus.events.length}`);

const evalSeedHex = profile.baselineEvalSeedHex ?? '0x' + 'a5'.repeat(32);
const hiddenPack = CLEAR_PACK_QUOTAS ? { packSize: PACK_SIZE, quotas: [] } : { ...(profile.hiddenPack ?? { packSize: PACK_SIZE, quotas: [] }), packSize: PACK_SIZE };
const pack = deriveQueryPack(0, evalSeedHex, corpus, hiddenPack);
console.log(`[screener-threshold] hidden pack derived: ${pack.events.length} events`);

const reranker = RERANKER === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const opts = scoringOptionsFromProfile(profile, rt);
const floors = { ...profile.patchAcceptanceFloors, acceptanceThresholdPpm: profile.patchAcceptanceFloors?.minImprovementPpm ?? 2500 };

// ─── Threshold inputs (canonical) ───
const baseline = BigInt(profile.baselineParentScorePpm ?? 0);
const recentNoise = 0n; // first cut: no measured noise floor; canonical formula uses minDelta and headroom
const screenerThresholdPpm = computeCoreTexScreenerThresholdPpm({ baselineScorePpm: baseline, recentNoiseFloorPpm: recentNoise });
// In the canonical policy the SCREENER_PASS vs STATE_ADVANCE distinction is the outcome STRING
// the submitter declares (+ a liveStateAdvance flag), NOT a delta band; both share the same
// minDeterministic floor (max(stateAdvance.minDeterministicDeltaPpm=1ppm, screenerThreshold)).
// For threshold-CALIBRATION we want a delta band so the report shows where each patch class
// lands; we use profile.patchAcceptanceFloors.minImprovementPpm (the operator-pinned
// "meaningful improvement" floor for this corpus) as the SCREENER_PASS → STATE_ADVANCE band.
const minStateAdvancePpm = BigInt(profile.patchAcceptanceFloors?.minImprovementPpm ?? 2500);
console.log(`[screener-threshold] baseline=${baseline}ppm screenerThreshold=${screenerThresholdPpm}ppm stateAdvanceBand>=${minStateAdvancePpm}ppm (profile.minImprovementPpm)`);

// ─── Patch generators (each returns {patch, intent}) ───
const zero = () => ({ words: new Array(1024).fill(0n) });
const parentRoot = new Uint8Array(32); // genesis: stateRoot = 0x00... (replay tolerance handles parent identity for synthetic class probes)
const u64 = (n) => BigInt.asUintN(64, BigInt(n));

function patchJunk(seed) {
  // junk: random bytes in random-but-valid wordCount range; classifier expects this to land at delta≈0 or apply_failed.
  const h = createHash('sha256').update(`junk:${seed}`).digest();
  const idx = RANGES.MEMORY_INDEX_START + (h[0] % (RANGES.MEMORY_INDEX_END - RANGES.MEMORY_INDEX_START));
  const word = BigInt.asUintN(64, BigInt('0x' + h.toString('hex').slice(0, 16)));
  return { patch: { patchType: PATCH_TYPE.SLOT_REPLACE, wordCount: 1, scoreDelta: 0, parentStateRoot: parentRoot, indices: [idx], newWords: [word] }, intent: 'junk_random_word' };
}
function patchStructValidIrrelevant(seed) {
  // structurally valid (POLICY_UPDATE with a real PolicyAtom that targets nothing useful) — no scoring lift expected.
  const word = encodePolicyAtom({ atomIndex: 0, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'bundle', scope: 'relation_path',
    targetSlot: 200, budget: 1, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
  const idx = RANGES.POLICY_EVIDENCE_START;
  return { patch: { patchType: PATCH_TYPE.POLICY_UPDATE, wordCount: 1, scoreDelta: 0, parentStateRoot: parentRoot, indices: [idx], newWords: [word] }, intent: 'structurally_valid_irrelevant' };
}
function patchExactDuplicate() {
  // identical to the structurally-valid-irrelevant patch — same bytes, same hash.
  return { ...patchStructValidIrrelevant(0), intent: 'exact_duplicate' };
}
function patchNearDuplicate(seed) {
  // PolicyAtom with one bit flipped — same intent, different bytes/hash.
  const base = patchStructValidIrrelevant(seed).patch;
  const w = base.newWords[0] ^ 1n;
  return { patch: { ...base, newWords: [w] }, intent: 'near_duplicate' };
}
function patchStaleParent(seed) {
  // valid patch shape but parentStateRoot doesn't match genesis — emulates a stale-parent submit.
  const p = patchStructValidIrrelevant(seed).patch;
  const wrongParent = createHash('sha256').update(`stale:${seed}`).digest();
  return { patch: { ...p, parentStateRoot: new Uint8Array(wrongParent) }, intent: 'stale_parent' };
}
function patchWeakPositive(seed) {
  // a real reclaimed-substrate touch: relation-typed admission atom targeting an existing MemoryIndex
  // slot. Expected delta: small, often below screener threshold on the calibration corpus.
  const slot = 5 + (seed % 10);
  const word = encodePolicyAtom({ atomIndex: 1, family: 'evidence_bundle', selector: POLICY_SELECTOR.RELATION_PATH_PRESENT,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'bundle', scope: 'relation_path',
    targetSlot: slot, budget: 50, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
  return { patch: { patchType: PATCH_TYPE.POLICY_UPDATE, wordCount: 1, scoreDelta: 0, parentStateRoot: parentRoot, indices: [RANGES.POLICY_EVIDENCE_START + 1], newWords: [word] }, intent: 'weak_positive_candidate' };
}
function patchViableNonAdvancing(seed) {
  // a temporal-currency MemoryIndex touch — historically a meaningful signal but not a state advance on its own.
  const slot = 32 + (seed % 16);
  const w = u64(0x1n << 60n) | u64(seed); // a non-zero MemoryIndex word
  return { patch: { patchType: PATCH_TYPE.SLOT_REPLACE, wordCount: 1, scoreDelta: 0, parentStateRoot: parentRoot, indices: [slot], newWords: [w] }, intent: 'viable_non_advancing' };
}
function patchTrueAdvanceCandidate(seed) {
  // best-known live surface: relation-typed admission + a temporal pair companion (MIXED).
  // Whether this lands as STATE_ADVANCE is the calibration question; classifier output is the truth.
  const word = encodePolicyAtom({ atomIndex: 0, family: 'evidence_bundle', selector: POLICY_SELECTOR.RELATION_PATH_PRESENT,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'bundle', scope: 'relation_path',
    targetSlot: 5 + (seed % 10), budget: 250, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
  const anchorIdx = RANGES.MEMORY_INDEX_START + 5 + (seed % 10);
  const anchorWord = u64(0x1n << 63n) | u64(seed * 7);
  return { patch: { patchType: PATCH_TYPE.MIXED, wordCount: 2, scoreDelta: 0, parentStateRoot: parentRoot, indices: [anchorIdx, RANGES.POLICY_EVIDENCE_START], newWords: [anchorWord, word] }, intent: 'true_state_advance_candidate' };
}

const classes = [
  { name: 'junk_random', gen: patchJunk, expected: 'REJECT' },
  { name: 'structurally_valid_irrelevant', gen: patchStructValidIrrelevant, expected: 'REJECT' },
  { name: 'exact_duplicate', gen: patchExactDuplicate, expected: 'REJECT' },
  { name: 'near_duplicate', gen: patchNearDuplicate, expected: 'REJECT' },
  { name: 'stale_parent', gen: patchStaleParent, expected: 'REJECT' },
  { name: 'weak_positive', gen: patchWeakPositive, expected: 'REJECT_or_SCREENER_PASS' },
  { name: 'viable_non_advancing', gen: patchViableNonAdvancing, expected: 'SCREENER_PASS' },
  { name: 'true_state_advance_candidate', gen: patchTrueAdvanceCandidate, expected: 'STATE_ADVANCE_or_SCREENER_PASS' },
];

function classifyOutcome(deltaPpm, accepted) {
  if (!accepted) return 'REJECT';
  if (BigInt(deltaPpm) < screenerThresholdPpm) return 'REJECT';
  if (BigInt(deltaPpm) < minStateAdvancePpm) return 'SCREENER_PASS';
  return 'STATE_ADVANCE';
}

function pctile(arr, p) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); const i = Math.min(a.length - 1, Math.floor((p / 100) * a.length)); return a[i]; }

const results = [];
for (const cls of classes) {
  console.log(`[screener-threshold] class=${cls.name} (n=${PER_CLASS}) ...`);
  const perPatchOutcomes = [];
  for (let i = 0; i < PER_CLASS; i++) {
    const { patch, intent } = cls.gen(i);
    let outcome, deltaPpm, reason = null;
    try {
      const r = await evaluateRetrievalBenchmarkPatch(zero(), patch, corpus, pack, opts, floors);
      deltaPpm = r.deltaPpm ?? 0;
      outcome = classifyOutcome(deltaPpm, r.accepted);
      if (!r.accepted) reason = r.reason;
    } catch (e) {
      outcome = 'REJECT';
      deltaPpm = 0;
      reason = `eval_error:${e.message?.slice(0, 80) ?? 'unknown'}`;
    }
    // Cheap structural fingerprint for the per-patch row (not the canonical computePatchHash,
    // which needs serialized normalizedPatchBytes; that lives downstream in screener submit).
    const fingerprintBytes = `${patch.patchType}|${patch.indices.join(',')}|${patch.newWords.map((w) => w.toString(16)).join(',')}`;
    const patchFp = '0x' + createHash('sha256').update(fingerprintBytes).digest('hex').slice(0, 16);
    perPatchOutcomes.push({ i, deltaPpm, outcome, reason, intent, patchFingerprint: patchFp });
  }
  const deltas = perPatchOutcomes.map((p) => p.deltaPpm);
  const outcomeCounts = { REJECT: 0, SCREENER_PASS: 0, STATE_ADVANCE: 0 };
  for (const p of perPatchOutcomes) outcomeCounts[p.outcome]++;
  results.push({ class: cls.name, expected: cls.expected, n: PER_CLASS,
    deltaPpm: { mean: deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length), p10: pctile(deltas, 10), p50: pctile(deltas, 50), p90: pctile(deltas, 90), min: Math.min(...deltas), max: Math.max(...deltas) },
    outcomeCounts, perPatch: perPatchOutcomes });
}

// ─── Summary metrics ───
const summary = {
  threshold_inputs: {
    baselineParentScorePpm: Number(baseline),
    recentNoiseFloorPpm: Number(recentNoise),
    minImprovementPpm: profile.patchAcceptanceFloors?.minImprovementPpm,
    replayTolerancePpm: profile.replayTolerancePpm,
    screenerThresholdPpm: Number(screenerThresholdPpm),
    minStateAdvancePpm: Number(minStateAdvancePpm),
  },
  per_class: Object.fromEntries(results.map((r) => [r.class, { mean_delta_ppm: Math.round(r.deltaPpm.mean), outcomes: r.outcomeCounts, expected: r.expected }])),
  false_screener_rate_by_class: Object.fromEntries(results.map((r) => {
    if (!r.expected.startsWith('REJECT')) return [r.class, null];
    const wronglyPassed = r.outcomeCounts.SCREENER_PASS + r.outcomeCounts.STATE_ADVANCE;
    return [r.class, wronglyPassed / r.n];
  })),
  viable_screener_recall: (() => {
    const v = results.find((r) => r.class === 'viable_non_advancing');
    return v ? (v.outcomeCounts.SCREENER_PASS + v.outcomeCounts.STATE_ADVANCE) / v.n : null;
  })(),
  true_advance_as_screener_count: (() => {
    const t = results.find((r) => r.class === 'true_state_advance_candidate');
    return t ? t.outcomeCounts.SCREENER_PASS : null;
  })(),
  state_advance_acceptance_rate: (() => {
    const t = results.find((r) => r.class === 'true_state_advance_candidate');
    return t ? t.outcomeCounts.STATE_ADVANCE / t.n : null;
  })(),
  duplicate_stale_rejection_rate: (() => {
    const sub = results.filter((r) => ['exact_duplicate', 'near_duplicate', 'stale_parent'].includes(r.class));
    if (!sub.length) return null;
    const total = sub.reduce((a, r) => a + r.n, 0);
    const rej = sub.reduce((a, r) => a + r.outcomeCounts.REJECT, 0);
    return rej / total;
  })(),
  junk_rejection_rate: (() => {
    const sub = results.filter((r) => ['junk_random', 'structurally_valid_irrelevant'].includes(r.class));
    if (!sub.length) return null;
    const total = sub.reduce((a, r) => a + r.n, 0);
    const rej = sub.reduce((a, r) => a + r.outcomeCounts.REJECT, 0);
    return rej / total;
  })(),
};

const report = {
  schema: 'coretex.screener-threshold-calibration.v1',
  reranker: RERANKER === 'gpu' ? `Qwen/${RR.modelId}@${RR.revision}` : 'deterministic',
  profile: PROFILE_PATH, bundle: BUNDLE_PATH, corpus: CORPUS_PATH, embeddings: EMB_PATH,
  bundleHash: bundle.bundleHash, corpusRoot: corpus.corpusRoot,
  per_class_results: results,
  summary,
};
mkdirSync(dirname(resolve(repoRoot, OUT_PATH)), { recursive: true });
writeFileSync(resolve(repoRoot, OUT_PATH), JSON.stringify(report, null, 2));
console.log(`\n[screener-threshold] wrote ${OUT_PATH}`);
console.log(JSON.stringify({ summary }, null, 2));

await reranker.close?.();
exit(0);
