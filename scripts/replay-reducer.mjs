#!/usr/bin/env node
/**
 * Cortex Epoch Reducer — Public Replay Script
 *
 * Usage:
 *   node scripts/replay-reducer.mjs --epoch 42 --events events.json [--threshold 0]
 *   node scripts/replay-reducer.mjs --help
 *
 * Input (events.json) — array of on-chain CortexPatchAccepted event objects:
 * [
 *   {
 *     "epoch": 42,
 *     "logIndex": 0,
 *     "miner": "0x...",
 *     "patchHash": "0x...",
 *     "compactPatchBytesHex": "0x...",  // full patch payload as hex
 *     "scoreDelta": "1234",             // bigint as decimal string
 *     "indices": [100, 200],
 *     "newWords": ["...", "..."],       // uint256 as decimal strings
 *     "patchType": 1,
 *     "wordCount": 2,
 *     "parentStateRootHex": "0x..."
 *   },
 *   ...
 * ]
 *
 * Output (stdout, JSON):
 * {
 *   "epoch": 42,
 *   "patchSetRoot": "0x...",
 *   "newStateRoot": "0x...",
 *   "accepted": ["0xhash1", "0xhash2", ...],
 *   "rejected": [{"patchHash": "0xhash3", "reason": "R01_TARGET_OVERLAP"}, ...]
 * }
 *
 * This script re-derives the same accepted patch set as the coordinator reducer
 * from ONLY on-chain observable data. No coordinator access required.
 *
 * Public-replay equivalence invariant:
 *   The coordinator reducer and this script, given the same input set,
 *   produce byte-identical patchSetRoot and newStateRoot. Divergence is a bug.
 *
 * Algorithm: deterministic greedy-by-marginal-gain
 *   Sort patches by (-scoreDelta, +wordCount, +patchHash) then apply greedily,
 *   skipping target-overlap (R01) and marginal-gain-below-threshold (R02).
 *
 * Marginal evaluator: declared scoreDelta (matches the coordinator reducer's
 * offline default — conservative: it cannot invent a pass, and semantic
 * conflicts beyond the explicit threshold are not detected). The live lane
 * never uses this path; production scoring is coordinator/production-evaluator.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// ── Inline Keccak-256 (matches EVM keccak256, NOT NIST SHA-3) ─────────────────
// Identical implementation to packages/cortex/src/state/keccak256.ts
function keccak256(data) {
  const RC = [
    [0x00000000,0x00000001],[0x00000000,0x00008082],[0x80000000,0x0000808A],[0x80000000,0x80008000],
    [0x00000000,0x0000808B],[0x00000000,0x80000001],[0x80000000,0x80008081],[0x80000000,0x00008009],
    [0x00000000,0x0000008A],[0x00000000,0x00000088],[0x00000000,0x80008009],[0x00000000,0x8000000A],
    [0x00000000,0x8000808B],[0x80000000,0x0000008B],[0x80000000,0x00008089],[0x80000000,0x00008003],
    [0x80000000,0x00008002],[0x80000000,0x00000080],[0x00000000,0x0000800A],[0x80000000,0x8000000A],
    [0x80000000,0x80008081],[0x80000000,0x00008080],[0x00000000,0x80000001],[0x80000000,0x80008008],
  ];
  const RHO=[0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
  const PI =[0,10,20,5,15,16,1,11,21,6,7,17,2,12,22,23,8,18,3,13,14,24,9,19,4];
  function rot64(hi,lo,n){n=((n%64)+64)%64;if(n===0)return[hi,lo];if(n===32)return[lo,hi];if(n<32)return[((hi<<n)|(lo>>>(32-n)))>>>0,((lo<<n)|(hi>>>(32-n)))>>>0];n-=32;return[((lo<<n)|(hi>>>(32-n)))>>>0,((hi<<n)|(lo>>>(32-n)))>>>0];}
  function kF(sH,sL){const bH=new Uint32Array(5),bL=new Uint32Array(5);for(let r=0;r<24;r++){for(let x=0;x<5;x++){let h=0,l=0;for(let y=0;y<5;y++){h^=sH[x+5*y];l^=sL[x+5*y];}bH[x]=h;bL[x]=l;}for(let x=0;x<5;x++){const[th,tl]=rot64(bH[(x+1)%5],bL[(x+1)%5],1);const dh=bH[(x+4)%5]^th,dl=bL[(x+4)%5]^tl;for(let y=0;y<5;y++){sH[x+5*y]^=dh;sL[x+5*y]^=dl;}}const tH=new Uint32Array(25),tL=new Uint32Array(25);for(let i=0;i<25;i++){const[rh,rl]=rot64(sH[i],sL[i],RHO[i]);tH[PI[i]]=rh;tL[PI[i]]=rl;}for(let y=0;y<5;y++)for(let x=0;x<5;x++){const i=x+5*y;sH[i]=tH[i]^((~tH[(x+1)%5+5*y])&tH[(x+2)%5+5*y]);sL[i]=tL[i]^((~tL[(x+1)%5+5*y])&tL[(x+2)%5+5*y]);}sH[0]^=RC[r][0];sL[0]^=RC[r][1];}}
  const rate=136;const sH=new Uint32Array(25),sL=new Uint32Array(25);
  function absorb(buf,off,len){for(let i=0;i<len/8;i++){const b=off+i*8;let lo=0,hi=0;for(let j=0;j<4;j++){lo|=((buf[b+j]??0)<<(j*8));hi|=((buf[b+4+j]??0)<<(j*8));}sL[i]^=lo>>>0;sH[i]^=hi>>>0;}}
  let off=0;while(off+rate<=data.length){absorb(data,off,rate);kF(sH,sL);off+=rate;}
  const last=new Uint8Array(rate);last.set(data.subarray(off));last[data.length-off]=0x01;last[rate-1]|=0x80;absorb(last,0,rate);kF(sH,sL);
  const out=new Uint8Array(32);for(let i=0;i<4;i++){const lane=i,bo=i*8,lo=sL[lane],hi=sH[lane];out[bo]=lo&0xff;out[bo+1]=(lo>>8)&0xff;out[bo+2]=(lo>>16)&0xff;out[bo+3]=(lo>>24)&0xff;out[bo+4]=hi&0xff;out[bo+5]=(hi>>8)&0xff;out[bo+6]=(hi>>16)&0xff;out[bo+7]=(hi>>24)&0xff;}
  return out;
}

function bytesToHex(bytes) {
  let h = '0x'; for (const b of bytes) h += b.toString(16).padStart(2,'0'); return h;
}

function hexToBytes(hex) {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i*2,i*2+2),16);
  return out;
}

function writeBE32(buf, off, value) {
  let v = BigInt.asUintN(256, value);
  for (let i = 31; i >= 0; i--) { buf[off+i] = Number(v & 0xffn); v >>= 8n; }
}

// ── Merkle state root (keccak256) ──────────────────────────────────────────────
function merkleizeState(words) {
  const wordBuf = new Uint8Array(32);
  let level = new Array(1024);
  for (let i = 0; i < 1024; i++) {
    writeBE32(wordBuf, 0, words[i] ?? 0n);
    level[i] = keccak256(wordBuf.slice());
  }
  const pairBuf = new Uint8Array(64);
  while (level.length > 1) {
    const next = new Array(level.length / 2);
    for (let i = 0; i < level.length / 2; i++) {
      pairBuf.set(level[2*i], 0); pairBuf.set(level[2*i+1], 32);
      next[i] = keccak256(pairBuf.slice());
    }
    level = next;
  }
  return level[0];
}

// ── Patch apply ───────────────────────────────────────────────────────────────
function applyPatch(words, indices, newWords) {
  const result = [...words];
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx < 0 || idx >= 1024 || (idx >= 992 && idx <= 1023)) return null;
    result[idx] = newWords[i];
  }
  return result;
}

// ── patchSetRoot ──────────────────────────────────────────────────────────────
function computePatchSetRoot(acceptedBytes) {
  if (acceptedBytes.length === 0) return keccak256(new Uint8Array(0));
  const leafBuf = new Uint8Array(acceptedBytes.length * 32);
  for (let i = 0; i < acceptedBytes.length; i++) {
    leafBuf.set(keccak256(acceptedBytes[i]), i * 32);
  }
  return keccak256(leafBuf);
}

// ── Canonical patchHash (domain-prefixed) ────────────────────────────────────
// Mirrors packages/cortex/src/eval/seed-derivation.ts computePatchHash:
// keccak256('coretex-patch-hash-v1' || patchBytes). The raw un-prefixed
// keccak256(patchBytes) is NOT the canonical patch id — using it for the
// sort tiebreak would diverge from the coordinator reducer on equal-score,
// equal-size patch sets.
const PATCH_HASH_DOMAIN_PREFIX = 'coretex-patch-hash-v1';
function computePatchHash(patchBytes) {
  const prefix = new TextEncoder().encode(PATCH_HASH_DOMAIN_PREFIX);
  const buf = new Uint8Array(prefix.length + patchBytes.length);
  buf.set(prefix, 0);
  buf.set(patchBytes, prefix.length);
  return bytesToHex(keccak256(buf));
}

// ── Marginal evaluator stub ───────────────────────────────────────────────────
/**
 * Returns the patch's declared scoreDelta unchanged (the offline-reducer
 * convention; see header). Conservative: no semantic-conflict detection
 * beyond threshold checks.
 */
