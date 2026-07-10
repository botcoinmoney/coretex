/**
 * BMU P2 offline generator — family `conflict_lifecycle` (BMU_SPEC.md rev3.2,
 * commit ad7e523: §5.2 family law, §4.1 task schema + GLOBAL m=1, §4.2 B=4,
 * §6.7b E_f_min=110, template mint-partition law).
 *
 * CLUSTER SHAPE (unstall plan Stage 3-G1-CONFLICT cross-type shape, adopted
 * by spec §5.2): one CONFLICT memory structure per cluster —
 *   A  candidate doc: still asserts the superseded claim, phrased to claim
 *      currency with exact-question vocabulary (the forbidden TRAP; the
 *      stale-trap pattern of evolve-corpus.mjs:120-123 transposed to the
 *      conflict lifecycle);
 *   B  resolved doc: the corrected/current-for-scope value, neutral
 *      resolution phrasing (never echoes the question skeleton — the trap
 *      must out-rank honestly, §2.2);
 *   R  resolution record: documents that A was contradicted and B confirmed
 *      (resolution provenance);
 *   Dx scope-mismatch decoys (§5.2 trap set): same subject + same attribute,
 *      DIFFERENT scope, claiming currency with question vocabulary — the
 *      distractor pressure that makes conflict headroom bind at small B
 *      (Stage 3-G1-CONFLICT measured conflict's lever as retrieval-cap
 *      ADMISSION under distractor pressure, not rerank reordering; ≥2 decoys
 *      always, +1 per escalation level, so ≥3 forbidden docs compete with the
 *      2 required docs for B=4 slots).
 * Relations: contradicts B→A (edge type `co_occurs_with` + label
 * `contradicts`, the ancestor encoding at evolve-corpus.mjs:446 — the
 * RelationEdgeType vocabulary has no `contradicts`), derived_from R→A.
 *
 * FIVE eval_hidden rows per cluster (k=5) across FOUR question types (the
 * typed-cluster anti-coverage-indexing law, buildTypedTemporalClusterSpec
 * ancestry — evolve-corpus.mjs:114-188):
 *   current_for_scope (v0 + v1), resolution_provenance,
 *   downstream_for_scope, candidate_status_verification.
 * Every row: requiredEvidence = [B, R] (⊆ qrels ≥ 0.5, |required| = 2 ≤ B=4),
 * forbiddenEvidence = [A, ...decoys] (⊆ qrels=0 ∪ hardNegatives), answer = B
 * or R by type. Utility per §2.2 demands trap EVICTION — label knowledge
 * earns nothing without the real resolution operation (conflict policy atom,
 * words 512-639).
 *
 * TEMPLATE LAW (§4.1 M7): templateId identifies the SURFACE-FORM template.
 * Design decision (documented, load-bearing): the template is the question
 * SKELETON with the (attribute, scope) pair BAKED IN — only the subject and
 * values are parameters. Both attr and scope appear verbatim in the question
 * text, and the attribute rotation gives every cluster a window-unique
 * attribute (common.mjs DELTA 1), so:
 *   - two rows share a templateId iff same (questionType, variant, attr,
 *     scope) = literally the same surface form (§4.1 iff-condition);
 *   - any two clusters of the family in the window carry DISJOINT templateId
 *     sets (mint-partition law) — enforced fail-closed by the m=1 registry.
 *
 * NAMED DELTAS from the temporal ancestor (I10), beyond the ones in
 * common.mjs:
 *   - provenance-support qrels are 0.6 (not the ancestor's 0.4) because the
 *     §4.3 mint-time consistency rule pins requiredEvidence ⊆ {qrels ≥ 0.5};
 *   - clusters are minted whole-or-not-at-all (fail-closed salt search);
 *   - every row is stamped with a full §4.1 bmuTask (the ancestor pre-dates
 *     the schema);
 *   - subjects are consumed via the GLOBAL m=1 registry and never reused
 *     while a prior cluster is active (spec §14.2: rotation waits for
 *     retirement; the caller releases registry keys when clusters retire).
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

export const CONFLICT_FAMILY = 'conflict_lifecycle';
export const CONFLICT_BUDGET_B = BMU_DEFAULT_BUDGET_B.conflict_lifecycle; // 4
export const CONFLICT_ROTATION_BASE_EPOCH = 137; // first BMU mint epoch (pre-flip inert stamping era)

/** Deterministic v2 operation classes consumed as P5 strata. Both implement
 * the same balanced public diamond while requiring different text operations:
 * reconcile competing claims vs apply an authority override. */
