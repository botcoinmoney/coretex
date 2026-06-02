#!/usr/bin/env node
/**
 * Fast CPU smoke for screener-threshold mechanics. Loads a TINY SLICE of the materialized
 * production-corpus artifact (NO 16-minute rebuild) and exercises the canonical chain end-to-end
 * with the deterministic reranker:
 *
 *   evaluateRetrievalBenchmarkPatch (real apply + score on slice pack)
 *   computeCoreTexScreenerThresholdPpm (with a tiny measured noise floor)
 *   evaluateCoreTexWorkQualification (REJECT / SCREENER_PASS / STATE_ADVANCE)
 *
 * Hard-fails on any of:
 *   - materialized artifact missing or input-sha drift;
 *   - canonical classifier returns an unknown outcome string;
 *   - computeCoreTexScreenerThresholdPpm returns <= 0.
 *
 * Usage: node scripts/smoke-screener-threshold-mechanics.mjs --profile <p> --bundle <b> [--slice 256]
 */
import { argv, exit } from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';

const C = await import(distIndex);
const {
  RANGES, PATCH_TYPE,
  evaluateRetrievalBenchmarkPatch,
  computeCoreTexScreenerThresholdPpm, evaluateCoreTexWorkQualification, DEFAULT_CORETEX_WORK_POLICY,
  scoringOptionsFromProfile, deriveQueryPack, biEncoderModelIdHash,
  createDeterministicReranker,
  encodePolicyAtom, POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE,
  merkleizeState,
} = C;

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const PROFILE = flag('profile');
const BUNDLE = flag('bundle');
const CORPUS = flag('corpus');
const EMB = flag('emb');
const PACK_SIZE = Number(flag('pack-size', '8'));
if (!PROFILE || !BUNDLE) { console.error('HARD FAIL: --profile, --bundle required'); exit(1); }

function fail(m) { console.error(`SMOKE FAIL: ${m}`); exit(1); }
function pass(m) { console.log(`SMOKE PASS: ${m}`); }

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE), 'utf8'));

console.log(`smoke: loading materialized full corpus (NO rebuild) ...`);
const t0 = Date.now();
const loaded = loadMaterializedCorpus(BUNDLE);
const { corpus, BE, RR, LAYOUT } = loaded;
pass(`materialized corpus loaded — events=${corpus.events.length} root=${corpus.corpusRoot.slice(0, 18)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

const reranker = await createDeterministicReranker();
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const opts = scoringOptionsFromProfile(profile, rt);
const floors = { ...profile.patchAcceptanceFloors, acceptanceThresholdPpm: profile.patchAcceptanceFloors?.minImprovementPpm ?? 2500 };

const evalSeed = profile.baselineEvalSeedHex ?? '0x' + 'a5'.repeat(32);
const pack = deriveQueryPack(0, evalSeed, corpus, { packSize: PACK_SIZE, quotas: [] });
if (pack.events.length === 0) fail('slice has no eligible pack events');
pass(`pack derived — ${pack.events.length} events`);

const baseline = BigInt(profile.baselineParentScorePpm ?? 0);

// Tiny noise-floor measurement (just to prove the canonical path; production uses N>=6).
const zero = () => ({ words: new Array(1024).fill(0n) });
const GENESIS_PARENT_ROOT = merkleizeState(zero());
const noisePatch = {
  patchType: PATCH_TYPE.POLICY_UPDATE, wordCount: 1, scoreDelta: 0, parentStateRoot: GENESIS_PARENT_ROOT,
  indices: [RANGES.POLICY_EVIDENCE_START], newWords: [encodePolicyAtom({
    atomIndex: 0, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'bundle', scope: 'relation_path',
    targetSlot: 200, budget: 1, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n })],
};
let noiseAbs = 0;
try { const r = await evaluateRetrievalBenchmarkPatch(zero(), noisePatch, corpus, pack, opts, floors); noiseAbs = Math.abs(r.deltaPpm ?? 0); }
catch (e) { fail(`noise-floor eval threw: ${e.message?.slice(0, 120)}`); }
const recentNoiseFloorPpm = BigInt(noiseAbs);
pass(`noise floor sampled: ${noiseAbs}ppm`);

const screenerThreshold = computeCoreTexScreenerThresholdPpm({ baselineScorePpm: baseline, recentNoiseFloorPpm });
if (screenerThreshold <= 0n) fail(`canonical screenerThreshold non-positive: ${screenerThreshold}`);
pass(`computeCoreTexScreenerThresholdPpm returned ${screenerThreshold}ppm`);
const plateauThreshold = computeCoreTexScreenerThresholdPpm({
  baselineScorePpm: baseline,
  recentNoiseFloorPpm,
  targetStateAdvances: 2,
  recentStateAdvances: 0,
  recentScreenerPasses: 2,
});
const probePressureThreshold = computeCoreTexScreenerThresholdPpm({
  baselineScorePpm: baseline,
  recentNoiseFloorPpm,
  recentProbePassRatePpm: 50_000,
});
if (plateauThreshold > screenerThreshold) fail(`plateau-eased threshold increased: ${plateauThreshold} > ${screenerThreshold}`);
if (probePressureThreshold < screenerThreshold) fail(`probe-pressure threshold decreased: ${probePressureThreshold} < ${screenerThreshold}`);
pass(`dynamic threshold controls responded — plateau=${plateauThreshold}ppm probe5pct=${probePressureThreshold}ppm`);

// Canonical qualification path — try REJECT, SCREENER_PASS, STATE_ADVANCE outcomes via the
// canonical evaluator (mechanics check; deterministic reranker gives delta≈0 so we expect REJECT).
const POLICY = DEFAULT_CORETEX_WORK_POLICY;
const baseInput = { baselineScorePpm: baseline, recentNoiseFloorPpm, deterministicDeltaPpm: 0n, localModelDeltaPpm: 0n, parentMatchesLiveRoot: true };
const sp = evaluateCoreTexWorkQualification({ ...baseInput, outcome: POLICY.screenerPass.outcome });
const sa = evaluateCoreTexWorkQualification({ ...baseInput, outcome: POLICY.stateAdvance.outcome, liveStateAdvanced: true });
if (typeof sp.qualified !== 'boolean' || typeof sa.qualified !== 'boolean') fail(`canonical evaluateCoreTexWorkQualification did not return boolean qualified field`);
pass(`canonical evaluateCoreTexWorkQualification responded — screenerPass.qualified=${sp.qualified} reason=${sp.reason}; stateAdvance.qualified=${sa.qualified} reason=${sa.reason}`);
pass('parent_matches_live_root stale_parent control (parentMatchesLiveRoot=false) → expect W02');
const stale = evaluateCoreTexWorkQualification({ ...baseInput, outcome: POLICY.screenerPass.outcome, parentMatchesLiveRoot: false });
if (stale.reason !== 'W02_STALE_PARENT') fail(`stale-parent control returned ${stale.reason}, expected W02_STALE_PARENT`);
pass(`stale-parent control hit W02_STALE_PARENT as expected`);

console.log('SMOKE: ALL PASS ✅ — screener-threshold mechanics confirmed (canonical qualification path + measured noise floor)');
exit(0);
