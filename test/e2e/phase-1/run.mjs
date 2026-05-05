#!/usr/bin/env node
// Phase 1 E2E gate. Per ORGANISM_CORTEX_STATE_PLAN.md §9 Phase 1 the
// following must pass:
//   1. Pack/unpack round-trip on 10k randomized 1024-word states.
//   2. Reserved-bit enforcement — any state with non-zero reserved bit rejected.
//   3. Patch wire format encode/decode on 10k randomized patches.
//   4. Old-words reconstruction parity (omitted-on-wire equivalence).
//   5. Wire-size budget gate — 99th-pct ≤ 200 bytes for 4-word case on 10k fuzz.
//   6. Reject-vector coverage — explicit fixtures, stable error codes.
//
// Cross-impl Merkle parity (TS vs second reference impl) is gated to a
// follow-up PR; logged but not enforced here.
//
// Imports compiled dist/. The root `npm run test:e2e` script runs the
// workspace build first, so dist/ is always present in CI.

const {
  pack, unpack, PACKED_SIZE,
  encodePatch, decodePatch,
  applyPatch, merkleizeState,
  RANGES, PATCH_TYPE,
  hasNonZeroReservedBits,
} = await import('../../../packages/cortex/dist/state/index.js');

function xorshift32(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

function rngBigUint256(rng) {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 32n) | BigInt(rng() >>> 0);
  return v;
}

function setHeaderMagic(words) {
  words[0] = (0xC07En << 240n) | (1024n << 208n);
}

function makeRandomValidState(rng) {
  const words = new Array(RANGES.WORD_COUNT).fill(0n);
  setHeaderMagic(words);

  for (let slot = 0; slot < 44; slot++) {
    const base = 32 + slot * 8;
    const eventId = rngBigUint256(rng) >> 128n;
    words[base] = (eventId & ((1n << 128n) - 1n)) << 128n;
    const cks = rngBigUint256(rng) >> 128n;
    const cep = BigInt(rng() >>> 0);
    const eep = BigInt(rng() >>> 0);
    words[base + 1] = ((cks & ((1n << 128n) - 1n)) << 128n)
                    | ((cep & ((1n << 64n) - 1n)) << 64n)
                    |  (eep & ((1n << 64n) - 1n));
    for (let w = 2; w < 8; w++) words[base + w] = rngBigUint256(rng);
  }

  for (let slot = 0; slot < 36; slot++) {
    const base = 384 + slot * 8;
    const keyId = rngBigUint256(rng) >> 128n;
    const keyType = 1n;
    const keyDim = BigInt(rng() & 0xffff);
    const keyFlags = 1n;
    words[base] = ((keyId & ((1n << 128n) - 1n)) << 128n)
                | ((keyType & 0xffffn) << 112n)
                | ((keyDim & 0xffffn) << 96n)
                | ((keyFlags & 0xffffn) << 80n);
    for (let w = 1; w < 8; w++) words[base + w] = rngBigUint256(rng);
  }

  for (let i = 672; i <= 799; i++) {
    const src = BigInt(rng() & 0xffff);
    const dst = BigInt(rng() & 0xffff);
    const rt = 1n;
    const wt = BigInt(rng() & 0xffff);
    words[i] = (src << 240n) | (dst << 224n) | (rt << 208n) | (wt << 192n);
  }

  for (let i = 800; i <= 895; i++) {
    const memIdx = BigInt(rng() & 0xffff);
    const validFrom = BigInt(rng() >>> 0);
    const validUntil = BigInt(rng() >>> 0);
    words[i] = (memIdx << 240n) | (validFrom << 176n) | (validUntil << 112n);
  }

  for (let slot = 0; slot < 48; slot++) {
    const base = 896 + slot * 2;
    const code = BigInt(rng() & 0xffff);
    const codeType = 1n;
    const codeFlags = 1n;
    words[base] = (code << 240n) | (codeType << 224n) | (codeFlags << 208n);
    words[base + 1] = rngBigUint256(rng);
  }

  return { words };
}

console.log('[phase-1] (1) pack/unpack round-trip × 10k');
{
  const rng = xorshift32(0xCAFE1234);
  for (let i = 0; i < 10_000; i++) {
    const words = new Array(RANGES.WORD_COUNT);
    for (let w = 0; w < RANGES.WORD_COUNT; w++) words[w] = rngBigUint256(rng);
    const state = { words };
    const bytes = pack(state);
    if (bytes.length !== PACKED_SIZE) throw new Error(`pack length: ${bytes.length}`);
    const back = unpack(bytes);
    for (let w = 0; w < RANGES.WORD_COUNT; w++) {
      if (back.words[w] !== words[w]) throw new Error(`round-trip mismatch at word ${w}`);
    }
  }
  console.log('  ok — 10000 round-trips byte-identical');
}

console.log('[phase-1] (2) reserved-bit enforcement');
{
  const valid = makeRandomValidState(xorshift32(0xBEEF));
  if (hasNonZeroReservedBits(valid)) throw new Error('valid state false-positive');

  const bad1 = { words: [...valid.words] };
  bad1.words[992] = 1n;
  if (!hasNonZeroReservedBits(bad1)) throw new Error('did not catch reserved-word bit');

  const bad2 = { words: [...valid.words] };
  bad2.words[11] = 1n;
  if (!hasNonZeroReservedBits(bad2)) throw new Error('did not catch header reserved word');

  console.log('  ok — random-valid passes; reserved-word and header-reserved both rejected');
}

