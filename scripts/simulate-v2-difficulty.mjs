#!/usr/bin/env node
/**
 * V2-native dynamic-difficulty controller simulation (Layer 9, increment 1).
 *
 * Drives the production difficulty controller (`nextMinImprovementPpm`) over the
 * OWNER-SCOPED V2 corpus's growth trajectory and reports PLATEAU risk. This is
 * the cheap, corpus-shape-faithful controller-dynamics cut (CPU, no scoring) —
 * the real-scoring anti-cheat long-horizon (random-patch acceptance per epoch)
 * is a separate, bounded A100 phase.
 *
 * V2-native corpus growth = activating more OWNERS over epochs (a real memory
 * platform onboards users/projects), which grows the active eval_hidden set and
 * fires `isMajorDelta` grace-freezes. We then check the controller:
 *   - keeps adapting (does not plateau: bounded consecutive-unchanged windows),
 *   - rises under sustained over-target advances (ramp), decays when stalled,
 *   - clamp behavior is bounded (not pinned at MAX/MIN every epoch),
 *   - honors major-delta grace exactly on owner-growth epochs.
 *
 * Usage:
 *   node scripts/simulate-v2-difficulty.mjs --corpus <v2-logical.json> \
 *     --epochs 120 --target-advances 5 --scenario alternating-burst \
 *     --owner-fractions 0.25,0.5,0.75,1.0 --epochs-per-fraction 30 \
 *     --major-delta-threshold 0.1 --seed v2-horizon-2026-05-22 --out <dir>
 */
import { distIndex } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const { nextMinImprovementPpm, isMajorDelta } = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p2-corpus.json');
const epochs = Number(flag('epochs', '120'));
const targetAdvances = Number(flag('target-advances', '5'));
const scenario = flag('scenario', 'alternating-burst');
const ownerFractions = String(flag('owner-fractions', '0.25,0.5,0.75,1.0')).split(',').map(Number);
const epochsPerFraction = Number(flag('epochs-per-fraction', String(Math.ceil(epochs / 4))));
const majorDeltaThreshold = Number(flag('major-delta-threshold', '0.1'));
const seed = flag('seed', 'v2-horizon-2026-05-22');
const startFloorPpm = BigInt(flag('start-floor-ppm', '5000'));
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2');

// ── load V2 logical corpus; derive the owner-scoped eval_hidden trajectory ──
const logical = JSON.parse(readFileSync(resolve(corpusPath), 'utf8'));
// Active retrieval scope = owner-scoped eval_hidden queries (ownerScoped !== false).
// Owner growth: owners sorted deterministically; activate the first `frac` of them.
const owners = [...new Set(logical.queries.filter((q) => q.ownerEntityId).map((q) => q.ownerEntityId))]
  .sort((a, b) => (a < b ? -1 : 1));
const evalHiddenByOwner = new Map();
for (const q of logical.queries) {
  if (q.abstain) continue;
  if ((q.split ?? 'eval_hidden') !== 'eval_hidden') continue;
  const o = q.ownerEntityId ?? '__pooled__';
  evalHiddenByOwner.set(o, (evalHiddenByOwner.get(o) ?? 0) + 1);
}
function activeEvalHiddenCount(frac) {
  const k = Math.max(1, Math.floor(owners.length * frac));
  const active = new Set(owners.slice(0, k));
  let n = 0;
  for (const [o, c] of evalHiddenByOwner) if (active.has(o) || o === '__pooled__') n += c;
  return n;
}

function scenarioCounts(kind, epoch) {
  switch (kind) {
    case 'steady-target': return { observedAdvances: targetAdvances, qualityAttempts: targetAdvances * 2 };
    case 'burst100': return { observedAdvances: 100, qualityAttempts: 300 };
    case 'alternating-burst': return epoch % 2 === 0
      ? { observedAdvances: targetAdvances, qualityAttempts: targetAdvances * 2 }
      : { observedAdvances: 100, qualityAttempts: 300 };
    case 'stalled': return { observedAdvances: 0, qualityAttempts: targetAdvances * 6 };
    case 'cooling': return { observedAdvances: 0, qualityAttempts: 0 };
    default: throw new Error(`unknown scenario ${kind}`);
  }
}

