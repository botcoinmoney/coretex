/**
 * §17.39 item-2 — CANONICAL public-path program EXECUTION primitives, relocated
 * into the vendored `@botcoin/coretex` package so the COORDINATOR verifier can
 * INDEPENDENTLY re-execute a decoded program over a cluster's relations and DERIVE
 * whether an evicted resident still solves a live cluster — replacing the trusted
 * producer `stillCoversActiveMotif` boolean with a verifier-recomputed one
 * (operator ruling §17.39 point-2 / §17.27 amendment).
 *
 * These are the deterministic CPU reference walker + deep-terminal topology builder
 * that already exist in the law-repo generator
 * (`scripts/lib/bmu-generators/operation-program.mjs`). They are ported here
 * SELF-CONTAINED (no era-registry dependency: the era-partition is not needed to
 * WALK a program, only to MINT one) and PINNED byte-identical to the .mjs originals
 * by the law-repo parity test `bmu-program-execution-parity.test.mjs`. Fix them in
 * the .mjs first, keep the parity test green, and re-port — never let the two drift.
 *
 * STOP-LINE: pure functions; arm nothing; mutate no production state.
 */

/** The six public edge types the decoder knows (byte law unchanged across eras). */
export const BMU_PUBLIC_EDGE_TYPES = Object.freeze([
  'supports', 'supersedes', 'coreference_of', 'causes', 'derived_from', 'co_occurs_with',
]) as readonly string[];
const EDGE_TYPES = new Set(BMU_PUBLIC_EDGE_TYPES);
const DIRECTIONS = new Set(['outgoing', 'incoming']);
const MAX_BRANCH_LIMIT = 4;

export interface BmuExecStep {
  readonly direction: 'outgoing' | 'incoming';
  readonly edgeType: string;
  readonly suppress?: boolean;
  readonly offPathSuppress?: boolean;
}
export interface BmuExecProgram {
  readonly branchLimit: number;
  readonly steps: readonly BmuExecStep[];
}
export interface BmuExecRelation {
  readonly src: string;
  readonly dst?: string;
  readonly other_id?: string;
  readonly type?: string;
  readonly edgeType?: string;
  readonly label?: string;
}
export interface BmuExecResult {
  readonly terminalIds: string[];
  readonly routes: Map<string, readonly string[]>;
  readonly promoteTerminalIds: readonly string[];
  readonly promotePathNodeIds: readonly string[];
  readonly suppressTerminalIds: readonly string[];
  readonly suppressLineageIds: readonly string[];
  readonly offPathSuppressedIds: readonly string[];
  readonly programHasSuppress: boolean;
  readonly programHasOffPathSuppress: boolean;
  readonly terminalsSuppressed: boolean;
}

/**
 * Minimal canonicalization for EXECUTION (self-contained twin of the .mjs
 * `canonicalBmuOperationProgram`, minus the era-partition assertions the walker
 * does not need). Validates 1..4 steps over the 6 public edges + a branchLimit in
 * [1,4], and normalizes the suppress/offPathSuppress flags. Unlike the .mjs it
 * PRESERVES the supplied branchLimit (a real decoded program may legally carry
 * branchLimit 1..4) rather than forcing 4; over the branchLimit-4 era catalog the
 * two agree exactly (pinned by the parity test).
 */
function canonicalExecProgram(program: BmuExecProgram): { branchLimit: number; steps: BmuExecStep[] } {
  if (!program || !Number.isInteger(program.branchLimit) || program.branchLimit < 1 || program.branchLimit > MAX_BRANCH_LIMIT) {
    throw new Error(`bmu exec program branchLimit must be an integer in [1, ${MAX_BRANCH_LIMIT}]`);
  }
  if (!Array.isArray(program.steps) || program.steps.length < 1 || program.steps.length > 4) {
    throw new Error('bmu exec program steps must contain 1..4 operations');
  }
  if (program.steps.some((step) => !step || !DIRECTIONS.has(step.direction) || !EDGE_TYPES.has(step.edgeType))) {
    throw new Error('bmu exec program steps contain an unknown direction or public edge type');
  }
  return {
    branchLimit: program.branchLimit,
    steps: program.steps.map((step) => ({
      direction: step.direction,
      edgeType: step.edgeType,
      ...(step.suppress === true ? { suppress: true } : {}),
      ...(step.offPathSuppress === true ? { offPathSuppress: true } : {}),
    })),
  };
}

