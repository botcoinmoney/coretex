/**
 * Shared V2 honest + adversarial patch families.
 *
 * Single source of truth for the substrate-compile levers measured in the Phase 3
 * response surface AND applied in the Phase 5 real long-horizon validation, so the
 * two phases exercise byte-identical patches. All honest levers are GENUINE
 * proposer-visible compiles (no query→answer leak): the relation lever compiles
 * category-lens edges; the temporal lever compiles the corpus's own current/stale
 * memory roles + a TemporalRecord (the construction the validated p05 ON arm uses).
 *
 * Incremental "strength" arguments (edgeCount / maxRecords) let the response-surface
 * harness sweep honest patch quality to trace an acceptance curve; the long-horizon
 * harness uses the full-strength levers.
 */
import { distIndex } from '../_repo-root.mjs';

const {
  encodeRelationCategoryLens, encodeMemoryIndexSlot, encodeTemporalRecord, stableRecordIdFor,
  encodePolicyAtom, POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE, POLICY_FLAG, POLICY_TARGET_NONE,
  merkleizeState, PATCH_TYPE, RANGES, RESERVED_MASKS,
} = await import(distIndex);

export const RELATION_EDGES = ['supports', 'causes', 'supersedes', 'coreference_of'];

/** relation lever: category-lens entries for the first `edgeCount` canonical edges. */
export function relationUnits(edgeCount = RELATION_EDGES.length) {
  const indices = [], newWords = [];
  const n = Math.max(1, Math.min(RELATION_EDGES.length, edgeCount));
  for (let i = 0; i < n; i++) {
    indices.push(RANGES.RELATIONS_START + (128 - 1 - i));
    newWords.push(encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: RELATION_EDGES[i], weight: 0x8000 }));
  }
  return { indices, newWords };
}

/**
 * relation lever variant: category-lens entries for an explicit edge SUBSET, written into
 * specific entry slots (starting at `entryOffset` counting down from the high end). Lets the
 * long-horizon harness rotate distinct relation operation fingerprints over epochs without
 * overlapping the same lens entries. Each entry is one word; total = `edges.length`.
 */
export function relationUnitsForEdges(edges, entryOffset = 0) {
  const indices = [], newWords = [];
  for (let i = 0; i < edges.length; i++) {
    const entryIndex = 128 - 1 - (entryOffset + i);
    if (entryIndex < 0) break;
    indices.push(RANGES.RELATIONS_START + entryIndex);
    newWords.push(encodeRelationCategoryLens({ entryIndex, edgeType: edges[i], weight: 0x8000 }));
  }
  return { indices, newWords };
}

/**
 * conflict_lifecycle PolicyAtom lever: anchors a CONFLICT_SET_MEMBER atom on the resolved
 * doc of the next available `conflict_lifecycle` pack query. Two words: one MemoryIndex
 * slot (policyAnchor for the resolved doc) + one PolicyAtom in POLICY_CONFLICT region.
 *
 * `conflictSlot` is the per-epoch cursor — pass an integer that monotonically advances so
 * successive conflict patches occupy disjoint slots (POLICY_CONFLICT has 128 atoms; the
 * targetSlot must fit in POLICY_ANCHOR_SLOT_LIMIT = 256). `skipDocIds` keeps the harness
 * from re-anchoring the same conflict doc across patches.
 *
 * Selector pin: CONFLICT_SET_MEMBER + CONTRADICTS_EDGE matches what the conflict-INTENT
 * scorer admits (see policyConflictIntentAdmission in the reduced launch profile). The
 * action defaults to 'boost' (favor the resolved doc); pass `action: 'suppress'` to demote
 * the conflict-candidate instead — both are profile-allowed for the conflict region.
 */
