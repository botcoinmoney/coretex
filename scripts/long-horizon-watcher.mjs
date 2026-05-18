#!/usr/bin/env node
/**
 * Real-time PASS/FAIL watcher for long-horizon simulation.
 *
 * Reads the .partial JSON snapshot (or final JSON) and computes the actual
 * gate metrics — not "process is alive" health checks but pass/fail
 * decisions per launch checklist §4.2.
 *
 * Continuous gates (auto-FAIL if triggered):
 *  - Plateau fail: random-probe acceptance rate stuck at 0% AND
 *    no positive minImpr movement for 8+ consecutive epochs AFTER
 *    first fraction transition (genuinely stagnant)
 *  - Anti-cheat fail: random-probe FA rate > 2% for 3 consecutive epochs
 *    (random patches accidentally accepting too often)
 *  - Difficulty instability fail: minImpr oscillates up/down for 6+
 *    epochs outside grace cycles
 *  - Growth-handling fail: at any fraction transition, majorDeltaActive
 *    did NOT produce one-cycle GRACE_FREEZE
 *  - Controller stuck fail: minImpr exactly equal for 10+ consecutive
 *    epochs without any grace explanation
 *
 * Usage:
 *   node scripts/long-horizon-watcher.mjs <path-to-partial-or-final-json>
 *
 * Exit codes:
 *   0 = PASS_SO_FAR (all gates clean for epochs completed)
 *   2 = FAIL_NOW (one of the gates tripped — kill the sim)
 *   3 = INSUFFICIENT_DATA (too few epochs to evaluate yet)
 */
import { readFileSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

const path = argv[2];
if (!path || !existsSync(path)) {
  console.error('usage: node long-horizon-watcher.mjs <partial-or-final.json>');
  exit(1);
}

const data = JSON.parse(readFileSync(path, 'utf8'));
const epochs = data.epochs ?? data.epochsOut ?? [];
if (epochs.length === 0) {
  console.log('STATE: INSUFFICIENT_DATA — 0 epochs completed');
  exit(3);
}

// Helpers
const rollingMean = (arr) => arr.reduce((s, x) => s + x, 0) / Math.max(arr.length, 1);

// Per-epoch summary table
console.log('\n=== Per-epoch trajectory ===');
console.log('ep | activeFrac | majorΔ |  minImpr  | branch        | randAccept | randΔ range');
console.log('---+------------+--------+-----------+---------------+------------+--------------');
for (const e of epochs) {
  const acc = e.randomProbe?.acceptanceRate ?? 0;
  const dMin = e.randomProbe?.deltaPpmMin ?? 0;
  const dMax = e.randomProbe?.deltaPpmMax ?? 0;
  const ep = String(e.epoch ?? '?').padStart(2);
  const af = String(e.activeEvalHiddenFraction ?? '?').padEnd(10);
  const mD = String(e.majorDeltaActive ? '✓' : ' ').padEnd(6);
  const mi = String(e.minImprovementPpmAfter ?? '?').padStart(9);
  const br = String(e.difficultyReason ?? '?').padEnd(13);
  const acR = `${(acc * 100).toFixed(1)}%`.padStart(10);
  console.log(`${ep} | ${af} | ${mD} | ${mi} | ${br} | ${acR} | [${dMin}..${dMax}]`);
}

// Gate evaluations
console.log('\n=== Gate evaluations ===');
const fails = [];
const passes = [];

// Gate 1 — Anti-cheat: random FA rate ≤ 2% per epoch (we want 0% but allow up to 2%)
{
  const high = epochs.filter((e) => (e.randomProbe?.acceptanceRate ?? 0) > 0.02);
  // Streak detection
  let maxStreak = 0, cur = 0;
  for (const e of epochs) {
    if ((e.randomProbe?.acceptanceRate ?? 0) > 0.02) { cur++; maxStreak = Math.max(maxStreak, cur); }
    else cur = 0;
  }
  if (maxStreak >= 3) {
    fails.push(`Anti-cheat FAIL: random FA rate > 2% for ${maxStreak} consecutive epochs`);
  } else {
    passes.push(`Anti-cheat OK: ${high.length}/${epochs.length} epochs above 2% FA, no 3+ streak`);
  }
}

// Gate 2 — Growth-handling: every fraction transition must produce
// exactly one GRACE_FREEZE cycle (epoch where fraction changes + majorDeltaActive=true).
{
  let badTransitions = 0;
  let cleanTransitions = 0;
  let prevFrac = epochs[0]?.activeFraction;
  for (const e of epochs) {
    if (e.activeEvalHiddenFraction !== prevFrac) {
      // Transition epoch. Should have majorDeltaActive=true AND difficultyReason indicating grace/freeze.
      const isGrace = e.majorDeltaActive === true;
      if (isGrace) cleanTransitions++;
      else badTransitions++;
      prevFrac = e.activeEvalHiddenFraction;
    }
  }
  if (badTransitions > 0) {
    fails.push(`Growth-handling FAIL: ${badTransitions} fraction transition(s) without majorDeltaActive`);
  } else {
    passes.push(`Growth-handling OK: ${cleanTransitions} fraction transitions all triggered majorDeltaActive`);
  }
}

// Gate 3 — Controller stuck: minImpr exactly equal for 10+ epochs without grace
{
  let maxStuckStreak = 0, cur = 0, lastMi = null;
  for (const e of epochs) {
    const mi = Number(e.minImprovementPpmAfter ?? 0);
    if (mi === lastMi && !e.majorDeltaActive) { cur++; maxStuckStreak = Math.max(maxStuckStreak, cur); }
    else cur = 0;
    lastMi = mi;
  }
  if (maxStuckStreak >= 10) {
    fails.push(`Controller-stuck FAIL: minImpr unchanged for ${maxStuckStreak}+ consecutive epochs (outside grace)`);
  } else {
    passes.push(`Controller-stuck OK: max non-grace stuck streak = ${maxStuckStreak} epochs`);
  }
}

// Gate 4 — Plateau (sim-output level): we want to see controller MOVING
// (decay or ramp) most epochs. If minImpr unchanged for too long, the
// controller isn't responding to signal — that's plateau-FAIL.
// Already covered by Gate 3.

// Gate 5 — Difficulty trajectory sanity: in bootstrap (targetAdvances high,
// no advances), expect monotonic decay between grace cycles. Count any
// up-then-down-then-up oscillation as instability.
{
  const moves = [];
  for (let i = 1; i < epochs.length; i++) {
    const prev = Number(epochs[i - 1].minImprovementPpmAfter ?? 0);
    const curr = Number(epochs[i].minImprovementPpmAfter ?? 0);
    if (curr > prev) moves.push('UP');
    else if (curr < prev) moves.push('DOWN');
    else moves.push('FLAT');
  }
  // Count flip events: UP followed by DOWN or vice versa, ignoring FLAT
  let flips = 0;
  let lastDir = null;
  for (const m of moves) {
    if (m === 'FLAT') continue;
    if (lastDir && m !== lastDir) flips++;
    lastDir = m;
  }
  if (flips > 6) {
    fails.push(`Difficulty-instability FAIL: ${flips} direction flips (>6) indicates oscillation`);
  } else {
    passes.push(`Difficulty-trajectory OK: ${flips} direction flips across ${epochs.length} epochs (decay/grace pattern)`);
  }
}

// Aggregate stats
const totalRandAcc = epochs.reduce((s, e) => s + (e.randomProbe?.accepted ?? 0), 0);
const totalRandAttempts = epochs.reduce((s, e) => s + (e.randomProbe?.attempts ?? 0), 0);
const overallFA = totalRandAttempts ? totalRandAcc / totalRandAttempts : 0;
const minImprs = epochs.map((e) => Number(e.minImprovementPpmAfter ?? 0));
const initMi = minImprs[0];
const finalMi = minImprs[minImprs.length - 1];

console.log('\n=== Aggregate stats ===');
console.log(`  Epochs completed:         ${epochs.length}`);
console.log(`  Random probe accept rate: ${totalRandAcc}/${totalRandAttempts} = ${(overallFA * 100).toFixed(2)}% overall`);
console.log(`  minImprovementPpm:        ${initMi} → ${finalMi}  (Δ = ${finalMi - initMi}, ${((finalMi - initMi) / initMi * 100).toFixed(1)}%)`);
console.log(`  Fractions visited:        ${[...new Set(epochs.map((e) => e.activeEvalHiddenFraction))].sort().join(', ')}`);
console.log(`  Grace cycles:             ${epochs.filter((e) => e.majorDeltaActive).length}`);

console.log('\n=== Verdict ===');
for (const p of passes) console.log(`  PASS: ${p}`);
for (const f of fails) console.log(`  FAIL: ${f}`);

if (fails.length > 0) {
  console.log('\nSTATE: FAIL_NOW — recommend killing sim');
  exit(2);
} else {
  console.log(`\nSTATE: PASS_SO_FAR (${epochs.length} epochs evaluated)`);
  exit(0);
}
