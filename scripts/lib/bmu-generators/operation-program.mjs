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
 * §18 GRAMMAR-ERA REGISTRY (era-2 iteration — this lane).
 *
 * The executable operation grammar is versioned by ERA. An era pins (a) the
 * disjoint outgoing/incoming edge PARTITION, (b) the two four-step incoming
 * chains, and (c) the operation-class basis string. The 36-class deep-terminal
 * bank is REGENERATED per era from (a)+(b). Two eras are DISJOINT-PARTITION when
 * their OUTGOING edge vocabularies do not intersect — because every legal
 * program's leading step is `outgoing:<edge>`, a non-intersecting outgoing
 * vocabulary makes it impossible for any era-N program's step-signature to equal
 * any era-M program's (N≠M). That is the class-collision guarantee the transfer
 * census keys on (cue-agnostic step-signature census): cross-era reuseRatio is 0
 * by construction, so a miner's era-1 residents can never re-key onto era-2
 * classes without genuinely NEW discovery.
 *
 * Era invariants enforced by `assertEraSpec`:
 *  - outgoing ∩ incoming = ∅  (the symmetric-route `outgoing:X→incoming:X`
 *    ambiguous-lineage program the decoder refuses fail-closed stays
 *    inexpressible: fix 2a carried forward);
 *  - |outgoing| = 2, |incoming| = 4  (so 2×4×4 + 2×2 = 36 classes / margin +4
 *    over the resident capacity 32 — the §18.6 census floor);
 *  - every edge is one of the six decoder-known public edge types (the byte law
 *    is UNCHANGED — era-2 reuses the same 6 edges under a new partition, so no
 *    decoder/relation-vocabulary change and no new keyed-inversion surface);
 *  - the four-step chains draw only from the era's incoming set.
 *
 * G-B17 three-question posture for a new era (must hold for every registered
 * era; audited by the era refuter, `bmu-v2-era-registry.test.mjs`):
 *  Q1 candidate-state causality — era-N programs decode from state words 384–511
 *     exactly like era-1; ZERO_STATE decodes none; an era-N cluster's required
 *     terminals are reachable ONLY by executing an era-N program (its edges).
 *  Q2 executable class-space > capacity — each era adds 36 classes disjoint from
 *     every other registered era, so the aggregate executable space grows 36 per
 *     era while the resident capacity stays 32 (strictly widening the gap).
 *  Q3 no keyed-inversion shortcut — same keyed-HMAC id law, same deep-terminal
 *     blindness (decoys are depth-1 dead ends, golds observationally identical);
 *     the edge repartition leaks no labels and reveals no ids.
 */
