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
  type BmuExecResult,
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
 *
 * §17.48 EXTENSION — four further public baselines (all OPT-IN, all default OFF; the
 * per-accept novelty gate keeps using ONLY the spec-remap strategies by default):
 *  - `includeRerankerReadingCompiler` — the §17.45 §8.5 crux made mechanical: run the
 *    (real, or documented-deterministic) reranker over the served graph and apply the
 *    PUBLIC suppression law to whatever it ranks highest among reachable competitors,
 *    with ZERO discovery. Default off: on the CURRENT corpus it degenerates to the
 *    topology probe (the corpus publishes gold-vs-decoy structurally, §17.44 finding
 *    3 / §17.45 L3), so per-accept it would reject ALL first-discovery; it also needs
 *    a judge/scorer (expensive). Built to be pointed at a NEW task shape unmodified.
 *  - `includeExhaustiveProgramSearch` — brute-force the whole enumerable public
 *    program space (every registered era's bank × the public suppress-flag envelope)
 *    and report the MINIMAL crediting program. Default off: expensive, and on the
 *    current corpus it subsumes spec-remap (already the default-on load-bearing gate).
 *  - `includeRawReranker` — the degenerate reranker-reading compiler with NO memory
 *    operation (topB straight off the reranker). A FLOOR CONTROL, not a novelty gate:
 *    it credits ~nothing on the current corpus (§17.47 Part B measured 0/128 under
 *    real Qwen), so per-accept it never rejects. Default off.
 *  - `includeIndexer` — the weakest baseline: pure retrieval, no reranker, no memory
 *    op — rank reachable docs by public structural proximity. Floor control. Default
 *    off (credits ~nothing on the current deep-terminal corpus).
 * `rerankerScore` is an optional factory `(task) => (docId) => score` letting a caller
 * inject a LIVE scorer (or a sibling lane's judge) instead of the deterministic
 * stand-in; `exhaustiveEras` overrides the enumerated program-space eras.
 */
export function bestPublicBaselineSolves(args: {
  targetProgram: BmuExecProgram;
  priorEras?: readonly number[];
  includeTopologyProbe?: boolean;
  includeRerankerReadingCompiler?: boolean;
  includeExhaustiveProgramSearch?: boolean;
  includeRawReranker?: boolean;
  includeIndexer?: boolean;
  exhaustiveEras?: readonly number[];
  rerankerScore?: (task: BmuBaselineTask) => BmuRerankerScore;
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

  // §17.48 opt-in strategies — reconstruct the full public task (roles derivable
  // from the program's own bytes, §17.44 finding 3) and run each enabled baseline.
  const wantsExtra = args.includeRerankerReadingCompiler === true
    || args.includeExhaustiveProgramSearch === true
    || args.includeRawReranker === true
    || args.includeIndexer === true;
  if (wantsExtra) {
    const task = bmuBaselineTaskFromProgram(targetProgram);
    if (task !== null) {
      const injected = args.rerankerScore ? args.rerankerScore(task) : undefined;
      const rrOpts = injected ? { rerankerScore: injected } : {};
      if (args.includeRerankerReadingCompiler === true) {
        const v = rerankerReadingCompilerSolves(task, rrOpts);
        if (v.baselineSolvable) return { baselineSolvable: true, strategy: v.strategy, fromEra: null, targetEra };
      }
      if (args.includeExhaustiveProgramSearch === true) {
        const v = exhaustiveMinimalProgramSearch(task, args.exhaustiveEras ? { eras: args.exhaustiveEras } : {});
        if (v.baselineSolvable) return { baselineSolvable: true, strategy: v.strategy, fromEra: v.fromEra, targetEra };
      }
      if (args.includeRawReranker === true) {
        const v = rawRerankerBaselineSolves(task, rrOpts);
        if (v.baselineSolvable) return { baselineSolvable: true, strategy: v.strategy, fromEra: null, targetEra };
      }
      if (args.includeIndexer === true) {
        const v = indexerBaselineSolves(task);
        if (v.baselineSolvable) return { baselineSolvable: true, strategy: v.strategy, fromEra: null, targetEra };
      }
    }
  }

  return { baselineSolvable: false, strategy: null, fromEra: null, targetEra };
}

// ═══════════════════════════════════════════════════════════════════════════════
// §17.48 SPIKE — four further public baselines (reranker-reading compiler,
// exhaustive/minimal program search, raw-reranker, indexer), built as GENERAL,
// REUSABLE members of this permanent battery. Every one runs on a generic
// `BmuBaselineTask` (relations + seed + gold + roles) so it points equally at the
// CURRENT deep-terminal corpus AND at a to-be-defined vertical-slice task shape —
// take the served graph + judge as parameters, hardcode no corpus assumption.
//
// PUBLIC-INFORMATION DISCIPLINE (unchanged from the module header): every strategy
// reads ONLY the served relations, the PUBLIC era spec, and a scorer/judge; none
// reads a private label the served graph does not already encode. On the current
// corpus the gold-vs-decoy split IS structurally published (§17.44 finding 3 /
// §17.45 L3), so a role derived from that structure is public by construction.
//
// THE JUDGE — honest boundary. This deterministic-CPU research context has no live
// Qwen HTTP scorer (matching §17.47's honest boundary: the full evaluator needs the
// box-retained base corpus, not present here). The DEFAULT judge is therefore the
// SAME deterministic credited-utility oracle the entire era-transition program uses
// to model scorer decisions without a network call — `creditedUtility`
// (era-transition-sim.mjs), ported self-contained here as
// `bmuBaselineCreditedUtility` and pinned to the .mjs by the parity test. It is NOT
// a fake stand-in: §17.47 Part B measured it FAITHFUL to the real Qwen scorer across
// all four families (reranker-alone 0/128; with the resident op 96/128; the one
// honest divergence is multi_hop, where real Qwen needs the bridge reranked unaided
// but the deterministic baseline credits it — noted wherever it matters). Every
// strategy accepts an injected `judge` / `rerankerScore`, so the identical code runs
// against a LIVE scorer (or the sibling lane's judge) unmodified.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A generic scoring task the whole §17.48 battery consumes. `relations`/`seedId`/
 * `goldId` describe the served graph + its single answer terminal; `requiredIds`/
 * `forbiddenIds` are the credited-utility role sets (required ⊆ topB ∧ forbidden ∩
 * topB = ∅). `program`, when present, is the target's own bytes (used only for the
 * flagless traversal skeleton + branchLimit — never for its flags).
 */
export interface BmuBaselineTask {
  readonly relations: readonly BmuExecRelation[];
  readonly seedId: string;
  readonly goldId: string;
  readonly trapId?: string;
  readonly requiredIds?: readonly string[];
  readonly forbiddenIds?: readonly string[];
  readonly program?: BmuExecProgram;
}

/** A reranker as the battery reads it: a query-conditioned score per served doc id. */
export type BmuRerankerScore = (docId: string) => number;

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reconstruct the full public task (roles included) a program implies — the
 * deterministic canonical deep-terminal cluster (`bmuBaselineTargetCluster`) plus
 * the §17.35 seed-role derivation: a program carrying `suppress` marks its family
 * seed a FORBIDDEN query-similar trap that must be evicted; an offPathSuppress-only
 * (or pure-promote) program marks the on-route seed REQUIRED. Mirrors
 * `buildClassCatalog`'s role assignment. Null for a non-deep-terminal program.
 */
export function bmuBaselineTaskFromProgram(program: BmuExecProgram): BmuBaselineTask | null {
  const cluster = bmuBaselineTargetCluster(program);
  if (cluster === null) return null;
  const seedRole: 'forbidden' | 'required' = program.steps.some((s) => s.suppress === true) ? 'forbidden' : 'required';
  const requiredIds = seedRole === 'required' ? [cluster.goldId, cluster.seedId] : [cluster.goldId];
  const forbiddenIds = seedRole === 'forbidden' ? [T_DECOY, cluster.seedId] : [T_DECOY];
  return {
    relations: cluster.relations,
    seedId: cluster.seedId,
    goldId: cluster.goldId,
    trapId: T_DECOY,
    requiredIds,
    forbiddenIds,
    program,
  };
}

// ── credited-utility judge (self-contained twin of era-transition-sim.mjs) ──────

/** The §17.35 set-membership credited law over an already-decided topB. */
export function bmuBaselineCreditedFromTopB(
  topB: ReadonlySet<string>,
  requiredIds: ReadonlySet<string>,
  forbiddenIds: ReadonlySet<string>,
): 0 | 1 {
  for (const f of forbiddenIds) if (topB.has(f)) return 0;
  for (const r of requiredIds) if (!topB.has(r)) return 0;
  return 1;
}

/**
 * The deterministic credited-utility judge — byte-mirror of era-transition-sim's
 * `creditedUtility`. Models the ranked pool the real judge consumes: every
 * query-similar FORBIDDEN doc is a strong stage-1 competitor (baseline 3 — the
 * trap LOOKS most relevant), REQUIRED docs are retrievable (baseline 1); the
 * executed program then PROMOTES (+1) / DEMOTES (−3) via its real promote/suppress
 * sets. topB = top |required| by (score desc, docId asc).
 */
export function bmuBaselineCreditedUtility(args: {
  exec: BmuExecResult;
  requiredIds: ReadonlySet<string>;
  forbiddenIds: ReadonlySet<string>;
}): { utility: 0 | 1; topB: string[] } {
  const { exec, requiredIds, forbiddenIds } = args;
  const promoted = new Set<string>([...exec.promoteTerminalIds, ...exec.promotePathNodeIds]);
  const demoted = new Set<string>([...exec.suppressTerminalIds, ...exec.suppressLineageIds, ...exec.offPathSuppressedIds]);
  const req = [...requiredIds];
  const forb = [...forbiddenIds];
  const baseline = (id: string): number => (forbiddenIds.has(id) ? 3 : requiredIds.has(id) ? 1 : 0);
  const score = (id: string): number => baseline(id) + (promoted.has(id) ? 1 : 0) + (demoted.has(id) ? -3 : 0);
  const pool = [...new Set<string>([...req, ...forb])];
  const budgetB = req.length;
  const topB = new Set<string>(pool
    .map((id) => ({ id, s: score(id) }))
    .sort((a, b) => (b.s - a.s) || cmpStr(a.id, b.id))
    .slice(0, budgetB)
    .map((x) => x.id));
  return { utility: bmuBaselineCreditedFromTopB(topB, requiredIds, forbiddenIds), topB: [...topB] };
}

/** Judge a PROGRAM over a task: execute it, then apply the credited-utility law. */
export function bmuBaselineJudgeProgram(program: BmuExecProgram, task: BmuBaselineTask): { utility: 0 | 1; topB: string[] } {
  let exec: BmuExecResult;
  try {
    exec = executeProgramOverRelations({ program, relations: task.relations, seedIds: [task.seedId], branchLimit: program.branchLimit });
  } catch {
    return { utility: 0, topB: [] };
  }
  return bmuBaselineCreditedUtility({ exec, requiredIds: new Set(task.requiredIds ?? []), forbiddenIds: new Set(task.forbiddenIds ?? []) });
}

/**
 * The default reranker score model (documented deterministic stand-in for live
 * Qwen): a served doc's query similarity is HIGH iff it is a query-similar
 * forbidden trap (3), MID iff it is required evidence (1), else 0 — exactly the
 * `creditedUtility` baseline. Derivable from the current corpus's public structure
 * (that is WHY it leaks); a new task shape passes a real reranker instead.
 */
export function bmuBaselineDefaultRerankerScore(task: BmuBaselineTask): BmuRerankerScore {
  const forb = new Set(task.forbiddenIds ?? []);
  const req = new Set(task.requiredIds ?? []);
  return (id: string): number => (forb.has(id) ? 3 : req.has(id) ? 1 : 0);
}

// ── graph helpers (public-relation reachability + structural proximity) ─────────

function bmuBaselineAdjacency(relations: readonly BmuExecRelation[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string): void => { (adj.get(a) ?? adj.set(a, new Set<string>()).get(a)!).add(b); };
  for (const r of relations) {
    const src = r.src;
    const dst = (r.dst ?? r.other_id) as string;
    if (src === undefined || dst === undefined) continue;
    add(src, dst);
    add(dst, src);
  }
  return adj;
}

/** Undirected BFS distance from the seed over the public relation graph. */
export function bmuBaselineSeedDistances(task: BmuBaselineTask): Map<string, number> {
  const adj = bmuBaselineAdjacency(task.relations);
  const dist = new Map<string, number>([[task.seedId, 0]]);
  let frontier = [task.seedId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        if (!dist.has(m)) { dist.set(m, dist.get(n)! + 1); next.push(m); }
      }
    }
    frontier = next;
  }
  return dist;
}

