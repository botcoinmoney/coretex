#!/usr/bin/env node
/**
 * Phase 4 — CPU Monte Carlo long-horizon simulator (100s–1000s of advances).
 *
 * Drives the REAL protocol controller (`nextMinImprovementPpm` from dist) over
 * 500–2000 epochs, sampling patch acceptance from the EMPIRICAL Phase 3 response
 * curves (`measure-v2-response-surface.mjs` artifacts). This is the only practical
 * way to test months of epochs / hundreds–thousands of state advances without
 * burning the A100 continuously: the expensive real-Qwen acceptance probabilities
 * are measured once (Phase 3) and replayed cheaply here.
 *
 * Population model: each honest proposal is accepted with probability p_honest_family(T)
 * read from the response curve (the curve aggregates the honest strength-spread, i.e.
 * a population of honest miners of varying quality). random/hillclimb likewise. Only
 * accepted honest advances feed the controller (observedAdvances). Baseline recompute
 * is forced on major-delta (owner-growth) epochs.
 *
 * Usage:
 *   node scripts/montecarlo-v2-longhorizon.mjs \
 *     --curves release/.../V2_RESPONSE_SURFACE_p1_a5_qwen.json,...p2...,...p3... \
 *     --epochs 500,1000,2000 --mc-seeds 8 --out release/.../p3-rework
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const { nextMinImprovementPpm, isMajorDelta, MIN_IMPROVEMENT_PPM, MAX_IMPROVEMENT_PPM } = await import(distIndex);
const MINP = Number(MIN_IMPROVEMENT_PPM), MAXP = Number(MAX_IMPROVEMENT_PPM);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const list = (s) => String(s).split(',').filter(Boolean);
const curvePaths = list(flag('curves', ''));
const epochsGrid = list(flag('epochs', '500,1000,2000')).map(Number);
const mcSeeds = Number(flag('mc-seeds', '8'));
const targetAdvances = Number(flag('target-advances', '2'));
const replayTol = Number(flag('replay-tol', '250'));
const variancePpm = Number(flag('variance-ppm', '0'));
const honestPerEpoch = Number(flag('honest-per-epoch', '6'));
const randomPerEpoch = Number(flag('random-per-epoch', '12'));
const hillclimbPerEpoch = Number(flag('hillclimb-per-epoch', '6'));
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/p3-rework');
const tag = flag('tag', undefined);

// ── controller candidates (Phase 2 shortlist C0–C3) ──
const CONTROLLERS = {
  C0: { rampUpMaxRatio: 1.5, decayRatio: 0.85, smallDriftRatio: 1.05, qualityHighThresholdMult: 4, ceilingPpm: 150000 },   // pinned-default CONTROL
  C1: { rampUpMaxRatio: 1.25, decayRatio: 0.85, smallDriftRatio: 1.05, qualityHighThresholdMult: 4, ceilingPpm: 150000 },  // CPU-best @ pinned ceiling
  C2: { rampUpMaxRatio: 1.25, decayRatio: 0.85, smallDriftRatio: 1.05, qualityHighThresholdMult: 4, ceilingPpm: 300000 },  // headroom
  C3: { rampUpMaxRatio: 1.25, decayRatio: 0.80, smallDriftRatio: 1.05, qualityHighThresholdMult: 2, ceilingPpm: 200000 },  // aggressive recovery
};

// ── load empirical response curves, build interpolators p(T) per population/family ──
function loadCurve(path) {
  const j = JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
  const pts = j.curve.map((r) => ({ T: r.threshold, honest_relation: r.honest_relation, honest_temporal: r.honest_temporal, honest_mixed: r.honest_mixed, honest_any: r.honest_any, random: r.random, hillclimb: r.hillclimb }));
  pts.sort((a, b) => a.T - b.T);
  // honest "potential": fraction acceptable at the EASIEST threshold (supply of real signal).
  const easiest = pts[0];
  // real-gain fraction: among honest patches that pass floors, fraction whose accepted gain is real retrieval/temporal/relation.
  const honestPatches = j.honestPatches ?? [];
  const realGainFrac = honestPatches.length ? honestPatches.filter((h) => h.acceptedAtMin && (h.comp.retrieval > 0 || h.comp.temporal > 0 || h.comp.relation > 0)).length / Math.max(1, honestPatches.filter((h) => h.acceptedAtMin).length) : 1;
  return { phase: j.provenance.phase, pts, easiest, realGainFrac, alpha: j.provenance.alpha };
}
const interp = (pts, key) => (T) => {
  if (T <= pts[0].T) return pts[0][key] ?? 0;
  if (T >= pts[pts.length - 1].T) return pts[pts.length - 1][key] ?? 0;
  for (let i = 1; i < pts.length; i++) if (T <= pts[i].T) { const a = pts[i - 1], b = pts[i]; const w = (T - a.T) / (b.T - a.T); return (a[key] ?? 0) + w * ((b[key] ?? 0) - (a[key] ?? 0)); }
  return 0;
};

// ── growth schedules: activeEvalHidden(epoch) over [0,1] owner fraction × maxEH ──
function growthSchedule(kind, epoch, epochs, maxEH) {
  const t = epoch / epochs;
  let frac;
  switch (kind) {
    case 'smooth': frac = t; break;
    case 'burst': frac = Math.min(1, Math.floor(t * 5) / 5 + (t * 5 % 1 > 0.8 ? 0.2 : 0)); break; // step jumps every 20%
    case 'pause-then-jump': frac = t < 0.5 ? 0.2 : (t < 0.55 ? 0.2 + (t - 0.5) / 0.05 * 0.8 : 1.0); break; // flat then jump at mid
    case 'late-heavy': frac = t < 0.7 ? t * 0.2 / 0.7 : 0.2 + (t - 0.7) / 0.3 * 0.8; break; // most growth in last 30%
    default: frac = t;
  }
  return Math.max(1, Math.round(Math.min(1, frac) * maxEH));
}
const GROWTH = ['smooth', 'burst', 'pause-then-jump', 'late-heavy'];

// ── miner populations: per-epoch proposal counts + a quality multiplier on p_honest ──
// qMult scales the effective acceptance probability (a weak population proposes patches
// at the low end of the strength-spread; the curve's honest_any already encodes the
// spread, so qMult tilts it). adaptive raises hillclimb pressure over time.
function population(kind, epoch, epochs) {
  switch (kind) {
    case 'weak-rare-strong': return { honest: honestPerEpoch, qMult: 0.4, random: randomPerEpoch, hillclimb: hillclimbPerEpoch, strongBurst: (epoch % 50 === 0 ? 1.5 : 0) };
    case 'mixed-honest': return { honest: honestPerEpoch, qMult: 1.0, random: randomPerEpoch, hillclimb: hillclimbPerEpoch, strongBurst: 0 };
    case 'strong-burst': return { honest: honestPerEpoch * 2, qMult: 1.3, random: randomPerEpoch, hillclimb: hillclimbPerEpoch, strongBurst: 0 };
    case 'adaptive-hillclimber': return { honest: honestPerEpoch, qMult: 1.0, random: randomPerEpoch, hillclimb: hillclimbPerEpoch + Math.floor(epoch / epochs * hillclimbPerEpoch * 3), strongBurst: 0 };
    default: return { honest: honestPerEpoch, qMult: 1.0, random: randomPerEpoch, hillclimb: hillclimbPerEpoch, strongBurst: 0 };
  }
}
const POPULATIONS = ['weak-rare-strong', 'mixed-honest', 'strong-burst', 'adaptive-hillclimber'];

function mulberry32(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function hseed(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const binom = (n, p, rand) => { let k = 0; for (let i = 0; i < n; i++) if (rand() < p) k++; return k; };

const FAMILIES = ['relation', 'temporal', 'mixed'];

/** One Monte Carlo run: returns the runbook Phase 4 metrics. */
function simulate({ curve, controller, epochs, growth, pop, majorDeltaThreshold, mcSeed }) {
  const rand = mulberry32(hseed(`${mcSeed}:${growth}:${pop}`));
  const pHonest = Object.fromEntries(FAMILIES.map((f) => [f, interp(curve.pts, `honest_${f}`)]));
  const pHonestAny = interp(curve.pts, 'honest_any');
  const pRandom = interp(curve.pts, 'random');
  const pHill = interp(curve.pts, 'hillclimb');
  const ceiling = controller.ceilingPpm;
  const cp = { rampUpMaxRatio: controller.rampUpMaxRatio, decayRatio: controller.decayRatio, smallDriftRatio: controller.smallDriftRatio,
    qualityHighThreshold: controller.qualityHighThresholdMult * targetAdvances, maxClampPpm: BigInt(ceiling) };
  const maxEH = 5000; // owner-scope eval_hidden ceiling (P3-scale); shape, not absolute, drives grace.

  let current = BigInt(5000), prevEH = 0;
  let advancesTotal = 0, cumGainPpm = 0;
  let timeAtMaxWhilePotential = 0, timeAtMinWhileQuality = 0;
  let drought = 0, longestDrought = 0;
  let epochsSinceBaselineAfterGrowth = 0, longestBaselineLag = 0, pendingBaseline = false;
  let randomAcceptsTotal = 0, hillAcceptsTotal = 0, attemptsRandom = 0, attemptsHill = 0;
  const familyAccepts = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  let plateauOnset = null;
  const distFromTarget = [];

  for (let epoch = 1; epoch <= epochs; epoch++) {
    const activeEH = growthSchedule(growth, epoch, epochs, maxEH);
    const majorDeltaActive = isMajorDelta(activeEH, prevEH, majorDeltaThreshold); prevEH = activeEH;
    if (majorDeltaActive) { pendingBaseline = true; epochsSinceBaselineAfterGrowth = 0; }
    // baseline recompute happens THIS epoch on grace (production rule); lag = epochs grace was pending.
    if (pendingBaseline) { longestBaselineLag = Math.max(longestBaselineLag, epochsSinceBaselineAfterGrowth); pendingBaseline = false; }
    else if (epochsSinceBaselineAfterGrowth >= 0) epochsSinceBaselineAfterGrowth++;

    const T = Number(current);
    const P = population(pop, epoch, epochs);
    // honest accepts per family (sampled from empirical curve × quality multiplier, capped at 1).
    let honestAccepts = 0; const accFam = {};
    for (const f of FAMILIES) {
      const nf = Math.round(P.honest / FAMILIES.length) + (P.strongBurst > 0 ? 1 : 0);
      const p = Math.min(1, (pHonest[f](T)) * (P.qMult + P.strongBurst));
      const k = binom(nf, p, rand);
      accFam[f] = k; familyAccepts[f] += k; honestAccepts += k;
    }
    advancesTotal += honestAccepts;
    // real-gain accounting: fraction of honest accepts that are genuine retrieval/temporal/relation gains.
    cumGainPpm += honestAccepts * curve.realGainFrac * Math.max(0, T); // proxy: each accept clears the threshold T of real gain
    // adversarial accepts (anti-cheat) — must remain ~0.
    const ra = binom(P.random, Math.min(1, pRandom(T)), rand); randomAcceptsTotal += ra; attemptsRandom += P.random;
    const ha = binom(P.hillclimb, Math.min(1, pHill(T)), rand); hillAcceptsTotal += ha; attemptsHill += P.hillclimb;

    // honest POTENTIAL at this epoch = supply at the easiest threshold (independent of T).
    const potential = P.honest * Math.min(1, pHonestAny(curve.pts[0].T) * (P.qMult + P.strongBurst));
    const atMax = T >= ceiling - 1;
    const atMin = T <= MINP + 1;
    if (atMax && potential > targetAdvances && honestAccepts < targetAdvances) { timeAtMaxWhilePotential++; if (plateauOnset === null) plateauOnset = epoch; }
    if (atMin && (P.honest * 2) > 0 && honestAccepts === 0 && potential > 0) timeAtMinWhileQuality++;
    if (honestAccepts === 0) { drought++; longestDrought = Math.max(longestDrought, drought); } else drought = 0;
    distFromTarget.push(Math.abs(honestAccepts - targetAdvances));

    // controller step (honest advances feed it; grace freezes on major-delta).
    const d = nextMinImprovementPpm({ current, observedAdvances: honestAccepts, targetAdvances, qualityAttempts: P.honest, majorDeltaActive, ...cp });
    current = d.next;
  }
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const familyEntropy = (() => { const tot = Object.values(familyAccepts).reduce((a, b) => a + b, 0); if (!tot) return 0; let h = 0; for (const f of FAMILIES) { const p = familyAccepts[f] / tot; if (p > 0) h -= p * Math.log2(p); } return +(h / Math.log2(FAMILIES.length)).toFixed(4); })();
  return {
    meanAdvancesPerEpoch: +(advancesTotal / epochs).toFixed(4),
    meanDistanceFromTarget: +mean(distFromTarget).toFixed(4),
    timeAtMaxWhilePotentialAboveTarget: timeAtMaxWhilePotential,
    timeAtMinWhileQualityHigh: timeAtMinWhileQuality,
    longestZeroHonestDrought: longestDrought,
    longestBaselineRecomputeLag: longestBaselineLag,
    cumulativeParentScorePpmGainProxy: Math.round(cumGainPpm),
    acceptedFamilyEntropyNorm: familyEntropy,
    realRetrievalGainFraction: +curve.realGainFrac.toFixed(4),
    randomAcceptanceRate: +(randomAcceptsTotal / Math.max(1, attemptsRandom)).toFixed(5),
    hillclimbAcceptanceRate: +(hillAcceptsTotal / Math.max(1, attemptsHill)).toFixed(5),
    plateauOnsetEpoch: plateauOnset,
  };
}

