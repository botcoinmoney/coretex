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
  indexHasTemplate,
  indexHasMotifGroup,
  registerCluster,
  searchEvalHiddenId,
  containsValue,
  sharedSkeletonNgrams,
} from './common.mjs';

export const BMU_MULTI_HOP_FAMILY = 'multi_hop_relation';        // bmuTask.family / bucketed (§5.6)
export const BMU_MULTI_HOP_LOGICAL_FAMILY = 'multi_session_bridge'; // corpus logicalFamily (§5.6 union member)
export const BMU_MULTI_HOP_BUDGET_B = 4;                          // §4.2 default
export const BMU_MULTI_HOP_CLUSTER_K = 5;                         // spec cluster size law

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
 * Chain shapes (deterministic in ordinal parity — both shapes exercised):
 *   even ordinal → 2-hop: subject →(link)→ relay →(register)→ value
 *   odd ordinal  → 3-hop: subject →(memo, alias-framed for persons)→ ticket
 *                          →(routing)→ desk →(register)→ value
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
export function generateMultiHopClusters({
  epoch,
  seed,
  subjects,
  universe,
  clusterCount = 2,
  splitOf,
  activeIndex = createBmuActiveIndex(),
  escalation = {},
}) {
  if (!Number.isInteger(epoch)) throw new Error('bmu multi_hop: epoch must be an integer');
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('bmu multi_hop: seed required');
  if (typeof splitOf !== 'function') throw new Error('bmu multi_hop: splitOf must be the injected canonical splitForRecord composition');
  if (!Array.isArray(subjects) || subjects.length === 0) throw new Error('bmu multi_hop: subjects bank required');
  if (typeof universe !== 'string' || universe.length === 0) throw new Error('bmu multi_hop: universe (ownerEntityId) required');
  if (!Number.isInteger(clusterCount) || clusterCount < 1) throw new Error('bmu multi_hop: clusterCount must be a positive integer');

  const { tsDate, priorDate } = datesForEpoch(epoch);
  const escalationLevel = escalationLevelForEpoch(epoch, escalation);
  const usedTemplatesThisEpoch = new Set(); // §4.1 per-(family, epoch) disjoint partition
  const usedSubjectsThisRun = new Set();
  const clusters = [];

  const subjectStart = Math.floor(prng(`${seed}:mh-subject-start:${epoch}`)() * subjects.length);

  for (let ordinal = 0; ordinal < clusterCount; ordinal++) {
    // ── Subject pick: seeded-start skip-scan, m=1 GLOBAL (delta 4) ──────────
    let subj = null;
    for (let step = 0; step < subjects.length; step++) {
      const cand = subjects[(subjectStart + ordinal + step) % subjects.length];
      if (usedSubjectsThisRun.has(cand.id)) continue;
      if (indexHasSubject(activeIndex, cand.id)) continue;
      subj = cand;
      break;
    }
    if (!subj) {
      throw new Error(`bmu multi_hop: subject bank exhausted at epoch ${epoch} ordinal ${ordinal} — every subject is in an active cluster (m=1); grow the bank or wait for retirement`);
    }
    usedSubjectsThisRun.add(subj.id);
    const canonical = subj.canonicalName;
    const isProject = /-svc-/.test(canonical);
    const alias = aliasFor(canonical);

    // ── Inherited rotation (topic/target grid; one-shot headroom law) ───────
    const { topic, targetAttr, valueSlug } = multiHopTopicForEpochSlot(epoch, ordinal);
    const rnd = prng(`${seed}:bmu-multihop:${epoch}:${subj.id}:${ordinal}`);
    const hostAt = () => HOSTS[Math.floor(rnd() * HOSTS.length)];

    const hopCount = ordinal % 2 === 0 ? 2 : 3;
    const corefFramed = hopCount === 3 && !isProject;
    const relayToken = `${hostAt()}-relay-${epoch}r${ordinal}`;
    const deskToken = `${hostAt()}-desk-${epoch}r${ordinal}`;
    const ticket = `dm-${epoch}r${ordinal}-${100 + Math.floor(rnd() * 900)}`;
    const lastBridgeToken = hopCount === 2 ? relayToken : deskToken;
    const wrongRelay = `${hostAt()}-relay-${epoch}x${ordinal}`;

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
    const b1Id = `d_${idBase}_b1`;
    const b2Id = `d_${idBase}_b2`;
    const ansId = `d_${idBase}_ans`;
    const offpathId = `d_${idBase}_op`;
    const nearBridgeId = `d_${idBase}_nb`;
    const shadowIds = shadowVals.map((_, i) => `d_${idBase}_sh${i}`);

    // ── Docs: the chain + the forbidden traps (deltas 2, 3) ─────────────────
    const docs = [];
    const pushDoc = (doc) => docs.push({
      lane: 'deep', shape: 'multi_session_bridge_record', timestamp: tsDate,
      liveUpdateEpoch: epoch, ...doc,
    });
    if (hopCount === 2) {
      pushDoc({
        id: b1Id, kind: 'bridge_link_record', role: 'chain_hop1',
        entityIds: [universe, subj.id], currentStaleFlag: true,
        text: `Delegation ledger entry ${tsDate}: ${canonical}'s ${topic} is handled through relay ${relayToken} under the standing assignment.`,
      });
    } else {
      pushDoc({
        id: b1Id, kind: 'bridge_link_record', role: 'chain_hop1',
        entityIds: [universe, subj.id], currentStaleFlag: true,
        text: corefFramed
          ? `${alias} filed delegation memo ${ticket} on ${tsDate} taking charge of ${canonical}'s ${topic}, and the memo governs it going forward.`
          : `Delegation memo ${ticket}, filed ${tsDate}, takes charge of ${canonical}'s ${topic} and governs it going forward.`,
      });
      pushDoc({
        id: b2Id, kind: 'bridge_hop_record', role: 'chain_hop2', grounding: 'distant',
        entityIds: [universe], currentStaleFlag: true,
        text: `Routing sheet: memo ${ticket} sends its subject matter to desk ${deskToken} for handling and resolution.`,
      });
    }
    pushDoc({
      id: ansId, kind: 'bridge_target_record', role: 'chain_answer', grounding: 'distant',
      entityIds: [universe], currentStaleFlag: true,
      text: hopCount === 2
        ? `Relay ${relayToken}'s duty register lists ${value} as the confirmed ${targetAttr}.`
        : `Desk ${deskToken}'s duty register lists ${value} as the confirmed ${targetAttr}.`,
    });
    pushDoc({
      id: offpathId, kind: 'bridge_offpath_digest', role: 'offpath_decoy',
      entityIds: [universe, subj.id], currentStaleFlag: false,
      text: `The weekly shared digest mentions ${canonical}'s ${topic} alongside relay ${wrongRelay}, noting ${decoyVal} as the working ${targetAttr} in passing.`,
    });
    pushDoc({
      id: nearBridgeId, kind: 'bridge_draft_note', role: 'near_bridge_decoy',
      entityIds: [universe], currentStaleFlag: false,
      text: `A draft planning note for ${hopCount === 2 ? 'relay' : 'desk'} ${lastBridgeToken} pencils in ${decoyVal2} as ${targetAttr}, pending confirmation and not yet entered anywhere.`,
    });
    for (let i = 0; i < shadowIds.length; i++) {
      pushDoc({
        id: shadowIds[i], kind: 'bridge_offpath_digest', role: 'offpath_shadow',
        entityIds: [universe, subj.id], currentStaleFlag: false,
        text: `An older digest excerpt from ${priorDate} pairs ${canonical}'s ${topic} with ${shadowVals[i]} for the ${targetAttr}, without any assignment behind it.`,
      });
    }

    // ── Relations: the chain edges + the measured noise-edge hazard ─────────
    const relations = [];
    if (hopCount === 2) {
      relations.push({ src: b1Id, dst: ansId, type: 'supports', label: 'routes_to' });
    } else {
      relations.push({ src: b1Id, dst: b2Id, type: 'supports', label: 'delegates_to' });
      relations.push({ src: b2Id, dst: ansId, type: 'supports', label: 'routes_to' });
    }
    relations.push({ src: offpathId, dst: b1Id, type: 'co_occurs_with', label: 'co_mentioned' });
    relations.push({ src: nearBridgeId, dst: ansId, type: 'co_occurs_with', label: 'draft_variant' });
    for (const shadowId of shadowIds) {
      relations.push({ src: shadowId, dst: b1Id, type: 'co_occurs_with', label: 'digest_mention' });
    }

    // ── Evidence law (delta 1): required = THE CHAIN ─────────────────────────
    const chainDocIds = hopCount === 2 ? [b1Id, ansId] : [b1Id, b2Id, ansId];
    const forbiddenEvidence = [offpathId, nearBridgeId, ...shadowIds];
    const bridgeQrels = (hopCount === 2 ? [b1Id] : [b1Id, b2Id]).map((docId) => ({ docId, relevance: 0.6, role: 'bridge' }));
    const decoyQrels = [
      { docId: offpathId, relevance: 0.0, role: 'offpath_decoy' },
      { docId: nearBridgeId, relevance: 0.0, role: 'near_bridge_decoy' },
      ...shadowIds.map((docId) => ({ docId, relevance: 0.0, role: 'offpath_shadow' })),
    ];
    const hardNegatives = [
      { docId: offpathId, category: 'co_occurrence_offpath_exact_terms' },
      { docId: nearBridgeId, category: 'bridge_break_draft' },
      ...shadowIds.map((docId) => ({ docId, category: 'co_occurrence_offpath' })),
    ];
    const evidenceForSlot = (qtype) => {
      switch (qtype) {
        case 'chain_endpoint_value':
        case 'downstream_routing':
          return {
            requiredEvidence: [...chainDocIds],
            answer: { id: ansId, value },
            qrels: [{ docId: ansId, relevance: 1.0, role: 'direct' }, ...bridgeQrels, ...decoyQrels],
          };
        case 'offpath_rejection':
          return {
            requiredEvidence: [...chainDocIds],
            answer: { id: ansId, value: `no — the routed ${targetAttr} is ${value}` },
            qrels: [{ docId: ansId, relevance: 1.0, role: 'direct' }, ...bridgeQrels, ...decoyQrels],
          };
        case 'chain_provenance':
          return {
            requiredEvidence: [...chainDocIds],
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
        operationFamily: 'multi_hop_relation_chain', liveUpdateEpoch: epoch,
        bmuTask: {
          family: BMU_MULTI_HOP_FAMILY,
          budgetB: BMU_MULTI_HOP_BUDGET_B,
          requiredEvidence,
          forbiddenEvidence: [...forbiddenEvidence],
          answer,
          abstain: false,
          motifGroupId,
          templateId: variant.templateId,
        },
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
      rows, docs, chainDocIds, answerDocId: ansId, value,
      bridgeTokens: [relayToken, deskToken, ticket].filter((t, i) => hopCount === 3 || i === 0),
      distantForbidden: [canonical, corefFramed ? alias : null, topic],
      slotValues: [
        canonical, alias, topic, targetAttr, value, decoyVal, decoyVal2, ...shadowVals,
        relayToken, deskToken, ticket, wrongRelay, subj.id, tsDate, priorDate,
      ],
    });

    // ── Register in the GLOBAL m=1 index (fail-closed on any collision) ─────
    registerCluster(activeIndex, {
      motifGroupId, family: BMU_MULTI_HOP_FAMILY, subjectEntityId: subj.id,
      templateIds: clusterTemplateIds, mintEpoch: epoch,
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
      hopCount,
      corefFramed,
      bridgeTokens: hopCount === 2 ? [relayToken] : [ticket, deskToken],
      answerValue: value,
      decoyValues: [decoyVal, decoyVal2, ...shadowVals],
      escalationLevel,
      templateIds: [...clusterTemplateIds],
      docs,
      relations,
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
      questionTypeHistogram: clusters.flatMap((c) => c.rows).reduce((histo, r) => {
        histo[r.questionType] = (histo[r.questionType] ?? 0) + 1;
        return histo;
      }, {}),
    },
  };
}
