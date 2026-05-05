/**
 * CortexBench V0 — Score formula.
 *
 * Weights (locked in research_brief_v0.md §4 and ORGANISM_CORTEX_STATE_PLAN.md §5):
 *
 *   + exact retrieval                w = 0.30
 *   + stale-memory rejection         w = 0.15
 *   + temporal update correctness    w = 0.15
 *   + compression survival           w = 0.30
 *   + routing accuracy               w = 0.05
 *   - latency penalty                w = 0.025  (subtracted)
 *   state-size compliance            hard veto (not weighted)
 *   protected-regression set         hard veto (not weighted)
 *
 * Family weights (also locked):
 *   long_horizon    0.60
 *   near_collision  0.20
 *   temporal        0.20
 *
 * All component scores are ∈ [0, 1].
 * Composite score is clamped to [0, 1].
 *
 * A patch is valid iff:
 *   candidateScore > baselineScore + SCORE_THRESHOLD
 *   protectedRegressionCount === 0
 *   patchSize <= PATCH_BUDGET_WORDS (4)
 *   evaluation is byte-reproducible
 */

// ── Weight constants (immutable) ───────────────────────────────────────────────

export const WEIGHTS = {
  exactRetrieval:          0.30,
  staleMemoryRejection:    0.15,
  temporalUpdateCorrectness: 0.15,
  compressionSurvival:     0.30,
  routingAccuracy:         0.05,
  latencyPenalty:          0.025, // subtracted
} as const;

export const FAMILY_WEIGHTS = {
  long_horizon:    0.60,
  near_collision:  0.20,
  temporal:        0.20,
} as const;

// Screener threshold: candidate must exceed baseline by at least this amount.
export const SCORE_THRESHOLD = 0.005;

// Maximum patch budget in words.
export const PATCH_BUDGET_WORDS = 4;

// Maximum CortexState size in words.
export const STATE_SIZE_LIMIT_WORDS = 1024;

// ── Score input / output types ─────────────────────────────────────────────────

/**
 * Per-component scores (all ∈ [0, 1]).
 */
export interface ScoreComponents {
  exactRetrieval:          number;
  staleMemoryRejection:    number;
  temporalUpdateCorrectness: number;
  compressionSurvival:     number;
  routingAccuracy:         number;
  /** Latency in milliseconds (used to compute the latency penalty). */
  latencyMs:               number;
}

/**
 * Hard-veto results. Either veto code sets candidateValid = false
 * regardless of the weighted score.
 */
export interface HardVetoResult {
  /** State exceeds STATE_SIZE_LIMIT_WORDS. */
  stateSizeViolation: boolean;
  /** ≥1 protected-regression anchor dropped relative to baseline. */
  protectedRegressionViolation: boolean;
  /** Number of protected anchors that regressed. */
  protectedRegressionCount: number;
}

export interface ScoreReport {
  /** Epoch in which evaluation was performed. */
  epoch: number;
  /** Miner address. */
  miner: string;
  /** Shard identifier. */
  shardId: string;
  /** Score before patch (baseline). */
  baselineScore: number;
  /** Score after patch (candidate). */
  candidateScore: number;
  /** candidateScore − baselineScore. */
  scoreDelta: number;
  /** Weighted breakdown. */
  components: ScoreComponents;
  /** Family-level breakdown. */
  familyScores: {
    near_collision: number;
    temporal:       number;
    long_horizon:   number;
  };
  /** Hard-veto results. */
  veto: HardVetoResult;
  /** Whether the patch passes all gates. */
  candidateValid: boolean;
  /** Rejection reason (if !candidateValid). */
  rejectionReason?: string;
  /** Patch word count. */
  patchWordCount: number;
  /** Deterministic eval report hash (keccak256 of the canonical JSON report). */
  reportHash: string;
  /** ISO timestamp at which eval was performed. */
  evaluatedAt: string;
  /** Core version hash (opaque). */
  coreVersionHash: string;
}

// ── Score computation ──────────────────────────────────────────────────────────

/**
 * Compute the weighted composite score from per-component scores.
 * Latency penalty is subtracted; result is clamped to [0, 1].
 *
 * Latency penalty: linear from 0 (at p50Target ms) to WEIGHTS.latencyPenalty
 * (at p99Target ms and beyond).
 */
export function computeComposite(
  components: ScoreComponents,
  opts?: {
    /** p50 latency target in ms (default: 10). Below this: no penalty. */
    latencyP50Ms?: number;
    /** p99 latency target in ms (default: 50). At or above this: full penalty. */
    latencyP99Ms?: number;
  },
): number {
  const p50 = opts?.latencyP50Ms ?? 10;
  const p99 = opts?.latencyP99Ms ?? 50;

  const latencyPenalty = computeLatencyPenalty(components.latencyMs, p50, p99);

  const raw =
    WEIGHTS.exactRetrieval * components.exactRetrieval +
    WEIGHTS.staleMemoryRejection * components.staleMemoryRejection +
    WEIGHTS.temporalUpdateCorrectness * components.temporalUpdateCorrectness +
    WEIGHTS.compressionSurvival * components.compressionSurvival +
    WEIGHTS.routingAccuracy * components.routingAccuracy -
    latencyPenalty;

  return Math.max(0, Math.min(1, raw));
}

