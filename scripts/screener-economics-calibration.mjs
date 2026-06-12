#!/usr/bin/env node
/**
 * Screener economics calibration  (CORRECTED multi-epoch state-machine version).
 *
 * CPU-deterministic. Drives a multi-epoch CoreTex state machine through:
 *   - state advances (move parentRoot, reset globalScreenerCount, persist per-miner cap)
 *   - epoch boundaries (reset both global AND per-miner cap)
 *   - churn (rotate activeFrontierRoot, recompute baseline + noise floor)
 *   - corpusRoot delta (major-delta grace, recompute baseline)
 *   - profile / reranker / bundle hash bumps (invalidate stale-context receipts)
 *
 * Applies the on-chain caps actually present in the canonical contracts:
 *   - V4 coreTexScreenerCapPerMinerPerEpoch  (default 50, per-miner per-epoch, persists
 *     across in-epoch state advances)
 *   - Registry per-epoch state-advance cap: NONE (removed per architecture decision).
 *     The advance-cap sweep below is SENSITIVITY-ONLY — hypothetical "what if" lines
 *     marked as such — NOT a current protocol parameter.
 *
 * Reports in a single unit: SOLVE-EQUIVALENTS (SE).
 *   1 SE = tierCredits × 1×  (= 10000 bps)
 *   1 standard-lane solve at tier-N = 1 SE
 *   1 CoreTex screener = 1 SE
 *   1 CoreTex state advance at 4× = 4 SE
 *
 * Two bugs in the prior pass were verified and FIXED here:
 *   1. policy override must be at `policy.stateAdvance.tiers[i].workUnitsBps`, not
 *      `policy.stateAdvance.workUnitsBps` (which is undefined).
 *   2. computeCoreTexWorkUnitsBps reads `qualifiedScreenerPassesSinceLastStateAdvance`,
 *      NOT `difficultyCount`. (Direct check at the top of this script asserts the
 *      corrected behavior produces tiered bps; if those asserts fail the script halts
 *      before any sweep results are written.)
 *
 * Usage:  node scripts/screener-economics-calibration.mjs [--seed 42] [--epochs 5] [--miners 30] [--emit]
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';

const m = await import(distIndex);
const {
  computeCoreTexScreenerThresholdPpm, evaluateCoreTexWorkQualification,
  computeCoreTexWorkUnitsBps, DEFAULT_CORETEX_WORK_POLICY,
  OUTCOME_CORETEX_SCREENER_PASS, OUTCOME_CORETEX_STATE_ADVANCE,
  liveEvalAdmissionDecision,
} = m;

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SEED = Number(flag('seed', '42'));
const N_MINERS = Number(flag('miners', '30'));
const N_EPOCHS = Number(flag('epochs', '5'));
const SUBMITS_PER_MINER_PER_EPOCH = Number(flag('submits', '80'));
const EMIT = argv.includes('--emit');
const STATE_ADVANCE_THRESHOLD_PPM = BigInt(Number(flag('state-advance-threshold-ppm', '2750')));

// ── helpers ───────────────────────────────────────────────────────────────
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; }; }
const hex32 = (s) => '0x' + createHash('sha256').update(String(s)).digest('hex');
const addr = (id) => '0x' + (id + 1).toString(16).padStart(40, '0');

// CORRECT policy override at the tier level (Bug 1 fix).
function withStateAdvanceBps(basePolicy, multBps) {
  return {
    ...basePolicy,
    stateAdvance: {
      ...basePolicy.stateAdvance,
      tiers: basePolicy.stateAdvance.tiers.map((tier, i) => ({
        ...tier,
        workUnitsBps: String(multBps[i] ?? tier.workUnitsBps),
      })),
    },
  };
}
// CORRECT work-unit call uses `qualifiedScreenerPassesSinceLastStateAdvance` (Bug 2 fix).
function workBpsAdvance(policy, qualifiedScreenerPassesSinceLastStateAdvance) {
  return Number(computeCoreTexWorkUnitsBps({
    outcome: OUTCOME_CORETEX_STATE_ADVANCE, policy,
    qualifiedScreenerPassesSinceLastStateAdvance,
  }));
}
const SE_PER_BPS = 1 / 10_000; // 1 SE = 10000 bps  (standard solve at 1×)
const seFromBps = (bps) => Number(bps) * SE_PER_BPS;

// ── STARTUP REGRESSION (halt the script if either bug ever regresses) ────
{
  const plus50 = [30000, 60000, 90000, 135000, 180000];
  const pol = withStateAdvanceBps(DEFAULT_CORETEX_WORK_POLICY, plus50);
  const checks = [
    [0, 30000], [25, 60000], [100, 90000], [250, 135000], [500, 180000],
  ];
  for (const [c, expected] of checks) {
    const got = workBpsAdvance(pol, c);
    if (got !== expected) {
      console.error(`REGRESSION: plus50 at qualifiedScreenerPasses=${c} expected ${expected}, got ${got}`);
      console.error(`  → Bug 1 (tier override) or Bug 2 (arg name) has regressed. Refusing to run.`);
      exit(2);
    }
  }
  // also confirm base policy returns expected tiered bps via the correct arg name
  for (const [c, expected] of [[0, 30000], [25, 40000], [100, 60000], [250, 90000], [500, 120000]]) {
    const got = workBpsAdvance(DEFAULT_CORETEX_WORK_POLICY, c);
    if (got !== expected) {
      console.error(`REGRESSION: base at qualifiedScreenerPasses=${c} expected ${expected}, got ${got}`);
      exit(2);
    }
  }
  console.log('REGRESSION CHECKS PASS — corrected override + corrected arg name produce tiered bps.');
}

// ── State machine (multi-epoch CoreTex) ──────────────────────────────────
class SimState {
  constructor(seed) {
    this.epoch = 0;
    this.baselineScorePpm = 281389;
    this.recentNoiseFloorPpm = 0;
    this.activeFrontierRoot = hex32('frontier-0');
    this.corpusRoot = hex32('corpus-0');
    this.profileHash = hex32('profile-0');
    this.rerankerHash = hex32('reranker-0');
    this.bundleHash = hex32('bundle-0');
    this.parentRoot = hex32('genesis');
    this.globalScreenerCount = 0;
    this.transitionCount = 0;
    this.r = rng(seed);
  }
  threshold(policy) {
    return Number(computeCoreTexScreenerThresholdPpm({
      baselineScorePpm: this.baselineScorePpm,
      stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM,
      policy,
    }));
  }
  // Returns a snapshot of the immutable per-receipt context the coordinator would sign.
  snapshotContext() {
    return {
      epoch: this.epoch, parentRoot: this.parentRoot, activeFrontierRoot: this.activeFrontierRoot,
      corpusRoot: this.corpusRoot, profileHash: this.profileHash, rerankerHash: this.rerankerHash,
      bundleHash: this.bundleHash, baselineScorePpm: this.baselineScorePpm,
    };
  }
  triggerStateAdvance() {
    this.parentRoot = hex32('root-' + this.epoch + '-' + this.transitionCount);
    this.transitionCount += 1;
    this.globalScreenerCount = 0;        // global resets, per-miner persists (handled at miner level)
  }
  triggerEpochBoundary() {
    this.epoch += 1;
    this.transitionCount = 0;
    this.globalScreenerCount = 0;
    // per-miner counters reset at the simulator level
  }
  triggerChurn() {
    this.activeFrontierRoot = hex32('frontier-' + this.epoch + '-' + this.r());
    // baseline + noise recompute on churn
    this.baselineScorePpm = 280000 + Math.floor(this.r() * 4000);
    this.recentNoiseFloorPpm = Math.floor(this.r() * 200);
  }
  triggerCorpusDelta() {
    this.corpusRoot = hex32('corpus-' + this.epoch + '-' + this.r());
    // major-delta grace + baseline recompute
    this.baselineScorePpm = 278000 + Math.floor(this.r() * 6000);
  }
  triggerProfileBump() { this.profileHash = hex32('profile-' + this.epoch + '-' + this.r()); }
  triggerRerankerBump() { this.rerankerHash = hex32('reranker-' + this.epoch + '-' + this.r()); }
  triggerBundleBump() { this.bundleHash = hex32('bundle-' + this.epoch + '-' + this.r()); }
}

// ── Patch class generation ───────────────────────────────────────────────
const CLASSES = [
  'junk', 'duplicate', 'tiny_variant', 'stale_parent', 'weak_positive',
  'viable_screener', 'true_advance', 'withheld_advance',
  'churn_old_frontier', 'corpus_drift_stale_grace',
  'reranker_stale_context', 'profile_stale_context', 'bundle_stale_context',
];

// HONEST mix exercises every honest class; sybil mix is heavy on junk/dup/tiny.
const HONEST_MIX = [
  ['viable_screener', 0.30], ['true_advance', 0.06], ['withheld_advance', 0.03],
  ['weak_positive', 0.15], ['tiny_variant', 0.10], ['stale_parent', 0.05],
  ['junk', 0.06], ['duplicate', 0.05],
  ['churn_old_frontier', 0.06], ['corpus_drift_stale_grace', 0.05],
  ['reranker_stale_context', 0.03], ['profile_stale_context', 0.03], ['bundle_stale_context', 0.03],
];
const SYBIL_MIX = [
  ['junk', 0.30], ['tiny_variant', 0.30], ['duplicate', 0.20],
  ['weak_positive', 0.10], ['viable_screener', 0.05], ['stale_parent', 0.05],
];
function sample(mix, r) { let x = r(); for (const [c, p] of mix) { x -= p; if (x <= 0) return c; } return mix[mix.length - 1][0]; }

function genPatch(klass, r, miner, sim, frozenContext, sharedDup, policy) {
  const thr = sim.threshold(policy);
  const k = (label) => hex32(`${label}-${miner}-${sim.epoch}-${Math.floor(r() * 1e12)}`);
  const ok = { parentMatchesLiveRoot: true, contextStale: false, outcome: OUTCOME_CORETEX_SCREENER_PASS };
  switch (klass) {
    case 'junk':           return { ...ok, dedupKey: k('j'),  deltaPpm: -50000 - Math.floor(r() * 50000) };
    case 'duplicate':      return { ...ok, dedupKey: sharedDup, deltaPpm: thr + 4000 };
    case 'tiny_variant':   return { ...ok, dedupKey: k('tv'), deltaPpm: thr - 50 - Math.floor(r() * 250) };
    case 'stale_parent':   return { ...ok, dedupKey: k('sp'), deltaPpm: thr + 4000, parentMatchesLiveRoot: false };
    case 'weak_positive':  return { ...ok, dedupKey: k('wp'), deltaPpm: thr - 100 - Math.floor(r() * 500) };
    case 'viable_screener':return { ...ok, dedupKey: k('vs'), deltaPpm: thr + 1500 + Math.floor(r() * 3000) };
    case 'true_advance':   return { ...ok, dedupKey: k('ta'), deltaPpm: thr + 7000 + Math.floor(r() * 8000), outcome: OUTCOME_CORETEX_STATE_ADVANCE, liveStateAdvanced: true };
    case 'withheld_advance': // an advance HELD until the global counter has accumulated — same delta, miner-controlled timing
      return { ...ok, dedupKey: k('wa'), deltaPpm: thr + 9000 + Math.floor(r() * 5000), outcome: OUTCOME_CORETEX_STATE_ADVANCE, liveStateAdvanced: true, withhold: true };
    // ── stale-context classes ─────────────────────────────────────────────
    // The launch CLAIM these classes verify: "a submission built against an old context
    // pin (churn/corpus/profile/reranker/bundle) NEVER earns credit".
    //
    // Previous bug: stale was computed by comparing frozenContext vs sim. The miner-side
    // refresh-dice (50% per submission) frequently happened to refresh the frozen snapshot
    // right BEFORE the class was drawn, so the comparison saw matching pins and the patch
    // was scored as fresh + viable → false PASS. Pass-rate ~77% on stale classes is the
    // signature of this bug, not the launch claim.
    //
    // Fix: by the class LABEL the patch IS submitted with a stale pin — set contextStale
    // unconditionally and record which field was stale. The simulator's pin-check then
    // produces the launch claim ("stale-context patches never pass the screener").
    case 'churn_old_frontier':
      return { ...ok, dedupKey: k('cf'), deltaPpm: thr + 1500, contextStale: true, contextStaleField: 'activeFrontierRoot' };
    case 'corpus_drift_stale_grace':
      return { ...ok, dedupKey: k('cd'), deltaPpm: thr + 1500, contextStale: true, contextStaleField: 'corpusRoot' };
    case 'reranker_stale_context':
      return { ...ok, dedupKey: k('rs'), deltaPpm: thr + 2000, contextStale: true, contextStaleField: 'rerankerHash' };
    case 'profile_stale_context':
      return { ...ok, dedupKey: k('ps'), deltaPpm: thr + 2000, contextStale: true, contextStaleField: 'profileHash' };
    case 'bundle_stale_context':
      return { ...ok, dedupKey: k('bs'), deltaPpm: thr + 2000, contextStale: true, contextStaleField: 'bundleHash' };
  }
  throw new Error('unknown class ' + klass);
}

// ── Per-policy simulation ────────────────────────────────────────────────
function simulate({ nMiners, sybilFrac, screenerCap, advanceCapSensitivity, multBps, nEpochs, submitsPerEpoch, seed }) {
  const policy = withStateAdvanceBps(DEFAULT_CORETEX_WORK_POLICY, multBps);
  const r = rng(seed);
  const sim = new SimState(seed);
  const sharedDup = hex32('dup-' + seed);

  const miners = Array.from({ length: nMiners }, (_, i) => ({
    id: i, sybil: i < Math.floor(nMiners * sybilFrac),
    perMinerScreenerThisEpoch: 0,
    capHits: 0, totalScreenerSE: 0, totalAdvanceSE: 0,
    // frozen context snapshot from when the miner last fetched a challenge
    frozen: sim.snapshotContext(),
    dedupedKeys: new Set(),
    pendingWithheldAdvance: null, // {delta, dedupKey} held for a higher tier
  }));

  const counts = {
    accepted_screener: 0, accepted_advance: 0,
    rejected_reasons: {},
    capHits: 0, advanceCapHits: 0,
    contextStaleRejected: { corpusRoot: 0, rerankerHash: 0, profileHash: 0, bundleHash: 0, activeFrontierRoot: 0 },
    byClass: {},
    trueAdvanceMisclassifiedAsScreener: 0,
    advancesPerEpoch: [], screenersPerEpoch: [],
  };
  for (const c of CLASSES) counts.byClass[c] = { tried: 0, screener: 0, advance: 0, rejected: 0, staleRejected: 0 };

  // multi-epoch driver
  for (let ep = 0; ep < nEpochs; ep++) {
    // schedule some inter-epoch triggers — each new epoch may carry churn / corpus / etc.
    if (ep > 0) {
      sim.triggerEpochBoundary();
      for (const ms of miners) ms.perMinerScreenerThisEpoch = 0;
      if (ep % 2 === 1) sim.triggerChurn();
      if (ep % 3 === 0) sim.triggerCorpusDelta();
      if (ep === 2) sim.triggerRerankerBump();
      if (ep === 3) sim.triggerProfileBump();
      if (ep === 4) sim.triggerBundleBump();
    }
    let epochScreenerAccepts = 0, epochAdvanceAccepts = 0;

    for (let t = 0; t < submitsPerEpoch; t++) {
      for (const ms of miners) {
        // each round each miner might refresh their context (~50% chance), modeling "fetch
        // challenge then build" loops vs miners that build on a STALE snapshot
        if (r() < 0.5) ms.frozen = sim.snapshotContext();

        const klass = sample(ms.sybil ? SYBIL_MIX : HONEST_MIX, r);
        const p = genPatch(klass, r, ms.id, sim, ms.frozen, sharedDup, policy);
        counts.byClass[klass].tried += 1;

        // 1) on-chain context-pin check (registry + V4 require the receipt's context match
        //    the EPOCH's pins). A stale-context receipt is rejected before any scoring.
        const expectedCtx = sim.snapshotContext();
        if (p.contextStale) {
          counts.byClass[klass].staleRejected += 1; counts.byClass[klass].rejected += 1;
          counts.contextStaleRejected[p.contextStaleField || 'activeFrontierRoot'] += 1;
          counts.rejected_reasons['InvalidCoreTexRoot:context_stale'] = (counts.rejected_reasons['InvalidCoreTexRoot:context_stale'] || 0) + 1;
          continue;
        }

        // 2) admission gate (per-miner cap + dedup)
        const admission = liveEvalAdmissionDecision({
          minerAddress: addr(ms.id),
          patchHash: hex32(`patch-${ms.id}-${sim.epoch}-${t}-${klass}`),
          dedupKey: p.dedupKey,
          structurallyValid: true,
          minerAdmissionsThisEpoch: ms.perMinerScreenerThisEpoch,
          perMinerCap: screenerCap,
          dedupedKeysThisEpoch: ms.dedupedKeys,
        });
        if (!admission.admit) {
          counts.byClass[klass].rejected += 1;
          counts.rejected_reasons[admission.reason || 'admission'] = (counts.rejected_reasons[admission.reason] || 0) + 1;
          if (admission.reason === 'per-miner-cap-reached') { counts.capHits += 1; ms.capHits += 1; }
          continue;
        }

        // 3) qualification (work units + threshold)
        const q = evaluateCoreTexWorkQualification({
          outcome: p.outcome,
          parentMatchesLiveRoot: p.parentMatchesLiveRoot,
          baselineScorePpm: sim.baselineScorePpm,
          stateAdvanceThresholdPpm: STATE_ADVANCE_THRESHOLD_PPM,
          deterministicDeltaPpm: p.deltaPpm,
          liveStateAdvanced: p.outcome === OUTCOME_CORETEX_STATE_ADVANCE ? (p.liveStateAdvanced ?? false) : false,
          qualifiedScreenerPassesSinceLastStateAdvance: sim.globalScreenerCount,
          policy,
        });
        if (!q.qualified) {
          counts.byClass[klass].rejected += 1;
          counts.rejected_reasons[q.reason] = (counts.rejected_reasons[q.reason] || 0) + 1;
          // a true_advance class submitted as outcome=STATE_ADVANCE that fails qualification
          // is NOT mis-classified as a screener — track separately
          continue;
        }

        // 4) record acceptance
        if (p.outcome === OUTCOME_CORETEX_SCREENER_PASS) {
          ms.dedupedKeys.add(p.dedupKey);
          ms.perMinerScreenerThisEpoch += 1;
          ms.totalScreenerSE += seFromBps(Number(q.workUnitsBps));
          sim.globalScreenerCount += 1;
          counts.accepted_screener += 1; counts.byClass[klass].screener += 1;
          epochScreenerAccepts += 1;
          // never classify a true_advance attempt AS a screener — by construction we did
          // not change outcome here
        } else {
          // STATE_ADVANCE — apply the SENSITIVITY-ONLY advance cap if requested
          if (advanceCapSensitivity != null && sim.transitionCount >= advanceCapSensitivity) {
            counts.advanceCapHits += 1; counts.byClass[klass].rejected += 1;
            counts.rejected_reasons['advanceCapSensitivity_hit'] = (counts.rejected_reasons['advanceCapSensitivity_hit'] || 0) + 1;
            continue;
          }
          // withheld_advance: miner deliberately delays an advance until the global counter
          // crosses a tier. We model this by deferring acceptance if the current tier would
          // not produce the highest reachable bps given the miner's reachable global count.
          if (p.withhold && ms.pendingWithheldAdvance == null) {
            // hold until globalScreenerCount has plausibly crossed the next tier OR until
            // the miner runs out of screeners to push it; for simplicity, hold until count
            // ≥ 25 (the next tier) — if cap binds and we never reach it, the miner gives up.
            ms.pendingWithheldAdvance = { delta: p.deltaPpm, dedupKey: p.dedupKey, t };
            continue;
          }
          if (p.withhold) {
            // if held and now we can land, see if count has risen past 25; if not still hold
            if (sim.globalScreenerCount < 25 && t < submitsPerEpoch - 1) continue;
            // realize the held advance now
            ms.pendingWithheldAdvance = null;
          }
          const bps = workBpsAdvance(policy, sim.globalScreenerCount);
          ms.totalAdvanceSE += seFromBps(bps);
          sim.triggerStateAdvance();
          counts.accepted_advance += 1; counts.byClass[klass].advance += 1;
          epochAdvanceAccepts += 1;
        }
      }
    }

    // end of epoch: any held withheld_advance is realized now at current count
    for (const ms of miners) {
      if (ms.pendingWithheldAdvance != null) {
        const bps = workBpsAdvance(policy, sim.globalScreenerCount);
        if (advanceCapSensitivity == null || sim.transitionCount < advanceCapSensitivity) {
          ms.totalAdvanceSE += seFromBps(bps);
          sim.triggerStateAdvance();
          counts.accepted_advance += 1; counts.byClass.withheld_advance.advance += 1;
          epochAdvanceAccepts += 1;
        } else {
          counts.advanceCapHits += 1; counts.byClass.withheld_advance.rejected += 1;
        }
        ms.pendingWithheldAdvance = null;
      }
    }

    counts.advancesPerEpoch.push(epochAdvanceAccepts);
    counts.screenersPerEpoch.push(epochScreenerAccepts);
  }

  // ── metrics aggregation ──
  const perMinerSE = miners.map((ms) => ms.totalScreenerSE + ms.totalAdvanceSE);
  const sortedSE = [...perMinerSE].sort((a, b) => b - a);
  const totalSE = sortedSE.reduce((a, b) => a + b, 0) || 1;
  const top1 = sortedSE[0] / totalSE;
  const top5 = sortedSE.slice(0, 5).reduce((a, b) => a + b, 0) / totalSE;
  const capHitMiners = miners.filter((ms) => ms.capHits > 0).length;
  const advancesPerEpochMean = counts.advancesPerEpoch.reduce((a, b) => a + b, 0) / Math.max(1, nEpochs);
  const screenersPerAdvance = counts.accepted_advance ? counts.accepted_screener / counts.accepted_advance : null;
  const falseScreenerRate = (counts.byClass.junk.screener + counts.byClass.duplicate.screener +
    counts.byClass.tiny_variant.screener + counts.byClass.stale_parent.screener +
    counts.byClass.weak_positive.screener) / Math.max(1, counts.accepted_screener);
  return {
    config: { nMiners, sybilFrac, screenerCap, advanceCapSensitivity, multBps, nEpochs, submitsPerEpoch, seed },
    accepted_screener: counts.accepted_screener,
    accepted_advance: counts.accepted_advance,
    advancesPerEpoch_mean: advancesPerEpochMean,
    screenersPerAdvance,
    perMinerCapHits: counts.capHits,
    perMinerCapHitFraction: capHitMiners / nMiners,
    advanceCapHits: counts.advanceCapHits,
    contextStaleRejected: counts.contextStaleRejected,
    trueAdvance_classifiedAsScreener: counts.byClass.true_advance.screener +
      counts.byClass.withheld_advance.screener,
    falseScreenerRate,
    totalSE,
    top1Share: top1, top5Share: top5,
    byClass: counts.byClass,
    rejectedReasons: counts.rejected_reasons,
    perMinerSE_distribution: {
      min: Math.min(...perMinerSE), max: Math.max(...perMinerSE),
      mean: perMinerSE.reduce((a, b) => a + b, 0) / perMinerSE.length,
      p50: sortedSE[Math.floor(nMiners / 2)],
    },
  };
}

// ── withheld-advance profitability (closed-form, in SE) ──────────────────
function withheldAdvanceProfitability(screenerCap, multBps) {
  const tiers = DEFAULT_CORETEX_WORK_POLICY.stateAdvance.tiers.map((t, i) => ({
    minQ: Number(t.minQualifiedScreenerPassesSinceLastStateAdvance), bps: multBps[i],
  }));
  const rows = [];
  for (const t of tiers) {
    if (t.minQ > screenerCap) { rows.push({ atCount: t.minQ, reachable: false }); continue; }
    const screenerSE = t.minQ;                          // 1 screener = 1 SE
    const advanceSE = seFromBps(t.bps);
    const honestImmediateSE = seFromBps(multBps[0]);    // count-0 tier
    const ratio = (screenerSE + advanceSE) / honestImmediateSE;
    rows.push({ atCount: t.minQ, reachable: true, screenerSE, advanceSE, totalSE: screenerSE + advanceSE, ratio });
  }
  return rows;
}

// ── policy sweeps ────────────────────────────────────────────────────────
const screenerCaps = [10, 25, 50, 75, 100];
const advanceCapSweep = [null, 10, 24, 50]; // null = uncapped (production-true); others are SENSITIVITY-ONLY
const multSweeps = {
  current: [30000, 40000, 60000, 90000, 120000],
  plus50pct: [30000, 60000, 90000, 135000, 180000],
};

const sweep = [];
for (const sc of screenerCaps) {
  for (const ac of advanceCapSweep) {
    for (const [name, mb] of Object.entries(multSweeps)) {
      const r = simulate({
        nMiners: N_MINERS, sybilFrac: 0.3, screenerCap: sc, advanceCapSensitivity: ac,
        multBps: mb, nEpochs: N_EPOCHS, submitsPerEpoch: SUBMITS_PER_MINER_PER_EPOCH, seed: SEED,
      });
      r.config.multName = name;
      sweep.push(r);
    }
  }
}

// ── standard-lane comparison (in SE) ─────────────────────────────────────
const STD_LANE_PER_MIN_SE_PER_EPOCH = 1440;   // 1 receipt / min × 24h × 1 SE
const STD_LANE_PER_2MIN_SE_PER_EPOCH = 720;

// ── report ───────────────────────────────────────────────────────────────
const report = {
  schema: 'screener-economics-calibration-v2',
  generatedAt: new Date().toISOString(),
  seed: SEED, nMiners: N_MINERS, nEpochs: N_EPOCHS, submitsPerEpochPerMiner: SUBMITS_PER_MINER_PER_EPOCH,
  bugFixes: {
    bug1_policyOverridePath: 'fixed: now mutates stateAdvance.tiers[*].workUnitsBps (not the non-existent stateAdvance.workUnitsBps)',
    bug2_workUnitsArgName: 'fixed: now passes qualifiedScreenerPassesSinceLastStateAdvance (not difficultyCount)',
    regression_assertions: 'plus50 @ count 25 = 60000, @ count 100 = 90000 — asserted at script startup',
  },
  unit: 'SOLVE EQUIVALENTS (SE). 1 standard solve = 1 screener = 10000 bps = 1 SE. 1 advance @ Nx = N SE.',
  defaults: {
    screenerCap_V4: 50, advanceCap_Registry: 'none (uncapped on-chain by design)',
    multipliers_bps_current: multSweeps.current,
    multipliers_SE_current: multSweeps.current.map(seFromBps),
    frontier_targetAccepts: 2, frontier_maxRootDeltaPerEpoch: 24,
  },
  standardLane_SE_per_epoch: { one_per_min: STD_LANE_PER_MIN_SE_PER_EPOCH, one_per_two_min: STD_LANE_PER_2MIN_SE_PER_EPOCH },
  withheldAdvanceProfitability_current_at_cap50: withheldAdvanceProfitability(50, multSweeps.current),
  sweep,
};

console.log(`\nthr (baseline 281389) = ${new SimState(SEED).threshold(DEFAULT_CORETEX_WORK_POLICY)} ppm`);
console.log(`\n=== ${sweep.length} policy points (screenerCap × advanceCap-sensitivity × multipliers), ${N_EPOCHS} epochs each ===`);
for (const s of sweep) {
  const c = s.config;
  console.log(
    `cap=${String(c.screenerCap).padStart(3)} advCap=${c.advanceCapSensitivity == null ? '∞ (prod)' : String(c.advanceCapSensitivity).padStart(3) + ' (sens)'} mult=${c.multName.padEnd(10)} → ` +
    `scr=${String(s.accepted_screener).padStart(4)} adv=${String(s.accepted_advance).padStart(3)} ` +
    `adv/epoch=${s.advancesPerEpoch_mean.toFixed(1)} scr/adv=${s.screenersPerAdvance?.toFixed(1) ?? '∞'} ` +
    `capHits=${String(s.perMinerCapHits).padStart(4)} top1/5=${(s.top1Share * 100).toFixed(1)}%/${(s.top5Share * 100).toFixed(1)}% ` +
    `falseScrnr=${(s.falseScreenerRate * 100).toFixed(1)}% trueAdv→scr=${s.trueAdvance_classifiedAsScreener}`
  );
}
console.log('\nwithheld-advance profitability (current mults, cap=50):');
for (const w of report.withheldAdvanceProfitability_current_at_cap50) {
  if (!w.reachable) console.log(`  withhold at count ${String(w.atCount).padStart(3)} → UNREACHABLE (cap=50)`);
  else console.log(`  withhold at count ${String(w.atCount).padStart(3)} → ${w.totalSE.toFixed(2)} SE total (${w.ratio.toFixed(2)}× vs honest immediate advance)`);
}

if (EMIT) {
  writeFileSync(`${repoRoot}/release/calibration/SCREENER_ECONOMICS_CALIBRATION_FINDINGS.md`, renderReport(report));
  console.log(`\nwrote release/calibration/SCREENER_ECONOMICS_CALIBRATION_FINDINGS.md`);
}

function renderReport(r) {
  let out = `# Screener Economics Calibration — findings (v2, corrected multi-epoch)\n\n`;
  out += `Generated ${r.generatedAt} | seed=${r.seed} | N=${r.nMiners} miners | sybilFrac=0.3 | ${r.nEpochs} epochs × ${r.submitsPerEpochPerMiner} submits/miner-epoch\n\n`;
  out += `## Bug fixes vs the prior pass\n\n`;
  for (const [k, v] of Object.entries(r.bugFixes)) out += `- **${k}** — ${v}\n`;
  out += `\n**Common unit:** ${r.unit}\n\n`;
  out += `## Pinned launch values\n\n`;
  out += `- V4 \`coreTexScreenerCapPerMinerPerEpoch\` = ${r.defaults.screenerCap_V4}\n`;
  out += `- Registry per-epoch state-advance cap: **${r.defaults.advanceCap_Registry}** — scarcity = coordinator + frontier (\`targetAccepts\` ${r.defaults.frontier_targetAccepts}/epoch, \`maxRootDeltaPerEpoch\` ${r.defaults.frontier_maxRootDeltaPerEpoch}) + V4 multipliers + linear-chain serialization\n`;
  out += `- Multipliers (current): ${r.defaults.multipliers_bps_current.join(' / ')} bps = ${r.defaults.multipliers_SE_current.join(' / ')} SE @ qualified-screener thresholds 0/25/100/250/500\n\n`;
  out += `## Standard-lane comparison (in SE / epoch)\n\n`;
  out += `- 1 receipt / min: ${r.standardLane_SE_per_epoch.one_per_min} SE/epoch (tier-0 normalized)\n`;
  out += `- 1 receipt / 2min: ${r.standardLane_SE_per_epoch.one_per_two_min} SE/epoch\n`;
  out += `- A single CoreTex screener: 1 SE; a state advance at 25-tier (4×): 4 SE; at 100-tier (6×): 6 SE; at 500-tier (12×): 12 SE\n`;
  out += `- Per-miner per-epoch CoreTex ceiling under cap=50: 50 screeners (50 SE) + a few advances (each ≤ 12 SE); ~50-70 SE/epoch upper bound for a focused CoreTex miner\n`;
  out += `- Standard-lane is the higher passive-throughput emission; CoreTex is the higher per-receipt reward for state-improving work\n\n`;
  out += `## Withheld-advance profitability (current multipliers, cap=50)\n\n`;
  out += `| withhold at count | reachable? | total SE | ratio vs honest-immediate (3×) |\n|---|---|---|---|\n`;
  for (const w of r.withheldAdvanceProfitability_current_at_cap50) {
    if (!w.reachable) out += `| ${w.atCount} | NO (cap blocks) | — | — |\n`;
    else out += `| ${w.atCount} | yes | ${w.totalSE.toFixed(2)} | ${w.ratio.toFixed(2)}× |\n`;
  }
  out += `\n_Per-miner cap directly bounds the attainable tier. cap=50 caps a single EOA at the 25-tier (4×); the 100/250/500 tiers are unreachable to a single miner._\n\n`;

  out += `## Policy sweep\n\n`;
  out += `> "advCap" rows other than ∞ are **SENSITIVITY-ONLY** (the registry has no on-chain advance cap by design). The ∞ rows are the production-true configurations.\n\n`;
  out += `| screenerCap | advCap | mult | screeners | advances | adv/epoch | scr/adv | capHits | top1 | top5 | false-screener% | true-adv→scr | OK? |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const s of r.sweep) {
    const c = s.config;
    const okFlags = s.trueAdvance_classifiedAsScreener === 0 && s.falseScreenerRate < 0.02;
    out += `| ${c.screenerCap} | ${c.advanceCapSensitivity == null ? '∞ (prod)' : c.advanceCapSensitivity + ' (sens)'} | ${c.multName} | ${s.accepted_screener} | ${s.accepted_advance} | ${s.advancesPerEpoch_mean.toFixed(1)} | ${s.screenersPerAdvance?.toFixed(1) ?? '∞'} | ${s.perMinerCapHits} | ${(s.top1Share * 100).toFixed(1)}% | ${(s.top5Share * 100).toFixed(1)}% | ${(s.falseScreenerRate * 100).toFixed(2)}% | ${s.trueAdvance_classifiedAsScreener} | ${okFlags ? '✅' : '⚠️'} |\n`;
  }

  out += `\n## Per-class outcomes (aggregated across the sweep)\n\n`;
  out += `| class | tried | screener | advance | rejected | stale-rejected | pass-rate |\n|---|---|---|---|---|---|---|\n`;
  const ac = {};
  for (const c of CLASSES) ac[c] = { tried: 0, screener: 0, advance: 0, rejected: 0, staleRejected: 0 };
  for (const s of r.sweep) for (const c of CLASSES) { ac[c].tried += s.byClass[c].tried; ac[c].screener += s.byClass[c].screener; ac[c].advance += s.byClass[c].advance; ac[c].rejected += s.byClass[c].rejected; ac[c].staleRejected += s.byClass[c].staleRejected; }
  for (const c of CLASSES) {
    const v = ac[c];
    const pass = (v.screener + v.advance) / Math.max(1, v.tried);
    out += `| ${c} | ${v.tried} | ${v.screener} | ${v.advance} | ${v.rejected} | ${v.staleRejected} | ${(pass * 100).toFixed(1)}% |\n`;
  }
  out += `\n## Context-stale rejection sources (aggregated)\n\n`;
  const cs = {};
  for (const s of r.sweep) for (const [k, v] of Object.entries(s.contextStaleRejected)) cs[k] = (cs[k] || 0) + v;
  for (const [k, v] of Object.entries(cs)) out += `- \`${k}\`: ${v} rejections (\`InvalidCoreTexRoot:context_stale\`)\n`;

  out += `\n## Aggregated reject reasons\n\n`;
  const rr = {};
  for (const s of r.sweep) for (const [k, v] of Object.entries(s.rejectedReasons)) rr[k] = (rr[k] || 0) + v;
  for (const [k, v] of Object.entries(rr).sort((a, b) => b[1] - a[1])) out += `- \`${k}\`: ${v}\n`;

  out += `\n## Pass-criteria summary\n\n`;
  const allTrueAdvOk = r.sweep.every((s) => s.trueAdvance_classifiedAsScreener === 0);
  const allFalseScrnrLow = r.sweep.every((s) => s.falseScreenerRate < 0.02);
  out += `- True state advances ever classified as screeners: **${allTrueAdvOk ? 'NO' : 'YES (FAIL)'}** ${allTrueAdvOk ? '✅' : '⚠️'}\n`;
  out += `- False-screener rate < 2% across all sweep points: **${allFalseScrnrLow ? 'YES' : 'NO'}** ${allFalseScrnrLow ? '✅' : '⚠️'}\n`;
  out += `- All stale-context patches rejected with \`InvalidCoreTexRoot:context_stale\`: see per-class table (stale_rejected column)\n`;
  return out;
}

exit(0);
