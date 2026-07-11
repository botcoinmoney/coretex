/**
 * BMU P2 offline generator — family `near_collision_abstention` (BMU_SPEC.md
 * rev3.2, commit ad7e523: §5.4 family law, §5.5 abstention signal, §4.1 task
 * schema + GLOBAL m=1, §4.2 B=3, §6.7b E_f_min=80, template mint-partition law).
 *
 * CLUSTER SHAPE (one DISCRIMINATION memory structure per cluster — the
 * typed-cluster anti-coverage-indexing law, buildTypedTemporalClusterSpec
 * ancestry, evolve-corpus.mjs:114-188, transposed to near-collision):
 *   E   exact-match doc: subject S (canonical name C, primary role R) holds
 *       attribute A for scope σ with value V — the §5.4 "right entity/
 *       attribute variant" that must stay retrievable at small B;
 *   Na  alias-collision decoy: a DIFFERENT entity with the
 *       SAME canonical name C, claiming the same role in text, asserting a
 *       different value V1 for A/σ — phrased to ECHO the question skeleton
 *       and to claim currency ("remains the standing …"), so it out-ranks
 *       honestly (§2.2; the stale-trap vocabulary pattern of
 *       evolve-corpus.mjs:120-123 transposed to duplicate-name collision —
 *       the ancestor's `entity_resolution_atom` duplicate-name wrong doc,
 *       evolve-corpus.mjs:632-655, is the direct parent of this decoy);
 *   Nt  attribute-lookalike decoy: same subject name, a NEAR-VARIANT
 *       attribute (non-rotation qualifier over the same base) with value V2;
 *   Ns  scope-lookalike decoy: same name/attr/role, DIFFERENT scope σ_d with
 *       value V3 — a true record that answers the wrong variant;
 *   D   disambiguation record: documents which filing is standing and that
 *       the duplicate belongs to a distinct holder (the memory-structure
 *       payload a discriminating substrate can anchor).
 * Escalation adds complete three-decoy incoming groups (alias/scope/
 * attribute coverage first, then alternating alias/attribute controls) —
 * the near-collision analog of the ancestor's escalation shadows
 * (evolve-corpus.mjs:199-215), rounded so every public-path group is full.
 *
 * FIVE eval_hidden rows per cluster (k=5) across FOUR DISTINCT question
 * types; the §5.4 answerable/abstain mix is 4:1 per cluster (~80% answerable,
 * matching the §2.2 false-abstain-counterweight arithmetic — a blanket-
 * abstain substrate zeroes 4 of every 5 rows of THIS family too):
 *   exact_variant_lookup (v0 + v1)      answerable  R=[E]      answer=E
 *   duplicate_discrimination            answerable  R=[E,D]    answer=E
 *   lookalike_status_verification       answerable  R=[D,E]    answer=D
 *   missing_variant_abstain             abstain     R=[]       no answer
 * The abstain row asks about a scope (σ_absent) for which NO record exists in
 * the cluster (reserved at mint: σ_absent ∉ {σ, σ_d}), so it is genuinely
 * unanswerable; its forbidden set is [E, ...decoys] — under §5.4 the
 * answerable sibling E IS a plausible decoy for the absent variant, and
 * u(t)=1 requires zero forbidden admitted AND the §5.5 policy-atom
 * MISSING_EVIDENCE signal to fire.
 * Forbidden (answerable rows) = a class-rotated primary axis followed by the
 * remaining [Na, Nt, Ns, ...extras] sibling decoy set — the
 * set itself (§5.4). Label knowledge earns nothing: evicting near-collisions
 * at B=3 with required+forbidden > B demands the discrimination operation,
 * not anchoring (§2.2, §6.5 part 1).
 *
 * TEMPLATE LAW (§4.1 M7), same design decision as the sibling conflict lane:
 * templateId = question SKELETON with the (attribute, scope) pair BAKED IN —
 * attr is window-unique per cluster (common.mjs DELTA 1 rotation), so
 * same-family same-epoch clusters carry DISJOINT templateId sets, and two
 * rows share a templateId iff they render the same surface form. The abstain
 * row's template bakes σ_absent (the scope actually in its surface form).
 *
 * NAMED DELTAS from the ancestors (I10), beyond the ones in common.mjs:
 *   - the ancestor `entity_resolution_atom` minted ONE row per structure;
 *     BMU's k=5 typed-cluster law renders the same duplicate-name collision
 *     as four question types + an abstain variant over one structure;
 *   - the ancestor `abstention_missing` branch (evolve-corpus.mjs:473-485)
 *     asked about out-of-corpus trivia with NO planted decoys; under §5.4 the
 *     abstain row must instead sit INSIDE the collision neighborhood
 *     (forbidden = the sibling docs) — abstention with nothing to resist
 *     admitting would be free utility for blank substrates;
 *   - duplicate-entity ids are SYNTHETIC per-cluster ids (`e_<idBase>_dupK`),
 *     never bank subjects — the collision partner is part of the minted
 *     structure, so it can never hold rows in another active cluster and the
 *     GLOBAL m=1 census stays subject-clean by construction;
 *   - disambiguation-support qrels are 0.6 where D is required (§4.3 pins
 *     requiredEvidence ⊆ {qrels ≥ 0.5}; GradedRelevance grid has no 0.5) and
 *     0.4 where D is merely supportive (the ancestor's bridge grade);
 *   - every row is stamped with a full §4.1 bmuTask; abstain rows carry
 *     abstain:true, requiredEvidence:[], NO answer key, and the logical row
 *     carries abstain:true so the production-corpus builder takes its
 *     truthless branch (build-v2-production-corpus.mjs `if (q.abstain)`).
 *
 * FAMILY NAMESPACES (§5.6): bmuTask.family = 'near_collision_abstention';
 * logical row family = 'entity_resolution_atom' (answerable) or
 * 'abstention_missing' (abstain) — both bucket to `near_collision` under the
 * canonical bucketing (build-v2-production-corpus.mjs `bucket()` default arm)
 * and both appear in the §5.6 table's logicalFamily column for this family.
 *
 * PURE: deterministic from (epoch, seed, subject bank order, registry state,
 * injected splitOf). No Date, no Math.random, no dist imports.
 */
