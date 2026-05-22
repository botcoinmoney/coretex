#!/usr/bin/env node
/**
 * V2-native dynamic-difficulty controller simulation (Layer 9, increment 1).
 *
 * Drives the production difficulty controller (`nextMinImprovementPpm`) over the
 * OWNER-SCOPED V2 corpus's growth trajectory and reports PLATEAU risk. This is
 * the cheap, corpus-shape-faithful controller-DYNAMICS cut (CPU, no scoring) —
 * it is NOT anti-cheat or minimal-plateau PROOF (that needs real scoring +
 * random-patch probes, a separate bounded A100 phase).
 *
 * V2-native corpus growth = activating more OWNERS over epochs (a real memory
 * platform onboards users/projects), which grows the active OWNER-SCOPED
 * eval_hidden set and fires `isMajorDelta` grace-freezes. Pooled families
 * (ownerScoped===false: entity_disambiguation, abstention) are tracked
 * SEPARATELY and excluded from the owner-scoped growth trajectory.
 *
 * Owner-ordering is randomized over multiple seeds (onboarding order is not the
 * id-sort prefix). Clamp bounds are read from the controller, never hardcoded.
 *
 * Usage:
 *   node scripts/simulate-v2-difficulty.mjs --corpus <v2-logical.json> \
 *     --epochs 120 --target-advances 5 --scenario alternating-burst \
 *     --owner-fractions 0.25,0.5,0.75,1.0 --epochs-per-fraction 30 \
 *     --major-delta-threshold 0.1 --order-seeds s1,s2,s3 --out <dir>
 */
import { distIndex } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const { nextMinImprovementPpm, isMajorDelta, MIN_IMPROVEMENT_PPM, MAX_IMPROVEMENT_PPM } = await import(distIndex);
const MAXP = Number(MAX_IMPROVEMENT_PPM);
const MINP = Number(MIN_IMPROVEMENT_PPM);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p2-corpus.json');
const epochs = Number(flag('epochs', '120'));
const targetAdvances = Number(flag('target-advances', '5'));
const scenario = flag('scenario', 'alternating-burst');
const ownerFractions = String(flag('owner-fractions', '0.25,0.5,0.75,1.0')).split(',').map(Number);
const epochsPerFraction = Number(flag('epochs-per-fraction', String(Math.ceil(epochs / 4))));
const majorDeltaThreshold = Number(flag('major-delta-threshold', '10'));
const orderSeeds = String(flag('order-seeds', 's1,s2,s3')).split(',').filter(Boolean);
const startFloorPpm = BigInt(flag('start-floor-ppm', '5000'));
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2');
// Controller-shape sweep flags (Phase 1 hardening). Undefined → controller defaults.
const num = (n) => { const v = flag(n, undefined); return v === undefined ? undefined : Number(v); };
const rampUpMaxRatio = num('ramp-up-max-ratio');
const decayRatio = num('decay-ratio');
const smallDriftRatio = num('small-drift-ratio');
const qualityHighThresholdMult = num('quality-high-threshold-mult'); // qualityHighThreshold = mult * targetAdvances
// Experimental clamp-bound overrides (research-only). Undefined → pinned protocol constants.
const minImprovementFloorPpm = (() => { const v = flag('min-improvement-floor-ppm', undefined); return v === undefined ? undefined : BigInt(v); })();
const maxImprovementCeilingPpm = (() => { const v = flag('max-improvement-ceiling-ppm', undefined); return v === undefined ? undefined : BigInt(v); })();
// Effective clamp bounds used for plateau/stall detection (must track overrides).
const EFF_MIN = minImprovementFloorPpm !== undefined && minImprovementFloorPpm > 0n ? Number(minImprovementFloorPpm) : MINP;
const EFF_MAX = maxImprovementCeilingPpm !== undefined && maxImprovementCeilingPpm > BigInt(EFF_MIN) ? Number(maxImprovementCeilingPpm) : MAXP;

// Production-count semantics for majorDeltaThreshold (Phase 1 item 7): isMajorDelta
// compares an ABSOLUTE new-minus-prev eval_hidden COUNT against the threshold. A
// ratio-like value (0<v<1) is almost certainly a mistake at production scale (it
// would fire grace on essentially any growth). Refuse it loudly.
if (majorDeltaThreshold > 0 && majorDeltaThreshold < 1) {
  console.error(`[v2-diff] FATAL: --major-delta-threshold=${majorDeltaThreshold} is ratio-like; isMajorDelta expects an integer new-eval_hidden COUNT (e.g. 10). Refusing.`);
  process.exit(2);
}
if (majorDeltaThreshold > 0 && !Number.isInteger(majorDeltaThreshold)) {
  console.error(`[v2-diff] WARN: --major-delta-threshold=${majorDeltaThreshold} is non-integer; isMajorDelta is an integer count comparison.`);
}

