/**
 * Shared V2 difficulty-controller simulation core.
 *
 * Single source of truth for the controller-DYNAMICS simulation used by both the
 * single-run harness (`simulate-v2-difficulty.mjs`) and the broad CPU sweep driver
 * (`sweep-v2-controller.mjs`). Pure arithmetic over the OWNER-SCOPED V2 growth
 * trajectory — NO scoring, NO Qwen. The owner-growth eval_hidden trajectory depends
 * only on (corpus, owner-order seed, owner-fractions, epochs); the controller params /
 * scenario / target / threshold are swept on top of a precomputed trajectory, so the
 * sweep loads each (large) corpus exactly once.
 *
 * The controller itself is imported from dist (`nextMinImprovementPpm`, `isMajorDelta`,
 * MIN/MAX_IMPROVEMENT_PPM) — this module never re-implements the protocol logic.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { distIndex } from '../_repo-root.mjs';

const { nextMinImprovementPpm, isMajorDelta, MIN_IMPROVEMENT_PPM, MAX_IMPROVEMENT_PPM } = await import(distIndex);
export const MINP = Number(MIN_IMPROVEMENT_PPM);
export const MAXP = Number(MAX_IMPROVEMENT_PPM);

export const SCENARIOS = [
  'steady-target', 'stalled', 'cooling', 'alternating-burst', 'burst100',
  'honest-improver-decay', 'adversarial-random-only', 'mixed-honest-adversarial',
];

/** Scenario observed-advances / quality-attempts shape — MUST match simulate-v2-difficulty.mjs. */
export function scenarioCounts(kind, epoch, targetAdvances) {
  switch (kind) {
    case 'steady-target': return { observedAdvances: targetAdvances, qualityAttempts: targetAdvances * 2 };
    case 'burst100': return { observedAdvances: 100, qualityAttempts: 300 };
    case 'alternating-burst': return epoch % 2 === 0
      ? { observedAdvances: targetAdvances, qualityAttempts: targetAdvances * 2 }
      : { observedAdvances: 100, qualityAttempts: 300 };
    case 'stalled': return { observedAdvances: 0, qualityAttempts: targetAdvances * 6 };
    case 'cooling': return { observedAdvances: 0, qualityAttempts: 0 };
    case 'honest-improver-decay': {
      const adv = Math.max(0, targetAdvances - Math.floor((epoch - 1) / 8));
      return { observedAdvances: adv, qualityAttempts: targetAdvances * 6 };
    }
    case 'adversarial-random-only': return { observedAdvances: 0, qualityAttempts: 0 };
    case 'mixed-honest-adversarial': return { observedAdvances: Math.max(1, Math.floor(targetAdvances / 2)), qualityAttempts: targetAdvances * 4 };
    default: throw new Error(`unknown scenario ${kind}`);
  }
}

function hseed(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }

/**
 * Load the owner-scoped eval_hidden-by-owner map from a V2 logical corpus.
 * @returns {{ownersAll:string[], evalHiddenByOwner:Map<string,number>, scopedEvalHidden:number, pooledEvalHidden:number, phase:string}}
 */
export function loadOwnerCorpus(corpusPath) {
  const logical = JSON.parse(readFileSync(resolve(corpusPath), 'utf8'));
  const scoped = logical.queries.filter((q) => !q.abstain && (q.split ?? 'eval_hidden') === 'eval_hidden' && q.ownerScoped === true && q.ownerEntityId);
  const pooled = logical.queries.filter((q) => !q.abstain && (q.split ?? 'eval_hidden') === 'eval_hidden' && q.ownerScoped !== true);
  const evalHiddenByOwner = new Map();
  for (const q of scoped) evalHiddenByOwner.set(q.ownerEntityId, (evalHiddenByOwner.get(q.ownerEntityId) ?? 0) + 1);
  return { ownersAll: [...evalHiddenByOwner.keys()], evalHiddenByOwner, scopedEvalHidden: scoped.length, pooledEvalHidden: pooled.length, phase: logical.phase ?? 'p' };
}

