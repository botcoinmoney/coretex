/**
 * Deterministic live-update corpus evolution — the churn "fuel" for plateau resistance.
 *
 * `evolveCorpusDelta({ baseLogical, epoch, seed, churnFraction })` is a PURE function: it appends
 * superseding / contradicting memories + subject-grounded queries to a SEEDED subset of EXISTING
 * subjects, creating NEW minable temporal/conflict structure each epoch (DGEN-1 chains are born
 * complete, so static churn rotation creates ~0 new work; this revises HELD facts over time).
 *
 * Designed to run as a DYNAMIC epoch event inside the CoreTex pipeline (NOT a manual regen): the
 * epoch-rotation step calls this with (prevCorpus, epoch, pinned seed), embeds `addedDocs` on the
 * pinned bi-encoder, feeds the result through `buildCorpusDelta` → new corpusRoot, then triggers
 * baseline recompute + major_delta_grace. Replayable: no Date/Math.random — same (base, epoch, seed)
 * → byte-identical delta, so any verifier reconstructs the same corpusRoot.
 *
 * This module is the LOGICAL-delta generator (text + structure, CPU-deterministic). The embedding +
 * production-event + corpusRoot step is the epoch-runner wiring.
 */
import { createHash } from 'node:crypto';

const h = (s) => createHash('sha256').update(s).digest();
const unit = (s) => h(s).readUInt32BE(0) / 4294967296; // deterministic [0,1)
function prng(seedStr) { let st = h(seedStr).readUInt32BE(0); return () => { st = (Math.imul(st ^ (st >>> 15), 0x2c1b3c6d) + 1) >>> 0; return st / 4294967296; }; }

// NO split field is emitted on delta records. Splits are assigned downstream by the CANONICAL
// splitForRecord(id, corpusEpoch) (in build-v2-production-corpus.mjs / the production-delta converter),
// the single source buildCorpusDelta validates against — so a live-update delta can never carry a
// noncanonical split into the production corpus.

const CITIES = ['Oslo', 'Lagos', 'Quito', 'Hanoi', 'Cairo', 'Lima', 'Riga', 'Accra', 'Sofia', 'Tunis', 'Osaka', 'Perth'];
const PKGS = ['pnpm', 'npm', 'yarn', 'bun', 'pip', 'poetry', 'cargo', 'maven'];
const DIETS = ['vegetarian', 'vegan', 'pescatarian', 'gluten-free', 'low-sodium', 'kosher', 'halal', 'omnivore'];
const LANGUAGES = ['TypeScript', 'Python', 'Rust', 'Go', 'Java', 'Kotlin', 'Elixir', 'Scala'];
const RUNTIMES = ['node22', 'python3.11', 'jvm21', 'wasmtime', 'deno2', 'bun1'];
const API_HOSTS = ['atlas', 'beacon', 'cedar', 'delta', 'ember', 'falcon', 'granite', 'harbor'];
const VALIDITY_SHADOW_COLORS = ['amber', 'silver', 'copper', 'violet'];
/**
 * Per-epoch temporal ATTRIBUTE rotation — required for headroom, and the N2 breadth axis.
 *
 * Scorer law (temporalMotifAdmission, live profile): once ANY substrate temporal record
 * references docs with validity.attribute = A, EVERY temporal query on attribute A is
 * corpus-oracle modulated (traps suppressed, currents boosted) — pool-wide, cross-subject,
 * and PERSISTENTLY (the substrate outlives the advance and the rebaseline absorbs the lift).
 * Consequences, both verified live 2026-07-02:
 *   - an attribute is ONE-SHOT headroom: the first accepted record covering A captures every
 *     present-and-future cluster on A (bare `city`, `diet`, `package manager` are already
 *     burned by live substrate records — never mint hidden clusters on them);
 *   - fresh headroom therefore requires a FRESH attribute string per epoch. Rotation makes
 *     the benchmark broaden over the attribute space (N2) instead of re-indexing one motif.
 * Composition: qualifier × base grid (fully deterministic in epoch). Two attributes per
 * epoch (cluster parity) so each epoch offers two independent mineable memory operations.
 * Past one full grid cycle, a " (series N)" suffix keeps attribute strings fresh forever —
 * the runway does not exhaust.
 */
const TEMPORAL_ROTATION_QUALIFIERS = [
  'commute', 'billing', 'travel', 'clinic', 'delivery', 'records',
  'appointment', 'insurance', 'weekday', 'weekend', 'training', 'emergency',
];
const TEMPORAL_ROTATION_BASES_PERSON = [
  ['city', CITIES],
  ['diet', DIETS],
  ['language', LANGUAGES],
];
const TEMPORAL_ROTATION_BASES_PROJECT = [
  ['region', CITIES],
  ['runtime', RUNTIMES],
  ['language', LANGUAGES],
];

export const TYPED_CLUSTER_ROTATION_BASE_EPOCH = 133;

export function temporalAttributeForEpochSlot(epoch, slot, { isProject = false, baseEpoch = TYPED_CLUSTER_ROTATION_BASE_EPOCH } = {}) {
  const bases = isProject ? TEMPORAL_ROTATION_BASES_PROJECT : TEMPORAL_ROTATION_BASES_PERSON;
  const grid = [];
  for (const qualifier of TEMPORAL_ROTATION_QUALIFIERS) {
    for (const [base, bank] of bases) grid.push([`${qualifier} ${base}`, bank]);
  }
  const index = (epoch - baseEpoch) * 2 + (slot % 2);
  const cycle = Math.floor(index / grid.length);
  const [attr, bank] = grid[((index % grid.length) + grid.length) % grid.length];
  return { attr: cycle > 0 ? `${attr} (series ${cycle + 1})` : attr, bank };
}

/**
 * Typed cluster question set — the anti-coverage-indexing core of hidden-eval minting.
 *
 * A cluster is ONE supersession memory structure (subject, attribute, staleVal→val at tsDate)
 * rendered as three public docs (current record, stale trap, change-provenance record) plus
 * escalation shadows, and FIVE hidden queries spanning FOUR DISTINCT QUESTION TYPES — not
 * paraphrases. One meaningful ≤4-cell miner patch (anchor stale revoked + anchor current +
 * temporal record) must lift multiple TYPES: the trap sinks (temporalStaleSuppression), the
 * current-event docs float (temporalCurrentBoost), and each type's gold/grading is wired so
 * that this single memory operation — not per-doc indexing — is what clears them. Scorer-law
 * facts this design is built against (retrieval-benchmark, live profile):
 *   - stale truth docs are relevance-ZEROED on temporal queries (temporalStaleContrast), so a
 *     type whose gold is the stale doc is unliftable by construction — none is minted;
 *   - the temporal record reaches only the anchored events' own docs, subject+attribute-scoped
 *     via doc `validity` (temporalRecordAppliesToQuery), so every doc carries validity;
 *   - raw routing anchors are disabled, so an anchor-only (indexing) patch is inert — the
 *     indexing-only control in the G1 harness must measure Δ0.
 */
export const TEMPORAL_CLUSTER_QUESTION_TYPES = [
  'current_value',
  'change_provenance',
  'downstream_application',
  'stale_verification',
];

/**
 * Pure typed-cluster spec: docs/relations/query stubs for one supersession structure.
 * Shared by the eval-hidden minter, the unit tests, and the offline G1 mineability harness
 * (.ops/coretex-stage3-typed-cluster-g1.mjs in the coordinator repo) so what is validated
 * offline is byte-for-byte what production mints.
 */
