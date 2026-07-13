/**
 * §17.39 item-5 — TRANSFERRING COMPILER audit (adversarial).
 *
 * `crossEraTransferAudit` (era-transition-sim.mjs) tests whether UNCHANGED
 * prior-era program BYTECODE can solve the next era's clusters. Because each era
 * pins a DISJOINT outgoing-edge vocabulary (BMU_EXECUTABLE_ERA_REGISTRY /
 * BMU_ERA_OUTGOING_EDGES), an era-N program's leading step edge does not exist in
 * era-(N+1)'s corpus at all — so it routes empty and the audit is 0/0 BY
 * CONSTRUCTION. That is a vacuous negative: it proves the bytecode is
 * syntactically incompatible, NOT that a miner who reads the PUBLIC era spec
 * cannot mechanically translate its known-good strategy into the new vocabulary
 * with zero re-discovery.
 *
 * This audit builds that adversary — a "transferring compiler" — and runs it for
 * real against the actual per-era program banks + the actual deep-terminal
 * clusters that `buildClassCatalog` mints. The question it answers is the one the
 * operator posed: does the DISJOINT-VOCABULARY design impose genuine per-era
 * DISCOVERY cost, or only cosmetic bytecode incompatibility that a spec-reading
 * remap defeats for free?
 *
 * Three compiler strategies (an honest multi-adversary battery, not one weak
 * naive remap):
 *
 *  A) specIndexRemap  — the canonical structural analog. Reads the PUBLIC
 *     registry arrays and maps each source-era step edge to the target era's edge
 *     AT THE SAME INDEX in the outgoing/incoming partition, preserving step
 *     direction, count, and suppress/offPathSuppress flags. This is exactly
 *     "remap its strategy to the new vocabulary."
 *  B) setCanonicalRemap — a STRICTLY WEAKER adversary that knows only the
 *     partition SETS (not the published array ORDER); it canonicalizes both
 *     partitions by lexical sort and maps by sorted index. Negative control: if
 *     it fails where (A) succeeds, the specific edge ASSIGNMENT is load-bearing —
 *     but that assignment is fully public (the registry array order), so (B)'s
 *     failure is a self-inflicted handicap, not real protection.
 *  C) topologyProbeCompiler — arity-AGNOSTIC. Ignores the source program's edge
 *     sequence; reads the TARGET cluster's PUBLIC relation edge types (the served
 *     memory graph a miner can observe) to reconstruct the target traversal, and
 *     applies the operation flag from the public family operation plan (carried
 *     from the source program's flagged step index). This defeats a bank-SHAPE
 *     change (e.g. era-3's all-4-step restructure) that (A) cannot follow.
 *
 * "Solves" = the same executed terminal-set equality `crossEraTransferAudit`
 * uses. "Credited" = the CREDITED utility the scorer actually consumes
 * (`creditedUtility`: required ⊆ topB ∧ forbidden ∩ topB = ∅). We report BOTH,
 * because a program can route the right terminals yet miss credited utility if it
 * mishandles the family seed role — so credited transfer is the stronger claim.
 *
 * STOP-LINE: build+prove only; deterministic CPU (no Qwen, no Date.now/random);
 * arms nothing; mutates no production state; reads only public specs + public
 * cluster relations.
 */
import {
  eraSpec,
  executeProgramOverRelations,
  buildProgramPathTopology,
  programBankForEra,
  BMU_EXECUTABLE_ERA_REGISTRY,
} from '../bmu-generators/operation-program.mjs';
import {
  buildClassCatalog,
  creditedUtility,
} from './era-transition-sim.mjs';

/** A step-signature string (flags included) for exact-reconstruction checks. */
export function programSig(program) {
  return `${program.steps.map((s) => `${s.direction}:${s.edgeType}${s.suppress ? ':sup' : ''}${s.offPathSuppress ? ':off' : ''}`).join('/')}|b${program.branchLimit}`;
}

/**
 * Build the public edge remap `sourceEdge -> targetEdge` between two eras.
 * `order`:
 *  - 'registry' (strategy A): map by index in the PUBLISHED registry arrays.
 *  - 'sorted'   (strategy B): map by index after a lexical sort of each set.
 */