export function conflictUnits({ pack, logicalQById, eventByDocId, conflictSlot = 0, action = 'boost', skipDocIds }) {
  const skip = skipDocIds ?? new Set();
  const tried = [];
  for (const ev of pack.events) {
    const lq = logicalQById.get(ev.id);
    if (!lq) continue;
    const fam = lq.family ?? lq.logicalFamily;
    if (fam !== 'conflict_lifecycle') continue;
    const resolved = (lq.qrels ?? []).find((r) => r.role === 'direct');
    if (!resolved) continue;
    if (skip.has(resolved.docId)) { tried.push(resolved.docId); continue; }
    const memEv = memoryEventForDocId(resolved.docId, eventByDocId);
    if (eventByDocId && !memEv) continue;
    const evId = memEv?.id ?? `mem_${resolved.docId}`;
    if (conflictSlot >= 128 || conflictSlot >= 256) {
      return { indices: [], newWords: [], minedDocId: null, reason: 'conflict_slot_exhausted', conflictQueriesAvailable: tried.length };
    }
    const slot = conflictSlot;
    // SubstrateFamily for MemoryIndex slots is the SCORER's anchor family enum
    // (near_collision / temporal / long_horizon / multi_hop_relation), NOT the PolicyAtom
    // family. The conflict_lifecycle PolicyAtom family lives in the conflict region; the
    // anchor slot uses multi_hop_relation to match the canonical probe-conflict-state-malleability
    // bucket — the conflict atom itself carries the family identity.
    const memWord = encodeMemoryIndexSlot({
      slotIndex: slot, recordId: stableRecordIdFor(evId),
      family: 'multi_hop_relation', domainBits: 1n,
      valid: true, revoked: false, protected: false, policyAnchor: true,
      retrievalSlot: 0, expiryEpoch: 0n,
    })[0];
    const atomWord = encodePolicyAtom({
      atomIndex: slot, family: 'conflict_lifecycle',
      selector: POLICY_SELECTOR.CONFLICT_SET_MEMBER,
      evidenceFeature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE,
      action, scope: 'conflict_set',
      targetSlot: slot, budget: 300, flags: 0,
      validFromEpoch: 0n, expiryEpoch: 0n,
    });
    return {
      indices: [RANGES.MEMORY_INDEX_START + slot, RANGES.POLICY_CONFLICT_START + slot],
      newWords: [memWord, atomWord],
      minedDocId: resolved.docId, slot, action,
    };
  }
  return { indices: [], newWords: [], minedDocId: null, reason: 'no_conflict_pack_query_available', conflictQueriesAvailable: tried.length };
}

/**
 * abstention_missing PolicyAtom lever: emits a MISSING_EVIDENCE / NO_PUBLIC_EVIDENCE_PATH
 * atom in POLICY_ABSTENTION region (32 atoms). Only fires if the pack contains at least
 * one abstention_missing query; otherwise no-op.
 *
 * Single-word patch (action='abstain', targetSlot=POLICY_TARGET_NONE) with
 * REQUIRE_NO_EVIDENCE_PATH flag — the canonical guardrail described in
 * `_r5PolicyNote._candidateNote` of the reduced launch profile.
 */
export function abstentionUnits({ pack, logicalQById, abstentionSlot = 0 }) {
  const hasAbst = pack.events.some((ev) => {
    const lq = logicalQById.get(ev.id);
    if (!lq) return false;
    const fam = lq.family ?? lq.logicalFamily;
    return fam === 'abstention_missing' || fam === 'abstention' || fam === 'unanswerable';
  });
  if (!hasAbst) return { indices: [], newWords: [], reason: 'no_abstention_pack_query_available' };
  if (abstentionSlot >= 32) return { indices: [], newWords: [], reason: 'abstention_slot_exhausted' };
  const atomWord = encodePolicyAtom({
    atomIndex: abstentionSlot, family: 'abstention',
    selector: POLICY_SELECTOR.MISSING_EVIDENCE,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.NO_PUBLIC_EVIDENCE_PATH,
    action: 'abstain', scope: 'entity',
    targetSlot: POLICY_TARGET_NONE, budget: 0, flags: POLICY_FLAG.REQUIRE_NO_EVIDENCE_PATH,
    validFromEpoch: 0n, expiryEpoch: 0n,
  });
  return {
    indices: [RANGES.POLICY_ABSTENTION_START + abstentionSlot],
    newWords: [atomWord],
    slot: abstentionSlot,
  };
}

function memoryEventForDocId(docId, eventByDocId) {
  return eventByDocId?.get(docId) ?? eventByDocId?.get(`mem_${docId}`) ?? null;
}

function recordEventIdForDocId(docId, eventByDocId) {
  return memoryEventForDocId(docId, eventByDocId)?.id ?? `mem_${docId}`;
}

export function isMemoryDocEventId(id) {
  return id.startsWith('mem_') || id.startsWith('zz_mem_') || /^zz_e\d+_mem_/.test(id);
}

export function buildMemoryEventByDocId(corpusOrEvents) {
  const events = Array.isArray(corpusOrEvents) ? corpusOrEvents : (corpusOrEvents?.events ?? []);
  const out = new Map();
  for (const ev of events) {
    out.set(ev.id, ev);
    if (!isMemoryDocEventId(ev.id)) continue;
    for (const td of ev.truthDocuments ?? []) {
      out.set(td.id, ev);
      out.set(`mem_${td.id}`, ev);
    }
  }
  return out;
}

