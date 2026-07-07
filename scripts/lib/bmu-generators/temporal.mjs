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
  indexHasTemplate,
  indexHasMotifGroup,
  registerCluster,
  searchEvalHiddenId,
  containsValue,
  sharedSkeletonNgrams,
} from './common.mjs';

export const BMU_TEMPORAL_FAMILY = 'temporal';            // bmuTask.family / bucketed (§5.6)
export const BMU_TEMPORAL_LOGICAL_FAMILY = 'temporal_update'; // corpus logicalFamily (§5.6)
export const BMU_TEMPORAL_BUDGET_B = 3;                   // §4.2 default
export const BMU_TEMPORAL_CLUSTER_K = 5;                  // spec cluster size law

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
  '', 'Ledger question:', 'History check:', 'For the audit trail:', 'Provenance:', 'Follow-up:',
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
function lintCluster({ rows, docs, currentValue, slotValues }) {
  const goldDocTexts = new Map(docs.filter((d) => d.role === 'current' || d.role === 'change_provenance').map((d) => [d.id, d.text]));
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
  subjects,
  universe,
  clusterCount = 2,
  splitOf,
  activeIndex = createBmuActiveIndex(),
  escalation = {},
}) {
  if (!Number.isInteger(epoch)) throw new Error('bmu temporal: epoch must be an integer');
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('bmu temporal: seed required');
  if (typeof splitOf !== 'function') throw new Error('bmu temporal: splitOf must be the injected canonical splitForRecord composition');
  if (!Array.isArray(subjects) || subjects.length === 0) throw new Error('bmu temporal: subjects bank required');
  if (typeof universe !== 'string' || universe.length === 0) throw new Error('bmu temporal: universe (ownerEntityId) required');
  if (!Number.isInteger(clusterCount) || clusterCount < 1) throw new Error('bmu temporal: clusterCount must be a positive integer');

  const { tsDate, priorDate } = datesForEpoch(epoch);
  const escalationLevel = escalationLevelForEpoch(epoch, escalation);
  const usedTemplatesThisEpoch = new Set(); // §4.1 per-(family, epoch) disjoint partition
  const usedSubjectsThisRun = new Set();
  const clusters = [];

  const subjectStart = Math.floor(prng(`${seed}:subject-start:${epoch}`)() * subjects.length);

  for (let ordinal = 0; ordinal < clusterCount; ordinal++) {
    // ── Subject pick: seeded-start skip-scan, m=1 GLOBAL (delta 3) ──────────
    let subj = null;
    for (let step = 0; step < subjects.length; step++) {
      const cand = subjects[(subjectStart + ordinal + step) % subjects.length];
      if (usedSubjectsThisRun.has(cand.id)) continue;
      if (indexHasSubject(activeIndex, cand.id)) continue;
      subj = cand;
      break;
    }
    if (!subj) {
      throw new Error(`bmu temporal: subject bank exhausted at epoch ${epoch} ordinal ${ordinal} — every subject is in an active cluster (m=1); grow the bank or wait for retirement`);
    }
    usedSubjectsThisRun.add(subj.id);
    const canonical = subj.canonicalName;
    const isProject = /-svc-/.test(canonical);

    // ── Inherited attribute rotation (one-shot headroom law) ────────────────
    const { attr, bank } = temporalAttributeForEpochSlot(epoch, ordinal, { isProject });
    const rnd = prng(`${seed}:bmu-temporal:${epoch}:${subj.id}:${ordinal}`);
    const val = bank[Math.floor(rnd() * bank.length)];
    let staleVal = bank[Math.floor(rnd() * bank.length)];
    if (staleVal === val) staleVal = bank[(bank.indexOf(val) + 1) % bank.length] ?? `${val}-prior`;
    const decoyVals = [];
    for (let i = 0; decoyVals.length < escalationLevel && i < bank.length; i++) {
      const decoy = bank[(bank.indexOf(staleVal) + 1 + i) % bank.length];
      if (decoy !== val && decoy !== staleVal) decoyVals.push(decoy);
    }

    const idBase = `e${epoch}_${subj.id}_bmu${ordinal}`;
    const motifGroupId = `mg_e${epoch}_temporal_${String(ordinal).padStart(4, '0')}_${subj.id}`;
    if (indexHasMotifGroup(activeIndex, motifGroupId)) {
      throw new Error(`bmu temporal: motifGroupId collision '${motifGroupId}' — active index already holds it`);
    }
    const currentId = `d_${idBase}_cur`;
    const staleId = `d_${idBase}_stale`;
    const changeId = `d_${idBase}_chg`;
    const shadowIds = decoyVals.map((_, i) => `d_${idBase}_sh${i}`);

    // ── Inherited 3-doc memory structure + qrels (verbatim import) ──────────
    const spec = buildTypedTemporalClusterSpec({
      canonical, subjectId: subj.id, attr, val, staleVal, tsDate, priorDate,
      currentId, staleId, changeId, shadowIds, decoyVals,
    });

    // Doc envelope exactly as the evolve minter stamps it (:749-753).
    const docs = spec.docs.map((doc) => ({
      id: doc.id, lane: 'deep', kind: doc.kind, entityIds: [universe, subj.id],
      text: doc.text, shape: 'temporal_update_record', timestamp: doc.timestamp,
      currentStaleFlag: doc.currentStaleFlag, validity: doc.validity,
      liveUpdateEpoch: epoch, role: doc.role,
    }));
    const relations = spec.relations.map((r) => ({ ...r }));

    // ── k=5 rows: inherited qrels per type + template bank + bmuTask ────────
    if (spec.queryStubs.length !== BMU_TEMPORAL_CLUSTER_K) {
      throw new Error(`bmu temporal: ancestor spec emitted ${spec.queryStubs.length} stubs, expected k=${BMU_TEMPORAL_CLUSTER_K}`);
    }
    const forbiddenEvidence = [staleId, ...shadowIds];
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
        qrels: stub.qrels.map((r) => ({ ...r })),
        hardNegatives: stub.hardNegatives.map((n) => ({ ...n })),
        publicIntent: {
          atom: 'temporal_cluster', subjectEntityId: subj.id, attribute: attr,
          queryTime: tsDate, selector: `qtype_${qtype}_v${slot}`,
        },
        questionType: qtype, capability: 'temporal_supersession',
        band: escalationLevel > 0 ? 'very_hard' : 'hard',
        operationFamily: 'temporal_cluster_typed', liveUpdateEpoch: epoch,
        bmuTask: {
          family: BMU_TEMPORAL_FAMILY,
          budgetB: BMU_TEMPORAL_BUDGET_B,
          requiredEvidence,
          forbiddenEvidence: [...forbiddenEvidence],
          answer,
          abstain: false,
          motifGroupId,
          templateId: variant.templateId,
        },
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
    });

    // ── Register in the GLOBAL m=1 index (fail-closed on any collision) ─────
    registerCluster(activeIndex, {
      motifGroupId, family: BMU_TEMPORAL_FAMILY, subjectEntityId: subj.id,
      templateIds: clusterTemplateIds, mintEpoch: epoch,
    });

    clusters.push({
      motifGroupId,
      family: BMU_TEMPORAL_FAMILY,
      logicalFamily: BMU_TEMPORAL_LOGICAL_FAMILY,
      epoch,
      subjectEntityId: subj.id,
      canonicalName: canonical,
      attribute: attr,
      currentValue: val,
      staleValue: staleVal,
      decoyValues: [...decoyVals],
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
      family: BMU_TEMPORAL_FAMILY,
      epoch,
      escalationLevel,
      clusterCount: clusters.length,
      rowCount: clusters.reduce((n, c) => n + c.rows.length, 0),
      questionTypeHistogram: clusters.flatMap((c) => c.rows).reduce((histo, r) => {
        histo[r.questionType] = (histo[r.questionType] ?? 0) + 1;
        return histo;
      }, {}),
    },
  };
}