export function makeEraEdgeRemap(fromEra, toEra, { order = 'registry' } = {}) {
  const s = eraSpec(fromEra);
  const t = eraSpec(toEra);
  const seq = (arr) => (order === 'sorted' ? [...arr].sort() : [...arr]);
  const sOut = seq(s.outgoingEdgeTypes);
  const tOut = seq(t.outgoingEdgeTypes);
  const sInc = seq(s.incomingEdgeTypes);
  const tInc = seq(t.incomingEdgeTypes);
  if (sOut.length !== tOut.length || sInc.length !== tInc.length) {
    throw new Error(`makeEraEdgeRemap: partition arity differs between era ${fromEra} and ${toEra}`);
  }
  const outMap = new Map(sOut.map((e, i) => [e, tOut[i]]));
  const incMap = new Map(sInc.map((e, i) => [e, tInc[i]]));
  return {
    order,
    outMap,
    incMap,
    remapEdge(edge, direction) {
      const m = direction === 'outgoing' ? outMap : incMap;
      const mapped = m.get(edge);
      if (mapped === undefined) throw new Error(`makeEraEdgeRemap: no ${direction} mapping for '${edge}'`);
      return mapped;
    },
  };
}

/**
 * Strategy A/B — mechanically remap a solved source-era program into the target
 * era's vocabulary by the public edge map, preserving direction, step count and
 * the suppress/offPathSuppress operation flags. No new discovery: a pure
 * relabel of a known-good program.
 */
