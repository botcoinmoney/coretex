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
  bmuBaselineTaskFromProgram as mjsTaskFromProgram,
  rerankerReadingCompilerProgram as mjsRerankerReadingCompilerProgram,
  rerankerReadingCompilerSolves as mjsRerankerReadingCompilerSolves,
  exhaustiveMinimalProgramSearch as mjsExhaustiveMinimalProgramSearch,
  rawRerankerBaselineSolves as mjsRawRerankerBaselineSolves,
  indexerBaselineSolves as mjsIndexerBaselineSolves,
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

// ─── §17.48 spike — parity for the four new battery members ───────────────────

// A representative flagged corpus: every era's base bank (required-seed role) plus a
// suppress@1 variant (forbidden-seed role) and an offPathSuppress@1 variant. Covers
// both credited-role shapes without pulling in the sim.
function flaggedProgramCorpus() {
  const out = [];
  for (const era of ERAS) {
    for (const p of dist.bmuProgramBankForEra(era)) {
      out.push({ branchLimit: p.branchLimit, steps: p.steps.map((s) => ({ direction: s.direction, edgeType: s.edgeType })) });
      const sup = { branchLimit: p.branchLimit, steps: p.steps.map((s, i) => (i === 1 ? { direction: s.direction, edgeType: s.edgeType, suppress: true } : { direction: s.direction, edgeType: s.edgeType })) };
      const off = { branchLimit: p.branchLimit, steps: p.steps.map((s, i) => (i === 1 ? { direction: s.direction, edgeType: s.edgeType, offPathSuppress: true } : { direction: s.direction, edgeType: s.edgeType })) };
      out.push(sup, off);
    }
  }
  return out;
}

test('§17.48 parity: reranker-reading / exhaustive / raw-reranker / indexer verdicts == law-repo (flagged corpus)', () => {
  let checked = 0;
  for (const program of flaggedProgramCorpus()) {
    const dTask = dist.bmuBaselineTaskFromProgram(program);
    const mTask = mjsTaskFromProgram(program);
    assert.deepEqual(dTask, mTask, 'task-from-program parity');
    if (dTask === null) continue;
    // reranker-reading compiler: constructed program AND verdict byte-equal
    assert.deepEqual(dist.rerankerReadingCompilerProgram(dTask), mjsRerankerReadingCompilerProgram(mTask), 'reranker-reading program parity');
    assert.equal(
      dist.rerankerReadingCompilerSolves(dTask).baselineSolvable,
      mjsRerankerReadingCompilerSolves(mTask).baselineSolvable,
      'reranker-reading verdict parity',
    );
    // exhaustive/minimal search: solvable + count + minimal-sig + fromEra
    const de = dist.exhaustiveMinimalProgramSearch(dTask);
    const me = mjsExhaustiveMinimalProgramSearch(mTask);
    assert.deepEqual(
      { b: de.baselineSolvable, c: de.solvingProgramCount, s: de.minimalStepSig, f: de.fromEra },
      { b: me.baselineSolvable, c: me.solvingProgramCount, s: me.minimalStepSig, f: me.fromEra },
      'exhaustive/minimal parity',
    );
    // raw-reranker + indexer: verdict + topB
    assert.deepEqual(dist.rawRerankerBaselineSolves(dTask), mjsRawRerankerBaselineSolves(mTask), 'raw-reranker parity');
    assert.deepEqual(dist.indexerBaselineSolves(dTask), mjsIndexerBaselineSolves(mTask), 'indexer parity');
    checked += 1;
  }
  assert.ok(checked >= 36 * 3 * 3, `covered the flagged corpus (${checked})`);
});

test('§17.48 parity: bestPublicBaselineSolves VERDICT with every new opt-in flag == law-repo', () => {
  const flagSets = [
    { includeRerankerReadingCompiler: true },
    { includeExhaustiveProgramSearch: true },
    { includeRawReranker: true },
    { includeIndexer: true },
    { includeRerankerReadingCompiler: true, includeExhaustiveProgramSearch: true, includeRawReranker: true, includeIndexer: true },
  ];
  let checked = 0;
  for (const targetProgram of flaggedProgramCorpus()) {
    for (const flags of flagSets) {
      assert.deepEqual(
        dist.bestPublicBaselineSolves({ targetProgram, ...flags }),
        mjsBestPublicBaselineSolves({ targetProgram, ...flags }),
        `best-verdict parity ${JSON.stringify(flags)}`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 36 * 3 * 3 * flagSets.length);
});

test('§17.48 census sanity: on the CURRENT corpus reranker-reading + exhaustive solve ALL, raw-reranker + indexer solve NONE', () => {
  // The four baselines against every era's flagged family programs (the roles the
  // real 144-class catalog carries). Pins the headline finding: the current corpus
  // publishes its solution, so the reranker-reading compiler degenerates to the
  // topology probe (solves everything with zero discovery), while the reranker /
  // proximity floors credit nothing (the memory operation is genuinely load-bearing).
  const supFamily = (p) => ({ branchLimit: p.branchLimit, steps: p.steps.map((s, i) => (i === 1 ? { ...s, suppress: true } : { ...s })) });
  const offFamily = (p) => ({ branchLimit: p.branchLimit, steps: p.steps.map((s, i) => (i === 1 ? { ...s, offPathSuppress: true } : { ...s })) });
  for (const era of ERAS) {
    let rr = 0; let ex = 0; let raw = 0; let ix = 0; let n = 0;
    for (const base of dist.bmuProgramBankForEra(era)) {
      // three forbidden-seed families (suppress@1) + one required-seed family (offPathSuppress@1)
      for (const program of [supFamily(base), supFamily(base), supFamily(base), offFamily(base)]) {
        const task = dist.bmuBaselineTaskFromProgram(program);
        n += 1;
        if (dist.rerankerReadingCompilerSolves(task).baselineSolvable) rr += 1;
        if (dist.exhaustiveMinimalProgramSearch(task).baselineSolvable) ex += 1;
        if (dist.rawRerankerBaselineSolves(task).baselineSolvable) raw += 1;
        if (dist.indexerBaselineSolves(task).baselineSolvable) ix += 1;
      }
    }
    assert.equal(n, 144, `era ${era} census size`);
    assert.equal(rr, 144, `era ${era}: reranker-reading compiler solves all 144 (degenerate on the current corpus)`);
    assert.equal(ex, 144, `era ${era}: exhaustive/minimal search solves all 144`);
    assert.equal(raw, 0, `era ${era}: raw-reranker floor credits none`);
    assert.equal(ix, 0, `era ${era}: indexer floor credits none`);
  }
});
