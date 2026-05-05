/**
 * @botcoin/cortex-server — standalone /v1/cortex/* HTTP process.
 *
 * Process topology (§8):
 *   - Own PID, own SQLite at CORTEX_DB_PATH, own worker pool.
 *   - Shares signing key, epoch state, rate-limit budget, and outstanding-challenge
 *     state with the SWCP coordinator via internal RPC (INTERNAL_RPC_URL).
 *   - Behind nginx path-prefix routing: /v1/cortex/* → this process.
 *     A ?lane=cortex query string on /v1/challenge NEVER reaches here.
 *
 * HTTP framework: Node.js built-in http (zero dependencies).
 * NOTE: For production, Fastify is strongly recommended for:
 *   - Built-in JSON Schema validation (avoids hand-rolling request parsing)
 *   - Faster request throughput and lower per-request overhead
 *   - Plugin ecosystem (rate-limiting, helmet, etc.)
 *   Install with: npm install fastify @fastify/formbody
 *   Replace this file with a Fastify app once npm access is available.
 *   The route handler signatures are compatible — each handler returns
 *   (req, res) => void which Fastify can wrap trivially.
 *
 * Latch/unlatch (§8): stopping this process (SIGTERM) does NOT affect
 * any open SWCP challenge or claim. The SWCP coordinator continues
 * unmodified. On restart, SQLite queue resumes from last durable state
 * (WAL journal prevents partial-write corruption).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { openDatabase } from './queue/sqlite.js';
import { getPool, shutdownPool } from './workers/eval-pool.js';
import { handleHealthz } from './routes/healthz.js';
import { handleChallenge } from './routes/challenge.js';
import { handleSubmit } from './routes/submit.js';
import { handleState } from './routes/state.js';
import { handleEpoch } from './routes/epoch.js';
import { handleEvalReport } from './routes/eval-report.js';
import { handleMergeBonus } from './routes/merge-bonus.js';

const PORT = Number(process.env['PORT'] ?? 8081);

// ─── Open database and worker pool ──────────────────────────────────────────

const db = openDatabase();
const pool = getPool();

// ─── Route table ────────────────────────────────────────────────────────────

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: Route[] = [
  // Health
  { method: 'GET',  pattern: /^\/healthz$/,                             handler: handleHealthz(db, pool) },

  // Cortex lane — path-prefixed only. A ?lane=cortex on /v1/challenge is never proxied here.
  { method: 'GET',  pattern: /^\/v1\/cortex\/challenge$/,               handler: handleChallenge(db) },
  { method: 'POST', pattern: /^\/v1\/cortex\/submit$/,                  handler: handleSubmit(db) },
  { method: 'GET',  pattern: /^\/v1\/cortex\/state$/,                   handler: handleState() },
  { method: 'GET',  pattern: /^\/v1\/cortex\/epoch\/\d+$/,              handler: handleEpoch() },
  { method: 'GET',  pattern: /^\/v1\/cortex\/eval-report\/0x[0-9a-fA-F]{64}$/, handler: handleEvalReport(db) },
  { method: 'GET',  pattern: /^\/v1\/cortex\/merge-bonus\/claim-calldata/, handler: handleMergeBonus() },
];

// ─── Request dispatcher ──────────────────────────────────────────────────────

function dispatch(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? 'GET';
  // Strip query string for routing (path-prefix only, per §6/§8)
  const urlWithoutQuery = (req.url ?? '/').split('?')[0]!;

  for (const route of routes) {
    if (route.method === method && route.pattern.test(urlWithoutQuery)) {
      route.handler(req, res);
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    error: 'not-found',
    path: urlWithoutQuery,
    note: 'Cortex lane: /v1/cortex/* only. Use /v1/challenge for SWCP lane.',
  }));
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = createServer(dispatch);

server.listen(PORT, () => {
  console.log(`[cortex-server] listening on :${PORT}`);
  console.log(`[cortex-server] INTERNAL_RPC_URL=${process.env['INTERNAL_RPC_URL'] ?? 'http://127.0.0.1:8080'}`);
  console.log(`[cortex-server] CORTEX_DB_PATH=${process.env['CORTEX_DB_PATH'] ?? 'data/cortex/queue.db'}`);
  console.log(`[cortex-server] CORTEX_WORKER_POOL_SIZE=${process.env['CORTEX_WORKER_POOL_SIZE'] ?? 'auto'}`);
  console.log('[cortex-server] Phase 5 — eval is STUBBED (Phase 3 pending). _stub=true in reports.');
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`[cortex-server] ${signal} received — shutting down`);
  server.close(() => {
    console.log('[cortex-server] HTTP server closed');
  });

  await shutdownPool();
  db.close();

  console.log('[cortex-server] clean exit');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
