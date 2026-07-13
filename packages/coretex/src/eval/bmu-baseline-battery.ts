/**
 * §17.44 point-4/5 — PERMANENT PUBLIC-BASELINE BATTERY (vendored into
 * `@botcoin/coretex` so the COORDINATOR verifier can INDEPENDENTLY decide whether a
 * program claimed as a genuine first-discovery is instead reachable by a purely
 * mechanical, public-information-only baseline — a spec-reading remap of a
 * prior-era program, or an arity-agnostic topology probe of the target's public
 * relations).
 *
 * WHY THIS EXISTS (operator ruling §17.44). The transferring-compiler audit
 * (§17.43) proved the disjoint-vocabulary era rotation imposes NO genuine per-era
 * DISCOVERY cost: era-2's whole program bank is the public registry-index remap of
 * era-1's bank (144/144 byte-exact, both directions), so a "first discovery" of an
 * era-2 program is a zero-search recompile of an already-known era-1 program. v3's
 * discovery-credit gate keyed novelty on EXACT byte-bound identity (§17.40), so the
 * mechanically-recompiled program — new bytes, new queryKey — was wrongly credited
 * as genuinely new. This module is the verifier-recomputed FUNCTIONAL-BEHAVIOR
 * novelty test the ruling demands: credit is genuine only for utility BEYOND the
 * best transferring public baseline.
 *
 * ANTI-DRIFT. This is a SELF-CONTAINED port of the law-repo harness battery
 * (`scripts/lib/bmu-sim/transferring-compiler-audit.mjs` + the era registry /
 * program bank in `scripts/lib/bmu-generators/operation-program.mjs`). It is PINNED
 * behaviourally to those originals by `bmu-baseline-battery-parity.test.mjs`. Fix
 * the .mjs first, keep the parity test green, re-port — never let the two drift.
 * The era registry here is PUBLIC data (the era spec is published alongside every
 * task by design — §17.44 finding 3); nothing private is embedded.
 *
 * STOP-LINE: pure functions; deterministic CPU; arm nothing; mutate no production
 * state; read only public specs + public (reconstructable) cluster relations.
 */
import {
  buildProgramPathTopology,
  executeProgramOverRelations,
  type BmuExecProgram,
  type BmuExecRelation,
  type BmuExecStep,
} from './bmu-program-execution.js';

/**
 * The PUBLIC era edge registry — mirrors the law generator's
 * `BMU_EXECUTABLE_ERA_REGISTRY`. Every registered era pins a 2-outgoing × 4-incoming
 * partition; distinct eras never share an outgoing vocabulary (the class-collision
 * guarantee the transfer census keys on). `bankShape` distinguishes the mixed
 * 3-/4-step banks (era-1/2) from the all-4-step depth-3 bank (era-3).
 */
export const BMU_BASELINE_ERA_REGISTRY: Readonly<Record<number, {
  readonly era: number;
  readonly outgoingEdgeTypes: readonly string[];
  readonly incomingEdgeTypes: readonly string[];
  readonly bankShape: 'mixed-3-4-step' | 'all-4-step-depth3';
  readonly fourStepIncomingChains: readonly (readonly string[])[];
}>> = Object.freeze({
  1: Object.freeze({
    era: 1,
    outgoingEdgeTypes: Object.freeze(['causes', 'derived_from']),
    incomingEdgeTypes: Object.freeze(['supports', 'supersedes', 'coreference_of', 'co_occurs_with']),
    bankShape: 'mixed-3-4-step',
    fourStepIncomingChains: Object.freeze([
      Object.freeze(['supports', 'supersedes', 'coreference_of']),
      Object.freeze(['co_occurs_with', 'coreference_of', 'supersedes']),
    ]),
  }),
  2: Object.freeze({
    era: 2,
    outgoingEdgeTypes: Object.freeze(['supports', 'supersedes']),
    incomingEdgeTypes: Object.freeze(['coreference_of', 'causes', 'derived_from', 'co_occurs_with']),
    bankShape: 'mixed-3-4-step',
    fourStepIncomingChains: Object.freeze([
      Object.freeze(['coreference_of', 'causes', 'derived_from']),
      Object.freeze(['co_occurs_with', 'derived_from', 'causes']),
    ]),
  }),
  3: Object.freeze({
    era: 3,
    outgoingEdgeTypes: Object.freeze(['coreference_of', 'co_occurs_with']),
    incomingEdgeTypes: Object.freeze(['causes', 'derived_from', 'supports', 'supersedes']),
    bankShape: 'all-4-step-depth3',
    fourStepIncomingChains: Object.freeze([]),
  }),
});

