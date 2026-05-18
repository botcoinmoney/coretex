/**
 * CoreTex pre-launch — Saturation detector.
 *
 * Per §9 Phase 4 completion checklist and §8 ORGANISM_CORTEX_STATE_PLAN.md:
 *   "Saturation alarm: alert when median score-delta < 1% for K=10 consecutive epochs."
 *
 * The alarm fires when median(score_deltas over last K epochs) < SATURATION_THRESHOLD.
 * On alarm: difficulty bump or family-weight adjustment follows (human/governance decision).
 */

// ── Constants ──────────────────────────────────────────────────────────────────

/** Number of consecutive epochs below threshold before alarm fires. */
export const SATURATION_K = 10;

/** Median score-delta threshold below which saturation is declared (1%). */
export const SATURATION_THRESHOLD = 0.01;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EpochScoreRecord {
  epoch: number;
  /** Median score-delta across all accepted patches in this epoch. */
  medianScoreDelta: number;
}

export interface SaturationResult {
  saturated: boolean;
  /** The K-epoch window that triggered (or was evaluated). */
  window: EpochScoreRecord[];
  /** Median of the window's medianScoreDeltas. */
  windowMedian: number;
  /** Threshold used. */
  threshold: number;
  /** K used. */
  k: number;
}

// ── Saturation detector ────────────────────────────────────────────────────────

/**
 * Check for saturation over the provided epoch history.
 *
 * @param history  - ordered epoch records (most recent last)
 * @param k        - window size (default: SATURATION_K = 10)
 * @param threshold - median threshold (default: SATURATION_THRESHOLD = 0.01)
 */
export function checkSaturation(
  history: EpochScoreRecord[],
  k: number = SATURATION_K,
  threshold: number = SATURATION_THRESHOLD,
): SaturationResult {
  if (history.length < k) {
    return {
      saturated: false,
      window: history,
      windowMedian: history.length === 0 ? 0 : median(history.map((r) => r.medianScoreDelta)),
      threshold,
      k,
    };
  }

  const window = history.slice(-k);
  const windowMedian = median(window.map((r) => r.medianScoreDelta));

  return {
    saturated: windowMedian < threshold,
    window,
    windowMedian,
    threshold,
    k,
  };
}

/**
 * Incremental saturation tracker.
 * Maintains a sliding window of EpochScoreRecord.
 */
export class SaturationTracker {
  private readonly history: EpochScoreRecord[] = [];
  private readonly k: number;
  private readonly threshold: number;

  constructor(k: number = SATURATION_K, threshold: number = SATURATION_THRESHOLD) {
    this.k = k;
    this.threshold = threshold;
  }

  /**
   * Record a new epoch's median score-delta and check for saturation.
   */
  push(record: EpochScoreRecord): SaturationResult {
    this.history.push(record);
    return checkSaturation(this.history, this.k, this.threshold);
  }

  /** Get the full history. */
  getHistory(): readonly EpochScoreRecord[] {
    return this.history;
  }

  /** Reset the tracker. */
  reset(): void {
    this.history.length = 0;
  }

  /** Get the current window (last K records). */
  getWindow(): EpochScoreRecord[] {
    return this.history.slice(-this.k);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Compute the median of an array of numbers.
 * Empty array returns 0.
 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Compute the median score-delta across a set of accepted patches in one epoch.
 * Each patch score-delta is candidateScore − baselineScore.
 */
export function epochMedianScoreDelta(scoreDeltas: number[]): number {
  return median(scoreDeltas);
}
