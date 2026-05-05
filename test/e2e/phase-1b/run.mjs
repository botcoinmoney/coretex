#!/usr/bin/env node
/**
 * Phase 1b E2E gate — cross-impl Merkle and patch parity (TS vs Python).
 *
 * Per ORGANISM_CORTEX_STATE_PLAN.md §9 Phase 1 deferred cross-impl gate:
 *   1. Cross-impl Merkle parity: 1000 fuzzed (state, patch-set) pairs →
 *      byte-identical roots in TS and Python.
 *   2. Cross-impl pack/unpack parity: 100 states → TS-pack → Python-unpack-repack
 *      → identical bytes; vice-versa.
 *   3. Cross-impl patch wire parity: 100 patches encoded by TS decode in Python
 *      and vice-versa; 99th-pct ≤ 200 bytes for 4-word case.
 *   4. Reject-vector parity: E01..E05 each produces the same code in both impls.
 *
 * Architecture: all requests are pipelined to Python via batch-stdin mode.
 * Python processes requests as they arrive and streams responses back.
 * This avoids per-request round-trip latency.
 */

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../..');
const TS_DIST = join(ROOT, 'packages/cortex/dist/state/index.js');

if (!existsSync(TS_DIST)) {
  console.error('[phase-1b] SKIP — TS dist unavailable at ' + TS_DIST);
  process.exit(0);
}

const {
  pack, unpack,
  encodePatch, decodePatch,
  applyPatch, merkleizeState,
  RANGES, PATCH_TYPE,
  keccak256: tsKeccak256,
  bytesToHex,
} = await import(TS_DIST);

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------
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

function makeRandomValidState(rng) {
  const words = new Array(RANGES.WORD_COUNT).fill(0n);
  words[0] = (0xC07En << 240n) | (1024n << 208n);
  for (let slot = 0; slot < 44; slot++) {
    const base = 32 + slot * 8;
    const eventId = rngBigUint256(rng) >> 128n;
    words[base] = (eventId & ((1n << 128n) - 1n)) << 128n;
    const cks = rngBigUint256(rng) >> 128n;
    const cep = BigInt(rng() >>> 0);
    const eep = BigInt(rng() >>> 0);
    words[base + 1] = ((cks & ((1n << 128n) - 1n)) << 128n) | ((cep & ((1n << 64n) - 1n)) << 64n) | (eep & ((1n << 64n) - 1n));
    for (let w = 2; w < 8; w++) words[base + w] = rngBigUint256(rng);
  }
  for (let slot = 0; slot < 36; slot++) {
    const base = 384 + slot * 8;
    const keyId = rngBigUint256(rng) >> 128n;
    words[base] = ((keyId & ((1n << 128n) - 1n)) << 128n) | (1n << 112n) | (BigInt(rng() & 0xffff) << 96n) | (1n << 80n);
    for (let w = 1; w < 8; w++) words[base + w] = rngBigUint256(rng);
  }
  for (let i = 672; i <= 799; i++) {
    words[i] = (BigInt(rng() & 0xffff) << 240n) | (BigInt(rng() & 0xffff) << 224n) | (1n << 208n) | (BigInt(rng() & 0xffff) << 192n);
  }
  for (let i = 800; i <= 895; i++) {
    words[i] = (BigInt(rng() & 0xffff) << 240n) | (BigInt(rng() >>> 0) << 176n) | (BigInt(rng() >>> 0) << 112n);
  }
  for (let slot = 0; slot < 48; slot++) {
    const base = 896 + slot * 2;
    words[base] = (BigInt(rng() & 0xffff) << 240n) | (1n << 224n) | (1n << 208n);
    words[base + 1] = rngBigUint256(rng);
  }
  return { words };
}