function stubMarginalEvaluator(_currentWords, scoreDelta) {
  return scoreDelta;
}

// ── Reducer ───────────────────────────────────────────────────────────────────
function reduce(parentStateWords, events, threshold) {
  // Build reducer inputs from on-chain events
  const patches = events.map(ev => {
    const patchBytes = hexToBytes(ev.compactPatchBytesHex);
    const patchHashHex = computePatchHash(patchBytes);
    return {
      patchHashHex,
      patchBytes,
      scoreDelta: BigInt(ev.scoreDelta),
      wordCount: ev.wordCount,
      indices: ev.indices,
      newWords: ev.newWords.map(BigInt),
      logIndex: ev.logIndex ?? 0,
    };
  });

  // Sort: (-scoreDelta, +wordCount, +patchHashHex)
  const ordered = patches.slice().sort((a, b) => {
    if (b.scoreDelta !== a.scoreDelta) return b.scoreDelta > a.scoreDelta ? 1 : -1;
    if (a.wordCount !== b.wordCount) return a.wordCount - b.wordCount;
    if (a.patchHashHex < b.patchHashHex) return -1;
    if (a.patchHashHex > b.patchHashHex) return 1;
    return 0;
  });

  let currentWords = parentStateWords;
  const accepted = [];
  const rejected = [];
  const acceptedTargets = new Set();

  for (const p of ordered) {
    // 2a. Target-overlap
    if (p.indices.some(i => acceptedTargets.has(i))) {
      rejected.push({ patchHash: p.patchHashHex, reason: 'R01_TARGET_OVERLAP' });
      continue;
    }

    // 2b. Marginal gain check
    // TODO(phase-4): Replace stubMarginalEvaluator with real evaluator
    const marginalGain = stubMarginalEvaluator(currentWords, p.scoreDelta);
    if (marginalGain < threshold) {
      rejected.push({ patchHash: p.patchHashHex, reason: 'R02_SEMANTIC_CONFLICT' });
      continue;
    }

    // 2c. Apply
    const newWords = applyPatch(currentWords, p.indices, p.newWords);
    if (newWords === null) {
      rejected.push({ patchHash: p.patchHashHex, reason: 'R02_SEMANTIC_CONFLICT' });
      continue;
    }

    currentWords = newWords;
    accepted.push({ patchHash: p.patchHashHex, patchBytes: p.patchBytes });
    for (const idx of p.indices) acceptedTargets.add(idx);
  }

  const patchSetRoot = computePatchSetRoot(accepted.map(a => a.patchBytes));
  const newStateRoot = merkleizeState(currentWords);

  return {
    patchSetRoot: bytesToHex(patchSetRoot),
    newStateRoot: bytesToHex(newStateRoot),
    accepted: accepted.map(a => a.patchHash),
    rejected,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`
Usage: node scripts/replay-reducer.mjs [OPTIONS]

Options:
  --epoch N         Epoch number (required for labeling)
  --events FILE     Path to JSON file of CortexPatchAccepted events (required)
  --state FILE      Path to JSON file of parent state words (array of 1024 hex strings)
                    If omitted, uses a zero state (for testing)
  --threshold N     Minimum marginal gain threshold (default: 0)
  --out FILE        Output file for results (default: stdout)
  --help            Show this help

Events JSON format:
  Array of objects with fields:
    epoch, logIndex, miner, patchHash, compactPatchBytesHex,
    scoreDelta (string), indices, newWords (strings), patchType, wordCount,
    parentStateRootHex

Output JSON:
  { epoch, patchSetRoot, newStateRoot, accepted, rejected }
`);
  process.exit(0);
}

