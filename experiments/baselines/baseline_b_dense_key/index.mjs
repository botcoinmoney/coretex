// Baseline B — Dense-key Cortex.
// Header populated; RetrievalKeys (384–671) populated with dense (256-bit) keys.
// Heuristic miner: replaces a random dense-key word with a small variation.

import { WORD_COUNT, RANGES, PATCH_TYPE, buildHeaderWord0, makePatch, randBigInt256, xorShift32 } from '../types.mjs';

export const BASELINE_ID = 'B';
export const BASELINE_NAME = 'dense-key';

export function genesisState() {
  const words = new Array(WORD_COUNT).fill(0n);
  words[0] = buildHeaderWord0(1);
  words[8] = (100n << 128n);

  // Populate the 36 retrieval-key slots (8 words each) with dense data.
  // Slot word 0: KEY_ID (255:128) + KEY_TYPE=0x0002 (127:112) + KEY_DIM=256 (111:96) + KEY_FLAGS=1 (95:80).
  // Slots 1..7: 224 bytes of dense key data.
  const rng = xorShift32(0xB0B);
  for (let slot = 0; slot < 36; slot++) {
    const base = RANGES.RETRIEVAL_KEYS_START + slot * 8;
    const keyId = randBigInt256(rng) >> 128n;
    const meta = ((keyId & ((1n << 128n) - 1n)) << 128n)
               | (0x0002n << 112n)
               | (256n    << 96n)
               | (0x0001n << 80n);
    words[base] = meta;
    for (let w = 1; w < 8; w++) words[base + w] = randBigInt256(rng);
  }
  return { words };
}

export function mineCandidatePatch(state, shardDescriptor) {
  // Patch a single dense-key word (slot 0, word 1).
  const idx = RANGES.RETRIEVAL_KEYS_START + 1;
  const current = state.words[idx] ?? 0n;
  const seed = (BigInt(shardDescriptor?.solveIndex ?? 0) ^ 0xDB1n) & ((1n << 64n) - 1n);
  const newWord = current ^ (1n << (seed % 256n));
  if (newWord === current) return null;

  return makePatch(
    PATCH_TYPE.KEY_UPDATE,
    [idx],
    [newWord],
    100n,
    new Uint8Array(32), // parentStateRoot is filled in by harness
  );
}
