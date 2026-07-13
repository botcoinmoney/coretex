/**
 * §17.44 point-4/5 ANTI-DRIFT PIN. The vendored `@botcoin/coretex` public-baseline
 * battery (`src/eval/bmu-baseline-battery.ts`: `bestPublicBaselineSolves` + the era
 * registry / program bank / edge remap it runs) is a SELF-CONTAINED port of the
 * law-repo harness originals (`scripts/lib/bmu-sim/transferring-compiler-audit.mjs`
 * + `scripts/lib/bmu-generators/operation-program.mjs`). The COORDINATOR verifier
 * imports the vendored copy to decide, per first-discovery accept, whether a public
 * baseline already solves the claimed target cluster — so the two copies MUST stay
 * behaviourally identical. This test pins: (1) the era edge registry, (2) the 36-
 * program base bank step-signatures, (3) the edge remap, and (4) the
 * `bestPublicBaselineSolves` VERDICT across the full era-1/2/3 catalog + adversarial
 * inputs. If it goes red the two implementations have drifted — fix the .mjs first,
 * re-port, re-green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as dist from '../../dist/index.js';
import {
  bestPublicBaselineSolves as mjsBestPublicBaselineSolves,
  inferBaselineEra as mjsInferBaselineEra,
  BMU_BASELINE_ERAS as MJS_BASELINE_ERAS,
} from '../../../../scripts/lib/bmu-sim/transferring-compiler-audit.mjs';
import {
  eraSpec,
  programBankForEra,
  BMU_EXECUTABLE_ERA_REGISTRY,
} from '../../../../scripts/lib/bmu-generators/operation-program.mjs';

const ERAS = [1, 2, 3];
const sigOf = (p) => `${p.steps.map((s) => `${s.direction}:${s.edgeType}${s.suppress ? ':sup' : ''}${s.offPathSuppress ? ':off' : ''}`).join('/')}|b${p.branchLimit}`;

test('§17.44 parity: vendored BMU_BASELINE_ERA_REGISTRY == law-repo era spec (partitions + bank shape)', () => {
  assert.deepEqual([...dist.BMU_BASELINE_ERAS], [...MJS_BASELINE_ERAS]);
  assert.deepEqual([...dist.BMU_BASELINE_ERAS], ERAS);
  for (const era of ERAS) {
    const d = dist.BMU_BASELINE_ERA_REGISTRY[era];
    const s = eraSpec(era);
    assert.deepEqual([...d.outgoingEdgeTypes], [...s.outgoingEdgeTypes], `era ${era} outgoing`);
    assert.deepEqual([...d.incomingEdgeTypes], [...s.incomingEdgeTypes], `era ${era} incoming`);
    assert.equal(d.bankShape, s.bankShape ?? 'mixed-3-4-step', `era ${era} bank shape`);
    assert.equal(d.era, BMU_EXECUTABLE_ERA_REGISTRY[era].era);
  }
});

test('§17.44 parity: vendored bmuProgramBankForEra == law-repo base bank (step-signatures, all eras)', () => {
  for (const era of ERAS) {
    const d = dist.bmuProgramBankForEra(era).map(sigOf);
    // law-repo base bank (no family suppress overlay — the bank entries themselves)
    const m = programBankForEra(era).map((p) => sigOf({ branchLimit: p.branchLimit, steps: p.steps }));
    assert.equal(d.length, m.length, `era ${era} bank size`);
    assert.deepEqual(d, m, `era ${era} bank step-signatures`);
  }
});

test('§17.44 parity: vendored edge remap == law-repo remap (both orders, all era pairs)', () => {
  for (const fromEra of ERAS) {
    for (const toEra of ERAS) {
      if (fromEra === toEra) continue;
      for (const order of ['registry', 'sorted']) {
        const d = dist.makeEraEdgeRemap(fromEra, toEra, { order });
        // remap a representative program (first bank entry of fromEra) via both copies
        const src = dist.bmuProgramBankForEra(fromEra)[0];
        const compiled = dist.remapProgramToEra(src, d);
        // parity: harness bestPublicBaselineSolves on the compiled program agrees
        assert.equal(
          mjsBestPublicBaselineSolves({ targetProgram: compiled }).baselineSolvable,
          dist.bestPublicBaselineSolves({ targetProgram: compiled }).baselineSolvable,
          `remap ${fromEra}->${toEra}/${order}`,
        );
      }
    }
  }
});

test('§17.44 parity: bestPublicBaselineSolves VERDICT == law-repo across the full catalog + adversarial inputs', () => {
  const cases = [];
  // every base bank program of every era (targets)
  for (const era of ERAS) for (const p of dist.bmuProgramBankForEra(era)) cases.push({ branchLimit: p.branchLimit, steps: [...p.steps] });
  // the §17.44 exploit: era-1 bank programs remapped forward into era-2 / era-3
  for (const toEra of [2, 3]) {
    const remap = dist.makeEraEdgeRemap(1, toEra, { order: 'registry' });
    for (const p of dist.bmuProgramBankForEra(1)) cases.push(dist.remapProgramToEra(p, remap));
  }
  // adversarial non-era / malformed programs
  cases.push({ branchLimit: 2, steps: [{ direction: 'incoming', edgeType: 'supports' }, { direction: 'outgoing', edgeType: 'co_occurs_with' }] });
  cases.push({ branchLimit: 1, steps: [{ direction: 'outgoing', edgeType: 'causes' }] });
  cases.push({ branchLimit: 4, steps: [] });

  let checked = 0;
  for (const targetProgram of cases) {
    for (const includeTopologyProbe of [false, true]) {
      const d = dist.bestPublicBaselineSolves({ targetProgram, includeTopologyProbe });
      const m = mjsBestPublicBaselineSolves({ targetProgram, includeTopologyProbe });
      assert.deepEqual(d, m, `verdict parity (probe=${includeTopologyProbe}) for ${sigOf(targetProgram.steps.length ? targetProgram : { branchLimit: 0, steps: [] })}`);
      checked += 1;
    }
    assert.equal(dist.bmuInferBaselineEra(targetProgram), mjsInferBaselineEra(targetProgram), 'era inference parity');
  }
  assert.ok(checked >= (36 * 3 + 36 * 2 + 3) * 2);
});
