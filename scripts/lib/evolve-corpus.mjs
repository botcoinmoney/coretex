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
  // prior temporal doc per subject (the held fact to supersede)
  const priorTemporal = new Map();
  for (const d of baseLogical.docs || []) {
    const sid = (d.entityIds || []).find((x) => x !== universe);
    if (sid && /temporal/.test(d.kind || '')) priorTemporal.set(sid, d.id); // last write wins → most recent in file order
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
    const op = h(`${seed}:op:${epoch}:${subj.id}`).readUInt32BE(0) % 2; // 0 = temporal revision, 1 = conflict update

    if (op === 0) {
      const attr = isProject ? 'package manager' : 'city';
      const bank = isProject ? PKGS : CITIES;
      const val = bank[Math.floor(rnd() * bank.length)];
      const docId = `d_${idBase}_t`, qid = `q_${idBase}_t`;
      addedDocs.push({ id: docId, lane: 'deep', kind: `temporal_${attr}`, entityIds: tagU,
        text: isProject ? `${canonical} switched its ${attr} to ${val}.` : `${canonical} updated their ${attr} to ${val}.`,
        shape: 'temporal_update_record', timestamp: tsDate, currentStaleFlag: true, liveUpdateEpoch: epoch });
      const prior = priorTemporal.get(subj.id);
      if (prior) addedRelations.push({ src: docId, dst: prior, type: 'supersedes', label: 'supersedes' });
      addedQueries.push({ id: qid, ownerScoped: true, subjectEntityId: subj.id, ownerEntityId: universe,
        lane: 'deep', family: 'temporal_update', queryText: `What is ${canonical}'s current ${attr}?`,
        qrels: [{ docId, relevance: 1.0, role: 'direct' }, ...(prior ? [{ docId: prior, relevance: 0.2, role: 'stale' }] : [])],
        hardNegatives: prior ? [{ docId: prior, category: 'temporal_stale' }] : [], band: 'very_hard', liveUpdateEpoch: epoch });
    } else {
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
    }
  }

  return { epoch, seed, churnFraction, addedDocs, addedRelations, addedQueries, churnedSubjects,
    liveChurnRate: subjects.length ? churnedSubjects.length / subjects.length : 0 };
}