function liveEpochForEvent(ev, lq) {
  if (Number.isInteger(lq?.liveUpdateEpoch)) return lq.liveUpdateEpoch;
  const m = /^zz_e(\d+)_/.exec(ev?.id ?? '');
  if (!m) return -1;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : -1;
}

function eventQrels(ev, lq) {
  if (lq?.qrels?.length) return lq.qrels.map((r) => ({
    docId: r.docId ?? r.documentId,
    relevance: r.relevance,
    role: r.role,
  })).filter((r) => r.docId);
  return (ev?.qrels ?? []).map((r) => ({
    docId: r.docId ?? r.documentId,
    relevance: r.relevance,
    role: r.role,
  })).filter((r) => r.docId);
}

function eventView(ev, logicalQById) {
  const lq = logicalQById.get(ev.id);
  const qrels = eventQrels(ev, lq);
  const truthDocs = (ev.truthDocuments ?? []).map((d) => d.id).filter(Boolean);
  const hardNegatives = (ev.hardNegatives ?? []).map((n) => ({
    docId: n.id ?? n.docId,
    category: n.category,
  })).filter((n) => n.docId);
  return {
    ev,
    lq,
    family: lq?.family ?? ev.logicalFamily ?? ev.family,
    qrels,
    truthDocs,
    hardNegatives,
    liveUpdateEpoch: liveEpochForEvent(ev, lq),
  };
}

function directQrelForView(view) {
  const direct = view.qrels.find((r) => r.role === 'direct' || r.relevance > 0);
  if (direct) return direct;
  const truth = view.truthDocs[0];
  return truth ? { docId: truth, relevance: 1, role: 'direct' } : null;
}

function staleQrelForView(view) {
  const stale = view.qrels.find((r) => r.role === 'stale');
  if (stale) return stale;
  const temporalHardNegative = view.hardNegatives.find((n) => /stale/i.test(n.category ?? ''));
  if (temporalHardNegative) return { docId: temporalHardNegative.docId, relevance: 0, role: 'stale' };
  return null;
}

/**
 * temporal lever: compile `maxRecords` temporal_update queries from the pack (starting
 * at the `startIndex`-th temporal query), each as stale+current memory-index slots
 * (revoked vs valid) + one TemporalRecord.
 *
 * IMPORTANT (4-word patch budget): each substrate block (memory-index slot, temporal
 * record) encodes into exactly ONE nonzero word (w0); the other 7 words are 0. We emit
 * ONLY the nonzero w0 of each block — leaving the rest at their (zero) genesis value,
 * which decodes identically — so one temporal unit = 1 record + 2 slots = 3 words, a
 * VALID single STATE_ADVANCE patch (applyPatch caps wordCount at 4). Compiling temporal
 * for many queries is therefore many small patches (realistic incremental mining), not
 * one over-budget patch. Slot/record indices advance with startIndex so successive
 * patches build disjoint substrate.
 */
// pack temporal queries (have both a current/direct and a stale qrel) — the minable set.
function packTemporalQueries(pack, logicalQById, families = ['temporal_update']) {
  const allowed = new Set(families);
  return pack.events.map((ev) => eventView(ev, logicalQById)).filter((view) => allowed.has(view.family)
    && directQrelForView(view) && staleQrelForView(view))
    .sort((a, b) => b.liveUpdateEpoch - a.liveUpdateEpoch);
}

/**
 * PACK-ALIGNED incremental mining (long-horizon production-faithful mode). Returns the
 * current-doc id of the first pack temporal query NOT yet covered by the substrate
 * (`skipDocIds`), or null if every pack temporal query is already mined. The long-horizon
 * harness uses this to (a) know what a temporal patch will mine THIS epoch and (b) advance
 * its mined-set + free record slot only on accept — decoupling the global record slot
 * (capped at 18 pairs) from the per-epoch random pack so mining does not stall when the
 * global counter exceeds a single pack's temporal-query count.
 */
export function nextTemporalDocId(pack, logicalQById, skipDocIds = new Set()) {
  for (const lq of packTemporalQueries(pack, logicalQById)) {
    const cur = (lq.qrels ?? []).find((r) => r.role === 'direct');
    if (cur && !skipDocIds.has(cur.docId)) return cur.docId;
  }
  return null;
}

