// @botcoin/cortex-handler — single-line drop-in router for the SWCP coordinator.
// Phase 5 deliverable. The mount surface defined here is the §13.4 plug-and-play contract:
//
//     import { mountCortexHandler } from '@botcoin/cortex-handler';
//     mountCortexHandler(app, { receiptSigner, epochState, rateLimitBudget, db });
//
// Adds /internal/miner-tier, /internal/sign-cortex-receipt, /internal/epoch,
// /internal/rate-limit-budget, /internal/outstanding-challenge.
// Adds /v1/cortex/merge-bonus/claim-calldata.
// Never edits /v1/challenge or /v1/submit.

export interface CortexHandlerDeps {
  /** Existing SWCP signer — single source of truth, never duplicated. */
  receiptSigner: unknown;
  /** Epoch state + secret-reveal status from the SWCP process. */
  epochState: unknown;
  /** Shared rate-limit budget across SWCP and Cortex lanes. */
  rateLimitBudget: unknown;
  /** SQLite handle on the SWCP side for cortex-store.ts cross-lane bookkeeping. */
  db: unknown;
}

/**
 * Mount the Cortex handler onto an Express/Fastify-compatible app.
 * Implementation lands in Phase 5.
 */
export function mountCortexHandler(_app: unknown, _deps: CortexHandlerDeps): void {
  throw new Error('mountCortexHandler is a Phase 5 stub. Do not mount in production yet.');
}

export const VERSION = '0.0.0';