export const BMU_EXECUTABLE_ERA_REGISTRY = Object.freeze({
  1: Object.freeze({
    era: 1,
    basis: BMU_EXECUTABLE_OPERATION_CLASS_BASIS,
    outgoingEdgeTypes: Object.freeze(['causes', 'derived_from']),
    incomingEdgeTypes: Object.freeze(['supports', 'supersedes', 'coreference_of', 'co_occurs_with']),
    fourStepIncomingChains: Object.freeze([
      Object.freeze(['supports', 'supersedes', 'coreference_of']),
      Object.freeze(['co_occurs_with', 'coreference_of', 'supersedes']),
    ]),
  }),
  2: Object.freeze({
    era: 2,
    basis: 'shared-policy-evidence-384-511-4w-program-v2',
    // Disjoint OUTGOING vocabulary vs era-1 {causes, derived_from} ⇒ no cross-era
    // step-signature collision. The evidence/lineage roles rotate: era-2 routes
    // OUT along the assertion pair {supports, supersedes} and gathers evidence IN
    // along the causal/coreference quad — a genuinely different traversal grammar
    // (a miner that learned era-1's causal-lineage-first programs has learned the
    // WRONG leading step for every era-2 cue).
    outgoingEdgeTypes: Object.freeze(['supports', 'supersedes']),
    incomingEdgeTypes: Object.freeze(['coreference_of', 'causes', 'derived_from', 'co_occurs_with']),
    fourStepIncomingChains: Object.freeze([
      Object.freeze(['coreference_of', 'causes', 'derived_from']),
      Object.freeze(['co_occurs_with', 'derived_from', 'causes']),
    ]),
  }),
  // ── era-3 (§17.32, CORRECTED §17.35): a distinct GRAMMAR (disjoint outgoing
  // vocabulary) whose per-family operation FLAG is governed by the family's SEED
  // ROLE — the axis the scorer actually credits. ────────────────────────────────
  // HONEST CORRECTION (§17.35, driven by the independent verifier §17.33): the
  // scorer credits u=1 iff required⊆topB ∧ forbidden∩topB=∅ (set membership); it
  // does NOT read the promote/demote signature. On that credited axis the earlier
  // "4 distinct (depth,flag) operations / 144 distinct" claim was a BYTECODE-
  // signature distinctness, not an operation distinctness. What genuinely makes a
  // wrong-family program FAIL credited utility is the family's SEED ROLE:
  //  - forbidden on-route seed (temporal/conflict/near_collision): the assigned
  //    operation MUST carry `suppress` (0x20) — it evicts on-route seed LINEAGE.
  //    `offPathSuppress` (0x40) demotes only off-path dead-ends and CANNOT evict an
  //    on-route forbidden seed ⇒ forbidden_admitted (this was the near_collision
  //    DEFECT: era-3 wrongly assigned it offPathSuppress@1 ⇒ own-control 36/36 fail
  //    on the REAL forbidden collision-seed; the sim passed only via a neutral seed).
  //  - required on-route seed (multi_hop): the assigned operation MUST carry
  //    `offPathSuppress` (0x40) so the required seed/bridge is SPARED; `suppress`
  //    would evict the required lineage ⇒ missing_required.
  // Depth (1|2) is retained as a secondary BYTECODE dimension only (it does not, by
  // itself, add a credited operation-class — see §17.35 feasibility verdict).
  //  - outgoing {coreference_of, co_occurs_with} — the last unused pair, DISJOINT
  //    from era-1 {causes,derived_from} AND era-2 {supports,supersedes} ⇒ cross-era
  //    reuseRatio 0 vs both prior eras. Six edges = three disjoint outgoing pairs.
  3: Object.freeze({
    era: 3,
    basis: 'shared-policy-evidence-384-511-4w-program-v3',
    bankShape: 'all-4-step-depth3',
    outgoingEdgeTypes: Object.freeze(['coreference_of', 'co_occurs_with']),
    incomingEdgeTypes: Object.freeze(['causes', 'derived_from', 'supports', 'supersedes']),
    // Per-family (suppress depth, flag, seedRole). The FLAG is validated against the
    // SEED ROLE (the credited axis) in assertEraSpec. Replaces the uniform global
    // BMU_FAMILY_SUPPRESS_STEPS / BMU_FAMILY_OFFPATH_SUPPRESS_STEPS for era-3.
    // Each family's REAL corpus structure places its trap/bridge at the depth-1
    // branch (temporal/conflict/near_collision: forbidden seed + depth-1 decoys;
    // multi_hop: required depth-1 bridge). So the credited-correct assignment is
    // depth-1 for all four, distinguished ONLY by seed role (forbidden→suppress,
    // required→offPathSuppress). This yields the 2 credited operation-classes the
    // scorer actually distinguishes (§17.29 confirmed; see §17.35). Depth-2 slots
    // exist in the 4-step bank but no current family has a depth-2-only trap.
    familyOperationPlan: Object.freeze({
      temporal: Object.freeze({ step: 1, flag: 'suppress', seedRole: 'forbidden' }),
      conflict_lifecycle: Object.freeze({ step: 1, flag: 'suppress', seedRole: 'forbidden' }),
      near_collision_abstention: Object.freeze({ step: 1, flag: 'suppress', seedRole: 'forbidden' }),
      multi_hop_relation: Object.freeze({ step: 1, flag: 'offPathSuppress', seedRole: 'required' }),
    }),
  }),
});

const ALL_EDGE_TYPE_SET = new Set(BMU_EXECUTABLE_EDGE_TYPES);
const FAMILY_CUE = Object.freeze({
  temporal: 'temporal',
  conflict_lifecycle: 'conflict lifecycle',
  multi_hop_relation: 'multi hop relation',
  near_collision_abstention: 'near collision abstention',
});