export function buildTypedTemporalClusterSpec({ canonical, subjectId, attr, val, staleVal, tsDate, priorDate, currentId, staleId, changeId, shadowIds = [], decoyVals = [] }) {
  const docs = [
    { id: currentId, kind: `temporal_${attr}`, role: 'current',
      text: `${canonical}'s supersession ledger records ${attr} ${val} as active after the prior ${attr} entry was replaced (entry ${tsDate}).`,
      timestamp: tsDate, currentStaleFlag: true,
      validity: { subjectEntityId: subjectId, attribute: attr, validFrom: tsDate, observedAt: tsDate } },
    { id: staleId, kind: `temporal_${attr}`, role: 'stale_trap',
      text: `What is ${canonical}'s current ${attr}? The current ${attr} is ${staleVal}, still listed as valid in the ${priorDate} record, and new sessions should keep relying on ${staleVal}.`,
      timestamp: priorDate, currentStaleFlag: false,
      validity: { subjectEntityId: subjectId, attribute: attr, validFrom: '2025-01-01', validUntil: priorDate, observedAt: priorDate, supersededBy: currentId } },
    { id: changeId, kind: `temporal_${attr}_provenance`, role: 'change_provenance',
      text: `Change ledger ${tsDate}: ${canonical}'s ${attr} entry ${staleVal} was superseded and replaced by ${val}; the older ${attr} record no longer applies.`,
      timestamp: tsDate, currentStaleFlag: true,
      validity: { subjectEntityId: subjectId, attribute: attr, validFrom: tsDate, observedAt: tsDate } },
    ...shadowIds.map((shadowId, i) => ({ id: shadowId, kind: `temporal_${attr}`, role: 'escalation_shadow',
      text: `What is ${canonical}'s current ${attr}? The current ${attr} is ${decoyVals[i] ?? `${staleVal}-alt${i}`}, still listed as valid in an earlier note.`,
      timestamp: priorDate, currentStaleFlag: false,
      validity: { subjectEntityId: subjectId, attribute: attr, validFrom: '2025-01-01', validUntil: priorDate, observedAt: priorDate, supersededBy: currentId } })),
  ];
  const relations = [
    { src: currentId, dst: staleId, type: 'supersedes', label: 'supersedes' },
    { src: changeId, dst: staleId, type: 'derived_from', label: 'records_supersession_of' },
    ...shadowIds.map((shadowId) => ({ src: currentId, dst: shadowId, type: 'supersedes', label: 'supersedes' })),
  ];
  const shadowQrels = shadowIds.map((docId) => ({ docId, relevance: 0.0, role: 'stale_shadow' }));
  const shadowNegs = shadowIds.map((docId) => ({ docId, category: 'temporal_stale' }));
  const trapNeg = { docId: staleId, category: 'temporal_stale_exact_terms' };
  const queryStubs = [
    { questionType: 'current_value', variant: 0,
      queryText: `As of now, what ${attr} is recorded for ${canonical}?`,
      qrels: [
        { docId: currentId, relevance: 1.0, role: 'direct' },
        { docId: changeId, relevance: 0.4, role: 'provenance_bridge' },
        { docId: staleId, relevance: 0.0, role: 'stale_trap' },
        ...shadowQrels,
      ],
      hardNegatives: [trapNeg, ...shadowNegs] },
    { questionType: 'stale_verification', variant: 0,
      queryText: `Is ${staleVal} still the valid ${attr} for ${canonical}?`,
      qrels: [
        { docId: changeId, relevance: 1.0, role: 'direct' },
        { docId: currentId, relevance: 0.6, role: 'current_support' },
        { docId: staleId, relevance: 0.0, role: 'stale_trap' },
        ...shadowQrels,
      ],
      hardNegatives: [trapNeg, ...shadowNegs] },
    { questionType: 'downstream_application', variant: 0,
      queryText: `Which ${attr} should ${canonical}'s new sessions rely on?`,
      qrels: [
        { docId: currentId, relevance: 1.0, role: 'direct' },
        { docId: changeId, relevance: 0.4, role: 'provenance_bridge' },
        { docId: staleId, relevance: 0.0, role: 'stale_trap' },
        ...shadowQrels,
      ],
      hardNegatives: [trapNeg, ...shadowNegs] },
    { questionType: 'current_value', variant: 1,
      queryText: `Which ${attr} is on record for ${canonical} right now?`,
      qrels: [
        { docId: currentId, relevance: 1.0, role: 'direct' },
        { docId: changeId, relevance: 0.4, role: 'provenance_bridge' },
        { docId: staleId, relevance: 0.0, role: 'stale_trap' },
        ...shadowQrels,
      ],
      hardNegatives: [trapNeg, ...shadowNegs] },
    { questionType: 'change_provenance', variant: 0,
      queryText: `What happened to the ${attr} entry ${staleVal} recorded for ${canonical}?`,
      qrels: [
        { docId: changeId, relevance: 1.0, role: 'direct' },
        { docId: currentId, relevance: 0.4, role: 'current_bridge' },
        { docId: staleId, relevance: 0.0, role: 'stale_trap' },
        ...shadowQrels,
      ],
      hardNegatives: [trapNeg, ...shadowNegs] },
  ];
  return { docs, relations, queryStubs };
}

/**
 * Capability rotation schedule (N2 ever-improvement): which memory-IR capability the
 * hidden-eval minter targets at a given epoch. Deterministic in epoch — replay-safe.
 * A capability may enter this schedule ONLY behind its own offline real-Qwen G1 gate
 * (mineable under the live profile, controls clean). conflict_resolution /
 * provenance_evidence / relation_traversal are designed next in line; they stay out
 * until their G1 evidence exists.
 */
export const TYPED_CLUSTER_CAPABILITY_SCHEDULE = ['temporal_supersession'];

export function capabilityForEpoch(epoch, schedule = TYPED_CLUSTER_CAPABILITY_SCHEDULE) {
  if (!Array.isArray(schedule) || schedule.length === 0) return 'temporal_supersession';
  return schedule[((epoch % schedule.length) + schedule.length) % schedule.length];
}

/**
 * Difficulty escalation (N2): number of extra stale-shadow decoys minted per cluster grows
 * with epoch, hardening the trap without changing the question types. Deterministic in epoch.
 */
export const TYPED_CLUSTER_ESCALATION_BASE_EPOCH = 133;

export function escalationLevelForEpoch(epoch, { baseEpoch = TYPED_CLUSTER_ESCALATION_BASE_EPOCH, epochsPerLevel = 4, maxLevel = 4 } = {}) {
  if (!Number.isInteger(epoch) || epoch <= baseEpoch) return 0;
  return Math.min(maxLevel, Math.floor((epoch - baseEpoch) / epochsPerLevel));
}
const V16_BRANCH_WEIGHTS = [
  ['temporal', 23],
  ['conflict', 21],
  ['validity_atom', 20],
  ['entity_resolution_atom', 17],
  ['scope_atom', 14],
  ['decision', 1],
  ['relation_lifecycle', 1],
  ['coreference', 1],
  ['noise_suppression', 1],
  ['abstention', 1],
];

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);
}

function publicScopeFor(subj, universe, epoch, label) {
  const base = slug(`${subj.id}_${epoch}_${label}`);
  return {
    projectId: `proj_${base}`,
    sessionId: `sess_${base}`,
    topicId: label.includes('math') ? 'topic_math_project' : label.includes('api') ? 'topic_api_migration' : 'topic_memory',
    taskId: `task_${base}`,
    userScopeId: universe,
  };
}

