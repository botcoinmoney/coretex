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
 * temporal lever: for each temporal_update query in the pack (up to `maxRecords`),
 * allocate stale+current memory-index slots (revoked vs valid) and one TemporalRecord.
 * Bounded to the substrate temporal/memory-index capacity (12 records / 42 slots).
 */
export function temporalUnits({ pack, logicalQById, maxRecords = 12 }) {
  const indices = [], newWords = [];
  let slot = 0, rec = 0;
  for (const ev of pack.events) {
    if (rec >= maxRecords || slot >= 42) break;
    const lq = logicalQById.get(ev.id);
    if (!lq || lq.family !== 'temporal_update') continue;
    const cur = (lq.qrels ?? []).find((r) => r.role === 'direct');
    const stale = (lq.qrels ?? []).find((r) => r.role === 'stale');
    if (!cur || !stale) continue;
    const staleSlot = slot++, curSlot = slot++;
    const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(`mem_${stale.docId}`), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, retrievalSlot: staleSlot, expiryEpoch: 0n });
    for (let j = 0; j < 8; j++) { indices.push(RANGES.MEMORY_INDEX_START + staleSlot * 8 + j); newWords.push(sw[j]); }
    const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(`mem_${cur.docId}`), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: curSlot, expiryEpoch: 0n });
    for (let j = 0; j < 8; j++) { indices.push(RANGES.MEMORY_INDEX_START + curSlot * 8 + j); newWords.push(cw[j]); }
    const tw = encodeTemporalRecord({ recordIndex: rec, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
    for (let j = 0; j < 8; j++) { indices.push(RANGES.TEMPORAL_START + rec * 8 + j); newWords.push(tw[j]); }
    rec++;
  }
  return { indices, newWords, recordsCompiled: rec };
}

export function makePatch(state, units) {
  return { patchType: PATCH_TYPE.MIXED, wordCount: units.indices.length, scoreDelta: 0n, parentStateRoot: merkleizeState(state), indices: units.indices, newWords: units.newWords };
}

/** family ∈ {relation, temporal, mixed}. mixed = relation ∪ temporal (disjoint ranges). */
export function honestPatch({ state, family, pack, logicalQById, edgeCount, maxRecords }) {
  if (family === 'relation') return makePatch(state, relationUnits(edgeCount));
  if (family === 'temporal') return makePatch(state, temporalUnits({ pack, logicalQById, maxRecords }));
  const r = relationUnits(edgeCount), t = temporalUnits({ pack, logicalQById, maxRecords });
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