function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// Support both CLI and library usage
export async function replayEpoch({ epoch, eventsJson, stateWords, threshold = 0n }) {
  const events = typeof eventsJson === 'string' ? JSON.parse(eventsJson) : eventsJson;
  const words = stateWords ?? new Array(1024).fill(0n);
  const result = reduce(words, events, threshold);
  return { epoch, ...result };
}

// CLI entrypoint
if (process.argv[1].endsWith('replay-reducer.mjs')) {
  const eventsFile = getArg('--events');
  const stateFile = getArg('--state');
  const outFile = getArg('--out');
  const epochArg = getArg('--epoch');
  const thresholdArg = getArg('--threshold');

  if (!eventsFile) {
    process.stderr.write('Error: --events FILE is required\n');
    process.exit(1);
  }

  let events;
  try {
    events = JSON.parse(readFileSync(eventsFile, 'utf8'));
  } catch (e) {
    process.stderr.write(`Error reading events file: ${e.message}\n`);
    process.exit(1);
  }

  let stateWords = new Array(1024).fill(0n);
  if (stateFile) {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
      stateWords = raw.map(v => BigInt(v));
    } catch (e) {
      process.stderr.write(`Error reading state file: ${e.message}\n`);
      process.exit(1);
    }
  }

  const threshold = BigInt(thresholdArg ?? '0');
  const epoch = epochArg ?? 'unknown';

  const result = reduce(stateWords, events, threshold);
  const output = JSON.stringify({ epoch, ...result }, null, 2);

  if (outFile) {
    writeFileSync(outFile, output, 'utf8');
    process.stderr.write(`Replay result written to ${outFile}\n`);
  } else {
    process.stdout.write(output + '\n');
  }
}
