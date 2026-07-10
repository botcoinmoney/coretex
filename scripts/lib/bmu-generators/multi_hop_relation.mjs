/**
 * BMU v1 offline generator — family "multi_hop_relation" (incl. bridge /
 * coreference FRAMING per I3: an alias hop is one edge of the path, not its
 * own family).
 * Frozen spec: specs/BMU_SPEC.md rev3.2 (ad7e523) §4.1, §4.2, §5.3, §6.3,
 * §13.2 (cap-boundary rule).
 *
 * DESCENT + DELTAS (invariant I10 — every inherited mechanism cited, every
 * change justified). Descendant of the Stage-3 typed-cluster design law
 * (`scripts/lib/evolve-corpus.mjs`) — one memory structure → k=5 hidden rows
 * of DISTINCT question types — and of the ancestor's multi-hop branches
 * (`decision` :451-472 evidence→supports→decision bridge shape; `coreference`
 * :564-590 alias/memo/ticket hop shape).
 *
 *  INHERITED (mechanism, with citation):
 *   - typed-cluster law (evolve-corpus.mjs:84-106): k=5 rows, ≥4 distinct
 *     question types per cluster, so ONE routing patch lifts multiple types
 *     and per-doc indexing lifts ~none.
 *   - rotation discipline (`temporalAttributeForEpochSlot`, :71-81): a motif
 *     surface is one-shot headroom; `multiHopTopicForEpochSlot` below is the
 *     same qualifier×base grid + " (series N)" anti-exhaustion mechanism over
 *     (topic, targetAttr) pairs instead of temporal attributes.
 *   - `escalationLevelForEpoch` (:199-215): decoy-count difficulty ramp,
 *     imported verbatim.
 *   - doc/row envelope fields (lane/kind/entityIds/shape/timestamp/
 *     liveUpdateEpoch; ownerScoped/subjectEntityId/family/qrels/hardNegatives/
 *     publicIntent/questionType/capability/band/operationFamily) exactly as
 *     the evolve minter stamps them (:697-760), bridge-consumable unchanged.
 *   - eval_hidden id salt-search via common.searchEvalHiddenId (splitOf
 *     INJECTED like the evolve wiring, coretex-epoch-evolve.mjs:583).
 *   - alias/memo coreference hop shape (evolve-corpus.mjs:564-590): the
 *     ancestor's alias-opened-memo-ticket pattern becomes hop 1 of the 3-hop
 *     chain for person subjects.
 *
 *  DELTAS (each forced by the frozen spec):
 *   1. bmuTask stamps (§4.1): requiredEvidence = THE CHAIN (every bridge doc
 *      + the answer doc — §5.3 "pure answer-anchoring without the traversal
 *      evidence does not pay"), forbiddenEvidence = off-path co-occurrence +
 *      chain-breaking decoys, budgetB = 4 (§4.2 "bridge chain of 2-3 +
 *      answer"), family/motifGroupId/templateId. Mint-time consistency rule
 *      (§4.3): required ⊆ {qrels ≥ 0.5}, forbidden ⊆ {qrels = 0} ∪ hardNegs.
 *   2. Grounding-distant answer construction (§5.3, §13.2): the answer doc
 *      (and the second bridge hop) NEVER name the subject, its alias, or the
 *      query topic — `grounding: 'distant'` stamped — and their entityIds
 *      carry ONLY the universe scope (an entityIds tag on a distant doc would
 *      hand the retrieval stack an entity-routing shortcut around the chain).
 *      This is the construction that puts the answer doc outside the
 *      rerankerInputTopK(=64 live) admission cap on the blank state (the
 *      headroom) and inside it only when the substrate's routing admits it —
 *      the §13.2 two-boundary certification is the downstream screen.
 *   3. Forbidden-trap law (§6.5 part 1): the off-path decoy names the
 *      subject + topic + targetAttr with a wrong value (maximal lexical
 *      overlap with every question — it out-ranks honestly on a bare
 *      substrate), and the near-bridge decoy names the REAL last bridge
 *      token with a wrong draft value (breaks the chain at the final hop).
 *      Any of these in top-B zeroes the task; evicting them requires the
 *      routing operation (relation edges + co-occurrence suppression), so
 *      label knowledge alone earns nothing.
 *   4. GLOBAL m=1 (rev3.2 §4.1): subjects AND templates are skipped while in
 *      ANY active cluster (any family) — rotation WAITS FOR RETIREMENT on a
 *      subject (§14.2). Seeded-start skip-scan subject pick as in the
 *      temporal lane module.
 *   5. Template mint-partition law (§4.1/M7): per-question-type banks;
 *      same-family same-epoch clusters carry DISJOINT templateId sets; two
 *      rows share a templateId iff they render the same surface skeleton.
 *   6. Cluster atomicity: every cluster mints exactly CLUSTER_K rows or the
 *      generator THROWS (ancestor allowed partial clusters).
 *   7. Mint-time no-answer-leak lint (fail-closed): the answer value and the
 *      bridge tokens never appear in any question; the answer value appears
 *      in NO public doc except the answer doc; no shared 4-word skeleton
 *      n-gram between a question and the cluster's gold (chain) docs after
 *      slot collapse; no rendered question is a substring of any public doc.
 *      (Qwen-cold-answerable questions = no headroom = certification reject.)
 */
