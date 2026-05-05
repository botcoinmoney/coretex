/**
 * GET /v1/cortex/eval-report/:hash
 *
 * Returns the eval report for a submission identified by its evalReportHash.
 * The report is stored in the submissions table (receiptJson contains it).
 *
 * Phase 5: looks up from the SQLite queue by evalReportHash embedded in
 * the receipt JSON. Phase 6+ will index this properly.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CortexDb } from '../queue/sqlite.js';

export function handleEvalReport(db: CortexDb) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const match = (req.url ?? '').match(/\/v1\/cortex\/eval-report\/(0x[0-9a-fA-F]{64})/);
      if (!match) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid eval-report hash in path (expected 0x + 64 hex chars)' }));
        return;
      }

      const hash = match[1]!.toLowerCase();

      // Scan pending/signed submissions for a matching evalReportHash
      // Phase 6: add a proper index
      const pending = db.getPendingSubmissions();
      for (const row of pending) {
        if (row.receiptJson) {
          try {
            const parsed = JSON.parse(row.receiptJson) as Record<string, unknown>;
            if (String(parsed['evalReportHash'] ?? '').toLowerCase() === hash) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                hash,
                submissionId: row.id,
                miner: row.miner,
                epoch: row.epoch,
                report: parsed['evalReport'] ?? null,
              }));
              return;
            }
          } catch { /* skip malformed */ }
        }
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'eval-report-not-found', hash }));
    })();
  };
}
