export const BMU_EXECUTABLE_PROGRAM_WORDS = 4;
export const BMU_EXECUTABLE_PROGRAM_CAPACITY = 32;
export const BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT = 4;
export const BMU_EXECUTABLE_OPERATION_CLASS_BASIS = 'shared-policy-evidence-384-511-4w-program-v1';
export const BMU_EXECUTABLE_OPERATION_ERA = 1;

export const BMU_EXECUTABLE_EDGE_TYPES = Object.freeze([
  'supports', 'supersedes', 'coreference_of',
  'causes', 'derived_from', 'co_occurs_with',
]);

/**
 * Disjoint outgoing/incoming edge partition (era-iteration fix 2a). The one
 * outgoing step draws only from the causal-lineage pair; every incoming step
 * draws only from the four evidence edges. Because the two vocabularies never
 * intersect, a symmetric-route (outgoing:X then incoming:X) program — the
 * ambiguous-lineage construction the decoder refuses fail-closed — cannot be
 * expressed by any bank entry, and the mint lint below refuses it for any
 * ad-hoc program too.
 */
export const BMU_EXECUTABLE_OUTGOING_EDGE_TYPES = Object.freeze(['causes', 'derived_from']);
export const BMU_EXECUTABLE_INCOMING_EDGE_TYPES = Object.freeze([
  'supports', 'supersedes', 'coreference_of', 'co_occurs_with',
]);

const DIRECTIONS = new Set(['outgoing', 'incoming']);
const EDGE_TYPES = new Set(BMU_EXECUTABLE_EDGE_TYPES);
const OUTGOING_EDGE_TYPES = new Set(BMU_EXECUTABLE_OUTGOING_EDGE_TYPES);
const INCOMING_EDGE_TYPES = new Set(BMU_EXECUTABLE_INCOMING_EDGE_TYPES);
const FAMILY_CUE = Object.freeze({
  temporal: 'temporal',
  conflict_lifecycle: 'conflict lifecycle',
  multi_hop_relation: 'multi hop relation',
  near_collision_abstention: 'near collision abstention',
});

/**
 * Mint-time lint (fix 2a): every minted program must be a disjoint-partition
 * deep-terminal program — exactly one leading outgoing step over the causal
 * pair, then 1..3 incoming steps over the evidence quad. This is precisely
 * the shape whose executed terminal set the generators make equal to the
 * row's operation-required answer terminal(s): decoys and forbidden docs are
 * parked at intermediate depth, which the decoder deliberately never admits.
 * Throws (mint fails closed) on any other shape, including the legacy
 * symmetric-route diagonal.
 */
export function assertDisjointPartitionProgram(program) {
  const steps = program?.steps;
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 4) {
    throw new Error('bmu mint lint: program must have 2..4 steps (one outgoing, then incoming chain)');
  }
  if (steps[0].direction !== 'outgoing' || !OUTGOING_EDGE_TYPES.has(steps[0].edgeType)) {
    throw new Error(`bmu mint lint: step 0 must be outgoing over {${BMU_EXECUTABLE_OUTGOING_EDGE_TYPES.join(', ')}}`);
  }
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].direction !== 'incoming' || !INCOMING_EDGE_TYPES.has(steps[i].edgeType)) {
      throw new Error(`bmu mint lint: step ${i} must be incoming over {${BMU_EXECUTABLE_INCOMING_EDGE_TYPES.join(', ')}}`);
    }
  }
  return program;
}

const FOUR_STEP_INCOMING_CHAINS = Object.freeze([
  Object.freeze(['supports', 'supersedes', 'coreference_of']),
  Object.freeze(['co_occurs_with', 'coreference_of', 'supersedes']),
]);

function bankEntry(ordinal, outgoingEdgeType, incomingChain) {
  return Object.freeze({
    ordinal,
    outgoingEdgeType,
    incomingEdgeType: incomingChain[0],
    /** Incoming-chain length; terminals sit at this depth past the sink. */
    terminalDepth: incomingChain.length,
    branchLimit: BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT,
    steps: Object.freeze([
      Object.freeze({ direction: 'outgoing', edgeType: outgoingEdgeType }),
      ...incomingChain.map((edgeType) => Object.freeze({ direction: 'incoming', edgeType })),
    ]),
  });
}

/**
 * The executable class bank: 36 disjoint-partition deep-terminal programs —
 * the 32 three-step chains (2 outgoing x 4 incoming x 4 incoming) plus 4
 * four-step chains (2 outgoing x 2 pinned incoming triples). Semantic prose,
 * sink multiplicity, and generator labels are not class dimensions: two
 * classes differ only when their encoded operation really differs. Every
 * entry passes the mint lint by construction.
 */