if (!curvePaths.length) { console.error('[mc] FATAL: --curves <response-surface artifact(s)> required'); process.exit(2); }
const curves = curvePaths.map(loadCurve);
const majorDeltaThreshold = 10; // production-pinned candidate (integer eval_hidden count)
const t0 = Date.now();
const results = [];
for (const curve of curves) for (const [cid, controller] of Object.entries(CONTROLLERS)) for (const epochs of epochsGrid) for (const growth of GROWTH) for (const pop of POPULATIONS) {
  const runs = [];
  for (let s = 0; s < mcSeeds; s++) runs.push(simulate({ curve, controller, epochs, growth, pop, majorDeltaThreshold, mcSeed: `${cid}:${epochs}:${s}` }));
  // aggregate over MC seeds (mean + worst).
  const agg = {};
  for (const k of Object.keys(runs[0])) {
    const vals = runs.map((r) => r[k]).filter((v) => v !== null);
    if (!vals.length) { agg[k] = null; continue; }
    agg[k + '_mean'] = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4);
    agg[k + '_worst'] = (k.startsWith('time') || k.startsWith('longest') || k.includes('Acceptance') || k.startsWith('plateau')) ? Math.max(...vals) : Math.min(...vals);
  }
  results.push({ scale: curve.phase, controller: cid, epochs, growth, population: pop, ...agg });
}
console.error(`[mc] ${results.length} cells × ${mcSeeds} MC seeds in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Phase 4 health flags per (controller) aggregated over all conditions.
const byController = {};
for (const cid of Object.keys(CONTROLLERS)) {
  const rs = results.filter((r) => r.controller === cid);
  byController[cid] = {
    maxRandomAcceptanceRate: Math.max(...rs.map((r) => r.randomAcceptanceRate_worst ?? 0)),
    maxHillclimbAcceptanceRate: Math.max(...rs.map((r) => r.hillclimbAcceptanceRate_worst ?? 0)),
    maxTimeAtMaxWhilePotential: Math.max(...rs.map((r) => r.timeAtMaxWhilePotentialAboveTarget_worst ?? 0)),
    maxLongestDrought: Math.max(...rs.map((r) => r.longestZeroHonestDrought_worst ?? 0)),
    anyPlateauOnset: rs.some((r) => (r.plateauOnsetEpoch_worst ?? 0) > 0),
    meanAdvancesPerEpochAvg: +(rs.reduce((a, r) => a + (r.meanAdvancesPerEpoch_mean ?? 0), 0) / rs.length).toFixed(4),
    meanDistanceFromTargetAvg: +(rs.reduce((a, r) => a + (r.meanDistanceFromTarget_mean ?? 0), 0) / rs.length).toFixed(4),
    minFamilyEntropy: Math.min(...rs.map((r) => r.acceptedFamilyEntropyNorm_worst ?? 0)),
  };
}

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();
const out = {
  generatedAt: new Date().toISOString(),
  provenance: { curves: curvePaths, curvePhases: curves.map((c) => c.phase), gitSha, dirtyTree, targetAdvances, replayTolerancePpm: replayTol, majorDeltaThreshold,
    honestPerEpoch, randomPerEpoch, hillclimbPerEpoch, epochsGrid, mcSeeds, controllers: CONTROLLERS, growthSchedules: GROWTH, populations: POPULATIONS,
    note: 'acceptance sampled from empirical Phase 3 response curves; controller is the real protocol nextMinImprovementPpm from dist' },
  byController,
  cells: results,
};
mkdirSync(resolve(repoRoot, outDir), { recursive: true });
const path = resolve(repoRoot, outDir, `V2_MONTECARLO_LONGHORIZON${tag ? '_' + tag : ''}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ byController }, null, 2));
console.log(`wrote ${path}`);
