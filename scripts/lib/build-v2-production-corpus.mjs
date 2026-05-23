/**
 * Shared V2 logical-corpus → owner-scoped ProductionCorpus mapping.
 *
 * Single source for the bridge mapping so the production-bridge, long-horizon,
 * and profile/replay smokes all build the SAME corpus (no ad hoc per-harness
 * variants). Leak-free (no-query): query events carry NO query→answer relations;
 * only public memory-doc edges (answer→bridge etc.) are traversable. Owner-scope
 * fields (ownerEntityId/ownerScoped) + the entity table are threaded through.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot, distIndex } from '../_repo-root.mjs';

const { computeCorpusRoot, biEncoderModelIdHash } = await import(distIndex);

const PROV = { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) };
const bucket = (f) => f === 'temporal_update' ? 'temporal'
  : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance') ? 'multi_hop_relation'
  : 'near_collision';

/**
 * @param {{corpusPath:string, embPath:string, junkEdges?:number}} args
 * @returns {{corpus, queryEvents, logical, LAYOUT, BE, RR, biEncoderHash}}
 */
export function buildV2ProductionCorpus({ corpusPath, embPath, junkEdges = 0 }) {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/bundle-manifest-launch-v3.json'), 'utf8'));
  const BE = manifest.model.biEncoder, RR = manifest.model.reranker;
  const LAYOUT = { dim: BE.retrievalKeyLayout.dim, quantization: BE.retrievalKeyLayout.quantization, headerBytes: BE.retrievalKeyLayout.headerBytes };
  const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');

  const logical = JSON.parse(readFileSync(resolve(corpusPath), 'utf8'));
  const cache = JSON.parse(readFileSync(resolve(embPath), 'utf8'));
  const b64ToVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
  const int8Bytes = (vec) => { let m = 0; for (const v of vec) m = Math.max(m, Math.abs(v)); const s = m > 0 ? m / 127 : 1; const o = new Uint8Array(4 + LAYOUT.dim); new DataView(o.buffer).setFloat32(0, s, false); for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / s); c = Math.max(-127, Math.min(127, c)); o[4 + i] = c & 0xff; } return o; };
  const docEmb = new Map(logical.docs.map((d) => [d.id, int8Bytes(b64ToVec(cache.docs[d.id]))]));
  const qEmb = new Map(logical.queries.map((q) => [q.id, int8Bytes(b64ToVec(cache.queries[q.id]))]));
  const docById = new Map(logical.docs.map((d) => [d.id, d]));
  const memId = (id) => `mem_${id}`;
  const mkEmb = (q, pt, pn) => ({ modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: q, perTruth: new Map(pt), perNegative: new Map(pn) });

  const relBySrc = new Map();
  for (const r of logical.relations) { if (!relBySrc.has(r.src)) relBySrc.set(r.src, []); relBySrc.get(r.src).push(r); }
  const events = [];
  for (const d of logical.docs) {
    const e = docEmb.get(d.id);
    events.push({ id: memId(d.id), family: 'near_collision', domain: d.lane, split: 'train_visible', queryText: d.text,
      truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }],
      hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
      relations: (relBySrc.get(d.id) ?? []).map((r) => ({ other_id: memId(r.dst), edgeType: r.type })),
      ...(Array.isArray(d.entityIds) && d.entityIds.length ? { entityIds: d.entityIds } : {}),
      provenance: PROV, embeddings: mkEmb(e, [[d.id, e]], []) });
  }
  // adversarial: inject N random WRONG mem→mem edges (gameability probe).
  if (junkEdges > 0) {
    const byId = new Map(events.map((e) => [e.id, e]));
    const ids = logical.docs.map((d) => memId(d.id));
    let s = 0x9e3779b1 >>> 0; const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0; return s / 4294967296; };
    for (let k = 0; k < junkEdges; k++) { const src = byId.get(ids[Math.floor(rnd() * ids.length)]); const dst = ids[Math.floor(rnd() * ids.length)]; if (src && dst && dst !== src.id) src.relations = [...(src.relations ?? []), { other_id: dst, edgeType: 'supports' }]; }
  }
  const queryEvents = [];
  for (const q of logical.queries) {
    if (q.abstain) {
      const negs = (q.hardNegatives ?? []).map((n) => ({ id: n.docId, text: docById.get(n.docId).text, category: n.category }));
      const ev = { id: q.id, family: bucket(q.family), logicalFamily: q.family, domain: q.lane, split: q.split ?? 'eval_hidden', queryText: q.queryText, truthDocuments: [], hardNegatives: negs, qrels: [], protected: false, relations: [],
        ...(q.band ? { band: q.band } : {}),
        ...(q.ownerEntityId !== undefined ? { ownerEntityId: q.ownerEntityId, ownerScoped: q.ownerScoped !== false } : {}), provenance: PROV, embeddings: mkEmb(qEmb.get(q.id), [], negs.map((n) => [n.id, docEmb.get(n.id)])) };
      events.push(ev); queryEvents.push(ev); continue;
    }
    const truths = (q.qrels ?? []).filter((r) => r.relevance > 0).map((r) => ({ id: r.docId, text: docById.get(r.docId).text, isCurrent: docById.get(r.docId).currentStaleFlag === false ? false : true }));
    const negs = (q.hardNegatives ?? []).map((n) => ({ id: n.docId, text: docById.get(n.docId).text, category: n.category }));
    const ev = { id: q.id, family: bucket(q.family), logicalFamily: q.family, domain: q.lane, split: q.split ?? 'eval_hidden', queryText: q.queryText,
      truthDocuments: truths, hardNegatives: negs, qrels: (q.qrels ?? []).map((r) => ({ documentId: r.docId, relevance: r.relevance })), protected: false, relations: [],
      ...(q.band ? { band: q.band } : {}),
      ...(q.grounding ? { grounding: q.grounding } : {}),
      ...(q.ownerEntityId !== undefined ? { ownerEntityId: q.ownerEntityId, ownerScoped: q.ownerScoped !== false } : {}), provenance: PROV, embeddings: mkEmb(qEmb.get(q.id), truths.map((t) => [t.id, docEmb.get(t.id)]), negs.map((n) => [n.id, docEmb.get(n.id)])) };
    if (ev.family === 'temporal') ev.temporal = { validFromEpoch: 1, validUntilEpoch: Number.MAX_SAFE_INTEGER, currentStaleFlag: false };
    events.push(ev); queryEvents.push(ev);
  }
  const corpusRoot = computeCorpusRoot(events);
  const corpus = { events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot, corpusEpoch: 0,
    entities: (logical.entities ?? []).map((e) => ({ id: e.id, canonicalName: e.canonicalName, aliases: e.aliases ?? [] })),
    biEncoderModelId: BE.modelId, biEncoderRevision: BE.revision, biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: RR.modelId, labelingModelRevision: RR.revision };
  return { corpus, queryEvents, logical, LAYOUT, BE, RR, biEncoderHash };
}

/** Inert bi-encoder stub: the scorer never calls encode() (embeddings pre-baked). */
export function inertBiEncoder(BE, LAYOUT) {
  return { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, async encode() { throw new Error('biEncoder.encode not used — embeddings pre-baked'); } };
}
