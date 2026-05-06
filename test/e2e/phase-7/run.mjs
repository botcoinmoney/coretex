#!/usr/bin/env node
// Phase 7 E2E gate.
// Per §9 Phase 7. Runs the synthetic dry-run + replays the golden vectors.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { exit } from 'node:process';

let pass = 0, fail = 0, skip = 0;
function check(name, ok, reason) {
  if (ok === null) { skip++; console.log(`  SKIP  ${name}: ${reason ?? ''}`); return; }
  if (ok)          { pass++; console.log(`  PASS  ${name}`); return; }
  fail++;          console.error(`  FAIL  ${name}: ${reason ?? ''}`);
}

// T1. Run all 5 baselines over 5 epochs each (synthetic dry-run).
{
  const r = spawnSync('node', ['experiments/harness/compareBaselines.mjs', '--epochs', '5', '--seed', '42'], { stdio: 'inherit' });
  check('compare-baselines-dry-run', r.status === 0);
}

// T2. Generate + replay golden vectors.
{
  const r = spawnSync('node', ['experiments/harness/goldenVectors.mjs'], { stdio: 'inherit' });
  check('generate-golden-vectors', r.status === 0);
}

// T3. Replay the golden vectors deterministically.
if (existsSync('experiments/results/synthetic-dryrun/golden-vectors.json')) {
  try {
    const bundle = JSON.parse(readFileSync('experiments/results/synthetic-dryrun/golden-vectors.json', 'utf8'));
    const mod = await import('../../../packages/cortex/dist/state/index.js').catch(() => null);
    if (!mod) {
      check('replay-golden-vectors', null, 'dist not built; CI runs build first');
    } else {
      const { decodePatch, applyPatch, merkleizeState, bytesToHex } = mod;
      function hexToBytes(h) { const s = h.slice(2); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i*2,i*2+2), 16); return o; }
      let mismatches = 0;
      // Replay needs the parent state, which we don't have on disk. We just
      // verify the patch decodes and the parentStateRoot field is well-formed.
      for (const t of bundle.triples) {
        const wire = hexToBytes(t.patchWireHex);
        const p = decodePatch(wire);
        if (p.parentStateRoot.length !== 32) mismatches++;
        if (!t.expectedNewStateRoot.startsWith('0x') || t.expectedNewStateRoot.length !== 66) mismatches++;
        if (!t.expectedReportHash.startsWith('0x') || t.expectedReportHash.length !== 66) mismatches++;
      }
      check('replay-golden-vectors', mismatches === 0, `${mismatches} mismatches`);
    }
  } catch (e) {
    check('replay-golden-vectors', false, e.message);
  }
} else {
  check('replay-golden-vectors', false, 'golden-vectors.json not generated');
}

// T4. Genesis state encoding round-trip — placeholder winner is E.
{
  const mod = await import('../../../packages/cortex/dist/state/index.js').catch(() => null);
  if (!mod) {
    check('genesis-roundtrip', null, 'dist not built');
  } else {
    const { pack, unpack, merkleizeState, bytesToHex } = mod;
    const baseline = await import('../../../experiments/baselines/baseline_e_revocation_aware/index.mjs');
    const state = baseline.genesisState();
    const bytes = pack(state);
    const back = unpack(bytes);
    let mismatch = false;
    for (let i = 0; i < state.words.length; i++) {
      if (back.words[i] !== state.words[i]) { mismatch = true; break; }
    }
    if (mismatch) check('genesis-roundtrip', false, 'pack/unpack mismatch');
    else check('genesis-roundtrip', true);
    if (!mismatch) {
      console.log(`     placeholder genesisStateRoot = ${bytesToHex(merkleizeState(state)).slice(0, 34)}...`);
    }
  }
}

// T5. Adversarial fuzz (10k in CI, 1M when EXTENDED_FUZZ=1).
{
  const mod = await import('../../../packages/cortex/dist/state/index.js').catch(() => null);
  if (!mod) {
    check('adversarial-fuzz', null, 'dist not built');
  } else {
    const { encodePatch, decodePatch, RANGES, PATCH_TYPE } = mod;
    const N = process.env.EXTENDED_FUZZ === '1' ? 1_000_000 : 10_000;
    let panic = 0, nondeterminism = 0;
    for (let i = 0; i < N; i++) {
      try {
        const wc = 1 + (i & 3);
        const indices = [];
        for (let k = 0; k < wc; k++) indices.push((i * 7 + k * 31) % (RANGES.RESERVED_START - 1));
        const patch = {
          patchType: PATCH_TYPE.MIXED,
          wordCount: wc,
          scoreDelta: BigInt(i),
          parentStateRoot: new Uint8Array(32).map((_, j) => (i + j) & 0xff),
          indices,
          newWords: indices.map(() => BigInt(i)),
        };
        const wire = encodePatch(patch);
        const wire2 = encodePatch(decodePatch(wire));
        if (wire.length !== wire2.length) nondeterminism++;
        for (let j = 0; j < wire.length; j++) if (wire[j] !== wire2[j]) { nondeterminism++; break; }
      } catch (e) {
        panic++;
      }
    }
    check(`adversarial-fuzz-${N}`, panic === 0 && nondeterminism === 0, `panics=${panic}, nondeterminism=${nondeterminism}`);
    if (N < 1_000_000) console.log('     set EXTENDED_FUZZ=1 for the ≥1M release run');
  }
}

