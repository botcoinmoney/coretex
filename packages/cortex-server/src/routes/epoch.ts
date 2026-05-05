/**
 * GET /v1/cortex/epoch/:id
 *
 * Returns finalization status for a specific epoch, including:
 *   - stateRoot (from CortexRegistry events if available)
 *   - patchSetRoot
 *   - hiddenSeed (if revealed)
 *   - screener pass count
 *   - merge bonus funding status
 *
 * For Phase 5 this is a minimal stub that returns what we have from the
 * epoch state. Full reducer output tracking lands in Phase 6.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getEpochState } from '../internal-rpc-client.js';

export function handleEpoch() {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      // Extract :id from URL like /v1/cortex/epoch/812
      const match = (req.url ?? '').match(/\/v1\/cortex\/epoch\/(\d+)/);
      if (!match) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid epoch id in path' }));
        return;
      }

      const epochId = Number(match[1]);
      if (!Number.isFinite(epochId) || epochId < 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid epoch id' }));
        return;
      }

      // For the current epoch, return live state; for historical epochs,
      // a full implementation would query CortexRegistry events.
      let epochState;
      try {
        epochState = await getEpochState();
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal-rpc-unavailable', detail: String(err) }));
        return;
      }

      if (epochId === epochState.epochId) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          epochId,
          status: 'active',
          parentStateRoot: epochState.parentStateRoot,
          experienceCorpusRoot: epochState.experienceCorpusRoot,
          coreVersionHash: epochState.coreVersionHash,
          secretRevealed: epochState.secretRevealed,
          // TODO(Phase 6): add patchSetRoot, newStateRoot, screenerPassCount, mergeBonusFunded
        }));
      } else if (epochId < epochState.epochId) {
        // Historical epoch — Phase 6 will query CortexRegistry events
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          epochId,
          status: 'finalized',
          _note: 'Full historical epoch data requires CortexRegistry event query (Phase 6+)',
        }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'epoch-not-found', epochId }));
      }
    })();
  };
}
