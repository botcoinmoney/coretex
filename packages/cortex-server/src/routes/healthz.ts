/**
 * GET /healthz
 *
 * Returns service health. Checks that:
 *   - SQLite queue is reachable (a quick PRAGMA check)
 *   - Worker pool is alive (at least one worker slot)
 *
 * Used by nginx upstream health checks and the scripted-miner smoke test.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CortexDb } from '../queue/sqlite.js';
import type { EvalPool } from '../workers/eval-pool.js';

export function handleHealthz(db: CortexDb, pool: EvalPool) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      let dbOk = false;
      try {
        // Simple liveness check — getOutstandingChallenge is a no-op read
        db.getOutstandingChallenge('0x0000000000000000000000000000000000000000');
        dbOk = true;
      } catch {
        dbOk = false;
      }

      // Pool liveness — `_pool` parameter was previously declared but
      // never queried, so a stuck pool reported `pool: 'ok'`. Probe
      // via the worker pool's reported size; size === 0 means the
      // pool has been closed or never initialized.
      const poolOk = (() => {
        try {
          return typeof pool.size === 'number' && pool.size > 0;
        } catch {
          return false;
        }
      })();

      const ok = dbOk && poolOk;
      const body = JSON.stringify({
        ok,
        service: 'cortex-server',
        phase: '5',
        db: dbOk ? 'ok' : 'error',
        pool: poolOk ? 'ok' : 'error',
      });

      // Return 503 when any dependency is unhealthy so upstream load
      // balancers + nginx health checks remove this host from rotation.
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(body);
    })();
  };
}
