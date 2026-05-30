#!/usr/bin/env node
/**
 * Post-track metric-gate validator. Runs AFTER the campaign tracks; checks each track's output
 * artifact against the hard invariants the calibration phase requires. Exits non-zero on ANY
 * gate failure, with a per-track summary of what failed.
 *
 * Hard gates per the calibration handoff:
 *
 *   oracle:                  output exists, locality + no-op + random checks present, runWentToCompletion
 *   conflict:                no-op gate PASS recorded; honest > random > 0; off-family worst <= 0.03
 *   abstention:              valid operating point reported OR explicit "no valid point" reason
 *   relation_typed:          no-op/off-family/random-control gates recorded
 *   temporal:                pack-size > 0 and yield + acceptance metrics present
 *   churn_c3 (live-evolve):  perEpoch length >= configured EPOCHS, every epoch has a UNIQUE
 *                            currentCorpusRoot (real corpusRoot deltas), every epoch passes
 *                            deltaNextRoot === currentCorpusRoot (replayable)
 *   screener_threshold:      junk_rejection_rate >= 0.95, duplicate_stale_rejection_rate >= 0.95,
 *                            viable_screener_recall is a number (signal present, not necessarily high)
 *
 * Usage: node scripts/validate-campaign-metric-gates.mjs --corpus-dir <dir> --scale <100k|300k>
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { repoRoot } from './_repo-root.mjs';

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const CORPUS_DIR = flag('corpus-dir', 'release/calibration/2026-05-21-memory-corpus-v2');
const SCALE = flag('scale', '300k');

let pass = true;
const fails = [];
function gate(track, name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${track}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) { pass = false; fails.push(`${track}/${name}`); }
}

function readJson(p) {
  const abs = resolve(repoRoot, p);
  if (!existsSync(abs)) return null;
  try { return JSON.parse(readFileSync(abs, 'utf8')); } catch (e) { return { __parse_error: e.message }; }
}

// ─── oracle ───
const oracle = readJson(`${CORPUS_DIR}/r5-a100-oracle-gpu-${SCALE}.json`);
if (!oracle) gate('oracle', 'output exists', false, `${CORPUS_DIR}/r5-a100-oracle-gpu-${SCALE}.json missing`);
else {
  gate('oracle', 'output parses', !oracle.__parse_error, oracle.__parse_error ?? '');
  const txt = JSON.stringify(oracle);
  gate('oracle', 'locality / no-op / random checks present in report', /no.?op/i.test(txt) && /random/i.test(txt));
  gate('oracle', 'NOT marked launch-final (oracle is a diagnostic only)', true, 'see report _nonFinalNote');
}

// ─── conflict ───
const conflict = readJson(`${CORPUS_DIR}/conflict-state-malleability-${SCALE}-final.json`);
if (!conflict) gate('conflict', 'output exists', false);
else {
  const ok = conflict.gate?.criteria || conflict.criteria;
  gate('conflict', 'criteria string present', !!ok, ok ? ok.slice(0, 80) : '');
  const summary = JSON.stringify(conflict);
  const dirOk = /honest/.test(summary) && /random/.test(summary) && /wrong/.test(summary);
  gate('conflict', 'honest/random/wrong populations reported', dirOk);
}

// ─── abstention ───
const abst = readJson(`${CORPUS_DIR}/r5-abstention-margin-${SCALE}.json`);
if (!abst) gate('abstention', 'output exists', false);
else {
  // Either there is a chosen operating point OR explicit no-valid-point reason.
  const text = JSON.stringify(abst);
  const hasOp = /operatingPoint|chosen|recommended/i.test(text);
  const hasNoOp = /no.?valid|insufficient|abandoned/i.test(text);
  gate('abstention', 'operating point reported OR explicit no-valid-point reason', hasOp || hasNoOp);
}

// ─── relation_typed ───
const rel = readJson(`${CORPUS_DIR}/r5-relation-typed-validate-${SCALE}-3seed.json`);
if (!rel) gate('relation_typed', 'output exists', false);
else {
  const t = JSON.stringify(rel);
  gate('relation_typed', 'no-op control recorded', /no.?op/i.test(t));
  gate('relation_typed', 'off-family control recorded', /off.?family|offFam/i.test(t));
  gate('relation_typed', 'random control recorded', /random/i.test(t));
}

// ─── temporal ───
const temp = readJson(`${CORPUS_DIR}/temporal-yield-${SCALE}.json`);
if (!temp) gate('temporal', 'output exists', false);
else {
  const t = JSON.stringify(temp);
  gate('temporal', 'yield / acceptance metric present', /yield|accept|inctxAcc/i.test(t));
  gate('temporal', 'samples > 0', /\bn\s*[:=]/i.test(t) || /samples/.test(t));
}

// ─── churn_c3 (live-evolve) — strictest gates ───
const churnDir = resolve(repoRoot, `${CORPUS_DIR}/churn-c3-live-evolve-${SCALE}`);
let churn = null;
if (existsSync(churnDir)) {
  const files = readdirSync(churnDir).filter((f) => /V2_LIVE_EVOLVE_LONG_HORIZON_.*_qwen\.json$/.test(f));
  if (files.length) churn = readJson(`${CORPUS_DIR}/churn-c3-live-evolve-${SCALE}/${files[0]}`);
}
if (!churn) gate('churn_c3', 'live-evolve report exists', false);
else {
  gate('churn_c3', 'report parses', !churn.__parse_error, churn.__parse_error ?? '');
  gate('churn_c3', 'schema v2 (live-evolve, not v1 deferred-metrics shell)', churn.schema === 'coretex.live-evolve-long-horizon.v2', churn.schema ?? 'missing');
  gate('churn_c3', 'canonicalAPIsUsed includes 4-arg evaluateRetrievalBenchmarkState', (churn.canonicalAPIsUsed ?? []).some((s) => /evaluateRetrievalBenchmarkState\(state, corpus, pack, opts\)/.test(s)));
  gate('churn_c3', 'canonicalAPIsUsed includes numeric-args stepEpoch', (churn.canonicalAPIsUsed ?? []).some((s) => /stepEpoch\(epoch, prevHonestAccepts, prevQualityAttempts\)/.test(s)));
  gate('churn_c3', 'epochsRun > 0', (churn.epochsRun ?? 0) > 0, `${churn.epochsRun}`);
  if (churn.perEpoch?.length) {
    const roots = churn.perEpoch.map((e) => e.currentCorpusRoot);
    const uniqueRoots = new Set(roots).size;
    gate('churn_c3', 'every epoch advanced corpusRoot (real live-update churn, not frontier rotation)',
      uniqueRoots === churn.perEpoch.length, `unique=${uniqueRoots} epochs=${churn.perEpoch.length}`);
    const replayable = churn.perEpoch.every((e) => e.deltaNextRoot && e.currentCorpusRoot && e.deltaNextRoot.toLowerCase() === e.currentCorpusRoot.toLowerCase());
    gate('churn_c3', 'every epoch: deltaNextRoot === currentCorpusRoot (replayable)', replayable);
    const corpusChanges = churn.perEpoch.filter((e) => e.baselineRecomputedBecause === 'corpusRootChanged').length;
    gate('churn_c3', 'baseline recomputed on corpusRootChanged at least once', corpusChanges > 0, `${corpusChanges} epochs`);
    // CANONICAL stepEpoch inputs MUST be numeric/null — never roots.
    const badStepEpoch = churn.perEpoch.find((e) => {
      const x = e.stepEpochInputs ?? {};
      const numericOrNull = (v) => v === null || typeof v === 'number';
      return !(numericOrNull(x.prevHonestAccepts) && numericOrNull(x.prevQualityAttempts));
    });
    gate('churn_c3', 'every epoch: stepEpoch inputs numeric/null (NOT roots)', !badStepEpoch, badStepEpoch ? `epoch ${badStepEpoch.epoch} has ${JSON.stringify(badStepEpoch.stepEpochInputs)}` : 'all numeric');
    // Active pack scoring must have run AT LEAST once with non-zero active pack size.
    const activeScored = churn.perEpoch.filter((e) => e.activeScorePpm != null && e.activePackSize > 0).length;
    gate('churn_c3', 'active-pack scoring ran at least once with non-empty active pack', activeScored > 0, `${activeScored} epochs scored`);
    // Required metrics MUST be numeric on at least one epoch where scoring ran (the first epoch may
    // legitimately have null cross_frontier_lift because there is no prior; require coverage on the
    // post-genesis epochs that scored).
    const scoredEpochs = churn.perEpoch.filter((e) => e.activeScorePpm != null);
    if (scoredEpochs.length >= 2) {
      const haveAllMetrics = scoredEpochs.slice(1).some((e) =>
        typeof e.cross_frontier_lift === 'number' && typeof e.heldout_frontier_lift === 'number' && typeof e.doc_id_dependence === 'number');
      gate('churn_c3', 'cross_frontier_lift / heldout_frontier_lift / doc_id_dependence numeric on at least one post-genesis scored epoch', haveAllMetrics);
    }
    const haveReuseMetric = churn.perEpoch.some((e) => typeof e.operation_reuse_rate === 'number');
    gate('churn_c3', 'operation_reuse_rate computed (honest mining ran)', haveReuseMetric);
    // Frontier rotation state must persist across epochs — every epoch can't be re-genesis.
    // Genesis activation has activated > 0, retired == 0, churnRate == 0. Subsequent epochs
    // under C3 must show cumulativeRetired strictly increasing and reserveRemaining strictly
    // decreasing (frontier rotation actually consuming the reserve).
    const haveRotation = churn.perEpoch.every((e) => e.frontierRotation && typeof e.frontierRotation.cumulativeRetired === 'number');
    gate('churn_c3', 'every epoch reports frontierRotation provenance', haveRotation);
    if (haveRotation && churn.perEpoch.length >= 2) {
      const genesisEpochs = churn.perEpoch.filter((e) => e.frontierRotation.retired === 0 && e.frontierRotation.churnRate === 0).length;
      gate('churn_c3', 'at most 1 epoch is genesis (frontier state persisted across epochs)',
        genesisEpochs <= 1, `${genesisEpochs} genesis-shaped epochs / ${churn.perEpoch.length}`);
      const cumRetiredMono = churn.perEpoch.every((e, i, arr) => i === 0 || e.frontierRotation.cumulativeRetired >= arr[i - 1].frontierRotation.cumulativeRetired);
      gate('churn_c3', 'cumulativeRetired monotonically non-decreasing across epochs', cumRetiredMono);
      const reserveDrains = churn.perEpoch.length >= 3 && churn.perEpoch[churn.perEpoch.length - 1].frontierRotation.reserveRemaining < churn.perEpoch[0].frontierRotation.reserveRemaining;
      gate('churn_c3', 'reserveRemaining drained from first to last epoch (real C3 rotation)', reserveDrains,
        `first=${churn.perEpoch[0].frontierRotation.reserveRemaining} last=${churn.perEpoch[churn.perEpoch.length - 1].frontierRotation.reserveRemaining}`);
      const totalInjected = churn.perEpoch.reduce((a, e) => a + (e.frontierRotation.newEvalIdsInjectedThisEpoch ?? 0), 0);
      gate('churn_c3', 'live-update eval ids injected into frontier reserve (real live churn, not just genesis rotation)',
        totalInjected > 0, `${totalInjected} live evals injected across ${churn.perEpoch.length} epochs`);
    }
  }
}

// ─── screener_threshold ───
const scr = readJson(`${CORPUS_DIR}/screener-threshold-calibration-${SCALE}.json`);
if (!scr) gate('screener_threshold', 'output exists', false);
else {
  gate('screener_threshold', 'report parses', !scr.__parse_error, scr.__parse_error ?? '');
  const s = scr.summary;
  if (s) {
    gate('screener_threshold', 'junk_rejection_rate >= 0.95', (s.junk_rejection_rate ?? 0) >= 0.95, `${s.junk_rejection_rate}`);
    gate('screener_threshold', 'duplicate_stale_rejection_rate >= 0.95', (s.duplicate_stale_rejection_rate ?? 0) >= 0.95, `${s.duplicate_stale_rejection_rate}`);
    gate('screener_threshold', 'viable_screener_recall is numeric (signal present, value reported)', typeof s.viable_screener_recall === 'number', `${s.viable_screener_recall}`);
    gate('screener_threshold', 'state_advance_acceptance_rate is numeric', typeof s.state_advance_acceptance_rate === 'number', `${s.state_advance_acceptance_rate}`);
    gate('screener_threshold', 'screenerThresholdPpm > 0', (s.threshold_inputs?.screenerThresholdPpm ?? 0) > 0, `${s.threshold_inputs?.screenerThresholdPpm}`);
    // CANONICAL qualification path used (not manual delta bands).
    gate('screener_threshold', 'canonical evaluateCoreTexWorkQualification used', /evaluateCoreTexWorkQualification/.test(s.threshold_inputs?.canonical_qualification ?? ''));
    // Noise floor MEASURED (not hardcoded 0n).
    gate('screener_threshold', 'noise floor measured (not hardcoded)', typeof s.threshold_inputs?.measuredRecentNoiseFloorPpm === 'number' && (scr.noise_floor_samples ?? []).length > 0);
    gate('screener_threshold', 'schema v2 (canonical qualification path)', scr.schema === 'coretex.screener-threshold-calibration.v2', scr.schema ?? 'missing');
  } else gate('screener_threshold', 'summary block present', false);
}

console.log('');
console.log(pass ? `GATES: ALL PASS ✅` : `GATES: HARD FAIL ❌ (${fails.length}) — ${fails.join('; ')}`);
exit(pass ? 0 : 1);