import {
  BMU_CLUSTER_SIZE_K,
  BMU_DEFAULT_BUDGET_B,
  bmuAttributeForClusterSlot,
  evalHiddenQueryId,
  lintNoAnswerLeak,
  prng,
  slug,
  opaqueBmuDocId,
  bmuEntityHoldoutKeysForSubject,
} from './common.mjs';
import {
  BMU_EXECUTABLE_OPERATION_ERA,
  BMU_EXECUTABLE_PROGRAM_BANK,
  buildProgramPathTopology,
  executableOperationForFamilySlot,
  programBankForEra,
  stampExecutableOperationTask,
} from './operation-program.mjs';

export const NEARCOL_FAMILY = 'near_collision_abstention';
export const NEARCOL_BUDGET_B = BMU_DEFAULT_BUDGET_B.near_collision_abstention; // 3
export const NEARCOL_ROTATION_BASE_EPOCH = 137; // first BMU mint epoch (pre-flip inert stamping era)
export const NEARCOL_LOGICAL_FAMILY_ANSWERABLE = 'entity_resolution_atom'; // §5.6 → bucketed near_collision
export const NEARCOL_LOGICAL_FAMILY_ABSTAIN = 'abstention_missing';        // §5.6 → bucketed near_collision
export const NEARCOL_OPERATION_FAMILY = 'outgoing_incoming_shared_sink';
const NEARCOL_SEMANTIC_PROFILES = Object.freeze([
  Object.freeze({ key: 'duplicate_holder', primaryKind: 'alias' }),
  Object.freeze({ key: 'variant_scope', primaryKind: 'scope' }),
  Object.freeze({ key: 'variant_attribute', primaryKind: 'attribute' }),
]);
/** Exactly 36 executable programs per era. Collision semantics rotate separately. */
const NEARCOL_ERA_CLASS_CACHE = new Map();
export function nearcolOperationClassesForEra(era = BMU_EXECUTABLE_OPERATION_ERA) {
  const cached = NEARCOL_ERA_CLASS_CACHE.get(era);
  if (cached) return cached;
  const classes = Object.freeze(programBankForEra(era).map((program, ordinal) => {
    const semantic = NEARCOL_SEMANTIC_PROFILES[ordinal % NEARCOL_SEMANTIC_PROFILES.length];
    const operation = executableOperationForFamilySlot(NEARCOL_FAMILY, ordinal * 2, { era });
    return Object.freeze({
      name: operation.operationClass,
      semantic: semantic.key,
      primaryKind: semantic.primaryKind,
      outgoingEdgeType: program.outgoingEdgeType,
      incomingEdgeType: program.incomingEdgeType,
      topology: 'single_sink',
      sinkMultiplicity: 1,
      operation,
    });
  }));
  NEARCOL_ERA_CLASS_CACHE.set(era, classes);
  return classes;
}
export const NEARCOL_OPERATION_CLASSES = nearcolOperationClassesForEra(1);

export function nearcolOperationClassForSlot(operationClassSlot, era = BMU_EXECUTABLE_OPERATION_ERA) {
  if (!Number.isInteger(operationClassSlot) || operationClassSlot < 0) {
    throw new Error('nearcolOperationClassForSlot: non-negative integer slot required');
  }
  const classes = nearcolOperationClassesForEra(era);
  return classes[Math.floor(operationClassSlot / 2) % classes.length];
}

/** §5.4 question types — four DISTINCT types, five rows (exact_variant_lookup ×2 variants). */
export const NEARCOL_QUESTION_TYPES = Object.freeze([
  'exact_variant_lookup',
  'duplicate_discrimination',
  'lookalike_status_verification',
  'missing_variant_abstain',
]);

// Family-namespaced rotation grid (common.mjs DELTA 2) — qualifier space
// disjoint from the temporal rotation's (evolve-corpus.mjs:55-58: commute,
// billing, …) and the conflict lane's (rollout, oncall, …), so near-collision
// never burns another family's one-shot attribute headroom.
const NEARCOL_QUALIFIERS = Object.freeze([
  'intake', 'outbound', 'customs', 'berthing', 'quayside', 'mooring',
  'bonded', 'crane', 'tally', 'pilotage', 'stowage', 'demurrage',
]);
// Value banks: single-token hyphenated handles, token-disjoint from every
// qualifier/base/scope/role token so the answer-value leak lint never
// false-positives on shared vocabulary (sibling-lane convention).
const CHANNELS = Object.freeze(['relay-kilo', 'relay-nova', 'relay-orion', 'relay-vega', 'relay-lyra', 'relay-polar', 'relay-sable', 'relay-quill']);
const CALLSIGNS = Object.freeze(['kestrel-nine', 'osprey-four', 'plover-six', 'gannet-two', 'skua-eight', 'petrel-five', 'avocet-three', 'curlew-seven']);
const LOCKERS = Object.freeze(['bin-north', 'bin-south', 'bin-east', 'bin-west', 'bin-upper', 'bin-lower', 'bin-mid', 'bin-annex']);
const NEARCOL_BASES = Object.freeze([
  ['channel', CHANNELS],
  ['callsign', CALLSIGNS],
  ['locker', LOCKERS],
]);
// Attribute-LOOKALIKE qualifiers: deliberately OUTSIDE the rotation grid so a
// lookalike attribute string can never equal another cluster's rotation
// attribute (no cross-cluster lexical pollution of the m=1/template space).
const LOOKALIKE_QUALIFIERS = Object.freeze(['provisional', 'tentative', 'unratified', 'preliminary']);
const ROLES_PRIMARY = Object.freeze(['manifest steward', 'gangway steward', 'holdings steward', 'victualing steward', 'chandlery steward', 'ballast steward', 'draught steward', 'bunkering steward']);
const ROLES_DECOY = Object.freeze(['visiting clerk', 'seasonal clerk', 'regional clerk', 'itinerant clerk', 'probationary clerk']);
const SCOPES_PERSON = Object.freeze(['morning desk', 'evening desk', 'overnight desk', 'relief desk', 'holiday desk', 'offsite desk']);
const SCOPES_PROJECT = Object.freeze(['ingest-line', 'replay-line', 'export-line', 'mirror-line', 'sandbox-line', 'fallback-line']);

