/**
 * @botcoin/cortex-handler — single-line drop-in router for the SWCP coordinator.
 *
 * §13.4 plug-and-play guarantee:
 *   One import + one function call. Zero changes to existing SWCP routes.
 *
 * Usage in the SWCP coordinator (packages/coordinator/src/server.ts):
 *
 *   import { mountCortexHandler } from '@botcoin/cortex-handler';
 *   mountCortexHandler(app, { receiptSigner, epochState, rateLimitBudget, db });
 *
 * Adds:
 *   GET  /internal/miner-tier?miner=0x...
 *   GET  /internal/miner-receipt-chain?miner=0x...
 *   POST /internal/sign-cortex-receipt
 *   POST /internal/sign-coretex-work-receipt
 *   GET  /internal/epoch
 *   GET  /internal/rate-limit-budget?miner=0x...&lane=cortex
 *   GET  /internal/outstanding-challenge?miner=0x...
 *   POST /internal/outstanding-challenge/set        (coordinator route shim calls after issuing a challenge)
 *   POST /internal/outstanding-challenge/clear      (coordinator route shim calls to clear after submit)
 *
 * Never modifies /v1/challenge or /v1/submit.
 * The signing key lives exclusively in receiptSigner — never in coordinator route shim.
 *
 * Express-compatible: app is typed as a minimal Express.Application interface so this
 * works with express@4 / express@5 without importing express types here.
 * For Fastify: wrap with fastify.addContentTypeParser + a small adapter (see README).
 */

import { getCortexStore } from './cortex-store.js';

// ─── Dep interface ─────────────────────────────────────────────────────────────

/**
 * Minimal interface for the existing SWCP ReceiptSigner.
 * Matches signer.ts:8-29 (ReceiptSigner class).
 */
export interface ReceiptSignerLike {
  signReceipt(receiptData: {
    miner: string;
    epochId: bigint;
    solveIndex: bigint;
    prevReceiptHash: string;
    challengeId: string;
    commit: string;
    docHash: string;
    questionsHash: string;
    constraintsHash: string;
    answersHash: string;
    worldSeed: bigint;
    rulesVersion: number;
  }): Promise<{ signature: string; receipt: unknown }>;
  signWorkReceipt?(receiptData: {
    miner: string;
    epochId: bigint;
    solveIndex: bigint;
    prevReceiptHash: string;
    lane: number;
    outcome: number;
    challengeId: string;
    parentStateRoot: string;
    artifactHash: string;
    worldSeed: bigint;
    rulesVersion: number;
    workPolicyHash: string;
    workUnitsBps: bigint;
  }): Promise<{ signature: string; receipt: unknown }>;
}

/**
 * Epoch state accessor. Returns the current epoch state.
 * Matches the shape getEpochState() returns in epoch.ts.
 */
export interface EpochStateAccessor {
  getCurrentEpoch(): Promise<{
    epochId: number;
    parentStateRoot: string;
    experienceCorpusRoot: string;
    coreVersionHash: string;
    hiddenSeedCommit: string;
    epochSecret?: string;
    secretRevealed: boolean;
  }>;
}

export interface ReceiptChainAccessor {
  getReceiptChain(miner: string): Promise<{
    solveIndex: number;
    prevReceiptHash: string;
  }>;
}

/**
 * Rate-limit budget accessor. Returns remaining budget for a miner+lane.
 * Shared across SWCP and Cortex lanes — budget is decremented by both.
 */
export interface RateLimitBudgetAccessor {
  getBudget(miner: string, lane: string): Promise<{ remaining: number; windowResetAt: number }>;
  /** Called by coordinator route shim on each successful screener pass */
  consumeBudget(miner: string, lane: string): Promise<void>;
  /**
   * Returns the current on-chain tier credits for a miner.
   * Backed by BotcoinMiningV3.getTier() / _creditsForBalance().
   */
  getMinerTier(miner: string): Promise<{ tier: number; creditsPerSolve: number }>;
}

