export const BMU_EXECUTABLE_PROGRAM_WORDS = 4;
export const BMU_EXECUTABLE_PROGRAM_CAPACITY = 32;
export const BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT = 4;
export const BMU_EXECUTABLE_OPERATION_CLASS_BASIS = 'shared-policy-evidence-384-511-4w-program-v1';
export const BMU_EXECUTABLE_OPERATION_ERA = 1;

export const BMU_EXECUTABLE_EDGE_TYPES = Object.freeze([
  'supports', 'supersedes', 'coreference_of',
  'causes', 'derived_from', 'co_occurs_with',
]);

const DIRECTIONS = new Set(['outgoing', 'incoming']);
const EDGE_TYPES = new Set(BMU_EXECUTABLE_EDGE_TYPES);
const FAMILY_CUE = Object.freeze({
  temporal: 'temporal',
  conflict_lifecycle: 'conflict lifecycle',
  multi_hop_relation: 'multi hop relation',
  near_collision_abstention: 'near collision abstention',
});

/**
 * The executable class bank is exactly the 6x6 directed two-step bytecode
 * matrix.  Semantic prose, sink multiplicity, and generator labels are not
 * class dimensions: two classes differ only when their encoded operation
 * really differs.
 */
export const BMU_EXECUTABLE_PROGRAM_BANK = Object.freeze(
  BMU_EXECUTABLE_EDGE_TYPES.flatMap((outgoingEdgeType) =>
    BMU_EXECUTABLE_EDGE_TYPES.map((incomingEdgeType, inner) => Object.freeze({
      ordinal: BMU_EXECUTABLE_EDGE_TYPES.indexOf(outgoingEdgeType) * BMU_EXECUTABLE_EDGE_TYPES.length + inner,
      outgoingEdgeType,
      incomingEdgeType,
      branchLimit: BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT,
      steps: Object.freeze([
        Object.freeze({ direction: 'outgoing', edgeType: outgoingEdgeType }),
        Object.freeze({ direction: 'incoming', edgeType: incomingEdgeType }),
      ]),
    }))),
);

export function canonicalBmuOperationProgram(program) {
  if (!program || program.branchLimit !== BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT) {
    throw new Error(`bmuOperationProgram.branchLimit must equal ${BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT}`);
  }
  if (!Array.isArray(program.steps) || program.steps.length < 1 || program.steps.length > 4) {
    throw new Error('bmuOperationProgram.steps must contain 1..4 operations');
  }
  if (program.steps.some((step) => !step || !DIRECTIONS.has(step.direction) || !EDGE_TYPES.has(step.edgeType))) {
    throw new Error('bmuOperationProgram.steps contain an unknown direction or public edge type');
  }
  return Object.freeze({
    branchLimit: BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT,
    steps: Object.freeze(program.steps.map((step) => Object.freeze({
      direction: step.direction,
      edgeType: step.edgeType,
    }))),
  });
}

export function executableOperationSignature({ operationCue, operationProgram, steps, branchLimit = BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT }) {
  const canonicalCue = String(operationCue).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^[a-z0-9][a-z0-9 _-]*$/.test(String(operationCue)) || canonicalCue !== operationCue
      || operationCue.length < 4 || operationCue.length > 160) {
    throw new Error('operationCue must be canonical lowercase ASCII of length 4..160');
  }
  const program = canonicalBmuOperationProgram(operationProgram ?? { branchLimit, steps });
  const executableSignature = `${operationCue}=>b${program.branchLimit}/${program.steps
    .map((step) => `${step.direction}:${step.edgeType}`).join('/')}`;
  if (executableSignature.length > 256) throw new Error('executable operation signature exceeds 256 characters');
  return Object.freeze({
    operationCue,
    operationProgram: program,
    operationLaw: 'public_path_program_v1',
    operationClass: executableSignature,
    operationClassBasis: BMU_EXECUTABLE_OPERATION_CLASS_BASIS,
    executableSignature,
  });
}

/** Two adjacent minted clusters share one exact executable class (I6). */
export function executableOperationForFamilySlot(family, operationSequence, { era = BMU_EXECUTABLE_OPERATION_ERA } = {}) {
  const familyCue = FAMILY_CUE[family];
  if (!familyCue) throw new Error(`unsupported BMU executable-operation family '${String(family)}'`);
  if (!Number.isInteger(operationSequence) || operationSequence < 0) {
    throw new Error('operationSequence must be a non-negative integer');
  }
  if (!Number.isInteger(era) || era < 1) throw new Error('operation era must be a positive integer');
  const classOrdinal = Math.floor(operationSequence / 2) % BMU_EXECUTABLE_PROGRAM_BANK.length;
  const plan = BMU_EXECUTABLE_PROGRAM_BANK[classOrdinal];
  const operationCue = `${familyCue} era ${era} route ${plan.outgoingEdgeType} then ${plan.incomingEdgeType}`;
  return Object.freeze({
    ...plan,
    classOrdinal,
    era,
    ...executableOperationSignature({
      operationCue,
      operationProgram: { branchLimit: plan.branchLimit, steps: plan.steps },
    }),
  });
}

export function stampExecutableOperationTask(task, operation) {
  return Object.freeze({
    ...task,
    operationLaw: operation.operationLaw,
    operationClass: operation.operationClass,
    operationClassBasis: operation.operationClassBasis,
  });
}