/** All registered baseline eras, ascending. */
export const BMU_BASELINE_ERAS: readonly number[] = Object.freeze(
  Object.keys(BMU_BASELINE_ERA_REGISTRY).map(Number).sort((a, b) => a - b),
);

/** Public spec for one era (throws on an unregistered era). */
export function bmuBaselineEraSpec(era: number): (typeof BMU_BASELINE_ERA_REGISTRY)[number] {
  const spec = BMU_BASELINE_ERA_REGISTRY[era];
  if (!spec) throw new Error(`bmu baseline battery: era ${era} is not registered`);
  return spec;
}

/**
 * Infer which registered era a program belongs to from its leading OUTGOING edge
 * (disjoint outgoing vocabularies ⇒ unambiguous). Returns null when the program is
 * not a well-formed single-era program (no outgoing lead, or an edge outside every
 * era's outgoing set) — a program that belongs to no registered era cannot be a
 * cross-era spec-remap of one, so the baseline check treats it as unreachable.
 */
export function bmuInferBaselineEra(program: BmuExecProgram): number | null {
  const lead = program?.steps?.[0];
  if (!lead || lead.direction !== 'outgoing') return null;
  for (const era of BMU_BASELINE_ERAS) {
    if (bmuBaselineEraSpec(era).outgoingEdgeTypes.includes(lead.edgeType)) return era;
  }
  return null;
}

function bankEntry(outgoingEdgeType: string, incomingChain: readonly string[]): BmuExecProgram {
  return Object.freeze({
    branchLimit: 4,
    steps: Object.freeze([
      Object.freeze({ direction: 'outgoing' as const, edgeType: outgoingEdgeType }),
      ...incomingChain.map((edgeType) => Object.freeze({ direction: 'incoming' as const, edgeType })),
    ]) as readonly BmuExecStep[],
  });
}

const ERA_BANK_CACHE = new Map<number, readonly BmuExecProgram[]>();

/**
 * The 36-program PUBLIC deep-terminal bank for one era (BASE programs — no family
 * suppress overlay; the suppress flag does not change which terminals a program
 * routes to, so the solve-based baseline check is overlay-robust). Ordinal layout
 * is identical across same-shape eras, so `bank(E')[slot]` remaps positionally onto
 * `bank(E)[slot]`. Mirrors the law generator's `programBankForEra`.
 */
export function bmuProgramBankForEra(era: number): readonly BmuExecProgram[] {
  const cached = ERA_BANK_CACHE.get(era);
  if (cached) return cached;
  const spec = bmuBaselineEraSpec(era);
  const out = spec.outgoingEdgeTypes;
  const inc = spec.incomingEdgeTypes;
  let bank: readonly BmuExecProgram[];
  if (spec.bankShape === 'all-4-step-depth3') {
    const triples: string[][] = [];
    for (const a of inc) for (const b of inc) for (const c of inc) triples.push([a, b, c]);
    const chosen = triples.slice(0, 18);
    bank = Object.freeze(out.flatMap((o) => chosen.map((chain) => bankEntry(o, chain))));
  } else {
    bank = Object.freeze([
      ...out.flatMap((o) => inc.flatMap((f) => inc.map((s) => bankEntry(o, [f, s])))),
      ...out.flatMap((o) => spec.fourStepIncomingChains.map((chain) => bankEntry(o, chain))),
    ]);
  }
  ERA_BANK_CACHE.set(era, bank);
  return bank;
}

