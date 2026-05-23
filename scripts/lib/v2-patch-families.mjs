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
export function temporalUnits({ pack, logicalQById, maxRecords = 1, startIndex = 0 }) {
  const indices = [], newWords = [];
  const tq = pack.events.map((ev) => logicalQById.get(ev.id)).filter((lq) => lq && lq.family === 'temporal_update'
    && (lq.qrels ?? []).find((r) => r.role === 'direct') && (lq.qrels ?? []).find((r) => r.role === 'stale'));
  let rec = 0;
  for (let qi = startIndex; qi < tq.length && rec < maxRecords; qi++) {
    const lq = tq[qi];
    const recIdx = startIndex + rec;          // distinct record per query
    const staleSlot = recIdx * 2, curSlot = recIdx * 2 + 1;
    if (recIdx >= 96 || curSlot >= 42) break; // temporal records now stride-1 (96 cap); memory-index curSlot<42 (→ ≤21 temporal pairs) is now the binding temporal-pair constraint
    const cur = (lq.qrels ?? []).find((r) => r.role === 'direct');
    const stale = (lq.qrels ?? []).find((r) => r.role === 'stale');
    const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(`mem_${stale.docId}`), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, retrievalSlot: staleSlot, expiryEpoch: 0n });
    indices.push(RANGES.MEMORY_INDEX_START + staleSlot * 8); newWords.push(sw[0]); // nonzero w0 only
    const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(`mem_${cur.docId}`), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: curSlot, expiryEpoch: 0n });
    indices.push(RANGES.MEMORY_INDEX_START + curSlot * 8); newWords.push(cw[0]);
    const tw = encodeTemporalRecord({ recordIndex: recIdx, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
    indices.push(RANGES.TEMPORAL_START + recIdx); newWords.push(tw[0]); // stride-1 temporal records
    rec++;
  }
  return { indices, newWords, recordsCompiled: rec, temporalQueriesAvailable: tq.length };
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
export function honestPatch({ state, family, pack, logicalQById, edgeCount = 4, startIndex = 0 }) {
  if (family === 'relation') return makePatch(state, relationUnits(edgeCount));
  if (family === 'temporal') return makePatch(state, temporalUnits({ pack, logicalQById, maxRecords: 1, startIndex }));
  const r = relationUnits(1), t = temporalUnits({ pack, logicalQById, maxRecords: 1, startIndex });
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