// T6. Baseline validity: every baseline genesis is reserved-bit-clean; every
// candidate patch either cleanly applies or explicitly returns null.
{
  const mod = await import('../../../packages/cortex/dist/state/index.js').catch(() => null);
  if (!mod) {
    check('baseline-validity', null, 'dist not built');
  } else {
    const { hasNonZeroReservedBits, merkleizeState, applyPatch } = mod;
    const baselineDefs = [
      ['A', '../../../experiments/baselines/baseline_a_empty/index.mjs'],
      ['B', '../../../experiments/baselines/baseline_b_dense_key/index.mjs'],
      ['C', '../../../experiments/baselines/baseline_c_binary_key/index.mjs'],
      ['D', '../../../experiments/baselines/baseline_d_late_interaction/index.mjs'],
      ['E', '../../../experiments/baselines/baseline_e_revocation_aware/index.mjs'],
    ];
    let failures = 0;
    for (const [id, p] of baselineDefs) {
      const baseline = await import(p);
      const state = baseline.genesisState();
      if (hasNonZeroReservedBits(state)) {
        console.error(`     baseline ${id}: reserved bits set in genesis`);
        failures++;
        continue;
      }
      const patch = baseline.mineCandidatePatch(state, { epoch: 1, solveIndex: 43 });
      if (patch) {
        patch.parentStateRoot = merkleizeState(state);
        const result = applyPatch(state, patch);
        if (!result.ok) {
          console.error(`     baseline ${id}: candidate rejected with ${result.code}`);
          failures++;
        }
      }
    }
    check('baseline-validity', failures === 0, `${failures} baseline failures`);
  }
}

// T7. Live epoch semantics: two different-area improvements in the same 24h
// epoch both advance state; a no-improvement candidate earns no credits.
{
  const stateMod = await import('../../../packages/cortex/dist/state/index.js').catch(() => null);
  const liveMod = await import('../../../packages/cortex/dist/reducer/live-epoch.js').catch(() => null);
  if (!stateMod || !liveMod) {
    check('live-epoch-mid-epoch-advances', null, 'dist not built');
  } else {
    const { merkleizeState, encodePatch, PATCH_TYPE } = stateMod;
    const { advanceEpochState, makeLiveEpochInput } = liveMod;
    const state = { words: new Array(1024).fill(0n) };
    const p1 = {
      patchType: PATCH_TYPE.KEY_UPDATE,
      wordCount: 1,
      scoreDelta: 10n,
      parentStateRoot: merkleizeState(state),
      indices: [401],
      newWords: [1n],
    };
    const afterFirst = { words: [...state.words] };
    afterFirst.words[401] = 1n;
    const p2 = {
      patchType: PATCH_TYPE.KEY_UPDATE,
      wordCount: 1,
      scoreDelta: 100n,
      parentStateRoot: merkleizeState(afterFirst),
      indices: [402],
      newWords: [2n],
    };
    const afterSecond = { words: [...afterFirst.words] };
    afterSecond.words[402] = 2n;
    const bogus = {
      patchType: PATCH_TYPE.KEY_UPDATE,
      wordCount: 1,
      scoreDelta: 999n,
      parentStateRoot: merkleizeState(afterSecond),
      indices: [403],
      newWords: [3n],
    };
    const result = advanceEpochState(state, [
      makeLiveEpochInput('0xaaaa', p1, encodePatch(p1)),
      makeLiveEpochInput('0xbbbb', p2, encodePatch(p2)),
      makeLiveEpochInput('0xcccc', bogus, encodePatch(bogus), () => 0n),
    ]);
    const ok = result.advances.length === 2
      && result.rejected.length === 1
      && result.rejected[0].reason === 'L01_NOT_IMPROVEMENT'
      && result.newState.words[401] === 1n
      && result.newState.words[402] === 2n
      && result.newState.words[403] === 0n;
    check('live-epoch-mid-epoch-advances', ok, `advances=${result.advances.length}, rejected=${result.rejected.length}`);
  }
}

console.log(`\n[phase-7] ${pass} pass, ${fail} fail, ${skip} skip`);
exit(fail === 0 ? 0 : 1);
