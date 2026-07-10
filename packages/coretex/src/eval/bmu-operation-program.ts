import type { CortexState, Patch } from '../state/index.js';
import { merkleizeState, PATCH_TYPE, RANGES } from '../state/index.js';
import { encodeBmuPublicPathProgramWords } from '../substrate/retrieval-decoder.js';
import { bmuOperationQueryKey } from './retrieval-benchmark.js';
import {
  BMU_V2_OPERATION_BRANCH_LIMIT,
  type BmuOperationProgram,
} from './bmu-task.js';

export const BMU_V2_RESIDENT_PROGRAM_CAPACITY = 32;

/**
 * Public miner helper: one cue + public directed program becomes one exact
 * aligned four-word POLICY_UPDATE.  It reads no qrel, answer, family, motif,
 * template, entity, or document id.
 */
export function buildBmuPublicPathProgramPatch(args: {
  readonly parent: CortexState;
  readonly operationCue: string;
  readonly operationProgram: BmuOperationProgram;
  readonly programSlot: number;
  readonly scoreDelta?: bigint;
}): Patch {
  const { parent, operationCue, operationProgram, programSlot } = args;
  if (!Number.isInteger(programSlot) || programSlot < 0 || programSlot >= BMU_V2_RESIDENT_PROGRAM_CAPACITY) {
    throw new Error(`programSlot must be an integer in [0, ${BMU_V2_RESIDENT_PROGRAM_CAPACITY - 1}]`);
  }
  if (operationProgram.branchLimit !== BMU_V2_OPERATION_BRANCH_LIMIT) {
    throw new Error(`operationProgram.branchLimit must equal ${BMU_V2_OPERATION_BRANCH_LIMIT}`);
  }
  const newWords = encodeBmuPublicPathProgramWords({
    programIndex: programSlot,
    queryKey: bmuOperationQueryKey(operationCue),
    branchLimit: operationProgram.branchLimit,
    validFromEpoch: 0n,
    expiryEpoch: 0n,
    steps: operationProgram.steps,
  });
  const start = RANGES.POLICY_EVIDENCE_START + programSlot * 4;
  return {
    patchType: PATCH_TYPE.POLICY_UPDATE,
    wordCount: 4,
    scoreDelta: args.scoreDelta ?? 0n,
    parentStateRoot: merkleizeState(parent),
    indices: [start, start + 1, start + 2, start + 3],
    newWords,
  };
}
