/**
 * §18 era-1 → era-2 grammar-transition simulator — proves the rotation runway
 * (net>0 across the transition, costless era-1 retirement, honest miner transfer)
 * and the static-frontier control (net rate → 0), on REAL applied bounded states.
 * Also pins the cross-family dedup census honest-red finding (72/144).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import * as dist from '../../dist/index.js';
import {
  runEraTransition,
  crossFamilyDedupCensus,
  crossFamilyDistinctnessCeiling,
  era3RecommendedDesignCensus,
  crossEraTransferAudit,
  RERANKER_INPUT_TOPK,
  buildClassCatalog,
  stepSigOf,
  creditedCrossFamilyTransferCensus,
  creditedUtility,
} from '../../../../scripts/lib/bmu-sim/era-transition-sim.mjs';
import {
  executeProgramOverRelations,
  programBankForEra,
  executableOperationForFamilySlot,
} from '../../../../scripts/lib/bmu-generators/operation-program.mjs';

const FAMILIES = ['temporal', 'conflict_lifecycle', 'multi_hop_relation', 'near_collision_abstention'];

test('rotating arm: net>0 across the era transition, era-1 retirement costless, era-2 fresh', () => {
  const r = runEraTransition({ arm: 'rotating', dist, evolves: 48 });
  // era-2 minted genuinely fresh classes that required new discovery
  assert.ok(r.checks.toEraFreshDiscoveries > 0, 'era-2 fresh discoveries');
  // NET positive after transition, per family
  assert.equal(r.checks.netPositiveAfterTransition, true);
  for (const f of FAMILIES) assert.ok(r.summary.netAfterTransitionByFamily[f] > 0, `net>0 ${f}`);
  // retirement makes evictions COSTLESS: evictions happen, none costly (greedy
  // net-positive miner never makes a costly eviction — it stalls instead).
  assert.ok(r.summary.totalEvictions > 0);
  assert.equal(r.summary.totalCostlyEvictions, 0);
  // sustained net acceptance after the store saturates
  assert.equal(r.checks.sustainedNetAfterCapacity, true);
  // §17.39 item-4 (era-aware retirement) — the sustained post-capacity headroom is
  // now the GENUINE prior-era drain (≈ one costless accept per freed resident
  // slot), NOT the pre-fix free-churn number (>100) that the era-blind age sweep
  // manufactured by retiring current-era workload in lockstep. It comes ENTIRELY
  // from prior-era retirement: zero current-era instances are age-expired.
  assert.ok(r.checks.netAcceptedAfterCapacityTotal >= 20, `genuine drain headroom ${r.checks.netAcceptedAfterCapacityTotal}`);
  assert.equal(r.checks.retiredCurrentEra, 0, 'no current-era instance age-expired under rotating');
  assert.ok(r.checks.retiredPriorEra > 0, 'prior-era instances genuinely retired');
  assert.equal(r.checks.headroomFromPriorEraRetirementOnly, true);
  // applied bounded state round-trips throughout (≤32 quads decode back exactly)
  assert.equal(r.checks.appliedStateRoundTripsThroughout, true);
});

test('static control arm: net acceptance rate collapses to ~0 at saturation', () => {
  const s = runEraTransition({ arm: 'static', dist, evolves: 48 });
  assert.equal(s.checks.staticNetRateCollapsesToZero, true);
  // decisive contrast vs rotating: post-capacity sustained net accepts near zero
  assert.ok(s.checks.netAcceptedAfterCapacityTotal <= FAMILIES.length);
  const r = runEraTransition({ arm: 'rotating', dist, evolves: 48 });
  assert.ok(r.checks.netAcceptedAfterCapacityTotal > 20 * s.checks.netAcceptedAfterCapacityTotal + 20,
    'rotating sustains dramatically more post-capacity net than static');
});

// ─── §17.39 item-4: ERA-AWARE retirement + the 2×2 mechanism isolation ───────

test('§17.39 item-4: rotating retirement is ERA-AWARE — only PRIOR-era instances retire, never current-era by age', () => {
  const r = runEraTransition({ arm: 'rotating', dist, evolves: 48 });
  // The pre-fix era-blind sweep retired ANY instance past maxAge (current-era
  // included). The fix retires ONLY prior-era instances the schedule has declared
  // obsolete (past the coexistence window). So under rotating:
  assert.ok(r.summary.retiredPriorEra > 0, 'prior-era instances retire (costless feedstock)');
  assert.equal(r.summary.retiredCurrentEra, 0, 'ZERO current-era instances age-expired');
  // every retirement event is a genuinely-obsolete prior era (era < active era)
  for (const ev of r.retirementEvents) {
    assert.equal(ev.reason, 'prior-era-obsolete');
    assert.equal(ev.era, r.fromEra, 'only the fromEra (prior) retires across a single transition');
  }
  // retirement only begins AFTER the coexistence window closes (never during it)
  const firstRetire = Math.min(...r.retirementEvents.map((e) => e.epoch));
  assert.ok(firstRetire > r.transitionEpoch, 'no prior-era retirement before the transition');
});

test('§17.39 item-4: 2×2 isolation — rotation × retirement, decoupled', () => {
  const runs = {
    static: runEraTransition({ arm: 'static', dist, evolves: 48 }),
    retireOnly: runEraTransition({ arm: 'retire-only', dist, evolves: 48 }),
    rotateNoRetire: runEraTransition({ arm: 'rotate-no-retire', dist, evolves: 48 }),
    rotating: runEraTransition({ arm: 'rotating', dist, evolves: 48 }),
  };
  // (1) STATIC: neither mechanism → no renewal, headroom collapses to 0.
  assert.equal(runs.static.checks.sustainedHeadroomAfterCapacity, false);
  assert.equal(runs.static.summary.totalRetirements, 0);
  assert.equal(runs.static.checks.netHeadroomAfterCapacityTotal, 0);

  // (2) RETIRE-ONLY (age-TTL, NO rotation): reproduces the pre-fix net>0 — but it
  // is FREE CHURN. Every retirement is CURRENT-era (unjustified), so the headroom
  // is NOT sourced from genuine obsolescence. This is the isolated gimmick.
  assert.equal(runs.retireOnly.checks.sustainedHeadroomAfterCapacity, true, 'age-TTL alone shows net>0…');
  assert.ok(runs.retireOnly.summary.retiredCurrentEra > 0);
  assert.equal(runs.retireOnly.summary.retiredPriorEra, 0);
  assert.equal(runs.retireOnly.checks.headroomFromPriorEraRetirementOnly, false, '…but 100% from current-era free churn (GIMMICK)');

  // (3) ROTATE-NO-RETIRE (rotation, NO retirement): minting fresh disjoint classes
  // alone does NOT sustain — the store stays saturated with still-covered
  // residents, so net after the transition is not positive.
  assert.equal(runs.rotateNoRetire.summary.totalRetirements, 0);
  assert.equal(runs.rotateNoRetire.checks.netPositiveAfterTransition, false);
  assert.equal(runs.rotateNoRetire.checks.sustainedHeadroomAfterCapacity, false);

  // (4) ROTATING (both, era-aware): genuine sustainability — headroom>0 sourced
  // ONLY from prior-era obsolescence (zero current-era churn).
  assert.equal(runs.rotating.checks.sustainedHeadroomAfterCapacity, true);
  assert.equal(runs.rotating.checks.headroomFromPriorEraRetirementOnly, true);
  assert.equal(runs.rotating.checks.netPositiveAfterTransition, true);
  // The decisive isolation: retire-only and rotating BOTH show net>0, but only
  // rotating's is justified. static and rotate-no-retire both show net→0.
  assert.equal(runs.retireOnly.checks.headroomFromPriorEraRetirementOnly, false);
  assert.equal(runs.rotating.checks.headroomFromPriorEraRetirementOnly, true);
});

test('§17.39 item-4: frontier-chase FORCES a genuine COSTLY eviction of a still-covered CURRENT-era resident', () => {
  // A miner that chases the freshest workload (admits the newest class even at
  // net≤0) evicts still-covered residents. In a STATIC (single-era) frontier this
  // is 100% costly and yields ZERO headroom — the honest not-sustainable result.
  const s = runEraTransition({ arm: 'static', admissionPolicy: 'frontier-chase', dist, evolves: 48 });
  assert.ok(s.summary.totalCostlyEvictions > 0, 'costly evictions actually occur');
  assert.equal(s.summary.totalCostlyEvictions, s.summary.totalEvictions, 'within a static era, EVERY eviction is costly');
  assert.equal(s.checks.netHeadroomAfterCapacityTotal, 0, 'costly churn buys zero net headroom (honest: NOT sustainable)');
  assert.equal(s.checks.sustainedHeadroomAfterCapacity, false);
  // The costly eviction is a CURRENT-era resident that still covered an active
  // motif — recomputed from the active catalog, not assumed.
  const activeEra = s.fromEra;
  const costlyDetail = s.perEvolveJournal.flatMap((e) => e.evictionDetail).find((d) => d.stillCoversActiveMotif);
  assert.ok(costlyDetail, 'a costly eviction detail exists');
  assert.equal(costlyDetail.era, activeEra, 'the costly-evicted resident is current-era');
  assert.ok(costlyDetail.evictionCostUtility > 0, 'it still covered ≥1 active instance (real utility lost)');

  // Under ROTATING + frontier-chase the SAME frontier-chaser incurs costly
  // evictions WITHIN the era (before retirement) but the prior-era drain still
  // funds a POSITIVE net after the transition — retirement converts would-be-costly
  // churn into costless renewal exactly when the grammar genuinely rotates.
  const r = runEraTransition({ arm: 'rotating', admissionPolicy: 'frontier-chase', dist, evolves: 48 });
  assert.ok(r.summary.totalCostlyEvictions > 0, 'costly within-era evictions happen under rotating too');
  assert.equal(r.summary.retiredCurrentEra, 0, 'still zero current-era age-expiry (retirement stays era-aware)');
  assert.equal(r.checks.netPositiveAfterTransition, true, 'net after the transition stays >0 (prior-era drain funds it)');
  for (const f of FAMILIES) assert.ok(r.summary.netAfterTransitionByFamily[f] > 0, `net>0 after transition ${f}`);
});

test('§17.39 item-2: the sim emits VERIFIER-RECOMPUTABLE eviction evidence (decode+execute+schedule ⇒ same costly/costless)', () => {
  // Independently REPLICATE the coordinator verifier's coverage recompute
  // (bmuRecomputeEvictionCoverage) against the sim's own evictionDetail: decode the
  // evicted bytes, bind the cue, infer the era from the leading edge, RE-EXECUTE the
  // program (must solve its class), then DERIVE costliness from the era schedule —
  // and assert it agrees with the sim's stillCoversActiveMotif for EVERY eviction,
  // across BOTH the costless (net-positive) and heavily-costly (frontier-chase)
  // regimes. This proves the disclosed boolean is fully verifier-reconstructable
  // (zero producer trust) and that the sim's evidence is coordinator-compatible.
  const ERA_OUT = { 1: ['causes', 'derived_from'], 2: ['supports', 'supersedes'] };
  const recompute = (ev, entry, boundary) => {
    const shell = new Array(Number(dist.WORD_COUNT_VALUE ?? 1024n)).fill(0n);
    for (let i = 0; i < 4; i++) {
      assert.match(ev.realProgramWordsHex[i], /^0x[0-9a-f]{64}$/, 'canonical 64-hex word');
      shell[384 + i] = BigInt(ev.realProgramWordsHex[i]);
    }
    const dec = dist.decodeBmuPublicPathPrograms({ words: shell });
    assert.equal(dec.programs.length, 1); assert.equal(dec.failures, 0);
    const dp = dec.programs[0];
    assert.equal(dist.bmuOperationQueryKey(ev.evictedCue), dp.queryKey, 'cue binds to bytes');
    const era = [1, 2].find((e) => dp.steps[0].direction === 'outgoing' && ERA_OUT[e].includes(dp.steps[0].edgeType));
    assert.equal(era, ev.era, 'inferred era matches disclosed era');
    const prog = { branchLimit: dp.branchLimit, steps: dp.steps };
    // use the VENDORED primitives (same ones the coordinator imports)
    const ex = dist.executeProgramOverRelations({
      program: prog,
      relations: dist.buildProgramPathTopology({ program: prog, seedId: 'n_seed', sinkIds: ['n_sink'], goldIds: ['n_gold'], decoyIds: ['n_trap'], midIdFor: (l) => `n_mid${l}`, decoyDepth: 1 }).relations,
      seedIds: ['n_seed'], branchLimit: prog.branchLimit,
    });
    assert.deepEqual(ex.terminalIds, ['n_gold'], 'evicted program solves its own class');
    const derived = era === entry.eraId ? true : entry.epoch < boundary;
    assert.equal((ev.coverageWitness.activeInstanceCount > 0), derived, 'witness consistent with derived');
    assert.equal(ev.stillCoversActiveMotif, derived, 'disclosed boolean == verifier-derived coverage');
    return derived;
  };
  for (const admissionPolicy of ['net-positive', 'frontier-chase']) {
    const r = runEraTransition({ arm: 'rotating', admissionPolicy, dist, evolves: 48 });
    const boundary = r.transitionEpoch + r.pins.maxAgeEpochs; // coexistence window = maxAge
    let costly = 0; let total = 0;
    for (const entry of r.perEvolveJournal) {
      for (const ev of entry.evictionDetail) { total += 1; if (recompute(ev, entry, boundary)) costly += 1; }
    }
    assert.equal(costly, r.summary.totalCostlyEvictions, `${admissionPolicy} verifier-recomputed costly == sim costly`);
    if (admissionPolicy === 'frontier-chase') assert.ok(costly > 0, 'frontier-chase exercises the COSTLY recompute path');
  }
});

test('miner transfer stays honest: era-1 programs do not solve era-2 clusters (real execution)', () => {
  const catalog = buildClassCatalog({ eras: [1, 2], queryKeyOf: dist.bmuOperationQueryKey });
  const solvesWith = (program, cluster) => {
    let out;
    try {
      out = executeProgramOverRelations({ program, relations: cluster.relations, seedIds: [cluster.seedId], branchLimit: program.branchLimit });
    } catch { return false; }
    const got = new Set(out.terminalIds);
    if (got.size !== cluster.requiredTerminals.size) return false;
    for (const t of cluster.requiredTerminals) if (!got.has(t)) return false;
    return true;
  };
  // For every era-2 cluster, NO era-1 program (any family/ordinal) solves it.
  const era1Programs = [...catalog.values()].filter((c) => c.era === 1).map((c) => c.program);
  const era2Clusters = [...catalog.values()].filter((c) => c.era === 2);
  let leaked = 0;
  for (const cluster of era2Clusters) {
    // the cluster's OWN era-2 program solves it (positive control)
    assert.equal(solvesWith(cluster.program, cluster), true, `own program solves ${cluster.classKey}`);
    for (const p1 of era1Programs) if (solvesWith(p1, cluster)) leaked += 1;
  }
  assert.equal(leaked, 0, 'no era-1 program auto-solved any era-2 cluster');
});

test('cross-family dedup census: 144 cue-bound classes collapse to 72 distinct sigs (honest-red)', () => {
  const census = crossFamilyDedupCensus({ eras: [1, 2] });
  for (const era of [1, 2]) {
    assert.equal(census[era].totalCueBoundClasses, 144);
    assert.equal(census[era].distinctCrossFamilySigs, 72);
    assert.equal(census[era].collapseRatio, 0.5);
    assert.equal(census[era].narrowing, true);
    // temporal+conflict+near_collision share 36; multi_hop distinct 36
    assert.equal(census[era].familySharingSets['conflict_lifecycle+near_collision_abstention+temporal'], 36);
    assert.equal(census[era].familySharingSets.multi_hop_relation, 36);
  }
});

test('cross-family 144 target is UNREACHABLE via flags: ceiling 112 (pigeonhole); collapse is correctness-forced (accepted headroom §17.29)', () => {
  // §17.29 ruling-2 outcome: 144/144 is NOT reachable within the deep-terminal
  // bank + single-non-final-flag overlay. This locks the ceiling so a future
  // change that claims to reach 144 must FIRST change the bank shape.
  for (const era of [1, 2]) {
    const c = crossFamilyDistinctnessCeiling({ era, familyCount: 4 });
    assert.equal(c.maxDistinctCrossFamilySigs, 112, `era ${era} ceiling`);
    assert.equal(c.reaches144, false);
    assert.equal(c.perShape['3-step'].patternsPerProgram, 3); // pigeonhole: 4 families, 3 flag states
    assert.equal(c.perShape['3-step'].count, 32);
    assert.equal(c.perShape['4-step'].count, 4);
  }
  // retained design measures 72 (< 112 ceiling): the extra gap is the
  // correctness-forced 3-family seed-treatment equivalence.
  assert.equal(crossFamilyDedupCensus({ eras: [1] })[1].distinctCrossFamilySigs, 72);
});

test('§17.30 era-3 feasibility: all-4-step multi-depth bank reaches 144/144 WITHIN the pinned Qwen cap', () => {
  const d = era3RecommendedDesignCensus();
  // 144/144 distinct cross-family sigs (4 genuinely-distinct depth/flag operations)
  assert.equal(d.reaches144, true);
  assert.equal(d.distinctCrossFamilySigs, 144);
  assert.equal(d.fourGenuinelyDistinctOperations, true);
  assert.equal(d.distinctDemotionOperations, 4);
  // guards preserved
  assert.equal(d.withinFamilyReuseRatioZero, true);       // 36 distinct/family
  assert.equal(d.crossEraDisjoint, true);                 // outgoing disjoint from era-1/2
  assert.equal(d.crossEraTraversalOverlap, 0);
  // Qwen input cap is NOT binding: depth-3 mandatory pool is tiny vs 128
  assert.equal(RERANKER_INPUT_TOPK, 128);
  assert.equal(d.terminalsAdmitted, 1);                   // only the gold terminal
  assert.ok(d.terminalsAdmitted + d.promotePathIntermediates < 32, 'depth-3 pool << 128');
  assert.equal(d.withinQwenCap, true);
});

// ─── §17.32 era-3 LIVE implementation (all-4-step multi-depth) ────────────────

test('§17.35 era-3 census: 144 cue-bearing classes, 72 distinct BYTECODE sigs, 2 CREDITED classes (honest)', () => {
  const bank = programBankForEra(3);
  assert.equal(bank.length, 36);
  assert.ok(bank.every((p) => p.steps.length === 4), 'era-3 all-4-step');
  const FAM = ['temporal', 'conflict_lifecycle', 'near_collision_abstention', 'multi_hop_relation'];
  const allSigs = [];
  const allClasses = [];
  const perFam = {};
  for (const f of FAM) {
    const s = new Set();
    for (let o = 0; o < 36; o++) {
      const op = executableOperationForFamilySlot(f, o * 2, { era: 3 });
      const sig = stepSigOf(op.operationProgram);
      s.add(sig); allSigs.push(sig); allClasses.push(op.operationClass);
    }
    perFam[f] = s.size;
  }
  assert.deepEqual(perFam, { temporal: 36, conflict_lifecycle: 36, near_collision_abstention: 36, multi_hop_relation: 36 }, 'within-family reuseRatio 0');
  // CUE-bearing operationClass strings remain 144 distinct (family name is in the cue).
  assert.equal(new Set(allClasses).size, 144, 'cue-bearing operationClass census = 144');
  // But the credited law reads bytecode (topB), not the cue: the 3 forbidden-seed
  // families collapse to one suppress@1 bytecode, multi_hop is offPathSuppress@1 →
  // 72 distinct bytecode step-signatures (§17.29 confirmed, NOT 144).
  assert.equal(new Set(allSigs).size, 72, 'distinct BYTECODE step-signatures = 72 (3 forbidden families share suppress@1)');
});

test('§17.32 era-1 and era-2 output stays BYTE-IDENTICAL (additive-only regression)', () => {
  // pinned canonical signature snapshots (must never change once era-3 is added)
  const snap = (era) => programBankForEra(era).map((p) => stepSigOf(p)).join('|');
  const FAM = ['temporal', 'conflict_lifecycle', 'near_collision_abstention', 'multi_hop_relation'];
  const opSnap = (era) => FAM.map((f) => Array.from({ length: 36 }, (_, o) => executableOperationForFamilySlot(f, o * 2, { era }).operationClass).join('~')).join('##');
  // era-1 leading step is always causes/derived_from; era-2 supports/supersedes
  assert.ok(programBankForEra(1).every((p) => ['causes', 'derived_from'].includes(p.steps[0].edgeType)));
  assert.ok(programBankForEra(2).every((p) => ['supports', 'supersedes'].includes(p.steps[0].edgeType)));
  // era-1 is still 32 three-step + 4 four-step (shape unchanged)
  assert.equal(programBankForEra(1).filter((p) => p.steps.length === 3).length, 32);
  assert.equal(programBankForEra(1).filter((p) => p.steps.length === 4).length, 4);
  // era-1/2 class strings carry the v1/v2 basis unchanged
  assert.ok(executableOperationForFamilySlot('temporal', 0, { era: 1 }).operationClassBasis.endsWith('v1'));
  assert.ok(executableOperationForFamilySlot('temporal', 0, { era: 2 }).operationClassBasis.endsWith('v2'));
  // snapshots are internally consistent (stable within a run) and disjoint across eras
  assert.notEqual(snap(1), snap(2));
  assert.notEqual(opSnap(1), opSnap(3));
  // HARD byte-identity pin: era-1/era-2 canonical output (program-bank stepSigs +
  // 144 operationClass strings) hashed. These constants were captured at the
  // era-3 landing commit and MUST NEVER change — any drift means era-3 mutated a
  // prior era, violating additive-only. (Regenerate ONLY on an intentional,
  // reviewed era-1/2 grammar change, which would be a new law version.)
  const pin = (era) => createHash('sha256').update(`${snap(era)}@@${opSnap(era)}`).digest('hex');
  assert.equal(pin(1), 'a6064cee92cffbfd30d2bf5c6710d3153a454e13175b33020acf0e232b6bcc67', 'era-1 byte-identity');
  assert.equal(pin(2), '1ec4b56946c61cd7b8f5993659b0788c2a9e757ccbd0bb9fdfa400161b18bd4a', 'era-2 byte-identity');
});

test('§17.35 era-3 CREDITED own-control passes on the REAL seed role for ALL families (incl. near_collision fix)', () => {
  const qk = (cue) => BigInt('0x' + Buffer.from(cue).toString('hex').slice(0, 14).padStart(14, '0'));
  const c = creditedCrossFamilyTransferCensus({ era: 3, queryKeyOf: qk });
  // OWN-CONTROL on the REAL seed role (forbidden seed for temporal/conflict/
  // near_collision; required seed for multi_hop) — the metric the scorer credits,
  // NOT "trap demoted on a neutral seed". near_collision was the DEFECT (era-3
  // assigned offPathSuppress@1 which cannot evict its on-route forbidden seed);
  // now suppress@1 → 36/36.
  assert.deepEqual(c.ownControlByFamily, {
    temporal: 36, conflict_lifecycle: 36, near_collision_abstention: 36, multi_hop_relation: 36,
  }, 'credited own-control 36/36 every family');
  assert.equal(c.ownControlAllPass, true);
  // The HONEST distinctness: exactly 2 CREDITED operation-classes — suppress-
  // forbidden-seed (@depth1) vs spare-required-seed (@depth1). NOT 4.
  assert.deepEqual(c.creditedOperationClasses, ['forbidden@1', 'required@1'], '2 credited operation-classes (not 4)');
});

test('§17.35 near_collision REAL forbidden seed is evicted by suppress but NOT by offPathSuppress (defect regression)', () => {
  const qk = (cue) => BigInt('0x' + Buffer.from(cue).toString('hex').slice(0, 14).padStart(14, '0'));
  const cat = buildClassCatalog({ eras: [3], queryKeyOf: qk });
  const nc = [...cat.values()].find((x) => x.family === 'near_collision_abstention' && x.ordinal === 0);
  assert.equal(nc.seedRole, 'forbidden');
  assert.equal(nc.creditedCorrect, true, 'fixed suppress@1 credits its own forbidden-seed cluster');
  // Regression: the OLD offPathSuppress@1 assignment fails credited (forbidden_admitted).
  const bad = { branchLimit: nc.program.branchLimit, steps: nc.program.steps.map((s, i) => (i === 1 ? { direction: s.direction, edgeType: s.edgeType, offPathSuppress: true } : { direction: s.direction, edgeType: s.edgeType })) };
  const exec = executeProgramOverRelations({ program: bad, relations: nc.relations, seedIds: [nc.seedId], branchLimit: nc.program.branchLimit });
  const credited = creditedUtility({ exec, requiredIds: new Set(nc.requiredIds), forbiddenIds: new Set(nc.forbiddenIds) });
  assert.equal(credited.utility, 0);
  assert.equal(credited.failure, 'forbidden_admitted');
});

test('§17.32 era-2 → era-3 transition: net>0 across rotation, retirement costless, correct', () => {
  const r = runEraTransition({ arm: 'rotating', dist, fromEra: 2, toEra: 3, evolves: 48 });
  assert.equal(r.summary.operationsAllCorrect, true);
  assert.equal(r.checks.netPositiveAfterTransition, true);
  for (const f of ['temporal', 'conflict_lifecycle', 'multi_hop_relation', 'near_collision_abstention']) assert.ok(r.summary.netAfterTransitionByFamily[f] > 0);
  assert.equal(r.checks.sustainedNetAfterCapacity, true);
  assert.ok(r.summary.totalEvictions > 0);
  assert.equal(r.summary.totalCostlyEvictions, 0);
  assert.ok(r.checks.toEraFreshDiscoveries > 0);
  const s = runEraTransition({ arm: 'static', dist, fromEra: 2, toEra: 3, evolves: 48 });
  assert.equal(s.checks.staticNetRateCollapsesToZero, true);
});

test('§17.32 miner transfer honest BOTH directions across era-2 ↔ era-3 (real execution)', () => {
  const audit = crossEraTransferAudit({ dist, fromEra: 2, toEra: 3 });
  assert.equal(audit.fromSolvesToCount, 0, 'no era-2 program solves any era-3 cluster');
  assert.equal(audit.toSolvesFromCount, 0, 'no era-3 program solves any era-2 cluster');
  assert.equal(audit.ownProgramControlFailures, 0, 'every own-program positive control passes');
  assert.equal(audit.honestBothDirections, true);
  // also honest across era-1 ↔ era-3 (three-era disjointness)
  const audit13 = crossEraTransferAudit({ dist, fromEra: 1, toEra: 3 });
  assert.equal(audit13.honestBothDirections, true);
});

test('transition journal per-evolve derives eviction + costly + retirement counters', () => {
  const r = runEraTransition({ arm: 'rotating', dist, evolves: 48 });
  for (const e of r.perEvolveJournal) {
    // evictionsByFamily equals count in evictionDetail
    const counted = {};
    for (const f of FAMILIES) counted[f] = 0;
    for (const d of e.evictionDetail) counted[d.family] += 1;
    for (const f of FAMILIES) assert.equal(e.evictionsByFamily[f], counted[f]);
    // costly = detail with stillCoversActiveMotif
    for (const f of FAMILIES) {
      const costly = e.evictionDetail.filter((d) => d.family === f && d.stillCoversActiveMotif).length;
      assert.equal(e.costlyEvictionsByFamily[f], costly);
    }
    // every eviction detail carries the raw program bytes + counterfactual delta
    for (const d of e.evictionDetail) {
      assert.equal(d.realProgramWordsHex.length, 4);
      assert.equal(typeof d.counterfactualUtilityDelta, 'number');
      // a dead/retired resident costs zero by construction
      if (!d.stillCoversActiveMotif) assert.equal(d.evictionCostUtility, 0);
    }
    // the flip evolve carries the transition record exactly once
    if (e.eraTransition) { assert.equal(e.eraTransition.fromEra, 1); assert.equal(e.eraTransition.toEra, 2); }
  }
  // exactly one transition across the horizon
  assert.equal(r.perEvolveJournal.filter((e) => e.eraTransition).length, 1);
});
