/**
 * §17.39 item-2 ANTI-DRIFT PIN. The vendored `@botcoin/coretex` execution
 * primitives (`executeProgramOverRelations`, `buildProgramPathTopology` in
 * `src/eval/bmu-program-execution.ts`) are a SELF-CONTAINED port of the law-repo
 * generator originals (`scripts/lib/bmu-generators/operation-program.mjs`). The
 * coordinator verifier now re-executes decoded programs through the VENDORED copy
 * to recompute `stillCoversActiveMotif` — so the two copies MUST stay byte-for-byte
 * behaviourally identical. This test proves that across the full era-1/2/3 catalog
 * (topology relations + execution promote/suppress/terminal output), plus the
 * cross-cluster no-solve path. If it goes red, the two implementations have drifted
 * — reconcile before shipping (fix the .mjs first, re-port, re-green).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProgramPathTopology as mjsBuildTopology,
  executeProgramOverRelations as mjsExec,
  executableOperationForFamilySlot,
  eraSpec,
} from '../../../../scripts/lib/bmu-generators/operation-program.mjs';
import {
  buildProgramPathTopology as distBuildTopology,
  executeProgramOverRelations as distExec,
} from '../../dist/index.js';

const FAMILIES = ['temporal', 'conflict_lifecycle', 'multi_hop_relation', 'near_collision_abstention'];
const ERAS = [1, 2, 3];

/** Serializable projection of an execution result (Map routes excluded). */
function projectExec(x) {
  return {
    terminalIds: [...x.terminalIds].sort(),
    promoteTerminalIds: [...x.promoteTerminalIds].sort(),
    promotePathNodeIds: [...x.promotePathNodeIds].sort(),
    suppressTerminalIds: [...x.suppressTerminalIds].sort(),
    suppressLineageIds: [...x.suppressLineageIds].sort(),
    offPathSuppressedIds: [...x.offPathSuppressedIds].sort(),
    programHasSuppress: x.programHasSuppress,
    programHasOffPathSuppress: x.programHasOffPathSuppress,
    terminalsSuppressed: x.terminalsSuppressed,
  };
}

function clusterFor(era, family, ordinal) {
  const op = executableOperationForFamilySlot(family, ordinal * 2, { era });
  const program = { branchLimit: op.operationProgram.branchLimit, steps: op.operationProgram.steps };
  const spec = eraSpec(era);
  const decoyDepth = spec.familyOperationPlan?.[family]?.step ?? 1;
  const mg = `mg_e${era}_${family}_${ordinal}`;
  const topoArgs = {
    program, seedId: `${mg}_seed`, sinkIds: [`${mg}_sink`], goldIds: [`${mg}_gold`],
    decoyIds: [`${mg}_trap`], midIdFor: (level) => `${mg}_mid${level}`, decoyDepth,
  };
  return { program, topoArgs, seedId: `${mg}_seed` };
}

test('§17.39 item-2 parity: vendored buildProgramPathTopology == law-repo .mjs across era-1/2/3 catalog', () => {
  let checked = 0;
  for (const era of ERAS) {
    for (const family of FAMILIES) {
      for (let ordinal = 0; ordinal < 36; ordinal++) {
        const { topoArgs } = clusterFor(era, family, ordinal);
        const a = mjsBuildTopology(topoArgs);
        const b = distBuildTopology(topoArgs);
        assert.deepEqual(b.relations, a.relations, `relations e${era}/${family}/${ordinal}`);
        assert.deepEqual(b.midIds, a.midIds);
        assert.deepEqual(b.terminalIds, a.terminalIds);
        assert.equal(b.terminalDepth, a.terminalDepth);
        assert.equal(b.decoyDepth, a.decoyDepth);
        checked += 1;
      }
    }
  }
  assert.equal(checked, ERAS.length * FAMILIES.length * 36);
});

test('§17.39 item-2 parity: vendored executeProgramOverRelations == law-repo .mjs (own-cluster solve path)', () => {
  for (const era of ERAS) {
    for (const family of FAMILIES) {
      for (let ordinal = 0; ordinal < 36; ordinal++) {
        const { program, topoArgs, seedId } = clusterFor(era, family, ordinal);
        const topo = mjsBuildTopology(topoArgs);
        const execArgs = { program, relations: topo.relations, seedIds: [seedId], branchLimit: program.branchLimit };
        assert.deepEqual(projectExec(distExec(execArgs)), projectExec(mjsExec(execArgs)),
          `exec e${era}/${family}/${ordinal}`);
      }
    }
  }
});

test('§17.39 item-2 parity: vendored executeProgramOverRelations == law-repo .mjs (cross-cluster NO-solve path)', () => {
  // Run each era-1 program over EVERY era-2 cluster (the honest transfer path the
  // verifier relies on: a wrong-class/era program routes empty or wrong terminals).
  const e1 = FAMILIES.map((f) => clusterFor(1, f, 0));
  const e2 = FAMILIES.flatMap((f) => [0, 1, 17].map((o) => clusterFor(2, f, o)));
  for (const src of e1) {
    for (const dstC of e2) {
      const topo = mjsBuildTopology(dstC.topoArgs);
      const execArgs = { program: src.program, relations: topo.relations, seedIds: [dstC.seedId], branchLimit: src.program.branchLimit };
      // BOTH implementations agree (either both throw the same collision, or both
      // return the same projection).
      let mjsOut; let mjsThrew = false;
      let distOut; let distThrew = false;
      try { mjsOut = projectExec(mjsExec(execArgs)); } catch (e) { mjsThrew = true; mjsOut = String(e.message); }
      try { distOut = projectExec(distExec(execArgs)); } catch (e) { distThrew = true; distOut = String(e.message); }
      assert.equal(distThrew, mjsThrew, 'throw-parity');
      assert.deepEqual(distOut, mjsOut, 'cross-cluster exec parity');
    }
  }
});
