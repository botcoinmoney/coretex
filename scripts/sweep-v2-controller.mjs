#!/usr/bin/env node
/**
 * Phase 2 — CPU controller-shape sweep (broad, no Qwen).
 *
 * Sweeps the difficulty-controller parameter space over the OWNER-SCOPED V2 growth
 * trajectory and applies the runbook's CPU selection criteria, emitting a ranked
 * Pareto summary of controller candidates to carry into the A100 response-surface
 * phase. Uses the SHARED controller-sim core (`lib/v2-controller-sim.mjs`), which
 * imports the real protocol controller from dist — no re-implementation.
 *
 * Key efficiency: the owner-growth eval_hidden trajectory depends only on
 * (corpus, owner-order seed, fractions, epochs). It is precomputed ONCE per seed,
 * then every (controller-params × scenario × target × majorDelta) cell is swept
 * in-memory — so the large P2/P3 corpora are parsed exactly once.
 *
 * Grid defaults follow DIFFICULTY_LONGEVITY_CALIBRATION_RUNBOOK.md Phase 2.
 *
 * Usage:
 *   node --max-old-space-size=16384 scripts/sweep-v2-controller.mjs \
 *     --corpus release/calibration/2026-05-21-memory-corpus-v2/p2-corpus.json \
 *     --epochs 240 --order-seeds 16 --out release/calibration/2026-05-21-memory-corpus-v2/p3-rework
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { repoRoot } from './_repo-root.mjs';
import { loadOwnerCorpus, computeTrajectory, simulateOrdering, SCENARIOS, MINP, MAXP } from './lib/v2-controller-sim.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const list = (s) => String(s).split(',').filter(Boolean).map(Number);
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p2-corpus.json');
const epochs = Number(flag('epochs', '240'));
const numSeeds = Number(flag('order-seeds', '16'));
const ownerFractions = list(flag('owner-fractions', '0.25,0.5,0.75,1.0'));
const epochsPerFraction = Number(flag('epochs-per-fraction', String(Math.ceil(epochs / ownerFractions.length))));
const startFloorPpm = Number(flag('start-floor-ppm', '5000'));
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/p3-rework');
// Grid (runbook Phase 2)
const targetsGrid = list(flag('targets', '1,2,4,8'));
const majorDeltaGrid = list(flag('major-deltas', '5,10,20,40,80'));
const rampGrid = list(flag('ramps', '1.25,1.5,1.75'));
const decayGrid = list(flag('decays', '0.80,0.85,0.90'));
const driftGrid = list(flag('drifts', '1.02,1.05,1.08'));
const qualHighGrid = list(flag('quality-high-mults', '2,4,6'));
const ceilingGrid = list(flag('ceilings', '150000,200000,300000'));

const seeds = Array.from({ length: numSeeds }, (_, i) => `s${i + 1}`);
const t0 = Date.now();
console.error(`[sweep] loading ${corpusPath} ...`);
const oc = loadOwnerCorpus(corpusPath);
console.error(`[sweep] ${oc.phase}: ${oc.ownersAll.length} scoped owners, ${oc.scopedEvalHidden} scoped eval_hidden, ${oc.pooledEvalHidden} pooled`);
// Precompute trajectories: depend only on (seed, fractions, epochs).
const trajectories = seeds.map((s) => computeTrajectory({ ownersAll: oc.ownersAll, evalHiddenByOwner: oc.evalHiddenByOwner, orderSeed: s, ownerFractions, epochsPerFraction, epochs }));
console.error(`[sweep] precomputed ${trajectories.length} owner-order trajectories (${epochs} epochs each)`);

// Scenario classes for the selection criteria.
const BURST = new Set(['burst100', 'alternating-burst']);                 // legitimately ramp/grace-oscillate
const STABLE = new Set(['steady-target', 'cooling', 'honest-improver-decay']); // must NOT see-saw
const std = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const candidates = [];
let cellCount = 0;
for (const ramp of rampGrid) for (const decay of decayGrid) for (const drift of driftGrid) for (const qhm of qualHighGrid) for (const ceiling of ceilingGrid) {
  const controllerParams = { rampUpMaxRatio: ramp, decayRatio: decay, smallDriftRatio: drift,
    // qualityHighThreshold is qhm*targetAdvances → set per-target inside the loop.
  };
  const effMax = ceiling, effMin = MINP;
  // Aggregates across all conditions for this controller candidate.
  let graceExactAlways = true;
  let plateauRiskBurst = 0;          // max maxClampWhileAdvancing over burst scenarios
  let oscillationStable = 0;         // max directionChanges over STABLE scenarios
  let collapseUnderActivity = 0;     // max minClampWhileStalled where scenario has activity (should stay 0)
  const seedCVs = [];                // per-condition CV of lastPpm across seeds
  let worstStagnant = 0;
  for (const scenario of SCENARIOS) for (const target of targetsGrid) for (const md of majorDeltaGrid) {
    const cp = { ...controllerParams, qualityHighThreshold: qhm * target, maxClampPpm: BigInt(ceiling) };
    const lastPpms = [];
    for (const traj of trajectories) {
      const r = simulateOrdering({ trajectory: traj, scenario, targetAdvances: target, majorDeltaThreshold: md, startFloorPpm, controllerParams: cp, effMin, effMax });
      if (r.graceFreezes !== r.ownerGrowthEpochs) graceExactAlways = false;
      if (BURST.has(scenario)) plateauRiskBurst = Math.max(plateauRiskBurst, r.maxClampWhileAdvancing);
      if (STABLE.has(scenario)) oscillationStable = Math.max(oscillationStable, r.directionChanges);
      // "healthy activity" scenarios: advances present (steady/mixed). minClampWhileStalled
      // only fires on observedAdvances===0, so any nonzero here is a real collapse-under-activity.
      if (scenario === 'steady-target' || scenario === 'mixed-honest-adversarial') collapseUnderActivity = Math.max(collapseUnderActivity, r.minClampWhileStalled);
      worstStagnant = Math.max(worstStagnant, r.maxConsecutiveUnchangedEpochs);
      lastPpms.push(r.lastPpm);
      cellCount++;
    }
    const m = mean(lastPpms);
    seedCVs.push(m > 0 ? std(lastPpms) / m : 0);
  }
  const seedInstability = Math.max(...seedCVs);
  candidates.push({
    rampUpMaxRatio: ramp, decayRatio: decay, smallDriftRatio: drift, qualityHighThresholdMult: qhm, ceilingPpm: ceiling,
    graceExactAlways, plateauRiskBurst, oscillationStable, collapseUnderActivity,
    seedInstability: +seedInstability.toFixed(4), worstConsecutiveUnchanged: worstStagnant,
  });
}
console.error(`[sweep] swept ${candidates.length} controller candidates over ${cellCount} orderings in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Selection: hard constraint graceExactAlways; then Pareto-minimize
// (plateauRiskBurst, oscillationStable, seedInstability). collapseUnderActivity must be 0.
const eligible = candidates.filter((c) => c.graceExactAlways && c.collapseUnderActivity === 0);
const AXES = ['plateauRiskBurst', 'oscillationStable', 'seedInstability'];
const dominates = (a, b) => AXES.every((k) => a[k] <= b[k]) && AXES.some((k) => a[k] < b[k]);
const pareto = eligible.filter((c) => !eligible.some((o) => o !== c && dominates(o, c)));
// Rank for readability: normalized weighted sum (plateau weighted highest), ceiling as tie-break (prefer lower).
const norm = (k) => { const vs = eligible.map((c) => c[k]); const mx = Math.max(...vs, 1e-9); return (c) => c[k] / mx; };
const nPlateau = norm('plateauRiskBurst'), nOsc = norm('oscillationStable'), nInst = norm('seedInstability');
const rank = (c) => 0.5 * nPlateau(c) + 0.3 * nOsc(c) + 0.2 * nInst(c) + 0.01 * (c.ceilingPpm / 300000);
const ranked = [...eligible].sort((a, b) => rank(a) - rank(b) || a.ceilingPpm - b.ceilingPpm);
const paretoRanked = [...pareto].sort((a, b) => rank(a) - rank(b) || a.ceilingPpm - b.ceilingPpm);

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();
const out = {
  generatedAt: new Date().toISOString(),
  provenance: { corpus: corpusPath, phase: oc.phase, gitSha, dirtyTree, epochs, orderSeeds: numSeeds, ownerFractions, epochsPerFraction, startFloorPpm,
    grid: { scenarios: SCENARIOS, targets: targetsGrid, majorDeltas: majorDeltaGrid, ramps: rampGrid, decays: decayGrid, drifts: driftGrid, qualityHighMults: qualHighGrid, ceilings: ceilingGrid },
    pinnedClamp: { minPpm: MINP, maxPpm: MAXP }, scopedOwners: oc.ownersAll.length, scopedEvalHidden: oc.scopedEvalHidden },
  summary: {
    candidates: candidates.length, eligibleAfterHardConstraints: eligible.length, paretoFront: pareto.length,
    selectionCriteria: 'hard: graceExactAlways && collapseUnderActivity==0; pareto-min: [plateauRiskBurst, oscillationStable, seedInstability]; rank: 0.5*plateau+0.3*osc+0.2*instab (+ceiling tiebreak)',
    bestCandidate: paretoRanked[0] ?? ranked[0] ?? null,
    minPlateauRiskBurstAchievable: Math.min(...eligible.map((c) => c.plateauRiskBurst)),
  },
  paretoRanked,
  topRanked: ranked.slice(0, 20),
};
mkdirSync(dirname(resolve(repoRoot, outDir, 'x')), { recursive: true });
const path = resolve(repoRoot, outDir, `V2_CONTROLLER_SWEEP_${oc.phase.toLowerCase()}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log(`wrote ${path}`);