// ── (1) RERANKER-READING COMPILER ───────────────────────────────────────────────

/**
 * The §17.45 §8.5 crux made mechanical. (a) Reconstruct the flagless public
 * traversal to the reachable answer from the served relations (the topology probe's
 * route reader — public relations only). (b) READ the reranker's ranking of the
 * reachable competitors. (c) Apply the PUBLIC suppression law to the competitors the
 * reranker surfaces ABOVE the answer — no discovery, no search: if the reranker
 * ranks the on-route seed itself high (a query-similar FORBIDDEN seed) evict its
 * lineage with `suppress`; else the high competitor is an off-path dead-end while
 * the on-route seed is required, so spare it with `offPathSuppress`; if nothing
 * outranks the answer, emit the pure-promote route. Returns null if the served graph
 * is not a reconstructable deep-terminal topology (a NEW task shape lacking the
 * public route labels — honest inability, not a silent pass).
 */
export function rerankerReadingCompilerProgram(
  task: BmuBaselineTask,
  opts: { rerankerScore?: BmuRerankerScore; branchLimit?: number } = {},
): BmuExecProgram | null {
  const rerankerScore = opts.rerankerScore ?? bmuBaselineDefaultRerankerScore(task);
  const branchLimit = opts.branchLimit ?? task.program?.branchLimit ?? 4;
  // (a) flagless public traversal — topology probe reads the route from relations
  // alone; the flag-stripped source is only for step-count/branchLimit, not flags.
  const skeleton: BmuExecProgram = {
    branchLimit,
    steps: (task.program?.steps ?? []).map((s) => ({ direction: s.direction, edgeType: s.edgeType })),
  };
  const base = topologyProbeProgram(skeleton, task.relations);
  if (base === null) return null;
  const steps = base.steps.map((s) => ({ ...s })) as (BmuExecStep & { suppress?: boolean; offPathSuppress?: boolean })[];
  // (b) read the reranker over reachable competitors. The promotion target is the
  // public answer terminal when the served graph publishes it (current corpus,
  // §17.44 finding 3); for a task shape that does NOT structurally mark the answer,
  // fall back to the reranker's own argmax reachable candidate — so the compiler
  // needs no per-shape modification (goldId is not required).
  const dist = bmuBaselineSeedDistances(task);
  const reachable = [...dist.keys()].filter((id) => id !== task.seedId);
  const answer = task.goldId ?? reachable.slice().sort((a, b) => (rerankerScore(b) - rerankerScore(a)) || cmpStr(a, b))[0];
  if (answer === undefined) return { branchLimit, steps };
  const answerScore = rerankerScore(answer);
  const seedScore = rerankerScore(task.seedId);
  const competitorsAboveAnswer = reachable.filter((id) => id !== answer && rerankerScore(id) > answerScore);
  // (c) apply the public suppression law at the first non-final incoming branch step
  let branchIdx = -1;
  for (let i = 1; i < steps.length - 1; i++) { if (steps[i]!.direction === 'incoming') { branchIdx = i; break; } }
  if (competitorsAboveAnswer.length > 0 && branchIdx >= 1) {
    if (seedScore > answerScore) steps[branchIdx]!.suppress = true;
    else steps[branchIdx]!.offPathSuppress = true;
  }
  return { branchLimit, steps };
}

