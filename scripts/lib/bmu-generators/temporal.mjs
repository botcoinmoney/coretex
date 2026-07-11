/**
 * BMU v1 offline generator — family "temporal" (current / stale / supersession).
 * Frozen spec: specs/BMU_SPEC.md rev3.2 (ad7e523) §4.1, §4.2, §5.1, §6.3, §13.2.
 *
 * DESCENT + DELTAS (invariant I10 — every inherited mechanism cited, every
 * change justified). Direct descendant of the PROVEN Stage-3-G1 typed-cluster
 * minter (`scripts/lib/evolve-corpus.mjs`, 8/8 clusters mineable, Δ198k-304k
 * ppm, controls 0):
 *
 *  INHERITED VERBATIM (imported, not copied):
 *   - `buildTypedTemporalClusterSpec` (:114-188): the 3-doc memory structure
 *     (current / stale-trap-claiming-currency / change-provenance) +
 *     escalation shadows + relations + per-question-type qrels/hardNegatives.
 *     The stale doc IS the §5.1 forbidden evidence; answer = the current
 *     (or provenance) doc.
 *   - `temporalAttributeForEpochSlot` (:71-81): attribute rotation — an
 *     attribute is ONE-SHOT headroom; rotation is the anti-exhaustion law.
 *   - `escalationLevelForEpoch` (:199-215): shadow-decoy difficulty ramp.
 *   - doc envelope fields (lane/kind/entityIds/shape/validity/liveUpdateEpoch)
 *     and row envelope fields (ownerScoped/subjectEntityId/lane/family/
 *     qrels/hardNegatives/publicIntent/questionType/capability/band/
 *     operationFamily) exactly as the evolve minter stamps them (:697-760),
 *     so the existing logical-delta bridge consumes these clusters unchanged.
 *   - eval_hidden id salt-search (via common.searchEvalHiddenId; splitOf is
 *     INJECTED like the evolve wiring, coretex-epoch-evolve.mjs:583).
 *
 *  DELTAS (each forced by the frozen spec):
 *   1. bmuTask stamps (§4.1): requiredEvidence/forbiddenEvidence/answer/
 *      budgetB(=3, §4.2)/family/motifGroupId/templateId per row. Mint-time
 *      consistency rule (§4.3) honored: requiredEvidence ⊆ {qrels ≥ 0.5},
 *      forbiddenEvidence ⊆ {qrels = 0} ∪ hardNegatives.
 *   2. Fixed surface wording → per-question-type TEMPLATE BANKS with the
 *      §4.1 template mint-partition law: same-family same-epoch clusters get
 *      DISJOINT templateId sets; two rows share a templateId iff they render
 *      the same surface form. (The ancestor's "Qwen-headroom wording"
 *      constraint DISSOLVES under BMU — §14.2; hardness certification is the
 *      admission bar, so wording rotates freely from banks.)
 *   3. GLOBAL m=1 (rev3.2 §4.1): subjects AND templates are skipped while in
 *      ANY active cluster (any family) — attribute rotation now WAITS FOR
 *      RETIREMENT on a subject (§14.2). The ancestor's `subjects[salt % n]`
 *      pick becomes a seeded-start skip-scan; its `priorTemporalByAttr`
 *      supersedes-chain is dropped (same-subject remint while active is now
 *      ILLEGAL, and after retirement the prior cluster's rows have left the
 *      active window).
 *   4. Cluster atomicity hardened: ancestor allowed partial clusters on probe
 *      exhaustion / mid-cluster quota cuts; BMU cluster size k=5 is law, so
 *      every cluster mints exactly CLUSTER_K rows or the generator THROWS.
 *   5. No-answer-leak lint runs AT MINT TIME (fail-closed): the answer value
 *      never appears in any question; no shared 4-word skeleton n-gram
 *      between a question and its cluster's gold docs (slot fills collapsed);
 *      no rendered question is a substring of any public doc.
 */
import {
  buildTypedTemporalClusterSpec,
  temporalAttributeForEpochSlot,
  escalationLevelForEpoch,
} from '../evolve-corpus.mjs';
import {
  prng,
  datesForEpoch,
  createBmuActiveIndex,
  indexHasSubject,
  indexHasEntityHoldoutKey,
  indexHasTemplate,
  indexHasMotifGroup,
  registerCluster,
  searchEvalHiddenId,
  containsValue,
  sharedSkeletonNgrams,
  opaqueBmuDocId,
  bmuEntityHoldoutKeysForSubject,
} from './common.mjs';
import {
  BMU_EXECUTABLE_PROGRAM_BANK,
  buildProgramPathTopology,
  executableOperationForFamilySlot,
  stampExecutableOperationTask,
} from './operation-program.mjs';

export const BMU_TEMPORAL_FAMILY = 'temporal';            // bmuTask.family / bucketed (§5.6)
export const BMU_TEMPORAL_LOGICAL_FAMILY = 'temporal_update'; // corpus logicalFamily (§5.6)
export const BMU_TEMPORAL_BUDGET_B = 3;                   // §4.2 default
export const BMU_TEMPORAL_CLUSTER_K = 5;                  // spec cluster size law
/** Same-subject, currently-valid records for unrelated attributes. Keep this
 * above B=3 so recency/validity-only shortcut rankers cannot recover the
 * temporal positives without also applying attribute/relation structure. */
export const BMU_TEMPORAL_SHORTCUT_CONTROL_DOCS = 4;