export const BMU_EXECUTABLE_PROGRAM_BANK = Object.freeze([
  ...BMU_EXECUTABLE_OUTGOING_EDGE_TYPES.flatMap((outgoingEdgeType, outerIndex) =>
    BMU_EXECUTABLE_INCOMING_EDGE_TYPES.flatMap((firstIncoming, firstIndex) =>
      BMU_EXECUTABLE_INCOMING_EDGE_TYPES.map((secondIncoming, secondIndex) => bankEntry(
        outerIndex * 16 + firstIndex * 4 + secondIndex,
        outgoingEdgeType,
        [firstIncoming, secondIncoming],
      )))),
  ...BMU_EXECUTABLE_OUTGOING_EDGE_TYPES.flatMap((outgoingEdgeType, outerIndex) =>
    FOUR_STEP_INCOMING_CHAINS.map((chain, chainIndex) => bankEntry(
      32 + outerIndex * FOUR_STEP_INCOMING_CHAINS.length + chainIndex,
      outgoingEdgeType,
      chain,
    ))),
].map((entry) => (assertDisjointPartitionProgram(entry), entry)));

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
      ...(step.suppress === true ? { suppress: true } : {}),
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
    .map((step) => `${step.direction}:${step.edgeType}${step.suppress === true ? ':suppress' : ''}`).join('/')}`;
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
  assertDisjointPartitionProgram(plan);
  const operationCue = `${familyCue} era ${era} route ${plan.steps.map((step) => step.edgeType).join(' then ')}`;
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

/**
 * Shared deep-terminal topology builder (fix 2a). Given a disjoint-partition
 * program, emits the public relations whose EXECUTED terminal set equals
 * exactly `goldIds`:
 *
 *   seed --steps[0]--> each sink                      (public_path_seed)
 *   mid_1 and each decoy --steps[1]--> each sink      (public_path_branch)
 *   mid_L --steps[L]--> mid_{L-1}    for L in 2..d-1  (public_path_chain)
 *   each gold --steps[d]--> mid_{d-1}                 (public_path_terminal)
 *
 * where d = terminal depth (steps.length - 1). Decoys are depth-1 dead ends:
 * balanced against mid_1 at the branch level (4 fresh branches per sink under
 * branchLimit), but with no incoming continuation, so the decoder — which
 * admits ONLY terminal branches — can never route them to Qwen. Fails closed
 * when the depth-1 branch fan (1 chain head + decoys) or the terminal fan
 * (golds) exceeds branchLimit, which would let id-sorted branch capping evict
 * the chain head or a required terminal.
 */
export function buildProgramPathTopology({ program, seedId, sinkIds, goldIds, decoyIds, midIdFor }) {
  assertDisjointPartitionProgram(program);
  const steps = program.steps;
  const depth = steps.length - 1;
  if (depth < 2) {
    throw new Error('buildProgramPathTopology: deep-terminal law requires >=3 steps (decoys must sit strictly above terminal depth)');
  }
  const branchLimit = program.branchLimit ?? BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT;
  if (!Array.isArray(sinkIds) || sinkIds.length < 1) throw new Error('buildProgramPathTopology: at least one sink id required');
  if (!Array.isArray(goldIds) || goldIds.length < 1) throw new Error('buildProgramPathTopology: at least one gold terminal id required');
  if (goldIds.length > branchLimit) {
    throw new Error(`buildProgramPathTopology: ${goldIds.length} gold terminals exceed branchLimit ${branchLimit}`);
  }
  const decoys = decoyIds ?? [];
  if (1 + decoys.length > branchLimit) {
    throw new Error(`buildProgramPathTopology: chain head + ${decoys.length} decoys exceed branchLimit ${branchLimit} at depth 1`);
  }
  const midIds = [];
  for (let level = 1; level < depth; level++) midIds.push(midIdFor(level));
  const relations = [];
  for (const sinkId of sinkIds) {
    relations.push({ src: seedId, dst: sinkId, type: steps[0].edgeType, label: 'public_path_seed' });
  }
  // Branches attach to the PRIMARY sink only. Attaching a branch to two sinks
  // reaches it by two distinct routes in one step, which the decoder refuses
  // fail-closed as an ambiguous-lineage route collision. Mirror sinks remain
  // seed-edge topology decoration (outgoing-step dead ends).
  const primarySinkId = sinkIds[0];
  const depthOneBranchIds = [midIds[0], ...decoys];
  for (const src of depthOneBranchIds) {
    relations.push({ src, dst: primarySinkId, type: steps[1].edgeType, label: 'public_path_branch' });
  }
  for (let level = 2; level < depth; level++) {
    relations.push({ src: midIds[level - 1], dst: midIds[level - 2], type: steps[level].edgeType, label: 'public_path_chain' });
  }
  for (const goldId of goldIds) {
    relations.push({ src: goldId, dst: midIds[depth - 2], type: steps[depth].edgeType, label: 'public_path_terminal' });
  }
  return Object.freeze({ relations, midIds, terminalDepth: depth, terminalIds: [...goldIds] });
}

/**
 * Deterministic CPU reference walker — mirrors the compiled decoder's
 * public-path execution byte law exactly (sorted frontiers, simple-path
 * visited exclusion, per-step branch cap, fail-closed ambiguous-lineage
 * collisions, terminal-only admission). Used by the certification lanes and
 * the P5 sim so what is certified offline is the law the scorer runs.
 */
export function executeProgramOverRelations({ program, relations, seedIds, branchLimit }) {
  const canonical = canonicalBmuOperationProgram(program);
  const cap = Math.min(branchLimit ?? canonical.branchLimit, canonical.branchLimit);
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const outgoingBySrc = new Map();
  const incomingByDst = new Map();
  for (const relation of relations) {
    const src = relation.src;
    const dst = relation.dst ?? relation.other_id;
    (outgoingBySrc.get(src) ?? outgoingBySrc.set(src, []).get(src)).push({ other: dst, type: relation.type ?? relation.edgeType });
    (incomingByDst.get(dst) ?? incomingByDst.set(dst, []).get(dst)).push({ other: src, type: relation.type ?? relation.edgeType });
  }
  let frontier = new Map([...new Set(seedIds)].sort(compare).map((id) => [id, [id]]));
  // §18.3: nodes produced by a NON-final suppress step (off-path dead-ends the
  // terminal-route lineage cannot reach).
  const suppressStepProducedIds = new Set();
  for (let stepIdx = 0; stepIdx < canonical.steps.length; stepIdx++) {
    const step = canonical.steps[stepIdx];
    const isFinalStep = stepIdx === canonical.steps.length - 1;
    const next = new Map();
    for (const [eventId, route] of frontier) {
      const neighbors = (step.direction === 'outgoing' ? outgoingBySrc.get(eventId) : incomingByDst.get(eventId)) ?? [];
      const visited = new Set(route);
      const fresh = neighbors
        .filter((neighbor) => neighbor.type === step.edgeType && !visited.has(neighbor.other))
        .map((neighbor) => neighbor.other)
        .sort(compare);
      for (const target of [...new Set(fresh)].slice(0, cap)) {
        const candidateRoute = [...route, target];
        const prior = next.get(target);
        if (prior && prior.join('\0') !== candidateRoute.join('\0')) {
          throw new Error(`executeProgramOverRelations: route collision at '${target}' — ambiguous lineage`);
        }
        if (!prior) next.set(target, candidateRoute);
      }
    }
    if (step.suppress === true && !isFinalStep) {
      for (const producedId of next.keys()) suppressStepProducedIds.add(producedId);
    }
    frontier = new Map([...next].sort(([a], [b]) => compare(a, b)));
    if (frontier.size === 0) break;
  }
  // §18.3: suppression fires ONLY for a program carrying the suppress opcode.
  // The final step's opcode decides terminal treatment; when the program has any
  // suppress step, every non-terminal route node (seed + intermediates) is
  // suppressed lineage, PLUS every node produced by a non-final suppress step
  // (off-path dead-ends). A pure promote program demotes nothing (byte-identical).
  const programHasSuppress = canonical.steps.some((s) => s.suppress === true);
  const terminalsSuppressed = canonical.steps[canonical.steps.length - 1]?.suppress === true;
  const suppressLineageIds = new Set(suppressStepProducedIds);
  if (programHasSuppress) {
    for (const route of frontier.values()) {
      for (let i = 0; i < route.length - 1; i++) suppressLineageIds.add(route[i]);
    }
  }
  const terminalIds = [...frontier.keys()];
  return Object.freeze({
    terminalIds,
    routes: new Map([...frontier].map(([id, route]) => [id, Object.freeze([...route])])),
    /** Terminals promoted (+1·UNIT). Empty when the final step is suppress-marked. */
    promoteTerminalIds: Object.freeze(terminalsSuppressed ? [] : [...terminalIds]),
    /** Terminals demoted (−1·UNIT) because the final step is suppress-marked. */
    suppressTerminalIds: Object.freeze(terminalsSuppressed ? [...terminalIds] : []),
    /** Seed/intermediate lineage demoted (−1·UNIT) — never an answer terminal. */
    suppressLineageIds: Object.freeze([...suppressLineageIds]),
    programHasSuppress,
    terminalsSuppressed,
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
