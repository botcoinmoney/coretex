/**
 * §18 era-1 → era-2 grammar-transition simulator — proves the rotation runway
 * (net>0 across the transition, costless era-1 retirement, honest miner transfer)
 * and the static-frontier control (net rate → 0), on REAL applied bounded states.
 * Also pins the cross-family dedup census honest-red finding (72/144).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as dist from '../../dist/index.js';
import {
  runEraTransition,
  crossFamilyDedupCensus,
  crossFamilyDistinctnessCeiling,
  era3RecommendedDesignCensus,
  RERANKER_INPUT_TOPK,
  buildClassCatalog,
} from '../../../../scripts/lib/bmu-sim/era-transition-sim.mjs';
import { executeProgramOverRelations } from '../../../../scripts/lib/bmu-generators/operation-program.mjs';

const FAMILIES = ['temporal', 'conflict_lifecycle', 'multi_hop_relation', 'near_collision_abstention'];

test('rotating arm: net>0 across the era transition, era-1 retirement costless, era-2 fresh', () => {
  const r = runEraTransition({ arm: 'rotating', dist, evolves: 48 });
  // era-2 minted genuinely fresh classes that required new discovery
  assert.ok(r.checks.era2FreshDiscoveries > 0, 'era-2 fresh discoveries');
  // NET positive after transition, per family
  assert.equal(r.checks.netPositiveAfterTransition, true);
  for (const f of FAMILIES) assert.ok(r.summary.netAfterTransitionByFamily[f] > 0, `net>0 ${f}`);
  // retirement makes evictions COSTLESS: evictions happen, none costly
  assert.ok(r.summary.totalEvictions > 0);
  assert.equal(r.summary.totalCostlyEvictions, 0);
  // sustained net acceptance after the store saturates
  assert.equal(r.checks.sustainedNetAfterCapacity, true);
  assert.ok(r.checks.netAcceptedAfterCapacityTotal > 100);
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
