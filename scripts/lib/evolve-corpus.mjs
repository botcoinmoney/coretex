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
 * production-event + corpusRoot step is the pipeline/A100 wiring (see the handoff).
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
const API_HOSTS = ['atlas', 'beacon', 'cedar', 'delta', 'ember', 'falcon', 'granite', 'harbor'];
const VALIDITY_SHADOW_COLORS = ['amber', 'silver', 'copper', 'violet'];

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

/**
 * @param {{ baseLogical: any, epoch: number, seed: string, churnFraction?: number }} args
 * @returns {{ epoch, seed, churnFraction, addedDocs, addedRelations, addedQueries, churnedSubjects, liveChurnRate }}
 */
export function evolveCorpusDelta({ baseLogical, epoch, seed, churnFraction = 0.1 }) {
  if (!baseLogical || !Array.isArray(baseLogical.entities)) throw new Error('evolveCorpusDelta: baseLogical.entities required');
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('evolveCorpusDelta: epoch must be a non-negative integer');
  if (typeof seed !== 'string' || !seed) throw new Error('evolveCorpusDelta: seed required');

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
  const priorTemporalByAttr = new Map(); // `${sid}::${attr}` → docId (last write wins)
  for (const d of baseLogical.docs || []) {
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
    const op = h(`${seed}:op:${epoch}:${subj.id}`).readUInt32BE(0) % (hasAtomV16Metadata ? 12 : 6);
    let branch = op <= 1 ? 'temporal'
      : op <= 3 ? 'conflict'
      : op === 4 ? 'decision'
      : op === 5 ? 'abstention'
      : op === 6 ? 'validity_atom'
      : op === 7 ? 'scope_atom'
      : op === 8 ? 'entity_resolution_atom'
      : op === 9 ? 'coreference'
      : op === 10 ? 'relation_lifecycle'
      : 'noise_suppression';
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
      const docId = `d_${idBase}_t`, qid = `q_${idBase}_t`;
      addedDocs.push({ id: docId, lane: 'deep', kind: `temporal_${attr}`, entityIds: tagU,
        text: isProject ? `${canonical} switched its ${attr} to ${val}.` : `${canonical} updated their ${attr} to ${val}.`,
        shape: 'temporal_update_record', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      const prior = priorTemporalByAttr.get(`${subj.id}::${attr}`);
      if (prior) addedRelations.push({ src: docId, dst: prior, type: 'supersedes', label: 'supersedes' });
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'temporal_update', queryText: `What is ${canonical}'s current ${attr}?`,
        qrels: [{ docId, relevance: 1.0, role: 'direct' }, ...(prior ? [{ docId: prior, relevance: 0.2, role: 'stale' }] : [])],
        hardNegatives: prior ? [{ docId: prior, category: 'temporal_stale' }] : [], band: 'very_hard', liveUpdateEpoch: epoch });
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
        text: `${canonical}'s algebra workspace approved ${endpoint} as the solver endpoint for last week's scoped session.`,
        shape: 'atom_scope_record', timestamp: tsDate, currentStaleFlag: true, scope, liveUpdateEpoch: epoch });
      addedDocs.push({ id: wrongId, lane: 'deep', kind: 'atom_scope_fact', entityIds: tagU,
        text: `For ${canonical}'s math project from last week, the project endpoint note listed ${wrongEndpoint}, but that note belonged to the finance modeling scope.`,
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
        text: `${canonical}'s current escalation relation for ${scopeLabel} points to ${oldDep} according to a late audit note.`,
        shape: 'relation_lifecycle_record', timestamp: tsDate, currentStaleFlag: false, lifecycleState: 'superseded_relation', liveUpdateEpoch: epoch });
      addedDocs.push({ id: curId, lane: 'deep', kind: 'relation_lifecycle_record', entityIds: tagU,
        text: `The replacement ledger sets ${newDep} as the active dependency for ${canonical}'s ${scopeLabel}, replacing the superseded late audit relation.`,
        shape: 'relation_lifecycle_record', timestamp: priorDate, currentStaleFlag: true, lifecycleState: 'current_relation', liveUpdateEpoch: epoch });
      addedRelations.push({ src: curId, dst: oldId, type: 'supersedes', label: 'supersedes' });
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'relation_lifecycle',
        queryText: `What current escalation relation replaced ${canonical}'s superseded late audit relation for ${scopeLabel}?`,
        qrels: [{ docId: curId, relevance: 1.0, role: 'direct' }, { docId: oldId, relevance: 0.2, role: 'stale_relation' }],
        hardNegatives: [{ docId: oldId, category: 'stale_relation_high_overlap' }],
        band: 'very_hard', operationFamily: 'relation_lifecycle', liveUpdateEpoch: epoch });
    } else if (branch === 'noise_suppression') {
      const scopeLabel = isProject ? 'rollback drill' : 'handoff drill';
      const owner = `${API_HOSTS[Math.floor(rnd() * API_HOSTS.length)]}-clear-${epoch}`;
      const wrongOwner = `${API_HOSTS[Math.floor(rnd() * API_HOSTS.length)]}-draft-${epoch}`;
      const rightId = `d_${idBase}_ns_r`, wrongId = `d_${idBase}_ns_w`, qid = `q_${idBase}_ns`;
      addedDocs.push({ id: rightId, lane: 'deep', kind: 'noise_suppression_answer', entityIds: tagU,
        text: `For ${canonical}'s ${scopeLabel}, the approved owner is ${owner} in the current signed handoff ledger.`,
        shape: 'noise_suppression_answer', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      addedDocs.push({ id: wrongId, lane: 'deep', kind: 'noise_suppression_distractor', entityIds: tagU,
        text: `For ${canonical}'s ${scopeLabel}, the current approved owner is ${wrongOwner}; this retired draft used the exact query wording but was rejected.`,
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
        text: `${pair.canonicalName} recorded ${retry} for the retry window in the migration workspace.`,
        shape: 'atom_entity_resolution_record', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      addedDocs.push({ id: wrongId, lane: 'deep', kind: 'atom_entity_resolution_fact', entityIds: [universe, pair.wrong.id],
        roleAliases: [...(pair.wrong.roleAliases ?? [wrongRole])], scope,
        text: `${pair.canonicalName} recorded ${wrongRetry} for the retry window in the design workspace.`,
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

  return { epoch, seed, churnFraction, addedDocs, addedRelations, addedQueries, churnedSubjects,
    liveChurnRate: subjects.length ? churnedSubjects.length / subjects.length : 0 };
}