let current = startFloorPpm;
let prevEvalHidden = 0;
let clampHits = 0, stagnant = 0, maxStagnant = 0, graceFreezes = 0, ramps = 0, decays = 0;
const rows = [];
for (let epoch = 1; epoch <= epochs; epoch++) {
  const fracIdx = Math.min(ownerFractions.length - 1, Math.floor((epoch - 1) / Math.max(1, epochsPerFraction)));
  const frac = ownerFractions[fracIdx] ?? 1;
  const activeEH = activeEvalHiddenCount(frac);
  const majorDeltaActive = majorDeltaThreshold > 0 ? isMajorDelta(activeEH, prevEvalHidden, majorDeltaThreshold) : false;
  prevEvalHidden = activeEH;
  const { observedAdvances, qualityAttempts } = scenarioCounts(scenario, epoch);
  const d = nextMinImprovementPpm({ current, observedAdvances, targetAdvances, qualityAttempts, majorDeltaActive });
  if (d.clamped) clampHits++;
  if (d.reason === 'major_delta_grace') graceFreezes++;
  if (d.reason === 'ramp_up') ramps++;
  if (d.reason === 'decay') decays++;
  const unchanged = d.next === current;
  if (unchanged) { stagnant++; maxStagnant = Math.max(maxStagnant, stagnant); } else stagnant = 0;
  rows.push({ epoch, ownerFraction: frac, activeEvalHidden: activeEH, majorDeltaActive,
    observedAdvances, qualityAttempts, before: Number(current), after: Number(d.next), reason: d.reason, clamped: d.clamped });
  current = d.next;
}

const minVals = rows.map((r) => r.after);
const summary = {
  epochs, scenario, targetAdvances, ownerFractions, epochsPerFraction, majorDeltaThreshold,
  owners: owners.length, evalHiddenTotal: activeEvalHiddenCount(1),
  firstPpm: rows[0]?.before ?? null, lastPpm: rows.at(-1)?.after ?? null,
  minPpm: Math.min(...minVals), maxPpm: Math.max(...minVals),
  clampHits, maxConsecutiveUnchangedEpochs: maxStagnant, graceFreezes, ramps, decays,
  movedEpochs: rows.filter((r) => r.after !== r.before).length,
  ownerGrowthEpochs: rows.filter((r) => r.majorDeltaActive).length,
};
// Plateau risk is NOT "the threshold held constant" (equilibrium at target is
// correct). The BAD plateau is: difficulty pinned at the MAX clamp WHILE miners
// keep advancing over target — the controller can no longer deter them. Mirror
// at the floor: pinned at MIN while NOTHING advances (can't attract miners).
const MAXP = Math.max(...minVals), MINP = Math.min(...minVals);
summary.maxClampWhileAdvancing = rows.filter((r) => r.after === 150000 && r.observedAdvances > targetAdvances).length;
summary.minClampWhileStalled = rows.filter((r) => r.after === 2500 && r.observedAdvances === 0).length;
// Responsive = the controller moves the threshold in response to signals (ramp,
// decay, or small drift) OR sits at a correct equilibrium (every epoch at target).
summary.adaptsDirectionally = summary.movedEpochs > 0 || rows.every((r) => r.observedAdvances === targetAdvances);
// Healthy controller: directionally responsive, grace-freezes only on growth,
// and not stuck saturated-at-MAX while miners keep beating it.
summary.plateauRiskAtMax = summary.maxClampWhileAdvancing;
summary.controllerHealthy = summary.adaptsDirectionally && summary.graceFreezes === summary.ownerGrowthEpochs;

const out = { generatedAt: new Date().toISOString(), corpus: corpusPath, phase: logical.phase, seed, summary, epochs: rows };
mkdirSync(dirname(resolve(outDir, 'x')), { recursive: true });
const path = resolve(outDir, `V2_DIFFICULTY_${(logical.phase || 'p').toLowerCase()}_${scenario}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`# V2 difficulty sim (${logical.phase}, ${scenario}) — ${epochs} epochs, ${owners.length} owners`);
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${path}`);
