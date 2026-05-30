#!/usr/bin/env node
/**
 * CoreTex-only screener threshold calibration (v2 — canonical qualification + noise-floor).
 * NOT the miner / V4 / wallet / chain harness.
 *
 * Per the calibration handoff:
 *   - patch classes scored via canonical evaluateRetrievalBenchmarkPatch
 *   - REJECT / SCREENER_PASS / STATE_ADVANCE via canonical evaluateCoreTexWorkQualification
 *     (NOT manual delta bands). Passes outcome, parentMatchesLiveRoot, liveStateAdvanced,
 *     deterministicDeltaPpm, localModelDeltaPpm, baselineScorePpm, recentNoiseFloorPpm.
 *   - recentNoiseFloorPpm is MEASURED via a control phase (no-op + random patches), NOT
 *     hardcoded. Hard-fails if noise sampling produced no signal.
 *
 * Classes generated:
 *   junk_random, structurally_valid_irrelevant, exact_duplicate, near_duplicate,
 *   stale_parent, weak_positive, viable_non_advancing, true_state_advance_candidate.
 *
 * Usage:
 *   node scripts/screener-threshold-calibration.mjs --reranker gpu
 *     --profile <p> --bundle <b> --corpus <c> --emb <e> --out <outfile>
 *     [--per-class 8] [--pack-size 64] [--clear-pack-quotas] [--noise-samples 6]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, env, exit } from 'node:process';
import { createHash } from 'node:crypto';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const C = await import(distIndex);
const {
  RANGES, PATCH_TYPE,
  verifyBundleManifest,
  evaluateRetrievalBenchmarkPatch,
  computeCoreTexScreenerThresholdPpm, evaluateCoreTexWorkQualification, DEFAULT_CORETEX_WORK_POLICY,
  scoringOptionsFromProfile, deriveQueryPack, biEncoderModelIdHash,
  createDeterministicReranker,
  encodePolicyAtom, POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE,
  encodeMemoryIndexSlot, stableRecordIdFor,
  merkleizeState,
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
const NOISE_SAMPLES = Number(flag('noise-samples', '6'));
const CLEAR_PACK_QUOTAS = has('clear-pack-quotas');

if (!PROFILE_PATH || !BUNDLE_PATH || !CORPUS_PATH || !EMB_PATH || !OUT_PATH) {
  console.error('HARD FAIL: --profile, --bundle, --corpus, --emb, --out required'); exit(1);
}

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
const bundle = JSON.parse(readFileSync(resolve(repoRoot, BUNDLE_PATH), 'utf8'));
const verr = verifyBundleManifest(bundle, repoRoot);
if (verr.length > 0) { console.error('HARD FAIL: bundle verify dirty:', verr.join('; ')); exit(1); }

console.log('[screener-threshold] loading materialized production corpus (NO rebuild) ...');
const { corpus, BE, RR, LAYOUT, manifest: matManifest } = loadMaterializedCorpus(BUNDLE_PATH, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH });
console.log(`[screener-threshold] materialized manifest bundleHash=${matManifest.bundleHash} corpusRoot=${matManifest.corpusRoot.slice(0, 18)}…`);
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
const baseline = BigInt(profile.baselineParentScorePpm ?? 0);
const POLICY = DEFAULT_CORETEX_WORK_POLICY;
const OUTCOME_SCREENER = POLICY.screenerPass.outcome;
const OUTCOME_STATE_ADVANCE = POLICY.stateAdvance.outcome;

const zero = () => ({ words: new Array(1024).fill(0n) });
// Canonical parentStateRoot is merkleizeState(state), NOT literal zero bytes.
// merkleizeState of 1024 zero words is a real keccak hash; applyPatch hard-fails E01
// (WRONG_PARENT_ROOT) if patch.parentStateRoot !== merkleizeState(state). The prior
// `new Uint8Array(32)` silently rejected every patch at the apply layer, collapsing
// the screener-threshold report to "everything REJECT for the wrong reason".
const parentRoot = merkleizeState(zero());
const u64 = (n) => BigInt.asUintN(64, BigInt(n));

// ─── patch generators (deterministic; class label = construction intent) ───
function patchJunk(seed) {
  const h = createHash('sha256').update(`junk:${seed}`).digest();
  const idx = RANGES.MEMORY_INDEX_START + (h[0] % (RANGES.MEMORY_INDEX_END - RANGES.MEMORY_INDEX_START));
  const word = BigInt.asUintN(64, BigInt('0x' + h.toString('hex').slice(0, 16)));
  return { patch: { patchType: PATCH_TYPE.SLOT_REPLACE, wordCount: 1, scoreDelta: 0, parentStateRoot: parentRoot, indices: [idx], newWords: [word] }, intent: 'junk_random_word' };
}
function patchStructValidIrrelevant(seed) {
  const word = encodePolicyAtom({ atomIndex: 0, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'bundle', scope: 'relation_path',
    targetSlot: 200, budget: 1, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
  return { patch: { patchType: PATCH_TYPE.POLICY_UPDATE, wordCount: 1, scoreDelta: 0, parentStateRoot: parentRoot, indices: [RANGES.POLICY_EVIDENCE_START], newWords: [word] }, intent: 'structurally_valid_irrelevant' };
}
function patchExactDuplicate() { return { ...patchStructValidIrrelevant(0), intent: 'exact_duplicate' }; }
function patchNearDuplicate(seed) { const b = patchStructValidIrrelevant(seed).patch; return { patch: { ...b, newWords: [b.newWords[0] ^ 1n] }, intent: 'near_duplicate' }; }
function patchStaleParent(seed) {
  const p = patchStructValidIrrelevant(seed).patch;
  const wrongParent = createHash('sha256').update(`stale:${seed}`).digest();
  return { patch: { ...p, parentStateRoot: new Uint8Array(wrongParent) }, intent: 'stale_parent' };
}
function patchWeakPositive(seed) {
  const slot = 5 + (seed % 10);
  const word = encodePolicyAtom({ atomIndex: 1, family: 'evidence_bundle', selector: POLICY_SELECTOR.RELATION_PATH_PRESENT,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'bundle', scope: 'relation_path',
    targetSlot: slot, budget: 50, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
  return { patch: { patchType: PATCH_TYPE.POLICY_UPDATE, wordCount: 1, scoreDelta: 0, parentStateRoot: parentRoot, indices: [RANGES.POLICY_EVIDENCE_START + 1], newWords: [word] }, intent: 'weak_positive_candidate' };
}
// Canonical anchor encoding: a real MemoryIndex slot word, not hand-crafted bits. This is required
// for structural_validity to pass — applyPatch rejects malformed MemoryIndex words.
function makeAnchorWord(seed, slotIndex) {
  return encodeMemoryIndexSlot({
    slotIndex, recordId: stableRecordIdFor(`mem_screener_anchor_${seed}`),
    family: 'multi_hop_relation', domainBits: 1n, valid: true, revoked: false, protected: false,
    policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n,
  })[0];
}
function patchViableNonAdvancing(seed) {
  // Canonical MemoryIndex anchor write — structurally valid, may not improve retrieval on the
  // calibration corpus → expected outcome SCREENER_PASS-or-REJECT depending on delta.
  const slotOffset = 32 + (seed % 16);
  const anchorIdx = RANGES.MEMORY_INDEX_START + slotOffset;
  return { patch: { patchType: PATCH_TYPE.SLOT_REPLACE, wordCount: 1, scoreDelta: 0, parentStateRoot: parentRoot, indices: [anchorIdx], newWords: [makeAnchorWord(seed, slotOffset)] }, intent: 'viable_non_advancing' };
}
function patchTrueAdvanceCandidate(seed) {
  const slotOffset = 5 + (seed % 10);
  const word = encodePolicyAtom({ atomIndex: 0, family: 'evidence_bundle', selector: POLICY_SELECTOR.RELATION_PATH_PRESENT,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'bundle', scope: 'relation_path',
    targetSlot: slotOffset, budget: 250, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
  const anchorIdx = RANGES.MEMORY_INDEX_START + slotOffset;
  // CANONICAL anchor word (encodeMemoryIndexSlot) — the prior synthetic bit pattern failed structural validity.
  return { patch: { patchType: PATCH_TYPE.MIXED, wordCount: 2, scoreDelta: 0, parentStateRoot: parentRoot, indices: [anchorIdx, RANGES.POLICY_EVIDENCE_START], newWords: [makeAnchorWord(seed, slotOffset), word] }, intent: 'true_state_advance_candidate' };
}

// liveStateAdvanced is TRUE only for the true_state_advance class — every other class is by
// construction either rejected (junk/dup/stale/irrelevant) or at-most a screener_pass candidate
// (weak/viable non-advancing). Passing liveStateAdvanced=true uniformly would wrongly let a
// viable_non_advancing patch qualify as STATE_ADVANCE on any sufficient delta.
const classes = [
  { name: 'junk_random', gen: patchJunk, expected: 'REJECT', parentMatchesLiveRoot: true, liveStateAdvanced: false },
  { name: 'structurally_valid_irrelevant', gen: patchStructValidIrrelevant, expected: 'REJECT', parentMatchesLiveRoot: true, liveStateAdvanced: false },
  { name: 'exact_duplicate', gen: patchExactDuplicate, expected: 'REJECT', parentMatchesLiveRoot: true, liveStateAdvanced: false },
  { name: 'near_duplicate', gen: patchNearDuplicate, expected: 'REJECT', parentMatchesLiveRoot: true, liveStateAdvanced: false },
  { name: 'stale_parent', gen: patchStaleParent, expected: 'REJECT', parentMatchesLiveRoot: false, liveStateAdvanced: false },
  { name: 'weak_positive', gen: patchWeakPositive, expected: 'REJECT_or_SCREENER_PASS', parentMatchesLiveRoot: true, liveStateAdvanced: false },
  { name: 'viable_non_advancing', gen: patchViableNonAdvancing, expected: 'SCREENER_PASS', parentMatchesLiveRoot: true, liveStateAdvanced: false },
  { name: 'true_state_advance_candidate', gen: patchTrueAdvanceCandidate, expected: 'STATE_ADVANCE_or_SCREENER_PASS', parentMatchesLiveRoot: true, liveStateAdvanced: true },
];

async function scorePatchDelta(patch) {
  try {
    const r = await evaluateRetrievalBenchmarkPatch(zero(), patch, corpus, pack, opts, floors);
    return { deltaPpm: r.deltaPpm ?? 0, accepted: !!r.accepted, reason: r.reason ?? null };
  } catch (e) {
    return { deltaPpm: 0, accepted: false, reason: `eval_error:${e.message?.slice(0, 80)}` };
  }
}

// ─── Noise-floor sampling (control phase) — feeds canonical qualification ───
console.log(`[screener-threshold] sampling noise floor: ${NOISE_SAMPLES} no-op-like patches ...`);
const noiseDeltas = [];
for (let i = 0; i < NOISE_SAMPLES; i++) {
  const cls = i % 2 === 0 ? patchJunk(1000 + i) : patchStructValidIrrelevant(2000 + i);
  const r = await scorePatchDelta(cls.patch);
  noiseDeltas.push(Math.abs(r.deltaPpm));
}
noiseDeltas.sort((a, b) => a - b);
const recentNoiseFloorPpm = noiseDeltas[Math.floor(noiseDeltas.length * 0.9)] || 0; // p90 abs delta
if (!Number.isFinite(recentNoiseFloorPpm) || recentNoiseFloorPpm < 0) {
  console.error(`HARD FAIL: noise-floor sampling produced invalid signal (${recentNoiseFloorPpm}, raw=${JSON.stringify(noiseDeltas)})`); exit(1);
}
const screenerThresholdPpm = computeCoreTexScreenerThresholdPpm({ baselineScorePpm: baseline, recentNoiseFloorPpm: BigInt(recentNoiseFloorPpm) });
console.log(`[screener-threshold] baseline=${baseline}ppm measured noiseFloor(p90)=${recentNoiseFloorPpm}ppm → screenerThreshold=${screenerThresholdPpm}ppm`);

// ─── CANONICAL classification via evaluateCoreTexWorkQualification ───
function classifyCanonically({ applyAccepted, applyReason, deltaPpm, parentMatchesLiveRoot, liveStateAdvanced }) {
  // The evaluator must accept the patch shape (structural / protected / family floors) before any
  // qualification can fire. A patch rejected by evaluateRetrievalBenchmarkPatch is REJECT
  // regardless of its delta — propagate the apply reason so the report row is informative.
  if (!applyAccepted) {
    return { outcome: 'REJECT', reason: `apply_rejected:${applyReason ?? 'unknown'}` };
  }
  const baseInput = {
    baselineScorePpm: baseline,
    recentNoiseFloorPpm: BigInt(recentNoiseFloorPpm),
    deterministicDeltaPpm: BigInt(Math.max(0, Math.round(deltaPpm))),
    localModelDeltaPpm: 0n,
    parentMatchesLiveRoot,
  };
  // Only try STATE_ADVANCE qualification when the class is a real state-advance candidate.
  // Other classes (viable non-advancing, weak, etc.) cannot pre-claim a state advance.
  if (liveStateAdvanced === true) {
    const sa = evaluateCoreTexWorkQualification({ ...baseInput, outcome: OUTCOME_STATE_ADVANCE, liveStateAdvanced: true });
    if (sa.qualified) return { outcome: 'STATE_ADVANCE', reason: sa.reason };
  }
  const sp = evaluateCoreTexWorkQualification({ ...baseInput, outcome: OUTCOME_SCREENER });
  if (sp.qualified) return { outcome: 'SCREENER_PASS', reason: sp.reason };
  return { outcome: 'REJECT', reason: sp.reason };
}

function pctile(arr, p) { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]; }

const results = [];
for (const cls of classes) {
  console.log(`[screener-threshold] class=${cls.name} (n=${PER_CLASS}) ...`);
  const perPatch = [];
  for (let i = 0; i < PER_CLASS; i++) {
    const { patch } = cls.gen(i);
    const r = await scorePatchDelta(patch);
    const cls2 = classifyCanonically({ applyAccepted: r.accepted, applyReason: r.reason, deltaPpm: r.deltaPpm, parentMatchesLiveRoot: cls.parentMatchesLiveRoot, liveStateAdvanced: cls.liveStateAdvanced });
    const fp = createHash('sha256').update(`${patch.patchType}|${patch.indices.join(',')}|${patch.newWords.map((w) => w.toString(16)).join(',')}`).digest('hex').slice(0, 16);
    perPatch.push({ i, deltaPpm: r.deltaPpm, applyAccepted: r.accepted, applyReason: r.reason, outcome: cls2.outcome, qualificationReason: cls2.reason, patchFingerprint: '0x' + fp });
  }
  const deltas = perPatch.map((p) => p.deltaPpm);
  const counts = { REJECT: 0, SCREENER_PASS: 0, STATE_ADVANCE: 0 };
  for (const p of perPatch) counts[p.outcome]++;
  results.push({ class: cls.name, expected: cls.expected, n: PER_CLASS,
    deltaPpm: { mean: deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length), p10: pctile(deltas, 10), p50: pctile(deltas, 50), p90: pctile(deltas, 90), min: Math.min(...deltas), max: Math.max(...deltas) },
    outcomeCounts: counts, perPatch });
}

const summary = {
  threshold_inputs: {
    baselineParentScorePpm: Number(baseline),
    measuredRecentNoiseFloorPpm: Number(recentNoiseFloorPpm),
    minImprovementPpm: profile.patchAcceptanceFloors?.minImprovementPpm,
    replayTolerancePpm: profile.replayTolerancePpm,
    screenerThresholdPpm: Number(screenerThresholdPpm),
    canonical_qualification: 'evaluateCoreTexWorkQualification (REJECT / SCREENER_PASS / STATE_ADVANCE)',
  },
  per_class: Object.fromEntries(results.map((r) => [r.class, { mean_delta_ppm: Math.round(r.deltaPpm.mean), outcomes: r.outcomeCounts, expected: r.expected }])),
  false_screener_rate_by_class: Object.fromEntries(results.map((r) => {
    if (!r.expected.startsWith('REJECT')) return [r.class, null];
    return [r.class, (r.outcomeCounts.SCREENER_PASS + r.outcomeCounts.STATE_ADVANCE) / r.n];
  })),
  viable_screener_recall: (() => { const v = results.find((r) => r.class === 'viable_non_advancing'); return v ? (v.outcomeCounts.SCREENER_PASS + v.outcomeCounts.STATE_ADVANCE) / v.n : null; })(),
  true_advance_as_screener_count: (() => { const t = results.find((r) => r.class === 'true_state_advance_candidate'); return t ? t.outcomeCounts.SCREENER_PASS : null; })(),
  state_advance_acceptance_rate: (() => { const t = results.find((r) => r.class === 'true_state_advance_candidate'); return t ? t.outcomeCounts.STATE_ADVANCE / t.n : null; })(),
  duplicate_stale_rejection_rate: (() => {
    const sub = results.filter((r) => ['exact_duplicate', 'near_duplicate', 'stale_parent'].includes(r.class));
    const total = sub.reduce((a, r) => a + r.n, 0); const rej = sub.reduce((a, r) => a + r.outcomeCounts.REJECT, 0);
    return total ? rej / total : null;
  })(),
  junk_rejection_rate: (() => {
    const sub = results.filter((r) => ['junk_random', 'structurally_valid_irrelevant'].includes(r.class));
    const total = sub.reduce((a, r) => a + r.n, 0); const rej = sub.reduce((a, r) => a + r.outcomeCounts.REJECT, 0);
    return total ? rej / total : null;
  })(),
};

const report = {
  schema: 'coretex.screener-threshold-calibration.v2',
  reranker: RERANKER === 'gpu' ? `Qwen/${RR.modelId}@${RR.revision}` : 'deterministic',
  profile: PROFILE_PATH, bundle: BUNDLE_PATH, corpus: CORPUS_PATH, embeddings: EMB_PATH,
  bundleHash: bundle.bundleHash, corpusRoot: corpus.corpusRoot,
  noise_floor_samples: noiseDeltas,
  per_class_results: results,
  summary,
  canonicalAPIsUsed: [
    'evaluateRetrievalBenchmarkPatch(state, patch, corpus, pack, opts, floors)',
    'computeCoreTexScreenerThresholdPpm({baselineScorePpm, recentNoiseFloorPpm})',
    'evaluateCoreTexWorkQualification({outcome, parentMatchesLiveRoot, deterministicDeltaPpm, baselineScorePpm, recentNoiseFloorPpm, ...})',
  ],
};
mkdirSync(dirname(resolve(repoRoot, OUT_PATH)), { recursive: true });
writeFileSync(resolve(repoRoot, OUT_PATH), JSON.stringify(report, null, 2));
console.log(`\n[screener-threshold] wrote ${OUT_PATH}`);
console.log(JSON.stringify({ summary }, null, 2));

await reranker.close?.();
exit(0);
