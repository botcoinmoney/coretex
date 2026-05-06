/**
 * GET /v1/cortex/challenge
 *
 * Response shape (§6):
 * {
 *   lane: "cortex",
 *   epoch: N,
 *   parentStateRoot: "0x...",
 *   experienceCorpusRoot: "0x...",
 *   coreVersionHash: "0x...",
 *   patchObjective: "KEY_UPDATE" | ...,
 *   patchBudget: 4,
 *   shardId: "0x...",
 *   shardDescriptor: {...},
 *   submissionFormat: "cortex-patch-v0",
 *   creditsPerSolve: N
 * }
 *
 * Enforces single outstanding challenge across lanes (§6/§8):
 *   - Queries /internal/outstanding-challenge on the SWCP process.
 *   - If a SWCP or Cortex challenge is already open, returns 409.
 *   - On serving a challenge, records it in the local outstanding_challenges table.
 *
 * Path-prefix routing: this handler is ONLY reachable via /v1/cortex/challenge.
 * A ?lane=cortex query string on /v1/challenge is NEVER proxied here (verified
 * by the Phase 5 path-routing isolation E2E test).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CortexDb } from '../queue/sqlite.js';
import {
  getEpochState,
  getMinerTier,
  getMinerReceiptChain,
  getOutstandingChallenge,
  setOutstandingChallenge,
} from '../internal-rpc-client.js';
import { deriveShardIdHex, hexToBytes } from '@botcoin/cortex';

/** Default challenge TTL: 10 minutes */
const CHALLENGE_TTL_SECONDS = Number(process.env['CHALLENGE_TTL_SECONDS'] ?? 600);

/**
 * Canonical challenge-time shard derivation (Step 6 fix).
 *
 * Uses the same `deriveShardIdU128` (Keccak-256 over ABI-packed
 * (epochSecret, miner, epochId, solveIndex, parentStateRoot, rulesVersion=0xC0))
 * as benchmark/shards.ts and the post-reveal auditor path. Returns the
 * lower 128 bits as a 0x-prefixed 16-byte hex.
 *
 * The `epochSecret` is provided by the SWCP coordinator over the trusted
 * internal RPC. Pre-reveal, only the coordinator + cortex-server see the
 * secret; the public sees only `hiddenSeedCommit = keccak256(epochSecret)`.
 * After CortexShardRevealed lands on-chain, anyone can re-derive byte-identically.
 */
function deriveCanonicalShardId(
  epochSecretHex: string,
  miner: string,
  solveIndex: number,
  parentStateRoot: string,
  epochId: number,
): string {
  const epochSecret = hexToBytes(
    epochSecretHex.startsWith('0x') ? epochSecretHex : '0x' + epochSecretHex,
  );
  const psr = hexToBytes(
    parentStateRoot.startsWith('0x') ? parentStateRoot : '0x' + parentStateRoot,
  );
  return deriveShardIdHex({
    epochSecret,
    miner,
    epochId: BigInt(epochId),
    solveIndex: BigInt(solveIndex),
    parentStateRoot: psr,
  });
}

function extractMiner(req: IncomingMessage): string | null {
  const h = req.headers['x-miner'];
  if (typeof h === 'string' && /^0x[0-9a-fA-F]{40}$/.test(h)) {
    return h.toLowerCase();
  }
  return null;
}

export function handleChallenge(db: CortexDb) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const miner = extractMiner(req);
      if (!miner) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing-or-invalid-x-miner header' }));
        return;
      }

      // 1. Check cross-lane outstanding challenge (SWCP process)
      let outstanding;
      try {
        outstanding = await getOutstandingChallenge(miner);
      } catch (err) {
        // If SWCP is unavailable, fail closed — do NOT serve a challenge.
        console.error('[challenge] internal-rpc outstanding-challenge failed:', err);
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal-rpc-unavailable', detail: String(err) }));
        return;
      }

      if (outstanding.outstanding) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'outstanding-challenge',
          lane: outstanding.lane,
          expiresAt: outstanding.expiresAt,
          message: `A ${outstanding.lane} challenge is already open. Submit or wait for expiry.`,
        }));
        return;
      }

      // 2. Fetch epoch state and miner tier
      let epochState, tierInfo, receiptChain;
      try {
        [epochState, tierInfo, receiptChain] = await Promise.all([
          getEpochState(),
          getMinerTier(miner),
          getMinerReceiptChain(miner),
        ]);
      } catch (err) {
        console.error('[challenge] internal-rpc epoch/tier fetch failed:', err);
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal-rpc-unavailable', detail: String(err) }));
        return;
      }

      // 3. Derive shard via canonical Keccak path (Steps 4 + 6).
      //    Requires `epochSecret` from the SWCP coordinator's internal RPC.
      //    Fail closed if missing — using hiddenSeedCommit (the public hash)
      //    breaks the hidden-shard property.
      if (!epochState.epochSecret) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'epoch-secret-unavailable',
          message: 'SWCP /internal/epoch did not return epochSecret. Update SWCP coordinator to expose it; canonical hidden-shard derivation requires it.',
        }));
        return;
      }
      const solveIndex = receiptChain.solveIndex;
      const shardId = deriveCanonicalShardId(
        epochState.epochSecret,
        miner,
        solveIndex,
        epochState.parentStateRoot,
        epochState.epochId,
      );

      const shardDescriptor = {
        family: 'near-collision',       // TODO(Phase 4): derive from shard seed
        difficultyTier: tierInfo.tier,
        benchmarkSubset: 'LIMIT-v0',    // TODO(Phase 4): from CortexBench V0
      };

      const expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;

      // 4. Record outstanding challenge in the SWCP-side cross-lane store
      // before returning it to the miner. If this fails, fail closed: SWCP
      // must know about Cortex challenges or the single-outstanding invariant
      // does not hold across lanes.
      try {
        await setOutstandingChallenge({
          miner,
          lane: 'cortex',
          expiresAt,
          shardOrChallengeId: shardId,
        });
      } catch (err) {
        console.error('[challenge] internal-rpc outstanding-challenge/set failed:', err);
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal-rpc-unavailable', detail: String(err) }));
        return;
      }

      // 5. Record outstanding challenge in local DB
      db.setOutstandingChallenge(
        miner,
        epochState.epochId,
        shardId,
        solveIndex,
        receiptChain.prevReceiptHash.toLowerCase(),
        expiresAt,
      );

      const body = {
        lane: 'cortex',
        epoch: epochState.epochId,
        parentStateRoot: epochState.parentStateRoot,
        experienceCorpusRoot: epochState.experienceCorpusRoot,
        coreVersionHash: epochState.coreVersionHash,
        patchObjective: 'KEY_UPDATE',
        patchBudget: 4,
        shardId,
        shardDescriptor,
        submissionFormat: 'cortex-patch-v0',
        creditsPerSolve: tierInfo.creditsPerSolve,
        solveIndex,
        prevReceiptHash: receiptChain.prevReceiptHash.toLowerCase(),
        _expiresAt: expiresAt,
      };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    })();
  };
}