/**
 * Deterministic CPU reference walker — mirrors the compiled decoder's public-path
 * execution byte law exactly (sorted frontiers, simple-path visited exclusion,
 * per-step branch cap, fail-closed ambiguous-lineage collisions, terminal-only
 * admission). Byte-identical to the law-repo `.mjs` `executeProgramOverRelations`.
 */
export function executeProgramOverRelations(args: {
  program: BmuExecProgram;
  relations: readonly BmuExecRelation[];
  seedIds: readonly string[];
  branchLimit?: number;
}): BmuExecResult {
  const { program, relations, seedIds, branchLimit } = args;
  const canonical = canonicalExecProgram(program);
  const cap = Math.min(branchLimit ?? canonical.branchLimit, canonical.branchLimit);
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const outgoingBySrc = new Map<string, { other: string; type: string }[]>();
  const incomingByDst = new Map<string, { other: string; type: string }[]>();
  for (const relation of relations) {
    const src = relation.src;
    const dst = (relation.dst ?? relation.other_id) as string;
    const type = (relation.type ?? relation.edgeType) as string;
    (outgoingBySrc.get(src) ?? outgoingBySrc.set(src, []).get(src)!).push({ other: dst, type });
    (incomingByDst.get(dst) ?? incomingByDst.set(dst, []).get(dst)!).push({ other: src, type });
  }
  let frontier = new Map<string, string[]>([...new Set(seedIds)].sort(compare).map((id) => [id, [id]]));
  const suppressStepProducedIds = new Set<string>();
  const offPathStepProducedIds = new Set<string>();
  for (let stepIdx = 0; stepIdx < canonical.steps.length; stepIdx++) {
    const step = canonical.steps[stepIdx]!;
    const isFinalStep = stepIdx === canonical.steps.length - 1;
    const next = new Map<string, string[]>();
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
    if (step.offPathSuppress === true && !isFinalStep) {
      for (const producedId of next.keys()) offPathStepProducedIds.add(producedId);
    }
    frontier = new Map([...next].sort(([a], [b]) => compare(a, b)));
    if (frontier.size === 0) break;
  }
  const programHasSuppress = canonical.steps.some((s) => s.suppress === true);
  const programHasOffPathSuppress = canonical.steps.some((s) => s.offPathSuppress === true);
  const terminalsSuppressed = canonical.steps[canonical.steps.length - 1]?.suppress === true;
  const suppressLineageIds = new Set(suppressStepProducedIds);
  if (programHasSuppress) {
    for (const route of frontier.values()) {
      for (let i = 0; i < route.length - 1; i++) suppressLineageIds.add(route[i]!);
    }
  }
  const onRouteIds = new Set<string>();
  for (const route of frontier.values()) for (const id of route) onRouteIds.add(id);
  const offPathSuppressedIds = new Set<string>();
  for (const id of offPathStepProducedIds) if (!onRouteIds.has(id)) offPathSuppressedIds.add(id);
  const terminalIds = [...frontier.keys()];
  const terminalIdSet = new Set(terminalIds);
  const promotePathNodeIds = new Set<string>();
  for (const route of frontier.values()) {
    for (let i = 1; i < route.length - 1; i++) {
      const id = route[i]!;
      if (terminalIdSet.has(id)) continue;
      if (suppressLineageIds.has(id)) continue;
      if (offPathSuppressedIds.has(id)) continue;
      promotePathNodeIds.add(id);
    }
  }
  return Object.freeze({
    terminalIds,
    routes: new Map([...frontier].map(([id, route]) => [id, Object.freeze([...route])] as const)),
    promoteTerminalIds: Object.freeze(terminalsSuppressed ? [] : [...terminalIds]),
    promotePathNodeIds: Object.freeze([...promotePathNodeIds]),
    suppressTerminalIds: Object.freeze(terminalsSuppressed ? [...terminalIds] : []),
    suppressLineageIds: Object.freeze([...suppressLineageIds]),
    offPathSuppressedIds: Object.freeze([...offPathSuppressedIds]),
    programHasSuppress,
    programHasOffPathSuppress,
    terminalsSuppressed,
  });
}