/**
 * The reranker-reading compiler's verdict: build the one mechanical program, judge
 * it (default deterministic credited-utility oracle; inject `judge` for a live
 * scorer). `baselineSolvable` iff the judge credits it with zero discovery.
 */
export function rerankerReadingCompilerSolves(
  task: BmuBaselineTask,
  opts: { rerankerScore?: BmuRerankerScore; judge?: (program: BmuExecProgram, task: BmuBaselineTask) => { utility: 0 | 1 } } = {},
): { baselineSolvable: boolean; strategy: string | null; program: BmuExecProgram | null } {
  const program = rerankerReadingCompilerProgram(task, opts.rerankerScore ? { rerankerScore: opts.rerankerScore } : {});
  if (program === null) return { baselineSolvable: false, strategy: null, program: null };
  const judge = opts.judge ?? bmuBaselineJudgeProgram;
  const solvable = judge(program, task).utility === 1;
  return { baselineSolvable: solvable, strategy: solvable ? 'rerankerReadingCompiler' : null, program };
}

// ── (2) EXHAUSTIVE / MINIMAL PROGRAM SEARCH ─────────────────────────────────────

/** The public suppress-flag overlays of one base program — the live generator's
 *  envelope: independently {none | suppress | offPathSuppress} on each NON-FINAL
 *  incoming step (3^k variants, k = #suppressable steps). No flag on the outgoing
 *  seed or the terminal step; suppress/offPathSuppress mutually exclusive per step. */