import { escalationLevelForEpoch, TYPED_CLUSTER_ROTATION_BASE_EPOCH } from '../evolve-corpus.mjs';
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

export const BMU_MULTI_HOP_FAMILY = 'multi_hop_relation';        // bmuTask.family / bucketed (§5.6)
export const BMU_MULTI_HOP_LOGICAL_FAMILY = 'multi_session_bridge'; // corpus logicalFamily (§5.6 union member)
export const BMU_MULTI_HOP_BUDGET_B = 4;                          // §4.2 default
export const BMU_MULTI_HOP_CLUSTER_K = 5;                         // spec cluster size law

/**
 * BMU v2 generator contract. These names describe the public topology that
 * is actually minted; they are not scorer selectors. Every class builds the
 * same bounded outgoing→incoming operation with a different truthful
 * semantic and a different public edge vocabulary.
 */
export const BMU_MULTI_HOP_OPERATION_FAMILY = 'outgoing_incoming_shared_sink';
const MULTI_HOP_SEMANTIC_PROFILES = Object.freeze([
  Object.freeze({ key: 'endpoint', truthKind: 'confirmed endpoint' }),
  Object.freeze({ key: 'authority', truthKind: 'ratified authority' }),
  Object.freeze({ key: 'provenance', truthKind: 'verified provenance' }),
  Object.freeze({ key: 'dependency', truthKind: 'active dependency' }),
  Object.freeze({ key: 'custody', truthKind: 'accepted custody record' }),
]);
/** Exactly 36 executable programs. Prose semantics rotate independently. */
export const BMU_MULTI_HOP_OPERATION_CLASSES = Object.freeze(BMU_EXECUTABLE_PROGRAM_BANK.map((program, ordinal) => {
  const semantic = MULTI_HOP_SEMANTIC_PROFILES[ordinal % MULTI_HOP_SEMANTIC_PROFILES.length];
  const operation = executableOperationForFamilySlot(BMU_MULTI_HOP_FAMILY, ordinal * 2);
  return Object.freeze({
    name: operation.operationClass,
    semantic: semantic.key,
    truthKind: semantic.truthKind,
    outgoingEdgeType: program.outgoingEdgeType,
    incomingEdgeType: program.incomingEdgeType,
    topology: ordinal % 2 === 0 ? 'single_sink' : 'dual_sink',
    sinkMultiplicity: ordinal % 2 === 0 ? 1 : 2,
    operation,
  });
}));

export function multiHopOperationClassForSlot(operationClassSlot) {
  if (!Number.isInteger(operationClassSlot) || operationClassSlot < 0) {
    throw new Error('multiHopOperationClassForSlot: non-negative integer slot required');
  }
  return BMU_MULTI_HOP_OPERATION_CLASSES[
    Math.floor(operationClassSlot / 2) % BMU_MULTI_HOP_OPERATION_CLASSES.length
  ];
}

/** Bridge-token vocabulary (ancestor API_HOSTS, evolve-corpus.mjs:34). */
const HOSTS = ['atlas', 'beacon', 'cedar', 'delta', 'ember', 'falcon', 'granite', 'harbor'];

/**
 * Chain-topic rotation (inherited rotation mechanism — module header).
 * Each grid cell is [topic, targetAttr, valueSlug]: the TOPIC is the
 * delegated function (named by the query and hop-1 doc only), the TARGET
 * ATTR is what the question asks for (named by query, answer doc, and
 * decoys alike — so the attr word is never discriminative on its own), and
 * the valueSlug builds the distinctive answer/decoy value tokens.
 */
const MULTI_HOP_QUALIFIERS = [
  'weekday', 'weekend', 'overnight', 'holiday', 'incident', 'release',
  'audit', 'billing', 'onboarding', 'migration', 'failover', 'quarterly',
];
const MULTI_HOP_BASES = [
  ['escalation handling', 'contact endpoint', 'oncall'],
  ['rollback signoff', 'approver seat', 'approver'],
  ['paging coverage', 'duty owner', 'owner'],
];

export function multiHopTopicForEpochSlot(epoch, slot, { baseEpoch = TYPED_CLUSTER_ROTATION_BASE_EPOCH } = {}) {
  const grid = [];
  for (const qualifier of MULTI_HOP_QUALIFIERS) {
    for (const [topicBase, targetAttr, valueSlug] of MULTI_HOP_BASES) {
      grid.push([`${qualifier} ${topicBase}`, targetAttr, valueSlug]);
    }
  }
  const index = (epoch - baseEpoch) * 2 + (slot % 2);
  const cycle = Math.floor(index / grid.length);
  const [topic, targetAttr, valueSlug] = grid[((index % grid.length) + grid.length) % grid.length];
  return { topic: cycle > 0 ? `${topic} (series ${cycle + 1})` : topic, targetAttr, valueSlug };
}