/**
 * Precompute the active-scoped-eval_hidden trajectory for one owner-order seed.
 * Returns an array (length `epochs`) of { frac, activeEH }.
 */
export function computeTrajectory({ ownersAll, evalHiddenByOwner, orderSeed, ownerFractions, epochsPerFraction, epochs }) {
  const owners = [...ownersAll].map((o) => [o, hseed(`${orderSeed}:${o}`)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
  const activeScopedCount = (frac) => { const k = Math.max(1, Math.floor(owners.length * frac)); let n = 0; for (let i = 0; i < k; i++) n += evalHiddenByOwner.get(owners[i]) ?? 0; return n; };
  const traj = [];
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const fracIdx = Math.min(ownerFractions.length - 1, Math.floor((epoch - 1) / Math.max(1, epochsPerFraction)));
    const frac = ownerFractions[fracIdx] ?? 1;
    traj.push({ frac, activeEH: activeScopedCount(frac) });
  }
  return traj;
}

/**
 * Run the controller over one precomputed trajectory under a given scenario +
 * controller config. Mirrors simulate-v2-difficulty.mjs `runOrdering` exactly.
 * @returns per-ordering metrics object.
 */
export function simulateOrdering({ trajectory, scenario, targetAdvances, majorDeltaThreshold, startFloorPpm, controllerParams = {}, effMin, effMax }) {
  let current = BigInt(startFloorPpm), prevEH = 0;
  let clampHits = 0, stagnant = 0, maxStagnant = 0, graceFreezes = 0, ramps = 0, decays = 0;
  let maxClampWhileAdvancing = 0, minClampWhileStalled = 0, moved = 0, growthEpochs = 0;
  const EFF_MIN = effMin ?? MINP, EFF_MAX = effMax ?? MAXP;
  let lastPpm = Number(current), minPpm = Number(current), maxPpm = Number(current);
  // Oscillation = sign flips in the epoch-over-epoch direction of change (excludes
  // grace freezes and no-change epochs). Pathological controllers see-saw; a sound
  // one trends and settles.
  let directionChanges = 0, lastDir = 0;
  for (let epoch = 1; epoch <= trajectory.length; epoch++) {
    const { activeEH } = trajectory[epoch - 1];
    const majorDeltaActive = majorDeltaThreshold > 0 ? isMajorDelta(activeEH, prevEH, majorDeltaThreshold) : false;
    prevEH = activeEH;
    if (majorDeltaActive) growthEpochs++;
    const { observedAdvances, qualityAttempts } = scenarioCounts(scenario, epoch, targetAdvances);
    const d = nextMinImprovementPpm({ current, observedAdvances, targetAdvances, qualityAttempts, majorDeltaActive, ...controllerParams });
    if (d.clamped) clampHits++;
    if (d.reason === 'major_delta_grace') graceFreezes++;
    if (d.reason === 'ramp_up') ramps++;
    if (d.reason === 'decay') decays++;
    const after = Number(d.next);
    const cur = Number(current);
    if (d.next === current) { stagnant++; if (stagnant > maxStagnant) maxStagnant = stagnant; }
    else {
      stagnant = 0; moved++;
      if (d.reason !== 'major_delta_grace') {
        const dir = after > cur ? 1 : -1;
        if (lastDir !== 0 && dir !== lastDir) directionChanges++;
        lastDir = dir;
      }
    }
    if (after === EFF_MAX && observedAdvances > targetAdvances) maxClampWhileAdvancing++;
    if (after === EFF_MIN && observedAdvances === 0) minClampWhileStalled++;
    lastPpm = after; if (after < minPpm) minPpm = after; if (after > maxPpm) maxPpm = after;
    current = d.next;
  }
  return { lastPpm, minPpm, maxPpm, clampHits, maxConsecutiveUnchangedEpochs: maxStagnant, graceFreezes, ramps, decays,
    movedEpochs: moved, ownerGrowthEpochs: growthEpochs, maxClampWhileAdvancing, minClampWhileStalled, directionChanges };
}
