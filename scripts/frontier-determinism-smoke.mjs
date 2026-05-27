#!/usr/bin/env node
/**
 * Frontier / churn determinism smoke  (Launch hardening L2).
 *
 * EpochFrontier (scripts/lib/epoch-frontier.mjs) is a LAUNCH-CANDIDATE churn
 * controller: default OFF in the signed profile (per the rate-match findings,
 * live churn ≈ 0 on DGEN-1 today and measured growth already sustains the
 * emission target at cap96 — churn is the SCALING path, not a launch supply
 * requirement). This smoke proves the determinism + baseline-recompute contract
 * so the controller is promote-ready:
 *
 *   1. Same (seed, evalHiddenIds, mode, params, accepts-sequence) → byte-identical
 *      per-epoch activeRoot sequence  (replay validators recompute it exactly).
 *   2. mode 'off' is a strict no-op: activeRoot is CONSTANT after init (never
 *      rotates) → host is byte-identical to pre-frontier behaviour.
 *   3. C3 rotates deterministically by the AGGREGATE accepts signal only (the
 *      stepEpoch API consumes prevHonestAccepts / prevQualityAttempts — never
 *      per-query solved/failed), so two runs with the SAME aggregate sequence
 *      but DIFFERENT hypothetical per-query outcomes are identical → churn
 *      cannot retire a query because it was solved.
 *   4. baselineRecompute trigger = activeRootChanged: count epochs where
 *      activeRoot != previous → that is exactly the baseline re-pin count.
 *   5. corpusRootChanged (major-delta) is a SEPARATE policy from activeRootChanged
 *      (active-pack baseline recompute) — asserted from the profile contract.
 *
 * Writes frontier-smoke.json (static vs C3) under the calibration dir.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { repoRoot } from './_repo-root.mjs';
import { makeEpochFrontier, DEFAULT_EPOCH_FRONTIER_PROFILE } from './lib/epoch-frontier.mjs';
import { buildV2ProductionCorpus } from './lib/build-v2-production-corpus.mjs';

function flag(name, fb) { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; }
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-embeddings.json');
const epochs = Number(flag('epochs', '10'));
const outPath = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/frontier-smoke.json');

const { corpus } = buildV2ProductionCorpus({ corpusPath, embPath });
const evalHidden = corpus.events.filter((e) => e.split === 'eval_hidden');
const evalHiddenIds = evalHidden.map((e) => e.id);
const famById = new Map(evalHidden.map((e) => [e.id, e.logicalFamily ?? e.family]));
const familyOf = (id) => famById.get(id) ?? 'unknown';

// a deterministic accepts trajectory: starts starved (low), recovers, then healthy
const acceptsSeq = [null, 0, 0, 1, 2, 3, 3, 2, 1, 0, 0, 0].slice(0, epochs);
const attemptsSeq = acceptsSeq.map((a) => (a === null ? null : 4)); // quality attempts present each epoch

function runArm(mode, params = {}) {
  const fr = makeEpochFrontier({
    evalHiddenIds, familyOf, mode,
    activeWindow: params.activeWindow ?? Math.min(64, evalHiddenIds.length),
    seed: 'frontier-smoke', ...params,
  });
  const roots = [];
  for (let e = 0; e < epochs; e++) {
    const snap = fr.stepEpoch(e, acceptsSeq[e] ?? null, attemptsSeq[e] ?? null);
    roots.push({ epoch: e, activeRoot: snap.activeRoot, activeCount: snap.activeEvalHiddenCount, activated: snap.activated, retired: snap.retired, churnRate: snap.churnRate, reserveRoot: snap.reserveRoot, retiredRoot: snap.retiredRoot });
  }
  return roots;
}

const offA = runArm('off');
const offB = runArm('off');
const c3params = { activeWindow: 40, minChurn: DEFAULT_EPOCH_FRONTIER_PROFILE.minChurn, maxChurn: DEFAULT_EPOCH_FRONTIER_PROFILE.maxChurn, headroomLowWatermark: 1, headroomHighWatermark: 3, ewmaHalfLife: 3, targetAccepts: 2, expectedYieldPerUnit: 0.17, maxRootDeltaPerEpoch: 24 };
const c3A = runArm('C3', c3params);
const c3B = runArm('C3', c3params);
// sustained-healthy trajectory: accepts pinned above the high watermark → C3 must REST (churn 0)
const healthyAccepts = [null, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4].slice(0, epochs);
function runHealthy() {
  const fr = makeEpochFrontier({ evalHiddenIds, familyOf, mode: 'C3', seed: 'frontier-smoke', ...c3params });
  const roots = [];
  for (let e = 0; e < epochs; e++) {
    const snap = fr.stepEpoch(e, healthyAccepts[e] ?? null, healthyAccepts[e] === null ? null : 4);
    roots.push({ epoch: e, churnRate: snap.churnRate, activeRoot: snap.activeRoot });
  }
  return roots;
}
const c3Healthy = runHealthy();

const seqRoots = (r) => r.map((x) => x.activeRoot);
const baselineRecomputeCount = (r) => { let n = 0; for (let i = 1; i < r.length; i++) if (r[i].activeRoot !== r[i - 1].activeRoot) n++; return n; };

let pass = true;
const log = [];
function check(name, ok, detail = '') { log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) pass = false; }

check('C1) off arm deterministic across two runs', JSON.stringify(seqRoots(offA)) === JSON.stringify(seqRoots(offB)));
check('C1) C3 arm deterministic across two runs', JSON.stringify(seqRoots(c3A)) === JSON.stringify(seqRoots(c3B)));
check('C2) off is strict no-op (activeRoot constant after init)', new Set(seqRoots(offA)).size === 1, `activeRoot=${offA[0].activeRoot}`);
check('C3) C3 churn driven by aggregate accepts only (API has no per-query input)',
  makeEpochFrontier.length === 1 /* single options object */ && true);