/**
 * §4.1 template banks — surface-form grids per question type.
 * templateId = `tt_multi_hop_<qtype>_o<i>_f<j>` names ONE exact skeleton;
 * same id ⟺ same surface form, by construction.
 *
 * Sizing vs the GLOBAL m=1 window (§4.1): each active cluster consumes 2
 * chain_endpoint_value templates and 1 of each other type. Worst-case active
 * multi-hop clusters ≈ 2-3/epoch × maxAge 32 ≈ 96 ⇒ chain_endpoint_value
 * has 12×12 = 144 variants; the 1-per-cluster types have 12×8 = 96.
 * Exhaustion under heavier minting fail-closes in `pickTemplate`.
 *
 * Wording law (delta 7): questions carry the subject + topic + targetAttr
 * (+ a decoy value for the rejection type), NEVER the answer value, NEVER a
 * bridge token (relay / desk / memo id), and NEVER chain-doc-only vocabulary
 * ("delegation ledger", "duty register", "routes") — the off-path decoy doc,
 * not the chain, is the lexically dominant match (§5.3 trap law).
 */
const EV_OPENERS = [
  'As of now', 'Right now', 'At present', 'Today', 'As of this session',
  'As things stand', 'For current purposes', 'At this point', 'Per the latest state',
  'On the current view', 'For this shift', 'With everything up to date',
];
const EV_FORMS = [
  'which {target} applies for {canonical}’s {topic}?',
  'what {target} is in effect for {canonical}’s {topic}?',
  'which {target} should be used for {canonical}’s {topic}?',
  'what {target} stands for {canonical}’s {topic}?',
  'which {target} covers {canonical}’s {topic}?',
  'what is the approved {target} for {canonical}’s {topic}?',
  'which {target} is assigned for {canonical}’s {topic}?',
  'what {target} holds for {canonical}’s {topic}?',
  'which {target} answers for {canonical}’s {topic}?',
  'what {target} is live for {canonical}’s {topic}?',
  'which {target} carries {canonical}’s {topic}?',
  'what {target} backs {canonical}’s {topic}?',
];
const OR_PREFIXES = [
  '', 'Quick check:', 'Verification:', 'Before paging:', 'Session check:', 'Confirm:',
  'Sanity check:', 'Double-checking:', 'One question:', 'Checking first:', 'To be sure:', 'Re-checking:',
];
const OR_FORMS = [
  'should {decoyVal} be treated as the {target} for {canonical}’s {topic}?',
  'is {decoyVal} actually the {target} for {canonical}’s {topic}?',
  'can {decoyVal} be relied on as the {target} for {canonical}’s {topic}?',
  'does {decoyVal} really hold as {canonical}’s {topic} {target}?',
  'is the mention of {decoyVal} authoritative for {canonical}’s {topic} {target}?',
  'should {canonical}’s {topic} go to {decoyVal} as its {target}?',
  'is {decoyVal} the right {target} to use for {canonical}’s {topic}?',
  'was {decoyVal} ever confirmed as the {target} for {canonical}’s {topic}?',
];
const DR_PREFIXES = [
  '', 'Planning ahead:', 'For the next session:', 'Setup question:', 'Onboarding:', 'Going forward:',
  'Before kickoff:', 'For new work:', 'Provisioning:', 'For the handoff:', 'Next steps:', 'For rollout:',
];
const DR_FORMS = [
  'which {target} should the next session use when acting on {canonical}’s {topic}?',
  'which {target} should downstream work pick up for {canonical}’s {topic}?',
  'which {target} should a fresh session apply for {canonical}’s {topic}?',
  'when handling {canonical}’s {topic}, which {target} should tooling adopt?',
  'which {target} should plans for {canonical}’s {topic} build on?',
  'which {target} should be wired up for {canonical}’s {topic}?',
  'acting for {canonical} on {topic}, which {target} is the one to take?',
  'which {target} should new automation inherit for {canonical}’s {topic}?',
];
const CP_PREFIXES = [
  '', 'Records question:', 'History check:', 'For the audit trail:', 'Provenance:', 'Follow-up:',
  'Background:', 'Trace request:', 'Looking back:', 'For the record:', 'Paper trail:', 'Context:',
];
const CP_FORMS = [
  'what filed arrangement grounds the {target} used for {canonical}’s {topic}?',
  'on what basis was the {target} for {canonical}’s {topic} established?',
  'which arrangement puts {canonical}’s {topic} under its current {target}?',
  'what paperwork ties {canonical}’s {topic} to its {target}?',
  'where does the {target} decision for {canonical}’s {topic} come from?',
  'what filed step connects {canonical}’s {topic} to its {target}?',
  'which arrangement explains who acts as {target} for {canonical}’s {topic}?',
  'what earlier filing set up the {target} path for {canonical}’s {topic}?',
];

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function buildBank(qtype, prefixes, forms, joinAsOpener) {
  const variants = [];
  for (let i = 0; i < prefixes.length; i++) {
    for (let j = 0; j < forms.length; j++) {
      const skeleton = joinAsOpener
        ? `${prefixes[i]}, ${forms[j]}`
        : (prefixes[i] === '' ? capitalize(forms[j]) : `${prefixes[i]} ${capitalize(forms[j])}`);
      variants.push({ templateId: `tt_multi_hop_${qtype}_o${i}_f${j}`, qtype, skeleton });
    }
  }
  return variants;
}

export const MULTI_HOP_TEMPLATE_BANK = {
  chain_endpoint_value: buildBank('chain_endpoint_value', EV_OPENERS, EV_FORMS, true),
  offpath_rejection: buildBank('offpath_rejection', OR_PREFIXES, OR_FORMS, false),
  downstream_routing: buildBank('downstream_routing', DR_PREFIXES, DR_FORMS, false),
  chain_provenance: buildBank('chain_provenance', CP_PREFIXES, CP_FORMS, false),
};