export interface BmuEraEdgeRemap {
  readonly order: 'registry' | 'sorted';
  remapEdge(edge: string, direction: 'outgoing' | 'incoming'): string;
}

/**
 * Build the PUBLIC edge remap `sourceEdge → targetEdge` between two eras.
 *  - 'registry' (strategy A / specIndexRemap): map by index in the PUBLISHED
 *    registry arrays — the canonical structural analog a spec-reader uses.
 *  - 'sorted'   (strategy B / setCanonicalRemap): map by index after a lexical sort
 *    of each partition (knows only the SETS, not the published order). Strictly
 *    weaker negative control.
 * Throws on partition-arity mismatch (never happens for the registered 2×4 eras).
 */
export function makeEraEdgeRemap(fromEra: number, toEra: number, opts?: { order?: 'registry' | 'sorted' }): BmuEraEdgeRemap {
  const order = opts?.order ?? 'registry';
  const s = bmuBaselineEraSpec(fromEra);
  const t = bmuBaselineEraSpec(toEra);
  const seq = (arr: readonly string[]): string[] => (order === 'sorted' ? [...arr].sort() : [...arr]);
  const sOut = seq(s.outgoingEdgeTypes);
  const tOut = seq(t.outgoingEdgeTypes);
  const sInc = seq(s.incomingEdgeTypes);
  const tInc = seq(t.incomingEdgeTypes);
  if (sOut.length !== tOut.length || sInc.length !== tInc.length) {
    throw new Error(`makeEraEdgeRemap: partition arity differs between era ${fromEra} and ${toEra}`);
  }
  const outMap = new Map(sOut.map((e, i) => [e, tOut[i]!]));
  const incMap = new Map(sInc.map((e, i) => [e, tInc[i]!]));
  return {
    order,
    remapEdge(edge: string, direction: 'outgoing' | 'incoming'): string {
      const mapped = (direction === 'outgoing' ? outMap : incMap).get(edge);
      if (mapped === undefined) throw new Error(`makeEraEdgeRemap: no ${direction} mapping for '${edge}'`);
      return mapped;
    },
  };
}

/**
 * Mechanically remap a source-era program into the target era's vocabulary by the
 * public edge map, preserving direction, step count, and suppress/offPathSuppress
 * flags. Zero new discovery — a pure relabel of a known-good program.
 */
export function remapProgramToEra(program: BmuExecProgram, remap: BmuEraEdgeRemap): BmuExecProgram {
  return {
    branchLimit: program.branchLimit,
    steps: program.steps.map((st) => ({
      direction: st.direction,
      edgeType: remap.remapEdge(st.edgeType, st.direction),
      ...(st.suppress === true ? { suppress: true } : {}),
      ...(st.offPathSuppress === true ? { offPathSuppress: true } : {}),
    })),
  };
}

/** Step signature (flags included) for byte-exact reconstruction checks. */
export function bmuProgramStepSig(program: BmuExecProgram): string {
  return `${program.steps.map((s) => `${s.direction}:${s.edgeType}${s.suppress ? ':sup' : ''}${s.offPathSuppress ? ':off' : ''}`).join('/')}|b${program.branchLimit}`;
}

// ── canonical public target-cluster reconstruction (deterministic from a program) ──
const T_SEED = 't_seed';
const T_SINK = 't_sink';
const T_GOLD = 't_gold';
const T_DECOY = 't_decoy';
const midIdFor = (level: number): string => `t_mid${level}`;

/**
 * The canonical PUBLIC deep-terminal target cluster a program solves — a
 * deterministic function of the program bytes (`buildProgramPathTopology`), exactly
 * as the coordinator's eviction-coverage recompute already reconstructs it. Returns
 * null for a program that cannot form a deep-terminal cluster (fewer than 3 steps,
 * non-outgoing lead, etc.) — such a program is not a registered-era bank program and
 * has no spec-remap baseline.
 */
