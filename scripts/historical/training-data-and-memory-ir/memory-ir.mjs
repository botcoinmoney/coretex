/**
 * Shared Memory-IR FIELD COMPUTATION over a raw logical corpus ({docs, relations, entities}).
 *
 * Single source of the resolved-state / public-structure feature extraction used by BOTH the exporter
 * (training data) and the eval harness (serve-time scorer lookup), so the IR a candidate carries at
 * train time is byte-identical to the IR it carries at serve time. Rendering is separate and owned by the
 * protocol renderer `renderMemoryIRDoc` (compiled from packages/coretex, imported by every JS consumer).
 *
 * lifecycle is NOT computed here (it depends on resolved substrate vs corpus-smoke source) — the caller
 * passes the resolved lifecycle string. Every other field is a deterministic function of public corpus
 * structure (relation edges) + the query subject parsed from the query text.
 */

const GENERIC = new Set(['e_universe']);
const PUB = new Set(['supports', 'supersedes', 'coreference_of', 'causes', 'derived_from', 'co_occurs_with']);
const ANSWER_EDGES = new Set(['causes', 'supersedes', 'coreference_of', 'derived_from']);

export const nonGeneric = (ids) => (ids ?? []).filter((e) => !GENERIC.has(e));

export function buildMemoryIRContext(corpus) {
  const { docs, relations, entities } = corpus;
  const docById = new Map(docs.map((d) => [d.id, d]));
  const supSrc = new Set(), supDst = new Set(), contradictsSrc = new Set(), contradictsDst = new Set();
  const supportInDeg = new Map(); const edgesBySrc = new Map(), edgesByDst = new Map();
  for (const r of relations ?? []) {
    if (r.type === 'supersedes') { supSrc.add(r.src); supDst.add(r.dst); }
    if (r.label === 'contradicts') { contradictsSrc.add(r.src); contradictsDst.add(r.dst); }
    if (r.type === 'supports') supportInDeg.set(r.dst, (supportInDeg.get(r.dst) ?? 0) + 1);
    (edgesBySrc.get(r.src) ?? edgesBySrc.set(r.src, []).get(r.src)).push(r);
    (edgesByDst.get(r.dst) ?? edgesByDst.set(r.dst, []).get(r.dst)).push(r);
  }
  const nameToEnt = [];
  for (const e of entities ?? []) for (const n of [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean)) nameToEnt.push([String(n).toLowerCase(), e.id]);

  const conflictState = (id) => contradictsSrc.has(id) ? 'resolved' : contradictsDst.has(id) ? 'candidate' : 'none';
  const hasEvidencePath = (id) => (edgesBySrc.get(id) ?? []).some((r) => PUB.has(r.type)) || (edgesByDst.get(id) ?? []).some((r) => PUB.has(r.type));
  // evidence_role from PUBLIC STRUCTURE (never qrel): edge to the subject via answer-edges → answer;
  // a supports-target → support; any public edge → context; none.
  const evidenceRole = (id, subjEnts) => {
    const inc = (edgesBySrc.get(id) ?? []).concat(edgesByDst.get(id) ?? []).filter((r) => PUB.has(r.type));
    if (inc.length === 0) return 'none';
    const toSubj = inc.filter((r) => { const o = docById.get(r.src === id ? r.dst : r.src); return o && (o.entityIds ?? []).some((e) => subjEnts.has(e)); });
    if (toSubj.some((r) => ANSWER_EDGES.has(r.type))) return 'answer';
    if (!supDst.has(id) && (edgesByDst.get(id) ?? []).some((r) => r.type === 'supports')) return 'support';
    return 'context';
  };
  const relationPath = (candId, subjEnts) => {
    const p = [];
    for (const r of (edgesBySrc.get(candId) ?? []).concat(edgesByDst.get(candId) ?? [])) {
      if (!PUB.has(r.type)) continue;
      const o = docById.get(r.src === candId ? r.dst : r.src);
      if (o && (o.entityIds ?? []).some((e) => subjEnts.has(e))) p.push(r.type);
    }
    return [...new Set(p)];
  };
  const querySubjects = (qt) => {
    const s = new Set(); const t = (qt ?? '').toLowerCase();
    for (const [n, id] of nameToEnt) { if (id === 'e_universe') continue; if (n.length > 2 && t.includes(n)) s.add(id); }
    return s;
  };
  const scopeMatch = (qt, text) => { const m = (qt ?? '').toLowerCase().match(/for ([a-z ]+?),/); return m ? text.toLowerCase().includes(m[1].trim()) : null; };

  return { docById, supSrc, supDst, supportInDeg, conflictState, hasEvidencePath, evidenceRole, relationPath, querySubjects, scopeMatch };
}

/** Resolve event lifecycle (current/superseded) from a DECODED substrate's temporal records — the SAME
 * mapping the exporter and the eval harness use, so train-time and serve-time lifecycle agree. `decoded` is
 * `decodeSubstrate(state, {policyAtomsMode:true})`; `stableRecordIdFor` is the coretex helper. */
export function resolvedLifecycleFromDecoded(decoded, docs, stableRecordIdFor) {
  const m = new Map();
  const recordIdToEvent = new Map();
  for (const d of docs) recordIdToEvent.set(stableRecordIdFor(`mem_${d.id}`).toString(), `mem_${d.id}`);
  for (const tr of decoded.temporal ?? []) {
    const staleSlot = decoded.memoryIndex?.[tr.memorySlot];
    if (!staleSlot) continue;
    const staleEv = recordIdToEvent.get(staleSlot.recordId?.toString());
    if (tr.currentStaleFlag && staleEv) {
      m.set(staleEv, 'superseded');
      if (tr.supersededBy !== undefined && tr.supersededBy !== 0xff) {
        const curSlot = decoded.memoryIndex?.[tr.supersededBy];
        const curEv = curSlot && recordIdToEvent.get(curSlot.recordId?.toString());
        if (curEv) m.set(curEv, 'current');
      }
    } else if (!tr.currentStaleFlag && staleEv) m.set(staleEv, 'current');
  }
  return m;
}

/** Compute the full resolved MemoryIR for one candidate doc against one query. `lifecycle` is supplied by
 * the caller (resolved-state or corpus-smoke). Returns the protocol IR object (rendered by renderMemoryIRDoc). */
export function computeMemoryIR(ctx, queryText, doc, lifecycle) {
  const subj = ctx.querySubjects(queryText);
  return {
    lifecycle,
    subject_scope: nonGeneric(doc.entityIds)[0] ?? '?',
    evidence_role: ctx.evidenceRole(doc.id, subj),
    relation_path: ctx.relationPath(doc.id, subj),
    scope_match: ctx.scopeMatch(queryText, doc.text),
    conflict_state: ctx.conflictState(doc.id),
    has_public_evidence_path: ctx.hasEvidencePath(doc.id),
    answer_density: ctx.supportInDeg.get(doc.id) ?? 0,
  };
}