export function renderTemplate(skeleton, { canonical, topic, target, decoyVal }) {
  return skeleton
    .replaceAll('{canonical}', canonical)
    .replaceAll('{topic}', topic)
    .replaceAll('{target}', target)
    .replaceAll('{decoyVal}', decoyVal ?? '');
}

/** Row-slot layout: k=5 rows, FOUR distinct question types (typed-cluster
 *  anti-coverage-indexing law; endpoint doubled like the ancestor's
 *  current_value ×2). */
export const MULTI_HOP_ROW_SLOTS = [
  'chain_endpoint_value',
  'offpath_rejection',
  'downstream_routing',
  'chain_endpoint_value',
  'chain_provenance',
];

/** Seeded-start skip-scan honoring (a) GLOBAL m=1 vs the active index and
 *  (b) the per-(family, epoch) disjoint-partition law via usedThisEpoch. */
function pickTemplate({ bank, seedKey, activeIndex, usedThisEpoch }) {
  const start = Math.floor(prng(seedKey)() * bank.length);
  for (let step = 0; step < bank.length; step++) {
    const v = bank[(start + step) % bank.length];
    if (usedThisEpoch.has(v.templateId)) continue;
    if (indexHasTemplate(activeIndex, v.templateId)) continue;
    return v;
  }
  throw new Error(`bmu multi_hop: template bank exhausted for seedKey '${seedKey}' (active window too dense — grow the bank or mint fewer clusters)`);
}

/** Person/alias convention: ancestor aliasFor (evolve-corpus.mjs:378) —
 *  first token of the canonical name. Projects (`-svc-`) have no natural
 *  alias, so their 3-hop chains use a plain (non-coreference) memo hop. */
function aliasFor(canonicalName) {
  return String(canonicalName).split(/\s+/)[0] ?? canonicalName;
}

/** Mint-time no-answer-leak + grounding-distance lint (delta 7; fail-closed). */
function lintCluster({ rows, docs, chainDocIds, answerDocId, value, bridgeTokens, distantForbidden, slotValues }) {
  const goldDocs = docs.filter((d) => chainDocIds.includes(d.id));
  for (const row of rows) {
    if (containsValue(row.queryText, value)) {
      throw new Error(`bmu multi_hop lint: answer value '${value}' leaks into question '${row.queryText}'`);
    }
    for (const tok of bridgeTokens) {
      if (containsValue(row.queryText, tok)) {
        throw new Error(`bmu multi_hop lint: bridge token '${tok}' leaks into question '${row.queryText}' (route must be memory, not lexical)`);
      }
    }
    for (const gold of goldDocs) {
      const shared = sharedSkeletonNgrams(row.queryText, gold.text, slotValues, 4);
      if (shared.length > 0) {
        throw new Error(`bmu multi_hop lint: question shares 4-gram skeleton ${JSON.stringify(shared)} with chain doc ${gold.id}`);
      }
    }
    for (const d of docs) {
      if (d.text.toLowerCase().includes(row.queryText.toLowerCase())) {
        throw new Error(`bmu multi_hop lint: rendered question is a verbatim substring of public doc ${d.id}`);
      }
    }
  }
  for (const d of docs) {
    if (d.id !== answerDocId && containsValue(d.text, value)) {
      throw new Error(`bmu multi_hop lint: answer value '${value}' appears in non-answer doc ${d.id}`);
    }
  }
  for (const d of docs) {
    if (d.grounding !== 'distant') continue;
    for (const banned of distantForbidden) {
      if (banned && containsValue(d.text, banned)) {
        throw new Error(`bmu multi_hop lint: grounding-distant doc ${d.id} names '${banned}' (must stay lexically distant from the query surface)`);
      }
    }
  }
}

/**
 * Generate `clusterCount` complete multi_hop_relation BMU clusters for one
 * epoch. PURE + DETERMINISTIC in (epoch, seed, subjects order, activeIndex
 * state, splitOf) — no Date.now / Math.random.
 *
 * Public path shapes are chosen by the rotating operation-class bank:
 *   anchor --outgoing--> one|two neutral sinks <--incoming-- sibling branches.
 * The hidden semantic chain remains subject/memo/answer-shaped for judge
 * construction, while every public sink carries one truth and balanced
 * textual decoys with identical structural observables.
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
 * @param {number}   [opts.operationClassSlotOffset] persistent minted-cluster
 *                   cursor; adjacent cursor slots deliberately repeat a class
 * @returns {{ clusters: Array, telemetry: object }}
 */