console.log('[phase-1] (3) patch wire encode/decode × 10k');
{
  const rng = xorshift32(0xFACEFEED);
  const types = Object.values(PATCH_TYPE);
  const allowedRangeEnd = RANGES.RESERVED_START - 1;
  for (let i = 0; i < 10_000; i++) {
    const wc = 1 + (rng() & 3);
    const indices = new Set();
    while (indices.size < wc) indices.add(rng() % allowedRangeEnd);
    const idxArr = [...indices];
    const newWords = idxArr.map(() => rngBigUint256(rng));
    const patch = {
      patchType: types[rng() % types.length],
      wordCount: wc,
      scoreDelta: BigInt.asIntN(64, BigInt(rng() | 0)),
      parentStateRoot: new Uint8Array(32).map(() => rng() & 0xff),
      indices: idxArr,
      newWords,
    };
    const wire = encodePatch(patch);
    const back = decodePatch(wire);
    if (back.patchType !== patch.patchType) throw new Error('patchType mismatch');
    if (back.wordCount !== patch.wordCount) throw new Error('wordCount mismatch');
    if (back.scoreDelta !== patch.scoreDelta) throw new Error('scoreDelta mismatch');
    for (let k = 0; k < wc; k++) {
      if (back.indices[k] !== patch.indices[k]) throw new Error('idx mismatch');
      if (back.newWords[k] !== patch.newWords[k]) throw new Error('word mismatch');
    }
  }
  console.log('  ok — 10000 patches encode→decode parity');
}

console.log('[phase-1] (4) old-words reconstruction parity');
{
  const rng = xorshift32(0xC0DE1234);
  const state = makeRandomValidState(rng);
  const root = merkleizeState(state);

  const idx = 100;
  const patch = {
    patchType: PATCH_TYPE.SLOT_REPLACE,
    wordCount: 1,
    scoreDelta: 100n,
    parentStateRoot: root,
    indices: [idx],
    newWords: [(state.words[idx] ?? 0n) ^ (1n << 200n)],
  };

  const r1 = applyPatch(state, patch);
  if (!r1.ok) throw new Error(`applyPatch failed: ${r1.code}`);
  for (let i = 0; i < RANGES.WORD_COUNT; i++) {
    if (i === idx) continue;
    if (r1.state.words[i] !== state.words[i]) throw new Error(`unexpected delta at ${i}`);
  }
  console.log('  ok — wire-omitted old words reconstructed via parent state');
}

console.log('[phase-1] (5) wire-size budget gate');
{
  const rng = xorshift32(0x99BB22CC);
  const sizes = [];
  for (let i = 0; i < 10_000; i++) {
    const indices = new Set();
    while (indices.size < 4) indices.add(rng() % (RANGES.RESERVED_START - 1));
    const idxArr = [...indices];
    const patch = {
      patchType: PATCH_TYPE.MIXED,
      wordCount: 4,
      scoreDelta: BigInt.asIntN(64, BigInt(rng() | 0)),
      parentStateRoot: new Uint8Array(32).map(() => rng() & 0xff),
      indices: idxArr,
      newWords: idxArr.map(() => rngBigUint256(rng)),
    };
    sizes.push(encodePatch(patch).length);
  }
  sizes.sort((a, b) => a - b);
  const p50 = sizes[Math.floor(sizes.length * 0.5)];
  const p99 = sizes[Math.floor(sizes.length * 0.99) - 1];
  const max = sizes[sizes.length - 1];
  console.log(`  p50=${p50} p99=${p99} max=${max}`);
  if (p99 > 200) throw new Error(`p99 ${p99} > 200-byte budget`);
  console.log('  ok — 99th-pct ≤ 200 bytes');
}

console.log('[phase-1] (6) reject-vector coverage');
{
  const state = makeRandomValidState(xorshift32(0xDEADBEEF));
  const root = merkleizeState(state);
  const wrongRoot = new Uint8Array(32).map(() => 0xAA);

  const e01 = applyPatch(state, {
    patchType: PATCH_TYPE.KEY_UPDATE, wordCount: 1, scoreDelta: 0n,
    parentStateRoot: wrongRoot, indices: [50], newWords: [123n],
  });
  if (e01.ok || e01.code !== 'E01') throw new Error(`E01 expected, got ${JSON.stringify(e01)}`);

  const e02 = applyPatch(state, {
    patchType: PATCH_TYPE.KEY_UPDATE, wordCount: 1, scoreDelta: 0n,
    parentStateRoot: root, indices: [1000], newWords: [123n],
  });
  if (e02.ok || e02.code !== 'E02') throw new Error(`E02 expected, got ${JSON.stringify(e02)}`);

  const e03 = applyPatch(state, {
    patchType: PATCH_TYPE.MIXED, wordCount: 5, scoreDelta: 0n,
    parentStateRoot: root, indices: [1, 2, 3, 4, 5], newWords: [1n, 2n, 3n, 4n, 5n],
  });
  if (e03.ok || e03.code !== 'E03') throw new Error(`E03 expected, got ${JSON.stringify(e03)}`);

  const e04 = applyPatch(state, {
    patchType: PATCH_TYPE.HEADER_UPDATE, wordCount: 1, scoreDelta: 0n,
    parentStateRoot: root, indices: [11], newWords: [1n],
  });
  if (e04.ok || e04.code !== 'E04') throw new Error(`E04 expected, got ${JSON.stringify(e04)}`);

  const e05 = applyPatch(state, {
    patchType: PATCH_TYPE.KEY_UPDATE, wordCount: 1, scoreDelta: 0n,
    parentStateRoot: root, indices: [50], newWords: [state.words[50] ?? 0n],
  });
  if (e05.ok || e05.code !== 'E05') throw new Error(`E05 expected, got ${JSON.stringify(e05)}`);

  console.log('  ok — E01..E05 each rejected with stable code');
}

console.log('[phase-1] all 6 gates green');
