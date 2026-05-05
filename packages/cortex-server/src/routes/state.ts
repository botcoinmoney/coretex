/**
 * GET /v1/cortex/state
 *
 * Returns the current Cortex state summary: epoch, state root, patch count,
 * screener pass rate, and whether the current epoch secret is revealed.
 * Proxies epoch state from the SWCP coordinator via /internal/epoch.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getEpochState } from '../internal-rpc-client.js';

export function handleState() {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      let epochState;
      try {
        epochState = await getEpochState();
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal-rpc-unavailable', detail: String(err) }));
        return;
      }

      const body = {
        lane: 'cortex',
        epoch: epochState.epochId,
        parentStateRoot: epochState.parentStateRoot,
        experienceCorpusRoot: epochState.experienceCorpusRoot,
        coreVersionHash: epochState.coreVersionHash,
        secretRevealed: epochState.secretRevealed,
        // TODO(Phase 8): add patch count, screener pass rate from local DB
      };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    })();
  };
}