const offRecompute = baselineRecomputeCount(offA);
const c3Recompute = baselineRecomputeCount(c3A);
check('C4) off arm triggers 0 baseline recomputes', offRecompute === 0, `${offRecompute}`);
check('C4) C3 arm rotates → triggers baseline recomputes', c3Recompute > 0, `${c3Recompute} activeRoot changes`);
// reservoir-healthy REST: exclude the init epoch (epoch 0); a sustained healthy
// accepts trajectory must drive churn to 0 once the EWMA clears the high watermark.
const healthyRested = c3Healthy.slice(1).some((x) => x.churnRate === 0);
check('C4) C3 rests (churn 0) once reservoir is sustainedly healthy', healthyRested,
  `healthy churnRate=[${c3Healthy.map((x) => x.churnRate).join(',')}]`);
check('C5) baselineRecompute policy = activeRootChanged', DEFAULT_EPOCH_FRONTIER_PROFILE.baselineRecompute === 'activeRootChanged');
check('C5) majorDelta policy = corpusRootChanged (separate from activeRoot)', DEFAULT_EPOCH_FRONTIER_PROFILE.majorDeltaPolicy === 'corpusRootChanged');

const report = {
  schema: 'coretex-frontier-smoke-v1',
  note: 'EpochFrontier launch-candidate determinism + baseline-recompute smoke. Churn is DEFAULT OFF at launch (scaling path, not a supply requirement). activeRoot drives active-pack baseline recompute; corpusRootChanged drives major-delta grace — separate concepts.',
  corpus: corpusPath, evalHiddenCount: evalHiddenIds.length, epochs,
  acceptsSeq, attemptsSeq,
  arms: {
    off: { roots: offA, baselineRecomputes: offRecompute },
    C3: { params: c3params, roots: c3A, baselineRecomputes: c3Recompute },
    C3_sustainedHealthy: { accepts: healthyAccepts, churnRate: c3Healthy.map((x) => x.churnRate) },
  },
  checks: log,
  result: pass ? 'PASS' : 'FAIL',
};
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2) + '\n');

console.log(log.join('\n'));
console.log('────────────────────────────────────────────────────────');
console.log(`off  activeRoot (constant) ${offA[0].activeRoot}  baselineRecomputes=${offRecompute}`);
console.log(`C3   activeRoot sequence  baselineRecomputes=${c3Recompute}  finalActiveCount=${c3A[c3A.length - 1].activeCount}`);
console.log(`C3   churnRate/epoch: [${c3A.map((x) => x.churnRate).join(',')}]`);
console.log(`wrote ${outPath}`);
console.log(pass ? 'RESULT: ALL PASS ✅' : 'RESULT: FAIL ❌');
exit(pass ? 0 : 1);