export function remapProgramToEra(program, remap) {
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

/**
 * Strategy C — reconstruct the target program by reading the TARGET cluster's
 * PUBLIC relation edge types (the observable served memory graph). Arity-agnostic:
 * it follows the actual deep-terminal route of the target cluster, so a target
 * era that changed its bank SHAPE (step count) is reconstructed exactly. The
 * operation flag is carried from the source program's flagged NON-final step
 * (which is the public per-family operation plan — the same rule in every era for
 * a given family). Reads NOTHING private: only public relations + the public
 * flag plan already encoded in the (public) source program.
 */
export function topologyProbeProgram(sourceProgram, targetCluster) {
  const rels = targetCluster.relations;
  const byLabel = (lab) => rels.filter((r) => r.label === lab);
  const seedRel = byLabel('public_path_seed')[0];
  const branchRels = byLabel('public_path_branch');
  const chainRels = byLabel('public_path_chain');
  const termRels = byLabel('public_path_terminal');
  if (!seedRel || branchRels.length === 0 || termRels.length === 0) {
    throw new Error('topologyProbeProgram: target cluster is not a deep-terminal topology');
  }
  // The on-route depth-1 mid node continues to deeper mids/terminal; decoys are
  // dead ends. Walk the on-route chain outward to order the incoming steps.
  const continues = new Set([...chainRels.map((r) => r.dst), ...termRels.map((r) => r.dst)]);
  const onRouteMid1 = branchRels.map((r) => r.src).find((src) => continues.has(src));
  const incomingTypes = [branchRels[0].type];
  const chainByDst = new Map(chainRels.map((r) => [r.dst, r]));
  let node = onRouteMid1;
  const guard = new Set();
  while (node !== undefined && chainByDst.has(node)) {
    if (guard.has(node)) break; // fail-safe against a malformed cycle
    guard.add(node);
    const r = chainByDst.get(node);
    incomingTypes.push(r.type);
    node = r.src;
  }
  incomingTypes.push(termRels[0].type);
  const steps = [
    { direction: 'outgoing', edgeType: seedRel.type },
    ...incomingTypes.map((type) => ({ direction: 'incoming', edgeType: type })),
  ];
  // Carry the public operation flag from the source program's flagged NON-final
  // step index (the family operation plan). Never flag the terminal step.
  const src = sourceProgram.steps;
  for (let i = 1; i < steps.length - 1 && i < src.length; i++) {
    if (src[i]?.suppress === true) steps[i].suppress = true;
    if (src[i]?.offPathSuppress === true) steps[i].offPathSuppress = true;
  }
  return { branchLimit: sourceProgram.branchLimit, steps };
}

/** Executed terminal-set equality (the `crossEraTransferAudit` "solves" law). */
function solvesCluster(program, cluster) {
  let out;
  try {
    out = executeProgramOverRelations({ program, relations: cluster.relations, seedIds: [cluster.seedId], branchLimit: program.branchLimit });
  } catch { return false; }
  const got = new Set(out.terminalIds);
  if (got.size !== cluster.requiredTerminals.size) return false;
  for (const t of cluster.requiredTerminals) if (!got.has(t)) return false;
  return true;
}

/** The CREDITED utility the scorer consumes (required ⊆ topB ∧ forbidden ∩ topB = ∅). */
function creditsCluster(program, cluster) {
  let exec;
  try {
    exec = executeProgramOverRelations({ program, relations: cluster.relations, seedIds: [cluster.seedId], branchLimit: program.branchLimit });
  } catch { return false; }
  return creditedUtility({ exec, requiredIds: new Set(cluster.requiredIds), forbiddenIds: new Set(cluster.forbiddenIds) }).utility === 1;
}

/**
 * Run the full transferring-compiler battery for one era pair against the REAL
 * catalog. For each solved source-era cluster, compile its program into the
 * target vocabulary by each strategy and test whether the compiled program solves
 * / credits the CORRESPONDING (same family+ordinal) target-era cluster — with zero
 * independent target-era discovery.
 *
 * @param {object} opts
 * @param {object} opts.dist — built @botcoin/coretex (provides bmuOperationQueryKey).
 * @param {number} opts.fromEra
 * @param {number} opts.toEra
 */
export function transferringCompilerAudit({ dist, fromEra, toEra }) {
  const catalog = buildClassCatalog({ eras: [fromEra, toEra], queryKeyOf: dist.bmuOperationQueryKey });
  const source = [...catalog.values()].filter((c) => c.era === fromEra);
  const targetByKey = new Map([...catalog.values()].filter((c) => c.era === toEra).map((c) => [`${c.family}:${c.ordinal}`, c]));
  const total = source.length;

  // Positive controls: every source program solves+credits its OWN cluster, and
  // every target program solves+credits ITS own cluster. If these fail the audit
  // is measuring noise.
  let sourceOwnControlFail = 0;
  let targetOwnControlFail = 0;
  for (const c of source) {
    if (!solvesCluster(c.program, c) || !creditsCluster(c.program, c)) sourceOwnControlFail += 1;
    const t = targetByKey.get(`${c.family}:${c.ordinal}`);
    if (!t || !solvesCluster(t.program, t) || !creditsCluster(t.program, t)) targetOwnControlFail += 1;
  }

  const strategies = {};
  // The EDGE-PARTITION arity (2 outgoing × 4 incoming) is identical in every
  // registered era, so a positional edge remap is always well-defined. Whether
  // the BANK SHAPE (per-program step count) is preserved is a separate question,
  // surfaced by specIndexRemap.arityMismatch below (era-3 restructured the bank to
  // all-4-step, so remapping an era-1/2 3-step program yields the wrong arity).
  const edgePartitionSameArity = eraSpec(fromEra).outgoingEdgeTypes.length === eraSpec(toEra).outgoingEdgeTypes.length
    && eraSpec(fromEra).incomingEdgeTypes.length === eraSpec(toEra).incomingEdgeTypes.length;

  const runRemap = (order) => {
    const remap = makeEraEdgeRemap(fromEra, toEra, { order });
    let solved = 0; let credited = 0; let arityMismatch = 0; let exactReconstruct = 0;
    for (const c of source) {
      const compiled = remapProgramToEra(c.program, remap);
      const t = targetByKey.get(`${c.family}:${c.ordinal}`);
      if (compiled.steps.length !== t.program.steps.length) arityMismatch += 1;
      if (programSig(compiled) === programSig(t.program)) exactReconstruct += 1;
      if (solvesCluster(compiled, t)) solved += 1;
      if (creditsCluster(compiled, t)) credited += 1;
    }
    return { order, solved, credited, arityMismatch, exactReconstruct, total };
  };

  strategies.specIndexRemap = runRemap('registry');
  strategies.setCanonicalRemap = runRemap('sorted');

  // Strategy C — topology probe (arity-agnostic).
  {
    let solved = 0; let credited = 0;
    for (const c of source) {
      const t = targetByKey.get(`${c.family}:${c.ordinal}`);
      const compiled = topologyProbeProgram(c.program, t);
      if (solvesCluster(compiled, t)) solved += 1;
      if (creditsCluster(compiled, t)) credited += 1;
    }
    strategies.topologyProbeCompiler = { solved, credited, total };
  }

  return {
    fromEra,
    toEra,
    total,
    edgePartitionSameArity,
    // bank shape (per-program step count) preserved iff a positional remap keeps
    // every program's arity — false when the target era restructured the bank.
    bankShapePreserved: strategies.specIndexRemap.arityMismatch === 0,
    sourceOwnControlFail,
    targetOwnControlFail,
    strategies,
    // headline verdict: does ANY purely-mechanical, public-info-only compiler
    // achieve full CREDITED transfer with zero re-discovery?
    fullCreditedTransferByAnyStrategy:
      strategies.specIndexRemap.credited === total
      || strategies.topologyProbeCompiler.credited === total,
  };
}

// ─── §17.44 point-4/5 — the PERMANENT public-baseline battery, as a standing,
//     per-program verdict (the harness-canonical twin of the vendored
//     `bestPublicBaselineSolves` the COORDINATOR verifier imports from
//     `@botcoin/coretex`; pinned byte-behaviourally by
//     `bmu-baseline-battery-parity.test.mjs`). ────────────────────────────────

/** All registered baseline eras, ascending. */
export const BMU_BASELINE_ERAS = Object.freeze(
  Object.keys(BMU_EXECUTABLE_ERA_REGISTRY).map(Number).sort((a, b) => a - b),
);

/** Infer a program's era from its leading outgoing edge; null when it is not a
 *  well-formed single-era program (so it cannot be a cross-era spec-remap of one). */
export function inferBaselineEra(program) {
  const lead = program?.steps?.[0];
  if (!lead || lead.direction !== 'outgoing') return null;
  for (const era of BMU_BASELINE_ERAS) {
    if (eraSpec(era).outgoingEdgeTypes.includes(lead.edgeType)) return era;
  }
  return null;
}

const T_SEED = 't_seed';
const T_GOLD = 't_gold';
const T_DECOY = 't_decoy';

/** The canonical PUBLIC deep-terminal target cluster a program solves — a
 *  deterministic function of the program bytes (`buildProgramPathTopology`). Null
 *  for a program that cannot form a deep-terminal cluster (not a bank program). */
export function bmuBaselineTargetCluster(program) {
  try {
    const topo = buildProgramPathTopology({
      program, seedId: T_SEED, sinkIds: ['t_sink'], goldIds: [T_GOLD],
      decoyIds: ['t_decoy'], midIdFor: (level) => `t_mid${level}`, decoyDepth: 1,
    });
    return { relations: topo.relations, seedId: T_SEED, goldId: T_GOLD };
  } catch {
    return null;
  }
}

function solvesTargetCluster(program, cluster) {
  try {
    const exec = executeProgramOverRelations({ program, relations: cluster.relations, seedIds: [cluster.seedId], branchLimit: program.branchLimit });
    return exec.terminalIds.length === 1 && exec.terminalIds[0] === cluster.goldId;
  } catch {
    return false;
  }
}

/**
 * THE PERMANENT BASELINE BATTERY (§17.44 point 5), as a single importable verdict:
 * does ANY purely-mechanical, public-information-only baseline already solve the
 * canonical target cluster of `targetProgram`? See the vendored TS twin
 * (`packages/coretex/src/eval/bmu-baseline-battery.ts`) for the full contract and
 * scope note (topology-probe is default-off; it is the degenerate "the task
 * publishes its own solution" reading).
 */
export function bestPublicBaselineSolves({
  targetProgram, priorEras, includeTopologyProbe = false,
  includeRerankerReadingCompiler = false, includeExhaustiveProgramSearch = false,
  includeRawReranker = false, includeIndexer = false, exhaustiveEras, rerankerScore,
} = {}) {
  const targetEra = inferBaselineEra(targetProgram);
  const cluster = bmuBaselineTargetCluster(targetProgram);
  if (cluster === null || targetEra === null) {
    return { baselineSolvable: false, strategy: null, fromEra: null, targetEra };
  }
  const eras = (priorEras ?? BMU_BASELINE_ERAS.filter((e) => e < targetEra))
    .filter((e) => e !== targetEra && BMU_EXECUTABLE_ERA_REGISTRY[e] !== undefined);
  for (const fromEra of eras) {
    const bank = programBankForEra(fromEra);
    for (const order of ['registry', 'sorted']) {
      let remap;
      try { remap = makeEraEdgeRemap(fromEra, targetEra, { order }); } catch { continue; }
      for (const q of bank) {
        const compiled = remapProgramToEra({ branchLimit: q.branchLimit, steps: q.steps }, remap);
        if (solvesTargetCluster(compiled, cluster)) {
          return { baselineSolvable: true, strategy: order === 'registry' ? 'specIndexRemap' : 'setCanonicalRemap', fromEra, targetEra };
        }
      }
    }
  }
  if (includeTopologyProbe === true) {
    const probe = topologyProbeProgram(targetProgram, { relations: cluster.relations });
    if (probe && solvesTargetCluster(probe, cluster)) {
      return { baselineSolvable: true, strategy: 'topologyProbeCompiler', fromEra: null, targetEra };
    }
  }
  // §17.48 opt-in strategies (all default off — mirror the vendored TS twin).
  if (includeRerankerReadingCompiler || includeExhaustiveProgramSearch || includeRawReranker || includeIndexer) {
    const task = bmuBaselineTaskFromProgram(targetProgram);
    if (task !== null) {
      const injected = rerankerScore ? rerankerScore(task) : undefined;
      const rrOpts = injected ? { rerankerScore: injected } : {};
      if (includeRerankerReadingCompiler) {
        const v = rerankerReadingCompilerSolves(task, rrOpts);
        if (v.baselineSolvable) return { baselineSolvable: true, strategy: v.strategy, fromEra: null, targetEra };
      }
      if (includeExhaustiveProgramSearch) {
        const v = exhaustiveMinimalProgramSearch(task, exhaustiveEras ? { eras: exhaustiveEras } : {});
        if (v.baselineSolvable) return { baselineSolvable: true, strategy: v.strategy, fromEra: v.fromEra, targetEra };
      }
      if (includeRawReranker) {
        const v = rawRerankerBaselineSolves(task, rrOpts);
        if (v.baselineSolvable) return { baselineSolvable: true, strategy: v.strategy, fromEra: null, targetEra };
      }
      if (includeIndexer) {
        const v = indexerBaselineSolves(task);
        if (v.baselineSolvable) return { baselineSolvable: true, strategy: v.strategy, fromEra: null, targetEra };
      }
    }
  }
  return { baselineSolvable: false, strategy: null, fromEra: null, targetEra };
}

// ─── §17.48 SPIKE — reranker-reading compiler, exhaustive/minimal program search,
//     raw-reranker + indexer baselines. Self-contained harness twin of the vendored
//     `@botcoin/coretex` `bmu-baseline-battery.ts` §17.48 section; PINNED
//     byte-behaviourally to it by `bmu-baseline-battery-parity.test.mjs`. Every
//     strategy runs on a generic task (relations + seed + gold + roles) so it points
//     equally at the current corpus and a new task shape; the DEFAULT judge is the
//     deterministic credited-utility oracle (`creditedUtility`, §17.47-Part-B-faithful
//     to real Qwen), injectable for a live scorer. ────────────────────────────────

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Reconstruct the full public task (roles included) a program implies — the
 *  canonical deep-terminal cluster + the §17.35 seed-role derivation (suppress ⇒
 *  forbidden seed; offPathSuppress/pure-promote ⇒ required seed). Mirrors
 *  buildClassCatalog's role assignment. Null for a non-deep-terminal program. */
export function bmuBaselineTaskFromProgram(program) {
  const cluster = bmuBaselineTargetCluster(program);
  if (cluster === null) return null;
  const seedRole = program.steps.some((s) => s.suppress === true) ? 'forbidden' : 'required';
  const requiredIds = seedRole === 'required' ? [cluster.goldId, cluster.seedId] : [cluster.goldId];
  const forbiddenIds = seedRole === 'forbidden' ? [T_DECOY, cluster.seedId] : [T_DECOY];
  return { relations: cluster.relations, seedId: cluster.seedId, goldId: cluster.goldId, trapId: T_DECOY, requiredIds, forbiddenIds, program };
}

/** The §17.35 set-membership credited law over an already-decided topB. */
export function bmuBaselineCreditedFromTopB(topB, requiredIds, forbiddenIds) {
  for (const f of forbiddenIds) if (topB.has(f)) return 0;
  for (const r of requiredIds) if (!topB.has(r)) return 0;
  return 1;
}

/** Deterministic credited-utility judge — byte-mirror of era-transition-sim's
 *  `creditedUtility` (query-similar forbidden baseline 3, required 1; promote +1,
 *  demote −3; topB = top |required|). */
export function bmuBaselineCreditedUtility({ exec, requiredIds, forbiddenIds }) {
  const promoted = new Set([...exec.promoteTerminalIds, ...exec.promotePathNodeIds]);
  const demoted = new Set([...exec.suppressTerminalIds, ...exec.suppressLineageIds, ...exec.offPathSuppressedIds]);
  const req = [...requiredIds];
  const forb = [...forbiddenIds];
  const baseline = (id) => (forbiddenIds.has(id) ? 3 : requiredIds.has(id) ? 1 : 0);
  const score = (id) => baseline(id) + (promoted.has(id) ? 1 : 0) + (demoted.has(id) ? -3 : 0);
  const pool = [...new Set([...req, ...forb])];
  const budgetB = req.length;
  const topB = new Set(pool
    .map((id) => ({ id, s: score(id) }))
    .sort((a, b) => (b.s - a.s) || cmpStr(a.id, b.id))
    .slice(0, budgetB)
    .map((x) => x.id));
  return { utility: bmuBaselineCreditedFromTopB(topB, requiredIds, forbiddenIds), topB: [...topB] };
}

/** Judge a PROGRAM over a task: execute it, then apply the credited-utility law. */
export function bmuBaselineJudgeProgram(program, task) {
  let exec;
  try {
    exec = executeProgramOverRelations({ program, relations: task.relations, seedIds: [task.seedId], branchLimit: program.branchLimit });
  } catch {
    return { utility: 0, topB: [] };
  }
  return bmuBaselineCreditedUtility({ exec, requiredIds: new Set(task.requiredIds ?? []), forbiddenIds: new Set(task.forbiddenIds ?? []) });
}

/** Default reranker score model (documented deterministic stand-in for live Qwen):
 *  query-similar forbidden trap = 3, required = 1, else 0 (the `creditedUtility`
 *  baseline). Derivable from the current corpus's public structure (that is WHY it
 *  leaks); a new task shape passes a real reranker instead. */
export function bmuBaselineDefaultRerankerScore(task) {
  const forb = new Set(task.forbiddenIds ?? []);
  const req = new Set(task.requiredIds ?? []);
  return (id) => (forb.has(id) ? 3 : req.has(id) ? 1 : 0);
}

function bmuBaselineAdjacency(relations) {
  const adj = new Map();
  const add = (a, b) => { (adj.get(a) ?? adj.set(a, new Set()).get(a)).add(b); };
  for (const r of relations) {
    const src = r.src;
    const dst = r.dst ?? r.other_id;
    if (src === undefined || dst === undefined) continue;
    add(src, dst);
    add(dst, src);
  }
  return adj;
}

/** Undirected BFS distance from the seed over the public relation graph. */
export function bmuBaselineSeedDistances(task) {
  const adj = bmuBaselineAdjacency(task.relations);
  const dist = new Map([[task.seedId, 0]]);
  let frontier = [task.seedId];
  while (frontier.length > 0) {
    const next = [];
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        if (!dist.has(m)) { dist.set(m, dist.get(n) + 1); next.push(m); }
      }
    }
    frontier = next;
  }
  return dist;
}

