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

  for (const subj of subjects) {
    if (unit(`${seed}:churn:${epoch}:${subj.id}`) >= churnFraction) continue; // deterministic selection
    churnedSubjects.push(subj.id);
    const rnd = prng(`${seed}:${epoch}:${subj.id}`);
    const canonical = subj.canonicalName;
    const isProject = /-svc-/.test(canonical);
    const tagU = [universe, subj.id];
    const idBase = `e${epoch}_${subj.id}`;
    // 4-branch op mix: 0 = temporal revision, 1 = conflict update,
    //                  2 = decision/causal extension (supports/causes chain),
    //                  3 = abstention_missing (no-direct-qrel guardrail eval).
    // Distribution: temporal:conflict:decision:abstention = 2:2:1:1 (12.5% each for
    // the latter two; the auditor's "no giant generator" guidance keeps these minimal
    // additions). Per-subject branch is deterministic from seed+epoch+subject.
    const op = h(`${seed}:op:${epoch}:${subj.id}`).readUInt32BE(0) % 6;
    // 0,1 → temporal; 2,3 → conflict; 4 → decision; 5 → abstention
    const branch = op <= 1 ? 'temporal' : op <= 3 ? 'conflict' : op === 4 ? 'decision' : 'abstention';

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
    }
  }

  return { epoch, seed, churnFraction, addedDocs, addedRelations, addedQueries, churnedSubjects,
    liveChurnRate: subjects.length ? churnedSubjects.length / subjects.length : 0 };
}