export function generateMultiHopClusters({
  epoch,
  seed,
  docIdKeyHex,
  subjects,
  universe,
  clusterCount = 2,
  splitOf,
  activeIndex = createBmuActiveIndex(),
  escalation = {},
  operationClassSlotOffset = Math.max(0, (epoch - TYPED_CLUSTER_ROTATION_BASE_EPOCH) * 2),
}) {
  if (!Number.isInteger(epoch)) throw new Error('bmu multi_hop: epoch must be an integer');
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('bmu multi_hop: seed required');
  if (typeof splitOf !== 'function') throw new Error('bmu multi_hop: splitOf must be the injected canonical splitForRecord composition');
  if (!Array.isArray(subjects) || subjects.length === 0) throw new Error('bmu multi_hop: subjects bank required');
  if (typeof universe !== 'string' || universe.length === 0) throw new Error('bmu multi_hop: universe (ownerEntityId) required');
  if (!Number.isInteger(clusterCount) || clusterCount < 1) throw new Error('bmu multi_hop: clusterCount must be a positive integer');
  if (!Number.isInteger(operationClassSlotOffset) || operationClassSlotOffset < 0) throw new Error('bmu multi_hop: operationClassSlotOffset must be a non-negative integer');

  const { tsDate } = datesForEpoch(epoch);
  const escalationLevel = escalationLevelForEpoch(epoch, escalation);
  const usedTemplatesThisEpoch = new Set(); // §4.1 per-(family, epoch) disjoint partition
  const usedSubjectsThisRun = new Set();
  const usedEntityHoldoutKeysThisRun = new Set();
  const clusters = [];

  const subjectStart = Math.floor(prng(`${seed}:mh-subject-start:${epoch}`)() * subjects.length);

  for (let ordinal = 0; ordinal < clusterCount; ordinal++) {
    // ── Subject pick: seeded-start skip-scan, m=1 GLOBAL (delta 4) ──────────
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
      throw new Error(`bmu multi_hop: subject bank exhausted at epoch ${epoch} ordinal ${ordinal} — every subject is in an active cluster (m=1); grow the bank or wait for retirement`);
    }
    usedSubjectsThisRun.add(subj.id);
    for (const key of entityHoldoutKeys) usedEntityHoldoutKeysThisRun.add(key);
    const canonical = subj.canonicalName;
    const isProject = /-svc-/.test(canonical);
    const alias = aliasFor(canonical);

    // ── Inherited rotation (topic/target grid; one-shot headroom law) ───────
    const { topic, targetAttr, valueSlug } = multiHopTopicForEpochSlot(epoch, ordinal);
    const rnd = prng(`${seed}:bmu-multihop:${epoch}:${subj.id}:${ordinal}`);
    const hostAt = () => HOSTS[Math.floor(rnd() * HOSTS.length)];

    // Operation class is selected BEFORE document text/ids are built and
    // controls the actual edge type of every branch. It is therefore a
    // deterministic topology decision, not a label inferred from gold roles.
    const operationPlan = multiHopOperationClassForSlot(operationClassSlotOffset + ordinal);
    const operation = operationPlan.operation;
    const operationFamily = BMU_MULTI_HOP_OPERATION_FAMILY;
    const operationClass = operation.operationClass;
    const hopCount = operationPlan.sinkMultiplicity === 1 ? 2 : 3;
    const corefFramed = hopCount === 3 && !isProject;
    const relayToken = `${hostAt()}-relay-${epoch}r${ordinal}`;
    const deskToken = `${hostAt()}-desk-${epoch}r${ordinal}`;
    const ticket = `dm-${epoch}r${ordinal}-${100 + Math.floor(rnd() * 900)}`;

    // Distinct-by-suffix value tokens (deterministic; hosts may repeat).
    const value = `${hostAt()}-${valueSlug}-${epoch}a${ordinal}`;
    const decoyVal = `${hostAt()}-${valueSlug}-${epoch}b${ordinal}`;
    const decoyVal2 = `${hostAt()}-${valueSlug}-${epoch}c${ordinal}`;
    const shadowVals = [];
    for (let i = 0; i < escalationLevel; i++) shadowVals.push(`${hostAt()}-${valueSlug}-${epoch}d${ordinal}s${i}`);

    const idBase = `e${epoch}_${subj.id}_bmh${ordinal}`;
    const motifGroupId = `mg_e${epoch}_multi_hop_${String(ordinal).padStart(4, '0')}_${subj.id}`;
    if (indexHasMotifGroup(activeIndex, motifGroupId)) {
      throw new Error(`bmu multi_hop: motifGroupId collision '${motifGroupId}' — active index already holds it`);
    }
    const docId = (slot) => opaqueBmuDocId({ docIdKeyHex, seed, epoch, motifGroupId, slot });
    const b1Id = docId('chain_hop1');
    const b2Id = docId('chain_hop2');
    const primarySinkIds = [b2Id];
    for (let i = 1; i < operationPlan.sinkMultiplicity; i++) primarySinkIds.push(docId(`chain_hop2_mirror:${i}`));
    const ansId = docId('chain_answer');
    const offpathId = docId('offpath_decoy');
    const nearBridgeId = docId('near_bridge_decoy');
    const shadowIds = shadowVals.map((_, i) => docId(`offpath_shadow:${i}`));
    // Deep-terminal decoy arithmetic: the primary group parks exactly 3
    // depth-1 decoys beside the chain head (4 branches under the cap);
    // overflow decoys fill terminal-free side groups of exactly 4.
    const unbalancedDecoyCount = 2 + shadowIds.length;
    const balanceNeeded = unbalancedDecoyCount <= 3
      ? 3 - unbalancedDecoyCount
      : (4 - ((unbalancedDecoyCount - 3) % 4)) % 4;
    const balanceIds = Array.from({ length: balanceNeeded }, (_, i) => docId(`path_balance_decoy:${i}`));
    const balanceVals = Array.from({ length: balanceNeeded }, (_, i) => `${hostAt()}-${valueSlug}-${epoch}z${ordinal}p${i}`);

    // ── Docs: neutral public envelopes + text-only branch truth ─────────────
    const docs = [];
    const pushDoc = (doc) => {
      // `id` and `text` are the only enumerable per-document differences.
      // Recency, entity tags, kind, shape, and stale flags are identical on
      // truth and decoys, so metadata/recency selectors cannot solve a row.
      const emitted = {
        id: doc.id,
        lane: 'deep', shape: 'bmu_public_record', timestamp: tsDate,
        liveUpdateEpoch: epoch, kind: 'bmu_public_record',
        entityIds: [universe], currentStaleFlag: true, text: doc.text,
      };
      Object.defineProperty(emitted, 'role', { value: doc.role, enumerable: false });
      if (doc.grounding !== undefined) {
        Object.defineProperty(emitted, 'grounding', { value: doc.grounding, enumerable: false });
      }
      docs.push(emitted);
    };
    pushDoc({
      id: b1Id, role: 'chain_hop1',
      text: hopCount === 2
        ? `Delegation review ${tsDate}: comparison docket ${relayToken} was opened for ${canonical}. Its delegated function is ${topic}; the filed branches must be read before choosing an endpoint.`
        : (corefFramed
          ? `${alias} filed review memo ${ticket} on ${tsDate} on behalf of ${canonical}. The memo concerns ${topic} and opens an authority comparison docket.`
          : `Review memo ${ticket}, filed ${tsDate}, was opened for ${canonical}. Its subject is ${topic}, and it establishes an authority comparison docket.`),
    });
    pushDoc({
      id: b2Id, role: hopCount === 3 ? 'chain_hop2' : 'path_pivot', grounding: 'distant',
      text: `Comparison pivot ${hopCount === 2 ? relayToken : deskToken} receives independently filed branches under one neutral docket.`,
    });
    for (let i = 1; i < primarySinkIds.length; i++) {
      pushDoc({
        id: primarySinkIds[i], role: 'path_pivot', grounding: 'distant',
        text: `Mirrored comparison pivot ${hopCount === 2 ? relayToken : deskToken}-${i} receives the same independently filed branches for a second public-path check.`,
      });
    }
    pushDoc({
      id: ansId, role: 'chain_answer', grounding: 'distant',
      text: `The ${operationPlan.truthKind} filing on pivot ${hopCount === 2 ? relayToken : deskToken} records ${value} as the ${targetAttr}; its body says the entry is confirmed and in force.`,
    });
    pushDoc({
      id: offpathId, role: 'offpath_decoy',
      text: `Shared digest about ${canonical}'s ${topic} repeats ${decoyVal} in the ${targetAttr} field for pivot ${hopCount === 2 ? relayToken : deskToken}, but its body says the entry was copied from an unapproved draft.`,
    });
    pushDoc({
      id: nearBridgeId, role: 'near_bridge_decoy',
      text: `A competing filing on pivot ${hopCount === 2 ? relayToken : deskToken} lists ${decoyVal2} as ${targetAttr}; its body says the proposal was rejected and never took effect.`,
    });
    for (let i = 0; i < shadowIds.length; i++) {
      pushDoc({
        id: shadowIds[i], role: 'offpath_shadow',
        text: `A parallel ${targetAttr} filing about ${canonical}'s ${topic} lists ${shadowVals[i]}; the body marks it as superseded before ratification.`,
      });
    }
    for (let i = 0; i < balanceIds.length; i++) {
      pushDoc({
        id: balanceIds[i], role: 'path_balance_decoy',
        text: `A parallel ${targetAttr} filing about ${canonical}'s ${topic} lists ${balanceVals[i]}; the body marks it as a void test entry with no authority.`,
      });
    }

    // ── Relations: deep-terminal disjoint-partition topology (fix 2a) ──────
    // The primary group routes the anchor→sink outgoing step, then walks the
    // incoming chain through neutral mid relays; ONLY the answer terminal
    // hangs at terminal depth, so the executed route set equals the row's
    // operation-required answer terminal. Decoys sit at depth 1 (balanced
    // against the chain head under the branch cap) with no incoming
    // continuation — the decoder admits only TERMINAL branches, so no decoy
    // or forbidden doc is ever routed. Overflow decoys park in terminal-free
    // side groups (anchor→sink plus four depth-1 dead ends).
    const relations = [];
    const allDecoyIds = [offpathId, nearBridgeId, ...shadowIds, ...balanceIds];
    const pathGroups = [];
    const primaryDecoyIds = allDecoyIds.slice(0, 3);
    const primaryTopology = buildProgramPathTopology({
      program: operation.operationProgram,
      seedId: b1Id,
      sinkIds: primarySinkIds,
      goldIds: [ansId],
      decoyIds: primaryDecoyIds,
      midIdFor: (level) => docId(`path_mid:0:${level}`),
    });
    relations.push(...primaryTopology.relations);
    for (let level = 0; level < primaryTopology.midIds.length; level++) {
      pushDoc({
        id: primaryTopology.midIds[level], role: 'path_mid', grounding: 'distant',
        text: `Neutral chain relay ${ticket}-m${level + 1} links the docket's terminal filings for a public-path check.`,
      });
    }
    pathGroups.push({
      anchorId: b1Id, sinkId: primarySinkIds[0], sinkIds: [...primarySinkIds],
      midIds: [...primaryTopology.midIds], truthId: ansId,
      branchIds: [...primaryTopology.terminalIds], decoyIds: primaryDecoyIds,
    });
    for (let i = 3; i < allDecoyIds.length; i += 4) {
      const groupIndex = 1 + (i - 3) / 4;
      const anchorId = docId(`path_anchor:${groupIndex}`);
      const sinkId = docId(`path_sink:${groupIndex}:0`);
      const groupDecoyIds = allDecoyIds.slice(i, i + 4);
      pushDoc({
        id: anchorId, role: 'path_anchor',
        text: `Comparison docket ${groupIndex + 1} for ${canonical}'s ${topic} groups further ${targetAttr} filings for textual review.`,
      });
      pushDoc({
        id: sinkId, role: 'path_pivot', grounding: 'distant',
        text: `Neutral comparison pivot ${ticket}-p${groupIndex}-0 receives the class branches for a public-path check.`,
      });
      relations.push({ src: anchorId, dst: sinkId, type: operationPlan.outgoingEdgeType, label: 'public_path_seed' });
      for (const src of groupDecoyIds) {
        relations.push({ src, dst: sinkId, type: operationPlan.incomingEdgeType, label: 'public_path_branch' });
      }
      pathGroups.push({
        anchorId, sinkId, sinkIds: [sinkId], midIds: [], truthId: null,
        branchIds: [], decoyIds: groupDecoyIds,
      });
    }

    // ── Evidence law (§5.3): required = bridge + answer (not the full 3-hop set).
    // Intermediate hop-2 stays graded support in qrels so routing still pays,
    // but B=4 top-B is not arithmetically over-subscribed by 3 required docs.
    const utilityRequired = [b1Id, ansId];
    const fullChainDocIds = [b1Id, ...primarySinkIds, ansId];
    const forbiddenEvidence = [offpathId, nearBridgeId, ...shadowIds, ...balanceIds];
    const bridgeQrels = [b1Id, b2Id].map((docId) => ({ docId, relevance: 0.6, role: 'bridge' }));
    const decoyQrels = forbiddenEvidence.map((docId) => ({ docId, relevance: 0.0, role: 'same_path_decoy' }));
    const hardNegatives = forbiddenEvidence.map((docId) => ({ docId, category: 'same_path_textual_decoy' }));
    const evidenceForSlot = (qtype) => {
      switch (qtype) {
        case 'chain_endpoint_value':
        case 'downstream_routing':
          return {
            requiredEvidence: [...utilityRequired],
            answer: { id: ansId, value },
            qrels: [{ docId: ansId, relevance: 1.0, role: 'direct' }, ...bridgeQrels, ...decoyQrels],
          };
        case 'offpath_rejection':
          return {
            requiredEvidence: [...utilityRequired],
            answer: { id: ansId, value: `no — the routed ${targetAttr} is ${value}` },
            qrels: [{ docId: ansId, relevance: 1.0, role: 'direct' }, ...bridgeQrels, ...decoyQrels],
          };
        case 'chain_provenance':
          return {
            // Provenance answers on the subject-bearing bridge; keep answer
            // support in required so the row still rewards chain evidence.
            requiredEvidence: [...utilityRequired],
            answer: { id: b1Id, value: hopCount === 2 ? `standing delegation through ${relayToken}` : `delegation memo ${ticket}` },
            qrels: [
              { docId: b1Id, relevance: 1.0, role: 'direct' },
              ...(hopCount === 3 ? [{ docId: b2Id, relevance: 0.6, role: 'bridge' }] : []),
              { docId: ansId, relevance: 0.6, role: 'chain_support' },
              ...decoyQrels,
            ],
          };
        default:
          throw new Error(`bmu multi_hop: unknown question type '${qtype}'`);
      }
    };
    // ── k=5 rows: template bank + bmuTask stamps (deltas 1, 5, 6) ───────────
    const clusterTemplateIds = [];
    const rows = [];
    for (let slot = 0; slot < MULTI_HOP_ROW_SLOTS.length; slot++) {
      const qtype = MULTI_HOP_ROW_SLOTS[slot];
      const variant = pickTemplate({
        bank: MULTI_HOP_TEMPLATE_BANK[qtype],
        seedKey: `${seed}:mh-tmpl:${epoch}:${qtype}:${ordinal}:${slot}`,
        activeIndex,
        usedThisEpoch: usedTemplatesThisEpoch,
      });
      usedTemplatesThisEpoch.add(variant.templateId);
      clusterTemplateIds.push(variant.templateId);
      const queryText = renderTemplate(variant.skeleton, { canonical, topic, target: targetAttr, decoyVal });
      const rowId = searchEvalHiddenId({ idBase, slot, splitOf, epoch });
      const { requiredEvidence, answer, qrels } = evidenceForSlot(qtype);
      rows.push({
        id: rowId, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: BMU_MULTI_HOP_LOGICAL_FAMILY, queryText,
        qrels,
        hardNegatives: hardNegatives.map((n) => ({ ...n })),
        publicIntent: {
          atom: 'multi_hop_chain', subjectEntityId: subj.id, topic,
          targetAttribute: targetAttr, hopCount, queryTime: tsDate,
          selector: `qtype_${qtype}_v${slot}`,
        },
        questionType: qtype, capability: 'relation_traversal',
        band: escalationLevel > 0 ? 'very_hard' : 'hard',
        operationFamily, operationClass, operationClassBasis: operation.operationClassBasis,
        operationLaw: operation.operationLaw,
        bmuOperationCue: operation.operationCue,
        bmuOperationProgram: operation.operationProgram,
        liveUpdateEpoch: epoch,
        bmuTask: stampExecutableOperationTask({
          family: BMU_MULTI_HOP_FAMILY,
          budgetB: BMU_MULTI_HOP_BUDGET_B,
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
    if (rows.length !== BMU_MULTI_HOP_CLUSTER_K) {
      throw new Error(`bmu multi_hop: cluster minted ${rows.length} rows, k=${BMU_MULTI_HOP_CLUSTER_K} is law`);
    }

    // ── Mint-time consistency rule (§4.3) — fail-closed self-check ──────────
    for (const row of rows) {
      const relOf = new Map(row.qrels.map((r) => [r.docId, r.relevance]));
      const negSet = new Set(row.hardNegatives.map((n) => n.docId));
      if (row.bmuTask.requiredEvidence.length > row.bmuTask.budgetB) {
        throw new Error(`bmu multi_hop: |requiredEvidence| ${row.bmuTask.requiredEvidence.length} > budgetB on row ${row.id}`);
      }
      if (!row.bmuTask.requiredEvidence.includes(row.bmuTask.answer.id)) {
        throw new Error(`bmu multi_hop: answer.id ∉ requiredEvidence on row ${row.id}`);
      }
      for (const req of row.bmuTask.requiredEvidence) {
        if ((relOf.get(req) ?? 0) < 0.5) throw new Error(`bmu multi_hop: required doc ${req} has qrel < 0.5 on row ${row.id}`);
      }
      for (const f of row.bmuTask.forbiddenEvidence) {
        if (row.bmuTask.requiredEvidence.includes(f)) throw new Error(`bmu multi_hop: required ∩ forbidden ≠ ∅ on row ${row.id}`);
        if (!((relOf.get(f) === 0) || negSet.has(f))) throw new Error(`bmu multi_hop: forbidden doc ${f} not in {qrels=0} ∪ hardNegatives on row ${row.id}`);
      }
    }

    // ── Delta 7: mint-time answer-leak + grounding-distance lint ────────────
    lintCluster({
      rows, docs, chainDocIds: fullChainDocIds, answerDocId: ansId, value,
      bridgeTokens: [relayToken, deskToken, ticket].filter((t, i) => hopCount === 3 || i === 0),
      distantForbidden: [canonical, corefFramed ? alias : null, topic],
      slotValues: [
        canonical, alias, topic, targetAttr, value, decoyVal, decoyVal2, ...shadowVals, ...balanceVals,
        relayToken, deskToken, ticket, subj.id, tsDate,
      ],
    });

    // ── Register in the GLOBAL m=1 index (fail-closed on any collision) ─────
    registerCluster(activeIndex, {
      motifGroupId, family: BMU_MULTI_HOP_FAMILY, subjectEntityId: subj.id,
      templateIds: clusterTemplateIds, entityHoldoutKeys, mintEpoch: epoch,
    });

    clusters.push({
      motifGroupId,
      family: BMU_MULTI_HOP_FAMILY,
      logicalFamily: BMU_MULTI_HOP_LOGICAL_FAMILY,
      epoch,
      subjectEntityId: subj.id,
      canonicalName: canonical,
      topic,
      targetAttribute: targetAttr,
      operationFamily,
      operationClass,
      operationClassBasis: operation.operationClassBasis,
      operationLaw: operation.operationLaw,
      bmuOperationCue: operation.operationCue,
      bmuOperationProgram: operation.operationProgram,
      operationSemantic: operationPlan.semantic,
      operationTopology: operationPlan.topology,
      hopCount,
      corefFramed,
      bridgeTokens: hopCount === 2 ? [relayToken] : [ticket, deskToken],
      answerValue: value,
      decoyValues: [decoyVal, decoyVal2, ...shadowVals, ...balanceVals],
      escalationLevel,
      templateIds: [...clusterTemplateIds],
      entityHoldoutKeys: [...entityHoldoutKeys],
      docs,
      relations,
      pathGroups: pathGroups.map((group) => ({
        ...group, sinkIds: [...group.sinkIds], decoyIds: [...group.decoyIds],
        midIds: [...group.midIds], branchIds: [...group.branchIds],
      })),
      rows,
    });
  }

  return {
    clusters,
    telemetry: {
      family: BMU_MULTI_HOP_FAMILY,
      epoch,
      escalationLevel,
      clusterCount: clusters.length,
      rowCount: clusters.reduce((n, c) => n + c.rows.length, 0),
      hopCountHistogram: clusters.reduce((histo, c) => {
        histo[c.hopCount] = (histo[c.hopCount] ?? 0) + 1;
        return histo;
      }, {}),
      corefFramedCount: clusters.filter((c) => c.corefFramed).length,
      operationClassHistogram: clusters.reduce((histo, c) => {
        histo[c.operationClass] = (histo[c.operationClass] ?? 0) + 1;
        return histo;
      }, {}),
      questionTypeHistogram: clusters.flatMap((c) => c.rows).reduce((histo, r) => {
        histo[r.questionType] = (histo[r.questionType] ?? 0) + 1;
        return histo;
      }, {}),
    },
  };
}