// ── (1) reranker-reading compiler ────────────────────────────────────────────────

/** Reconstruct the flagless public traversal, READ the reranker over reachable
 *  competitors, apply the PUBLIC suppression law to those it surfaces above the
 *  answer (on-route high seed ⇒ suppress; off-path high dead-end ⇒ offPathSuppress;
 *  none ⇒ pure promote). Null if the served graph is not a reconstructable
 *  deep-terminal topology. */
export function rerankerReadingCompilerProgram(task, opts = {}) {
  const rerankerScore = opts.rerankerScore ?? bmuBaselineDefaultRerankerScore(task);
  const branchLimit = opts.branchLimit ?? task.program?.branchLimit ?? 4;
  const skeleton = { branchLimit, steps: (task.program?.steps ?? []).map((s) => ({ direction: s.direction, edgeType: s.edgeType })) };
  let base;
  try { base = topologyProbeProgram(skeleton, { relations: task.relations }); } catch { return null; }
  if (!base) return null;
  const steps = base.steps.map((s) => ({ ...s }));
  const dist = bmuBaselineSeedDistances(task);
  // Promotion target: the public answer terminal when the served graph publishes it
  // (current corpus); else the reranker's argmax reachable candidate — no per-shape
  // modification, goldId not required.
  const reachable = [...dist.keys()].filter((id) => id !== task.seedId);
  const answer = task.goldId ?? reachable.slice().sort((a, b) => (rerankerScore(b) - rerankerScore(a)) || cmpStr(a, b))[0];
  if (answer === undefined) return { branchLimit, steps };
  const answerScore = rerankerScore(answer);
  const seedScore = rerankerScore(task.seedId);
  const competitorsAboveAnswer = reachable.filter((id) => id !== answer && rerankerScore(id) > answerScore);
  let branchIdx = -1;
  for (let i = 1; i < steps.length - 1; i++) { if (steps[i].direction === 'incoming') { branchIdx = i; break; } }
  if (competitorsAboveAnswer.length > 0 && branchIdx >= 1) {
    if (seedScore > answerScore) steps[branchIdx].suppress = true;
    else steps[branchIdx].offPathSuppress = true;
  }
  return { branchLimit, steps };
}

