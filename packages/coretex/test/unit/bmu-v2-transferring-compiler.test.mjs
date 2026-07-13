/**
 * §17.39 item-5 — TRANSFERRING COMPILER adversarial audit.
 *
 * `crossEraTransferAudit` proves UNCHANGED prior-era BYTECODE cannot solve the
 * next era's clusters — but that is 0/0 BY CONSTRUCTION (disjoint outgoing
 * vocabulary ⇒ the leading edge does not exist in the next era's corpus), so it
 * says nothing about a miner that reads the PUBLIC era spec and mechanically
 * REMAPS its known-good strategy. This test runs that adversary for real against
 * the actual per-era program banks + clusters and PINS the honest finding:
 *
 *  - era-1 ↔ era-2 (bank shape PRESERVED): a trivial public registry-index edge
 *    remap EXACTLY reconstructs the era-2 program (144/144 byte-identical) and
 *    solves + credits ALL 144 era-2 clusters with ZERO re-discovery. The disjoint
 *    vocabulary buys only cosmetic bytecode incompatibility.
 *  - the weaker `sorted` adversary (discards the published array ORDER) fails
 *    0/144 — proving the specific edge assignment is load-bearing, but that
 *    assignment is fully PUBLIC, so the failure is a self-handicap.
 *  - era-3 (bank shape CHANGED to all-4-step): the pure bytecode remap fails on
 *    solve (arity mismatch), yet an arity-agnostic topology-probe compiler that
 *    reads the target cluster's PUBLIC relations still solves + credits 144/144.
 *
 * Net: the disjoint-vocabulary rotation forces a miner to RE-COMPILE (mechanical,
 * ~free), not to RE-DISCOVER — no genuine per-era discovery cost. This is the
 * concrete evidence behind the §17.39 verdict that vocabulary rotation alone does
 * not prove the runway claim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as dist from '../../dist/index.js';
import {
  transferringCompilerAudit,
  makeEraEdgeRemap,
  remapProgramToEra,
  topologyProbeProgram,
  programSig,
  bestPublicBaselineSolves,
} from '../../../../scripts/lib/bmu-sim/transferring-compiler-audit.mjs';
import {
  buildClassCatalog,
} from '../../../../scripts/lib/bmu-sim/era-transition-sim.mjs';
import { programBankForEra } from '../../../../scripts/lib/bmu-generators/operation-program.mjs';

test('§17.39 item-5: crossEraTransferAudit\'s 0/0 is vacuous — a spec-reading remap transfers era-1→era-2 for FREE (144/144)', () => {
  const a = transferringCompilerAudit({ dist, fromEra: 1, toEra: 2 });
  assert.equal(a.total, 144);
  // positive controls sound
  assert.equal(a.sourceOwnControlFail, 0);
  assert.equal(a.targetOwnControlFail, 0);
  // bank shape preserved era-1→era-2, so the positional remap keeps arity
  assert.equal(a.bankShapePreserved, true);

  // STRATEGY A — registry-index remap: EXACTLY reconstructs era-2's own program
  // (byte-identical) and solves + credits every era-2 cluster. Zero re-discovery.
  const A = a.strategies.specIndexRemap;
  assert.equal(A.exactReconstruct, 144, 'registry remap reconstructs era-2 bytecode exactly');
  assert.equal(A.solved, 144, 'registry remap solves all 144 era-2 clusters');
  assert.equal(A.credited, 144, 'registry remap CREDITS all 144 era-2 clusters');
  assert.equal(A.arityMismatch, 0);

  // STRATEGY B — sorted (set-only) remap: strictly weaker; fails 0/144. Proves
  // the specific edge assignment matters — but it is PUBLIC (registry array order).
  const B = a.strategies.setCanonicalRemap;
  assert.equal(B.solved, 0, 'discarding the public array order fails to solve any');
  assert.equal(B.credited, 0);
  assert.equal(B.exactReconstruct, 0);

  // STRATEGY C — topology probe: also 144/144 (reads the public target corpus).
  const C = a.strategies.topologyProbeCompiler;
  assert.equal(C.solved, 144);
  assert.equal(C.credited, 144);

  assert.equal(a.fullCreditedTransferByAnyStrategy, true);
});

test('§17.39 item-5: era-3 bank-shape change defeats BYTECODE remap on solve but NOT an arity-agnostic spec-reader', () => {
  for (const fromEra of [1, 2]) {
    const a = transferringCompilerAudit({ dist, fromEra, toEra: 3 });
    assert.equal(a.total, 144);
    assert.equal(a.sourceOwnControlFail, 0);
    assert.equal(a.targetOwnControlFail, 0);
    // era-3 restructured the bank to all-4-step, so a positional remap of the
    // era-1/2 3-step programs produces the wrong arity for the 128 three-step
    // slots — the pure bytecode remap CANNOT solve (0/144).
    assert.equal(a.bankShapePreserved, false, `era-${fromEra}→3 bank shape differs`);
    const A = a.strategies.specIndexRemap;
    assert.equal(A.arityMismatch, 128, 'the 128 three-step programs mismatch era-3 arity');
    assert.equal(A.solved, 0, 'pure bytecode remap solves ZERO era-3 clusters');
    assert.equal(A.exactReconstruct, 0);
    // a marginal CREDITED leak survives from the 4-step programs, but NOT full transfer
    assert.ok(A.credited > 0 && A.credited < 144, `partial credited leak (${A.credited}), not full`);

    // The arity-AGNOSTIC topology-probe compiler reconstructs the era-3 traversal
    // from the target's PUBLIC relations and solves + credits ALL 144 — the
    // bank-shape change is NOT genuine discovery-cost protection.
    const C = a.strategies.topologyProbeCompiler;
    assert.equal(C.solved, 144, `era-${fromEra}→3 topology probe solves all 144`);
    assert.equal(C.credited, 144, `era-${fromEra}→3 topology probe credits all 144`);
    assert.equal(a.fullCreditedTransferByAnyStrategy, true);
  }
});

test('§17.39 item-5: the registry remap is a canonical PUBLIC isomorphism era-1↔era-2 (both directions, byte-exact)', () => {
  // Symmetry: the same public map inverts era-2 back onto era-1 exactly. This is
  // the precise sense in which era-2 is "not a genuinely new grammar" for a
  // spec-reader — it is a relabeling under a published bijection.
  const catalog = buildClassCatalog({ eras: [1, 2], queryKeyOf: dist.bmuOperationQueryKey });
  const src = [...catalog.values()];
  const by = (era) => new Map(src.filter((c) => c.era === era).map((c) => [`${c.family}:${c.ordinal}`, c]));
  const e1 = by(1); const e2 = by(2);
  const fwd = makeEraEdgeRemap(1, 2, { order: 'registry' });
  const rev = makeEraEdgeRemap(2, 1, { order: 'registry' });
  let f = 0; let r = 0;
  for (const [k, c1] of e1) {
    const c2 = e2.get(k);
    if (programSig(remapProgramToEra(c1.program, fwd)) === programSig(c2.program)) f += 1;
    if (programSig(remapProgramToEra(c2.program, rev)) === programSig(c1.program)) r += 1;
  }
  assert.equal(f, 144, 'era-1 → era-2 remap byte-exact for all 144');
  assert.equal(r, 144, 'era-2 → era-1 remap byte-exact for all 144 (inverse isomorphism)');
});

test('§17.39 item-5: topology probe reads ONLY public relations + carries the public flag plan (no private peek)', () => {
  // Guard against the probe accidentally reading the target program: reconstruct
  // from relations alone and confirm the reconstructed program equals the target
  // program's traversal (edges) and lands its operation flag correctly.
  const catalog = buildClassCatalog({ eras: [1, 2], queryKeyOf: dist.bmuOperationQueryKey });
  const e1 = [...catalog.values()].filter((c) => c.era === 1);
  const e2 = new Map([...catalog.values()].filter((c) => c.era === 2).map((c) => [`${c.family}:${c.ordinal}`, c]));
  let exact = 0;
  for (const c of e1) {
    const t = e2.get(`${c.family}:${c.ordinal}`);
    const probe = topologyProbeProgram(c.program, t);
    if (programSig(probe) === programSig(t.program)) exact += 1;
  }
  // era-1→era-2 same bank shape ⇒ the probe reconstructs the era-2 program exactly
  assert.equal(exact, 144, 'topology probe reconstructs the era-2 program byte-exact from public relations');
});

// ─── §17.44 point-4/5 — the PERMANENT baseline battery, as a standing per-program
//     novelty verdict (the mechanism the coordinator verifier imports). ─────────

test('§17.44 point-5: bestPublicBaselineSolves is a STANDING battery — the era-1→era-2 spec-remap exploit is NOT novel', () => {
  // A miner takes a solved era-1 bank program, mechanically remaps it into era-2 by
  // the PUBLIC registry index map (§17.43 strategy A) — genuinely new bytes, new
  // queryKey — and would claim it a first discovery. The standing battery finds a
  // public baseline (the remap of the era-1 bank) already solves the target cluster.
  const remap12 = makeEraEdgeRemap(1, 2, { order: 'registry' });
  let flagged = 0;
  for (const era1 of programBankForEra(1)) {
    const exploit = remapProgramToEra({ branchLimit: era1.branchLimit, steps: era1.steps }, remap12);
    const v = bestPublicBaselineSolves({ targetProgram: exploit });
    assert.equal(v.baselineSolvable, true, 'era-2 spec-remap of an era-1 bank program is baseline-solvable');
    assert.equal(v.strategy, 'specIndexRemap');
    assert.equal(v.fromEra, 1);
    assert.equal(v.targetEra, 2);
    flagged += 1;
  }
  assert.equal(flagged, 36, 'every era-1 bank program mechanically transfers to era-2');
});

test('§17.44 point-4: EVERY honest era-2 bank program is baseline-transferable (era rotation mints no novelty)', () => {
  // The honest confirmation of the operator ruling: era-2 is a public relabeling of
  // era-1, so all 36 era-2 bank programs — what a truthful era-2 producer would
  // submit as "first discoveries" — are already solved by the era-1 baseline.
  let flagged = 0;
  for (const era2 of programBankForEra(2)) {
    if (bestPublicBaselineSolves({ targetProgram: { branchLimit: era2.branchLimit, steps: era2.steps } }).baselineSolvable) flagged += 1;
  }
  assert.equal(flagged, 36, 'all 36 era-2 bank programs are public-baseline-transferable from era-1');
});

test('§17.44: an era-1 GENESIS program has no prior-era baseline — it is NOT flagged (novelty still possible)', () => {
  for (const era1 of programBankForEra(1)) {
    const v = bestPublicBaselineSolves({ targetProgram: { branchLimit: era1.branchLimit, steps: era1.steps } });
    assert.equal(v.baselineSolvable, false, 'the first era has no prior public bank to transfer from');
    assert.equal(v.targetEra, 1);
  }
});

test('§17.44: era-3 bank-shape change SURVIVES the scoped spec-remap battery but NOT the topology probe (documented degenerate)', () => {
  let specRemapFlagged = 0;
  let probeFlagged = 0;
  for (const era3 of programBankForEra(3)) {
    const p = { branchLimit: era3.branchLimit, steps: era3.steps };
    if (bestPublicBaselineSolves({ targetProgram: p }).baselineSolvable) specRemapFlagged += 1;
    if (bestPublicBaselineSolves({ targetProgram: p, includeTopologyProbe: true }).baselineSolvable) probeFlagged += 1;
  }
  // spec-remap cannot fully transfer to era-3 (bank shape changed: all-4-step vs the
  // 32 three-step era-1/2 programs) — only the marginal 4-step-arity matches leak.
  assert.ok(specRemapFlagged < 36, `era-3 not fully spec-remap-transferable (${specRemapFlagged}/36 leak)`);
  // but the arity-agnostic topology probe (the corpus publishes the solution) solves
  // every era-3 target — era-3 is NOT genuine discovery-cost protection either.
  assert.equal(probeFlagged, 36, 'topology probe defeats era-3 for all 36 (the whole task publishes its solution)');
});

test('§17.44: a non-era / malformed program has no spec-remap baseline (fail-open on the check, never a false novelty rejection)', () => {
  const arbitrary = { branchLimit: 2, steps: [{ direction: 'incoming', edgeType: 'supports' }, { direction: 'outgoing', edgeType: 'co_occurs_with' }] };
  const v = bestPublicBaselineSolves({ targetProgram: arbitrary });
  assert.equal(v.baselineSolvable, false);
  assert.equal(v.targetEra, null);
});