/**
 * BMU v2 operation classes. Cluster slot parity is the only selector: the
 * class is deterministic, independent of labels/qrels, and serialized on the
 * cluster/rows for P5 stratification. The rotating bank instantiates bounded
 * outgoing→incoming diamonds and changes both edge program and textual
 * decision. Its transferable substrate target remains ≤4 words: stale-seed
 * anchor, winning-terminal anchor, plus the inherited two-word
 * subject/attribute currency record.
 */
export const TEMPORAL_SEMANTIC_OPERATIONS = Object.freeze([
  Object.freeze({ id: 'revision_supersession', decision: 'authorized revision replaces a retired value' }),
  Object.freeze({ id: 'validity_renewal', decision: 'scheduled review renews one value past expiry' }),
  Object.freeze({ id: 'rollback_restoration', decision: 'invalid interim revision rolls back to the governing value' }),
  Object.freeze({ id: 'effective_handoff', decision: 'dated handoff activates the successor value' }),
]);

export const TEMPORAL_PATH_TOPOLOGIES = Object.freeze(BMU_EXECUTABLE_PROGRAM_BANK.map((program) =>
  Object.freeze({
    id: `${program.outgoingEdgeType}_then_${program.incomingEdgeType}`,
    seed: program.outgoingEdgeType,
    branch: program.incomingEdgeType,
  })));

/** Exactly 36 executable classes; semantic prose rotates independently. */
export const TEMPORAL_OPERATION_CLASS_BANK = Object.freeze(BMU_EXECUTABLE_PROGRAM_BANK.map((program, ordinal) => {
  const operation = executableOperationForFamilySlot(BMU_TEMPORAL_FAMILY, ordinal * 2);
  return Object.freeze({
    id: operation.operationClass,
    semantic: TEMPORAL_SEMANTIC_OPERATIONS[ordinal % TEMPORAL_SEMANTIC_OPERATIONS.length],
    topology: TEMPORAL_PATH_TOPOLOGIES[ordinal],
    operation,
  });
}));
export const TEMPORAL_OPERATION_FAMILIES = Object.freeze(TEMPORAL_OPERATION_CLASS_BANK.map((profile) => profile.id));
export function temporalOperationProfileForCluster(operationSequenceOffset, clusterSlot) {
  if (!Number.isInteger(operationSequenceOffset) || operationSequenceOffset < 0) throw new Error('bmu temporal: non-negative integer operationSequenceOffset required');
  if (!Number.isInteger(clusterSlot) || clusterSlot < 0) throw new Error('bmu temporal: non-negative integer clusterSlot required');
  const sequence = operationSequenceOffset + clusterSlot;
  // Adjacent-pair rotation: two entity/template-disjoint instances of a class
  // coexist inside maxAge. One-class-per-cluster rotation repeated only after
  // 32 mints, long after the first temporal instance retired at cadence 8.
  return TEMPORAL_OPERATION_CLASS_BANK[Math.floor(sequence / 2) % TEMPORAL_OPERATION_CLASS_BANK.length];
}

export function temporalOperationFamilyForCluster(operationSequenceOffset, clusterSlot) {
  return temporalOperationProfileForCluster(operationSequenceOffset, clusterSlot).id;
}

/**
 * §4.1 template banks — surface-form grids per question type.
 * templateId = `tt_temporal_supersession_<qtype>_o<i>_f<j>` names ONE exact
 * skeleton (prefix i × form j); same id ⟺ same surface form, by construction.
 *
 * Sizing vs the GLOBAL m=1 window (§4.1): each active cluster consumes 2
 * current_value templates and 1 of each other type. Worst-case active
 * temporal clusters ≈ 2/epoch × maxAge 32 = 64 ⇒ need ≥128 current_value
 * variants (12×12=144) and ≥64 per other type (12×8=96). Exhaustion under
 * heavier minting fail-closes in `pickTemplate` rather than violating m=1.
 *
 * Wording law inherited from the ancestor's proven shapes: questions carry the
 * subject + attribute (+ staleVal for verification/provenance types), NEVER
 * the current value (the answer), and NEVER gold-only vocabulary
 * ("superseded", "replaced", "supersession ledger") — the stale TRAP doc, not
 * the gold doc, is the lexically dominant match (§5.1 anti-lexical-shortcut).
 */