/** Validate one era spec against the §18 era invariants (fail-closed). */
export function assertEraSpec(spec) {
  if (!spec || !Number.isInteger(spec.era) || spec.era < 1) {
    throw new Error('bmu era spec: era must be a positive integer');
  }
  const out = spec.outgoingEdgeTypes ?? [];
  const inc = spec.incomingEdgeTypes ?? [];
  if (out.length !== 2 || inc.length !== 4) {
    throw new Error(`bmu era ${spec.era}: partition must be 2 outgoing × 4 incoming edges`);
  }
  for (const e of [...out, ...inc]) {
    if (!ALL_EDGE_TYPE_SET.has(e)) throw new Error(`bmu era ${spec.era}: unknown public edge type '${String(e)}'`);
  }
  const outSet = new Set(out);
  const incSet = new Set(inc);
  if (outSet.size !== 2 || incSet.size !== 4) throw new Error(`bmu era ${spec.era}: duplicate edge in partition`);
  for (const e of out) if (incSet.has(e)) throw new Error(`bmu era ${spec.era}: edge '${e}' in BOTH outgoing and incoming (symmetric-route hazard)`);
  const bankShape = spec.bankShape ?? 'mixed-3-4-step';
  if (bankShape === 'mixed-3-4-step') {
    // era-1/era-2: 32 three-step + 4 four-step, uniform per-family suppress plan.
    const chains = spec.fourStepIncomingChains ?? [];
    if (chains.length !== 2) throw new Error(`bmu era ${spec.era}: exactly 2 four-step incoming chains required`);
    for (const chain of chains) {
      if (!Array.isArray(chain) || chain.length !== 3) throw new Error(`bmu era ${spec.era}: each four-step chain has 3 incoming edges`);
      for (const e of chain) if (!incSet.has(e)) throw new Error(`bmu era ${spec.era}: four-step chain edge '${e}' not in incoming set`);
    }
    if (spec.familyOperationPlan !== undefined) throw new Error(`bmu era ${spec.era}: mixed-3-4-step eras use the global family suppress plan, not familyOperationPlan`);
  } else if (bankShape === 'all-4-step-depth3') {
    // era-3: all-4-step (depth-3); per-family (step, flag, seedRole). The CREDITED-
    // CORRECTNESS invariant (§17.35): the flag MUST match the seed role, because the
    // scorer credits set membership (required⊆topB ∧ forbidden∩topB=∅), and only a
    // matching flag makes the family's own operation achieve it —
    //   seedRole 'forbidden' ⟺ flag 'suppress'        (evict on-route forbidden seed lineage)
    //   seedRole 'required'  ⟺ flag 'offPathSuppress'  (spare on-route required seed/bridge)
    // (We intentionally DO NOT require distinct (step,flag) across families: under
    // the credited law the forbidden-seed families share one operation-class — that
    // is the honest finding, not a defect. See §17.35.)
    const plan = spec.familyOperationPlan;
    if (!plan) throw new Error(`bmu era ${spec.era}: all-4-step-depth3 requires familyOperationPlan`);
    const families = Object.keys(FAMILY_CUE);
    for (const family of families) {
      const p = plan[family];
      if (!p || (p.step !== 1 && p.step !== 2)) throw new Error(`bmu era ${spec.era}: family '${family}' plan step must be 1 or 2 (non-final on a 4-step program)`);
      if (p.flag !== 'suppress' && p.flag !== 'offPathSuppress') throw new Error(`bmu era ${spec.era}: family '${family}' plan flag must be suppress|offPathSuppress`);
      if (p.seedRole !== 'forbidden' && p.seedRole !== 'required') throw new Error(`bmu era ${spec.era}: family '${family}' plan seedRole must be forbidden|required`);
      if (p.seedRole === 'forbidden' && p.flag !== 'suppress') {
        throw new Error(`bmu era ${spec.era}: family '${family}' has a forbidden on-route seed but flag '${p.flag}' — a forbidden seed requires 'suppress' (offPathSuppress cannot evict on-route lineage ⇒ forbidden_admitted)`);
      }
      if (p.seedRole === 'required' && p.flag !== 'offPathSuppress') {
        throw new Error(`bmu era ${spec.era}: family '${family}' has a required on-route seed but flag '${p.flag}' — a required seed requires 'offPathSuppress' ('suppress' would evict the required lineage ⇒ missing_required)`);
      }
    }
    if (Object.keys(plan).some((f) => !FAMILY_CUE[f])) throw new Error(`bmu era ${spec.era}: familyOperationPlan has an unknown family`);
  } else {
    throw new Error(`bmu era ${spec.era}: unknown bankShape '${String(bankShape)}'`);
  }
  if (typeof spec.basis !== 'string' || spec.basis.length === 0) throw new Error(`bmu era ${spec.era}: basis string required`);
  return spec;
}

