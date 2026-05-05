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
import { createHash } from 'node:crypto';
import type { CortexDb } from '../queue/sqlite.js';
import {
  getEpochState,
  getMinerTier,
  getOutstandingChallenge,
} from '../internal-rpc-client.js';

/** Default challenge TTL: 10 minutes */
const CHALLENGE_TTL_SECONDS = Number(process.env['CHALLENGE_TTL_SECONDS'] ?? 600);

/** Derive shardId from epoch hidden seed (H_e), miner address, solveIndex, parentStateRoot.
 *  Mirrors deriveWorldSeedU128 pattern from epoch.ts:257.
 *  Since H_e is the hidden seed commit (not yet revealed), we use the commit.
 *  The revealed seed is validated at submit time.
 */
function deriveShardId(
  hiddenSeedCommit: string,
  miner: string,
  solveIndex: number,
  parentStateRoot: string,
): string {
  const packed = hiddenSeedCommit + miner.toLowerCase() + solveIndex.toString(16).padStart(16, '0') + parentStateRoot.replace('0x', '');
  return '0x' + createHash('sha256').update(packed).digest('hex');
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
      let epochState, tierInfo;
      try {
        [epochState, tierInfo] = await Promise.all([
          getEpochState(),
          getMinerTier(miner),
        ]);
      } catch (err) {
        console.error('[challenge] internal-rpc epoch/tier fetch failed:', err);
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal-rpc-unavailable', detail: String(err) }));
        return;
      }

      // 3. Derive shard
      const solveIndex = 0; // TODO(Phase 6): derive from miner's lastReceiptHash chain position
      const shardId = deriveShardId(
        epochState.hiddenSeedCommit,
        miner,
        solveIndex,
        epochState.parentStateRoot,
      );

      const shardDescriptor = {
        family: 'near-collision',       // TODO(Phase 4): derive from shard seed
        difficultyTier: tierInfo.tier,
        benchmarkSubset: 'LIMIT-v0',    // TODO(Phase 4): from CortexBench V0
      };

      const expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;

      // 4. Record outstanding challenge in local DB
      db.setOutstandingChallenge(miner, epochState.epochId, shardId, expiresAt);

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
        _expiresAt: expiresAt,
      };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    })();
  };
}
