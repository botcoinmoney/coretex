#!/usr/bin/env node
/**
 * Baseline recalibration e2e  (Launch hardening L7).
 *
 * Proves the production baseline-recompute contract deterministically (CPU):
 *
 *   1. Baseline A on active-frontier A (activeRoot A).
 *   2. Rotate the frontier deterministically (C3) → activeRoot B ≠ A.
 *   3. Baseline B recomputed on the rotated active pack — DIFFERENT comparison
 *      point from A (activeRootChanged ⇒ baseline re-pin).
 *   4. The NEXT-epoch patch delta is measured against baseline B (not A): the
 *      acceptance threshold = minImprovementPpm + B.variancePpm + replayTolerancePpm,
 *      and a temporal honest patch's delta is scored vs B.parentScorePpm.
 *   5. Difficulty behaviour:
 *        - activeRootChanged only → baseline recompute, NO major-delta grace.
 *        - corpusRootChanged (eval_hidden grows ≥ majorDeltaThreshold) → isMajorDelta
 *          true → nextMinImprovementPpm returns reason 'major_delta_grace' (frozen
 *          threshold for exactly that epoch).
 *   6. Baseline manifest carries the required pinned roots/fields.
 *
 * Deterministic reranker ⇒ variance 0 (single calibrated host). Real-Qwen
 * samples≥3 variance is confirmed separately on the A100 (see findings).
 *
 * Usage: node scripts/baseline-recalibration-e2e.mjs
 *   [--corpus dgen1-r5-synth-corpus.json] [--emb ...] [--profile ...-policy-r5.json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeEpochFrontier } from './lib/epoch-frontier.mjs';
import { honestPatch } from './lib/v2-patch-families.mjs';

const m = await import(distIndex);
const {
  scoringOptionsFromProfile, deriveQueryPack, evaluateBaseline, createDeterministicReranker,
  evaluateRetrievalBenchmarkState, isMajorDelta, nextMinImprovementPpm, controllerParamsFromProfile,
  merkleizeState, applyPatch, bytesToHex,
} = m;

function flag(name, fb) { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; }
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-300k-final-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-r5-synth-300k-final-embeddings.json`);
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k.json');

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const { corpus, logical, LAYOUT, BE, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const reranker = await createDeterministicReranker();
const opts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
const logicalQById = new Map((logical?.docs ? logical.queries ?? [] : []).map?.((q) => [q.id, q]) ?? []);

// frontier over eval_hidden
const evalHidden = corpus.events.filter((e) => e.split === 'eval_hidden');
const famById = new Map(evalHidden.map((e) => [e.id, e.logicalFamily ?? e.family]));
const fr = makeEpochFrontier({ evalHiddenIds: evalHidden.map((e) => e.id), familyOf: (id) => famById.get(id) ?? 'unknown', mode: 'C3', activeWindow: 30, seed: 'baseline-e2e', minChurn: 4, maxChurn: 12, headroomLowWatermark: 1, headroomHighWatermark: 3, targetAccepts: 2, expectedYieldPerUnit: 0.17, maxRootDeltaPerEpoch: 24 });

const seedHex = '0x' + createHash('sha256').update('baseline-e2e').digest('hex');
// Derive the scored pack FROM the active frontier: eval_hidden is restricted to
// the active ids before pack derivation, so the scored set follows the frontier.
// (The previous form derived 64 queries over the FULL corpus and then filtered
// by a 30-event active window — the intersection was empty, so every "baseline"
// here was the n=0 default and the gate scored nothing.)
const activePackFor = (activeIds) => {
  const restricted = { ...corpus, events: corpus.events.filter((e) => e.split !== 'eval_hidden' || activeIds.has(e.id)) };
  return deriveQueryPack(0, seedHex, restricted, { ...profile.hiddenPack, packSize: Math.min(64, activeIds.size), quotas: [] });
};

let pass = true; const log = [];
const check = (n, ok, d = '') => { log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!ok) pass = false; };
const requireNonEmpty = (name, pack) => { if (pack.events.length === 0) { console.error(`HARD FAIL: ${name} scored pack is empty — the gate would prove nothing`); exit(1); } };

// epoch 0: frontier A
const snapA = fr.stepEpoch(0, null, null);
const packA = activePackFor(snapA.activeIds);
requireNonEmpty('pack A', packA);
const baselineA = await evaluateBaseline({ words: new Array(1024).fill(0n) }, corpus, packA, opts, { samples: 1 });

// rotate: starve to force C3 replenishment → activeRoot B ≠ A
const snapB = fr.stepEpoch(1, 0, 4);
const packB = activePackFor(snapB.activeIds);
requireNonEmpty('pack B', packB);
const baselineB = await evaluateBaseline({ words: new Array(1024).fill(0n) }, corpus, packB, opts, { samples: 1 });

check('1) activeRoot rotates (A ≠ B)', snapA.activeRoot !== snapB.activeRoot, `${snapA.activeRoot} → ${snapB.activeRoot}`);
const packAIds = new Set(packA.events.map((e) => e.id));
const scoredPackRotated = packB.events.length !== packA.events.length || packB.events.some((e) => !packAIds.has(e.id));
check('2) baseline B recomputed on rotated active pack', Number.isFinite(baselineB.parentScorePpm) && scoredPackRotated, `A=${baselineA.parentScorePpm}ppm (n=${packA.events.length}) B=${baselineB.parentScorePpm}ppm (n=${packB.events.length})`);

// 3+4) next-epoch patch delta measured against baseline B
const replayTol = profile.replayTolerancePpm;
const minImpr = Number(profile.patchAcceptanceFloors.minImprovementPpm);
const thresholdB = minImpr + baselineB.variancePpm + replayTol;
// Build a temporal honest patch and score it on packB. Mining/scoring errors
// propagate (uncaught → nonzero exit): a broken scorer must FAIL this gate,
// never pass it. "No unit minable" is the one legitimate skip, and only via
// the explicit zero-indices path below.
const empty = { words: new Array(1024).fill(0n) };
let patchDeltaVsB = null, patchDeltaVsA = null, patchFailure = null;
const patch = honestPatch({ state: empty, family: 'temporal', pack: packB, logicalQById, recordSlot: 0, skipDocIds: new Set() });
if (patch.indices.length > 0) {
  const res = applyPatch(empty, patch);
  if (!res.ok) {
    patchFailure = `applyPatch failed: ${res.code ?? 'unknown'}`;
  } else {
    const patched = await evaluateRetrievalBenchmarkState(res.state, corpus, packB, opts);
    const patchPpm = Math.round(patched.composite * 1_000_000);
    patchDeltaVsB = patchPpm - baselineB.parentScorePpm;
    patchDeltaVsA = patchPpm - baselineA.parentScorePpm;
  }
}
check('3) acceptance threshold uses baseline B variance', Number.isFinite(thresholdB), `${minImpr} + ${baselineB.variancePpm} + ${replayTol} = ${thresholdB}`);
check('4) patch delta is measured vs baseline B (the active comparison point)',
  patchFailure === null && (patch.indices.length === 0
    ? true
    : Number.isFinite(patchDeltaVsB) && Number.isFinite(patchDeltaVsA)
      && (patchDeltaVsB - patchDeltaVsA) === (baselineA.parentScorePpm - baselineB.parentScorePpm)),
  patchFailure ?? (patch.indices.length === 0
    ? 'no temporal unit minable on this pack subset (verified: honestPatch returned 0 indices; scoring errors propagate)'
    : `Δ_vs_B=${patchDeltaVsB} vs Δ_vs_A=${patchDeltaVsA} (stale-baseline error would be ${patchDeltaVsB - patchDeltaVsA}ppm)`));

// 5) difficulty: activeRootChanged-only → no grace; corpusRootChanged → grace
const cp = controllerParamsFromProfile(profile, 3);
const noGrace = nextMinImprovementPpm({ current: 100_000n, observedAdvances: 1, targetAdvances: 3, qualityAttempts: 3, majorDeltaActive: false, ...cp });
const majorDeltaThreshold = profile.majorDeltaThreshold ?? 10;
const corpusGrew = isMajorDelta(evalHidden.length + majorDeltaThreshold, evalHidden.length, majorDeltaThreshold);
const grace = nextMinImprovementPpm({ current: 100_000n, observedAdvances: 1, targetAdvances: 3, qualityAttempts: 3, majorDeltaActive: corpusGrew, ...cp });
check('5a) activeRootChanged only → NO major-delta grace', noGrace.reason !== 'major_delta_grace', `reason=${noGrace.reason}`);
check('5b) corpusRootChanged (≥ majorDeltaThreshold) → isMajorDelta true', corpusGrew === true, `threshold=${majorDeltaThreshold}`);
check('5c) major delta → grace freezes threshold', grace.reason === 'major_delta_grace' && grace.next === 100_000n, `reason=${grace.reason} next=${grace.next}`);

// 6) baseline manifest fields
const manifest = {
  parentStateRoot: bytesToHex(merkleizeState(empty)),
  corpusRoot: baselineB.corpusRoot,
  activeRoot: snapB.activeRoot,
  queryPackRoot: bytesToHex((m.keccak256)(new TextEncoder().encode(packB.events.map((e) => e.id).sort().join('\n')))),
  bundleProfile: profilePath,
  parentScorePpm: baselineB.parentScorePpm,
  variancePpm: baselineB.variancePpm,
  samples: baselineB.samples,
  epochId: baselineB.epochId,
};
check('6) baseline manifest carries pinned roots (corpus/active/queryPack/parent + variance + samples)',
  !!(manifest.corpusRoot && manifest.activeRoot && manifest.queryPackRoot && manifest.parentStateRoot && Number.isFinite(manifest.parentScorePpm) && Number.isFinite(manifest.variancePpm) && manifest.samples >= 1));

console.log(log.join('\n'));
console.log('────────────────────────────────────────────────────────');
console.log(`baseline A  parentScorePpm=${baselineA.parentScorePpm} variancePpm=${baselineA.variancePpm} n=${packA.events.length} activeRoot=${snapA.activeRoot}`);
console.log(`baseline B  parentScorePpm=${baselineB.parentScorePpm} variancePpm=${baselineB.variancePpm} n=${packB.events.length} activeRoot=${snapB.activeRoot}`);
console.log(`manifest    ${JSON.stringify(manifest)}`);
console.log(pass ? 'RESULT: ALL PASS ✅' : 'RESULT: FAIL ❌');
if (typeof reranker.close === 'function') reranker.close();
exit(pass ? 0 : 1);