/** Resolve a validated era spec by id (defaults to the active era). */
export function eraSpec(era = BMU_EXECUTABLE_OPERATION_ERA) {
  const spec = BMU_EXECUTABLE_ERA_REGISTRY[era];
  if (!spec) throw new Error(`bmu era spec: era ${String(era)} not registered`);
  return assertEraSpec(spec);
}

// Cross-era disjointness self-check: no two registered eras share an outgoing
// edge (⇒ no shared program step-signature ⇒ transfer census reuseRatio 0
// across eras). Runs once at module load; a future era added with a colliding
// outgoing vocabulary fails the build.
(() => {
  const eras = Object.values(BMU_EXECUTABLE_ERA_REGISTRY).map(assertEraSpec);
  for (let i = 0; i < eras.length; i++) {
    for (let j = i + 1; j < eras.length; j++) {
      const a = new Set(eras[i].outgoingEdgeTypes);
      for (const e of eras[j].outgoingEdgeTypes) {
        if (a.has(e)) {
          throw new Error(`bmu era registry: eras ${eras[i].era} and ${eras[j].era} share outgoing edge '${e}' — cross-era class collision`);
        }
      }
    }
  }
})();

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

/**
 * §18.3 fix 2 — per-family suppression plan (which step indices carry the
 * suppress opcode). Suppression MUST be opcode-gated per-family because the
 * topology role of each depth differs by family:
 *
 *  - conflict_lifecycle: suppress the depth-1 branch step (index 1). The seed
 *    is the rejected candidate-base (forbidden lineage) and the depth-1
 *    step-produced nodes are the scope-mismatch decoys (forbidden); the golds
 *    are depth-2 terminals (promoted). Evicts the whole forbidden set with one
 *    program per cue (CPU-walker proven, round3 evidence).
 *  - temporal: suppress the depth-1 branch step (index 1). Seed = superseded
 *    stale base (forbidden lineage); depth-1 step-produced = recency/currency
 *    shortcut controls (forbidden); golds = current/change terminals (promoted).
 *    Required evidence sits ONLY at terminal depth, so no required doc is demoted.
 *  - multi_hop_relation: EMPTY (promote-only). The required chain intermediates
 *    live at depth 1, so a step-1 suppress would evict REQUIRED docs
 *    (missing_required). The off-path decoys are not query-similar enough to be
 *    Qwen-admitted, so a pure-promote program (byte-identical) is used and the
 *    real-Qwen margin run is the arbiter.
 *  - near_collision_abstention: suppress the depth-1 branch step (index 1),
 *    ROUND 4. The clean design lands a DISTINCT query-similar forbidden
 *    seed-trap doc (mirroring conflict's candidateId): the trap seeds the
 *    outgoing step (query-similar ⇒ stage-1 retrievable ⇒ BC1-safe), the depth-1
 *    suppress step evicts the collision competitors (alias/attribute/scope
 *    lookalike decoys, step-produced) AND the trap itself (suppressed lineage),
 *    while BOTH the exact-match record and the disambiguation record hang at
 *    terminal depth as PROMOTED answer terminals (disambiguation is
 *    simultaneously the lookalike answer and duplicate-discrim required, so it
 *    must be a promoted terminal). The 3 same-path decoys stay structurally
 *    indistinguishable (none seeds; all are depth-1 dead ends). Seeding from a
 *    NEUTRAL root starves the route (BC1) and seeding from a balanced decoy
 *    breaks decoy indistinguishability — the distinct seed-trap avoids both.
 *  - multi_hop_relation: EMPTY (promote-only). The required chain intermediates
 *    live at depth 1, so a step-1 suppress would evict REQUIRED docs
 *    (missing_required). Off-path decoys stay promote-only pending real-Qwen
 *    margin evidence of forbidden admission (round-4 decision: no margin
 *    evidence yet ⇒ keep byte-identical promote-only).
 */
export const BMU_FAMILY_SUPPRESS_STEPS = Object.freeze({
  temporal: Object.freeze([1]),
  conflict_lifecycle: Object.freeze([1]),
  multi_hop_relation: Object.freeze([]),
  near_collision_abstention: Object.freeze([1]),
});