/**
 * Deterministic decoy count: near-collision floor of 3 (alias + attribute +
 * scope lookalike — the §5.4 "sibling decoy set" needs all three collision
 * axes), plus escalation rounded up to complete three-decoy incoming groups.
 */
export function nearcolDecoyCount(escalationLevel) {
  const raw = 3 + Math.max(0, Math.min(4, escalationLevel | 0));
  return Math.ceil(raw / 3) * 3;
}

export function nearcolTemplateId(questionType, variant, attr, scope) {
  return `tt_nearcol_${questionType}_v${variant}__${slug(attr)}__${slug(scope)}`;
}

/**
 * Pure single-cluster spec: docs / relations / query stubs (with bmuTask) for
 * ONE near-collision discrimination structure. The analog of
 * `buildTypedTemporalClusterSpec` (evolve-corpus.mjs:114-188); shared by the
 * generator, the unit tests, and the sample-emission harness so what is
 * certified offline is byte-for-byte what production will mint.
 *
 * decoys: ordered array of { kind: 'alias'|'attribute'|'scope', id, value,
 * role? (alias), lookalikeAttr? (attribute), scope? (scope) }; decoys[0] MUST
 * be the alias-collision primary trap.
 */
export function buildNearCollisionClusterSpec({
  canonical, subjectId, attr, scope, absentScope, role, value,
  decoys, tsDate, exactId, disambigId, motifGroupId, subjectAliases = [],
  operationClass = NEARCOL_OPERATION_CLASSES[0].name,
  collisionSeedTrapId, trapValue,
}) {
  if (!Array.isArray(decoys) || decoys.length < 3) {
    throw new Error('buildNearCollisionClusterSpec: >=3 sibling decoys required (alias + attribute + scope collision axes)');
  }
  const operationPlan = Object.values(NEARCOL_OPERATION_CLASSES).find((plan) => plan.name === operationClass);
  if (!operationPlan) throw new Error(`buildNearCollisionClusterSpec: unknown operationClass '${operationClass}'`);
  if (decoys[0].kind !== operationPlan.primaryKind) {
    throw new Error(`buildNearCollisionClusterSpec: decoys[0] must be the ${operationPlan.primaryKind}-collision primary trap for ${operationClass}`);
  }
  if (decoys.some((d) => d.value === value)) throw new Error('buildNearCollisionClusterSpec: decoy values must differ from the exact-match value');
  if (absentScope === scope || decoys.some((d) => d.kind === 'scope' && d.scope === absentScope)) {
    throw new Error('buildNearCollisionClusterSpec: absentScope must be covered by NO doc (neither the exact scope nor any scope-lookalike)');
  }
  // ROUND 4: the distinct query-similar forbidden seed-trap (mirrors conflict's
  // candidateId). It carries the exact-question vocabulary AND claims currency
  // with a WRONG value so it is a strong stage-1 seed (BC1-safe) yet forbidden;
  // the depth-1 suppress step evicts it (as suppressed lineage) along with the
  // collision decoys, while the exact-match and disambiguation records hang at
  // terminal depth as promoted answers. Its value differs from the exact value
  // and every decoy value (never gold-only; never the answer).
  if (collisionSeedTrapId === undefined || collisionSeedTrapId === null) {
    throw new Error('buildNearCollisionClusterSpec: collisionSeedTrapId required (round-4 seed-trap suppression)');
  }
  if (trapValue === undefined || trapValue === value || decoys.some((d) => d.value === trapValue)) {
    throw new Error('buildNearCollisionClusterSpec: trapValue must differ from the exact value and every decoy value');
  }
  const primaryTrap = decoys[0];

  const docs = [
    { id: collisionSeedTrapId, kind: `nearcol_${slug(attr)}`, role: 'collision_seed_trap',
      text: `What ${attr} did ${canonical} the ${role} set for the ${scope}? The ${attr} ${canonical} the ${role} set for the ${scope} is ${trapValue}, per the standing intake note, and current filings should keep applying ${trapValue}.`,
      timestamp: tsDate, currentStaleFlag: true, subjectKey: subjectId,
      collisionRole: 'collision_seed_trap', collisionScope: scope, roleAliases: [role] },
    { id: exactId, kind: `nearcol_${slug(attr)}`, role: 'exact_match',
      text: `${canonical} serving as ${role} set the ${attr} for the ${scope} to ${value} in the registry workspace filing.`,
      timestamp: tsDate, currentStaleFlag: true, subjectKey: subjectId,
      collisionRole: 'exact_match', collisionScope: scope, roleAliases: [role] },
    ...decoys.map((d, i) => {
      if (d.kind === 'alias') {
        // Duplicate-name collision claiming the exact question vocabulary AND
        // currency — the trap must out-rank honestly (§2.2).
        return { id: d.id, kind: `nearcol_${slug(attr)}`, role: 'alias_collision_decoy',
          text: `What ${attr} did ${canonical} the ${role} set for the ${scope}? The overlapping ${attr} ${canonical} set for the ${scope} was noted as ${d.value} in the duplicate ledger filings under the name ${canonical}, and ${d.value} remains the standing ${attr} for the ${scope}.`,
          timestamp: tsDate, currentStaleFlag: true, subjectKey: d.entityId,
          collisionRole: 'alias_collision_decoy', collisionScope: scope, roleAliases: [d.role, role] };
      }
      if (d.kind === 'attribute') {
        return { id: d.id, kind: `nearcol_${slug(d.lookalikeAttr)}`, role: 'attribute_lookalike_decoy',
          text: `What ${attr} did ${canonical} the ${role} set for the ${scope}? This overlapping filing does not record the ${attr}; it records the ${d.lookalikeAttr} as ${d.value} and is kept beside the standing entries.`,
          timestamp: tsDate, currentStaleFlag: true, subjectKey: subjectId,
          collisionRole: 'attribute_lookalike_decoy', collisionScope: scope, roleAliases: [role] };
      }
      if (d.kind === 'scope') {
        return { id: d.id, kind: `nearcol_${slug(attr)}`, role: 'scope_lookalike_decoy',
          text: `What ${attr} did ${canonical} the ${role} set for the ${scope}? This overlapping filing explicitly does not cover the ${scope}; it covers the ${d.scope}, where ${d.value} remains the standing ${attr}.`,
          timestamp: tsDate, currentStaleFlag: true, subjectKey: subjectId,
          collisionRole: 'scope_lookalike_decoy', collisionScope: d.scope, roleAliases: [role] };
      }
      throw new Error(`buildNearCollisionClusterSpec: unknown decoy kind '${d.kind}' at index ${i}`);
    }),
    { id: disambigId, kind: `nearcol_${slug(attr)}_disambiguation`, role: 'disambiguation_record',
      text: operationPlan.primaryKind === 'alias'
        ? `Registry review ${tsDate}: overlapping ${attr} filings under the name ${canonical} were compared — the ${role} filing covering the ${scope} is standing, while the duplicate holder and lookalike measure are separate records.`
        : `Registry review ${tsDate}: overlapping ${attr} scope variants for ${canonical} were compared — the ${role} filing covering the ${scope} is standing, while the neighboring scope and lookalike measure are separate records.`,
      timestamp: tsDate, currentStaleFlag: true, subjectKey: subjectId,
      collisionRole: 'disambiguation_record', collisionScope: scope, roleAliases: [role] },
  ];

  // Public-path relations are overlaid by the epoch generator after it has
  // opaque ids for every sink/control branch. Keeping this semantic
  // constructor relation-free prevents legacy role labels from becoming a
  // structural answer oracle.
  const relations = [];

  const decoyIds = decoys.map((d) => d.id);
  const categoryFor = { alias: 'duplicate_name_alias_collision', attribute: 'attribute_lookalike_near_collision', scope: 'wrong_scope_near_collision' };
  const trapQrel = { docId: collisionSeedTrapId, relevance: 0.0, role: 'collision_seed_trap' };
  const trapNeg = { docId: collisionSeedTrapId, category: 'collision_seed_trap_exact_terms' };
  const decoyQrels = [trapQrel, ...decoys.map((d) => ({ docId: d.id, relevance: 0.0, role: `${d.kind}_lookalike` }))];
  const decoyNegs = [trapNeg, ...decoys.map((d) => ({ docId: d.id, category: categoryFor[d.kind] }))];
  // Round 4: the seed-trap leads the veto set (forbiddenEvidence[0]) so the
  // no-answer-leak lint treats it as the primary trap it must out-rank.
  const forbiddenAnswerable = [collisionSeedTrapId, ...decoyIds];
  // §5.4: the answerable sibling stays a plausible decoy for the absent
  // variant, but it is the cluster's ROUTED TERMINAL under the shared
  // cue/program — a forbidden routed terminal makes the abstain row
  // unsolvable by construction for exactly the state the law rewards
  // (fix-2b hard contract). It therefore stays a hardNegative (below) and
  // out of the veto set; the abstain law still binds via the required
  // abstainSignal and the decoy veto.
  const forbiddenAbstain = [collisionSeedTrapId, ...decoyIds];

  const entityHoldoutKeys = bmuEntityHoldoutKeysForSubject({ id: subjectId, canonicalName: canonical, aliases: subjectAliases });
  const stampTask = ({ requiredEvidence, answerId, answerValue, abstain, questionType, variant, templateScope }) => stampExecutableOperationTask({
    family: NEARCOL_FAMILY,
    budgetB: NEARCOL_BUDGET_B,
    requiredEvidence,
    forbiddenEvidence: abstain ? forbiddenAbstain : forbiddenAnswerable,
    ...(abstain ? {} : { answer: { id: answerId, value: answerValue } }),
    abstain,
    motifGroupId,
    templateId: nearcolTemplateId(questionType, variant, attr, templateScope ?? scope),
    entityHoldoutKeys,
  }, operationPlan.operation);

  const hardNegatives = decoyNegs;
  const abstainHardNegatives = [{ docId: exactId, category: 'answerable_sibling_near_collision' }, ...decoyNegs];

  const queryStubs = [
    { questionType: 'exact_variant_lookup', variant: 0, abstain: false,
      queryText: `What ${attr} did ${canonical} the ${role} set for the ${scope}?`,
      qrels: [{ docId: exactId, relevance: 1.0, role: 'direct' }, { docId: disambigId, relevance: 0.4, role: 'disambiguation_support' }, ...decoyQrels],
      hardNegatives,
      bmuTask: stampTask({ requiredEvidence: [exactId], answerId: exactId, answerValue: value, abstain: false, questionType: 'exact_variant_lookup', variant: 0 }) },
    { questionType: 'exact_variant_lookup', variant: 1, abstain: false,
      queryText: `Which ${attr} is on record for ${canonical} the ${role} covering the ${scope}?`,
      qrels: [{ docId: exactId, relevance: 1.0, role: 'direct' }, { docId: disambigId, relevance: 0.4, role: 'disambiguation_support' }, ...decoyQrels],
      hardNegatives,
      bmuTask: stampTask({ requiredEvidence: [exactId], answerId: exactId, answerValue: value, abstain: false, questionType: 'exact_variant_lookup', variant: 1 }) },
    { questionType: 'duplicate_discrimination', variant: 0, abstain: false,
      // Vocabulary discipline: 'duplicate', 'filings', 'under', 'name' all
      // appear in the primary trap; 'among'/'covers' appear in NO required
      // doc (D says 'covering') — nothing here is gold-only.
      queryText: operationPlan.primaryKind === 'alias'
        ? `Among the overlapping ${attr} filings under the name ${canonical}, which entry covers the ${scope}?`
        : `Among ${canonical}'s overlapping ${attr} filings, which entry covers the ${scope}?`,
      qrels: [{ docId: exactId, relevance: 1.0, role: 'direct' }, { docId: disambigId, relevance: 0.6, role: 'disambiguation_bridge' }, ...decoyQrels],
      hardNegatives,
      bmuTask: stampTask({ requiredEvidence: [exactId, disambigId], answerId: exactId, answerValue: value, abstain: false, questionType: 'duplicate_discrimination', variant: 0 }) },
    { questionType: 'lookalike_status_verification', variant: 0, abstain: false,
      // Names the TRAP's own value (mirrored verbatim in the trap doc, hence
      // never gold-only and never the answer — the conflict lane's
      // candidate_status_verification pattern).
      queryText: `Is ${primaryTrap.value} still the standing ${attr} for ${canonical}'s ${scope}?`,
      qrels: [{ docId: disambigId, relevance: 1.0, role: 'direct' }, { docId: exactId, relevance: 0.6, role: 'exact_support' }, ...decoyQrels],
      hardNegatives,
      bmuTask: stampTask({ requiredEvidence: [disambigId, exactId], answerId: disambigId, answerValue: `no — ${primaryTrap.value} belongs to a competing near-collision filing, not ${canonical}'s standing ${attr}`, abstain: false, questionType: 'lookalike_status_verification', variant: 0 }) },
    { questionType: 'missing_variant_abstain', variant: 0, abstain: true,
      queryText: `For ${canonical}'s ${absentScope}, which ${attr} is on record?`,
      qrels: [], // genuinely unanswerable — abstain is the correct behavior (§5.4/§5.5)
      hardNegatives: abstainHardNegatives,
      bmuTask: stampTask({ requiredEvidence: [], abstain: true, questionType: 'missing_variant_abstain', variant: 0, templateScope: absentScope }) },
  ];
  if (queryStubs.length !== BMU_CLUSTER_SIZE_K) throw new Error('near-collision cluster must carry exactly k=5 rows');

  return { docs, relations, queryStubs, forbiddenAnswerable, forbiddenAbstain, collisionSeedTrapId };
}