function pickWeightedBranch(seedKey, weights) {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = unit(seedKey) * total;
  for (const [branch, weight] of weights) {
    cursor -= weight;
    if (cursor < 0) return branch;
  }
  return weights[weights.length - 1]?.[0] ?? 'temporal';
}

function temporalAttrBank(isProject, attr) {
  if (isProject && attr === 'package manager') return PKGS;
  if (isProject && attr === 'deployment region') return CITIES;
  if (isProject && attr === 'language') return LANGUAGES;
  if (isProject && attr === 'runtime') return RUNTIMES;
  if (!isProject && attr === 'diet') return DIETS;
  if (!isProject && attr === 'city') return CITIES;
  return CITIES;
}

/**
 * @param {{
 *   baseLogical: any, epoch: number, seed: string, churnFraction?: number,
 *   retractionFraction?: number,
 *   evalHiddenPolicy?: null | {
 *     splitOf: (logicalQueryId: string, liveUpdateEpoch?: number) => string,
 *     minFreshPerEpoch?: number,
 *     retireAfterEpochs?: number,
 *     maxRetiredPerEpoch?: number,
 *     maxMintedPerEpoch?: number,
 *     excludeRetireIds?: Set<string> | null,
 *   },
 * }} args
 *   - `retractionFraction` (default 0, backwards-compatible): deterministic per-epoch fraction of
 *     EXISTING fact docs that get RETRACTED. Retracted ids are returned in `retractedDocIds`
 *     (callers translate them into CorpusDelta.removedIds) and a continuity-labeled
 *     `retraction_record` tombstone doc is appended to `addedDocs` per retracted fact, following
 *     the existing supersession/staleness pattern. Retracted docs are excluded from the
 *     same-attribute supersession prior map so no later epoch references a removed doc.
 *   - `evalHiddenPolicy` (default null, backwards-compatible): hidden-eval pool turnover.
 *     `splitOf` MUST be the canonical production split assignment (splitForRecord over the
 *     production event id) injected by the caller so the generator stays pure. When set:
 *     fresh `eval_hidden` queries are minted (deterministic id-salt search) until at least
 *     `minFreshPerEpoch` added queries land in eval_hidden, and existing hidden queries older
 *     than `retireAfterEpochs` (mint epoch = liveUpdateEpoch ?? 0) are retired oldest-first into
 *     `retiredQueryIds` (capped at `maxRetiredPerEpoch`, skipping `excludeRetireIds`).
 *     Optional `capabilitySchedule` (string[]) overrides TYPED_CLUSTER_CAPABILITY_SCHEDULE and
 *     `escalation` ({baseEpoch, epochsPerLevel, maxLevel}) overrides the difficulty-escalation
 *     defaults; both stay pure functions of `epoch`.
 * @returns {{ epoch, seed, churnFraction, retractionFraction, addedDocs, addedRelations, addedQueries,
 *   churnedSubjects, retractedDocIds, retiredQueryIds, freshEvalHiddenQueryIds,
 *   hiddenClusterTelemetry: { capability, escalationLevel, clusterCount, questionTypeHistogram,
 *     bandHistogram, clusters }, liveChurnRate }}
 */