/**
 * §18.4 — per-family OFF-PATH suppression plan (which non-final step indices
 * carry the 0x40 off-path-suppress opcode). Distinct from the 0x20 plan above:
 * a 0x40 step demotes ONLY the off-path dead-ends it produces and triggers NO
 * on-route seed/intermediate lineage demotion. This is the ONLY suppression
 * that is safe for multi_hop_relation, whose on-route hop-1 bridge (the seed)
 * and intermediate are REQUIRED evidence — the 0x20 on-route lineage demotion
 * would evict them (missing_required). The step-1 incoming branch produces both
 * the on-path chain relay (spared, continues to the answer terminal) and the
 * query-similar off-path co-occurrence / near-bridge decoys (demoted).
 * A family may use the 0x20 plan OR the 0x40 plan on a given step, never both.
 */
export const BMU_FAMILY_OFFPATH_SUPPRESS_STEPS = Object.freeze({
  temporal: Object.freeze([]),
  conflict_lifecycle: Object.freeze([]),
  multi_hop_relation: Object.freeze([1]),
  near_collision_abstention: Object.freeze([]),
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
export function assertDisjointPartitionProgram(program, era) {
  const steps = program?.steps;
  if (!Array.isArray(steps) || steps.length < 2 || steps.length > 4) {
    throw new Error('bmu mint lint: program must have 2..4 steps (one outgoing, then incoming chain)');
  }
  // Resolve the era to lint against. When an era is supplied, the program must
  // conform to THAT era's partition. When omitted, the era is INFERRED from the
  // leading outgoing edge — unambiguous because registered eras never share an
  // outgoing vocabulary (cross-era disjointness self-check above).
  let spec;
  if (era === undefined) {
    if (steps[0].direction !== 'outgoing') {
      throw new Error('bmu mint lint: step 0 must be outgoing');
    }
    const owner = Object.values(BMU_EXECUTABLE_ERA_REGISTRY)
      .find((s) => new Set(s.outgoingEdgeTypes).has(steps[0].edgeType));
    if (!owner) {
      throw new Error(`bmu mint lint: step 0 edge '${steps[0].edgeType}' belongs to no registered era's outgoing vocabulary`);
    }
    spec = assertEraSpec(owner);
  } else {
    spec = eraSpec(era);
  }
  const outSet = new Set(spec.outgoingEdgeTypes);
  const incSet = new Set(spec.incomingEdgeTypes);
  if (steps[0].direction !== 'outgoing' || !outSet.has(steps[0].edgeType)) {
    throw new Error(`bmu mint lint (era ${spec.era}): step 0 must be outgoing over {${spec.outgoingEdgeTypes.join(', ')}}`);
  }
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].direction !== 'incoming' || !incSet.has(steps[i].edgeType)) {
      throw new Error(`bmu mint lint (era ${spec.era}): step ${i} must be incoming over {${spec.incomingEdgeTypes.join(', ')}}`);
    }
  }
  return program;
}

/**
 * Infer which registered era a disjoint-partition program belongs to (by its
 * leading outgoing edge). Throws if the program is not a valid single-era
 * program. This is the canonical cross-era class-assignment used to prove a
 * program cannot belong to two eras at once.
 */
export function inferProgramEra(program) {
  const steps = program?.steps;
  if (!Array.isArray(steps) || steps.length < 1) throw new Error('inferProgramEra: program has no steps');
  const owner = Object.values(BMU_EXECUTABLE_ERA_REGISTRY)
    .find((s) => new Set(s.outgoingEdgeTypes).has(steps[0].edgeType));
  if (!owner) throw new Error(`inferProgramEra: leading edge '${steps[0]?.edgeType}' belongs to no registered era`);
  assertDisjointPartitionProgram(program, owner.era);
  return owner.era;
}

const FOUR_STEP_INCOMING_CHAINS = BMU_EXECUTABLE_ERA_REGISTRY[1].fourStepIncomingChains;

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
/**
 * Build the 36-class disjoint-partition deep-terminal program bank for one era.
 * Ordinal layout is identical across eras (32 three-step 2×4×4 + 4 four-step
 * 2×2), so `floor(sequence/2) mod 36` addresses the same slot index in every
 * era — only the edge vocabulary differs. Every entry passes the era-scoped
 * mint lint by construction.
 */