function bmuBaselineFlagOverlays(program: BmuExecProgram): BmuExecProgram[] {
  const suppressable: number[] = [];
  for (let i = 1; i < program.steps.length - 1; i++) if (program.steps[i]!.direction === 'incoming') suppressable.push(i);
  const total = 3 ** suppressable.length;
  const out: BmuExecProgram[] = [];
  for (let mask = 0; mask < total; mask++) {
    let m = mask;
    const steps = program.steps.map((s) => ({ direction: s.direction, edgeType: s.edgeType })) as (BmuExecStep & { suppress?: boolean; offPathSuppress?: boolean })[];
    for (const idx of suppressable) {
      const choice = m % 3; m = Math.floor(m / 3);
      if (choice === 1) steps[idx]!.suppress = true;
      else if (choice === 2) steps[idx]!.offPathSuppress = true;
    }
    out.push({ branchLimit: program.branchLimit, steps });
  }
  return out;
}

/**
 * The full enumerable PUBLIC program space over the given eras: every era's 36-entry
 * base bank × the public suppress-flag envelope, de-duplicated by step-signature.
 * This is the exact space §17.43/§17.44 established is enumerable with no search
 * secret (`programBankForEra` is a public function of the era spec).
 */
export function enumeratePublicProgramSpace(eras: readonly number[] = BMU_BASELINE_ERAS): BmuExecProgram[] {
  const out: BmuExecProgram[] = [];
  const seen = new Set<string>();
  for (const era of eras) {
    if (BMU_BASELINE_ERA_REGISTRY[era] === undefined) continue;
    for (const base of bmuProgramBankForEra(era)) {
      for (const variant of bmuBaselineFlagOverlays(base)) {
        const sig = bmuProgramStepSig(variant);
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(variant);
      }
    }
  }
  return out;
}