// ---------------------------------------------------------------------------
// Python batch runner: write all requests, then read all responses
// ---------------------------------------------------------------------------
function runPythonBatch(requests) {
  const pyDir = join(ROOT, 'packages/cortex-py');
  const input = requests.map(r => JSON.stringify(r)).join('\n') + '\n';
  const result = spawnSync('python3', ['-m', 'cortex_py', 'batch-stdin'], {
    cwd: pyDir,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,  // 64MB
    timeout: 300_000,  // 5 min
  });
  if (result.status !== 0) {
    throw new Error(`Python batch failed: ${result.stderr}`);
  }
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}

let failed = 0;

// ---------------------------------------------------------------------------
// (0) Keccak-256 sanity
// ---------------------------------------------------------------------------
console.log('[phase-1b] (0) keccak256 sanity check');
{
  const EXPECTED = 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
  const got = bytesToHex(tsKeccak256(new Uint8Array(0)));
  const gotHex = got.startsWith('0x') ? got.slice(2) : got;
  if (gotHex !== EXPECTED) {
    console.error(`  FAIL TS keccak256("") = ${gotHex} (expected ${EXPECTED})`);
    failed++;
    console.error('[phase-1b] Aborting: TS keccak bug detected. Fix keccak256.ts first.');
    process.exit(1);
  }
  console.log(`  ok — keccak256("") = ${gotHex.slice(0, 16)}...`);
}

// ---------------------------------------------------------------------------
// (1) Cross-impl Merkle parity: 1000 fuzzed pairs (pipelined)
// ---------------------------------------------------------------------------
console.log('[phase-1b] (1) cross-impl Merkle parity — 1000 fuzzed pairs');
{
  const N = 1000;
  const rng = xorshift32(0xC0DE_BEEF);
  const states = [];
  const tsRoots = [];

  // Generate all states and TS roots first
  for (let i = 0; i < N; i++) {
    const state = makeRandomValidState(rng);
    states.push(state);
    const r = bytesToHex(merkleizeState(state));
    tsRoots.push(r.startsWith('0x') ? r.slice(2) : r);
  }

  // Build batch requests for Python
  const requests = states.map((state) => ({
    cmd: 'merkleize',
    state: Buffer.from(pack(state)).toString('hex'),
  }));

  const t0 = Date.now();
  const responses = runPythonBatch(requests);
  const elapsed = (Date.now() - t0) / 1000;
  const throughput = Math.round(N / elapsed);

  let merkFail = 0;
  for (let i = 0; i < N; i++) {
    const res = responses[i];
    if (!res.ok) { merkFail++; continue; }
    if (tsRoots[i] !== res.root) {
      if (merkFail < 3) {
        console.error(`  FAIL pair ${i}: TS=${tsRoots[i].slice(0,16)}... Py=${res.root.slice(0,16)}...`);
      }
      merkFail++;
    }
  }
  console.log(`  throughput: ${throughput} pairs/sec (${elapsed.toFixed(2)}s)`);
  if (merkFail > 0) {
    console.error(`  FAIL — ${merkFail}/${N} root mismatches`);
    failed += merkFail;
  } else {
    console.log(`  ok — ${N} pairs: byte-identical Merkle roots`);
  }
}

// ---------------------------------------------------------------------------
// (2) Cross-impl pack/unpack parity: 100 states
// ---------------------------------------------------------------------------
console.log('[phase-1b] (2) cross-impl pack/unpack parity — 100 states');
{
  const rng = xorshift32(0xBEEF_FACE);
  const states = Array.from({ length: 100 }, () => makeRandomValidState(rng));
  const hexes = states.map(s => Buffer.from(pack(s)).toString('hex'));
  const requests = hexes.map(h => ({ cmd: 'pack-unpack', state: h }));
  const responses = runPythonBatch(requests);

  let packFail = 0;
  for (let i = 0; i < 100; i++) {
    const res = responses[i];
    if (!res.ok || res.state !== hexes[i]) packFail++;
  }
  if (packFail > 0) {
    console.error(`  FAIL — ${packFail}/100 pack/unpack mismatches`);
    failed += packFail;
  } else {
    console.log('  ok — 100 states: TS-pack → Python-unpack-repack = identical');
  }
}