const ERA_BANK_CACHE = new Map();
export function programBankForEra(era = BMU_EXECUTABLE_OPERATION_ERA) {
  const cached = ERA_BANK_CACHE.get(era);
  if (cached) return cached;
  const spec = eraSpec(era);
  const out = spec.outgoingEdgeTypes;
  const inc = spec.incomingEdgeTypes;
  let bank;
  if ((spec.bankShape ?? 'mixed-3-4-step') === 'all-4-step-depth3') {
    // era-3: 36 DISTINCT four-step (depth-3) programs — 2 outgoing × the first 18
    // incoming triples of the 4³=64 space (canonical order), each a distinct
    // step-signature (within-family reuseRatio 0). Depth 3 gives two suppressable
    // non-final steps so the four families' distinct (depth,flag) operations
    // never collide (144/144 cross-family).
    const triples = [];
    for (const a of inc) for (const b of inc) for (const c of inc) triples.push([a, b, c]);
    const chosen = triples.slice(0, 18);
    bank = Object.freeze(out.flatMap((outgoingEdgeType, outerIndex) =>
      chosen.map((chain, chainIndex) => bankEntry(
        outerIndex * chosen.length + chainIndex,
        outgoingEdgeType,
        chain,
      ))).map((entry) => (assertDisjointPartitionProgram(entry, era), entry)));
  } else {
    bank = Object.freeze([
      ...out.flatMap((outgoingEdgeType, outerIndex) =>
        inc.flatMap((firstIncoming, firstIndex) =>
          inc.map((secondIncoming, secondIndex) => bankEntry(
            outerIndex * 16 + firstIndex * 4 + secondIndex,
            outgoingEdgeType,
            [firstIncoming, secondIncoming],
          )))),
      ...out.flatMap((outgoingEdgeType, outerIndex) =>
        spec.fourStepIncomingChains.map((chain, chainIndex) => bankEntry(
          32 + outerIndex * spec.fourStepIncomingChains.length + chainIndex,
          outgoingEdgeType,
          chain,
        ))),
    ].map((entry) => (assertDisjointPartitionProgram(entry, era), entry)));
  }
  ERA_BANK_CACHE.set(era, bank);
  return bank;
}

export const BMU_EXECUTABLE_PROGRAM_BANK = programBankForEra(1);

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
      ...(step.offPathSuppress === true ? { offPathSuppress: true } : {}),
    }))),
  });
}