export function temporalUnits({ pack, logicalQById, maxRecords = 1, startIndex = 0, recordSlot, skipDocIds, eventByDocId, families = ['temporal_update'] }) {
  const indices = [], newWords = [];
  const tq = packTemporalQueries(pack, logicalQById, families);
  // ── NEW pack-aligned mode (recordSlot given): mine the first UNCOVERED pack temporal
  // query into the explicit free record slot. Deterministic (first uncovered) so the
  // eval-call and the apply-call build the identical patch. ──
  if (recordSlot !== undefined) {
    const skip = skipDocIds ?? new Set();
    const slotBase = recordSlot, staleSlot = slotBase * 2, curSlot = slotBase * 2 + 1;
    // TIER-1 DECOUPLING (TEMPORAL_DECOUPLING_DESIGN.md): the scorer's §temporal path resolves
    // record→memorySlot→recordId→event and NEVER reads the slot's `retrievalSlot` field (the
    // lens path iterates decoded.retrievalKeys directly). So pin temporal slots' retrievalSlot
    // to a fixed in-range value (0) instead of the slot index, removing the artificial
    // `retrievalSlot < 36` → 18-pair cap. Tier-2 stride-1 MemoryIndex exposes 352
    // one-word slots, so temporal capacity is bounded by the 96-record Temporal region.
    const MEM_SLOTS = 352; // MEMORY_INDEX_SLOT_COUNT (Tier-2 stride-1 repack) — pair cap now Temporal-record-bound (slotBase<96)
    if (slotBase >= 96 || curSlot >= MEM_SLOTS) return { indices, newWords, recordsCompiled: 0, minedDocId: null, temporalQueriesAvailable: tq.length };
    for (const view of tq) {
      const cur = directQrelForView(view);
      const stale = staleQrelForView(view);
      if (skip.has(cur.docId)) continue;
      const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(recordEventIdForDocId(stale.docId, eventByDocId)), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n });
      indices.push(RANGES.MEMORY_INDEX_START + staleSlot * 1); newWords.push(sw[0]);
      const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(recordEventIdForDocId(cur.docId, eventByDocId)), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n });
      indices.push(RANGES.MEMORY_INDEX_START + curSlot * 1); newWords.push(cw[0]);
      const tw = encodeTemporalRecord({ recordIndex: slotBase, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
      indices.push(RANGES.TEMPORAL_START + slotBase); newWords.push(tw[0]);
      return { indices, newWords, recordsCompiled: 1, minedDocId: cur.docId, temporalQueriesAvailable: tq.length };
    }
    return { indices, newWords, recordsCompiled: 0, minedDocId: null, temporalQueriesAvailable: tq.length };
  }
  // ── LEGACY mode (startIndex) — unchanged; used by the response-surface / Monte-Carlo harnesses. ──
  let rec = 0;
  for (let qi = startIndex; qi < tq.length && rec < maxRecords; qi++) {
    const view = tq[qi];
    const recIdx = startIndex + rec;          // distinct record per query
    const staleSlot = recIdx * 2, curSlot = recIdx * 2 + 1;
    // Temporal RECORD capacity is 96 (stride-1). But each pair uses two MemoryIndex slots
    // whose retrievalSlot must be < 36, so curSlot = recIdx*2+1 < 36 caps the patch-family at
    // 18 temporal pairs end-to-end (NOT 96). Honest ceiling until MemoryIndex/retrieval-slot
    // coupling is redesigned.
    if (recIdx >= 96 || curSlot >= 36) break;
    const cur = directQrelForView(view);
    const stale = staleQrelForView(view);
    const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(recordEventIdForDocId(stale.docId, eventByDocId)), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, policyAnchor: true, retrievalSlot: staleSlot, expiryEpoch: 0n });
    indices.push(RANGES.MEMORY_INDEX_START + staleSlot * 1); newWords.push(sw[0]); // nonzero w0 only
    const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(recordEventIdForDocId(cur.docId, eventByDocId)), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: curSlot, expiryEpoch: 0n });
    indices.push(RANGES.MEMORY_INDEX_START + curSlot * 1); newWords.push(cw[0]);
    const tw = encodeTemporalRecord({ recordIndex: recIdx, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
    indices.push(RANGES.TEMPORAL_START + recIdx); newWords.push(tw[0]); // stride-1 temporal records
    rec++;
  }
  return { indices, newWords, recordsCompiled: rec, temporalQueriesAvailable: tq.length };
}