export interface CortexHandlerDeps {
  /** Existing SWCP signer — single source of truth, never duplicated. */
  receiptSigner: ReceiptSignerLike;
  /** Epoch state accessor. */
  epochState: EpochStateAccessor;
  /** Shared rate-limit budget accessor. */
  rateLimitBudget: RateLimitBudgetAccessor;
  /** Current BotcoinMiningV3 nextIndex/lastReceiptHash cursor. */
  receiptChain: ReceiptChainAccessor;
  /** Optional: path to the cortex-store SQLite DB. Defaults to CORTEX_STORE_DB_PATH env. */
  cortexStorePath?: string;
  /** Optional: shared secret to validate /internal/* requests. If set, x-internal-secret header required. */
  internalSecret?: string;
}

// ─── Minimal Express-compatible app interface ──────────────────────────────────

type NextFn = (err?: unknown) => void;
type Req = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  on(event: string, listener: (chunk: Buffer) => void): void;
};
type Res = {
  writeHead(code: number, headers?: Record<string, string>): void;
  end(body?: string): void;
  status(code: number): Res;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
};

interface MinimalApp {
  get(path: string, handler: (req: Req, res: Res, next?: NextFn) => void): void;
  post(path: string, handler: (req: Req, res: Res, next?: NextFn) => void): void;
  use?(path: string, handler: (req: Req, res: Res, next?: NextFn) => void): void;
}

// ─── Auth middleware ────────────────────────────────────────────────────────────

function makeAuthCheck(secret?: string) {
  return function authCheck(req: Req, res: Res): boolean {
    if (!secret) return true; // No secret configured — allow all (dev mode)
    const provided = req.headers['x-internal-secret'];
    if (typeof provided !== 'string' || provided !== secret) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid or missing x-internal-secret' }));
      return false;
    }
    return true;
  };
}