const CV_OPENERS = [
  'As of now', 'Right now', 'At present', 'Today', 'As of this session',
  'As things stand', 'For current purposes', 'At this point', 'As of the latest note',
  'Per the latest state', 'With everything up to date', 'On the current view',
];
const CV_FORMS = [
  'what {attr} is recorded for {canonical}?',
  'which {attr} is on record for {canonical}?',
  'what is the standing {attr} for {canonical}?',
  'which {attr} applies to {canonical}?',
  'what {attr} does {canonical} carry?',
  'which {attr} is in effect for {canonical}?',
  "what is {canonical}'s effective {attr}?",
  'which {attr} entry stands for {canonical}?',
  'what {attr} should be read for {canonical}?',
  'which {attr} is live for {canonical}?',
  "what does {canonical}'s {attr} come to?",
  'which {attr} holds for {canonical}?',
];
const SV_PREFIXES = [
  '', 'Quick check:', 'Verification:', 'Before reuse:', 'Session check:', 'Confirm:',
  'Sanity check:', 'Double-checking:', 'One question:', 'Checking first:', 'To be sure:', 'Re-checking:',
];
const SV_FORMS = [
  'is {staleVal} still the valid {attr} for {canonical}?',
  'does {staleVal} remain the standing {attr} for {canonical}?',
  "is {canonical}'s {attr} still {staleVal}?",
  "should {staleVal} still be treated as {canonical}'s {attr}?",
  "can new sessions still rely on {staleVal} as {canonical}'s {attr}?",
  "is the {staleVal} entry still in force as {canonical}'s {attr}?",
  'does the {attr} value {staleVal} still hold for {canonical}?',
  "is {staleVal} still current for {canonical}'s {attr}?",
];
const DA_PREFIXES = [
  '', 'Planning ahead:', 'For the next session:', 'Setup question:', 'Onboarding:', 'Going forward:',
  'Before kickoff:', 'For new work:', 'Provisioning:', 'For the handoff:', 'Next steps:', 'For rollout:',
];
const DA_FORMS = [
  "which {attr} should {canonical}'s new sessions rely on?",
  'which {attr} should a fresh session apply for {canonical}?',
  'which {attr} should downstream work assume for {canonical}?',
  'when acting for {canonical}, which {attr} should be used?',
  'which {attr} should tooling pick up for {canonical}?',
  'what {attr} should plans for {canonical} build on?',
  "which {attr} setting should {canonical}'s next task inherit?",
  'which {attr} should be applied on behalf of {canonical}?',
];
const CP_PREFIXES = [
  // 'Paper trail:' replaced 'Ledger question:' (P2 certification screen fix:
  // 'ledger' is gold-only vocabulary — inside a cluster it appears ONLY in
  // the current/provenance doc templates, a NoLiMa lexical pointer to gold).
  '', 'Paper trail:', 'History check:', 'For the audit trail:', 'Provenance:', 'Follow-up:',
  'Background:', 'Trace request:', 'Looking back:', 'For the record:', 'Timeline check:', 'Context:',
];
const CP_FORMS = [
  'what happened to the {attr} value {staleVal} recorded for {canonical}?',
  "why is {staleVal} no longer listed for {canonical}'s {attr}?",
  "what became of {canonical}'s earlier {attr} value {staleVal}?",
  "how did {canonical}'s {attr} move off {staleVal}?",
  "what event displaced {staleVal} from {canonical}'s {attr}?",
  "which update retired {staleVal} as {canonical}'s {attr}?",
  "what does the change history say about {staleVal} as {canonical}'s {attr}?",
  "when did {staleVal} stop being {canonical}'s {attr}, and on what basis?",
];

