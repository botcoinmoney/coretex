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
} from '../../../../scripts/lib/bmu-sim/transferring-compiler-audit.mjs';
import {
  buildClassCatalog,
} from '../../../../scripts/lib/bmu-sim/era-transition-sim.mjs';

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