export function bmuBaselineTargetCluster(program: BmuExecProgram): { relations: readonly BmuExecRelation[]; seedId: string; goldId: string } | null {
  try {
    const topo = buildProgramPathTopology({
      program, seedId: T_SEED, sinkIds: [T_SINK], goldIds: [T_GOLD],
      decoyIds: [T_DECOY], midIdFor, decoyDepth: 1,
    });
    return { relations: topo.relations, seedId: T_SEED, goldId: T_GOLD };
  } catch {
    return null;
  }
}

/** Does `program` route EXACTLY the target cluster's single gold terminal? */
function solvesTargetCluster(program: BmuExecProgram, cluster: { relations: readonly BmuExecRelation[]; seedId: string; goldId: string }): boolean {
  try {
    const exec = executeProgramOverRelations({ program, relations: cluster.relations, seedIds: [cluster.seedId], branchLimit: program.branchLimit });
    return exec.terminalIds.length === 1 && exec.terminalIds[0] === cluster.goldId;
  } catch {
    return false;
  }
}

/**
 * Strategy C — arity-agnostic topology probe. Reconstructs a solving traversal by
 * reading ONLY the target cluster's PUBLIC relation edge types (the observable
 * served memory graph), carrying suppress flags from the source program's public
 * per-family plan. Reads nothing private. Ported from the harness
 * `topologyProbeProgram`. Returns null if the relations are not a deep-terminal
 * topology.
 */
export function topologyProbeProgram(sourceProgram: BmuExecProgram, targetRelations: readonly BmuExecRelation[]): BmuExecProgram | null {
  const byLabel = (lab: string): BmuExecRelation[] => targetRelations.filter((r) => r.label === lab);
  const seedRel = byLabel('public_path_seed')[0];
  const branchRels = byLabel('public_path_branch');
  const chainRels = byLabel('public_path_chain');
  const termRels = byLabel('public_path_terminal');
  if (!seedRel || branchRels.length === 0 || termRels.length === 0) return null;
  const dstOf = (r: BmuExecRelation): string => (r.dst ?? r.other_id) as string;
  const srcOf = (r: BmuExecRelation): string => r.src;
  const typeOf = (r: BmuExecRelation): string => (r.type ?? r.edgeType) as string;
  const continues = new Set<string>([...chainRels.map(dstOf), ...termRels.map(dstOf)]);
  const onRouteMid1 = branchRels.map(srcOf).find((src) => continues.has(src));
  const incomingTypes = [typeOf(branchRels[0]!)];
  const chainByDst = new Map(chainRels.map((r) => [dstOf(r), r]));
  let node = onRouteMid1;
  const guard = new Set<string>();
  while (node !== undefined && chainByDst.has(node)) {
    if (guard.has(node)) break;
    guard.add(node);
    const r = chainByDst.get(node)!;
    incomingTypes.push(typeOf(r));
    node = srcOf(r);
  }
  incomingTypes.push(typeOf(termRels[0]!));
  const steps: BmuExecStep[] = [
    { direction: 'outgoing', edgeType: typeOf(seedRel) },
    ...incomingTypes.map((edgeType) => ({ direction: 'incoming' as const, edgeType })),
  ];
  const src = sourceProgram.steps;
  for (let i = 1; i < steps.length - 1 && i < src.length; i++) {
    if (src[i]?.suppress === true) (steps[i] as { suppress?: boolean }).suppress = true;
    if (src[i]?.offPathSuppress === true) (steps[i] as { offPathSuppress?: boolean }).offPathSuppress = true;
  }
  return { branchLimit: sourceProgram.branchLimit, steps };
}

export interface BmuBaselineVerdict {
  /** true iff SOME public baseline solves the target cluster with zero re-discovery. */
  readonly baselineSolvable: boolean;
  /** which strategy solved it ('specIndexRemap' | 'setCanonicalRemap' | 'topologyProbeCompiler'), or null. */
  readonly strategy: string | null;
  /** the prior era the transferring baseline was compiled FROM, or null. */
  readonly fromEra: number | null;
  /** the target program's inferred era, or null when it is not a registered-era program. */
  readonly targetEra: number | null;
}