export function atomAnchorUnits({ pack, logicalQById, eventByDocId, atomFamily, memorySlot, skipDocIds, maxRecords = 1 }) {
  const skip = skipDocIds ?? new Set();
  const slotRange = atomFamily === 'entity_resolution_atom'
    ? { start: 128, end: 192 }
    : atomFamily === 'scope_atom'
      ? { start: 192, end: 256 }
      : { start: 128, end: 256 };
  if (memorySlot < slotRange.start || memorySlot >= slotRange.end) {
    return { indices: [], newWords: [], minedDocId: null, reason: `${atomFamily}_slot_exhausted` };
  }
  const candidates = pack.events
    .map((ev) => eventView(ev, logicalQById))
    .filter((view) => view.family === atomFamily)
    .sort((a, b) => b.liveUpdateEpoch - a.liveUpdateEpoch);
  const indices = [], newWords = [], minedDocIds = [], eventIds = [], slots = [];
  for (const view of candidates) {
    const direct = directQrelForView(view);
    if (!direct || skip.has(direct.docId)) continue;
    const memEv = memoryEventForDocId(direct.docId, eventByDocId);
    if (eventByDocId && !memEv) continue;
    if (indices.length >= maxRecords) break;
    const slot = memorySlot + indices.length;
    if (slot >= slotRange.end) break;
    const word = encodeMemoryIndexSlot({
      slotIndex: slot,
      recordId: stableRecordIdFor(memEv?.id ?? `mem_${direct.docId}`),
      family: 'multi_hop_relation',
      domainBits: 1n,
      valid: true,
      revoked: false,
      protected: false,
      policyAnchor: true,
      retrievalSlot: 0,
      expiryEpoch: 0n,
    })[0];
    indices.push(RANGES.MEMORY_INDEX_START + slot);
    newWords.push(word);
    minedDocIds.push(direct.docId);
    eventIds.push(memEv?.id ?? `mem_${direct.docId}`);
    slots.push(slot);
  }
  if (indices.length > 0) return {
    indices,
    newWords,
    recordsCompiled: indices.length,
    minedDocId: minedDocIds[0],
    minedDocIds,
    eventId: eventIds[0],
    eventIds,
    slot: slots[0],
    slots,
  };
  return { indices: [], newWords: [], minedDocId: null, reason: `no_${atomFamily}_pack_query_available` };
}

export function makePatch(state, units) {
  return { patchType: PATCH_TYPE.MIXED, wordCount: units.indices.length, scoreDelta: 0n, parentStateRoot: merkleizeState(state), indices: units.indices, newWords: units.newWords };
}

/**
 * family ∈ {relation, temporal, mixed}, all within the 4-word patch budget:
 *   relation → up to 4 category-lens edges (edgeCount, default 4)
 *   temporal → ONE temporal query's unit (3 words: 2 slots + 1 record) at startIndex
 *   mixed    → 1 relation edge + 1 temporal unit = 4 words (the only combination that fits)
 * `startIndex` selects which temporal query (incremental mining across patches).
 */
export function honestPatch({ state, family, pack, logicalQById, edgeCount = 4, startIndex = 0, recordSlot, skipDocIds }) {
  if (family === 'relation') return makePatch(state, relationUnits(edgeCount));
  if (family === 'temporal') return makePatch(state, temporalUnits({ pack, logicalQById, maxRecords: 1, startIndex, recordSlot, skipDocIds }));
  const r = relationUnits(1), t = temporalUnits({ pack, logicalQById, maxRecords: 1, startIndex, recordSlot, skipDocIds });
  return makePatch(state, { indices: [...r.indices, ...t.indices], newWords: [...r.newWords, ...t.newWords] });
}

export const empty = () => ({ words: new Array(1024).fill(0n) });
export function hseed(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
export function mulberry32(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function randomWord(rand, mask) { let v = 0n; for (let i = 0; i < 4; i++) v = (v << 64n) | (BigInt(Math.floor(rand() * 0x100000000)) << 32n) | BigInt(Math.floor(rand() * 0x100000000)); return v & (~mask); }
/** adversarial: 1–4 random words at random indices (respecting reserved masks). */
export function randomPatch(state, rand) {
  const n = 1 + Math.floor(rand() * 4); const used = new Set(); const indices = [], newWords = [];
  while (indices.length < n) {
    const idx = Math.floor(rand() * RANGES.WORD_COUNT); if (used.has(idx)) continue; used.add(idx);
    const mask = RESERVED_MASKS[idx] ?? 0n; let w = randomWord(rand, mask);
    if (w === (state.words[idx] ?? 0n)) w = (w + 1n) & (~mask);
    indices.push(idx); newWords.push(w);
  }
  return { patchType: PATCH_TYPE.MIXED, wordCount: n, scoreDelta: 0n, parentStateRoot: merkleizeState(state), indices, newWords };
}