// ── load V2 logical corpus; SEPARATE owner-scoped from pooled families ──
const logical = JSON.parse(readFileSync(resolve(corpusPath), 'utf8'));
const scopedEvalHidden = logical.queries.filter((q) => !q.abstain && (q.split ?? 'eval_hidden') === 'eval_hidden'
  && q.ownerScoped === true && q.ownerEntityId);
const pooledEvalHidden = logical.queries.filter((q) => !q.abstain && (q.split ?? 'eval_hidden') === 'eval_hidden'
  && q.ownerScoped !== true);
const evalHiddenByOwner = new Map();
for (const q of scopedEvalHidden) evalHiddenByOwner.set(q.ownerEntityId, (evalHiddenByOwner.get(q.ownerEntityId) ?? 0) + 1);
const ownersAll = [...evalHiddenByOwner.keys()];

function hseed(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
function shuffledOwners(orderSeed) {
  // Deterministic owner ordering keyed by seed (onboarding order, not id-prefix).
  return [...ownersAll].map((o) => [o, hseed(`${orderSeed}:${o}`)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
}
function activeScopedCount(owners, frac) {
  const k = Math.max(1, Math.floor(owners.length * frac));
  let n = 0; for (let i = 0; i < k; i++) n += evalHiddenByOwner.get(owners[i]) ?? 0; return n;
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
    // honest-improver-decay: a healthy honest population whose advance RATE
    // decays over time (real signal getting scarcer) while it keeps trying hard.
    // Tests whether the controller decays gracefully toward the floor instead of
    // pinning high and starving the runway.
    case 'honest-improver-decay': {
      const adv = Math.max(0, targetAdvances - Math.floor((epoch - 1) / 8));
      return { observedAdvances: adv, qualityAttempts: targetAdvances * 6 };
    }
    // adversarial-random-only: pure junk pressure — zero honest advances and zero
    // genuine quality attempts. Tests drift-down-to-floor under noise (no false
    // tightening). Random patches are bogus, so qualityAttempts (elevated/non-bogus) = 0.
    case 'adversarial-random-only': return { observedAdvances: 0, qualityAttempts: 0 };
    // mixed-honest-adversarial: a heterogeneous market — some honest advances below
    // target plus high genuine quality activity (and implicit junk). Tests whether
    // the controller equilibrates rather than oscillating.
    case 'mixed-honest-adversarial': return { observedAdvances: Math.max(1, Math.floor(targetAdvances / 2)), qualityAttempts: targetAdvances * 4 };
    default: throw new Error(`unknown scenario ${kind}`);
  }
}

// Controller params threaded into every nextMinImprovementPpm call (undefined → defaults).
const controllerParams = {
  ...(rampUpMaxRatio !== undefined ? { rampUpMaxRatio } : {}),
  ...(decayRatio !== undefined ? { decayRatio } : {}),
  ...(smallDriftRatio !== undefined ? { smallDriftRatio } : {}),
  ...(qualityHighThresholdMult !== undefined ? { qualityHighThreshold: qualityHighThresholdMult * targetAdvances } : {}),
  ...(minImprovementFloorPpm !== undefined ? { minClampPpm: minImprovementFloorPpm } : {}),
  ...(maxImprovementCeilingPpm !== undefined ? { maxClampPpm: maxImprovementCeilingPpm } : {}),
};

function runOrdering(orderSeed) {
  const owners = shuffledOwners(orderSeed);
  let current = startFloorPpm, prevEH = 0;
  let clampHits = 0, stagnant = 0, maxStagnant = 0, graceFreezes = 0, ramps = 0, decays = 0;
  let maxClampWhileAdvancing = 0, minClampWhileStalled = 0, moved = 0, growthEpochs = 0;
  const rows = [];
  for (let epoch = 1; epoch <= epochs; epoch++) {
    const fracIdx = Math.min(ownerFractions.length - 1, Math.floor((epoch - 1) / Math.max(1, epochsPerFraction)));
    const frac = ownerFractions[fracIdx] ?? 1;
    const activeEH = activeScopedCount(owners, frac);
    const majorDeltaActive = majorDeltaThreshold > 0 ? isMajorDelta(activeEH, prevEH, majorDeltaThreshold) : false;
    prevEH = activeEH;
    if (majorDeltaActive) growthEpochs++;
    const { observedAdvances, qualityAttempts } = scenarioCounts(scenario, epoch);
    const d = nextMinImprovementPpm({ current, observedAdvances, targetAdvances, qualityAttempts, majorDeltaActive, ...controllerParams });
    if (d.clamped) clampHits++;
    if (d.reason === 'major_delta_grace') graceFreezes++;
    if (d.reason === 'ramp_up') ramps++;
    if (d.reason === 'decay') decays++;
    const after = Number(d.next);
    if (d.next === current) { stagnant++; maxStagnant = Math.max(maxStagnant, stagnant); } else { stagnant = 0; moved++; }
    if (after === EFF_MAX && observedAdvances > targetAdvances) maxClampWhileAdvancing++;
    if (after === EFF_MIN && observedAdvances === 0) minClampWhileStalled++;
    rows.push({ epoch, ownerFraction: frac, activeScopedEvalHidden: activeEH, majorDeltaActive, observedAdvances, after, reason: d.reason });
    current = d.next;
  }
  const vals = rows.map((r) => r.after);
  return { orderSeed, firstPpm: Number(startFloorPpm), lastPpm: rows.at(-1).after, minPpm: Math.min(...vals), maxPpm: Math.max(...vals),
    clampHits, maxConsecutiveUnchangedEpochs: maxStagnant, graceFreezes, ramps, decays, movedEpochs: moved, ownerGrowthEpochs: growthEpochs,
    maxClampWhileAdvancing, minClampWhileStalled };
}

const perSeed = orderSeeds.map(runOrdering);
const agg = (k) => perSeed.map((s) => s[k]);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const maxA = (a) => Math.max(...a);
// HONEST health: the controller is "responsive" (ramps/decays/drift/equilibrium)
// AND grace fires exactly on owner-growth epochs. But MAX-clamp-while-advancing
// is the UNRESOLVED plateau risk — it must NOT be hidden by a healthy=true flag.
const responsive = perSeed.every((s) => s.movedEpochs > 0 || scenario === 'steady-target');
const graceExact = perSeed.every((s) => s.graceFreezes === s.ownerGrowthEpochs);
const plateauRiskAtMax = maxA(agg('maxClampWhileAdvancing'));
const minClampStalled = maxA(agg('minClampWhileStalled'));
const summary = {
  scenario, epochs, targetAdvances, ownerFractions, epochsPerFraction, majorDeltaThreshold,
  controllerParams: { rampUpMaxRatio: rampUpMaxRatio ?? 1.5, decayRatio: decayRatio ?? 0.85, smallDriftRatio: smallDriftRatio ?? 1.05,
    qualityHighThresholdMult: qualityHighThresholdMult ?? 4 },
  clampBounds: { minPpm: EFF_MIN, maxPpm: EFF_MAX, pinnedMinPpm: MINP, pinnedMaxPpm: MAXP,
    overridden: EFF_MIN !== MINP || EFF_MAX !== MAXP }, orderSeeds,
  scopedOwners: ownersAll.length, scopedEvalHidden: scopedEvalHidden.length, pooledEvalHidden: pooledEvalHidden.length,
  lastPpmMean: mean(agg('lastPpm')), rampsMean: mean(agg('ramps')), decaysMean: mean(agg('decays')),
  graceFreezesMean: mean(agg('graceFreezes')), ownerGrowthEpochsMean: mean(agg('ownerGrowthEpochs')),
  maxConsecutiveUnchangedEpochsMax: maxA(agg('maxConsecutiveUnchangedEpochs')),
  plateauRiskAtMax, minClampWhileStalled: minClampStalled,
  controllerResponsive: responsive, graceFiresExactlyOnGrowth: graceExact,
  // A bare "healthy" boolean would be misleading: report the unresolved risk explicitly.
  unresolvedPlateauRiskAtMax: plateauRiskAtMax > 0,
  assessment: responsive && graceExact
    ? (plateauRiskAtMax > 0
      ? `dynamics-correct; UNRESOLVED MAX-clamp plateau under this scenario (${plateauRiskAtMax} epochs pinned at MAX while advancing) — needs real advance rates`
      : 'dynamics-correct; no MAX-clamp saturation in this scenario')
    : 'CHECK: controller not responsive or grace mis-fired',
};
const out = { generatedAt: new Date().toISOString(), corpus: corpusPath, phase: logical.phase, summary, perSeed };
mkdirSync(dirname(resolve(outDir, 'x')), { recursive: true });
// Sweep mode writes unique files per grid point: pass --tag to disambiguate, else
// a short config hash keeps grid points from overwriting each other.
const tag = flag('tag', undefined);
const cfgHash = createHash('sha256').update(JSON.stringify(summary.controllerParams) + `:${targetAdvances}:${majorDeltaThreshold}:${EFF_MIN}:${EFF_MAX}`).digest('hex').slice(0, 8);
const suffix = tag !== undefined ? `_${tag}` : ((summary.clampBounds.overridden || rampUpMaxRatio !== undefined || decayRatio !== undefined || smallDriftRatio !== undefined || qualityHighThresholdMult !== undefined) ? `_${cfgHash}` : '');
const path = resolve(outDir, `V2_DIFFICULTY_${(logical.phase || 'p').toLowerCase()}_${scenario}${suffix}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(`# V2 difficulty sim (${logical.phase}, ${scenario}) — ${epochs} epochs × ${orderSeeds.length} owner-orderings, ${ownersAll.length} scoped owners`);
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${path}`);