function readBody(req: Req): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: Res, code: number, body: unknown): void {
  // Support both Express-style (res.status().json()) and raw http style
  if (typeof res.json === 'function') {
    res.status(code).json(body);
  } else {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

// ─── mountCortexHandler ────────────────────────────────────────────────────────

/**
 * Mount the Cortex handler onto an Express-compatible app.
 *
 * This is the §13.4 plug-and-play entry point. One call, zero changes to
 * existing routes.
 */
export function mountCortexHandler(app: MinimalApp, deps: CortexHandlerDeps): void {
  const { receiptSigner, epochState, rateLimitBudget, receiptChain, cortexStorePath, internalSecret } = deps;
  const store = getCortexStore(cortexStorePath);
  const checkAuth = makeAuthCheck(internalSecret);

  // ── GET /internal/miner-tier?miner=0x... ────────────────────────────────────
  app.get('/internal/miner-tier', (req, res) => {
    void (async () => {
      if (!checkAuth(req, res)) return;

      const url = new URL(req.url ?? '/', 'http://localhost');
      const miner = url.searchParams.get('miner') ?? '';

      if (!/^0x[0-9a-fA-F]{40}$/.test(miner)) {
        sendJson(res, 400, { error: 'invalid miner address' });
        return;
      }

      try {
        const tier = await rateLimitBudget.getMinerTier(miner);
        sendJson(res, 200, { miner, ...tier });
      } catch (err) {
        sendJson(res, 500, { error: 'tier-lookup-failed', detail: String(err) });
      }
    })();
  });

  // ── GET /internal/miner-receipt-chain?miner=0x... ─────────────────────────────
  app.get('/internal/miner-receipt-chain', (req, res) => {
    void (async () => {
      if (!checkAuth(req, res)) return;

      const url = new URL(req.url ?? '/', 'http://localhost');
      const miner = (url.searchParams.get('miner') ?? '').toLowerCase();

      if (!/^0x[0-9a-fA-F]{40}$/.test(miner)) {
        sendJson(res, 400, { error: 'invalid miner address' });
        return;
      }

      try {
        const chain = await receiptChain.getReceiptChain(miner);
        if (!Number.isSafeInteger(chain.solveIndex) || chain.solveIndex < 0) {
          throw new Error(`invalid solveIndex from receiptChain: ${chain.solveIndex}`);
        }
        if (!/^0x[0-9a-fA-F]{64}$/.test(chain.prevReceiptHash)) {
          throw new Error('invalid prevReceiptHash from receiptChain');
        }
        sendJson(res, 200, {
          miner,
          solveIndex: chain.solveIndex,
          prevReceiptHash: chain.prevReceiptHash.toLowerCase(),
        });
      } catch (err) {
        sendJson(res, 500, { error: 'receipt-chain-lookup-failed', detail: String(err) });
      }
    })();
  });

  // ── POST /internal/sign-cortex-receipt ──────────────────────────────────────
  app.post('/internal/sign-cortex-receipt', (req, res) => {
    void (async () => {
      if (!checkAuth(req, res)) return;

      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'invalid-json' });
        return;
      }

      if (typeof body !== 'object' || body === null) {
        sendJson(res, 400, { error: 'body-must-be-object' });
        return;
      }

      const b = body as Record<string, unknown>;

      // Validate rulesVersion = 0xC0 (192) — Cortex receipts only
      const rulesVersion = Number(b['rulesVersion'] ?? 0);
      if (rulesVersion !== 0xC0) {
        sendJson(res, 400, {
          error: 'invalid-rules-version',
          expected: '0xC0',
          got: `0x${rulesVersion.toString(16)}`,
          message: 'sign-cortex-receipt only accepts rulesVersion=0xC0',
        });
        return;
      }

      try {
        const miner = String(b['miner'] ?? '').toLowerCase();
        if (!/^0x[0-9a-fA-F]{40}$/.test(miner)) {
          sendJson(res, 400, { error: 'invalid miner address' });
          return;
        }
        const solveIndex = BigInt(String(b['solveIndex'] ?? '0'));
        const prevReceiptHash = String(b['prevReceiptHash'] ?? '0x' + '00'.repeat(32)).toLowerCase();
        if (!/^0x[0-9a-fA-F]{64}$/.test(prevReceiptHash)) {
          sendJson(res, 400, { error: 'invalid prevReceiptHash' });
          return;
        }

        const chain = await receiptChain.getReceiptChain(miner);
        if (solveIndex !== BigInt(chain.solveIndex) || prevReceiptHash !== chain.prevReceiptHash.toLowerCase()) {
          sendJson(res, 409, {
            error: 'stale-receipt-chain',
            expected: { solveIndex: chain.solveIndex, prevReceiptHash: chain.prevReceiptHash.toLowerCase() },
            got: { solveIndex: solveIndex.toString(), prevReceiptHash },
          });
          return;
        }

        const signed = await receiptSigner.signReceipt({
          miner,
          epochId:         BigInt(String(b['epochId'] ?? '0')),
          solveIndex,
          prevReceiptHash,
          challengeId:     String(b['challengeId'] ?? '0x' + '00'.repeat(32)),
          commit:          String(b['commit'] ?? '0x' + '00'.repeat(32)),
          docHash:         String(b['docHash'] ?? '0x' + '00'.repeat(32)),
          questionsHash:   String(b['questionsHash'] ?? '0x' + '00'.repeat(32)),
          constraintsHash: String(b['constraintsHash'] ?? '0x' + '00'.repeat(32)),
          answersHash:     String(b['answersHash'] ?? '0x' + '00'.repeat(32)),
          worldSeed:       BigInt(String(b['worldSeed'] ?? '0')),
          rulesVersion,
        });

        sendJson(res, 200, signed);
      } catch (err) {
        console.error('[cortex-handler] sign-cortex-receipt failed:', err);
        sendJson(res, 500, { error: 'signing-failed', detail: String(err) });
      }
    })();
  });

  // ── POST /internal/sign-coretex-work-receipt ────────────────────────────────
  app.post('/internal/sign-coretex-work-receipt', (req, res) => {
    void (async () => {
      if (!checkAuth(req, res)) return;

      if (!receiptSigner.signWorkReceipt) {
        sendJson(res, 501, {
          error: 'work-receipt-signer-unavailable',
          message: 'BotcoinMiningV4 requires receiptSigner.signWorkReceipt in the SWCP coordinator.',
        });
        return;
      }

      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'invalid-json' });
        return;
      }

      if (typeof body !== 'object' || body === null) {
        sendJson(res, 400, { error: 'body-must-be-object' });
        return;
      }

      const b = body as Record<string, unknown>;
      const rulesVersion = Number(b['rulesVersion'] ?? 0);
      if (rulesVersion !== 0xC0) {
        sendJson(res, 400, {
          error: 'invalid-rules-version',
          expected: '0xC0',
          got: `0x${rulesVersion.toString(16)}`,
          message: 'sign-coretex-work-receipt only accepts rulesVersion=0xC0',
        });
        return;
      }

      try {
        const miner = String(b['miner'] ?? '').toLowerCase();
        if (!/^0x[0-9a-fA-F]{40}$/.test(miner)) {
          sendJson(res, 400, { error: 'invalid miner address' });
          return;
        }
        const solveIndex = BigInt(String(b['solveIndex'] ?? '0'));
        const prevReceiptHash = String(b['prevReceiptHash'] ?? '0x' + '00'.repeat(32)).toLowerCase();
        if (!/^0x[0-9a-fA-F]{64}$/.test(prevReceiptHash)) {
          sendJson(res, 400, { error: 'invalid prevReceiptHash' });
          return;
        }

        const chain = await receiptChain.getReceiptChain(miner);
        if (solveIndex !== BigInt(chain.solveIndex) || prevReceiptHash !== chain.prevReceiptHash.toLowerCase()) {
          sendJson(res, 409, {
            error: 'stale-receipt-chain',
            expected: { solveIndex: chain.solveIndex, prevReceiptHash: chain.prevReceiptHash.toLowerCase() },
            got: { solveIndex: solveIndex.toString(), prevReceiptHash },
          });
          return;
        }

        const lane = Number(b['lane'] ?? 0);
        const outcome = Number(b['outcome'] ?? 0);
        if (lane !== 2 || (outcome !== 1 && outcome !== 2)) {
          sendJson(res, 400, { error: 'invalid-coretex-lane-outcome', expected: { lane: 2, outcomes: [1, 2] } });
          return;
        }

        const parentStateRoot = String(b['parentStateRoot'] ?? '').toLowerCase();
        const artifactHash = String(b['artifactHash'] ?? '').toLowerCase();
        const challengeId = String(b['challengeId'] ?? '').toLowerCase();
        const workPolicyHash = String(b['workPolicyHash'] ?? '').toLowerCase();
        for (const [field, value] of Object.entries({ parentStateRoot, artifactHash, challengeId, workPolicyHash })) {
          if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
            sendJson(res, 400, { error: `invalid ${field}` });
            return;
          }
        }

        const signed = await receiptSigner.signWorkReceipt({
          miner,
          epochId: BigInt(String(b['epochId'] ?? '0')),
          solveIndex,
          prevReceiptHash,
          lane,
          outcome,
          challengeId,
          parentStateRoot,
          artifactHash,
          worldSeed: BigInt(String(b['worldSeed'] ?? '0')),
          rulesVersion,
          workPolicyHash,
          workUnitsBps: BigInt(String(b['workUnitsBps'] ?? '0')),
        });

        sendJson(res, 200, signed);
      } catch (err) {
        console.error('[cortex-handler] sign-coretex-work-receipt failed:', err);
        sendJson(res, 500, { error: 'signing-failed', detail: String(err) });
      }
    })();
  });

  // ── GET /internal/epoch ─────────────────────────────────────────────────────
  app.get('/internal/epoch', (req, res) => {
    void (async () => {
      if (!checkAuth(req, res)) return;

      try {
        const epoch = await epochState.getCurrentEpoch();
        sendJson(res, 200, epoch);
      } catch (err) {
        sendJson(res, 500, { error: 'epoch-lookup-failed', detail: String(err) });
      }
    })();
  });

  // ── GET /internal/rate-limit-budget?miner=0x...&lane=cortex ────────────────
  app.get('/internal/rate-limit-budget', (req, res) => {
    void (async () => {
      if (!checkAuth(req, res)) return;

      const url = new URL(req.url ?? '/', 'http://localhost');
      const miner = url.searchParams.get('miner') ?? '';
      const lane = url.searchParams.get('lane') ?? 'cortex';

      if (!/^0x[0-9a-fA-F]{40}$/.test(miner)) {
        sendJson(res, 400, { error: 'invalid miner address' });
        return;
      }

      try {
        const budget = await rateLimitBudget.getBudget(miner, lane);
        sendJson(res, 200, { miner, lane, ...budget });
      } catch (err) {
        sendJson(res, 500, { error: 'budget-lookup-failed', detail: String(err) });
      }
    })();
  });

  // ── GET /internal/outstanding-challenge?miner=0x... ─────────────────────────
  app.get('/internal/outstanding-challenge', (req, res) => {
    void (async () => {
      if (!checkAuth(req, res)) return;

      const url = new URL(req.url ?? '/', 'http://localhost');
      const miner = url.searchParams.get('miner') ?? '';

      if (!/^0x[0-9a-fA-F]{40}$/.test(miner)) {
        sendJson(res, 400, { error: 'invalid miner address' });
        return;
      }

      // Lazily expire stale records
      store.clearExpired();

      const record = store.getOutstanding(miner.toLowerCase());
      if (!record) {
        sendJson(res, 200, { outstanding: false, lane: null, expiresAt: null });
        return;
      }

      sendJson(res, 200, {
        outstanding: true,
        lane: record.lane,
        expiresAt: record.expiresAt,
        shardOrChallengeId: record.shardOrChallengeId,
      });
    })();
  });

  // ── POST /internal/outstanding-challenge/clear ──────────────────────────────
  // Called by coordinator route shim after a successful submit (clears the cortex-side entry)
  app.post('/internal/outstanding-challenge/set', (req, res) => {
    void (async () => {
      if (!checkAuth(req, res)) return;

      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'invalid-json' });
        return;
      }

      if (typeof body !== 'object' || body === null) {
        sendJson(res, 400, { error: 'body-must-be-object' });
        return;
      }

      const b = body as Record<string, unknown>;
      const miner = String(b['miner'] ?? '').toLowerCase();
      const lane = String(b['lane'] ?? '');
      const expiresAt = Number(b['expiresAt'] ?? 0);
      const shardOrChallengeId = String(b['shardOrChallengeId'] ?? '');

      if (!/^0x[0-9a-fA-F]{40}$/.test(miner)) {
        sendJson(res, 400, { error: 'invalid miner address' });
        return;
      }
      if (lane !== 'cortex') {
        sendJson(res, 400, { error: 'invalid lane', expected: 'cortex' });
        return;
      }
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
        sendJson(res, 400, { error: 'invalid expiresAt' });
        return;
      }
      if (!/^0x[0-9a-fA-F]{32}$/.test(shardOrChallengeId)) {
        sendJson(res, 400, { error: 'invalid shardOrChallengeId' });
        return;
      }

      store.clearExpired();
      const existing = store.getOutstanding(miner);
      if (existing) {
        sendJson(res, 409, {
          error: 'outstanding-challenge',
          lane: existing.lane,
          expiresAt: existing.expiresAt,
          shardOrChallengeId: existing.shardOrChallengeId,
        });
        return;
      }

      store.setOutstanding(miner, 'cortex', expiresAt, shardOrChallengeId);
      sendJson(res, 200, { ok: true, miner });
    })();
  });

  app.post('/internal/outstanding-challenge/clear', (req, res) => {
    void (async () => {
      if (!checkAuth(req, res)) return;

      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'invalid-json' });
        return;
      }

      const miner = String((body as Record<string, unknown>)['miner'] ?? '').toLowerCase();
      if (!/^0x[0-9a-fA-F]{40}$/.test(miner)) {
        sendJson(res, 400, { error: 'invalid miner address' });
        return;
      }

      store.clearOutstanding(miner);
      sendJson(res, 200, { ok: true, miner });
    })();
  });

  console.log('[cortex-handler] mounted /internal/* routes on SWCP coordinator');
}

export { getCortexStore } from './cortex-store.js';
export type { CortexStore, OutstandingChallengeRecord, MergeBonusFundingRecord } from './cortex-store.js';

export const VERSION = '0.1.0';
