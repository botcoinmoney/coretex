/**
 * Internal RPC client — cortex-server → SWCP coordinator.
 *
 * All calls go to the SWCP process at INTERNAL_RPC_URL via the shared
 * INTERNAL_RPC_SHARED_SECRET. The signing key NEVER leaves the SWCP process;
 * cortex-server only passes receipt data and receives back a signature.
 *
 * Endpoints (all on the SWCP side):
 *   GET  /internal/miner-tier?miner=0x...
 *   POST /internal/sign-cortex-receipt
 *   GET  /internal/epoch
 *   GET  /internal/rate-limit-budget?miner=0x...&lane=cortex
 *   GET  /internal/outstanding-challenge?miner=0x...
 */

const INTERNAL_RPC_URL = process.env['INTERNAL_RPC_URL'] ?? 'http://127.0.0.1:8080';
const INTERNAL_RPC_SECRET = process.env['INTERNAL_RPC_SHARED_SECRET'] ?? '';

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (INTERNAL_RPC_SECRET) {
    h['x-internal-secret'] = INTERNAL_RPC_SECRET;
  }
  return h;
}

async function rpcGet<T>(path: string): Promise<T> {
  const url = `${INTERNAL_RPC_URL}${path}`;
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`internal-rpc GET ${path} -> ${r.status}: ${body}`);
  }
  return r.json() as Promise<T>;
}

async function rpcPost<T>(path: string, body: unknown): Promise<T> {
  const url = `${INTERNAL_RPC_URL}${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const b = await r.text().catch(() => '');
    throw new Error(`internal-rpc POST ${path} -> ${r.status}: ${b}`);
  }
  return r.json() as Promise<T>;
}

// ─── Response types ────────────────────────────────────────────────────────────

export interface MinerTierResponse {
  miner: string;
  tier: number;
  creditsPerSolve: number;
}

export interface EpochStateResponse {
  epochId: number;
  parentStateRoot: string;
  experienceCorpusRoot: string;
  coreVersionHash: string;
  hiddenSeedCommit: string;
  secretRevealed: boolean;
}

export interface RateLimitBudgetResponse {
  miner: string;
  lane: string;
  remaining: number;
  windowResetAt: number;
}

export interface OutstandingChallengeResponse {
  outstanding: boolean;
  lane: 'swcp' | 'cortex' | null;
  expiresAt: number | null;
}

export interface SignCortexReceiptRequest {
  miner: string;
  epochId: number;
  solveIndex: number;
  prevReceiptHash: string;
  challengeId: string;
  commit: string;
  /** Receipt field mapping (§6): docHash = parentStateRoot */
  docHash: string;
  /** questionsHash = experienceCorpusRoot */
  questionsHash: string;
  /** constraintsHash = shardCommitment */
  constraintsHash: string;
  /** answersHash = patchHash */
  answersHash: string;
  /** worldSeed = keccak(H_e ‖ miner ‖ solveIndex ‖ parentStateRoot) truncated to uint128 */
  worldSeed: string;
  /** rulesVersion = 0xC0 (192) */
  rulesVersion: number;
}

export interface SignCortexReceiptResponse {
  signature: string;
  receipt: SignCortexReceiptRequest;
}

// ─── Client API ───────────────────────────────────────────────────────────────

export async function getMinerTier(miner: string): Promise<MinerTierResponse> {
  return rpcGet<MinerTierResponse>(`/internal/miner-tier?miner=${encodeURIComponent(miner)}`);
}

export async function getEpochState(): Promise<EpochStateResponse> {
  return rpcGet<EpochStateResponse>('/internal/epoch');
}

export async function getRateLimitBudget(miner: string): Promise<RateLimitBudgetResponse> {
  return rpcGet<RateLimitBudgetResponse>(`/internal/rate-limit-budget?miner=${encodeURIComponent(miner)}&lane=cortex`);
}

export async function getOutstandingChallenge(miner: string): Promise<OutstandingChallengeResponse> {
  return rpcGet<OutstandingChallengeResponse>(`/internal/outstanding-challenge?miner=${encodeURIComponent(miner)}`);
}

export async function signCortexReceipt(req: SignCortexReceiptRequest): Promise<SignCortexReceiptResponse> {
  return rpcPost<SignCortexReceiptResponse>('/internal/sign-cortex-receipt', req);
}