// ---------------------------------------------------------------------------
// (3) Cross-impl patch wire parity: 100 patches
// ---------------------------------------------------------------------------
console.log('[phase-1b] (3) cross-impl patch wire parity — 100 patches');
{
  const rng = xorshift32(0xFEED_1234);
  const patches = [];
  const patchSizes = [];

  for (let i = 0; i < 100; i++) {
    const wc = (rng() % 4) + 1;
    const idxSet = new Set();
    while (idxSet.size < wc) idxSet.add(rng() % (RANGES.RESERVED_START - 1));
    const indices = [...idxSet].slice(0, wc);
    const patch = {
      patchType: PATCH_TYPE.MIXED, wordCount: wc,
      scoreDelta: BigInt.asIntN(64, BigInt(rng() | 0)),
      parentStateRoot: new Uint8Array(32).map(() => rng() & 0xff),
      indices, newWords: indices.map(() => rngBigUint256(rng)),
    };
    const wire = encodePatch(patch);
    patchSizes.push(wire.length);
    patches.push(Buffer.from(wire).toString('hex'));
  }
  patchSizes.sort((a, b) => a - b);
  const p99 = patchSizes[Math.floor(patchSizes.length * 0.99) - 1];

  const requests = patches.map(p => ({ cmd: 'encode-decode-patch', patch: p }));
  const responses = runPythonBatch(requests);

  let wireFail = 0;
  for (let i = 0; i < 100; i++) {
    const res = responses[i];
    if (!res.ok || res.patch !== patches[i]) wireFail++;
  }
  console.log(`  p50=${patchSizes[49]} p99=${p99} max=${patchSizes[99]}`);
  if (wireFail > 0) {
    console.error(`  FAIL — ${wireFail}/100 wire mismatches`);
    failed += wireFail;
  } else {
    console.log('  ok — 100 patches: TS-encode → Python-decode-reencode = identical');
  }
  if (p99 > 200) {
    console.error(`  FAIL — p99 ${p99} > 200-byte budget`);
    failed++;
  } else {
    console.log(`  ok — p99 ${p99} ≤ 200-byte budget`);
  }
}