/**
 * THE PERMANENT BASELINE BATTERY (§17.44 point 5), as a single importable verdict.
 *
 * Given the target program a producer claims as a genuine first-discovery, decide
 * whether ANY purely-mechanical, public-information-only baseline already solves the
 * canonical target cluster — using only the PUBLIC era spec + the PUBLIC target
 * cluster relations (which are a deterministic public function of the program bytes,
 * §17.44 finding 3). If so, the claim is NOT a genuine first-discovery: it is
 * baseline-transferable and earns no novelty credit (operator ruling §17.44 point 4:
 * "credit a miner only for utility BEYOND the best transferring public baseline").
 *
 * Battery strategies run (bounded, deterministic):
 *  - specIndexRemap  — for every prior era E' (same-bank-shape or not), remap every
 *    program in era-E''s PUBLIC bank into the target era by the published registry
 *    index map, and test whether the remapped program solves the target cluster.
 *    This is the load-bearing check that closes the §17.44 exploit (era-1→era-2 is a
 *    public bijection, so every era-2 program is a spec-remap of an era-1 bank
 *    program → NOT novel).
 *  - setCanonicalRemap — the strictly-weaker sorted-order variant (negative control).
 *  - topologyProbeCompiler — OPTIONAL (default off; see scope note). Reconstructs the
 *    solution from the target's own public relations; because the corpus publishes
 *    the solving program alongside the task, this baseline solves EVERYTHING,
 *    including genuine era-1 genesis discoveries. It is therefore reported/available
 *    but NOT used as a per-accept rejection criterion by default — enabling it would
 *    (correctly, per §17.44) reject ALL first-discovery, which is the "the whole task
 *    publishes its solution" finding rather than a usable novelty gate. Callers that
 *    want the maximal (degenerate) reading pass `includeTopologyProbe: true`.
 *
 * `priorEras` defaults to every registered era strictly below the target era (the
 * banks a miner provably already knows). Cost is bounded by
 * |priorEras| × 36 × 2 program executions per call — small enough to run per-accept
 * with no caching (documented tradeoff).
 */
export function bestPublicBaselineSolves(args: {
  targetProgram: BmuExecProgram;
  priorEras?: readonly number[];
  includeTopologyProbe?: boolean;
}): BmuBaselineVerdict {
  const { targetProgram } = args;
  const targetEra = bmuInferBaselineEra(targetProgram);
  const cluster = bmuBaselineTargetCluster(targetProgram);
  if (cluster === null || targetEra === null) {
    return { baselineSolvable: false, strategy: null, fromEra: null, targetEra };
  }
  const priorEras = (args.priorEras ?? BMU_BASELINE_ERAS.filter((e) => e < targetEra))
    .filter((e) => e !== targetEra && BMU_BASELINE_ERA_REGISTRY[e] !== undefined);

  for (const fromEra of priorEras) {
    const bank = bmuProgramBankForEra(fromEra);
    for (const order of ['registry', 'sorted'] as const) {
      let remap: BmuEraEdgeRemap;
      try {
        remap = makeEraEdgeRemap(fromEra, targetEra, { order });
      } catch {
        continue; // partition arity mismatch — no positional remap defined
      }
      for (const q of bank) {
        const compiled = remapProgramToEra(q, remap);
        if (solvesTargetCluster(compiled, cluster)) {
          return {
            baselineSolvable: true,
            strategy: order === 'registry' ? 'specIndexRemap' : 'setCanonicalRemap',
            fromEra,
            targetEra,
          };
        }
      }
    }
  }

  if (args.includeTopologyProbe === true) {
    const probe = topologyProbeProgram(targetProgram, cluster.relations);
    if (probe && solvesTargetCluster(probe, cluster)) {
      return { baselineSolvable: true, strategy: 'topologyProbeCompiler', fromEra: null, targetEra };
    }
  }

  return { baselineSolvable: false, strategy: null, fromEra: null, targetEra };
}
