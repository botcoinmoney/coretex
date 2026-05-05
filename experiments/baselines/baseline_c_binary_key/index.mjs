// Baseline C — Binary-key Cortex.
// Header populated; RetrievalKeys (384–671) populated with binary (bit-level) keys.
// KEY_TYPE=0x0001 (binary), KEY_DIM=128 (bits).
// Heuristic miner: bit-flips a single bit in a random binary key.

import { WORD_COUNT, RANGES, PATCH_TYPE, buildHeaderWord0, makePatch, randBigInt256, xorShift32 } from '../types.mjs';

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
               | (0x0001n << 112n)  // KEY_TYPE = binary
               | (128n    << 96n)   // KEY_DIM = 128 bits
               | (0x0001n << 80n);  // KEY_FLAGS = active
    words[base] = meta;
    // For binary keys, only words 1..4 carry 128 bits of data; words 5..7 zeroed.
    for (let w = 1; w < 5; w++) words[base + w] = randBigInt256(rng);
  }
  return { words };
}

export function mineCandidatePatch(state, shardDescriptor) {
  // Bit-flip in slot 5, word 2.
  const idx = RANGES.RETRIEVAL_KEYS_START + 5 * 8 + 2;
  const current = state.words[idx] ?? 0n;
  const seed = BigInt(shardDescriptor?.solveIndex ?? 0) ^ 0xCAFEn;
  const newWord = current ^ (1n << (seed % 256n));
  if (newWord === current) return null;

  return makePatch(
    PATCH_TYPE.KEY_UPDATE,
    [idx],
    [newWord],
    150n,
    new Uint8Array(32),
  );
}
