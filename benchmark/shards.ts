/**
 * CoreTex pre-launch — Hidden shard derivation.
 *
 * Mirrors deriveWorldSeedU128 from:
 *   /root/botcoin-coordinator/packages/coordinator/src/epoch.ts:257
 *
 * Canonical implementation (cited verbatim):
 *
 *   export function deriveWorldSeedU128(params: {
 *     epochSecretHex: string;
 *     miner: string;
 *     epochId: bigint;
 *     solveIndex: bigint;
 *     prevReceiptHash: string;
 *     rulesVersion: number;
 *     nonce?: string;
 *   }): bigint {
 *     const packed = ethers.solidityPacked(
 *       ["bytes32", "address", "uint64", "uint64", "bytes32", "uint32"],
 *       [epochSecretHex, miner, epochId, solveIndex, prevReceiptHash, rulesVersion],
 *     );
 *     const toHash = nonce ? ethers.concat([packed, ethers.toUtf8Bytes(nonce)]) : packed;
 *     const h = ethers.keccak256(toHash);
 *     const mask128 = (1n << 128n) - 1n;
 *     return BigInt(h) & mask128;
 *   }
 *
 * This implementation reproduces exactly the same result without ethers.js,
 * using the vendored keccak256 and manual ABI packing.
 *
 * Per §5 ORGANISM_CORTEX_STATE_PLAN.md:
 *   "A miner's assigned shard is keccak(H_e ‖ miner ‖ solveIndex ‖ parentStateRoot),
 *    derived through the existing deriveWorldSeedU128(...) (epoch.ts:257)."
 *
 * The Cortex-specific derivation adds parentStateRoot where the coordinator uses
 * prevReceiptHash, and uses rulesVersion = 0xC0 for Cortex (per §6 field mapping).
 *
 * CORTEX_RULES_VERSION = 0xC0 (reserved Cortex value per §6 receipt field mapping).
 */

import { keccak256 } from './generators/keccak256_vendor.js';

// ── Constants ──────────────────────────────────────────────────────────────────

/** rulesVersion = 0xC0 for all Cortex receipts (per §6 receipt field mapping). */
export const CORTEX_RULES_VERSION = 0xC0;

// ── Shard descriptor ──────────────────────────────────────────────────────────

export interface ShardDescriptor {
  /** Epoch identifier. */
  epochId: bigint;
  /** Miner Ethereum address (checksummed or lowercase hex). */
  miner: string;
  /** solve index (0-based for this challenge). */
  solveIndex: bigint;
  /** parentStateRoot bytes32 (mirrors prevReceiptHash in the coordinator). */
  parentStateRoot: Uint8Array;
  /**
   * worldSeed (lower 128 bits of keccak256 of the packed fields).
   * This is the shardId used in the challenge response.
   */
  worldSeed: bigint;
  /** Hex shard identifier = '0x' + worldSeed.toString(16).padStart(32, '0') */
  shardId: string;
}

// ── Hidden seed commitment / reveal ───────────────────────────────────────────

export interface EpochCommitment {
  epochId: bigint;
  /** keccak256(epochSecret) — committed on-chain at epoch start. */
  hiddenSeedCommit: Uint8Array;
  /** The secret itself — revealed at epoch end. */
  epochSecret: Uint8Array;
}

/**
 * Compute the on-chain commitment for an epoch secret.
 * Mirrors: CortexShardCommitted(epoch, keccak256(epochSecret))
 */
export function commitEpochSecret(epochSecret: Uint8Array): Uint8Array {
  return keccak256(epochSecret);
}

/**
 * Verify that a revealed epoch secret matches its commitment.
 */
export function verifyEpochReveal(epochSecret: Uint8Array, commitment: Uint8Array): boolean {
  const computed = keccak256(epochSecret);
  return bytesEqual(computed, commitment);
}

// ── Shard derivation ──────────────────────────────────────────────────────────

/**
 * Derive a miner's assigned shardId for a given challenge.
 *
 * Reproduces deriveWorldSeedU128 from epoch.ts:257 without ethers.js.
 *
 * ABI packing order (matches solidityPacked):
 *   bytes32  epochSecretHex   (32 bytes, big-endian)
 *   address  miner            (20 bytes, right-padded to 20)
 *   uint64   epochId          (8 bytes, big-endian)
 *   uint64   solveIndex       (8 bytes, big-endian)
 *   bytes32  parentStateRoot  (32 bytes, big-endian) — maps to prevReceiptHash
 *   uint32   rulesVersion     (4 bytes, big-endian)
 *
 * Total packed: 32 + 20 + 8 + 8 + 32 + 4 = 104 bytes.
 *
 * Returns the lower 128 bits of keccak256(packed) as a bigint.
 */
