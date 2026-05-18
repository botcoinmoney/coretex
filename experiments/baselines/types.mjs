/**
 * Shared types and helpers for Phase 7 baselines.
 *
 * All baselines export:
 *   genesisState()                                     → CortexState
 *   mineCandidatePatch(state, shardDescriptor)         → Patch | null
 *
 * These are plain-JS ES modules so they run without tsc compilation.
 * They inline the minimal state-codec logic needed to construct valid states,
 * following the same encoding as packages/cortex/src/state/.
 *
 * Word layout (from ORGANISM_CORTEX_STATE_PLAN.md §3):
 *   Words 0–31     protocol header
 *   Words 32–383   memory-object index slots
 *   Words 384–671  binary / multi-vector retrieval keys
 *   Words 672–799  relation and routing weights
 *   Words 800–895  temporal validity / revocation map
 *   Words 896–991  codebook / operator table
 *   Words 992–1023 reserved (must be zero)
 */

// ── Constants (mirrors packages/cortex/src/state/types.ts) ──────────────────

export const MAGIC = 0xC07En;
export const SCHEMA_VERSION_CoreTex = 0x0000n;
export const WORD_COUNT = 1024;

export const RANGES = {
  HEADER_START:         0,
  HEADER_END:           31,
  MEMORY_INDEX_START:   32,
  MEMORY_INDEX_END:     383,
  RETRIEVAL_KEYS_START: 384,
  RETRIEVAL_KEYS_END:   671,
  RELATIONS_START:      672,
  RELATIONS_END:        799,
  TEMPORAL_START:       800,
  TEMPORAL_END:         895,
  CODEBOOK_START:       896,
  CODEBOOK_END:         991,
  RESERVED_START:       992,
  RESERVED_END:         1023,
};

export const PATCH_TYPE = {
  KEY_UPDATE:      0x01,
  SLOT_REPLACE:    0x02,
  TEMPORAL_UPDATE: 0x03,
  RELATION_UPDATE: 0x04,
  CODEBOOK_UPDATE: 0x05,
  HEADER_UPDATE:   0x06,
  MIXED:           0xFF,
};

// ── Field helpers ────────────────────────────────────────────────────────────

/** Set a bit-field in a uint256 word. */
export function setField(word, bitsHi, bitsLo, value) {
  const width = bitsHi - bitsLo + 1;
  const mask = (1n << BigInt(width)) - 1n;
  const shift = BigInt(bitsLo);
  const cleared = word & ~(mask << shift);
  return cleared | ((BigInt(value) & mask) << shift);
}

/** Get a bit-field from a uint256 word. */
export function getField(word, bitsHi, bitsLo) {
  const width = bitsHi - bitsLo + 1;
  const mask = (1n << BigInt(width)) - 1n;
  return (word >> BigInt(bitsLo)) & mask;
}

// ── Header word builder ──────────────────────────────────────────────────────

/**
 * Build word 0 (header metadata word).
 *   bits 255:240  magic = 0xC07E
 *   bits 239:224  schemaVersion = 0x0000
 *   bits 223:208  wordCount = 1024
 *   bits 207:192  flags (bit 0 = genesisState)
 */
export function buildHeaderWord0(flags = 1) {
  let w = 0n;
  w = setField(w, 255, 240, MAGIC);
  w = setField(w, 239, 224, SCHEMA_VERSION_CoreTex);
  w = setField(w, 223, 208, BigInt(WORD_COUNT));
  w = setField(w, 207, 192, BigInt(flags));
  return w;
}

// ── Deterministic RNG (xorShift32) ───────────────────────────────────────────

export function xorShift32(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5;  s >>>= 0;
    return s >>> 0;
  };
}

/** Produce a deterministic bigint in [0, 2^256). */
export function randBigInt256(rng) {
  let v = 0n;
  for (let i = 0; i < 8; i++) {
    v = (v << 32n) | BigInt(rng());
  }
  return v;
}

// ── Patch wire helpers ───────────────────────────────────────────────────────

/** Write a big-endian uint256 into a buffer at offset. */
export function writeBE32(buf, off, value) {
  let v = BigInt.asUintN(256, value);
  for (let i = 31; i >= 0; i--) {
    buf[off + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/** Encode an unsigned integer as LEB128. */
export function encodeLEB128(n) {
  const bytes = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    bytes.push(b);
  } while (n !== 0);
  return new Uint8Array(bytes);
}

/**
 * Build a minimal Patch object (decoded representation).
 * parentStateRoot must be a 32-byte Uint8Array.
 */
export function makePatch(patchType, indices, newWords, scoreDelta, parentStateRoot) {
  return {
    patchType,
    wordCount: indices.length,
    scoreDelta: BigInt(scoreDelta),
    parentStateRoot,
    indices,
    newWords: newWords.map(BigInt),
  };
}

/** Encode a patch to its wire representation (matching encodePatch in patch.ts). */
export function encodePatchWire(patch) {
  const encodedIndices = patch.indices.map(encodeLEB128);
  const indexBytes = encodedIndices.reduce((s, a) => s + a.length, 0);
  const totalSize = 42 + indexBytes + patch.wordCount * 32;
  const out = new Uint8Array(totalSize);
  let offset = 0;

  out[offset++] = patch.patchType & 0xff;
  out[offset++] = patch.wordCount & 0xff;

  const sd = BigInt.asIntN(64, patch.scoreDelta);
  const sdUnsigned = BigInt.asUintN(64, sd);
  const sdHi = Number(sdUnsigned >> 32n) >>> 0;
  const sdLo = Number(sdUnsigned & 0xffffffffn) >>> 0;
  out[offset++] = (sdHi >>> 24) & 0xff;
  out[offset++] = (sdHi >>> 16) & 0xff;
  out[offset++] = (sdHi >>> 8) & 0xff;
  out[offset++] = sdHi & 0xff;
  out[offset++] = (sdLo >>> 24) & 0xff;
  out[offset++] = (sdLo >>> 16) & 0xff;
  out[offset++] = (sdLo >>> 8) & 0xff;
  out[offset++] = sdLo & 0xff;

  out.set(patch.parentStateRoot, offset);
  offset += 32;

  for (let i = 0; i < patch.wordCount; i++) {
    const idxBytes = encodedIndices[i];
    out.set(idxBytes, offset);
    offset += idxBytes.length;
    writeBE32(out, offset, patch.newWords[i] ?? 0n);
    offset += 32;
  }

  return out;
}

// ── makeZeroState ─────────────────────────────────────────────────────────────

/** All-zero state (not a valid genesis — no header magic). */
export function makeZeroState() {
  return { words: new Array(WORD_COUNT).fill(0n) };
}