/**
 * Brute-force the whole enumerable public program space and report whether ANY
 * program credits the task, PLUS the MINIMAL such program (fewest steps, then fewest
 * suppress flags, then smallest branchLimit, then step-sig) — operationalizing the
 * operator's "minimal-solver". Judged by credited utility (what the scorer consumes)
 * by default; inject `judge` for a live scorer.
 */
export function exhaustiveMinimalProgramSearch(
  task: BmuBaselineTask,
  opts: { eras?: readonly number[]; judge?: (program: BmuExecProgram, task: BmuBaselineTask) => { utility: 0 | 1 } } = {},
): { baselineSolvable: boolean; strategy: string | null; solvingProgramCount: number; minimalProgram: BmuExecProgram | null; minimalStepSig: string | null; fromEra: number | null } {
  const judge = opts.judge ?? bmuBaselineJudgeProgram;
  const space = enumeratePublicProgramSpace(opts.eras ?? BMU_BASELINE_ERAS);
  const flagCount = (p: BmuExecProgram): number => p.steps.filter((s) => s.suppress === true || s.offPathSuppress === true).length;
  const better = (a: BmuExecProgram, b: BmuExecProgram): boolean => (
    a.steps.length !== b.steps.length ? a.steps.length < b.steps.length
      : flagCount(a) !== flagCount(b) ? flagCount(a) < flagCount(b)
        : a.branchLimit !== b.branchLimit ? a.branchLimit < b.branchLimit
          : bmuProgramStepSig(a) < bmuProgramStepSig(b)
  );
  let count = 0;
  let minimal: BmuExecProgram | null = null;
  for (const program of space) {
    if (judge(program, task).utility !== 1) continue;
    count += 1;
    if (minimal === null || better(program, minimal)) minimal = program;
  }
  return {
    baselineSolvable: count > 0,
    strategy: count > 0 ? 'exhaustiveProgramSearch' : null,
    solvingProgramCount: count,
    minimalProgram: minimal,
    minimalStepSig: minimal === null ? null : bmuProgramStepSig(minimal),
    fromEra: minimal === null ? null : bmuInferBaselineEra(minimal),
  };
}