export function deriveShardId(params: {
  epochSecret: Uint8Array;          // 32 bytes
  miner: string;                    // 0x-prefixed 20-byte address
  epochId: bigint;
  solveIndex: bigint;
  parentStateRoot: Uint8Array;      // 32 bytes
  rulesVersion?: number;            // default: CORTEX_RULES_VERSION (0xC0)
}): bigint {
  const {
    epochSecret, miner, epochId, solveIndex, parentStateRoot,
    rulesVersion = CORTEX_RULES_VERSION,
  } = params;

  // Validate lengths
  if (epochSecret.length !== 32) throw new RangeError(`epochSecret must be 32 bytes, got ${epochSecret.length}`);
  if (parentStateRoot.length !== 32) throw new RangeError(`parentStateRoot must be 32 bytes, got ${parentStateRoot.length}`);

  const minerBytes = addressToBytes20(miner);

  const packed = new Uint8Array(104);
  let off = 0;

  // bytes32 epochSecret
  packed.set(epochSecret, off); off += 32;
  // address miner (20 bytes)
  packed.set(minerBytes, off); off += 20;
  // uint64 epochId (8 bytes big-endian)
  writeBigUint64BE(packed, off, epochId); off += 8;
  // uint64 solveIndex (8 bytes big-endian)
  writeBigUint64BE(packed, off, solveIndex); off += 8;
  // bytes32 parentStateRoot
  packed.set(parentStateRoot, off); off += 32;
  // uint32 rulesVersion (4 bytes big-endian)
  packed[off + 0] = (rulesVersion >>> 24) & 0xff;
  packed[off + 1] = (rulesVersion >>> 16) & 0xff;
  packed[off + 2] = (rulesVersion >>> 8) & 0xff;
  packed[off + 3] = rulesVersion & 0xff;

  const h = keccak256(packed);
  const hBig = bytesToBigInt(h);
  const mask128 = (1n << 128n) - 1n;
  return hBig & mask128;
}

/**
 * Build a full ShardDescriptor for a challenge.
 */
export function buildShardDescriptor(params: {
  epochSecret: Uint8Array;
  miner: string;
  epochId: bigint;
  solveIndex: bigint;
  parentStateRoot: Uint8Array;
  rulesVersion?: number;
}): ShardDescriptor {
  const worldSeed = deriveShardId(params);
  const shardId = '0x' + worldSeed.toString(16).padStart(32, '0');
  return {
    epochId: params.epochId,
    miner: params.miner,
    solveIndex: params.solveIndex,
    parentStateRoot: params.parentStateRoot,
    worldSeed,
    shardId,
  };
}

// ── Epoch state (in-memory simulation) ────────────────────────────────────────

/**
 * Minimal in-memory epoch state for E2E commit/reveal simulation.
 * Does NOT touch /root/botcoin-coordinator.
 */
export interface EpochState {
  epochId: bigint;
  epochSecret: Uint8Array;
  commitment: Uint8Array;
  revealed: boolean;
  challenges: Array<{
    miner: string;
    solveIndex: bigint;
    parentStateRoot: Uint8Array;
    shardIdAtChallengeTime: string;
  }>;
}

export function createEpochState(epochId: bigint, epochSecret: Uint8Array): EpochState {
  return {
    epochId,
    epochSecret,
    commitment: commitEpochSecret(epochSecret),
    revealed: false,
    challenges: [],
  };
}

/**
 * Simulate setEpochCommit — records the commitment.
 * Returns the commitment bytes for on-chain storage.
 */
export function setEpochCommit(state: EpochState): Uint8Array {
  return state.commitment;
}

/**
 * Issue a challenge to a miner. Records the shardId at challenge time.
 */
export function issueChallengeToMiner(
  state: EpochState,
  miner: string,
  solveIndex: bigint,
  parentStateRoot: Uint8Array,
): string {
  const desc = buildShardDescriptor({
    epochSecret: state.epochSecret,
    miner,
    epochId: state.epochId,
    solveIndex,
    parentStateRoot,
  });
  state.challenges.push({
    miner,
    solveIndex,
    parentStateRoot,
    shardIdAtChallengeTime: desc.shardId,
  });
  return desc.shardId;
}

/**
 * Simulate revealEpochSecret — marks epoch as revealed.
 * Returns the epoch secret for on-chain storage.
 */
export function revealEpochSecret(state: EpochState): Uint8Array {
  state.revealed = true;
  return state.epochSecret;
}

/**
 * After reveal: recompute each miner's shardId from the revealed secret
 * and confirm it matches what was issued at challenge time.
 *
 * Returns an array of verification results.
 */
export function verifyShardConsistency(state: EpochState): Array<{
  miner: string;
  solveIndex: bigint;
  expectedShardId: string;
  actualShardId: string;
  ok: boolean;
}> {
  if (!state.revealed) {
    throw new Error('verifyShardConsistency: epoch not yet revealed');
  }

  return state.challenges.map((ch) => {
    const desc = buildShardDescriptor({
      epochSecret: state.epochSecret,
      miner: ch.miner,
      epochId: state.epochId,
      solveIndex: ch.solveIndex,
      parentStateRoot: ch.parentStateRoot,
    });
    return {
      miner: ch.miner,
      solveIndex: ch.solveIndex,
      expectedShardId: ch.shardIdAtChallengeTime,
      actualShardId: desc.shardId,
      ok: desc.shardId === ch.shardIdAtChallengeTime,
    };
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function addressToBytes20(address: string): Uint8Array {
  const hex = address.startsWith('0x') ? address.slice(2) : address;
  if (hex.length !== 40) throw new RangeError(`Invalid address length: ${address}`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function writeBigUint64BE(buf: Uint8Array, offset: number, value: bigint): void {
  const v = BigInt.asUintN(64, value);
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = Number(v & 0xffn);
    // Not shifting in-place to avoid mutation warning
  }
  // Re-encode properly big-endian
  const tmp = BigInt.asUintN(64, value);
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((tmp >> BigInt((7 - i) * 8)) & 0xffn);
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = 0; i < bytes.length; i++) {
    result = (result << 8n) | BigInt(bytes[i]!);
  }
  return result;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