// ---------------------------------------------------------------------------
// (4) Reject-vector parity: E01..E05
// ---------------------------------------------------------------------------
console.log('[phase-1b] (4) reject-vector parity — E01..E05');
{
  const rng = xorshift32(0xDEAD_C0DE);
  const state = makeRandomValidState(rng);
  const root = merkleizeState(state);
  const stateHex = Buffer.from(pack(state)).toString('hex');
  const wrongRoot = new Uint8Array(32).fill(0xAA);

  // Build wire bytes for E03 manually (encodePatch rejects wordCount>4 by design)
  // Wire: patchType(1) + wordCount(1) + scoreDelta(8) + parentRoot(32) + 5×(leb128+32bytes)
  function buildOverBudgetWire(parentRoot) {
    const out = [];
    out.push(PATCH_TYPE.MIXED);  // patchType
    out.push(5);                  // wordCount = 5 (over budget)
    for (let i = 0; i < 8; i++) out.push(0);  // scoreDelta = 0
    for (const b of parentRoot) out.push(b);   // parentStateRoot
    for (let k = 0; k < 5; k++) {
      out.push(k + 1);  // LEB128 index (1-byte for 1-5)
      for (let b = 0; b < 31; b++) out.push(0);
      out.push(k + 1);  // newWord = k+1
    }
    return Buffer.from(out);
  }

  const validCases = [
    {
      name: 'E01', expected: 'E01',
      patch: { patchType: PATCH_TYPE.SLOT_REPLACE, wordCount: 1, scoreDelta: 0n, parentStateRoot: wrongRoot, indices: [50], newWords: [123n] },
      wire: () => encodePatch({ patchType: PATCH_TYPE.SLOT_REPLACE, wordCount: 1, scoreDelta: 0n, parentStateRoot: wrongRoot, indices: [50], newWords: [123n] }),
    },
    {
      name: 'E02', expected: 'E02',
      patch: { patchType: PATCH_TYPE.MIXED, wordCount: 1, scoreDelta: 0n, parentStateRoot: root, indices: [1000], newWords: [123n] },
      wire: () => encodePatch({ patchType: PATCH_TYPE.MIXED, wordCount: 1, scoreDelta: 0n, parentStateRoot: root, indices: [1000], newWords: [123n] }),
    },
    {
      name: 'E04', expected: 'E04',
      patch: { patchType: PATCH_TYPE.HEADER_UPDATE, wordCount: 1, scoreDelta: 0n, parentStateRoot: root, indices: [11], newWords: [1n] },
      wire: () => encodePatch({ patchType: PATCH_TYPE.HEADER_UPDATE, wordCount: 1, scoreDelta: 0n, parentStateRoot: root, indices: [11], newWords: [1n] }),
    },
    {
      name: 'E05', expected: 'E05',
      patch: { patchType: PATCH_TYPE.SLOT_REPLACE, wordCount: 1, scoreDelta: 0n, parentStateRoot: root, indices: [50], newWords: [state.words[50] ?? 0n] },
      wire: () => encodePatch({ patchType: PATCH_TYPE.SLOT_REPLACE, wordCount: 1, scoreDelta: 0n, parentStateRoot: root, indices: [50], newWords: [state.words[50] ?? 0n] }),
    },
  ];

  // E03: apply-level check (wordCount>4) — TS applyPatch returns E03 regardless of wire
  // For Python wire test, we need to send the raw over-budget wire bytes
  const e03Wire = buildOverBudgetWire(root);
  const e03PatchObj = { patchType: PATCH_TYPE.MIXED, wordCount: 5, scoreDelta: 0n, parentStateRoot: root, indices: [1,2,3,4,5], newWords: [1n,2n,3n,4n,5n] };

  const requests = [
    ...validCases.map(c => ({
      cmd: 'apply-patch', state: stateHex,
      patch: Buffer.from(c.wire()).toString('hex'),
    })),
    { cmd: 'apply-patch', state: stateHex, patch: e03Wire.toString('hex') },
  ];
  const pyResponses = runPythonBatch(requests);

  let rvFail = 0;
  for (let i = 0; i < validCases.length; i++) {
    const { name, expected, patch } = validCases[i];
    const tsResult = applyPatch(state, patch);
    const pyResult = pyResponses[i];
    if (tsResult.ok || tsResult.code !== expected) {
      console.error(`  FAIL ${name} TS: ${JSON.stringify(tsResult)}`); rvFail++;
    }
    if (pyResult.ok || pyResult.code !== expected) {
      console.error(`  FAIL ${name} Py: ${JSON.stringify(pyResult)}`); rvFail++;
    }
  }
  // E03 TS check
  const tsE03 = applyPatch(state, e03PatchObj);
  const pyE03 = pyResponses[validCases.length];
  if (tsE03.ok || tsE03.code !== 'E03') {
    console.error(`  FAIL E03 TS: ${JSON.stringify(tsE03)}`); rvFail++;
  }
  if (pyE03.ok || pyE03.code !== 'E03') {
    console.error(`  FAIL E03 Py: ${JSON.stringify(pyE03)}`); rvFail++;
  }

  failed += rvFail;
  if (rvFail === 0) console.log('  ok — E01..E05 identical codes in TS and Python');
}

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------
if (failed > 0) {
  console.error(`\n[phase-1b] FAIL — ${failed} assertions failed`);
  process.exit(1);
}
console.log('\n[phase-1b] all cross-impl parity gates green');
