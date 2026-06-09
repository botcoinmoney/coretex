#!/usr/bin/env node
/**
 * Item 5 — V2-profile baseline / min-improvement / replay smoke (CPU, deterministic).
 *
 * Verifies the PRODUCTION-FAITHFUL path end-to-end WITHOUT bespoke opts:
 *   - scoring options come from `scoringOptionsFromProfile(V2 profile)` (the
 *     canonical mapping) — carrying ownerScopeMode / categoryLensFinalBonusWeight
 *     / categoryLensScoreInheritance / V2 pack quotas.
 *   - pack comes from production `deriveQueryPack(canonical hiddenPack)`.
 *   - baseline via `evaluateBaseline`; min-improvement acceptance threshold =
 *     minImprovementPpm + variancePpm + replayTolerancePpm (production rule).
 *   - REPLAY determinism: re-scoring the same (state, corpus, pack) reproduces
 *     the composite within `replayTolerancePpm` (deterministic ⇒ exact).
 *   - leak-free corpus invariant: query events carry NO relations (no-query).
 *
 * Deterministic reranker → CPU-only, no GPU. Exit 0 = all checks pass.
 *
 * Usage: node scripts/smoke-v2-profile-replay.mjs --corpus <p1> --emb <p1emb>
 *        [--profile release/bundle/evaluator-profile-v2-ownerscope-r1.json] [--epoch 1]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const {
  scoringOptionsFromProfile, controllerParamsFromProfile, nextMinImprovementPpm,
  deriveQueryPack, evaluateBaseline, createDeterministicReranker, hiddenPackProfileFromEvaluatorProfile, computeAcceptanceThresholdPpm,
} = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p1-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/p1-embeddings.json');
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-ownerscope-r1.json');
const epoch = Number(flag('epoch', '1'));
const samples = Number(flag('samples', '3'));

const rerankerArg = flag('reranker', 'deterministic');
const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const hiddenPack = hiddenPackProfileFromEvaluatorProfile(profile);
const { corpus, queryEvents, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });

// Deterministic for CPU (replay ⇒ exact). gpu/cpu use real Qwen (replay must be
// within replayTolerancePpm — the production replay-disagreement ceiling).
const reranker = rerankerArg === 'gpu' || rerankerArg === 'cpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : await createDeterministicReranker();
const opts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

// 1. Canonical profile carries the V2 knobs into scoring options.
check('profile→opts: ownerScopeMode=restrict', opts.ownerScopeMode === 'restrict', `got ${opts.ownerScopeMode}`);
check('profile→opts: categoryLensFinalBonusWeight=0', opts.categoryLensFinalBonusWeight === 0, `got ${opts.categoryLensFinalBonusWeight}`);
check('profile→opts: categoryLensScoreInheritance=0.3', opts.categoryLensScoreInheritance === 0.3, `got ${opts.categoryLensScoreInheritance}`);
check('profile→opts: pipelineVersion carried', !!opts.pipelineVersion, opts.pipelineVersion);

// 2. Leak-free (no-query): query events carry no relations.
const anyQueryRel = queryEvents.some((e) => (e.relations ?? []).length > 0);
check('corpus leak-free (no query→answer relations)', !anyQueryRel);

// 3. Production pack via deriveQueryPack (V2 family quotas).
const seedHex = '0x' + createHash('sha256').update(`v2-replay:${epoch}`).digest('hex');
const pack = deriveQueryPack(epoch, seedHex, corpus, hiddenPack);
check('deriveQueryPack produced a pack', pack.events.length > 0, `packN=${pack.events.length} (cap ${hiddenPack.packSize})`);

// 4. Baseline + variance.
const empty = { words: new Array(1024).fill(0n) };
const base = await evaluateBaseline(empty, corpus, pack, opts, { samples });
check('baseline scored', Number.isFinite(base.parentScorePpm), `parentScorePpm=${base.parentScorePpm} variancePpm=${base.variancePpm}`);

// 5. REPLAY determinism: re-score, expect within replayTolerancePpm (deterministic ⇒ 0).
const replay = await evaluateBaseline(empty, corpus, pack, opts, { samples: 1 });
const replayDelta = Math.abs(replay.parentScorePpm - base.parentScorePpm);
check('replay within replayTolerancePpm', replayDelta <= profile.replayTolerancePpm, `|Δ|=${replayDelta} ≤ ${profile.replayTolerancePpm}`);

// 6. Production min-improvement acceptance threshold.
const minImpr = Number(profile.patchAcceptanceFloors.minImprovementPpm);
const acceptanceThresholdPpm = computeAcceptanceThresholdPpm(profile);
check('acceptance threshold computed (minImpr + productionVariance + replayTol)', Number.isFinite(acceptanceThresholdPpm),
  `${minImpr} + source=${profile.baselineVarianceSource ?? 'unavailable'} + ${profile.replayTolerancePpm} = ${acceptanceThresholdPpm}`);

// 7. Profile → CONTROLLER consumption (controllerParamsFromProfile is the single
//    profile → difficulty-controller path, the controller analog of
//    scoringOptionsFromProfile). The launch profile pins controllerParams; assert
//    the pinned shape is consumed AND that the calibrated decay branch is reachable
//    at honestAttempts == targetAdvances (the 2026-05-24 A/B fix).
const target = Number(flag('target-advances', '3'));
const cp = controllerParamsFromProfile(profile, target);
const pinned = profile.controllerParams !== undefined;
check('profile→controller: controllerParams pinned in launch profile', pinned,
  pinned ? `mult=${profile.controllerParams.qualityHighThresholdMult} ramp=${profile.controllerParams.rampUpMaxRatio} decay=${profile.controllerParams.decayRatio}` : 'absent → difficulty.ts defaults');
check('profile→controller: qualityHighThreshold = mult × targetAdvances', cp.qualityHighThreshold === (profile.controllerParams?.qualityHighThresholdMult ?? 4) * target,
  `qualityHighThreshold=${cp.qualityHighThreshold} (target=${target})`);
const decay = nextMinImprovementPpm({ current: 100_000n, observedAdvances: 0, targetAdvances: target, qualityAttempts: target, ...cp });
check('profile→controller: decay branch FIRES at honestAttempts==targetAdvances', decay.reason === 'decay',
  `reason=${decay.reason} ratio=${decay.ratioApplied} next=${decay.next}`);

const allPass = checks.every((c) => c.ok);
console.log(`\nRESULT: ${allPass ? 'ALL PASS ✅' : 'FAIL ❌'} (${checks.filter((c) => c.ok).length}/${checks.length})`);
console.log(`profile=${profilePath} corpus=${corpusPath} reranker=${rerankerArg} | baselinePpm=${base.parentScorePpm} variancePpm=${base.variancePpm} acceptanceThresholdPpm=${acceptanceThresholdPpm}`);
if (typeof reranker.close === 'function') reranker.close();
process.exit(allPass ? 0 : 1);
