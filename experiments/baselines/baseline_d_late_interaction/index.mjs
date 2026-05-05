// Baseline D — Late-interaction (multi-vector) Cortex.
// Header populated; RetrievalKeys populated with multi-slot vectors per
// WARP-style late-interaction (one slot per "token", many slots per record).
// Heuristic miner: refines one of the multi-slot vectors.

import { WORD_COUNT, RANGES, PATCH_TYPE, buildHeaderWord0, makePatch, randBigInt256, xorShift32 } from '../types.mjs';

export const BASELINE_ID = 'D';
export const BASELINE_NAME = 'late-interaction';

export function genesisState() {
  const words = new Array(WORD_COUNT).fill(0n);
  words[0] = buildHeaderWord0(1);
  words[8] = (100n << 128n);

  const rng = xorShift32(0xD17);
  // 36 slots → 9 records × 4 slots-per-record (multi-vector). Each slot has
  // a 7-word vector. The multi-slot organization is encoded by sharing
  // KEY_ID across the 4 slots of a record; KEY_DIM=256 each.
  for (let record = 0; record < 9; record++) {
    const recordKeyId = randBigInt256(rng) >> 128n;
    for (let v = 0; v < 4; v++) {
      const slot = record * 4 + v;
      const base = RANGES.RETRIEVAL_KEYS_START + slot * 8;
      const meta = ((recordKeyId & ((1n << 128n) - 1n)) << 128n)
                 | (0x0002n << 112n)  // dense
                 | (256n    << 96n)
                 | (0x0001n << 80n);
      words[base] = meta;
      for (let w = 1; w < 8; w++) words[base + w] = randBigInt256(rng);
    }
  }
  return { words };
}

export function mineCandidatePatch(state, shardDescriptor) {
  // Refine record 2, sub-vector 1, vector word 3.
  const slot = 2 * 4 + 1;
  const idx = RANGES.RETRIEVAL_KEYS_START + slot * 8 + 3;
  const current = state.words[idx] ?? 0n;
  const seed = BigInt(shardDescriptor?.solveIndex ?? 0);
  const newWord = current ^ ((1n << ((seed % 256n))) | (1n << (((seed * 31n) % 256n))));
  if (newWord === current) return null;

  return makePatch(
    PATCH_TYPE.KEY_UPDATE,
    [idx],
    [newWord],
    200n,
    new Uint8Array(32),
  );
}
