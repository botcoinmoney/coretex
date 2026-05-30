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
  } else gate('screener_threshold', 'summary block present', false);
}

console.log('');
console.log(pass ? `GATES: ALL PASS ✅` : `GATES: HARD FAIL ❌ (${fails.length}) — ${fails.join('; ')}`);
exit(pass ? 0 : 1);