/**
 * Compute latency penalty ∈ [0, WEIGHTS.latencyPenalty].
 * Linear interpolation between p50 (no penalty) and p99 (full penalty).
 */
export function computeLatencyPenalty(latencyMs: number, p50Ms: number, p99Ms: number): number {
  if (latencyMs <= p50Ms) return 0;
  if (latencyMs >= p99Ms) return WEIGHTS.latencyPenalty;
  const t = (latencyMs - p50Ms) / (p99Ms - p50Ms);
  return t * WEIGHTS.latencyPenalty;
}

/**
 * Compute family-level scores from component scores.
 *
 * Mapping:
 *   near_collision: primarily exact retrieval
 *   temporal:       stale-memory rejection + temporal update correctness
 *   long_horizon:   compression survival + routing accuracy
 */
export function computeFamilyScores(
  components: ScoreComponents,
): ScoreReport['familyScores'] {
  return {
    near_collision: components.exactRetrieval,
    temporal:
      (components.staleMemoryRejection + components.temporalUpdateCorrectness) / 2,
    long_horizon:
      (components.compressionSurvival * WEIGHTS.compressionSurvival +
        components.routingAccuracy * WEIGHTS.routingAccuracy) /
      (WEIGHTS.compressionSurvival + WEIGHTS.routingAccuracy),
  };
}

/**
 * Assess hard vetoes.
 *
 * @param patchWordCount - number of words changed by this patch
 * @param stateSizeWords - resulting state size in words
 * @param protectedRegressionCount - number of protected anchors that regressed
 */
export function assessVeto(
  patchWordCount: number,
  stateSizeWords: number,
  protectedRegressionCount: number,
): HardVetoResult {
  return {
    stateSizeViolation: stateSizeWords > STATE_SIZE_LIMIT_WORDS,
    protectedRegressionViolation: protectedRegressionCount > 0,
    protectedRegressionCount,
  };
}

/**
 * Build a complete ScoreReport.
 * This is the canonical report format — hashed for byte-identity verification.
 */
export function buildScoreReport(params: {
  epoch: number;
  miner: string;
  shardId: string;
  baselineComponents: ScoreComponents;
  candidateComponents: ScoreComponents;
  patchWordCount: number;
  stateSizeWords: number;
  protectedRegressionCount: number;
  coreVersionHash: string;
  hashFn: (data: Uint8Array) => Uint8Array;
}): ScoreReport {
  const {
    epoch, miner, shardId, baselineComponents, candidateComponents,
    patchWordCount, stateSizeWords, protectedRegressionCount, coreVersionHash, hashFn,
  } = params;

  const baselineScore = computeComposite(baselineComponents);
  const candidateScore = computeComposite(candidateComponents);
  const scoreDelta = candidateScore - baselineScore;
  const familyScores = computeFamilyScores(candidateComponents);
  const veto = assessVeto(patchWordCount, stateSizeWords, protectedRegressionCount);

  let candidateValid = true;
  let rejectionReason: string | undefined;

  if (veto.stateSizeViolation) {
    candidateValid = false;
    rejectionReason = `HARD_VETO: state-size violation (${stateSizeWords} > ${STATE_SIZE_LIMIT_WORDS} words)`;
  } else if (veto.protectedRegressionViolation) {
    candidateValid = false;
    rejectionReason = `HARD_VETO: protected-regression (${protectedRegressionCount} anchor(s) regressed)`;
  } else if (scoreDelta <= SCORE_THRESHOLD) {
    candidateValid = false;
    rejectionReason = `BELOW_THRESHOLD: delta ${scoreDelta.toFixed(6)} <= ${SCORE_THRESHOLD}`;
  } else if (patchWordCount > PATCH_BUDGET_WORDS) {
    candidateValid = false;
    rejectionReason = `OVER_BUDGET: ${patchWordCount} words > ${PATCH_BUDGET_WORDS}`;
  }

  const evaluatedAt = new Date().toISOString();

  // Build canonical report (without reportHash) for hashing.
  const reportWithoutHash = {
    epoch,
    miner,
    shardId,
    baselineScore,
    candidateScore,
    scoreDelta,
    components: candidateComponents,
    familyScores,
    veto,
    candidateValid,
    rejectionReason: rejectionReason ?? null,
    patchWordCount,
    evaluatedAt,
    coreVersionHash,
  };

  const canonical = JSON.stringify(reportWithoutHash);
  const hashBytes = hashFn(textEncode(canonical));
  const reportHash = bytesToHex(hashBytes);

  return {
    ...reportWithoutHash,
    rejectionReason,
    reportHash,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  let h = '0x';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return h;
}

function textEncode(s: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  return Buffer.from(s, 'utf8');
}
