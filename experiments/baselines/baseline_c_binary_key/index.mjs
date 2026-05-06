// Baseline C — Binary-key Cortex.
// Header populated; RetrievalKeys (384–671) populated with binary (bit-level) keys.
// KEY_TYPE=0x0001 (binary), KEY_DIM=128 (bits).
// Corpus-aware miner: replaces a slot's metadata word with the 128-bit hash
// of the next uncovered near-collision event, keeping the binary key tag.

import { WORD_COUNT, RANGES, PATCH_TYPE, buildHeaderWord0, makePatch, randBigInt256, xorShift32, setField } from '../types.mjs';
import { eventIdToKey128 } from '../../harness/cortex-bench-eval.mjs';

export const BASELINE_ID = 'C';
export const BASELINE_NAME = 'binary-key';

export function genesisState() {
  const words = new Array(WORD_COUNT).fill(0n);
  words[0] = buildHeaderWord0(1);
  words[8] = (100n << 128n);

  const rng = xorShift32(0xC1B);
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
    const idx = RANGES.RETRIEVAL_KEYS_START + 5 * 8 + 2;
    const current = state.words[idx] ?? 0n;
    const seed = BigInt(shardDescriptor?.solveIndex ?? 0) ^ 0xCAFEn;
    const newWord = current ^ (1n << (seed % 256n));
    if (newWord === current) return null;
    return makePatch(PATCH_TYPE.KEY_UPDATE, [idx], [newWord], 150n, new Uint8Array(32));
  }

  const events = corpus.events.near_collision;
  if (events.length === 0) return null;

  const presentIds = new Set();
  const slotIds = [];
  for (let s = 0; s < 36; s++) {
    const w0 = state.words[RANGES.RETRIEVAL_KEYS_START + s * 8] ?? 0n;
    const id = (w0 >> 128n) & ((1n << 128n) - 1n);
    presentIds.add(id);
    slotIds.push(id);
  }

  const indices = [];
  const newWords = [];
  let probe = Number(BigInt(shardDescriptor?.solveIndex ?? 0) % BigInt(events.length));
  let slotProbe = Number(BigInt(shardDescriptor?.solveIndex ?? 0) % 36n);
  let probesUsed = 0;
  let slotsUsed = 0;
  while (indices.length < 4 && probesUsed < events.length && slotsUsed < 36) {
    const ev = events[probe];
    probe = (probe + 1) % events.length;
    probesUsed++;
    const kid = eventIdToKey128(ev.id);
    if (presentIds.has(kid)) continue;

    let slotIdx = -1;
    for (let i = 0; i < 36; i++) {
      const cand = (slotProbe + i) % 36;
      if (slotIds[cand] === 0n && !indices.includes(RANGES.RETRIEVAL_KEYS_START + cand * 8)) { slotIdx = cand; break; }
    }
    if (slotIdx < 0) {
      for (let i = 0; i < 36; i++) {
        const cand = (slotProbe + i) % 36;
        if (!indices.includes(RANGES.RETRIEVAL_KEYS_START + cand * 8)) { slotIdx = cand; break; }
      }
    }
    if (slotIdx < 0) break;
    slotProbe = (slotIdx + 1) % 36;
    slotsUsed++;

    presentIds.delete(slotIds[slotIdx]);
    slotIds[slotIdx] = kid;
    presentIds.add(kid);

    let meta = 0n;
    meta = setField(meta, 255, 128, kid);
    meta = setField(meta, 127, 112, 0x0001n);
    meta = setField(meta, 111, 96,  128n);
    meta = setField(meta, 95, 80,   0x0001n);
    indices.push(RANGES.RETRIEVAL_KEYS_START + slotIdx * 8);
    newWords.push(meta);
  }
  if (indices.length === 0) return null;

  return makePatch(
    PATCH_TYPE.KEY_UPDATE,
    indices,
    newWords,
    150n,
    new Uint8Array(32),
  );
}