export const CONFLICT_OPERATION_FAMILIES = Object.freeze([
  'conflict_claim_reconciliation',
  'conflict_authority_override',
]);

export function conflictOperationFamilyForCluster(clusterSlot) {
  if (!Number.isInteger(clusterSlot) || clusterSlot < 0) throw new Error('conflict_lifecycle: non-negative integer clusterSlot required');
  return CONFLICT_OPERATION_FAMILIES[clusterSlot % CONFLICT_OPERATION_FAMILIES.length];
}

const CONFLICT_PATH_EDGES = Object.freeze({
  conflict_claim_reconciliation: Object.freeze({ seed: 'derived_from', branch: 'co_occurs_with' }),
  conflict_authority_override: Object.freeze({ seed: 'causes', branch: 'supports' }),
});

/** §5.2 question types — four DISTINCT types, five rows (current_for_scope ×2 variants). */
export const CONFLICT_QUESTION_TYPES = Object.freeze([
  'current_for_scope',
  'resolution_provenance',
  'downstream_for_scope',
  'candidate_status_verification',
]);

// Family-namespaced rotation grids (common.mjs DELTA 2 — disjoint from the
// temporal rotation's qualifier space so conflict never burns temporal
// headroom attributes).
const CONFLICT_QUALIFIERS = Object.freeze([
  'rollout', 'oncall', 'triage', 'vendor', 'failover', 'transit',
  'handover', 'audit-cycle', 'escalation', 'renewal', 'standby', 'dispatch',
]);
// Value banks are single-token handles DISJOINT from every base/qualifier/
// scope token, so the answer-value leak lint never false-positives on shared
// vocabulary (e.g. a "depot" attr with a "X depot" value would self-trip).
const APPROVERS = Object.freeze(['vasken-ingrid', 'reyol-tomas', 'nandari-priya', 'bruun-ola', 'kayat-selim', 'mossberg-rita', 'petrovna-dana', 'owusu-kofi']);
const DEPOTS = Object.freeze(['bergen-yard', 'tallinn-yard', 'porto-yard', 'danang-yard', 'kigali-yard', 'aarhus-yard', 'basel-yard', 'fukuoka-yard']);
const REGISTRIES = Object.freeze(['ledger-north', 'ledger-east', 'ledger-delta', 'ledger-prime', 'ledger-atlas', 'ledger-onyx', 'ledger-ridge', 'ledger-cove']);
const CONFLICT_BASES = Object.freeze([
  ['approver', APPROVERS],
  ['depot', DEPOTS],
  ['registry', REGISTRIES],
]);
const SCOPES_PERSON = Object.freeze(['weekday care', 'weekend care', 'travel care', 'home care']);
const SCOPES_PROJECT = Object.freeze(['production', 'staging', 'canary', 'disaster-recovery']);

/** Deterministic decoy count: distractor-pressure floor of 2, +1 per escalation level. */
export function conflictDecoyCount(escalationLevel) {
  return 2 + Math.max(0, Math.min(4, escalationLevel | 0));
}

export function conflictTemplateId(questionType, variant, attr, scope) {
  return `tt_conflict_${questionType}_v${variant}__${slug(attr)}__${slug(scope)}`;
}

/**
 * Pure single-cluster spec: docs / relations / query stubs (with bmuTask) for
 * ONE conflict-lifecycle memory structure. The analog of
 * `buildTypedTemporalClusterSpec` (evolve-corpus.mjs:114-188); shared by the
 * generator, the unit tests, and the sample-emission harness so what is
 * certified offline is byte-for-byte what production will mint.
 */