function buildBank(qtype, prefixes, forms, joinAsOpener) {
  const variants = [];
  for (let i = 0; i < prefixes.length; i++) {
    for (let j = 0; j < forms.length; j++) {
      const skeleton = joinAsOpener
        ? `${prefixes[i]}, ${forms[j]}`
        : (prefixes[i] === '' ? capitalize(forms[j]) : `${prefixes[i]} ${capitalize(forms[j])}`);
      variants.push({ templateId: `tt_temporal_supersession_${qtype}_o${i}_f${j}`, qtype, skeleton });
    }
  }
  return variants;
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

export const TEMPORAL_TEMPLATE_BANK = {
  current_value: buildBank('current_value', CV_OPENERS, CV_FORMS, true),
  stale_verification: buildBank('stale_verification', SV_PREFIXES, SV_FORMS, false),
  downstream_application: buildBank('downstream_application', DA_PREFIXES, DA_FORMS, false),
  change_provenance: buildBank('change_provenance', CP_PREFIXES, CP_FORMS, false),
};

export function renderTemplate(skeleton, { canonical, attr, staleVal }) {
  return skeleton
    .replaceAll('{canonical}', canonical)
    .replaceAll('{attr}', attr)
    .replaceAll('{staleVal}', staleVal);
}

/** Ancestor row-slot layout (evolve-corpus.mjs queryStubs order, k=5, four
 *  DISTINCT question types — the anti-coverage-indexing core). */
export const TEMPORAL_ROW_SLOTS = [
  'current_value',
  'stale_verification',
  'downstream_application',
  'current_value',
  'change_provenance',
];

/** Seeded-start skip-scan over a template bank honoring (a) GLOBAL m=1 vs the
 *  active index and (b) the per-(family, epoch) disjoint-partition law via
 *  `usedThisEpoch`. Deterministic in (seed, epoch, qtype, cluster, slot). */
function pickTemplate({ bank, seedKey, activeIndex, usedThisEpoch }) {
  const start = Math.floor(prng(seedKey)() * bank.length);
  for (let step = 0; step < bank.length; step++) {
    const v = bank[(start + step) % bank.length];
    if (usedThisEpoch.has(v.templateId)) continue;
    if (indexHasTemplate(activeIndex, v.templateId)) continue;
    return v;
  }
  throw new Error(`bmu temporal: template bank exhausted for seedKey '${seedKey}' (active window too dense — grow the bank or mint fewer clusters)`);
}

/** bmuTask evidence law per question type (§4.2 rationale: "current +
 *  provenance required; stale trap forbidden"; §4.3 mint-time consistency:
 *  required ⊆ qrels≥0.5 — so change doc (0.4) is NOT required on
 *  current-value/downstream types, and both golds ARE required on
 *  stale_verification (1.0 + 0.6)). */
function bmuEvidenceForSlot(qtype, { currentId, changeId, val, staleVal }) {
  switch (qtype) {
    case 'current_value':
    case 'downstream_application':
      return { requiredEvidence: [currentId], answer: { id: currentId, value: val } };
    case 'stale_verification':
      return { requiredEvidence: [changeId, currentId], answer: { id: changeId, value: `no — ${staleVal} was superseded by ${val}` } };
    case 'change_provenance':
      return { requiredEvidence: [changeId], answer: { id: changeId, value: `superseded by ${val}` } };
    default:
      throw new Error(`bmu temporal: unknown question type '${qtype}'`);
  }
}

/** Mint-time no-answer-leak lint (fail-closed; delta 5 in module header). */
function lintCluster({ rows, docs, currentValue, slotValues, goldDocIds }) {
  const goldIds = new Set(goldDocIds);
  const goldDocTexts = new Map(docs.filter((d) => goldIds.has(d.id)).map((d) => [d.id, d.text]));
  for (const row of rows) {
    if (containsValue(row.queryText, currentValue)) {
      throw new Error(`bmu temporal lint: answer value '${currentValue}' leaks into question '${row.queryText}'`);
    }
    for (const [docId, text] of goldDocTexts) {
      const shared = sharedSkeletonNgrams(row.queryText, text, slotValues, 4);
      if (shared.length > 0) {
        throw new Error(`bmu temporal lint: question shares 4-gram skeleton ${JSON.stringify(shared)} with gold doc ${docId}`);
      }
    }
    for (const d of docs) {
      if (d.text.toLowerCase().includes(row.queryText.toLowerCase())) {
        throw new Error(`bmu temporal lint: rendered question is a verbatim substring of public doc ${d.id}`);
      }
    }
  }
}

/**
 * Generate `clusterCount` complete temporal BMU clusters for one epoch.
 * PURE + DETERMINISTIC in (epoch, seed, subjects order, activeIndex state,
 * splitOf) — no Date.now / Math.random.
 *
 * @param {object} opts
 * @param {number}   opts.epoch         synthetic/real epoch id
 * @param {string}   opts.seed          generation seed (pinned)
 * @param {Array}    opts.subjects      [{ id, canonicalName }] — bank state input
 * @param {string}   opts.universe      ownerEntityId scope
 * @param {number}   opts.clusterCount  clusters to mint (≥2 per §6.3 obligation)
 * @param {Function} opts.splitOf       (logicalQueryId, liveUpdateEpoch) => split — CANONICAL splitForRecord composition, injected (purity)
 * @param {object}   [opts.activeIndex] GLOBAL m=1 index (mutated: minted clusters are registered). Defaults to a fresh index.
 * @param {object}   [opts.escalation]  escalationLevelForEpoch overrides
 * @returns {{ clusters: Array, telemetry: object }}
 */
export function generateTemporalClusters({
  epoch,
  seed,
  docIdKeyHex,
  subjects,
  universe,
  clusterCount = 2,
  splitOf,
  activeIndex = createBmuActiveIndex(),
  escalation = {},
  operationSequenceOffset,
}) {
  if (!Number.isInteger(epoch)) throw new Error('bmu temporal: epoch must be an integer');
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('bmu temporal: seed required');
  if (typeof splitOf !== 'function') throw new Error('bmu temporal: splitOf must be the injected canonical splitForRecord composition');
  if (!Array.isArray(subjects) || subjects.length === 0) throw new Error('bmu temporal: subjects bank required');
  if (typeof universe !== 'string' || universe.length === 0) throw new Error('bmu temporal: universe (ownerEntityId) required');
  if (!Number.isInteger(clusterCount) || clusterCount < 1) throw new Error('bmu temporal: clusterCount must be a positive integer');
  if (!Number.isInteger(operationSequenceOffset) || operationSequenceOffset < 0) throw new Error('bmu temporal: operationSequenceOffset must be a non-negative integer');

  const { tsDate, priorDate } = datesForEpoch(epoch);
  const escalationLevel = escalationLevelForEpoch(epoch, escalation);
  const usedTemplatesThisEpoch = new Set(); // §4.1 per-(family, epoch) disjoint partition
  const usedSubjectsThisRun = new Set();
  const usedEntityHoldoutKeysThisRun = new Set();
  const clusters = [];

  const subjectStart = Math.floor(prng(`${seed}:subject-start:${epoch}`)() * subjects.length);

  for (let ordinal = 0; ordinal < clusterCount; ordinal++) {
    // ── Subject pick: seeded-start skip-scan, m=1 GLOBAL (delta 3) ──────────
    let subj = null;
    let entityHoldoutKeys = null;
    for (let step = 0; step < subjects.length; step++) {
      const cand = subjects[(subjectStart + ordinal + step) % subjects.length];
      if (usedSubjectsThisRun.has(cand.id)) continue;
      if (indexHasSubject(activeIndex, cand.id)) continue;
      const candKeys = bmuEntityHoldoutKeysForSubject(cand);
      if (candKeys.some((key) => indexHasEntityHoldoutKey(activeIndex, key) || usedEntityHoldoutKeysThisRun.has(key))) continue;
      subj = cand;
      entityHoldoutKeys = candKeys;
      break;
    }
    if (!subj) {
      throw new Error(`bmu temporal: subject bank exhausted at epoch ${epoch} ordinal ${ordinal} — every subject is in an active cluster (m=1); grow the bank or wait for retirement`);
    }
    usedSubjectsThisRun.add(subj.id);
    for (const key of entityHoldoutKeys) usedEntityHoldoutKeysThisRun.add(key);
    const canonical = subj.canonicalName;
    const isProject = /-svc-/.test(canonical);

    // ── Inherited attribute rotation (one-shot headroom law) ────────────────
    const { attr, bank } = temporalAttributeForEpochSlot(epoch, ordinal, { isProject });
    const rnd = prng(`${seed}:bmu-temporal:${epoch}:${subj.id}:${ordinal}`);
    const val = bank[Math.floor(rnd() * bank.length)];
    let staleVal = bank[Math.floor(rnd() * bank.length)];
    if (staleVal === val) staleVal = bank[(bank.indexOf(val) + 1) % bank.length] ?? `${val}-prior`;
    const decoyVals = [];
    for (let i = 0; decoyVals.length < BMU_TEMPORAL_SHORTCUT_CONTROL_DOCS && i < bank.length * 2; i++) {
      const decoy = bank[(bank.indexOf(staleVal) + 1 + i) % bank.length];
      if (decoy !== val && decoy !== staleVal && !decoyVals.includes(decoy)) decoyVals.push(decoy);
    }
    if (decoyVals.length < BMU_TEMPORAL_SHORTCUT_CONTROL_DOCS) {
      throw new Error(`bmu temporal: value bank cannot supply ${BMU_TEMPORAL_SHORTCUT_CONTROL_DOCS} distinct balanced decoys`);
    }
    const shadowDecoyVals = decoyVals.slice(0, escalationLevel);
    const operationProfile = temporalOperationProfileForCluster(operationSequenceOffset, ordinal);
    const operation = operationProfile.operation;
    const operationFamily = operation.operationClass;
    const operationClass = operation.operationClass;
    const pathEdges = operationProfile.topology;
    const pathClauseFor = (edgeType) => ({
      supports: 'This finding supports the linked review conclusion.',
      supersedes: 'This branch finding supersedes the linked preliminary summary.',
      coreference_of: 'This finding refers to the same case as the linked case marker.',
      co_occurs_with: 'This finding is filed alongside the linked docket entry.',
      causes: 'This finding records the cause of the linked review conclusion.',
      derived_from: 'This finding is derived from the linked review conclusion.',
    }[edgeType]);
    // Terminal (gold) docs describe their actual terminal-depth edge; the
    // depth-1 branch controls describe the branch edge — each clause matches
    // the edge the doc really carries, so the clause is topology-consistent.
    const terminalPathClause = pathClauseFor(operation.operationProgram.steps.at(-1).edgeType);
    const branchPathClause = pathClauseFor(pathEdges.branch);
    const withPathSemantics = (text, clause = terminalPathClause) => `${text} ${clause}`;

    const idBase = `e${epoch}_${subj.id}_bmu${ordinal}`;
    const motifGroupId = `mg_e${epoch}_temporal_${String(ordinal).padStart(4, '0')}_${subj.id}`;
    if (indexHasMotifGroup(activeIndex, motifGroupId)) {
      throw new Error(`bmu temporal: motifGroupId collision '${motifGroupId}' — active index already holds it`);
    }
    const docId = (slot) => opaqueBmuDocId({ docIdKeyHex, seed, epoch, motifGroupId, slot });
    const currentId = docId('current');
    const staleId = docId('stale_trap');
    const changeId = docId('change_provenance');
    const pathPivotId = docId('public_path_pivot');
    const shadowIds = shadowDecoyVals.map((_, i) => docId(`escalation_shadow:${i}`));
    const shortcutControlIds = Array.from(
      { length: BMU_TEMPORAL_SHORTCUT_CONTROL_DOCS },
      (_, i) => docId(`current_unrelated_attribute:${i}`),
    );

    // ── Inherited 3-doc memory structure + qrels (verbatim import) ──────────
    const spec = buildTypedTemporalClusterSpec({
      canonical, subjectId: subj.id, attr, val, staleVal, tsDate, priorDate,
      currentId, staleId, changeId, shadowIds, decoyVals: shadowDecoyVals,
    });

    const terminalText = (role, decoyValue) => {
      if (operationProfile.semantic.id === 'revision_supersession') {
        if (role === 'current') return withPathSemantics(`Revision decision ${tsDate}: the authorized outcome is ${val}. Subject ${canonical}; field ${attr}. The earlier ${staleVal} entry was retired.`);
        if (role === 'change_provenance') return withPathSemantics(`Revision review ${tsDate} approved ${val} and closed the prior ${staleVal} proposal. Subject ${canonical}; field ${attr}.`);
        return withPathSemantics(`Revision review ${tsDate} considered ${decoyValue}, but did not approve that proposal. Subject ${canonical}; field ${attr}.`, branchPathClause);
      }
      if (operationProfile.semantic.id === 'validity_renewal') {
        if (role === 'current') return withPathSemantics(`Validity notice ${tsDate}: scheduled verification confirmed ${val} for the next interval. Subject ${canonical}; field ${attr}.`);
        if (role === 'change_provenance') return withPathSemantics(`Validity review ${tsDate} renewed ${val}; the earlier ${staleVal} entry expired before renewal. Subject ${canonical}; field ${attr}.`);
        return withPathSemantics(`Validity review ${tsDate} examined ${decoyValue}, but did not validate it for the next interval. Subject ${canonical}; field ${attr}.`, branchPathClause);
      }
      if (operationProfile.semantic.id === 'rollback_restoration') {
        if (role === 'current') return withPathSemantics(`Rollback decision ${tsDate}: controls restored ${val} as governing. Subject ${canonical}; field ${attr}. The interim ${staleVal} revision was invalid.`);
        if (role === 'change_provenance') return withPathSemantics(`Rollback audit ${tsDate} invalidated interim ${staleVal} and restored ${val}. Subject ${canonical}; field ${attr}.`);
        return withPathSemantics(`Rollback audit ${tsDate} examined ${decoyValue}, but review did not restore that candidate. Subject ${canonical}; field ${attr}.`, branchPathClause);
      }
      if (role === 'current') return withPathSemantics(`Handoff notice ${tsDate}: the effective transition activates ${val}. Subject ${canonical}; field ${attr}.`);
      if (role === 'change_provenance') return withPathSemantics(`Handoff record ${tsDate} closed ${staleVal} and activated successor ${val}. Subject ${canonical}; field ${attr}.`);
      return withPathSemantics(`Handoff review ${tsDate} listed ${decoyValue}, but that candidate was not activated. Subject ${canonical}; field ${attr}.`, branchPathClause);
    };
    // All terminal branches deliberately share the same public metadata. The
    // only gold/decoy discriminator is branch text seen by Qwen; ids, edge
    // shape, recency, validity, entity ids, kind and flags are balanced.
    const terminalValidity = {
      subjectEntityId: subj.id, attribute: attr,
      validFrom: priorDate, observedAt: `${tsDate}T12:00:00Z`,
    };

    // Doc envelope exactly as the evolve minter stamps it (:749-753).
    const docs = spec.docs.map((doc) => {
      // The ancestor writes validity.supersededBy = currentId on every stale
      // document.  That is an exact answer pointer, so BMU keeps the public
      // validUntil/observedAt semantics and the supersedes relation while
      // removing this one leaking field from generated documents.
      const { supersededBy: _exactAnswerPointer, ...validity } = doc.validity ?? {};
      const isTerminal = doc.role === 'current' || doc.role === 'change_provenance';
      const text = isTerminal ? terminalText(doc.role) : doc.text;
      const emitted = {
        // `role` and role-correlated `kind` are generator-internal only.
        // Emitting either lets an attacker classify a path position without
        // performing the public operation. v2 exposes one neutral envelope.
        id: doc.id, lane: 'deep', kind: 'bmu_public_record', entityIds: [universe, subj.id],
        text, shape: 'temporal_update_record', timestamp: isTerminal ? `${tsDate}T12:00:00Z` : doc.timestamp,
        currentStaleFlag: isTerminal ? true : doc.currentStaleFlag,
        validity: isTerminal ? { ...terminalValidity } : validity,
        liveUpdateEpoch: epoch,
      };
      // Keep construction diagnostics available to the in-process generator
      // tests without serializing a public envelope field.
      Object.defineProperty(emitted, 'role', { value: doc.role, enumerable: false });
      return emitted;
    });
    const pivot = {
      id: pathPivotId, lane: 'deep', kind: 'bmu_public_record', entityIds: [universe, subj.id],
      text: pathEdges.seed === 'causes'
        ? `${operationProfile.semantic.decision}. Review docket ${tsDate} for ${canonical}'s ${attr} was opened because the disputed seed required a decision.`
        : `${operationProfile.semantic.decision}. Source dossier ${tsDate} for ${canonical}'s ${attr} is the record from which the disputed seed was derived.`,
      shape: 'temporal_update_record', timestamp: `${tsDate}T12:00:00Z`, currentStaleFlag: true,
      validity: { ...terminalValidity }, liveUpdateEpoch: epoch,
    };
    Object.defineProperty(pivot, 'role', { value: 'public_path_pivot', enumerable: false });
    docs.push(pivot);
    // Benign current observations for the SAME attribute prevent even an
    // attribute-scoped latest/current metadata ranker from becoming an answer
    // selector. They are
    // deliberately absent from qrels/forbidden sets; the correct operation
    // must scope by the public attribute and follow supersession structure.
    for (let i = 0; i < shortcutControlIds.length; i++) {
      const controlAttr = attr;
      const emitted = {
        id: shortcutControlIds[i], lane: 'deep', kind: 'bmu_public_record',
        entityIds: [universe, subj.id],
        text: terminalText('decoy', decoyVals[i]),
        shape: 'temporal_update_record', timestamp: `${tsDate}T12:00:00Z`,
        currentStaleFlag: true,
        validity: { ...terminalValidity, attribute: controlAttr },
        liveUpdateEpoch: epoch,
      };
      Object.defineProperty(emitted, 'role', { value: 'shortcut_control', enumerable: false });
      docs.push(emitted);
    }
    const goldBranchIds = [currentId, changeId];
    const pathDecoyIds = shortcutControlIds.slice(0, 3);
    // All same-recency/current control observations are forbidden. Leaving
    // the non-path control neutral lets a public recency/currency sorter
    // place {gold + neutral controls} in top-B without ever touching a veto.
    // It remains outside the depth-1 branch layer, but closes that shortcut.
    const shortcutForbiddenIds = [...shortcutControlIds];
    // Deep-terminal disjoint-partition topology (fix 2a): stale lexical seed
    // → pivot on the outgoing step; chain head + three balanced controls hold
    // the depth-1 branch layer; ONLY the two gold terminals hang at terminal
    // depth, so the executed route set equals the row's required evidence and
    // no decoy/forbidden doc is ever routed.
    const pathTopology = buildProgramPathTopology({
      program: operation.operationProgram,
      seedId: staleId,
      sinkIds: [pathPivotId],
      goldIds: goldBranchIds,
      decoyIds: pathDecoyIds,
      midIdFor: (level) => docId(`path_mid:${level}`),
    });
    for (let level = 0; level < pathTopology.midIds.length; level++) {
      const midDoc = {
        id: pathTopology.midIds[level], lane: 'deep', kind: 'bmu_public_record',
        entityIds: [universe, subj.id],
        text: `Neutral review relay ${tsDate}-m${level + 1} for ${canonical}'s ${attr} links the docket's decision filings for a public-path check.`,
        shape: 'temporal_update_record', timestamp: `${tsDate}T12:00:00Z`, currentStaleFlag: true,
        validity: { ...terminalValidity }, liveUpdateEpoch: epoch,
      };
      Object.defineProperty(midDoc, 'role', { value: 'path_mid', enumerable: false });
      docs.push(midDoc);
    }
    const relations = [
      ...pathTopology.relations,
      // Preserve the public supersession relation without making it a gold
      // topology oracle: golds and in-path controls carry the identical edge.
      ...[...goldBranchIds, ...pathDecoyIds].map((src) => ({ src, dst: staleId, type: 'supersedes', label: 'supersedes_candidate' })),
    ];
    // §17.21 round-5: EVERY forbidden doc must be reachable by the executed
    // suppress walk or no program can ever evict it (real-Qwen proof at the
    // r5-evict context: the escalation shadows + the 4th shortcut control sat
    // OFF the topology, were never step-produced, and rode into topB on merit
    // ⇒ forbidden_admitted ⇒ gate floor). Hang each off-topology forbidden doc
    // on a dedicated suppress-reach sink seeded from the SAME stale seed
    // (outgoing step-0 edge) so the depth-1 suppress step produces — and the
    // §18.3 eviction upgrade excludes — all of them. Chunked to the branch cap;
    // the step-0 fan (path pivot + suppress sinks) is cap-checked fail-closed.
    const offTopologyForbiddenIds = [...shortcutControlIds.slice(3), ...shadowIds];
    if (offTopologyForbiddenIds.length > 0) {
      const branchCap = operation.operationProgram.branchLimit;
      const chunks = [];
      for (let i = 0; i < offTopologyForbiddenIds.length; i += branchCap) {
        chunks.push(offTopologyForbiddenIds.slice(i, i + branchCap));
      }
      if (1 + chunks.length > branchCap) {
        throw new Error(`bmu temporal: step-0 fan ${1 + chunks.length} (path pivot + suppress sinks) exceeds branchLimit ${branchCap}`);
      }
      chunks.forEach((chunk, ci) => {
        const suppressSinkId = docId(`public_path_suppress_sink:${ci}`);
        // Deliberately NOT subject-scoped and NOT validity-current: a neutral
        // current subject-scoped doc would enlarge the veto-free pool a public
        // recency/currency sorter can pack into topB (cheap-gate regression).
        const sinkDoc = {
          id: suppressSinkId, lane: 'deep', kind: 'bmu_public_record',
          entityIds: [universe],
          text: `Neutral review holding docket ${priorDate}-x${ci + 1}-r${ordinal} groups parallel superseded observations for a public-path check.`,
          shape: 'temporal_update_record', timestamp: `${priorDate}T12:00:00Z`, currentStaleFlag: false,
          validity: { subjectEntityId: subj.id, attribute: attr, validFrom: priorDate, observedAt: `${priorDate}T12:00:00Z`, validUntil: priorDate }, liveUpdateEpoch: epoch,
        };
        Object.defineProperty(sinkDoc, 'role', { value: 'path_suppress_sink', enumerable: false });
        docs.push(sinkDoc);
        relations.push({ src: staleId, dst: suppressSinkId, type: operation.operationProgram.steps[0].edgeType, label: 'public_path_seed' });
        for (const src of chunk) {
          relations.push({ src, dst: suppressSinkId, type: operation.operationProgram.steps[1].edgeType, label: 'public_path_branch' });
        }
      });
    }

    // ── k=5 rows: inherited qrels per type + template bank + bmuTask ────────
    if (spec.queryStubs.length !== BMU_TEMPORAL_CLUSTER_K) {
      throw new Error(`bmu temporal: ancestor spec emitted ${spec.queryStubs.length} stubs, expected k=${BMU_TEMPORAL_CLUSTER_K}`);
    }
    const forbiddenEvidence = [staleId, ...shortcutForbiddenIds, ...shadowIds];
    const clusterTemplateIds = [];
    const rows = [];
    for (let slot = 0; slot < TEMPORAL_ROW_SLOTS.length; slot++) {
      const qtype = TEMPORAL_ROW_SLOTS[slot];
      const stub = spec.queryStubs[slot];
      if (stub.questionType !== qtype) {
        throw new Error(`bmu temporal: ancestor stub order drift at slot ${slot}: '${stub.questionType}' != '${qtype}'`);
      }
      const variant = pickTemplate({
        bank: TEMPORAL_TEMPLATE_BANK[qtype],
        seedKey: `${seed}:tmpl:${epoch}:${qtype}:${ordinal}:${slot}`,
        activeIndex,
        usedThisEpoch: usedTemplatesThisEpoch,
      });
      usedTemplatesThisEpoch.add(variant.templateId);
      clusterTemplateIds.push(variant.templateId);
      const queryText = renderTemplate(variant.skeleton, { canonical, attr, staleVal });
      const rowId = searchEvalHiddenId({ idBase, slot, splitOf, epoch });
      const { requiredEvidence, answer } = bmuEvidenceForSlot(qtype, { currentId, changeId, val, staleVal });
      rows.push({
        id: rowId, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: BMU_TEMPORAL_LOGICAL_FAMILY, queryText,
        qrels: [
          ...stub.qrels.map((r) => ({ ...r })),
          ...shortcutForbiddenIds.map((docId) => ({ docId, relevance: 0, role: 'recency_currency_control' })),
        ],
        hardNegatives: [
          ...stub.hardNegatives.map((n) => ({ ...n })),
          ...shortcutForbiddenIds.map((docId) => ({ docId, category: 'recency_currency_control' })),
        ],
        publicIntent: {
          atom: 'temporal_cluster', subjectEntityId: subj.id, attribute: attr,
          queryTime: `${tsDate}T23:59:59Z`, selector: `qtype_${qtype}_v${slot}`,
        },
        questionType: qtype, capability: 'temporal_supersession',
        band: escalationLevel > 0 ? 'very_hard' : 'hard',
        operationFamily, operationClass, operationClassBasis: operation.operationClassBasis,
        operationLaw: operation.operationLaw,
        bmuOperationCue: operation.operationCue,
        bmuOperationProgram: operation.operationProgram,
        liveUpdateEpoch: epoch,
        bmuTask: stampExecutableOperationTask({
          family: BMU_TEMPORAL_FAMILY,
          budgetB: BMU_TEMPORAL_BUDGET_B,
          requiredEvidence,
          forbiddenEvidence: [...forbiddenEvidence],
          answer,
          abstain: false,
          motifGroupId,
          templateId: variant.templateId,
          entityHoldoutKeys,
        }, operation),
      });
    }

    // ── Mint-time consistency rule (§4.3) — fail-closed self-check ──────────
    for (const row of rows) {
      const relOf = new Map(row.qrels.map((r) => [r.docId, r.relevance]));
      const negSet = new Set(row.hardNegatives.map((n) => n.docId));
      for (const req of row.bmuTask.requiredEvidence) {
        if ((relOf.get(req) ?? 0) < 0.5) throw new Error(`bmu temporal: required doc ${req} has qrel < 0.5 on row ${row.id}`);
      }
      for (const f of row.bmuTask.forbiddenEvidence) {
        if (!((relOf.get(f) === 0) || negSet.has(f))) throw new Error(`bmu temporal: forbidden doc ${f} not in {qrels=0} ∪ hardNegatives on row ${row.id}`);
      }
    }

    // ── Delta 5: mint-time answer-leak lint ─────────────────────────────────
    lintCluster({
      rows, docs, currentValue: val,
      slotValues: [canonical, attr, val, staleVal, ...decoyVals, subj.id, tsDate, priorDate],
      goldDocIds: [currentId, changeId],
    });

    // ── Register in the GLOBAL m=1 index (fail-closed on any collision) ─────
    registerCluster(activeIndex, {
      motifGroupId, family: BMU_TEMPORAL_FAMILY, subjectEntityId: subj.id,
      templateIds: clusterTemplateIds, entityHoldoutKeys, mintEpoch: epoch,
    });

    clusters.push({
      motifGroupId,
      family: BMU_TEMPORAL_FAMILY,
      logicalFamily: BMU_TEMPORAL_LOGICAL_FAMILY,
      epoch,
      clusterSlot: ordinal,
      subjectEntityId: subj.id,
      canonicalName: canonical,
      attribute: attr,
      currentValue: val,
      staleValue: staleVal,
      decoyValues: [...decoyVals],
      escalationLevel,
      operationFamily,
      operationClass,
      operationClassBasis: operation.operationClassBasis,
      operationLaw: operation.operationLaw,
      bmuOperationCue: operation.operationCue,
      bmuOperationProgram: operation.operationProgram,
      operationSemantic: operationProfile.semantic.id,
      operationTopology: operationProfile.topology.id,
      operationSequence: operationSequenceOffset + ordinal,
      templateIds: [...clusterTemplateIds],
      entityHoldoutKeys: [...entityHoldoutKeys],
      docs,
      relations,
      publicPath: {
        seedId: staleId,
        pivotId: pathPivotId,
        firstEdgeType: pathEdges.seed,
        branchEdgeType: pathEdges.branch,
        terminalEdgeType: operation.operationProgram.steps.at(-1).edgeType,
        midIds: [...pathTopology.midIds],
        terminalBranchIds: [...pathTopology.terminalIds],
        goldBranchIds: [currentId, changeId],
        decoyBranchIds: [...pathDecoyIds],
      },
      rows,
    });
  }

  return {
    clusters,
    telemetry: {
      family: BMU_TEMPORAL_FAMILY,
      epoch,
      escalationLevel,
      clusterCount: clusters.length,
      rowCount: clusters.reduce((n, c) => n + c.rows.length, 0),
      operationFamilyHistogram: clusters.reduce((histo, c) => {
        histo[c.operationFamily] = (histo[c.operationFamily] ?? 0) + 1;
        return histo;
      }, {}),
      questionTypeHistogram: clusters.flatMap((c) => c.rows).reduce((histo, r) => {
        histo[r.questionType] = (histo[r.questionType] ?? 0) + 1;
        return histo;
      }, {}),
    },
  };
}