/**
 * Deep-terminal topology builder — byte-identical to the law-repo `.mjs`
 * `buildProgramPathTopology`. Given a public-path program, emits the canonical
 * public relations whose EXECUTED terminal set (via `executeProgramOverRelations`
 * from `seedId`) equals exactly `goldIds`. The verifier uses this to RECONSTRUCT a
 * live cluster's canonical topology from its byte-bound program (never trusting a
 * producer-disclosed relation set), then re-executes an evicted program over it.
 *
 * Self-contained twin: validates the step SHAPE (2..4 steps, step 0 outgoing, the
 * rest incoming — enough to build the diamond) instead of the .mjs era-partition
 * assertion the mint path uses; over the era catalog the two agree (parity-pinned).
 */
export function buildProgramPathTopology(args: {
  program: BmuExecProgram;
  seedId: string;
  sinkIds: readonly string[];
  goldIds: readonly string[];
  decoyIds?: readonly string[];
  midIdFor: (level: number) => string;
  decoyDepth?: number;
}): {
  relations: readonly BmuExecRelation[];
  midIds: string[];
  terminalDepth: number;
  terminalIds: string[];
  decoyDepth: number;
} {
  const { program, seedId, sinkIds, goldIds, decoyIds, midIdFor, decoyDepth = 1 } = args;
  const steps = program.steps;
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 4) {
    throw new Error('buildProgramPathTopology: program must have 2..4 steps');
  }
  if (steps[0]!.direction !== 'outgoing') throw new Error('buildProgramPathTopology: step 0 must be outgoing');
  for (let i = 1; i < steps.length; i++) {
    if (steps[i]!.direction !== 'incoming') throw new Error(`buildProgramPathTopology: step ${i} must be incoming`);
  }
  const depth = steps.length - 1;
  if (depth < 2) {
    throw new Error('buildProgramPathTopology: deep-terminal law requires >=3 steps (decoys must sit strictly above terminal depth)');
  }
  if (!Number.isInteger(decoyDepth) || decoyDepth < 1 || decoyDepth >= depth) {
    throw new Error(`buildProgramPathTopology: decoyDepth ${decoyDepth} must be a non-final branch level in 1..${depth - 1}`);
  }
  const branchLimit = program.branchLimit ?? MAX_BRANCH_LIMIT;
  if (!Array.isArray(sinkIds) || sinkIds.length < 1) throw new Error('buildProgramPathTopology: at least one sink id required');
  if (!Array.isArray(goldIds) || goldIds.length < 1) throw new Error('buildProgramPathTopology: at least one gold terminal id required');
  if (goldIds.length > branchLimit) {
    throw new Error(`buildProgramPathTopology: ${goldIds.length} gold terminals exceed branchLimit ${branchLimit}`);
  }
  const decoys = decoyIds ?? [];
  if (1 + decoys.length > branchLimit) {
    throw new Error(`buildProgramPathTopology: chain head + ${decoys.length} decoys exceed branchLimit ${branchLimit} at depth ${decoyDepth}`);
  }
  const midIds: string[] = [];
  for (let level = 1; level < depth; level++) midIds.push(midIdFor(level));
  const relations: BmuExecRelation[] = [];
  for (const sinkId of sinkIds) {
    relations.push({ src: seedId, dst: sinkId, type: steps[0]!.edgeType, label: 'public_path_seed' });
  }
  const primarySinkId = sinkIds[0]!;
  if (decoyDepth === 1) {
    const depthOneBranchIds = [midIds[0]!, ...decoys];
    for (const src of depthOneBranchIds) {
      relations.push({ src, dst: primarySinkId, type: steps[1]!.edgeType, label: 'public_path_branch' });
    }
    for (let level = 2; level < depth; level++) {
      relations.push({ src: midIds[level - 1]!, dst: midIds[level - 2]!, type: steps[level]!.edgeType, label: 'public_path_chain' });
    }
  } else {
    const parentAtLevel = (level: number): string => (level === 1 ? primarySinkId : midIds[level - 2]!);
    for (let level = 1; level < depth; level++) {
      relations.push({ src: midIds[level - 1]!, dst: parentAtLevel(level), type: steps[level]!.edgeType, label: level === 1 ? 'public_path_branch' : 'public_path_chain' });
    }
    for (const decoy of decoys) {
      relations.push({ src: decoy, dst: parentAtLevel(decoyDepth), type: steps[decoyDepth]!.edgeType, label: 'public_path_branch' });
    }
  }
  for (const goldId of goldIds) {
    relations.push({ src: goldId, dst: midIds[depth - 2]!, type: steps[depth]!.edgeType, label: 'public_path_terminal' });
  }
  return Object.freeze({ relations, midIds, terminalDepth: depth, terminalIds: [...goldIds], decoyDepth });
}