export function buildConflictLifecycleClusterSpec({
  canonical, subjectId, attr, scope, decoyScopes, valA, valB, decoyVals,
  tsDate, priorDate, candidateId, resolvedId, resolutionId, decoyIds, motifGroupId,
  pivotId = `${candidateId}_pivot`, operationFamily = CONFLICT_OPERATION_FAMILIES[0],
  subjectAliases = [],
}) {
  if (decoyIds.length !== decoyVals.length || decoyIds.length !== decoyScopes.length) {
    throw new Error('buildConflictLifecycleClusterSpec: decoyIds/decoyVals/decoyScopes must align');
  }
  if (decoyIds.length < 2) throw new Error('buildConflictLifecycleClusterSpec: >=2 scope-mismatch decoys required (distractor-pressure floor)');
  if (valA === valB) throw new Error('buildConflictLifecycleClusterSpec: candidate and resolved values must differ');
  if (!CONFLICT_OPERATION_FAMILIES.includes(operationFamily)) throw new Error(`buildConflictLifecycleClusterSpec: unknown operationFamily '${operationFamily}'`);

  const pathEdges = CONFLICT_PATH_EDGES[operationFamily];
  const resolvedText = operationFamily === 'conflict_claim_reconciliation'
    ? `${canonical}'s ${attr} claims for ${scope} were compared in the ${tsDate} reconciliation; ${valB} matched the governing record while ${valA} did not.`
    : `Authority notice ${tsDate} for ${canonical}'s ${scope} ${attr}: the signed override establishes ${valB}; the provisional ${valA} instruction has no standing.`;
  const resolutionText = operationFamily === 'conflict_claim_reconciliation'
    ? `Review minutes ${tsDate} for ${canonical}'s ${scope} ${attr}: source checks confirmed ${valB} and rejected the competing ${valA} intake claim.`
    : `Override audit ${tsDate} for ${canonical}'s ${scope} ${attr}: authorization checks validate ${valB} and reject the provisional ${valA} instruction.`;
  const decoyText = (i) => operationFamily === 'conflict_claim_reconciliation'
    ? `Review finding ${tsDate} for ${canonical}'s ${scope} ${attr}: ${decoyVals[i]} came from the separate ${decoyScopes[i]} scope, so it does not govern this scope.`
    : `Override finding ${tsDate} for ${canonical}'s ${scope} ${attr}: ${decoyVals[i]} authorizes only the separate ${decoyScopes[i]} scope, not this scope.`;

  const docs = [
    { id: candidateId, kind: `conflict_${slug(attr)}`, role: 'conflict_candidate_trap',
      text: `What is ${canonical}'s current ${attr} for ${scope}? The current ${attr} for ${scope} is ${valA}, per the earlier intake note, and new sessions should keep applying ${valA}.`,
      timestamp: priorDate, currentStaleFlag: false,
      lifecycleState: 'conflict_candidate', lifecycleScope: scope,
      scope: { topicId: scope } },
    { id: resolvedId, kind: 'bmu_public_record', role: 'conflict_resolved',
      text: resolvedText,
      timestamp: tsDate, currentStaleFlag: true,
      lifecycleState: 'terminal_branch', lifecycleScope: scope,
      scope: { topicId: scope } },
    { id: resolutionId, kind: 'bmu_public_record', role: 'resolution_record',
      text: resolutionText,
      timestamp: tsDate, currentStaleFlag: true,
      lifecycleState: 'terminal_branch', lifecycleScope: scope,
      scope: { topicId: scope } },
    ...decoyIds.map((decoyId, i) => ({ id: decoyId, kind: 'bmu_public_record', role: 'scope_mismatch_decoy',
      text: decoyText(i),
      timestamp: tsDate, currentStaleFlag: true,
      lifecycleState: 'terminal_branch', lifecycleScope: scope,
      scope: { topicId: scope } })),
    { id: pivotId, kind: 'bmu_public_record', role: 'public_path_pivot',
      text: operationFamily === 'conflict_claim_reconciliation'
        ? `Claim-review docket ${tsDate} for ${canonical}'s ${scope} ${attr} links parallel findings for comparison.`
        : `Authority-review docket ${tsDate} for ${canonical}'s ${scope} ${attr} links parallel findings for verification.`,
      timestamp: tsDate, currentStaleFlag: true, lifecycleState: 'path_pivot', lifecycleScope: scope,
      scope: { topicId: scope } },
  ];

  const terminalBranchIds = [resolvedId, resolutionId, decoyIds[0], decoyIds[1]];
  // Fixed outgoing→incoming diamond. Every terminal also receives identical
  // legacy cross-type edges, preserving the old relation substrate without
  // leaving B/R as structural gold oracles.
  const relations = [
    { src: candidateId, dst: pivotId, type: pathEdges.seed, label: 'public_path_seed' },
    ...terminalBranchIds.map((src) => ({ src, dst: pivotId, type: pathEdges.branch, label: 'public_path_branch' })),
    ...terminalBranchIds.flatMap((src) => [
      { src, dst: candidateId, type: 'co_occurs_with', label: 'contradicts' },
      { src, dst: candidateId, type: 'derived_from', label: 'resolution_of' },
    ]),
  ];

  const trapQrel = { docId: candidateId, relevance: 0.0, role: 'conflict_candidate_trap' };
  const decoyQrels = decoyIds.map((docId) => ({ docId, relevance: 0.0, role: 'scope_mismatch_decoy' }));
  const trapNeg = { docId: candidateId, category: 'conflict_candidate_exact_terms' };
  const decoyNegs = decoyIds.map((docId) => ({ docId, category: 'scope_mismatch_near_collision' }));
  const forbiddenEvidence = [candidateId, ...decoyIds];

  const entityHoldoutKeys = bmuEntityHoldoutKeysForSubject({ id: subjectId, canonicalName: canonical, aliases: subjectAliases });
  const stampTask = ({ requiredEvidence, answerId, answerValue, questionType, variant }) => ({
    family: CONFLICT_FAMILY,
    budgetB: CONFLICT_BUDGET_B,
    requiredEvidence,
    forbiddenEvidence,
    answer: { id: answerId, value: answerValue },
    abstain: false,
    motifGroupId,
    templateId: conflictTemplateId(questionType, variant, attr, scope),
    entityHoldoutKeys,
  });

  // §4.3 mint-time consistency: requiredEvidence ⊆ {qrels ≥ 0.5} — support
  // doc graded 0.6 (DELTA from the ancestor's 0.4 provenance bridge).
  const answerFirstQrels = (answerDoc, supportDoc) => [
    { docId: answerDoc, relevance: 1.0, role: 'direct' },
    { docId: supportDoc, relevance: 0.6, role: 'resolution_support' },
    trapQrel,
    ...decoyQrels,
  ];
  const hardNegatives = [trapNeg, ...decoyNegs];

  const queryStubs = [
    { questionType: 'current_for_scope', variant: 0,
      queryText: `For ${canonical}'s ${scope}, which ${attr} is on record as current?`,
      qrels: answerFirstQrels(resolvedId, resolutionId), hardNegatives,
      bmuTask: stampTask({ requiredEvidence: [resolvedId, resolutionId], answerId: resolvedId, answerValue: valB, questionType: 'current_for_scope', variant: 0 }) },
    { questionType: 'resolution_provenance', variant: 0,
      // Vocabulary discipline: every non-stopword here also appears in the
      // TRAP doc ("per the earlier intake note"), so no token is gold-only.
      queryText: `What happened to the earlier intake ${attr} note for ${canonical}'s ${scope}?`,
      qrels: answerFirstQrels(resolutionId, resolvedId), hardNegatives,
      bmuTask: stampTask({ requiredEvidence: [resolutionId, resolvedId], answerId: resolutionId, answerValue: `${valA} rejected; ${valB} confirmed`, questionType: 'resolution_provenance', variant: 0 }) },
    { questionType: 'downstream_for_scope', variant: 0,
      queryText: `Which ${attr} should ${canonical}'s upcoming ${scope} sessions rely on?`,
      qrels: answerFirstQrels(resolvedId, resolutionId), hardNegatives,
      bmuTask: stampTask({ requiredEvidence: [resolvedId, resolutionId], answerId: resolvedId, answerValue: valB, questionType: 'downstream_for_scope', variant: 0 }) },
    { questionType: 'candidate_status_verification', variant: 0,
      queryText: `Is ${valA} still the accepted ${attr} for ${canonical}'s ${scope}?`,
      qrels: answerFirstQrels(resolutionId, resolvedId), hardNegatives,
      bmuTask: stampTask({ requiredEvidence: [resolutionId, resolvedId], answerId: resolutionId, answerValue: `no — ${valA} was rejected in resolution`, questionType: 'candidate_status_verification', variant: 0 }) },
    { questionType: 'current_for_scope', variant: 1,
      queryText: `As of now, what ${attr} applies to ${canonical} for ${scope}?`,
      qrels: answerFirstQrels(resolvedId, resolutionId), hardNegatives,
      bmuTask: stampTask({ requiredEvidence: [resolvedId, resolutionId], answerId: resolvedId, answerValue: valB, questionType: 'current_for_scope', variant: 1 }) },
  ];
  if (queryStubs.length !== BMU_CLUSTER_SIZE_K) throw new Error('conflict cluster must carry exactly k=5 rows');

  return {
    docs, relations, queryStubs, forbiddenEvidence,
    operationFamily,
    publicPath: {
      seedId: candidateId, pivotId,
      firstEdgeType: pathEdges.seed, terminalEdgeType: pathEdges.branch,
      terminalBranchIds, goldBranchIds: [resolvedId, resolutionId],
      decoyBranchIds: decoyIds.slice(0, 2),
    },
  };
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
 * }} args
 */