/** The reranker-reading compiler's verdict: build the mechanical program, judge it. */
export function rerankerReadingCompilerSolves(task, opts = {}) {
  const program = rerankerReadingCompilerProgram(task, opts.rerankerScore ? { rerankerScore: opts.rerankerScore } : {});
  if (program === null) return { baselineSolvable: false, strategy: null, program: null };
  const judge = opts.judge ?? bmuBaselineJudgeProgram;
  const solvable = judge(program, task).utility === 1;
  return { baselineSolvable: solvable, strategy: solvable ? 'rerankerReadingCompiler' : null, program };
}

// ── (2) exhaustive / minimal program search ──────────────────────────────────────

/** Public suppress-flag overlays of one base program (3^k over non-final incoming
 *  steps; suppress/offPathSuppress mutually exclusive per step). */
function bmuBaselineFlagOverlays(program) {
  const suppressable = [];
  for (let i = 1; i < program.steps.length - 1; i++) if (program.steps[i].direction === 'incoming') suppressable.push(i);
  const total = 3 ** suppressable.length;
  const out = [];
  for (let mask = 0; mask < total; mask++) {
    let m = mask;
    const steps = program.steps.map((s) => ({ direction: s.direction, edgeType: s.edgeType }));
    for (const idx of suppressable) {
      const choice = m % 3; m = Math.floor(m / 3);
      if (choice === 1) steps[idx].suppress = true;
      else if (choice === 2) steps[idx].offPathSuppress = true;
    }
    out.push({ branchLimit: program.branchLimit, steps });
  }
  return out;
}