// ── (3) RAW-RERANKER BASELINE ───────────────────────────────────────────────────

/**
 * The degenerate reranker-reading compiler with ZERO memory operation: topB read
 * straight off the reranker over the role-bearing pool (required ∪ forbidden), no
 * promote/suppress. This is §17.47 Part B's `baseline (reranker only)` (measured
 * 0/128 under real Qwen) made a first-class, reusable battery member. A FLOOR
 * CONTROL: it credits only when the reranker ALONE already ranks the answer over
 * every trap — which the whole memory operation exists precisely because it does
 * not (§17.35).
 */
export function rawRerankerBaselineSolves(
  task: BmuBaselineTask,
  opts: { rerankerScore?: BmuRerankerScore } = {},
): { baselineSolvable: boolean; strategy: string | null; topB: string[] } {
  const rerankerScore = opts.rerankerScore ?? bmuBaselineDefaultRerankerScore(task);
  const requiredIds = new Set(task.requiredIds ?? []);
  const forbiddenIds = new Set(task.forbiddenIds ?? []);
  const pool = [...new Set<string>([...requiredIds, ...forbiddenIds])];
  const budgetB = requiredIds.size;
  const topB = new Set<string>(pool
    .map((id) => ({ id, s: rerankerScore(id) }))
    .sort((a, b) => (b.s - a.s) || cmpStr(a.id, b.id))
    .slice(0, budgetB)
    .map((x) => x.id));
  const solvable = bmuBaselineCreditedFromTopB(topB, requiredIds, forbiddenIds) === 1;
  return { baselineSolvable: solvable, strategy: solvable ? 'rawReranker' : null, topB: [...topB] };
}

// ── (4) INDEXER BASELINE (weakest floor) ────────────────────────────────────────

/**
 * Pure retrieval — NO reranker, NO memory operation, NO judgment: index everything
 * reachable and rank by PUBLIC structural proximity (undirected graph distance from
 * the seed; a BM25-style "closer is more relevant" prior), take the top |required|.
 * The weakest-possible baseline, a true floor: on a deep-terminal corpus the answer
 * sits FARTHEST from the seed while the traps sit closest, so proximity alone can
 * never surface it.
 */
export function indexerBaselineSolves(
  task: BmuBaselineTask,
): { baselineSolvable: boolean; strategy: string | null; topB: string[] } {
  const requiredIds = new Set(task.requiredIds ?? []);
  const forbiddenIds = new Set(task.forbiddenIds ?? []);
  const dist = bmuBaselineSeedDistances(task);
  const budgetB = requiredIds.size;
  const candidates = [...dist.keys()].filter((id) => id !== task.seedId);
  const topB = new Set<string>(candidates
    .sort((a, b) => (dist.get(a)! - dist.get(b)!) || cmpStr(a, b))
    .slice(0, budgetB));
  const solvable = bmuBaselineCreditedFromTopB(topB, requiredIds, forbiddenIds) === 1;
  return { baselineSolvable: solvable, strategy: solvable ? 'indexer' : null, topB: [...topB] };
}
