export const BMU_EXECUTABLE_PROGRAM_WORDS = 4;
export const BMU_EXECUTABLE_PROGRAM_CAPACITY = 32;
export const BMU_EXECUTABLE_OPERATION_CLASS_BASIS = 'shared-policy-evidence-384-511-4w-program-v1';

const DIRECTIONS = new Set(['outgoing', 'incoming']);
const EDGE_TYPES = new Set([
  'supports', 'supersedes', 'coreference_of',
  'causes', 'derived_from', 'co_occurs_with',
]);

export function executableOperationSignature({ operationCue, operationClass, steps }) {
  const canonicalCue = String(operationCue).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^[a-z0-9][a-z0-9 _-]*$/.test(String(operationCue)) || canonicalCue !== operationCue
      || operationCue.length < 4 || operationCue.length > 160) {
    throw new Error('operationCue must be canonical lowercase ASCII of length 4..160');
  }
  if (typeof operationClass !== 'string' || operationClass.length < 4 || operationClass.length > 256) {
    throw new Error('operationClass must be a string of length 4..256');
  }
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 4) throw new Error('steps must contain 1..4 operations');
  if (steps.some((step) => !step || !DIRECTIONS.has(step.direction) || !EDGE_TYPES.has(step.edgeType))) {
    throw new Error('steps contain an unknown direction or public edge type');
  }
  return Object.freeze({
    operationCue,
    operationClass,
    operationClassBasis: BMU_EXECUTABLE_OPERATION_CLASS_BASIS,
    steps: Object.freeze(steps.map((step) => Object.freeze({ ...step }))),
    executableSignature: `${operationCue}=>${steps.map((step) => `${step.direction}:${step.edgeType}`).join('/')}`,
  });
}