/** The full enumerable PUBLIC program space over the given eras (each era's 36-entry
 *  base bank × the public flag envelope), de-duplicated by step-signature. */
export function enumeratePublicProgramSpace(eras = BMU_BASELINE_ERAS) {
  const out = [];
  const seen = new Set();
  for (const era of eras) {
    if (BMU_EXECUTABLE_ERA_REGISTRY[era] === undefined) continue;
    for (const base of programBankForEra(era)) {
      for (const variant of bmuBaselineFlagOverlays({ branchLimit: base.branchLimit, steps: base.steps })) {
        const sig = programSig(variant);
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(variant);
      }
    }
  }
  return out;
}

/** Brute-force the whole enumerable public program space; report whether ANY credits
 *  the task + the MINIMAL crediting program (fewest steps, then flags, then
 *  branchLimit, then step-sig). Operationalizes the operator's "minimal-solver". */
export function exhaustiveMinimalProgramSearch(task, opts = {}) {
  const judge = opts.judge ?? bmuBaselineJudgeProgram;
  const space = enumeratePublicProgramSpace(opts.eras ?? BMU_BASELINE_ERAS);
  const flagCount = (p) => p.steps.filter((s) => s.suppress === true || s.offPathSuppress === true).length;
  const better = (a, b) => (
    a.steps.length !== b.steps.length ? a.steps.length < b.steps.length
      : flagCount(a) !== flagCount(b) ? flagCount(a) < flagCount(b)
        : a.branchLimit !== b.branchLimit ? a.branchLimit < b.branchLimit
          : programSig(a) < programSig(b)
  );
  let count = 0;
  let minimal = null;
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
    minimalStepSig: minimal === null ? null : programSig(minimal),
    fromEra: minimal === null ? null : inferBaselineEra(minimal),
  };
}

