/**
 * Shared types for CoreTex pre-launch generators.
 * Each family loader produces CortexEvent[] and an experienceCorpusRoot.
 */

// ── CortexEvent ────────────────────────────────────────────────────────────────

/**
 * A single experience corpus event in Cortex format.
 * Re-encoded from any anchored benchmark source.
 */
export interface CortexEvent {
  /** Unique identifier within the corpus. */
  readonly id: string;
  /** Benchmark family. */
  readonly family: 'near_collision' | 'temporal' | 'long_horizon';
  /** Sub-task type. */
  readonly taskType: string;
  /** Whether this event is part of the protected-regression set. */
  readonly isProtected: boolean;
  /** Stable source attribution (benchmark name + item key). */
  readonly sourceRef: string;
  /**
   * Canonical payload — encoded as a single Uint8Array so it can be
   * hashed deterministically across machines. Content is opaque to the
   * scoring formula; the formula reads typed fields below.
   */
  readonly payload: Uint8Array;
  // ── Scoring fields ─────────────────────────────────────────────────────────
  /** Query (near-collision) or utterance (temporal) or session summary (long-horizon). */
  readonly queryText: string;
  /** Ground-truth answer / relevant passage. */
  readonly truthText: string;
  /** For temporal: whether the truthText is the stale value (should be rejected). */
  readonly isStaleTruth?: boolean;
  /** For near-collision: bit-flip distance d applied to binary key. */
  readonly bitFlipDistance?: number;
  /** Epoch at which this event was committed to the corpus. */
  readonly epochCommitted: number;
}

// ── Loader interface ───────────────────────────────────────────────────────────

export interface LoadCorpusOptions {
  /** Only load protected-regression items. Default: false (load full corpus). */
  protectedOnly?: boolean;
  /** Max items to load (undefined = no limit). */
  limit?: number;
  /**
   * Epoch number. Used to filter events committed at or before this epoch.
   * Default: Infinity (no epoch filter).
   */
  epoch?: number;
}

export interface FamilyLoader {
  /** Load corpus events for a specific epoch. */
  loadCorpus(epoch: number, opts?: LoadCorpusOptions): Promise<CortexEvent[]>;
  /** Compute experienceCorpusRoot from a set of events (pure, deterministic). */
  computeRoot(events: CortexEvent[]): Uint8Array;
}

// ── Hash verification ──────────────────────────────────────────────────────────

/** Stable error codes for loader failures. */
export type LoaderErrorCode =
  | 'CORPUS_HASH_MISMATCH'
  | 'LICENSE_BLOCKED'
  | 'SOURCE_NOT_FOUND'
  | 'MALFORMED_SOURCE';

export class LoaderError extends Error {
  constructor(
    public readonly code: LoaderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LoaderError';
  }
}