export function executableOperationSignature({ operationCue, operationProgram, steps, branchLimit = BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT, operationClassBasis = BMU_EXECUTABLE_OPERATION_CLASS_BASIS }) {
  const canonicalCue = String(operationCue).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^[a-z0-9][a-z0-9 _-]*$/.test(String(operationCue)) || canonicalCue !== operationCue
      || operationCue.length < 4 || operationCue.length > 160) {
    throw new Error('operationCue must be canonical lowercase ASCII of length 4..160');
  }
  const program = canonicalBmuOperationProgram(operationProgram ?? { branchLimit, steps });
  const executableSignature = `${operationCue}=>b${program.branchLimit}/${program.steps
    .map((step) => `${step.direction}:${step.edgeType}${step.suppress === true ? ':suppress' : ''}${step.offPathSuppress === true ? ':offsuppress' : ''}`).join('/')}`;
  if (executableSignature.length > 256) throw new Error('executable operation signature exceeds 256 characters');
  return Object.freeze({
    operationCue,
    operationProgram: program,
    operationLaw: 'public_path_program_v1',
    operationClass: executableSignature,
    operationClassBasis,
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
  const spec = eraSpec(era);
  const bank = programBankForEra(era);
  const classOrdinal = Math.floor(operationSequence / 2) % bank.length;
  const plan = bank[classOrdinal];
  assertDisjointPartitionProgram(plan, era);
  // §18.3 fix 2 (era-1/2): overlay the GLOBAL uniform family suppression plan.
  // §17.32 (era-3): a per-era familyOperationPlan gives each family a DISTINCT
  // (suppress depth, flag) so the four families are genuinely different
  // operations (144/144 cross-family). A non-final suppress step must exist for
  // the flag to be signature-bearing; marking the final step is refused.
  let suppressSteps;
  let offPathSuppressSteps;
  if (spec.familyOperationPlan) {
    const fp = spec.familyOperationPlan[family];
    if (!fp) throw new Error(`bmu era ${era}: family '${family}' missing from familyOperationPlan`);
    suppressSteps = new Set(fp.flag === 'suppress' ? [fp.step] : []);
    offPathSuppressSteps = new Set(fp.flag === 'offPathSuppress' ? [fp.step] : []);
  } else {
    suppressSteps = new Set(BMU_FAMILY_SUPPRESS_STEPS[family] ?? []);
    offPathSuppressSteps = new Set(BMU_FAMILY_OFFPATH_SUPPRESS_STEPS[family] ?? []);
  }
  const lastIdx = plan.steps.length - 1;
  for (const idx of suppressSteps) {
    if (!Number.isInteger(idx) || idx < 1 || idx >= lastIdx) {
      throw new Error(`bmu suppress plan: family '${family}' suppress step ${idx} must be a non-final step in 1..${lastIdx - 1}`);
    }
  }
  for (const idx of offPathSuppressSteps) {
    if (!Number.isInteger(idx) || idx < 1 || idx >= lastIdx) {
      throw new Error(`bmu off-path suppress plan: family '${family}' step ${idx} must be a non-final step in 1..${lastIdx - 1}`);
    }
    if (suppressSteps.has(idx)) {
      throw new Error(`bmu suppress plan: family '${family}' step ${idx} cannot be both suppress (0x20) and offPathSuppress (0x40)`);
    }
  }
  const suppressedSteps = plan.steps.map((step, idx) => (
    suppressSteps.has(idx) ? { direction: step.direction, edgeType: step.edgeType, suppress: true }
      : offPathSuppressSteps.has(idx) ? { direction: step.direction, edgeType: step.edgeType, offPathSuppress: true }
        : { direction: step.direction, edgeType: step.edgeType }
  ));
  const operationCue = `${familyCue} era ${era} route ${suppressedSteps
    .map((step) => `${step.edgeType}${step.suppress === true ? ' guarded' : ''}${step.offPathSuppress === true ? ' scoped' : ''}`).join(' then ')}`;
  return Object.freeze({
    ...plan,
    classOrdinal,
    era,
    ...executableOperationSignature({
      operationCue,
      operationProgram: { branchLimit: plan.branchLimit, steps: suppressedSteps },
      operationClassBasis: spec.basis,
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
export function buildProgramPathTopology({ program, seedId, sinkIds, goldIds, decoyIds, midIdFor, decoyDepth = 1 }) {
  assertDisjointPartitionProgram(program);
  const steps = program.steps;
  const depth = steps.length - 1;
  if (depth < 2) {
    throw new Error('buildProgramPathTopology: deep-terminal law requires >=3 steps (decoys must sit strictly above terminal depth)');
  }
  // §17.32 (era-3): the family's forbidden trap may sit at a DEEPER branch level
  // than depth 1 so a suppress@d / offPathSuppress@d operation evicts a depth-d
  // trap. decoyDepth must be a NON-FINAL branch level in 1..depth-1 (a depth-`depth`
  // node would be an answer terminal, not a dead-end decoy). Default 1 keeps the
  // era-1/2 topology byte-identical.
  if (!Number.isInteger(decoyDepth) || decoyDepth < 1 || decoyDepth >= depth) {
    throw new Error(`buildProgramPathTopology: decoyDepth ${decoyDepth} must be a non-final branch level in 1..${depth - 1}`);
  }
  const branchLimit = program.branchLimit ?? BMU_EXECUTABLE_PROGRAM_BRANCH_LIMIT;
  if (!Array.isArray(sinkIds) || sinkIds.length < 1) throw new Error('buildProgramPathTopology: at least one sink id required');
  if (!Array.isArray(goldIds) || goldIds.length < 1) throw new Error('buildProgramPathTopology: at least one gold terminal id required');
  if (goldIds.length > branchLimit) {
    throw new Error(`buildProgramPathTopology: ${goldIds.length} gold terminals exceed branchLimit ${branchLimit}`);
  }
  const decoys = decoyIds ?? [];
  if (1 + decoys.length > branchLimit) {
    throw new Error(`buildProgramPathTopology: chain head + ${decoys.length} decoys exceed branchLimit ${branchLimit} at depth ${decoyDepth}`);
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
  if (decoyDepth === 1) {
    // ── DEPTH-1 decoys: the era-1/2 topology, byte-identical (emission order and
    // relations unchanged from the original builder). ──
    const depthOneBranchIds = [midIds[0], ...decoys];
    for (const src of depthOneBranchIds) {
      relations.push({ src, dst: primarySinkId, type: steps[1].edgeType, label: 'public_path_branch' });
    }
    for (let level = 2; level < depth; level++) {
      relations.push({ src: midIds[level - 1], dst: midIds[level - 2], type: steps[level].edgeType, label: 'public_path_chain' });
    }
  } else {
    // ── DEEPER decoys (§17.32, era-3): the on-route chain is emitted intact, then
    // the decoys are dead-end branches produced by step[decoyDepth], balanced
    // beside the chain relay at that level (no incoming continuation ⇒ never a
    // routed terminal, but demoted by a suppress@decoyDepth / offPath@decoyDepth). ──
    const parentAtLevel = (level) => (level === 1 ? primarySinkId : midIds[level - 2]);
    for (let level = 1; level < depth; level++) {
      relations.push({ src: midIds[level - 1], dst: parentAtLevel(level), type: steps[level].edgeType, label: level === 1 ? 'public_path_branch' : 'public_path_chain' });
    }
    for (const decoy of decoys) {
      relations.push({ src: decoy, dst: parentAtLevel(decoyDepth), type: steps[decoyDepth].edgeType, label: 'public_path_branch' });
    }
  }
  for (const goldId of goldIds) {
    relations.push({ src: goldId, dst: midIds[depth - 2], type: steps[depth].edgeType, label: 'public_path_terminal' });
  }
  return Object.freeze({ relations, midIds, terminalDepth: depth, terminalIds: [...goldIds], decoyDepth });
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
  // §18.4: nodes produced by a NON-final OFF-PATH suppress step (0x40). The
  // on-route ones are subtracted after the walk so only off-path dead-ends are
  // demoted; the on-route required seed/intermediates are spared.
  const offPathStepProducedIds = new Set();
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
    if (step.offPathSuppress === true && !isFinalStep) {
      for (const producedId of next.keys()) offPathStepProducedIds.add(producedId);
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
  const programHasOffPathSuppress = canonical.steps.some((s) => s.offPathSuppress === true);
  const terminalsSuppressed = canonical.steps[canonical.steps.length - 1]?.suppress === true;
  const suppressLineageIds = new Set(suppressStepProducedIds);
  if (programHasSuppress) {
    for (const route of frontier.values()) {
      for (let i = 0; i < route.length - 1; i++) suppressLineageIds.add(route[i]);
    }
  }
  // §18.4: off-path suppression demotes produced nodes NOT on any terminal route
  // (the on-route required seed/intermediates are spared — no lineage demotion).
  const onRouteIds = new Set();
  for (const route of frontier.values()) for (const id of route) onRouteIds.add(id);
  const offPathSuppressedIds = new Set();
  for (const id of offPathStepProducedIds) if (!onRouteIds.has(id)) offPathSuppressedIds.add(id);
  const terminalIds = [...frontier.keys()];
  const terminalIdSet = new Set(terminalIds);
  // §18.5 PATH-INCLUSIVE PROMOTION parity with retrieval-benchmark.ts
  // (promotePathNodeDocIds): every NON-TERMINAL, NON-SEED on-path intermediate of
  // an executed route that is NOT in any suppress set is promoted (+1·UNIT,
  // routed). Empty for a pure suppress program (its lineage is suppressed) and
  // for ZERO_STATE (no routes), so the three suppress families are byte-identical.
  const promotePathNodeIds = new Set();
  for (const route of frontier.values()) {
    for (let i = 1; i < route.length - 1; i++) {
      const id = route[i];
      if (terminalIdSet.has(id)) continue;
      if (suppressLineageIds.has(id)) continue;
      if (offPathSuppressedIds.has(id)) continue;
      promotePathNodeIds.add(id);
    }
  }
  return Object.freeze({
    terminalIds,
    routes: new Map([...frontier].map(([id, route]) => [id, Object.freeze([...route])])),
    /** Terminals promoted (+1·UNIT). Empty when the final step is suppress-marked. */
    promoteTerminalIds: Object.freeze(terminalsSuppressed ? [] : [...terminalIds]),
    /** §18.5: on-path bridge intermediates promoted (+1·UNIT, routed). */
    promotePathNodeIds: Object.freeze([...promotePathNodeIds]),
    /** Terminals demoted (−1·UNIT) because the final step is suppress-marked. */
    suppressTerminalIds: Object.freeze(terminalsSuppressed ? [...terminalIds] : []),
    /** Seed/intermediate lineage demoted (−1·UNIT) — never an answer terminal. */
    suppressLineageIds: Object.freeze([...suppressLineageIds]),
    /** Off-path dead-ends demoted (−1·UNIT) by a 0x40 step — never an on-route node. */
    offPathSuppressedIds: Object.freeze([...offPathSuppressedIds]),
    programHasSuppress,
    programHasOffPathSuppress,
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