// ── (3) raw-reranker baseline (§17.47 Part B, now reusable) ──────────────────────

/** Degenerate reranker-reading compiler with ZERO memory op: topB straight off the
 *  reranker over required∪forbidden. Floor control (0/128 under real Qwen, §17.47). */
export function rawRerankerBaselineSolves(task, opts = {}) {
  const rerankerScore = opts.rerankerScore ?? bmuBaselineDefaultRerankerScore(task);
  const requiredIds = new Set(task.requiredIds ?? []);
  const forbiddenIds = new Set(task.forbiddenIds ?? []);
  const pool = [...new Set([...requiredIds, ...forbiddenIds])];
  const budgetB = requiredIds.size;
  const topB = new Set(pool
    .map((id) => ({ id, s: rerankerScore(id) }))
    .sort((a, b) => (b.s - a.s) || cmpStr(a.id, b.id))
    .slice(0, budgetB)
    .map((x) => x.id));
  const solvable = bmuBaselineCreditedFromTopB(topB, requiredIds, forbiddenIds) === 1;
  return { baselineSolvable: solvable, strategy: solvable ? 'rawReranker' : null, topB: [...topB] };
}

// ── (4) indexer baseline (weakest floor) ─────────────────────────────────────────

/** Pure retrieval — no reranker, no memory op: rank reachable docs by public
 *  structural proximity (BFS distance from seed), take top |required|. True floor. */
export function indexerBaselineSolves(task) {
  const requiredIds = new Set(task.requiredIds ?? []);
  const forbiddenIds = new Set(task.forbiddenIds ?? []);
  const dist = bmuBaselineSeedDistances(task);
  const budgetB = requiredIds.size;
  const candidates = [...dist.keys()].filter((id) => id !== task.seedId);
  const topB = new Set(candidates
    .sort((a, b) => (dist.get(a) - dist.get(b)) || cmpStr(a, b))
    .slice(0, budgetB));
  const solvable = bmuBaselineCreditedFromTopB(topB, requiredIds, forbiddenIds) === 1;
  return { baselineSolvable: solvable, strategy: solvable ? 'indexer' : null, topB: [...topB] };
}
