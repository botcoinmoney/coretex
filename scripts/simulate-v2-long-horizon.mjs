#!/usr/bin/env node
/**
 * V2 owner-scoped long-horizon harness (Layer 9, items 6+7) — production-faithful.
 *
 * Drives the difficulty controller over the owner-scoped V2 corpus's owner-growth
 * trajectory with REAL scoring, using the PRODUCTION acceptance rule and the
 * SIGNED-profile-derived scoring options (no bespoke opts). Two cleanly-separated
 * populations per epoch:
 *   - HONEST: the positive-control relation-lever patch (+ small variants) from
 *     the current BEST accepted state. Accepted honest patches FEED the controller
 *     (`observedAdvances`) so the RAMP branch is exercised, and update bestState.
 *   - ADVERSARIAL: RANDOM patches (from empty) + HILLCLIMB patches (mutate the
 *     current bestState — an adaptive miner). Acceptance is measured as the
 *     anti-cheat / gameability rate; it does NOT feed the controller.
 *
 * Production acceptance threshold = minImprovementPpm + variancePpm +
 * replayTolerancePpm. Baseline is recomputed on major-delta (owner-growth) epochs.
 *
 * CPU smoke (mechanics; deterministic reranker can't reward routing → honest
 * accepts ~0, but threshold/population/baseline-recompute plumbing is exercised):
 *   node scripts/simulate-v2-long-horizon.mjs --reranker deterministic --epochs 4 \
 *     --random-probes 4 --hillclimb-probes 2 --honest-per-epoch 1
 * A100 real signal:
 *   HF_HUB_CACHE=... CORETEX_RERANKER_PYTHON=/usr/bin/python3 \
 *   node scripts/simulate-v2-long-horizon.mjs --reranker gpu --epochs 12 \
 *     --random-probes 12 --hillclimb-probes 6 --honest-per-epoch 2 --out <dir>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';
import { honestPatch as honestPatchLib, nextTemporalDocId, empty, hseed, mulberry32, randomPatch } from './lib/v2-patch-families.mjs';
import { makeEpochFrontier } from './lib/epoch-frontier.mjs';

const {
  scoringOptionsFromProfile, controllerParamsFromProfile, deriveQueryPack, evaluateBaseline, evaluateRetrievalBenchmarkPatch,
  applyPatch, nextMinImprovementPpm, isMajorDelta, createDeterministicReranker,
  MIN_IMPROVEMENT_PPM, MAX_IMPROVEMENT_PPM,
} = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p1-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/p1-embeddings.json');
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-ownerscope-r1.json');
const epochs = Number(flag('epochs', '12'));
const randomProbes = Number(flag('random-probes', '12'));
const hillclimbProbes = Number(flag('hillclimb-probes', '6'));
const honestPerEpoch = Number(flag('honest-per-epoch', '2'));
const baselineSamples = Number(flag('baseline-samples', '1'));
const targetAdvances = Number(flag('target-advances', '2'));
const rerankerArg = flag('reranker', 'deterministic');
const masterSeed = flag('seed', 'v2-lh-2026-05-22');
const ownerFractions = String(flag('owner-fractions', '0.34,0.67,1.0')).split(',').map(Number);
// ── Phase-2 frontier-churn probe (ADDITIVE, default OFF → byte-identical). mode off|C0|C1|C2 ──
const frontierMode = flag('frontier-mode', 'off');
const frontierWindow = Number(flag('frontier-window', '0'));      // active-frontier size K (0 = all eval_hidden)
const frontierChurn = Number(flag('frontier-churn-rate', '4'));   // C1/C2 units retired+activated per epoch
const frontierMaxAge = flag('frontier-max-age', 'inf') === 'inf' ? Infinity : Number(flag('frontier-max-age', 'inf'));
const frontierSeed = flag('frontier-seed', 'frontier-2026-05-25');
const frontierLowAdv = Number(flag('frontier-low-advances', '1'));
const epochsPerFraction = Number(flag('epochs-per-fraction', String(Math.ceil(epochs / ownerFractions.length))));
// Bounded-run overrides (keep A100 Qwen-pair budget tractable). 0 = use profile.
const packSizeOverride = Number(flag('pack-size', '0'));
const rerankCapOverride = Number(flag('rerank-cap', '0'));
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2');
// Difficulty-band progression: as epochs advance (corpus deepens), shift the hidden
// pack's band mix toward harder bands, with a MANDATORY exhaustion probe (runbook 1C.3).
// Off by default; --band-progression turns it on (requires a band-bearing corpus, e.g. DGEN-1).
const bandProgression = argv.includes('--band-progression');
const BANDS = ['easy', 'medium', 'hard', 'very_hard', 'exhaustion'];
// Quotas must not exceed what the corpus's eval_hidden actually has per band (else
// deriveQueryPack fails closed). `availCounts` is computed once from the corpus.
function bandQuotasForEpoch(epoch, epochsN, packSize, availCounts) {
  const t = epochsN > 1 ? (epoch - 1) / (epochsN - 1) : 1; // difficulty pointer 0..1
  const w = {
    easy: Math.max(0, 0.30 - 0.30 * t), medium: Math.max(0, 0.35 - 0.15 * t),
    hard: 0.20 + 0.10 * Math.min(1, 2 * t), very_hard: 0.10 + 0.30 * t, exhaustion: 0.05 + 0.20 * t,
  };
  // zero out bands the corpus lacks, renormalize over available bands.
  for (const b of BANDS) if ((availCounts[b] ?? 0) === 0) w[b] = 0;
  const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const quotas = [];
  for (const b of BANDS) {
    const want = Math.floor((w[b] / sum) * packSize);
    const mc = Math.min(want, availCounts[b] ?? 0);
    if (mc > 0) quotas.push({ stratum: `band=${b}`, minCount: mc });
  }
  // mandatory exhaustion probe IF the corpus has any (tests apparent-live-but-exhausted families).
  if ((availCounts.exhaustion ?? 0) > 0 && !quotas.some((q) => q.stratum === 'band=exhaustion')) {
    quotas.push({ stratum: 'band=exhaustion', minCount: 1 });
  }
  return quotas;
}
// ── Phase 1 hardening flags ──
const num = (n) => { const v = flag(n, undefined); return v === undefined ? undefined : Number(v); };
const big = (n) => { const v = flag(n, undefined); return v === undefined ? undefined : BigInt(v); };
// Controller-shape sweep (undefined → controller defaults).
const rampUpMaxRatio = num('ramp-up-max-ratio');
const decayRatio = num('decay-ratio');
const smallDriftRatio = num('small-drift-ratio');
const qualityHighThresholdMult = num('quality-high-threshold-mult');
// Experimental clamp-bound overrides (research-only; pinned constants otherwise).
const minImprovementFloorPpm = big('min-improvement-floor-ppm');
const maxImprovementCeilingPpm = big('max-improvement-ceiling-ppm');
// Fixed-threshold response-curve mode: hold minImprovement fixed, optionally freeze
// the controller entirely (measure acceptance vs difficulty without feedback).
const fixedMinImprovementPpm = big('fixed-min-improvement-ppm');
const disableController = argv.includes('--disable-controller') || fixedMinImprovementPpm !== undefined;
// Honest patch families: relation | temporal | mixed | all (round-robin over the three).
const honestFamily = flag('honest-family', 'all');
// Checkpoint / resume for long A100 / many-epoch continuation.
const resumePath = flag('resume', undefined);
const stateOutPath = flag('state-out', undefined);
const START_T = Date.now();
// Research-only clamp-bound overrides (CLI; pinned protocol constants otherwise).
const clampOverrides = {
  ...(minImprovementFloorPpm !== undefined ? { minClampPpm: minImprovementFloorPpm } : {}),
  ...(maxImprovementCeilingPpm !== undefined ? { maxClampPpm: maxImprovementCeilingPpm } : {}),
};

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
// CANONICAL: the difficulty-controller shape is SOURCED FROM THE SIGNED PROFILE
// (controllerParamsFromProfile → the pinned launch controller), with CLI flags
// overriding per-field ONLY for calibration sweeps. This proves profile → runtime
// controller consumption the same way scoringOptionsFromProfile proves it for the
// scorer. When the profile lacks controllerParams, this returns the difficulty.ts
// protocol defaults (pre-pin behaviour) — backward compatible.
const profileController = controllerParamsFromProfile(profile, targetAdvances);
const controllerSource = profile.controllerParams !== undefined ? 'profile' : 'difficulty-defaults';
const controllerOverrides = {
  rampUpMaxRatio: rampUpMaxRatio ?? profileController.rampUpMaxRatio,
  decayRatio: decayRatio ?? profileController.decayRatio,
  smallDriftRatio: smallDriftRatio ?? profileController.smallDriftRatio,
  qualityHighThreshold: qualityHighThresholdMult !== undefined
    ? qualityHighThresholdMult * targetAdvances
    : profileController.qualityHighThreshold,
  ...clampOverrides,
};
const { corpus, queryEvents, logical, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));
const reranker = rerankerArg === 'gpu' || rerankerArg === 'cpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : await createDeterministicReranker();
// CANONICAL: scoring options from the signed profile (no bespoke opts). Bounded-run
// cap override only narrows the reranker pool (compute), not substrate expressivity.
const opts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
if (rerankCapOverride > 0) opts.rerankerInputTopK = rerankCapOverride;
// --clear-pack-quotas: drop the profile's per-stratum hidden-pack quotas (the frontier-churn probe
// uses a small ROTATING active window that can't satisfy fixed family quotas; default OFF → unchanged).
const clearPackQuotas = argv.includes('--clear-pack-quotas');
const hiddenPackBase = packSizeOverride > 0 ? { ...profile.hiddenPack, packSize: packSizeOverride } : profile.hiddenPack;
const hiddenPack = clearPackQuotas ? { ...hiddenPackBase, quotas: [] } : hiddenPackBase;
// Band availability in eval_hidden (for band-progression quota capping; 0 if no bands).
const bandAvailCounts = (() => { const c = {}; for (const e of corpus.events) { if (e.split === 'eval_hidden' && e.band) c[e.band] = (c[e.band] ?? 0) + 1; } return c; })();
if (bandProgression) console.error(`[v2-lh] band-progression ON; eval_hidden band availability: ${JSON.stringify(bandAvailCounts)}`);
const replayTol = Number(profile.replayTolerancePpm ?? 250);
// Effective major-delta threshold MUST come from the profile (auditable, not a
// silent default). Warn loudly if the profile lacks it rather than quietly using 0.1.
if (profile.majorDeltaThreshold === undefined) console.error('[v2-lh] WARN: profile lacks majorDeltaThreshold; falling back to 0.1 (NOT profile-pinned)');
const effMajorDelta = Number(profile.majorDeltaThreshold ?? 0.1);
// Production-count semantics (Phase 1 item 7): isMajorDelta compares an ABSOLUTE
// new-minus-prev eval_hidden COUNT. A ratio-like value (0<v<1) in production-profile
// mode is almost certainly a misconfiguration — refuse it loudly.
if (profile.majorDeltaThreshold !== undefined && effMajorDelta > 0 && effMajorDelta < 1) {
  console.error(`[v2-lh] FATAL: profile.majorDeltaThreshold=${effMajorDelta} is ratio-like; isMajorDelta expects an integer new-eval_hidden COUNT. Refusing.`);
  process.exit(2);
}
const structFloors = {
  structuralFloor: profile.patchAcceptanceFloors.structuralFloor,
  protectedRegressionFloor: -50000, familyCatastrophicFloor: -100000,
};

// owner-growth: activate the first `frac` of owners (deterministic order).
const owners = [...new Set(queryEvents.filter((e) => e.ownerScoped === true && e.ownerEntityId).map((e) => e.ownerEntityId))];
const ownerOrder = [...owners].map((o) => [o, hseed(`${masterSeed}:${o}`)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
// Active subset corpus: eval_hidden restricted to active owners (+ pooled families always on); all mem docs kept.
function activeCorpus(frac) {
  const k = Math.max(1, Math.floor(ownerOrder.length * frac));
  const active = new Set(ownerOrder.slice(0, k));
  const events = corpus.events.filter((e) => e.split !== 'eval_hidden' || e.ownerScoped !== true || active.has(e.ownerEntityId));
  return { ...corpus, events, byId: new Map(events.map((e) => [e.id, e])),
    evalHiddenCount: events.filter((e) => e.split === 'eval_hidden').length };
}

// ── Phase-2 frontier (built only when active; OFF → never constructed → no behavior change) ──
let frontier = null;
if (frontierMode !== 'off') {
  const evalHiddenIds = corpus.events.filter((e) => e.split === 'eval_hidden').map((e) => e.id);
  const famById = new Map(corpus.events.map((e) => [e.id, e.logicalFamily ?? e.family ?? 'unknown']));
  frontier = makeEpochFrontier({
    evalHiddenIds, familyOf: (id) => famById.get(id), mode: frontierMode,
    activeWindow: frontierWindow > 0 ? frontierWindow : evalHiddenIds.length,
    churnRate: frontierChurn, maxAge: frontierMaxAge, lowAdvancesThreshold: frontierLowAdv, seed: frontierSeed,
  });
  console.error(`[v2-lh] FRONTIER ${frontierMode} window=${frontier.K}/${frontier.totalUnits} churn=${frontierChurn} maxAge=${frontierMaxAge} families=[${frontier.familyOrder}]`);
}
let prevHonestAccepts = null;  // aggregate-only churn trigger (C2); set at each epoch's end

// ── honest patch families (shared lib — same levers measured in Phase 3) ──
// relation | temporal | mixed are GENUINE substrate compiles (proposer-visible memory
// structure, no query→answer leak). honestPatch wraps them into a MIXED patch parented
// on `state` (mutate-best semantics). See scripts/lib/v2-patch-families.mjs.
// PACK-ALIGNED incremental temporal mining: temporal/mixed patches mine the next pack
// temporal query NOT yet covered by the substrate (skipDocIds), into the next free record
// slot (recordSlot, capped at 18 pairs). This is the production-faithful regime (runbook
// Phase-3 §3) — it decouples the global record slot from the per-epoch random pack so
// mining does not stall when the slot counter exceeds a single pack's temporal-query count.
const honestPatch = (state, family, pack, recordSlot, skipDocIds) => honestPatchLib({ state, family, pack, logicalQById, recordSlot, skipDocIds });
const HONEST_FAMILIES = honestFamily === 'all' ? ['relation', 'temporal', 'mixed'] : [honestFamily];

async function evalPatch(state, patch, corpus_, pack, acceptanceThresholdPpm, minImprovementPpm) {
  return evaluateRetrievalBenchmarkPatch(state, patch, corpus_, pack, opts, { ...structFloors, minImprovementPpm, acceptanceThresholdPpm });
}

// State (de)serialization for checkpoint/resume — bigint words ↔ decimal strings.
const serializeState = (s) => s.words.map((w) => w.toString());
const deserializeState = (arr) => ({ words: arr.map((x) => BigInt(x)) });

// Initial minImprovement: fixed-threshold mode pins it; else the profile floor.
let current = fixedMinImprovementPpm !== undefined ? fixedMinImprovementPpm : BigInt(Number(profile.patchAcceptanceFloors.minImprovementPpm) || 5000);
let bestState = empty();
let prevEH = 0, clampHits = 0, maxClampWhileAdvancing = 0, baselineRecomputes = 0;
let cachedVariance = null, cachedFrac = null;
let startEpoch = 1;
// Incremental temporal mining: each accepted temporal/mixed patch claims the next
// temporal query/record (the per-query unit is 3 words; one per patch within budget).
let temporalRecordSlot = 0;            // next free temporal record slot (0..17; 18-pair cap)
let minedTemporalDocs = new Set();     // current-docs already compiled into the substrate
let attemptedRejectedTemporal = new Set(); // temporal current-docs attempted but NOT accepted (Δ≤bar)
// Opt-in mining-selection fix: also skip attempted-AND-rejected temporal queries (not just accepted),
// so nextTemporalDocId advances past non-minable Δ0 heads instead of re-picking them every epoch
// (root cause of the 64-pair plateau; see V2_DGEN1_ENDURANCE_FINDINGS.md §COVERAGE RE-DIAGNOSIS).
// Default OFF → canonical behavior byte-identical.
const skipRejectedTemporal = process.argv.slice(2).includes('--skip-rejected-temporal');
let rows = [];
if (resumePath) {
  const ck = JSON.parse(readFileSync(resolve(repoRoot, resumePath), 'utf8'));
  bestState = deserializeState(ck.bestState);
  if (!disableController) current = BigInt(ck.current);
  prevEH = ck.prevEH ?? 0; clampHits = ck.clampHits ?? 0; maxClampWhileAdvancing = ck.maxClampWhileAdvancing ?? 0;
  baselineRecomputes = ck.baselineRecomputes ?? 0; cachedVariance = ck.cachedVariance ?? null; cachedFrac = ck.cachedFrac ?? null;
  rows = ck.rows ?? []; startEpoch = (ck.lastEpoch ?? 0) + 1;
  temporalRecordSlot = ck.temporalRecordSlot ?? 0;
  minedTemporalDocs = new Set(ck.minedTemporalDocs ?? []);
  attemptedRejectedTemporal = new Set(ck.attemptedRejectedTemporal ?? []);
  console.error(`[v2-lh] RESUMED from ${resumePath} at epoch ${startEpoch} (rows=${rows.length}, current=${current}, temporalRecordSlot=${temporalRecordSlot}, minedTemporal=${minedTemporalDocs.size})`);
}
function writeStateOut(lastEpoch) {
  if (!stateOutPath) return;
  const ck = { lastEpoch, current: current.toString(), prevEH, clampHits, maxClampWhileAdvancing, baselineRecomputes,
    cachedVariance, cachedFrac, temporalRecordSlot, minedTemporalDocs: [...minedTemporalDocs], attemptedRejectedTemporal: [...attemptedRejectedTemporal], bestState: serializeState(bestState), rows };
  writeFileSync(resolve(repoRoot, stateOutPath), JSON.stringify(ck));
}
console.error(`[v2-lh] corpus=${corpus.events.length} evt, scopedOwners=${owners.length}, reranker=${rerankerArg}, profile=${profilePath}, epochs=${epochs}, families=[${HONEST_FAMILIES}], controller=${disableController ? 'DISABLED(fixed=' + current + ')' : 'on'}`);
for (let epoch = startEpoch; epoch <= epochs; epoch++) {
  const fracIdx = Math.min(ownerFractions.length - 1, Math.floor((epoch - 1) / Math.max(1, epochsPerFraction)));
  const frac = ownerFractions[fracIdx] ?? 1;
  const ac = activeCorpus(frac);
  // Phase-2 frontier: restrict eval_hidden to the epoch's ACTIVE frontier set (aggregate-only churn).
  let frontierManifest = null;
  if (frontier) {
    const fr = frontier.stepEpoch(epoch, prevHonestAccepts);
    ac.events = ac.events.filter((e) => e.split !== 'eval_hidden' || fr.activeIds.has(e.id));
    ac.byId = new Map(ac.events.map((e) => [e.id, e]));
    ac.evalHiddenCount = ac.events.filter((e) => e.split === 'eval_hidden').length;
    frontierManifest = { epochId: fr.epochId, mode: frontierMode, activeEvalHiddenCount: fr.activeEvalHiddenCount, activated: fr.activated, retired: fr.retired, churnRate: fr.churnRate, reserveRemaining: fr.reserveRemaining, cumulativeActivated: fr.cumulativeActivated, cumulativeRetired: fr.cumulativeRetired, activeRoot: fr.activeRoot, reserveRoot: fr.reserveRoot, retiredRoot: fr.retiredRoot };
  }
  const majorDeltaActive = isMajorDelta(ac.evalHiddenCount, prevEH, effMajorDelta); prevEH = ac.evalHiddenCount;
  const seedHex = '0x' + createHash('sha256').update(`${masterSeed}:${epoch}`).digest('hex');
  // Band-progression: per-epoch band quotas (harder bands as the run advances + mandatory
  // exhaustion probe). Merged onto the profile quotas; deriveQueryPack enforces them.
  const epochPack = bandProgression
    ? { ...hiddenPack, quotas: [...(hiddenPack.quotas ?? []), ...bandQuotasForEpoch(epoch, epochs, packSizeOverride > 0 ? packSizeOverride : (hiddenPack.packSize ?? 64), bandAvailCounts)] }
    : hiddenPack;
  const pack = deriveQueryPack(epoch, seedHex, ac, epochPack);

  // Baseline + variance: recompute on first epoch or major-delta (owner-growth).
  if (cachedVariance === null || majorDeltaActive || frac !== cachedFrac) {
    const base = await evaluateBaseline(bestState, ac, pack, opts, { samples: baselineSamples });
    cachedVariance = base.variancePpm; cachedFrac = frac; baselineRecomputes++;
  }
  const acceptanceThresholdPpm = Number(current) + cachedVariance + replayTol;

  // HONEST population: genuine substrate-compile levers from bestState, rotating over
  // the selected families (relation / temporal / mixed). Major-delta epochs are a
  // controller grace freeze, but we still measure advances honestly. Per-component
  // deltas (retrieval/temporal/relation/abstention/structural) are recorded so
  // non-retrieval fluff can be filtered out downstream (Phase 1 item 5).
  const compDelta = () => ({ retrieval: 0, temporal: 0, relation: 0, abstention: 0, structural: 0 });
  const familyStats = {}; for (const f of HONEST_FAMILIES) familyStats[f] = { attempts: 0, accepts: 0, deltaPpm: [], comp: compDelta() };
  let honestAccepts = 0, honestAttempts = 0; let pcDelta = null;
  for (let h = 0; h < honestPerEpoch; h++) {
    const family = HONEST_FAMILIES[(epoch + h) % HONEST_FAMILIES.length];
    // pack-aligned temporal mining: the uncovered pack temporal query this patch will mine
    // (null for relation, or when every pack temporal query is already in the substrate).
    // Skip set = accepted docs, plus (opt-in) attempted-and-rejected docs so mining advances past
    // non-minable Δ0 heads. Both nextTemporalDocId and honestPatch get the SAME set so the tracked
    // minedDoc matches what the patch actually mines.
    const temporalSkip = skipRejectedTemporal
      ? new Set([...minedTemporalDocs, ...attemptedRejectedTemporal])
      : minedTemporalDocs;
    const minedDoc = family === 'relation' ? null : nextTemporalDocId(pack, logicalQById, temporalSkip);
    const mkPatch = () => honestPatch(bestState, family, pack, temporalRecordSlot, temporalSkip);
    const r = await evalPatch(bestState, mkPatch(), ac, pack, acceptanceThresholdPpm, Number(current));
    honestAttempts++; familyStats[family].attempts++;
    if (h === 0) pcDelta = r.deltaPpm;
    familyStats[family].deltaPpm.push(r.deltaPpm);
    const c = familyStats[family].comp;
    c.retrieval += r.after.nDCG10 - r.before.nDCG10;
    c.temporal += r.after.temporal - r.before.temporal;
    c.relation += r.after.categoryLensRelationHit10 - r.before.categoryLensRelationHit10;
    c.abstention += r.after.abstention - r.before.abstention;
    c.structural += r.after.structuralValidity - r.before.structuralValidity;
    if (r.accepted) { honestAccepts++; familyStats[family].accepts++; const ap = applyPatch(bestState, mkPatch()); if (ap.ok) { bestState = ap.state; if (family !== 'relation' && minedDoc) { minedTemporalDocs.add(minedDoc); temporalRecordSlot++; } } }
    else if (skipRejectedTemporal && family !== 'relation' && minedDoc) { attemptedRejectedTemporal.add(minedDoc); } // non-minable head → skip next time
  }

  // ADVERSARIAL population: random (from empty) + hillclimb (mutate bestState).
  const rand = mulberry32(hseed(`${masterSeed}:adv:${epoch}`));
  let randAccepts = 0, hillAccepts = 0; const randDeltas = [], hillDeltas = [];
  for (let i = 0; i < randomProbes; i++) { const r = await evalPatch(empty(), randomPatch(empty(), rand), ac, pack, acceptanceThresholdPpm, Number(current)); randDeltas.push(r.deltaPpm); if (r.accepted) randAccepts++; }
  for (let i = 0; i < hillclimbProbes; i++) { const r = await evalPatch(bestState, randomPatch(bestState, rand), ac, pack, acceptanceThresholdPpm, Number(current)); hillDeltas.push(r.deltaPpm); if (r.accepted) hillAccepts++; }

  // Controller: ONLY honest advances feed observedAdvances. In fixed-threshold /
  // disable-controller mode the threshold is held constant (Phase 3 response-surface
  // measurement) — no ramp/decay feedback.
  const minImprBefore = Number(current);
  let reason = 'fixed_threshold';
  if (!disableController) {
    const d = nextMinImprovementPpm({ current, observedAdvances: honestAccepts, targetAdvances, qualityAttempts: honestAttempts, majorDeltaActive, ...controllerOverrides });
    if (d.clamped) clampHits++;
    const effMax = maxImprovementCeilingPpm !== undefined ? Number(maxImprovementCeilingPpm) : Number(MAX_IMPROVEMENT_PPM);
    if (Number(d.next) === effMax && honestAccepts > targetAdvances) maxClampWhileAdvancing++;
    current = d.next; reason = d.reason;
  }
  // Round per-family component deltas for readability.
  const fstats = {};
  for (const f of HONEST_FAMILIES) {
    const s = familyStats[f]; const r4 = (x) => +x.toFixed(6);
    fstats[f] = { attempts: s.attempts, accepts: s.accepts, deltaPpmMax: s.deltaPpm.length ? Math.max(...s.deltaPpm) : null,
      componentDelta: { retrieval: r4(s.comp.retrieval), temporal: r4(s.comp.temporal), relation: r4(s.comp.relation), abstention: r4(s.comp.abstention), structural: r4(s.comp.structural) } };
  }
  rows.push({ epoch, ownerFraction: frac, activeEvalHidden: ac.evalHiddenCount, majorDeltaActive, packN: pack.events.length,
    acceptanceThresholdPpm, variancePpm: cachedVariance,
    honestAccepts, honestAttempts, positiveControlDeltaPpm: pcDelta, familyStats: fstats,
    randomProbes, randomAccepts: randAccepts, randomAcceptanceRate: +(randAccepts / Math.max(1, randomProbes)).toFixed(4), randomDeltaPpmMax: randDeltas.length ? Math.max(...randDeltas) : null,
    hillclimbProbes, hillclimbAccepts: hillAccepts, hillclimbAcceptanceRate: +(hillAccepts / Math.max(1, hillclimbProbes)).toFixed(4), hillclimbDeltaPpmMax: hillDeltas.length ? Math.max(...hillDeltas) : null,
    minImprBefore, minImprAfter: Number(current), reason,
    ...(frontierManifest ? { frontier: frontierManifest } : {}) });
  prevHonestAccepts = honestAccepts;   // aggregate-only churn trigger for the NEXT epoch (C2)
  writeStateOut(epoch);
  console.error(`[v2-lh] ep ${epoch}/${epochs} frac=${frac} packN=${pack.events.length} thr=${acceptanceThresholdPpm} | honest ${honestAccepts}/${honestAttempts}(Δ${pcDelta}) rand ${randAccepts}/${randomProbes} hill ${hillAccepts}/${hillclimbProbes} | minImpr ${minImprBefore}→${Number(current)} [${reason}]`);
}
const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/cortex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const out = {
  generatedAt: new Date().toISOString(),
  provenance: { corpus: corpusPath, corpusRoot: corpus.corpusRoot, profile: profilePath, gitSha, distHashRetrievalBenchmark: distHash, dirtyTree,
    reranker: rerankerArg === 'gpu' || rerankerArg === 'cpu' ? `Qwen/Qwen3-Reranker-0.6B@${RR.revision} (${rerankerArg})` : 'deterministic-stub',
    seed: masterSeed, replayTolerancePpm: replayTol, majorDeltaThreshold: effMajorDelta,
    majorDeltaThresholdProfilePinned: profile.majorDeltaThreshold !== undefined,
    clampBounds: { minPpm: minImprovementFloorPpm !== undefined ? Number(minImprovementFloorPpm) : Number(MIN_IMPROVEMENT_PPM),
      maxPpm: maxImprovementCeilingPpm !== undefined ? Number(maxImprovementCeilingPpm) : Number(MAX_IMPROVEMENT_PPM),
      pinnedMinPpm: Number(MIN_IMPROVEMENT_PPM), pinnedMaxPpm: Number(MAX_IMPROVEMENT_PPM),
      overridden: minImprovementFloorPpm !== undefined || maxImprovementCeilingPpm !== undefined },
    honestFamilies: HONEST_FAMILIES, targetAdvances,
    bandProgression,
    controllerMode: disableController ? (fixedMinImprovementPpm !== undefined ? `fixed=${fixedMinImprovementPpm}` : 'disabled') : 'feedback',
    // EFFECTIVE controller shape actually fed to nextMinImprovementPpm: profile-sourced
    // (controllerParamsFromProfile) unless a CLI flag overrode that field.
    controllerSource,
    controllerProfilePinned: profile.controllerParams !== undefined,
    controllerEffective: {
      rampUpMaxRatio: controllerOverrides.rampUpMaxRatio,
      decayRatio: controllerOverrides.decayRatio,
      smallDriftRatio: controllerOverrides.smallDriftRatio,
      qualityHighThreshold: controllerOverrides.qualityHighThreshold,
      qualityHighThresholdMult: controllerOverrides.qualityHighThreshold / targetAdvances,
    },
    controllerCliOverrides: { rampUpMaxRatio, decayRatio, smallDriftRatio, qualityHighThresholdMult },
    acceptanceRule: 'delta > minImprovementPpm + variancePpm + replayTolerancePpm' },
  summary: {
    epochs, scopedOwners: owners.length, baselineRecomputes,
    honestAcceptedEpochs: rows.filter((r) => r.honestAccepts > 0).length,
    meanRandomAcceptanceRate: +mean(rows.map((r) => r.randomAcceptanceRate)).toFixed(4),
    maxRandomAcceptanceRate: Math.max(...rows.map((r) => r.randomAcceptanceRate)),
    meanHillclimbAcceptanceRate: +mean(rows.map((r) => r.hillclimbAcceptanceRate)).toFixed(4),
    maxHillclimbAcceptanceRate: Math.max(...rows.map((r) => r.hillclimbAcceptanceRate)),
    clampHits, plateauRiskAtMax: maxClampWhileAdvancing,
    minImprFirst: rows[0]?.minImprBefore, minImprLast: rows.at(-1)?.minImprAfter,
    approxQwenPairs: rows.reduce((s, r) => s + r.packN * opts.rerankerInputTopK * 2 * (r.honestAttempts + r.randomProbes + r.hillclimbProbes + 1), 0),
    wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1),
    // EVIDENCE (not launch proof): anti-cheat = random+hillclimb acceptance ~0;
    // advance signal = honest accepts present; plateau = MAX-clamp-while-advancing.
    antiCheatCleanRandom: mean(rows.map((r) => r.randomAcceptanceRate)) <= 0.01,
    antiCheatCleanHillclimb: mean(rows.map((r) => r.hillclimbAcceptanceRate)) <= 0.01,
    advanceSignalPresent: rows.some((r) => r.honestAccepts > 0),
    // Per-family advance signal: which honest families actually produced accepts /
    // real retrieval+temporal gains over the run (filters single-family longevity).
    perFamily: Object.fromEntries(HONEST_FAMILIES.map((f) => {
      const accepts = rows.reduce((s, r) => s + (r.familyStats?.[f]?.accepts ?? 0), 0);
      const attempts = rows.reduce((s, r) => s + (r.familyStats?.[f]?.attempts ?? 0), 0);
      const dRetr = rows.reduce((s, r) => s + (r.familyStats?.[f]?.componentDelta?.retrieval ?? 0), 0);
      const dTemp = rows.reduce((s, r) => s + (r.familyStats?.[f]?.componentDelta?.temporal ?? 0), 0);
      const dRel = rows.reduce((s, r) => s + (r.familyStats?.[f]?.componentDelta?.relation ?? 0), 0);
      return [f, { attempts, accepts, acceptanceRate: +(accepts / Math.max(1, attempts)).toFixed(4), sumRetrievalDelta: +dRetr.toFixed(6), sumTemporalDelta: +dTemp.toFixed(6), sumRelationDelta: +dRel.toFixed(6) }];
    })),
  },
  epochs: rows,
};
const suffix = rerankerArg === 'gpu' || rerankerArg === 'cpu' ? 'qwen' : 'det';
mkdirSync(resolve(outDir), { recursive: true });
const tag = flag('tag', undefined);
const tagSuffix = tag !== undefined ? `_${tag}` : '';
const path = resolve(outDir, `V2_LONG_HORIZON_${(profile.name || 'p').toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${suffix}${tagSuffix}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log(`wrote ${path}`);
if (typeof reranker.close === 'function') reranker.close();
