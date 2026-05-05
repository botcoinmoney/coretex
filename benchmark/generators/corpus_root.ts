/**
 * experienceCorpusRoot builder.
 *
 * Merkle root over the corpus event set this epoch evaluates against.
 * Deterministic: same events (in canonical sort order) → same root.
 *
 * Algorithm:
 *   1. Sort events by id (lexicographic, stable).
 *   2. leaf[i] = keccak256(event.id_as_utf8 ‖ event.payload)
 *   3. Merkle tree padded to next power of 2 with zero-leaves.
 *   4. Internal: keccak256(left ‖ right).
 *
 * Uses the same keccak256 from packages/cortex/src/state/keccak256.ts,
 * vendored here to keep benchmark/ dependency-free.
 */

import type { CortexEvent } from './types.js';
import { keccak256 } from './keccak256_vendor.js';

/**
 * Compute the experienceCorpusRoot from an array of CortexEvents.
 * Returns 32 bytes (Uint8Array).
 *
 * Deterministic — events need not be pre-sorted by the caller.
 */
export function computeCorpusRoot(events: CortexEvent[]): Uint8Array {
  if (events.length === 0) {
    // Empty corpus: return zero root
    return new Uint8Array(32);
  }

  // 1. Sort by id (lexicographic)
  const sorted = [...events].sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  // 2. Leaf hashes
  const leaves: Uint8Array[] = sorted.map((ev) => eventLeaf(ev));

  // 3. Pad to next power of 2
  const n = nextPow2(leaves.length);
  const zeroLeaf = new Uint8Array(32);
  while (leaves.length < n) leaves.push(zeroLeaf);

  // 4. Reduce to root
  return merkleReduce(leaves);
}

function eventLeaf(ev: CortexEvent): Uint8Array {
  const idBytes = textEncode(ev.id);
  const buf = new Uint8Array(4 + idBytes.length + ev.payload.length);
  // length-prefix id to avoid ambiguity
  buf[0] = (idBytes.length >>> 24) & 0xff;
  buf[1] = (idBytes.length >>> 16) & 0xff;
  buf[2] = (idBytes.length >>> 8) & 0xff;
  buf[3] = idBytes.length & 0xff;
  buf.set(idBytes, 4);
  buf.set(ev.payload, 4 + idBytes.length);
  return keccak256(buf);
}

function merkleReduce(nodes: Uint8Array[]): Uint8Array {
  const pairBuf = new Uint8Array(64);
  while (nodes.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      pairBuf.set(nodes[i]!, 0);
      pairBuf.set(nodes[i + 1]!, 32);
      next.push(keccak256(pairBuf.slice(0)));
    }
    nodes = next;
  }
  return nodes[0]!;
}

function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Minimal TextEncoder shim for Node.js environments without DOM
function textEncode(s: string): Uint8Array {
  // Node.js >= 10 has global TextEncoder
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s);
  }
  return Buffer.from(s, 'utf8');
}
