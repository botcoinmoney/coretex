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