export function generateConflictLifecycleClusters({
  epoch, seed, subjects, registry, splitOf,
  clusterCount = 2, escalationLevel = 0, clusterSlotOffset = 0,
  ownerEntityId = 'e_universe', rotationBaseEpoch = CONFLICT_ROTATION_BASE_EPOCH,
}) {
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('generateConflictLifecycleClusters: non-negative integer epoch required');
  if (typeof seed !== 'string' || !seed) throw new Error('generateConflictLifecycleClusters: seed required');
  if (!Array.isArray(subjects) || subjects.length === 0) throw new Error('generateConflictLifecycleClusters: subjects bank required');
  if (typeof splitOf !== 'function') throw new Error('generateConflictLifecycleClusters: canonical splitOf must be injected');
  if (!registry || typeof registry.claimCluster !== 'function' || typeof registry.hasEntityHoldoutKey !== 'function') {
    throw new Error('generateConflictLifecycleClusters: alias-aware m=1 registry required');
  }
  if (!Number.isInteger(clusterCount) || clusterCount < 1) throw new Error('generateConflictLifecycleClusters: clusterCount >= 1');

  // Same deterministic date derivation as the ancestor (evolve-corpus.mjs:376-377).
  const tsDate = new Date(new Date('2024-01-01').getTime() + (40 + epoch) * 30 * 86400000).toISOString().slice(0, 10);
  const priorDate = new Date(new Date(tsDate).getTime() - 86400000).toISOString().slice(0, 10);

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
    throw new Error(`generateConflictLifecycleClusters: subject bank exhausted under GLOBAL m=1 (minting ${motifGroupId}); supply more subjects or wait for retirements`);
  };

  for (let c = 0; c < clusterCount; c++) {
    const clusterSlot = clusterSlotOffset + c;
    const motifGroupId = `mg_e${epoch}_conflict_${String(clusterSlot).padStart(4, '0')}`;
    const picked = nextFreeSubject(motifGroupId);
    const subj = picked.subject;
    const entityHoldoutKeys = picked.entityHoldoutKeys;
    const canonical = subj.canonicalName;
    const isProject = /-svc-/.test(canonical);
    const rnd = prng(`${seed}:bmu-conflict:${epoch}:${subj.id}:${clusterSlot}`);
    const operationFamily = conflictOperationFamilyForCluster(clusterSlot);

    const { attr, bank } = bmuAttributeForClusterSlot(epoch, clusterSlot, {
      qualifiers: CONFLICT_QUALIFIERS, bases: CONFLICT_BASES, baseEpoch: rotationBaseEpoch,
    });
    const scopes = isProject ? SCOPES_PROJECT : SCOPES_PERSON;
    const scopeIdx = Math.floor(rnd() * scopes.length);
    const scope = scopes[scopeIdx];

    const valB = bank[Math.floor(rnd() * bank.length)];
    let valA = bank[Math.floor(rnd() * bank.length)];
    if (valA === valB) valA = bank[(bank.indexOf(valB) + 1) % bank.length];

    const decoyCount = conflictDecoyCount(escalationLevel);
    const decoyScopes = [];
    const decoyVals = [];
    for (let i = 0; i < decoyCount; i++) {
      decoyScopes.push(scopes[(scopeIdx + 1 + (i % (scopes.length - 1))) % scopes.length]);
      let dv = bank[(bank.indexOf(valB) + 2 + i) % bank.length];
      if (dv === valA || dv === valB) dv = bank[(bank.indexOf(dv) + 1) % bank.length];
      decoyVals.push(dv);
    }

    const idBase = `e${epoch}_${subj.id}_bc${clusterSlot}`;
    const docId = (slot) => opaqueBmuDocId({ seed, epoch, motifGroupId, slot });
    const spec = buildConflictLifecycleClusterSpec({
      canonical, subjectId: subj.id, attr, scope, decoyScopes, valA, valB, decoyVals,
      tsDate, priorDate, subjectAliases: subj.aliases,
      candidateId: docId('conflict_candidate_trap'), resolvedId: docId('conflict_resolved'),
      resolutionId: docId('resolution_record'),
      pivotId: docId('public_path_pivot'), operationFamily,
      decoyIds: decoyVals.map((_, i) => docId(`scope_mismatch_decoy:${i}`)), motifGroupId,
    });

    // Mint-time no-answer-leak lint (fail-closed). answerValue is always the
    // RESOLVED value valB (the leak-sensitive secret on every row of the
    // cluster); candidate_status_verification legitimately names valA — the
    // trap's own value, mirrored verbatim in the trap doc, hence never
    // gold-only and never the answer.
    const docText = new Map(spec.docs.map((d) => [d.id, d.text]));
    for (const stub of spec.queryStubs) {
      const t = stub.bmuTask;
      const lintErrors = lintNoAnswerLeak({
        rowId: `${motifGroupId}/${t.templateId}`,
        queryText: stub.queryText,
        answerValue: valB,
        requiredDocTexts: t.requiredEvidence.map((id) => docText.get(id)),
        forbiddenDocTexts: t.forbiddenEvidence.map((id) => docText.get(id)),
        primaryTrapText: docText.get(t.forbiddenEvidence[0]),
        answerDocText: docText.get(t.answer.id),
      });
      if (lintErrors.length > 0) {
        throw new Error(`conflict_lifecycle mint lint failed:\n  ${lintErrors.join('\n  ')}`);
      }
    }

    // Claim GLOBAL m=1 keys BEFORE emitting (fail-closed; throws on collision).
    const templateIds = spec.queryStubs.map((s) => s.bmuTask.templateId);
    registry.claimCluster({ subjectEntityId: subj.id, templateIds, entityHoldoutKeys, motifGroupId });
    usedSubjectsThisRun.add(subj.id);
    for (const key of entityHoldoutKeys) usedEntityHoldoutKeysThisRun.add(key);

    for (const doc of spec.docs) {
      const emitted = {
        id: doc.id, lane: 'deep', kind: 'bmu_public_record', entityIds: [ownerEntityId, subj.id],
        text: doc.text, shape: 'lifecycle_conflict_record', timestamp: doc.timestamp,
        currentStaleFlag: doc.currentStaleFlag,
        lifecycleScope: doc.lifecycleScope, liveUpdateEpoch: epoch,
      };
      Object.defineProperty(emitted, 'role', { value: doc.role, enumerable: false });
      addedDocs.push(emitted);
    }
    for (const rel of spec.relations) addedRelations.push(rel);

    const rowIds = [];
    for (let stubIndex = 0; stubIndex < spec.queryStubs.length; stubIndex++) {
      const stub = spec.queryStubs[stubIndex];
      const qid = evalHiddenQueryId({ idBase, stubIndex, epoch, splitOf });
      addedQueries.push({
        id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId,
        lane: 'deep', family: CONFLICT_FAMILY, queryText: stub.queryText,
        qrels: stub.qrels, hardNegatives: stub.hardNegatives,
        publicIntent: { atom: 'conflict_cluster', subjectEntityId: subj.id, attribute: attr,
          lifecycleScope: scope, queryTime: tsDate, selector: `qtype_${stub.questionType}_v${stub.variant}` },
        questionType: stub.questionType,
        band: escalationLevel > 0 ? 'very_hard' : 'hard',
        operationFamily, operationClass: operationFamily, liveUpdateEpoch: epoch,
        bmuTask: stub.bmuTask,
      });
      rowIds.push(qid);
    }

    clusters.push({
      motifGroupId, family: CONFLICT_FAMILY, epoch, clusterSlot,
      subjectEntityId: subj.id, attribute: attr, scope,
      operationFamily, operationClass: operationFamily,
      escalationLevel, decoyCount, decoyScopes: [...decoyScopes],
      docIds: spec.docs.map((d) => d.id), rowIds, templateIds,
      entityHoldoutKeys: [...entityHoldoutKeys],
      questionTypes: [...new Set(spec.queryStubs.map((s) => s.questionType))],
      forbiddenEvidence: spec.forbiddenEvidence,
      publicPath: spec.publicPath,
    });
  }

  const questionTypeHistogram = {};
  for (const q of addedQueries) questionTypeHistogram[q.questionType] = (questionTypeHistogram[q.questionType] ?? 0) + 1;

  return {
    epoch, seed, family: CONFLICT_FAMILY,
    addedDocs, addedRelations, addedQueries, clusters,
    telemetry: {
      family: CONFLICT_FAMILY, epoch, clusterCount: clusters.length,
      rowCount: addedQueries.length, escalationLevel, questionTypeHistogram,
      operationFamilyHistogram: clusters.reduce((histo, cluster) => {
        histo[cluster.operationFamily] = (histo[cluster.operationFamily] ?? 0) + 1;
        return histo;
      }, {}),
      mintedSubjectEntityIds: clusters.map((c) => c.subjectEntityId),
      mintedTemplateIds: clusters.flatMap((c) => c.templateIds),
    },
  };
}