/**
 * Multi-cluster epoch generator. Deterministic from
 * (epoch, seed, subjects order, registry state, splitOf).
 *
 * @param {{
 *   epoch: number, seed: string,
 *   subjects: readonly { id: string, canonicalName: string }[],
 *   registry: ReturnType<import('./common.mjs').createM1Registry>,
 *   splitOf: (logicalQueryId: string, liveUpdateEpoch?: number) => string,
 *   clusterCount?: number, escalationLevel?: number,
 *   clusterSlotOffset?: number, ownerEntityId?: string,
 *   rotationBaseEpoch?: number,
 *   operationClassSlotOffset?: number,
 * }} args
 */
export function generateNearCollisionAbstentionClusters({
  epoch, seed, docIdKeyHex, subjects, registry, splitOf,
  clusterCount = 2, escalationLevel = 0, clusterSlotOffset = 0,
  ownerEntityId = 'e_universe', rotationBaseEpoch = NEARCOL_ROTATION_BASE_EPOCH,
  operationClassSlotOffset = Math.max(0, (epoch - rotationBaseEpoch) * 2),
  era = BMU_EXECUTABLE_OPERATION_ERA,
}) {
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('generateNearCollisionAbstentionClusters: non-negative integer epoch required');
  if (typeof seed !== 'string' || !seed) throw new Error('generateNearCollisionAbstentionClusters: seed required');
  if (!Array.isArray(subjects) || subjects.length === 0) throw new Error('generateNearCollisionAbstentionClusters: subjects bank required');
  if (typeof splitOf !== 'function') throw new Error('generateNearCollisionAbstentionClusters: canonical splitOf must be injected');
  if (!registry || typeof registry.claimCluster !== 'function' || typeof registry.hasEntityHoldoutKey !== 'function') {
    throw new Error('generateNearCollisionAbstentionClusters: alias-aware m=1 registry required');
  }
  if (!Number.isInteger(clusterCount) || clusterCount < 1) throw new Error('generateNearCollisionAbstentionClusters: clusterCount >= 1');
  if (!Number.isInteger(operationClassSlotOffset) || operationClassSlotOffset < 0) throw new Error('generateNearCollisionAbstentionClusters: operationClassSlotOffset must be a non-negative integer');

  // Same deterministic date derivation as the ancestor (evolve-corpus.mjs:376-377).
  const tsDate = new Date(new Date('2024-01-01').getTime() + (40 + epoch) * 30 * 86400000).toISOString().slice(0, 10);

  const addedDocs = [];
  const addedRelations = [];
  const addedQueries = [];
  const clusters = [];
  const usedSubjectsThisRun = new Set();
  const usedEntityHoldoutKeysThisRun = new Set();

  let subjectCursor = 0;
  const nextFreeSubject = (motifGroupId) => {
    // GLOBAL m=1: skip subjects with an ACTIVE cluster in ANY family
    // (attribute rotation waits for retirement, spec §14.2). Deterministic:
    // bank order, monotone cursor.
    while (subjectCursor < subjects.length) {
      const s = subjects[subjectCursor++];
      const keys = bmuEntityHoldoutKeysForSubject(s);
      if (!registry.hasSubject(s.id) && !usedSubjectsThisRun.has(s.id)
          && !keys.some((key) => registry.hasEntityHoldoutKey(key) || usedEntityHoldoutKeysThisRun.has(key))) {
        return { subject: s, entityHoldoutKeys: keys };
      }
    }
    throw new Error(`generateNearCollisionAbstentionClusters: subject bank exhausted under GLOBAL m=1 (minting ${motifGroupId}); supply more subjects or wait for retirements`);
  };

  for (let c = 0; c < clusterCount; c++) {
    const clusterSlot = clusterSlotOffset + c;
    const motifGroupId = `mg_e${epoch}_nearcol_${String(clusterSlot).padStart(4, '0')}`;
    const picked = nextFreeSubject(motifGroupId);
    const subj = picked.subject;
    const entityHoldoutKeys = picked.entityHoldoutKeys;
    const canonical = subj.canonicalName;
    const isProject = /-svc-/.test(canonical);
    const rnd = prng(`${seed}:bmu-nearcol:${epoch}:${subj.id}:${clusterSlot}`);
    // Class choice controls both the primary collision axis and every public
    // branch edge. It is selected from cluster topology, never inferred from
    // a qrel/role label after generation.
    const operationPlan = nearcolOperationClassForSlot(operationClassSlotOffset + c, era);
    const operation = operationPlan.operation;
    const operationFamily = NEARCOL_OPERATION_FAMILY;
    const operationClass = operation.operationClass;

    const { attr, bank } = bmuAttributeForClusterSlot(epoch, clusterSlot, {
      qualifiers: NEARCOL_QUALIFIERS, bases: NEARCOL_BASES, baseEpoch: rotationBaseEpoch,
    });
    const scopes = isProject ? SCOPES_PROJECT : SCOPES_PERSON;
    const scopeIdx = Math.floor(rnd() * scopes.length);
    const scope = scopes[scopeIdx];
    const absentScope = scopes[(scopeIdx + 1) % scopes.length];   // reserved: NO doc ever covers it
    const scopeDecoyScope = scopes[(scopeIdx + 2) % scopes.length];

    const role = ROLES_PRIMARY[Math.floor(rnd() * ROLES_PRIMARY.length)];
    const valueIdx = Math.floor(rnd() * bank.length);
    const value = bank[valueIdx];
    // Decoy values walk the finite bank from the exact value, then use
    // deterministic void tokens for the full escalation group (never
    // colliding with the exact value or another decoy).
    const decoyValue = (k) => k < bank.length - 1
      ? bank[(valueIdx + 1 + k) % bank.length]
      : `void-${slug(attr)}-${epoch}-${clusterSlot}-${k}`;

    const idBase = `e${epoch}_${subj.id}_bn${clusterSlot}`;
    const docId = (slot) => opaqueBmuDocId({ docIdKeyHex, seed, epoch, motifGroupId, slot });
    const decoyCount = nearcolDecoyCount(escalationLevel);
    let decoys = [];
    let aliasCount = 0;
    let attrCount = 0;
    const pushAlias = () => {
      const k = aliasCount++;
      decoys.push({ kind: 'alias', id: docId(`alias_collision_decoy:${k}`), entityId: `e_${idBase}_dup${k}`,
        value: decoyValue(decoys.length), role: ROLES_DECOY[k % ROLES_DECOY.length] });
    };
    const pushAttr = () => {
      const k = attrCount++;
      const base = attr.replace(/\s*\(series \d+\)$/, '').split(' ').pop();
      decoys.push({ kind: 'attribute', id: docId(`attribute_lookalike_decoy:${k}`),
        value: decoyValue(decoys.length), lookalikeAttr: `${LOOKALIKE_QUALIFIERS[k % LOOKALIKE_QUALIFIERS.length]} ${base}` });
    };
    pushAlias(); // decoys[0] = primary trap
    pushAttr();
    decoys.push({ kind: 'scope', id: docId('scope_lookalike_decoy:0'), value: decoyValue(decoys.length), scope: scopeDecoyScope });
    for (let i = 3; i < decoyCount; i++) (i % 2 === 1 ? pushAlias : pushAttr)(); // extras alternate alias/attr
    if (operationPlan.primaryKind !== 'alias') {
      const primary = decoys.find((d) => d.kind === operationPlan.primaryKind);
      const firstAlias = decoys.find((d) => d.kind === 'alias');
      const firstAttr = decoys.find((d) => d.kind === 'attribute');
      const firstScope = decoys.find((d) => d.kind === 'scope');
      const orderedFirst = [primary, firstAlias, firstAttr, firstScope].filter((value, index, all) =>
        value !== undefined && all.indexOf(value) === index);
      const first = new Set(orderedFirst);
      decoys = [...orderedFirst, ...decoys.filter((d) => !first.has(d))];
    }

    // Round 4: the seed-trap's wrong value is the next fresh bank/void token
    // past the last decoy so it never collides with the exact value or a decoy.
    const trapValue = decoyValue(decoys.length);
    const spec = buildNearCollisionClusterSpec({
      canonical, subjectId: subj.id, attr, scope, absentScope, role, value,
      decoys, tsDate, subjectAliases: subj.aliases,
      exactId: docId('exact_match'), disambigId: docId('disambiguation_record'), motifGroupId,
      operationClass,
      collisionSeedTrapId: docId('collision_seed_trap'), trapValue,
    });

    // Mint-time no-answer-leak lint (fail-closed). answerValue passed is the
    // exact-match value (the cluster's leak-sensitive secret on every row);
    // lookalike_status_verification legitimately names the trap's own value —
    // mirrored verbatim in the trap doc, hence never gold-only and never the
    // answer. Abstain rows have no required docs and no answer — the lint's
    // gold-only and dominance checks degenerate correctly.
    const docText = new Map(spec.docs.map((d) => [d.id, d.text]));
    for (const stub of spec.queryStubs) {
      const t = stub.bmuTask;
      const lintErrors = lintNoAnswerLeak({
        rowId: `${motifGroupId}/${t.templateId}`,
        queryText: stub.queryText,
        answerValue: value,
        requiredDocTexts: t.requiredEvidence.map((id) => docText.get(id)),
        forbiddenDocTexts: t.forbiddenEvidence.map((id) => docText.get(id)),
        ...(t.abstain ? {} : {
          primaryTrapText: docText.get(t.forbiddenEvidence[0]),
          answerDocText: docText.get(t.answer.id),
        }),
      });
      if (lintErrors.length > 0) {
        throw new Error(`near_collision_abstention mint lint failed:\n  ${lintErrors.join('\n  ')}`);
      }
    }

    // Overlay the deep-terminal disjoint-partition topology (fix 2a). The
    // primary group routes disambiguation-anchor → sink on the outgoing step,
    // then walks the incoming chain through neutral registry relays; ONLY the
    // exact-match terminal hangs at terminal depth, so the executed route set
    // equals the answerable rows' required terminal and no decoy or forbidden
    // doc is ever routed. Decoy trios are depth-1 dead ends (the primary trio
    // balanced beside the chain head; overflow trios in terminal-free side
    // groups).
    const exactId = spec.docs.find((doc) => doc.role === 'exact_match')?.id;
    const disambigId = spec.docs.find((doc) => doc.role === 'disambiguation_record')?.id;
    const collisionSeedTrapId = spec.collisionSeedTrapId;
    if (!exactId || !disambigId || !collisionSeedTrapId) throw new Error('near_collision_abstention: exact/disambiguation/seed-trap docs missing');
    if (decoys.length % 3 !== 0) throw new Error('near_collision_abstention: decoy bank must partition into triples');
    const pathDocs = [];
    const pathGroups = [];
    const pathRelations = [];
    for (let i = 0; i < decoys.length; i += 3) {
      const groupIndex = i / 3;
      const trio = decoys.slice(i, i + 3);
      const sinkIds = [docId(`public_path_sink:${groupIndex}:0`)];
      for (let j = 1; j < operationPlan.sinkMultiplicity; j++) sinkIds.push(docId(`public_path_sink:${groupIndex}:${j}`));
      const sinkId = sinkIds[0];
      pathDocs.push(
        ...sinkIds.map((id, j) => ({ id, role: 'path_pivot', text: `${j === 0 ? 'Neutral' : 'Mirrored'} registry pivot ${epoch}-${clusterSlot}-${groupIndex}-${j} receives the same independently filed collision branches under one docket.` })),
      );
      if (groupIndex === 0) {
        // Round 4: seed the outgoing step from the query-similar forbidden
        // seed-trap (BC1-safe stage-1 chain-start), suppress the depth-1 branch
        // step to evict the trap (lineage) + collision decoys (step-produced),
        // and hang BOTH answer records (exact-match + disambiguation) at terminal
        // depth as promoted terminals.
        const topology = buildProgramPathTopology({
          program: operation.operationProgram,
          seedId: collisionSeedTrapId,
          sinkIds,
          goldIds: [exactId, disambigId],
          decoyIds: trio.map((d) => d.id),
          midIdFor: (level) => docId(`path_mid:${groupIndex}:${level}`),
        });
        pathRelations.push(...topology.relations);
        pathDocs.push(...topology.midIds.map((id, level) => ({
          id, role: 'path_mid',
          text: `Neutral registry relay ${epoch}-${clusterSlot}-m${level + 1} links the docket's standing filings for a public-path check.`,
        })));
        pathGroups.push({
          sinkId, sinkIds, truthId: exactId, decoyIds: trio.map((d) => d.id),
          anchorId: collisionSeedTrapId, midIds: [...topology.midIds],
          branchIds: [...topology.terminalIds],
        });
      } else {
        // §17.21 round-5: side trios MUST be reachable from the SAME
        // collision_seed_trap seed or no program can ever evict them — the
        // real-Qwen proof at the r5-evict context showed side-group decoys
        // (formerly seeded from their own neutral anchors, never among the
        // top-4 stage-1 seeds) are verbatim query-echo docs that ride into
        // topB on merit ⇒ forbidden_admitted ⇒ gate floor. Seeding the side
        // sinks from the trap makes every trio step-produced at the depth-1
        // suppress step (and the §18.3 eviction upgrade excludes them from
        // topB). Side sinks stay terminal-free dead ends — no decoy is routed
        // IN, and each node keeps a single route (no ambiguous lineage).
        pathRelations.push(...sinkIds.map((id) => ({ src: collisionSeedTrapId, dst: id, type: operationPlan.outgoingEdgeType, label: 'public_path_seed' })));
        for (const d of trio) {
          pathRelations.push({ src: d.id, dst: sinkId, type: operationPlan.incomingEdgeType, label: 'public_path_branch' });
        }
        pathGroups.push({
          sinkId, sinkIds, truthId: null, decoyIds: trio.map((d) => d.id),
          anchorId: collisionSeedTrapId, midIds: [], branchIds: [],
        });
      }
    }
    // Fail-closed: the trap's step-0 outgoing fan (primary + side sinks) must
    // fit the branch cap or id-sorted capping could silently drop the PRIMARY
    // sink and break routing.
    const trapFan = pathRelations.filter((r) => r.src === collisionSeedTrapId && r.label === 'public_path_seed').length;
    if (trapFan > operation.operationProgram.branchLimit) {
      throw new Error(`bmu near_collision: trap step-0 fan ${trapFan} exceeds branchLimit ${operation.operationProgram.branchLimit}`);
    }
    const allDocs = [...spec.docs, ...pathDocs];

    // Claim GLOBAL m=1 keys BEFORE emitting (fail-closed; throws on collision).
    const templateIds = spec.queryStubs.map((s) => s.bmuTask.templateId);
    registry.claimCluster({ subjectEntityId: subj.id, templateIds, entityHoldoutKeys, motifGroupId });
    usedSubjectsThisRun.add(subj.id);
    for (const key of entityHoldoutKeys) usedEntityHoldoutKeysThisRun.add(key);

    for (const doc of allDocs) {
      // The public envelope is deliberately uniform. Internal roles/scopes
      // remain non-enumerable for generator audits but disappear from JSON,
      // corpus serialization, and proposer-visible metadata.
      const emitted = {
        id: doc.id, lane: 'deep', kind: 'bmu_public_record',
        entityIds: [ownerEntityId], text: doc.text,
        shape: 'bmu_public_record', timestamp: tsDate,
        currentStaleFlag: true, liveUpdateEpoch: epoch,
      };
      Object.defineProperty(emitted, 'role', { value: doc.role, enumerable: false });
      if (doc.collisionScope !== undefined) {
        Object.defineProperty(emitted, 'collisionScope', { value: doc.collisionScope, enumerable: false });
      }
      addedDocs.push(emitted);
    }
    for (const rel of pathRelations) addedRelations.push(rel);

    const rowIds = [];
    for (let stubIndex = 0; stubIndex < spec.queryStubs.length; stubIndex++) {
      const stub = spec.queryStubs[stubIndex];
      const qid = evalHiddenQueryId({ idBase, stubIndex, epoch, splitOf });
      addedQueries.push({
        id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId,
        lane: 'deep',
        family: stub.abstain ? NEARCOL_LOGICAL_FAMILY_ABSTAIN : NEARCOL_LOGICAL_FAMILY_ANSWERABLE,
        ...(stub.abstain ? { abstain: true } : {}),
        queryText: stub.queryText,
        qrels: stub.qrels, hardNegatives: stub.hardNegatives,
        publicIntent: { atom: 'near_collision_cluster', subjectEntityId: subj.id, attribute: attr,
          collisionScope: stub.abstain ? absentScope : scope, queryTime: tsDate,
          selector: `qtype_${stub.questionType}_v${stub.variant}` },
        questionType: stub.questionType,
        band: escalationLevel > 0 ? 'very_hard' : 'hard',
        operationFamily, operationClass, operationClassBasis: operation.operationClassBasis,
        operationLaw: operation.operationLaw,
        bmuOperationCue: operation.operationCue,
        bmuOperationProgram: operation.operationProgram,
        liveUpdateEpoch: epoch,
        bmuTask: stub.bmuTask,
      });
      rowIds.push(qid);
    }

    clusters.push({
      motifGroupId, family: NEARCOL_FAMILY, epoch, clusterSlot,
      subjectEntityId: subj.id, attribute: attr, scope, absentScope, role,
      operationFamily, operationClass,
      operationClassBasis: operation.operationClassBasis,
      operationLaw: operation.operationLaw,
      bmuOperationCue: operation.operationCue,
      bmuOperationProgram: operation.operationProgram,
      operationSemantic: operationPlan.semantic,
      operationTopology: operationPlan.topology,
      escalationLevel, decoyCount,
      truthDocId: exactId,
      disambiguationDocId: disambigId,
      decoyKinds: decoys.map((decoy) => ({ id: decoy.id, kind: decoy.kind })),
      docIds: allDocs.map((d) => d.id), rowIds, templateIds,
      pathGroups: pathGroups.map((group) => ({
        ...group, sinkIds: [...group.sinkIds], decoyIds: [...group.decoyIds],
        midIds: [...group.midIds], branchIds: [...group.branchIds],
      })),
      entityHoldoutKeys: [...entityHoldoutKeys],
      questionTypes: [...new Set(spec.queryStubs.map((s) => s.questionType))],
      answerableRowCount: spec.queryStubs.filter((s) => !s.abstain).length,
      abstainRowCount: spec.queryStubs.filter((s) => s.abstain).length,
      forbiddenEvidenceAnswerable: spec.forbiddenAnswerable,
      forbiddenEvidenceAbstain: spec.forbiddenAbstain,
    });
  }

  const questionTypeHistogram = {};
  for (const q of addedQueries) questionTypeHistogram[q.questionType] = (questionTypeHistogram[q.questionType] ?? 0) + 1;

  return {
    epoch, seed, family: NEARCOL_FAMILY,
    addedDocs, addedRelations, addedQueries, clusters,
    telemetry: {
      family: NEARCOL_FAMILY, epoch, clusterCount: clusters.length,
      rowCount: addedQueries.length,
      answerableRowCount: addedQueries.filter((q) => !q.bmuTask.abstain).length,
      abstainRowCount: addedQueries.filter((q) => q.bmuTask.abstain).length,
      escalationLevel, questionTypeHistogram,
      operationClassHistogram: clusters.reduce((histo, cluster) => {
        histo[cluster.operationClass] = (histo[cluster.operationClass] ?? 0) + 1;
        return histo;
      }, {}),
      mintedSubjectEntityIds: clusters.map((c) => c.subjectEntityId),
      mintedTemplateIds: clusters.flatMap((c) => c.templateIds),
    },
  };
}
