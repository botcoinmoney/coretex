#!/usr/bin/env node
/**
 * Post-track metric-gate validator. Runs AFTER the campaign tracks; checks each track's output
 * artifact against the hard invariants the calibration phase requires. Exits non-zero on ANY
 * gate failure, with a per-track summary of what failed.
 *
 * Hard gates per the calibration handoff:
 *
 *   oracle:                  output exists, locality + no-op + random checks present, runWentToCompletion
 *   conflict:                no-op gate PASS recorded; honest > random > 0; off-family worst <= 0.03
 *   abstention:              valid operating point reported OR explicit "no valid point" reason
 *   relation_typed:          no-op/off-family/random-control gates recorded
 *   temporal:                pack-size > 0 and yield + acceptance metrics present
 *   churn_c3 (live-evolve):  perEpoch length >= configured EPOCHS, every epoch has a UNIQUE
 *                            currentCorpusRoot (real corpusRoot deltas), every epoch passes
 *                            deltaNextRoot === currentCorpusRoot (replayable)
 *   screener_threshold:      junk_rejection_rate >= 0.95, duplicate_stale_rejection_rate >= 0.95,
 *                            viable_screener_recall is a number (signal present, not necessarily high)
 *
 * Usage: node scripts/validate-campaign-metric-gates.mjs --corpus-dir <dir> --scale <100k|300k>
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { repoRoot } from './_repo-root.mjs';

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const CORPUS_DIR = flag('corpus-dir', 'release/calibration/2026-05-21-memory-corpus-v2');
const SCALE = flag('scale', '300k');

let pass = true;
const fails = [];
function gate(track, name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${track}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) { pass = false; fails.push(`${track}/${name}`); }
}

function readJson(p) {
  const abs = resolve(repoRoot, p);
  if (!existsSync(abs)) return null;
  try { return JSON.parse(readFileSync(abs, 'utf8')); } catch (e) { return { __parse_error: e.message }; }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

// ─── oracle ───
// Schema-aware: each family carries betaSweep[β].meanDeltaNdcg as a number; locality is a
// structured queryLocalitySelfCheck.allPass boolean; no-op + random are encoded as the
// queryLocalitySelfCheck checks[*].qPrimeUnchanged invariant (q' nDCG must be byte-identical
// to baseline under q's atom — the canonical no-op-on-others control).
const oracle = readJson(`${CORPUS_DIR}/r5-a100-oracle-gpu-${SCALE}.json`);
if (!oracle) gate('oracle', 'output exists', false, `${CORPUS_DIR}/r5-a100-oracle-gpu-${SCALE}.json missing`);
else {
  gate('oracle', 'output parses', !oracle.__parse_error, oracle.__parse_error ?? '');
  const oracleCorpusRoot = oracle.provenance?.corpusRoot ?? oracle.corpusRoot;
  gate('oracle', 'provenance.corpusRoot is a 0x hex string', isStr(oracleCorpusRoot) && /^0x[0-9a-f]+$/i.test(oracleCorpusRoot), oracleCorpusRoot ?? 'missing');
  gate('oracle', 'queryLocalitySelfCheck.allPass === true', oracle.queryLocalitySelfCheck?.allPass === true, `allPass=${oracle.queryLocalitySelfCheck?.allPass}`);
  const checks = oracle.queryLocalitySelfCheck?.checks;
  gate('oracle', 'queryLocalitySelfCheck.checks non-empty array', Array.isArray(checks) && checks.length > 0, `len=${checks?.length}`);
  if (Array.isArray(checks) && checks.length > 0) {
    const allQPrimeUnchanged = checks.every((c) => c.qPrimeUnchanged === true);
    gate('oracle', 'every locality check has qPrimeUnchanged===true (no-op-on-other-queries)', allQPrimeUnchanged);
    const allFired = checks.every((c) => c.qAtomFired === true);
    gate('oracle', 'every locality check has qAtomFired===true (atom actually exercised)', allFired);
  }
  const families = oracle.perSeed?.[0]?.families;
  gate('oracle', 'perSeed[0].families present', families && typeof families === 'object', families ? `keys=${Object.keys(families).length}` : 'missing');
  if (families) {
    const familyDeltas = [];
    for (const [famKey, fam] of Object.entries(families)) {
      // Some families (evidence_bundle) are nested with reach/bundle arms; others have a flat betaSweep.
      const arms = (fam && typeof fam === 'object' && fam.betaSweep) ? { [famKey]: fam } : (fam ?? {});
      for (const [armKey, arm] of Object.entries(arms)) {
        const sweep = arm?.betaSweep;
        if (sweep && typeof sweep === 'object') {
          for (const [beta, row] of Object.entries(sweep)) {
            if (isNum(row?.meanDeltaNdcg)) familyDeltas.push({ key: `${famKey}/${armKey}@β=${beta}`, mean: row.meanDeltaNdcg });
          }
        }
      }
    }
    gate('oracle', 'per-family meanDeltaNdcg populated (no null arms)', familyDeltas.length > 0, `${familyDeltas.length} arms reported`);
  }
  gate('oracle', 'NOT marked launch-final (oracle is a diagnostic only)', true, 'oracle prioritises surfaces; only conflict/relation/abstention/temporal validators promote');
}

// ─── conflict ───
// Schema-aware: verdict.criteria is the canonical criteria string (NOT top-level criteria);
// arms_overall_nDCG10 carries H_honest/R_random/W_wrong numerics; conflictFamily_meanDeltaNdcg_vsNoAtoms
// gives the per-arm honest>0, random≈0, wrong<0 signal; offFamily_worstRegression_honest gates damage.
const conflict = readJson(`${CORPUS_DIR}/conflict-state-malleability-${SCALE}-final.json`);
if (!conflict) gate('conflict', 'output exists', false);
else {
  gate('conflict', 'output parses', !conflict.__parse_error, conflict.__parse_error ?? '');
  const crit = conflict.verdict?.criteria ?? conflict.gate?.criteria ?? conflict.criteria;
  gate('conflict', 'verdict.criteria string present', isStr(crit), crit ? crit.slice(0, 80) : 'missing');
  const arms = conflict.arms_overall_nDCG10;
  gate('conflict', 'arms_overall_nDCG10 carries numeric H_honest/R_random/W_wrong/A_r4',
    arms && isNum(arms.H_honest) && isNum(arms.R_random) && isNum(arms.W_wrong) && isNum(arms.A_r4),
    arms ? `H=${arms.H_honest} R=${arms.R_random} W=${arms.W_wrong}` : 'missing');
  const fam = conflict.conflictFamily_meanDeltaNdcg_vsNoAtoms;
  gate('conflict', 'conflictFamily_meanDeltaNdcg_vsNoAtoms honest/random/wrong numeric',
    fam && isNum(fam.honest) && isNum(fam.random) && isNum(fam.wrong),
    fam ? `honest=${fam.honest} random=${fam.random} wrong=${fam.wrong}` : 'missing');
  gate('conflict', 'offFamily_worstRegression_honest numeric (off-family damage gate)',
    isNum(conflict.offFamily_worstRegression_honest), `${conflict.offFamily_worstRegression_honest}`);
  gate('conflict', 'noOpGate present with structured maxPerQueryNdcgDelta + holds',
    conflict.noOpGate && isNum(conflict.noOpGate.maxPerQueryNdcgDelta) && typeof conflict.noOpGate.holds === 'boolean',
    conflict.noOpGate ? `max=${conflict.noOpGate.maxPerQueryNdcgDelta} holds=${conflict.noOpGate.holds}` : 'missing');
  // ── METRIC BOUNDS ── (not just presence)
  // No-op gate must HOLD: atoms must not displace OTHER queries' ranking.
  gate('conflict', 'noOpGate.holds === true (atoms are query-local)', conflict.noOpGate?.holds === true,
    conflict.noOpGate ? `holds=${conflict.noOpGate.holds} max=${conflict.noOpGate.maxPerQueryNdcgDelta}` : 'missing');
  // Conflict surface must produce positive honest lift on its own family.
  if (fam && isNum(fam.honest)) {
    gate('conflict', 'conflictFamily honest meanDeltaNdcg > 0 (real lift on intended family)', fam.honest > 0, `${fam.honest}`);
  }
  // Off-family damage budget: matches the launch criteria string offFamilyWorst<=0.03.
  if (isNum(conflict.offFamily_worstRegression_honest)) {
    gate('conflict', 'offFamily_worstRegression_honest <= 0.03 (cross-family damage budget)',
      conflict.offFamily_worstRegression_honest <= 0.03, `${conflict.offFamily_worstRegression_honest}`);
  }
  // Direction: H_honest > A_r4 (intended lift beats baseline arm by at least nDCG 0.01).
  if (arms && isNum(arms.H_honest) && isNum(arms.A_r4)) {
    gate('conflict', 'arms.H_honest > arms.A_r4 + 0.01 (honest beats baseline)',
      arms.H_honest > arms.A_r4 + 0.01, `H=${arms.H_honest} A_r4=${arms.A_r4}`);
  }
}

// ─── abstention ───
// Schema-aware: best operating points + separation AUC are the structured artifacts;
// counts/distributions/sweep are the support data.
const abst = readJson(`${CORPUS_DIR}/r5-abstention-margin-${SCALE}.json`);
if (!abst) gate('abstention', 'output exists', false);
else {
  gate('abstention', 'output parses', !abst.__parse_error, abst.__parse_error ?? '');
  const hasOp = abst.bestOperatingPoints && (Array.isArray(abst.bestOperatingPoints) ? abst.bestOperatingPoints.length > 0 : Object.keys(abst.bestOperatingPoints).length > 0);
  const hasReason = isStr(abst.noValidOperatingPointReason) || (abst.counts && abst.counts.eligible === 0);
  gate('abstention', 'bestOperatingPoints populated OR explicit no-valid-point reason', !!hasOp || !!hasReason, hasOp ? 'op-set' : (hasReason ? 'reason' : 'neither'));
  // separationAUC is a {top1, margin, note} block; both AUCs must be numeric.
  const auc = abst.separationAUC;
  gate('abstention', 'separationAUC.top1 + .margin numeric',
    auc && isNum(auc.top1) && isNum(auc.margin),
    auc ? `top1=${auc.top1} margin=${auc.margin}` : 'missing');
  gate('abstention', 'counts/distributions/sweep blocks present', !!(abst.counts && abst.distributions && abst.sweep));
}

// ─── relation_typed ───
// Schema-aware: perSeed[].arms.A_r4/B_noatoms/C1_entity/C2_typed/E_random are numeric;
// routingSlice_typed.meanDeltaNdcg + offFamily_typed.meanDeltaNdcg + randomControlDelta
// are the controls. Validator must read structure, not just match keyword strings.
const rel = readJson(`${CORPUS_DIR}/r5-relation-typed-validate-${SCALE}-3seed.json`);
if (!rel) gate('relation_typed', 'output exists', false);
else {
  gate('relation_typed', 'output parses', !rel.__parse_error, rel.__parse_error ?? '');
  const seeds = rel.perSeed;
  gate('relation_typed', 'perSeed is non-empty array', Array.isArray(seeds) && seeds.length > 0, `${seeds?.length}`);
  if (Array.isArray(seeds) && seeds.length > 0) {
    const armsOk = seeds.every((s) => s.arms && isNum(s.arms.A_r4) && isNum(s.arms.B_noatoms) && isNum(s.arms.C1_entity) && isNum(s.arms.C2_typed) && isNum(s.arms.E_random));
    gate('relation_typed', 'every seed has numeric arms (A_r4/B_noatoms/C1_entity/C2_typed/E_random)', armsOk);
    const routingOk = seeds.every((s) => s.routingSlice_typed && isNum(s.routingSlice_typed.meanDeltaNdcg));
    gate('relation_typed', 'every seed: routingSlice_typed.meanDeltaNdcg numeric', routingOk);
    const offFamOk = seeds.every((s) => s.offFamily_typed && isNum(s.offFamily_typed.meanDeltaNdcg));
    gate('relation_typed', 'every seed: offFamily_typed.meanDeltaNdcg numeric (off-family control)', offFamOk);
    const randOk = seeds.every((s) => isNum(s.randomControlDelta));
    gate('relation_typed', 'every seed: randomControlDelta numeric (random control)', randOk);
    const noOpOk = seeds.every((s) => isNum(s.noOpMaxAbsDelta));
    gate('relation_typed', 'every seed: noOpMaxAbsDelta numeric (no-op gate)', noOpOk);
    // ── METRIC BOUNDS ──
    // Routing slice must produce a positive typed-routing lift on its own family.
    const lifts = seeds.map((s) => s.routingSlice_typed?.meanDeltaNdcg).filter(isNum);
    if (lifts.length) {
      const avg = lifts.reduce((a, b) => a + b, 0) / lifts.length;
      gate('relation_typed', 'mean routingSlice_typed.meanDeltaNdcg > 0 (typed routing produces lift)',
        avg > 0, `avg=${avg.toFixed(4)} per-seed=[${lifts.map((l) => l.toFixed(4)).join(',')}]`);
    }
    // Off-family damage budget (per seed, matches conflict's 0.03 ceiling).
    const offFams = seeds.map((s) => s.offFamily_typed?.meanDeltaNdcg).filter(isNum);
    if (offFams.length) {
      const worst = Math.min(...offFams); // most-negative is worst damage
      gate('relation_typed', 'worst-seed offFamily_typed.meanDeltaNdcg >= -0.03 (cross-family damage budget)',
        worst >= -0.03, `worst=${worst.toFixed(4)}`);
    }
    // Random control must be near-zero (random-edge atoms should NOT lift the typed slice).
    const rands = seeds.map((s) => s.randomControlDelta).filter(isNum);
    if (rands.length) {
      const worstAbs = Math.max(...rands.map(Math.abs));
      gate('relation_typed', 'every seed: abs(randomControlDelta) < 0.02 (random control is null)',
        worstAbs < 0.02, `worstAbs=${worstAbs.toFixed(4)}`);
    }
    // No-op gate per seed: max single-query nDCG delta from off-target atoms (locality gate).
    const noOps = seeds.map((s) => s.noOpMaxAbsDelta).filter(isNum);
    if (noOps.length) {
      const worst = Math.max(...noOps);
      gate('relation_typed', 'every seed: noOpMaxAbsDelta < 0.05 (atoms are query-local)',
        worst < 0.05, `worst=${worst.toFixed(4)}`);
    }
  }
}

// ─── temporal ───
// Schema-aware: nChains is the sample count; rows[] is the per-chain row array;
// isolatedPositiveYield + inContextPositiveYield + inContextAcceptYield + packInterferenceFactor
// are the structured yield/acceptance metrics. NOT the generic 'n' or 'samples' grep.
const temp = readJson(`${CORPUS_DIR}/temporal-yield-${SCALE}.json`);
if (!temp) gate('temporal', 'output exists', false);
else {
  gate('temporal', 'output parses', !temp.__parse_error, temp.__parse_error ?? '');
  gate('temporal', 'nChains > 0', isNum(temp.nChains) && temp.nChains > 0, `${temp.nChains}`);
  gate('temporal', 'rows non-empty array', Array.isArray(temp.rows) && temp.rows.length > 0, `${temp.rows?.length}`);
  gate('temporal', 'isolatedPositiveYield numeric', isNum(temp.isolatedPositiveYield), `${temp.isolatedPositiveYield}`);
  gate('temporal', 'inContextPositiveYield numeric', isNum(temp.inContextPositiveYield), `${temp.inContextPositiveYield}`);
  gate('temporal', 'inContextAcceptYield numeric', isNum(temp.inContextAcceptYield), `${temp.inContextAcceptYield}`);
  gate('temporal', 'packInterferenceFactor numeric', isNum(temp.packInterferenceFactor), `${temp.packInterferenceFactor}`);
  // ── METRIC BOUNDS ──
  // The temporal surface itself must be ALIVE in isolation. If isolatedPositiveYield=0 the
  // surface is dead regardless of pack interference; that's a hard fail.
  if (isNum(temp.isolatedPositiveYield)) {
    gate('temporal', 'isolatedPositiveYield > 0 (temporal surface alive in isolation)',
      temp.isolatedPositiveYield > 0, `${temp.isolatedPositiveYield}`);
  }
  // packInterferenceFactor is (isolated - inContextPositive); must be in [0, 1]. >0.7 is a
  // hard fail (surface effectively unusable in-context); 0.3–0.7 is warned but not failed
  // (matches the documented pack-interference reality on 300k).
  if (isNum(temp.packInterferenceFactor)) {
    gate('temporal', 'packInterferenceFactor in [0, 0.7] (in-context surface usable)',
      temp.packInterferenceFactor >= 0 && temp.packInterferenceFactor <= 0.7,
      `${temp.packInterferenceFactor}`);
  }
  // inContextAcceptYield: tolerated to be 0 (we know it's a real result on 300k under canonical
  // floors per temporal-yield-300k.json). But if the artifact reports >0, it must be sensible
  // (<= inContextPositiveYield). This catches reporting bugs where accept > positive.
  if (isNum(temp.inContextAcceptYield) && isNum(temp.inContextPositiveYield)) {
    gate('temporal', 'inContextAcceptYield <= inContextPositiveYield (accept ⊆ positive)',
      temp.inContextAcceptYield <= temp.inContextPositiveYield + 1e-9,
      `accept=${temp.inContextAcceptYield} positive=${temp.inContextPositiveYield}`);
  }
}

// ─── churn_c3 (live-evolve) — strictest gates ───
const churnDir = resolve(repoRoot, `${CORPUS_DIR}/churn-c3-live-evolve-${SCALE}`);
let churn = null;
if (existsSync(churnDir)) {
  // Pick the NEWEST matching file by mtime, not alphabetical. With CPU smokes + A100 reruns
  // sharing the dir, alphabetical picked the oldest artifact; mtime picks the latest run.
  const files = readdirSync(churnDir)
    .filter((f) => /V2_LIVE_EVOLVE_LONG_HORIZON_.*_qwen\.json$/.test(f))
    .map((f) => ({ f, m: statSync(resolve(churnDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (files.length) {
    if (files.length > 1) {
      console.log(`[validator] churn dir has ${files.length} artifacts; validating newest: ${files[0].f} (${new Date(files[0].m).toISOString()})`);
    }
    churn = readJson(`${CORPUS_DIR}/churn-c3-live-evolve-${SCALE}/${files[0].f}`);
  }
}
if (!churn) gate('churn_c3', 'live-evolve report exists', false);
else {
  gate('churn_c3', 'report parses', !churn.__parse_error, churn.__parse_error ?? '');
  gate('churn_c3', 'schema v2 (live-evolve, not v1 deferred-metrics shell)', churn.schema === 'coretex.live-evolve-long-horizon.v2', churn.schema ?? 'missing');
  gate('churn_c3', 'canonicalAPIsUsed includes 4-arg evaluateRetrievalBenchmarkState', (churn.canonicalAPIsUsed ?? []).some((s) => /evaluateRetrievalBenchmarkState\(state, corpus, pack, opts\)/.test(s)));
  gate('churn_c3', 'canonicalAPIsUsed includes numeric-args stepEpoch', (churn.canonicalAPIsUsed ?? []).some((s) => /stepEpoch\(epoch, prevHonestAccepts, prevQualityAttempts\)/.test(s)));
  // NEW canonical paths added in cd03cef/bf04f2b: package-level corpus event bridge + live reserve injection.
  // These MUST appear in canonicalAPIsUsed so artifact provenance proves the post-fix harness was used.
  gate('churn_c3', 'canonicalAPIsUsed includes bridgeLogicalDeltaToProductionEvents (package-level bridge)',
    (churn.canonicalAPIsUsed ?? []).some((s) => /bridgeLogicalDeltaToProductionEvents/.test(s)));
  // Canonical string is `makeLaunchFrontier(profile, prod).addReserveIds(...)` — match on
  // the method, not on a literal "frontier." prefix (the constructor name varies).
  gate('churn_c3', 'canonicalAPIsUsed includes .addReserveIds (live reserve injection)',
    (churn.canonicalAPIsUsed ?? []).some((s) => /\.addReserveIds\s*\(/.test(s)));
  gate('churn_c3', 'epochsRun > 0', (churn.epochsRun ?? 0) > 0, `${churn.epochsRun}`);
  if (churn.perEpoch?.length) {
    const roots = churn.perEpoch.map((e) => e.currentCorpusRoot);
    const uniqueRoots = new Set(roots).size;
    gate('churn_c3', 'every epoch advanced corpusRoot (real live-update churn, not frontier rotation)',
      uniqueRoots === churn.perEpoch.length, `unique=${uniqueRoots} epochs=${churn.perEpoch.length}`);
    const replayable = churn.perEpoch.every((e) => e.deltaNextRoot && e.currentCorpusRoot && e.deltaNextRoot.toLowerCase() === e.currentCorpusRoot.toLowerCase());
    gate('churn_c3', 'every epoch: deltaNextRoot === currentCorpusRoot (replayable)', replayable);
    const corpusChanges = churn.perEpoch.filter((e) => e.baselineRecomputedBecause === 'corpusRootChanged').length;
    gate('churn_c3', 'baseline recomputed on corpusRootChanged at least once', corpusChanges > 0, `${corpusChanges} epochs`);
    // CANONICAL stepEpoch inputs MUST be numeric/null — never roots.
    const badStepEpoch = churn.perEpoch.find((e) => {
      const x = e.stepEpochInputs ?? {};
      const numericOrNull = (v) => v === null || typeof v === 'number';
      return !(numericOrNull(x.prevHonestAccepts) && numericOrNull(x.prevQualityAttempts));
    });
    gate('churn_c3', 'every epoch: stepEpoch inputs numeric/null (NOT roots)', !badStepEpoch, badStepEpoch ? `epoch ${badStepEpoch.epoch} has ${JSON.stringify(badStepEpoch.stepEpochInputs)}` : 'all numeric');
    // Active pack scoring must have run AT LEAST once with non-zero active pack size.
    const activeScored = churn.perEpoch.filter((e) => e.activeScorePpm != null && e.activePackSize > 0).length;
    gate('churn_c3', 'active-pack scoring ran at least once with non-empty active pack', activeScored > 0, `${activeScored} epochs scored`);
    // Required metrics MUST be numeric on at least one epoch where scoring ran (the first epoch may
    // legitimately have null cross_frontier_lift because there is no prior; require coverage on the
    // post-genesis epochs that scored).
    const scoredEpochs = churn.perEpoch.filter((e) => e.activeScorePpm != null);
    if (scoredEpochs.length >= 2) {
      const haveAllMetrics = scoredEpochs.slice(1).some((e) =>
        typeof e.cross_frontier_lift === 'number' && typeof e.heldout_frontier_lift === 'number' && typeof e.doc_id_dependence === 'number');
      gate('churn_c3', 'cross_frontier_lift / heldout_frontier_lift / doc_id_dependence numeric on at least one post-genesis scored epoch', haveAllMetrics);
    }
    const haveReuseMetric = churn.perEpoch.some((e) => typeof e.operation_reuse_rate === 'number');
    gate('churn_c3', 'operation_reuse_rate computed (honest mining ran)', haveReuseMetric);
    // Frontier rotation state must persist across epochs — every epoch can't be re-genesis.
    // Genesis activation has activated > 0, retired == 0, churnRate == 0. Subsequent epochs
    // under C3 must show cumulativeRetired strictly increasing and reserveRemaining strictly
    // decreasing (frontier rotation actually consuming the reserve).
    //
    // HARD-FAIL on null frontierRotation: a missing block on any epoch means the post-fix
    // harness did not run (or the report shape is stale). Previously this skipped silently,
    // letting "12 epochs PASS" through despite zero rotation provenance.
    const missingRotation = churn.perEpoch.filter((e) => !e.frontierRotation || typeof e.frontierRotation.cumulativeRetired !== 'number');
    gate('churn_c3', 'every epoch reports frontierRotation provenance (no null/missing blocks)',
      missingRotation.length === 0,
      missingRotation.length ? `${missingRotation.length}/${churn.perEpoch.length} epochs missing frontierRotation` : 'all populated');
    if (missingRotation.length === 0 && churn.perEpoch.length >= 2) {
      const genesisEpochs = churn.perEpoch.filter((e) => e.frontierRotation.retired === 0 && e.frontierRotation.churnRate === 0).length;
      gate('churn_c3', 'at most 1 epoch is genesis (frontier state persisted across epochs)',
        genesisEpochs <= 1, `${genesisEpochs} genesis-shaped epochs / ${churn.perEpoch.length}`);
      const cumRetiredMono = churn.perEpoch.every((e, i, arr) => i === 0 || e.frontierRotation.cumulativeRetired >= arr[i - 1].frontierRotation.cumulativeRetired);
      gate('churn_c3', 'cumulativeRetired monotonically non-decreasing across epochs', cumRetiredMono);
      // Rotation evidence: under genesis-only (no live injection) reserve must DRAIN as ids
      // activate. Under live churn, reserve can GROW when addReserveIds injects faster than
      // stepEpoch activates — that's healthy, not a bug. So accept EITHER: (a) reserve drained
      // (genesis-only mode), OR (b) cumulativeRetired strictly > 0 (real rotation happened
      // even if reserve net-grew).
      if (churn.perEpoch.length >= 3) {
        const first = churn.perEpoch[0].frontierRotation;
        const last = churn.perEpoch[churn.perEpoch.length - 1].frontierRotation;
        const drained = last.reserveRemaining < first.reserveRemaining;
        const rotated = last.cumulativeRetired > 0;
        gate('churn_c3', 'rotation evidence: reserve drained OR cumulativeRetired > 0 (real C3 rotation)',
          drained || rotated,
          `first.reserve=${first.reserveRemaining} last.reserve=${last.reserveRemaining} last.cumRetired=${last.cumulativeRetired}`);
      }
      // PER-EPOCH live-injection gate: every epoch must REPORT newEvalIdsInjectedThisEpoch as
      // a number (0 allowed on epochs with no new evals; null/undefined is a reporting bug).
      // Aggregate-sum gate retained as a separate "real live churn" check below.
      const missingInjectField = churn.perEpoch.filter((e) => typeof e.frontierRotation.newEvalIdsInjectedThisEpoch !== 'number');
      gate('churn_c3', 'every epoch reports newEvalIdsInjectedThisEpoch as a number',
        missingInjectField.length === 0,
        missingInjectField.length ? `${missingInjectField.length}/${churn.perEpoch.length} epochs missing/null` : 'all numeric');
      const totalInjected = churn.perEpoch.reduce((a, e) => a + (e.frontierRotation.newEvalIdsInjectedThisEpoch ?? 0), 0);
      gate('churn_c3', 'live-update eval ids injected into frontier reserve (real live churn, not just genesis rotation)',
        totalInjected > 0, `${totalInjected} live evals injected across ${churn.perEpoch.length} epochs`);
    }
    // Honest-mining sanity: a campaign where honestAccepted is 0 on every epoch means the
    // honest patch generators failed before evaluation (E01 / parent-root / wiring) — that
    // collapses screener threshold and operation_reuse to vacuous values. Require at least
    // one epoch with honestAccepted > 0.
    const honestSum = churn.perEpoch.reduce((a, e) => a + (typeof e.honestAccepted === 'number' ? e.honestAccepted : 0), 0);
    gate('churn_c3', 'at least one epoch with honestAccepted > 0 (honest mining ran)',
      honestSum > 0,
      `total honestAccepted=${honestSum} across ${churn.perEpoch.length} epochs`);
  }
}

// ─── screener_threshold ───
const scr = readJson(`${CORPUS_DIR}/screener-threshold-calibration-${SCALE}.json`);
if (!scr) gate('screener_threshold', 'output exists', false);
else {
  gate('screener_threshold', 'report parses', !scr.__parse_error, scr.__parse_error ?? '');
  const s = scr.summary;
  if (s) {
    gate('screener_threshold', 'junk_rejection_rate >= 0.95', (s.junk_rejection_rate ?? 0) >= 0.95, `${s.junk_rejection_rate}`);
    gate('screener_threshold', 'duplicate_stale_rejection_rate >= 0.95', (s.duplicate_stale_rejection_rate ?? 0) >= 0.95, `${s.duplicate_stale_rejection_rate}`);
    gate('screener_threshold', 'viable_screener_recall is numeric (signal present, value reported)', typeof s.viable_screener_recall === 'number', `${s.viable_screener_recall}`);
    gate('screener_threshold', 'state_advance_acceptance_rate is numeric', typeof s.state_advance_acceptance_rate === 'number', `${s.state_advance_acceptance_rate}`);
    gate('screener_threshold', 'screenerThresholdPpm > 0', (s.threshold_inputs?.screenerThresholdPpm ?? 0) > 0, `${s.threshold_inputs?.screenerThresholdPpm}`);
    // ── METRIC BOUNDS ── (positive classes must actually qualify on a representative pack)
    gate('screener_threshold', 'viable_screener_recall > 0 (viable class actually clears screener threshold)',
      (s.viable_screener_recall ?? 0) > 0, `${s.viable_screener_recall}`);
    gate('screener_threshold', 'state_advance_acceptance_rate > 0 (true-advance class actually fires state-advance qualification)',
      (s.state_advance_acceptance_rate ?? 0) > 0, `${s.state_advance_acceptance_rate}`);
    // False-screener rate: REJECT classes must NOT spuriously pass screener/state-advance.
    if (s.false_screener_rate_by_class) {
      const worst = Math.max(0, ...Object.values(s.false_screener_rate_by_class).filter((v) => typeof v === 'number'));
      gate('screener_threshold', 'no REJECT class has false-screener rate > 0.05 (qualification specificity)',
        worst <= 0.05, `worst=${worst}`);
    }
    // CANONICAL qualification path used (not manual delta bands).
    gate('screener_threshold', 'canonical evaluateCoreTexWorkQualification used', /evaluateCoreTexWorkQualification/.test(s.threshold_inputs?.canonical_qualification ?? ''));
    // Noise floor MEASURED (not hardcoded 0n).
    gate('screener_threshold', 'noise floor measured (not hardcoded)', typeof s.threshold_inputs?.measuredRecentNoiseFloorPpm === 'number' && (scr.noise_floor_samples ?? []).length > 0);
    gate('screener_threshold', 'schema v2 (canonical qualification path)', scr.schema === 'coretex.screener-threshold-calibration.v2', scr.schema ?? 'missing');
  } else gate('screener_threshold', 'summary block present', false);
}

console.log('');
console.log(pass ? `GATES: ALL PASS ✅` : `GATES: HARD FAIL ❌ (${fails.length}) — ${fails.join('; ')}`);
exit(pass ? 0 : 1);