export function evolveCorpusDelta({ baseLogical, epoch, seed, churnFraction = 0.1, retractionFraction = 0, evalHiddenPolicy = null }) {
  if (!baseLogical || !Array.isArray(baseLogical.entities)) throw new Error('evolveCorpusDelta: baseLogical.entities required');
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('evolveCorpusDelta: epoch must be a non-negative integer');
  if (typeof seed !== 'string' || !seed) throw new Error('evolveCorpusDelta: seed required');
  if (!Number.isFinite(retractionFraction) || retractionFraction < 0 || retractionFraction > 1) {
    throw new Error('evolveCorpusDelta: retractionFraction must be in [0, 1]');
  }
  if (evalHiddenPolicy && typeof evalHiddenPolicy.splitOf !== 'function') {
    throw new Error('evolveCorpusDelta: evalHiddenPolicy.splitOf must be a function (canonical splitForRecord over the production id)');
  }

  const universe = (baseLogical.entities.find((e) => e.id === 'e_universe') || {}).id || 'e_universe';
  const subjects = baseLogical.entities.filter((e) => e.id !== universe && /_s\d+$/.test(e.id));
  const subjectIndexById = new Map(subjects.map((s, i) => [s.id, i]));
  const hasAtomV16Metadata = baseLogical.dgen1?.atomV16Metadata === true
    || (baseLogical.queries ?? []).some((q) => q.family === 'validity_atom' || q.family === 'scope_atom' || q.family === 'entity_resolution_atom');
  const duplicateByName = new Map();
  for (const e of baseLogical.entities ?? []) {
    const name = String(e.canonicalName ?? '').toLowerCase();
    if (!name) continue;
    const arr = duplicateByName.get(name) ?? [];
    arr.push(e);
    duplicateByName.set(name, arr);
  }
  const duplicateEntityPairs = [...duplicateByName.values()]
    .filter((xs) => xs.length >= 2)
    .map((xs) => {
      const target = xs.find((e) => (e.roleAliases ?? []).some((r) => /api migration lead|backend lead/i.test(r))) ?? xs[0];
      const wrong = xs.find((e) => e.id !== target.id) ?? xs[1];
      return { canonicalName: target.canonicalName, target, wrong };
    })
    .filter((p) => p.target && p.wrong);
  // Prior temporal doc per (subject, attribute) — a stale qrel MUST point at a doc that
  // was about the SAME attribute, else the substrate's current/stale contrast is
  // half-meaningless (see CORPUS_EVOLVE_SEMANTIC_AUDIT.md: 92% of supersessions changed
  // attribute under the old subject-only keying). Attribute is derived from the doc:
  //   - "temporal_${attr}" kind  → attr field directly
  //   - generic v15 doc text     → keyword scan ('diet'/'city'/...)
  const ATTRS_FOR_PERSON = ['city', 'diet'];
  const ATTRS_FOR_PROJECT = ['package manager', 'deployment region', 'language', 'runtime'];
  const attrOfDoc = (d) => {
    const m = (d.kind || '').match(/^temporal_(.+)$/);
    if (m) return m[1];
    // Generic v15 doc text: scan known attribute words
    const text = (d.text || '').toLowerCase();
    if (/\b(?:city|town|metro|location)\b/.test(text)) return 'city';
    if (/\bdiet\b/.test(text)) return 'diet';
    if (/\bpackage manager\b/.test(text)) return 'package manager';
    if (/\bdeployment region\b/.test(text)) return 'deployment region';
    if (/\blanguage\b/.test(text)) return 'language';
    if (/\bruntime\b/.test(text)) return 'runtime';
    return null;
  };
  // Retraction/tombstone selection: a deterministic per-epoch fraction of EXISTING fact docs is
  // withdrawn (security/decay churn — the production caller turns these into removedIds).
  // Tombstone replacement records are emitted after the churn loop; retracted ids are excluded
  // from the supersession prior map so nothing minted this or any later epoch references them.
  const retractedDocIds = [];
  if (retractionFraction > 0) {
    for (const d of baseLogical.docs || []) {
      if ((d.kind ?? '') === 'retraction_record') continue; // never retract a tombstone
      if (unit(`${seed}:retract:${epoch}:${d.id}`) < retractionFraction) retractedDocIds.push(d.id);
    }
  }
  const retractedSet = new Set(retractedDocIds);

  const priorTemporalByAttr = new Map(); // `${sid}::${attr}` → docId (last write wins)
  for (const d of baseLogical.docs || []) {
    if (retractedSet.has(d.id)) continue; // retracted docs must never be supersession priors
    const sid = (d.entityIds || []).find((x) => x !== universe);
    if (!sid) continue;
    if (!/temporal/.test(d.kind || '')) continue;
    const attr = attrOfDoc(d);
    if (!attr) continue;
    priorTemporalByAttr.set(`${sid}::${attr}`, d.id); // last write wins → most recent in file order
  }

  const addedDocs = [], addedRelations = [], addedQueries = [], churnedSubjects = [];
  const tsDate = new Date(new Date('2024-01-01').getTime() + (40 + epoch) * 30 * 86400000).toISOString().slice(0, 10);
  const priorDate = new Date(new Date(tsDate).getTime() - 86400000).toISOString().slice(0, 10);
  const aliasFor = (entity) => (entity.aliases ?? []).find(Boolean) ?? String(entity.canonicalName ?? '').split(/\s+/)[0] ?? entity.id;
  const otherSubjectFor = (subj, rnd) => {
    if (subjects.length <= 1) return subj;
    const idx = subjectIndexById.get(subj.id) ?? 0;
    const off = 1 + Math.floor(rnd() * (subjects.length - 1));
    return subjects[(idx + off) % subjects.length] ?? subj;
  };

  for (const subj of subjects) {
    if (unit(`${seed}:churn:${epoch}:${subj.id}`) >= churnFraction) continue; // deterministic selection
    churnedSubjects.push(subj.id);
    const rnd = prng(`${seed}:${epoch}:${subj.id}`);
    const canonical = subj.canonicalName;
    const isProject = /-svc-/.test(canonical);
    const tagU = [universe, subj.id];
    const idBase = `e${epoch}_${subj.id}`;
    const op = h(`${seed}:op:${epoch}:${subj.id}`).readUInt32BE(0) % 6;
    let branch = hasAtomV16Metadata
      ? pickWeightedBranch(`${seed}:branch-weight:${epoch}:${subj.id}`, V16_BRANCH_WEIGHTS)
      : op <= 1 ? 'temporal'
        : op <= 3 ? 'conflict'
        : op === 4 ? 'decision'
        : 'abstention';
    if (branch === 'entity_resolution_atom' && duplicateEntityPairs.length === 0) branch = 'scope_atom';

    if (branch === 'temporal') {
      // Same-attribute supersession: PREFER an attribute the subject already has a prior
      // temporal doc on (so the stale qrel is genuinely stale-for-this-attribute). Fall
      // back to a deterministic per-epoch attribute when the subject has no prior
      // temporal doc on any known attribute (cold start).
      const candidateAttrs = isProject ? ATTRS_FOR_PROJECT : ATTRS_FOR_PERSON;
      let attr = candidateAttrs.find((a) => priorTemporalByAttr.has(`${subj.id}::${a}`));
      if (!attr) attr = candidateAttrs[Math.floor(rnd() * candidateAttrs.length)];
      const bank = isProject && attr === 'package manager' ? PKGS : CITIES;
      const val = bank[Math.floor(rnd() * bank.length)];
      let staleVal = bank[Math.floor(rnd() * bank.length)];
      if (staleVal === val) staleVal = bank[(bank.indexOf(val) + 1) % bank.length] ?? `${val}-prior`;
      const docId = `d_${idBase}_t`, staleShadowId = `d_${idBase}_tx`, qid = `q_${idBase}_t`;
      addedDocs.push({ id: docId, lane: 'deep', kind: `temporal_${attr}`, entityIds: tagU,
        text: isProject ? `${canonical}'s supersession ledger sets ${attr} ${val}.` : `${canonical}'s supersession ledger sets ${attr} ${val}.`,
        shape: 'temporal_update_record', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      addedDocs.push({ id: staleShadowId, lane: 'deep', kind: `temporal_${attr}`, entityIds: tagU,
        text: isProject ? `What is ${canonical}'s current ${attr}? The current ${attr} is ${staleVal} according to the older rollout note.`
          : `What is ${canonical}'s current ${attr}? The current ${attr} is ${staleVal} according to the older profile note.`,
        shape: 'temporal_update_record', timestamp: priorDate, currentStaleFlag: false, liveUpdateEpoch: epoch });
      const prior = priorTemporalByAttr.get(`${subj.id}::${attr}`);
      if (prior) addedRelations.push({ src: docId, dst: prior, type: 'supersedes', label: 'supersedes' });
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'temporal_update', queryText: `What is ${canonical}'s current ${attr}?`,
        qrels: [{ docId, relevance: 1.0, role: 'direct' }, { docId: staleShadowId, relevance: 0.0, role: 'stale_shadow' }, ...(prior ? [{ docId: prior, relevance: 0.2, role: 'stale' }] : [])],
        hardNegatives: [{ docId: staleShadowId, category: 'temporal_stale_exact_terms' }, ...(prior ? [{ docId: prior, category: 'temporal_stale' }] : [])], band: 'very_hard', liveUpdateEpoch: epoch });
      // Carry the new same-attr prior forward so within-epoch later iterations align.
      priorTemporalByAttr.set(`${subj.id}::${attr}`, docId);
    } else if (branch === 'conflict') {
      const attr = isProject ? 'deployment region' : 'preferred clinic';
      const scope = isProject ? 'production' : 'weekday care';
      const cityA = CITIES[Math.floor(rnd() * CITIES.length)];
      let cityB = CITIES[Math.floor(rnd() * CITIES.length)];
      if (cityB === cityA) cityB = CITIES[(CITIES.indexOf(cityA) + 1) % CITIES.length];
      const aId = `d_${idBase}_ca`, bId = `d_${idBase}_cb`, qid = `q_${idBase}_c`;
      const valA = isProject ? cityA : `${cityA} family clinic`;
      const valB = isProject ? cityB : `${cityB} specialist clinic`;
      addedDocs.push({ id: aId, lane: 'deep', kind: 'lifecycle_conflict', entityIds: tagU,
        text: `${canonical}'s ${attr} for ${scope} was recorded as ${valA}.`, shape: 'lifecycle_conflict_record',
        timestamp: tsDate, currentStaleFlag: true, lifecycleState: 'conflict_candidate', lifecycleScope: scope, liveUpdateEpoch: epoch });
      addedDocs.push({ id: bId, lane: 'deep', kind: 'lifecycle_conflict', entityIds: tagU,
        text: `${canonical}'s corrected ${attr} for ${scope} is ${valB}.`, shape: 'lifecycle_conflict_record',
        timestamp: tsDate, currentStaleFlag: true, lifecycleState: 'conflict_resolved', lifecycleScope: scope, liveUpdateEpoch: epoch });
      addedRelations.push({ src: bId, dst: aId, type: 'co_occurs_with', label: 'contradicts' });
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'conflict_lifecycle', queryText: `For ${scope}, what is ${canonical}'s current ${attr}?`,
        qrels: [{ docId: bId, relevance: 1.0, role: 'direct' }, { docId: aId, relevance: 0.0, role: 'conflict' }],
        hardNegatives: [{ docId: aId, category: 'temporal_stale' }], band: 'very_hard', operationFamily: 'conflict_lifecycle', liveUpdateEpoch: epoch });
    } else if (branch === 'decision') {
      // Decision/causal-provenance extension: the subject made a decision; a separate
      // doc describes the SUPPORTING reason (public `supports` edge). Query asks for the
      // reason — answered by the supporting doc; the direct decision doc is itself a
      // strong but secondary qrel. This produces relation/category mining material
      // (supports edge) without inventing a new substrate slot.
      const project = isProject ? 'project' : 'medical case';
      const decisionId = `d_${idBase}_dec`, evidenceId = `d_${idBase}_ev`, qid = `q_${idBase}_d`;
      const choice = CITIES[Math.floor(rnd() * CITIES.length)];
      addedDocs.push({ id: decisionId, lane: 'deep', kind: 'decision_provenance_record', entityIds: tagU,
        text: `${canonical} chose ${choice} for the ${project} after review.`,
        shape: 'decision_record', timestamp: tsDate, liveUpdateEpoch: epoch });
      addedDocs.push({ id: evidenceId, lane: 'deep', kind: 'decision_evidence_record', entityIds: tagU,
        text: `The ${project} review noted that ${choice} satisfies the residency requirement, which supports ${canonical}'s decision.`,
        shape: 'decision_evidence_record', timestamp: tsDate, liveUpdateEpoch: epoch });
      addedRelations.push({ src: evidenceId, dst: decisionId, type: 'supports', label: 'supports' });
      addedRelations.push({ src: decisionId, dst: evidenceId, type: 'causes', label: 'caused_by' });
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'decision_provenance',
        queryText: `Why did ${canonical} choose ${choice} for the ${project}?`,
        qrels: [{ docId: evidenceId, relevance: 1.0, role: 'direct' }, { docId: decisionId, relevance: 0.6, role: 'bridge' }],
        hardNegatives: [], band: 'very_hard', operationFamily: 'decision_provenance', liveUpdateEpoch: epoch });
    } else if (branch === 'abstention') {
      // Abstention_missing guardrail eval: a query whose answer is NOT present in the
      // corpus — the operator's abstention atom should fire (refuse to answer) instead of
      // returning a wrong doc. No direct qrel. This is NOT mining runway; it is supply
      // for the guardrail to be measured against.
      const trivia = ['favorite color', 'high school mascot', 'shoe size'];
      const trivium = trivia[Math.floor(rnd() * trivia.length)];
      const qid = `q_${idBase}_a`;
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'abstention_missing',
        queryText: `What is ${canonical}'s ${trivium}?`,
        qrels: [], // intentionally empty — abstain is the correct answer
        hardNegatives: [], band: 'very_hard', operationFamily: 'abstention_missing', liveUpdateEpoch: epoch });
    } else if (branch === 'validity_atom') {
      const attr = 'api endpoint';
      const scope = publicScopeFor(subj, universe, epoch, 'api_migration_validity');
      const host = API_HOSTS[Math.floor(rnd() * API_HOSTS.length)];
      const staleId = `d_${idBase}_vs`, curId = `d_${idBase}_vc`, qid = `q_${idBase}_v`;
      const shadowIds = VALIDITY_SHADOW_COLORS.map((_, i) => `d_${idBase}_vx${i}`);
      const staleVal = `${host}-blue-${epoch}.api.internal`;
      const curVal = `${host}-green-${epoch}.api.internal`;
      addedDocs.push({ id: staleId, lane: 'deep', kind: 'atom_validity_fact', entityIds: tagU,
        text: `${canonical}'s rollout slot endpoint token ${staleVal} appeared in the API migration ledger with review stamp ${tsDate}.`,
        shape: 'atom_validity_record', timestamp: tsDate, currentStaleFlag: false, scope,
        validity: { subjectEntityId: subj.id, attribute: attr, validFrom: '2025-01-01', validUntil: priorDate, observedAt: tsDate, supersededBy: curId },
        liveUpdateEpoch: epoch });
      for (let i = 0; i < shadowIds.length; i++) {
        const shadowId = shadowIds[i];
        const shadowVal = `${host}-${VALIDITY_SHADOW_COLORS[i]}-${epoch}.api.internal`;
        addedDocs.push({ id: shadowId, lane: 'deep', kind: 'atom_validity_fact', entityIds: tagU,
          text: `${canonical}'s rollout slot endpoint token ${shadowVal} appeared in the API migration ledger with review stamp ${tsDate}.`,
          shape: 'atom_validity_record', timestamp: tsDate, currentStaleFlag: false, scope,
          validity: { subjectEntityId: subj.id, attribute: attr, validFrom: `2025-0${Math.min(9, i + 2)}-01`, validUntil: priorDate, observedAt: tsDate, supersededBy: curId },
          liveUpdateEpoch: epoch });
      }
      addedDocs.push({ id: curId, lane: 'deep', kind: 'atom_validity_fact', entityIds: tagU,
        text: `${canonical}'s rollout slot endpoint token ${curVal} appeared in the API migration ledger with review stamp ${priorDate}.`,
        shape: 'atom_validity_record', timestamp: tsDate, currentStaleFlag: true, scope,
        validity: { subjectEntityId: subj.id, attribute: attr, validFrom: tsDate, observedAt: priorDate },
        liveUpdateEpoch: epoch });
      addedRelations.push({ src: curId, dst: staleId, type: 'supersedes', label: 'supersedes' });
      for (const shadowId of shadowIds) addedRelations.push({ src: curId, dst: shadowId, type: 'supersedes', label: 'supersedes' });
      const validityQrels = [
        { docId: curId, relevance: 1.0, role: 'direct' },
        { docId: staleId, relevance: 0.0, role: 'stale' },
        ...shadowIds.map((docId) => ({ docId, relevance: 0.0, role: 'stale_distractor' })),
      ];
      const validityHardNegatives = [
        { docId: staleId, category: 'temporal_stale' },
        ...shadowIds.map((docId) => ({ docId, category: 'temporal_stale' })),
      ];
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'validity_atom',
        queryText: `Which rollout slot API endpoint applies to ${canonical} on ${tsDate}?`,
        qrels: validityQrels,
        hardNegatives: validityHardNegatives,
        scope, publicIntent: { atom: 'validity_atom', subjectEntityId: subj.id, attribute: attr, queryTime: tsDate, ...scope },
        band: 'very_hard', operationFamily: 'validity_atom', liveUpdateEpoch: epoch });
      addedQueries.push({ id: `${qid}_confirm`, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'validity_atom',
        queryText: `For ${canonical}'s rollout slot on ${tsDate}, what API endpoint should be used?`,
        qrels: validityQrels,
        hardNegatives: validityHardNegatives,
        scope, publicIntent: { atom: 'validity_atom', subjectEntityId: subj.id, attribute: attr, queryTime: tsDate, ...scope },
        band: 'very_hard', operationFamily: 'validity_atom', liveUpdateEpoch: epoch });
      addedQueries.push({ id: `${qid}_active`, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'validity_atom',
        queryText: `What API migration endpoint is in force for ${canonical}'s rollout slot on ${tsDate}?`,
        qrels: validityQrels,
        hardNegatives: validityHardNegatives,
        scope, publicIntent: { atom: 'validity_atom', subjectEntityId: subj.id, attribute: attr, queryTime: tsDate, ...scope },
        band: 'very_hard', operationFamily: 'validity_atom', liveUpdateEpoch: epoch });
    } else if (branch === 'scope_atom') {
      const scope = publicScopeFor(subj, universe, epoch, 'math_project_scope');
      const wrongScope = { ...scope, projectId: `proj_${slug(`${subj.id}_${epoch}_finance_project`)}`, topicId: 'topic_finance_project' };
      const rightId = `d_${idBase}_sr`, wrongId = `d_${idBase}_sw`, qid = `q_${idBase}_s`;
      const endpoint = `${API_HOSTS[Math.floor(rnd() * API_HOSTS.length)]}-solver-${epoch}.internal`;
      const wrongEndpoint = `${API_HOSTS[Math.floor(rnd() * API_HOSTS.length)]}-finance-${epoch}.internal`;
      addedDocs.push({ id: rightId, lane: 'deep', kind: 'atom_scope_fact', entityIds: tagU,
        text: `${canonical}'s algebra workspace approval set ${endpoint} as the solver endpoint for last week's scoped session.`,
        shape: 'atom_scope_record', timestamp: tsDate, currentStaleFlag: true, scope, liveUpdateEpoch: epoch });
      addedDocs.push({ id: wrongId, lane: 'deep', kind: 'atom_scope_fact', entityIds: tagU,
        text: `For ${canonical}'s math project scope from last week, the project endpoint note listed ${wrongEndpoint} as the endpoint for the scoped session.`,
        shape: 'atom_scope_record', timestamp: tsDate, currentStaleFlag: true, scope: wrongScope, liveUpdateEpoch: epoch });
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'scope_atom',
        queryText: `For ${canonical}, what endpoint belongs to the math project scope from last week?`,
        qrels: [{ docId: rightId, relevance: 1.0, role: 'direct' }, { docId: wrongId, relevance: 0.0, role: 'wrong_scope' }],
        hardNegatives: [{ docId: wrongId, category: 'wrong_scope_near_collision' }],
        scope, publicIntent: { atom: 'scope_atom', ...scope },
        band: 'very_hard', operationFamily: 'scope_atom', liveUpdateEpoch: epoch });
    } else if (branch === 'coreference') {
      const wrong = otherSubjectFor(subj, rnd);
      const alias = aliasFor(subj);
      const wrongAlias = aliasFor(wrong);
      const ticket = `cr-${epoch}-${Math.floor(rnd() * 900 + 100)}`;
      const wrongTicket = `cr-${epoch}-${Math.floor(rnd() * 900 + 100)}`;
      const aliasId = `d_${idBase}_cf_alias`, rightId = `d_${idBase}_cf_ref`, wrongAliasId = `d_${idBase}_cf_wa`, wrongId = `d_${idBase}_cf_w`;
      addedDocs.push({ id: aliasId, lane: 'deep', kind: 'coreference_alias_record', entityIds: tagU,
        aliases: [alias], text: `${alias} opened rollback memo ${ticket} for ${canonical}'s migration workspace.`,
        shape: 'coreference_alias_record', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      addedDocs.push({ id: rightId, lane: 'deep', kind: 'coreference_reference_record', entityIds: tagU,
        text: `They confirmed that ${API_HOSTS[Math.floor(rnd() * API_HOSTS.length)]}-owner-${epoch} owns the rollback checklist for memo ${ticket}.`,
        shape: 'coreference_reference_record', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      addedDocs.push({ id: wrongAliasId, lane: 'deep', kind: 'coreference_alias_record', entityIds: [universe, wrong.id],
        aliases: [wrongAlias], text: `${wrongAlias} opened rollback memo ${wrongTicket} for ${wrong.canonicalName}'s migration workspace.`,
        shape: 'coreference_alias_record', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      addedDocs.push({ id: wrongId, lane: 'deep', kind: 'coreference_reference_record', entityIds: [universe, wrong.id],
        text: `They confirmed that ${API_HOSTS[Math.floor(rnd() * API_HOSTS.length)]}-owner-${epoch} owns the rollback checklist for memo ${wrongTicket}.`,
        shape: 'coreference_reference_record', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      addedRelations.push({ src: rightId, dst: aliasId, type: 'coreference_of', label: 'coreference_of' });
      addedRelations.push({ src: wrongId, dst: wrongAliasId, type: 'coreference_of', label: 'coreference_of' });
      addedQueries.push({ id: `q_${idBase}_cf`, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'coreference',
        queryText: `For ${canonical}, who owns the rollback checklist confirmed in the follow-up memo?`,
        qrels: [{ docId: rightId, relevance: 1.0, role: 'direct' }, { docId: aliasId, relevance: 0.6, role: 'alias_bridge' }, { docId: wrongId, relevance: 0.0, role: 'wrong_alias' }],
        hardNegatives: [{ docId: wrongId, category: 'wrong_alias_near_collision' }],
        band: 'very_hard', operationFamily: 'coreference', liveUpdateEpoch: epoch });
    } else if (branch === 'relation_lifecycle') {
      const scopeLabel = isProject ? 'deployment escalation' : 'care escalation';
      const oldDep = `${API_HOSTS[Math.floor(rnd() * API_HOSTS.length)]}-legacy-${epoch}`;
      const newDep = `${API_HOSTS[Math.floor(rnd() * API_HOSTS.length)]}-active-${epoch}`;
      const oldId = `d_${idBase}_rl_old`, curId = `d_${idBase}_rl_cur`, qid = `q_${idBase}_rl`;
      addedDocs.push({ id: oldId, lane: 'deep', kind: 'relation_lifecycle_record', entityIds: tagU,
        text: `The late audit note says ${canonical}'s current escalation relation for ${scopeLabel} is ${oldDep}; operators should use ${oldDep} for the current escalation relation.`,
        shape: 'relation_lifecycle_record', timestamp: tsDate, currentStaleFlag: false, lifecycleState: 'superseded_relation', liveUpdateEpoch: epoch });
      addedDocs.push({ id: curId, lane: 'deep', kind: 'relation_lifecycle_record', entityIds: tagU,
        text: `Supersession ledger ${priorDate}: ${newDep} replaces the late audit dependency for ${canonical}'s ${scopeLabel}; ${oldDep} is retired.`,
        shape: 'relation_lifecycle_record', timestamp: priorDate, currentStaleFlag: true, lifecycleState: 'current_relation', liveUpdateEpoch: epoch });
      addedRelations.push({ src: curId, dst: oldId, type: 'supersedes', label: 'supersedes' });
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'relation_lifecycle',
        queryText: `What is ${canonical}'s current escalation relation for ${scopeLabel} after the late audit relation was superseded?`,
        qrels: [{ docId: curId, relevance: 1.0, role: 'direct' }, { docId: oldId, relevance: 0.2, role: 'stale_relation' }],
        hardNegatives: [{ docId: oldId, category: 'stale_relation_high_overlap' }],
        publicIntent: { atom: 'relation_lifecycle', subjectEntityId: subj.id, relationType: 'supersedes', lifecycleState: 'current_relation', scopeLabel },
        band: 'very_hard', operationFamily: 'relation_lifecycle', liveUpdateEpoch: epoch });
    } else if (branch === 'noise_suppression') {
      const scopeLabel = isProject ? 'rollback drill' : 'operator drill';
      const owner = `${API_HOSTS[Math.floor(rnd() * API_HOSTS.length)]}-clear-${epoch}`;
      const wrongOwner = `${API_HOSTS[Math.floor(rnd() * API_HOSTS.length)]}-draft-${epoch}`;
      const rightId = `d_${idBase}_ns_r`, wrongId = `d_${idBase}_ns_w`, qid = `q_${idBase}_ns`;
      addedDocs.push({ id: rightId, lane: 'deep', kind: 'noise_suppression_answer', entityIds: tagU,
        text: `The signed run ledger for ${canonical}'s ${scopeLabel} lists approved owner ${owner}.`,
        shape: 'noise_suppression_answer', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      addedDocs.push({ id: wrongId, lane: 'deep', kind: 'noise_suppression_distractor', entityIds: tagU,
        text: `For ${canonical}'s ${scopeLabel}, the current approved owner is ${wrongOwner}.`,
        shape: 'noise_suppression_distractor', timestamp: tsDate, currentStaleFlag: false, liveUpdateEpoch: epoch });
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'noise_suppression',
        queryText: `What is the current approved owner for ${canonical}'s ${scopeLabel}?`,
        qrels: [{ docId: rightId, relevance: 1.0, role: 'direct' }, { docId: wrongId, relevance: 0.0, role: 'lexical_noise' }],
        hardNegatives: [{ docId: wrongId, category: 'lexical_distractor_exact_terms' }],
        publicIntent: { atom: 'noise_suppression', subjectEntityId: subj.id, selector: 'ANSWER_DENSITY', action: 'suppress' },
        band: 'very_hard', operationFamily: 'noise_suppression', liveUpdateEpoch: epoch });
    } else if (branch === 'entity_resolution_atom') {
      const pair = duplicateEntityPairs[Math.floor(rnd() * duplicateEntityPairs.length)];
      const roleAlias = (pair.target.roleAliases ?? []).find((r) => /api migration lead|backend lead/i.test(r)) ?? pair.target.roleAliases?.[0] ?? 'API migration lead';
      const wrongRole = pair.wrong.roleAliases?.[0] ?? 'design lead';
      const scope = publicScopeFor(subj, universe, epoch, 'entity_resolution_role');
      const rightId = `d_${idBase}_er`, wrongId = `d_${idBase}_ew`, qid = `q_${idBase}_e`;
      const retry = `${4 + Math.floor(rnd() * 8)} minutes`;
      const wrongRetry = `${1 + Math.floor(rnd() * 4)} minutes`;
      addedDocs.push({ id: rightId, lane: 'deep', kind: 'atom_entity_resolution_fact', entityIds: [universe, pair.target.id],
        roleAliases: [...(pair.target.roleAliases ?? [])], scope,
        text: `${pair.canonicalName} serving as ${roleAlias} set the approved retry window to ${retry} in the migration workspace record.`,
        shape: 'atom_entity_resolution_record', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      addedDocs.push({ id: wrongId, lane: 'deep', kind: 'atom_entity_resolution_fact', entityIds: [universe, pair.wrong.id],
        roleAliases: [...new Set([...(pair.wrong.roleAliases ?? [wrongRole]), roleAlias])], scope,
        text: `${pair.canonicalName} the ${roleAlias} recorded ${wrongRetry} for the retry window in the migration workspace.`,
        shape: 'atom_entity_resolution_record', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      addedQueries.push({ id: qid, ownerScoped: true, ownerEntityId: universe, subjectEntityId: pair.target.id,
        lane: 'deep', family: 'entity_resolution_atom',
        queryText: `What retry window did ${pair.canonicalName} the ${roleAlias} set?`,
        qrels: [{ docId: rightId, relevance: 1.0, role: 'direct' }, { docId: wrongId, relevance: 0.0, role: 'wrong_entity_same_name' }],
        hardNegatives: [{ docId: wrongId, category: 'duplicate_name_wrong_role' }],
        scope, publicIntent: { atom: 'entity_resolution_atom', subjectEntityId: pair.target.id, name: pair.canonicalName, roleAlias, ...scope },
        band: 'very_hard', operationFamily: 'entity_resolution_atom', liveUpdateEpoch: epoch });
    }
  }

  // Retraction tombstones: one continuity-labeled replacement record per retracted fact
  // (consistent with the existing supersession/staleness pattern — the tombstone is the
  // surviving public record; the retracted doc itself is removed via removedIds downstream).
  if (retractedDocIds.length > 0) {
    const entityById = new Map((baseLogical.entities ?? []).map((e) => [e.id, e]));
    const baseDocsById = new Map((baseLogical.docs ?? []).map((d) => [d.id, d]));
    for (const docId of retractedDocIds) {
      const d = baseDocsById.get(docId);
      const sid = (d?.entityIds || []).find((x) => x !== universe) ?? null;
      const canonical = sid ? (entityById.get(sid)?.canonicalName ?? sid) : 'the shared ledger';
      addedDocs.push({ id: `d_e${epoch}_rt_${slug(docId)}`, lane: d?.lane ?? 'deep', kind: 'retraction_record',
        entityIds: sid ? [universe, sid] : [universe],
        text: `Retraction notice ${tsDate}: the earlier ${String(d?.kind ?? 'fact').replace(/_/g, ' ')} record for ${canonical} was withdrawn from the supersession ledger and no longer applies.`,
        shape: 'retraction_record', timestamp: tsDate, currentStaleFlag: true, retractsDocId: docId, liveUpdateEpoch: epoch });
    }
  }

  // Hidden-eval pool turnover (public-qrels memorization decay): mint fresh eval_hidden queries
  // up to the pinned per-epoch quota, and retire hidden rows past the horizon oldest-first.
  const freshEvalHiddenQueryIds = [];
  const hiddenClusterTelemetry = { capability: null, escalationLevel: 0, clusters: [] };
  const retiredQueryIds = [];
  const retiredQuerySet = new Set();
  const retireQuery = (id) => {
    if (retiredQuerySet.has(id)) return;
    retiredQuerySet.add(id);
    retiredQueryIds.push(id);
  };
  if (evalHiddenPolicy) {
    const { splitOf, minFreshPerEpoch = 0, retireAfterEpochs = Infinity, maxRetiredPerEpoch = Infinity, maxMintedPerEpoch = Infinity, excludeRetireIds = null } = evalHiddenPolicy;
    for (const q of addedQueries) if (splitOf(q.id, epoch) === 'eval_hidden') freshEvalHiddenQueryIds.push(q.id);
    // Deterministic id-salt search: the canonical split is an id hash, so the only honest way to
    // guarantee fresh hidden supply is to mint ids until enough land in eval_hidden (~15%).
    // Minting is bounded by maxMintedPerEpoch (the caller's root-delta budget); when the quota
    // cannot be met inside the budget the caller's quota gate hard-fails.
    const saltCap = Math.max(600, minFreshPerEpoch * 80);
    let minted = 0;
    const mintedClusters = hiddenClusterTelemetry.clusters;
    const capability = capabilityForEpoch(epoch, evalHiddenPolicy.capabilitySchedule ?? TYPED_CLUSTER_CAPABILITY_SCHEDULE);
    const escalationLevel = escalationLevelForEpoch(epoch, evalHiddenPolicy.escalation ?? {});
    hiddenClusterTelemetry.capability = capability;
    hiddenClusterTelemetry.escalationLevel = escalationLevel;
    const clusterDocsAdded = new Set();
    for (let salt = 0; freshEvalHiddenQueryIds.length < minFreshPerEpoch && minted < maxMintedPerEpoch && salt < saltCap && subjects.length > 0; salt++) {
      const subj = subjects[salt % subjects.length];
      const rnd = prng(`${seed}:hidden-cluster:${epoch}:${subj.id}:${salt}`);
      const canonical = subj.canonicalName;
      const isProject = /-svc-/.test(canonical);
      // Rotated attribute (NOT the burned bare city/diet/package-manager space): two fresh
      // attributes per epoch, alternating by cluster parity — two independent memory
      // operations' worth of headroom every evolve.
      const { attr, bank } = temporalAttributeForEpochSlot(epoch, mintedClusters.length, { isProject });
      const val = bank[Math.floor(rnd() * bank.length)];
      let staleVal = bank[Math.floor(rnd() * bank.length)];
      if (staleVal === val) staleVal = bank[(bank.indexOf(val) + 1) % bank.length] ?? `${val}-prior`;
      const prior = priorTemporalByAttr.get(`${subj.id}::${attr}`);
      const cluster = `${salt}`;
      const idBase = `e${epoch}_${subj.id}_hc${cluster}`;
      const decoyVals = [];
      for (let i = 0; decoyVals.length < escalationLevel && i < bank.length; i++) {
        const decoy = bank[(bank.indexOf(staleVal) + 1 + i) % bank.length];
        if (decoy !== val && decoy !== staleVal) decoyVals.push(decoy);
      }
      const spec = buildTypedTemporalClusterSpec({
        canonical, subjectId: subj.id, attr, val, staleVal, tsDate, priorDate,
        currentId: `d_${idBase}_cur`, staleId: `d_${idBase}_stale`, changeId: `d_${idBase}_chg`,
        shadowIds: decoyVals.map((_, i) => `d_${idBase}_sh${i}`), decoyVals,
      });
      const mintedRows = [];
      // Clusters are ATOMIC: once started, all five typed stubs mint even if the fresh-hidden
      // quota is crossed mid-cluster (churn-branch queries that happen to land in eval_hidden
      // count toward the quota and would otherwise truncate the cluster to a partial type set).
      // Bounded overshoot: quota + 4 rows ≪ maxRootDeltaPerEpoch; maxMintedPerEpoch still binds.
      for (let stub = 0; stub < spec.queryStubs.length && minted < maxMintedPerEpoch; stub++) {
        const q = spec.queryStubs[stub];
        let qid = null;
        for (let probe = 0; probe < 96; probe++) {
          const candidate = `q_${idBase}_v${stub}_s${probe}`;
          if (splitOf(candidate, epoch) === 'eval_hidden') {
            qid = candidate;
            break;
          }
        }
        if (!qid) continue;
        if (!clusterDocsAdded.has(idBase)) {
          clusterDocsAdded.add(idBase);
          for (const doc of spec.docs) {
            addedDocs.push({ id: doc.id, lane: 'deep', kind: doc.kind, entityIds: [universe, subj.id],
              text: doc.text, shape: 'temporal_update_record', timestamp: doc.timestamp,
              currentStaleFlag: doc.currentStaleFlag, validity: doc.validity, liveUpdateEpoch: epoch });
          }
          for (const rel of spec.relations) addedRelations.push(rel);
          if (prior) addedRelations.push({ src: `d_${idBase}_cur`, dst: prior, type: 'supersedes', label: 'supersedes' });
          priorTemporalByAttr.set(`${subj.id}::${attr}`, `d_${idBase}_cur`);
        }
        addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
          lane: 'deep', family: 'temporal_update', queryText: q.queryText,
          qrels: [
            ...q.qrels,
            ...(prior ? [{ docId: prior, relevance: 0.0, role: 'stale_prior' }] : []),
          ],
          hardNegatives: [...q.hardNegatives, ...(prior ? [{ docId: prior, category: 'temporal_stale' }] : [])],
          publicIntent: { atom: 'temporal_cluster', subjectEntityId: subj.id, attribute: attr, queryTime: tsDate,
            selector: `qtype_${q.questionType}_v${q.variant}` },
          questionType: q.questionType, capability,
          band: escalationLevel > 0 ? 'very_hard' : 'hard', operationFamily: 'temporal_cluster_typed', liveUpdateEpoch: epoch });
        freshEvalHiddenQueryIds.push(qid);
        mintedRows.push({ id: qid, questionType: q.questionType });
        minted++;
      }
      if (mintedRows.length > 0) {
        mintedClusters.push({
          clusterKey: idBase, capability, escalationLevel, subjectEntityId: subj.id, attribute: attr,
          rowCount: mintedRows.length, questionTypes: [...new Set(mintedRows.map((r) => r.questionType))],
          shadowCount: decoyVals.length,
        });
      }
    }
    // If a retracted doc was a positive qrel target, the hidden query is no
    // longer answerable and must leave the eval pool regardless of age.
    for (const q of baseLogical.queries ?? []) {
      if (!q || typeof q.id !== 'string') continue;
      if (splitOf(q.id, q.liveUpdateEpoch) !== 'eval_hidden') continue;
      const qrels = Array.isArray(q.qrels) ? q.qrels : [];
      if (qrels.some((r) => Number(r?.relevance ?? 0) > 0 && retractedSet.has(String(r?.docId ?? '')))) {
        retireQuery(q.id);
      }
    }
    if (Number.isFinite(retireAfterEpochs)) {
      const candidates = (baseLogical.queries ?? [])
        .filter((q) => {
          if (!q || typeof q.id !== 'string') return false;
          const mintEpoch = Number.isInteger(q.liveUpdateEpoch) ? q.liveUpdateEpoch : 0;
          if (epoch - mintEpoch < retireAfterEpochs) return false;
          if (excludeRetireIds && excludeRetireIds.has(q.id)) return false;
          if (retiredQuerySet.has(q.id)) return false;
          return splitOf(q.id, q.liveUpdateEpoch) === 'eval_hidden';
        })
        .sort((a, b) => ((a.liveUpdateEpoch ?? 0) - (b.liveUpdateEpoch ?? 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const remainingCap = Math.max(0, maxRetiredPerEpoch - retiredQueryIds.length);
      for (const q of candidates.slice(0, remainingCap)) retireQuery(q.id);
    }
  }

  // Per-epoch capability/difficulty telemetry (N2 anti-coverage-indexing signal): consumers
  // (epoch-evolve artifact, cutover accounting) can detect "same capability + same difficulty
  // for N consecutive epochs" — the coverage-indexing failure mode — from these fields alone.
  const questionTypeHistogram = {};
  const clusterBandHistogram = {};
  for (const c of hiddenClusterTelemetry.clusters) {
    for (const qt of c.questionTypes) questionTypeHistogram[qt] = (questionTypeHistogram[qt] ?? 0) + 1;
  }
  for (const q of addedQueries) {
    if (q.operationFamily !== 'temporal_cluster_typed') continue;
    clusterBandHistogram[q.band] = (clusterBandHistogram[q.band] ?? 0) + 1;
  }

  return { epoch, seed, churnFraction, retractionFraction, addedDocs, addedRelations, addedQueries, churnedSubjects,
    retractedDocIds, retiredQueryIds, freshEvalHiddenQueryIds,
    hiddenClusterTelemetry: {
      capability: hiddenClusterTelemetry.capability,
      escalationLevel: hiddenClusterTelemetry.escalationLevel,
      clusterCount: hiddenClusterTelemetry.clusters.length,
      questionTypeHistogram,
      bandHistogram: clusterBandHistogram,
      clusters: hiddenClusterTelemetry.clusters,
    },
    liveChurnRate: subjects.length ? churnedSubjects.length / subjects.length : 0 };
}
