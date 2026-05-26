#!/usr/bin/env node
/**
 * Churn-validation analyzer — applies the launch pass-criteria to C0/C1/C3 (and C2/C4 if present).
 * Per the auditor: judge C3 NOT by total accepts alone, but by reserve-efficiency + operation reuse.
 *
 * Per arm: total accepts, accepts/epoch, plateau (last-accept epoch), accepts-per-activated-unit
 * (reserve efficiency), reserve consumed, baselineRecomputes (cost), activeRoot churn variance,
 * anti-cheat (rand+hill), family-accept balance, and the ETHOS guardrail — operation-family reuse
 * ACROSS the rotating frontier (do the SAME operation families keep accepting after the active set
 * rotates? = portable operation, not one-off doc-IDs).
 *
 * Usage: node scripts/analyze-churn-validation.mjs [--dir <run-dir-prefix>] [--arms C0,C1,C3]
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = flag('dir', '/tmp');
const arms = flag('arms', 'C0,C1,C3').split(',');
const profileTag = 'coretex-evaluator-v2-dgen1-policy-r5';

const variance = (xs) => { if (xs.length < 2) return 0; const m = xs.reduce((a, b) => a + b, 0) / xs.length; return +Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length).toFixed(4); };

function analyzeArm(arm) {
  const p = resolve(base, `cval-${arm}`, `V2_LONG_HORIZON_${profileTag}_qwen.json`);
  if (!existsSync(p)) return { arm, missing: true };
  const r = JSON.parse(readFileSync(p, 'utf8'));
  const rows = r.epochs || r.rows || [];
  let cum = 0, last = 0, rand = 0, hill = 0;
  const cumArr = [], rootChanges = [], activeRoots = [];
  const famAccByEpoch = [];     // [{epoch, fam:{temporal:n,...}}] for operation-reuse
  let cumActivated = 0, finalReserve = null, prevRoot = null;
  for (const x of rows) {
    cum += x.honestAccepts; cumArr.push(cum); if (x.honestAccepts > 0) last = x.epoch;
    rand += x.randomAccepts ?? 0; hill += x.hillclimbAccepts ?? 0;
    const f = x.frontier;
    if (f) { cumActivated = f.cumulativeActivated ?? cumActivated; finalReserve = f.reserveRemaining; activeRoots.push(f.activeRoot); if (prevRoot !== null) rootChanges.push(f.activeRoot !== prevRoot ? 1 : 0); prevRoot = f.activeRoot; }
    const fam = {}; if (x.familyStats) for (const [k, s] of Object.entries(x.familyStats)) if ((s.accepts ?? 0) > 0) fam[k] = s.accepts;
    famAccByEpoch.push({ epoch: x.epoch, fam });
  }
  // operation-family reuse across the (rotating) frontier: which families accept, and do they keep
  // accepting in the LATER half (after rotation churned in fresh entities)?
  const half = Math.floor(rows.length / 2);
  const earlyFams = new Set(), lateFams = new Set();
  famAccByEpoch.forEach((e, i) => { for (const k of Object.keys(e.fam)) (i < half ? earlyFams : lateFams).add(k); });
  const reusedFams = [...earlyFams].filter((k) => lateFams.has(k));
  return {
    arm, epochs: rows.length, totalAccepts: cum, plateauLastAcceptEp: last,
    cumActivated, finalReserve, acceptsPerActivatedUnit: cumActivated ? +(cum / cumActivated).toFixed(3) : null,
    baselineRecomputes: r.summary?.baselineRecomputes ?? r.baselineRecomputes,
    antiCheat: { randomAccepts: rand, hillclimbAccepts: hill },
    activeRootChurnRate: rootChanges.length ? +(rootChanges.reduce((a, b) => a + b, 0) / rootChanges.length).toFixed(3) : 0,
    perEpochAcceptsVariance: variance(rows.map((x) => x.honestAccepts)),
    operationReuse: { earlyFamilies: [...earlyFams], lateFamilies: [...lateFams], reusedAcrossFrontier: reusedFams,
      note: 'reusedAcrossFrontier = operation families that keep ACCEPTING after the frontier rotated fresh entities (portable operation, not one-off doc-IDs)' },
    cumAcceptsPerEpoch: cumArr,
  };
}

const results = arms.map(analyzeArm).filter((a) => !a.missing);
const c0 = results.find((a) => a.arm === 'C0');
const passCriteria = {};
for (const a of results) {
  if (a.arm === 'C0') continue;
  passCriteria[a.arm] = {
    acceptsGEC0: c0 ? (a.totalAccepts >= c0.totalAccepts) : null,
    antiCheatZero: a.antiCheat.randomAccepts === 0 && a.antiCheat.hillclimbAccepts === 0,
    reserveEfficiencyVsC1: null, // filled below if C1 present
    operationReuseAcrossFrontier: a.operationReuse.reusedAcrossFrontier.length > 0,
  };
}
const c1 = results.find((a) => a.arm === 'C1'), c3 = results.find((a) => a.arm === 'C3');
if (c1 && c3 && passCriteria.C3) passCriteria.C3.reserveEfficiencyVsC1 = { c3AcceptsPerUnit: c3.acceptsPerActivatedUnit, c1AcceptsPerUnit: c1.acceptsPerActivatedUnit, c3MoreEfficient: (c3.acceptsPerActivatedUnit ?? 0) >= (c1.acceptsPerActivatedUnit ?? 0), c3ReserveSaved: (c3.finalReserve ?? 0) - (c1.finalReserve ?? 0) };

console.log(JSON.stringify({ arms: results, passCriteria }, null, 2));
