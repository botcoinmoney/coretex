// Baseline E — Revocation-aware Cortex (PLACEHOLDER WINNER).
// Header populated; RetrievalKeys populated with binary keys; Temporal
// (800–895) populated with valid_from / valid_until / revoke_epoch fields.
// Heuristic miner: writes a revocation entry (bit 0 of TEMPORAL_FLAGS).

import { WORD_COUNT, RANGES, PATCH_TYPE, buildHeaderWord0, makePatch, randBigInt256, xorShift32, setField } from '../types.mjs';

export const BASELINE_ID = 'E';
export const BASELINE_NAME = 'revocation-aware';

export function genesisState() {
  const words = new Array(WORD_COUNT).fill(0n);
  words[0] = buildHeaderWord0(1);
  words[8] = (100n << 128n);

  const rng = xorShift32(0xE5C);
  // Binary keys (per baseline C).
  for (let slot = 0; slot < 36; slot++) {
    const base = RANGES.RETRIEVAL_KEYS_START + slot * 8;
    const keyId = randBigInt256(rng) >> 128n;
    const meta = ((keyId & ((1n << 128n) - 1n)) << 128n)
               | (0x0001n << 112n)  // binary
               | (128n    << 96n)
               | (0x0001n << 80n);
    words[base] = meta;
    for (let w = 1; w < 5; w++) words[base + w] = randBigInt256(rng);
  }

  // Populate temporal map (800–895): half active, half with valid_until set,
  // a few with revoke_epoch set.
  for (let i = 0; i < 96; i++) {
    let w = 0n;
    w = setField(w, 255, 240, BigInt(i % 44));      // MEM_IDX
    w = setField(w, 239, 176, 1n);                  // VALID_FROM_EPOCH
    if (i % 3 === 0) w = setField(w, 175, 112, 100n);  // VALID_UNTIL_EPOCH
    if (i % 7 === 0) w = setField(w, 111, 48, 50n);    // REVOKE_EPOCH
    if (i % 7 === 0) w = setField(w, 47, 32, 1n);      // is_revoked flag
    words[RANGES.TEMPORAL_START + i] = w;
  }
  return { words };
}

export function mineCandidatePatch(state, shardDescriptor) {
  // Write revocation on a temporal entry that hasn't been revoked yet.
  const seed = BigInt(shardDescriptor?.solveIndex ?? 0);
  const entry = Number(seed % 96n);
  const idx = RANGES.TEMPORAL_START + entry;
  const current = state.words[idx] ?? 0n;

  // Set is_revoked flag (bit 32) and revoke_epoch (bits 111:48 := some value).
  let newWord = current;
  // Skip if already revoked.
  if ((current >> 32n) & 1n) return null;
  newWord = setField(newWord, 47, 32, 1n);                       // is_revoked
  newWord = setField(newWord, 111, 48, BigInt(100 + Number(seed % 50n))); // revoke_epoch
  if (newWord === current) return null;

  return makePatch(
    PATCH_TYPE.TEMPORAL_UPDATE,
    [idx],
    [newWord],
    250n,
    new Uint8Array(32),
  );
}
