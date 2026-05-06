// Baseline E — Revocation-aware Cortex.
// Header populated; RetrievalKeys populated with binary keys; the genesis
// keeps a few seed temporal entries so verifiers can trace structure.
//
// Corpus-aware miner: writes memory_index slots covering the next uncovered
// temporal-family events. For stale events the slot's REVOKED flag (bit 65,
// inside VALIDITY_FLAGS at 79:64) is set so scoreState classifies the
// eventId as correctly rejected; for current events REVOKED stays 0 so the
// eventId is classified as a correct temporal update.

import { WORD_COUNT, RANGES, PATCH_TYPE, buildHeaderWord0, makePatch, randBigInt256, xorShift32, setField } from '../types.mjs';
import { eventIdToMem128 } from '../../harness/cortex-bench-eval.mjs';

export const BASELINE_ID = 'E';
export const BASELINE_NAME = 'revocation-aware';

export function genesisState() {
  const words = new Array(WORD_COUNT).fill(0n);
  words[0] = buildHeaderWord0(1);
  words[8] = (100n << 128n);

  const rng = xorShift32(0xE5C);
  for (let slot = 0; slot < 36; slot++) {
    const base = RANGES.RETRIEVAL_KEYS_START + slot * 8;
    const keyId = randBigInt256(rng) >> 128n;
    const meta = ((keyId & ((1n << 128n) - 1n)) << 128n)
               | (0x0001n << 112n)
               | (128n    << 96n)
               | (0x0001n << 80n);
    words[base] = meta;
    for (let w = 1; w < 5; w++) words[base + w] = randBigInt256(rng);
  }
  return { words };
}

export function mineCandidatePatch(state, shardDescriptor, opts = {}) {
  const corpus = opts.corpus;
  if (!corpus) {
    // Legacy heuristic: bit-flip is_revoked in TEMPORAL_FLAGS (47:32) on a
    // temporal entry. This stays inside the spec layout (bits 31:0 reserved)
    // so reserved-bit validation passes.
    const seed = BigInt(shardDescriptor?.solveIndex ?? 0);
    const entry = Number(seed % 96n);
    const idx = RANGES.TEMPORAL_START + entry;
    const current = state.words[idx] ?? 0n;
    const flag = (current >> 32n) & 1n;
    if (flag === 1n) return null;
    let nw = setField(current, 47, 32, 1n);
    if (nw === current) return null;
    return makePatch(PATCH_TYPE.TEMPORAL_UPDATE, [idx], [nw], 250n, new Uint8Array(32));
  }

  const events = corpus.events.temporal;
  if (events.length === 0) return null;

  const occupied = new Set();
  const freeSlots = [];
  for (let s = 0; s < 44; s++) {
    const w0 = state.words[RANGES.MEMORY_INDEX_START + s * 8] ?? 0n;
    if (w0 === 0n) freeSlots.push(s);
    else occupied.add((w0 >> 128n) & ((1n << 128n) - 1n));
  }
  if (freeSlots.length === 0) return null;

  const indices = [];
  const newWords = [];
  let probe = Number(BigInt(shardDescriptor?.solveIndex ?? 0) % BigInt(events.length));
  let probesUsed = 0;
  while (indices.length < 4 && indices.length < freeSlots.length && probesUsed < events.length) {
    const ev = events[probe];
    probe = (probe + 1) % events.length;
    probesUsed++;
    const eid = eventIdToMem128(ev.id);
    if (occupied.has(eid)) continue;
    occupied.add(eid);
    const slot = freeSlots[indices.length];
    let w0 = 0n;
    w0 = setField(w0, 255, 128, eid);
    w0 = setField(w0, 127, 96,  2n);                       // domainCode 2 = temporal-derived
    w0 = setField(w0, 95, 80,   2n);                       // objType 2
    let flags = 0x0001n;                                   // VALID
    if (ev.isStaleTruth) flags |= 0x0002n;                 // REVOKED bit
    w0 = setField(w0, 79, 64, flags);
    indices.push(RANGES.MEMORY_INDEX_START + slot * 8);
    newWords.push(w0);
  }
  if (indices.length === 0) return null;

  return makePatch(
    PATCH_TYPE.SLOT_REPLACE,
    indices,
    newWords,
    250n,
    new Uint8Array(32),
  );
}
