/**
 * Long-horizon compression family loader.
 *
 * Sources:
 *   Primary: MemoryArena (He et al., arXiv:2602.16313, Feb 2026)
 *            License: CC-BY-4.0 (HuggingFace dataset ZexueHe/memoryarena)
 *            Attribution: He et al. arXiv:2602.16313. CC-BY-4.0.
 *            Note: code repo URL unresolved as of 2026-05-05; loader uses HF dataset only.
 *
 *   Synthetic stream-and-evict generator: parameterized to force capacity
 *            pressure on 1024 words (no external dataset required; generated inline).
 *
 * current fixture: benchmark/fixtures/long_horizon/memoryarena.json
 *
 * Deferred: MemoryArena code repository URL — confirm with zexueh@stanford.edu.
 *           Until confirmed, only HF dataset subset is used (CC-BY-4.0, confirmed).
 *
 * Family weight: 60% of composite score (locked in research_brief.md §4).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CortexEvent, FamilyLoader, LoadCorpusOptions } from '../types.js';
import { LoaderError } from '../types.js';
import { computeCorpusRoot } from '../corpus_root.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const PINNED_CORPUS_HASH = 'FIXTURE_HASH_PLACEHOLDER';

const FIXTURE_PATH_SEGMENTS = [
  'benchmark', 'fixtures', 'long_horizon', 'memoryarena.json',
];

/** MemoryArena task configurations used in CoreTex. */
export const MEMORYARENA_CONFIGS = [
  'bundled_shopping',
  'progressive_search',
  'group_travel_planner',
  'formal_reasoning_math',
  'formal_reasoning_phys',
] as const;

// ── Raw fixture types ──────────────────────────────────────────────────────────

interface RawLongHorizonItem {
  id: string;
  config: string;
  session_index: number;
  session_count: number;
  query: string;
  truth: string;
  synthetic: boolean;
  protected: boolean;
  epoch_committed: number;
  source_ref: string;
  payload_hex: string;
}

interface FixtureFile {
  schema_version: string;
  source: 'MemoryArena' | 'Synthetic';
  license_spdx: string;
  corpus_hash: string;
  generated_at: string;
  items: RawLongHorizonItem[];
}

// ── Loader ─────────────────────────────────────────────────────────────────────

export class LongHorizonLoader implements FamilyLoader {
  static readonly MEMORYARENA_HF = 'ZexueHe/memoryarena';
  static readonly LICENSE_SPDX = 'CC-BY-4.0';
  static readonly ATTRIBUTION = 'He et al. arXiv:2602.16313. February 2026. CC-BY-4.0.';

  private readonly repoRoot: string;

  constructor(repoRoot?: string) {
    this.repoRoot = repoRoot ?? process.cwd();
  }

  async loadCorpus(epoch: number, opts?: LoadCorpusOptions): Promise<CortexEvent[]> {
    const fixturePath = join(this.repoRoot, ...FIXTURE_PATH_SEGMENTS);

    let raw: FixtureFile;
    try {
      const text = readFileSync(fixturePath, 'utf8');
      raw = JSON.parse(text) as FixtureFile;
    } catch (err) {
      throw new LoaderError(
        'SOURCE_NOT_FOUND',
        `LongHorizonLoader: fixture not found at ${fixturePath}. ` +
          'Run scripts/fetch-fixtures.mjs to generate it.\n' + String(err),
      );
    }

    validateFixtureHash(raw, fixturePath);

    let events = raw.items.map(rawToEvent);

    const epochFilter = opts?.epoch ?? epoch;
    events = events.filter((e) => e.epochCommitted <= epochFilter);

    if (opts?.protectedOnly) {
      events = events.filter((e) => e.isProtected);
    }

    if (opts?.limit !== undefined) {
      events = events.slice(0, opts.limit);
    }

    return events;
  }

  computeRoot(events: CortexEvent[]): Uint8Array {
    return computeCorpusRoot(events);
  }
}

// ── Synthetic stream-and-evict generator ──────────────────────────────────────

/**
 * Generates synthetic stream-and-evict events that force capacity pressure
 * on the 1024-word CortexState.
 *
 * Not a fixture file — generated deterministically from a seed.
 * Used to supplement MemoryArena when parameterizing beyond the dataset's
 * native scope (e.g., testing at 8× session count).
 */
export function generateStreamEvictEvents(opts: {
  epochSeed: Uint8Array;
  sessionCount: number;
  itemsPerSession: number;
  epoch: number;
  startId?: number;
}): CortexEvent[] {
  const events: CortexEvent[] = [];
  const { epochSeed, sessionCount, itemsPerSession, epoch, startId = 0 } = opts;

  for (let session = 0; session < sessionCount; session++) {
    for (let item = 0; item < itemsPerSession; item++) {
      const idx = startId + session * itemsPerSession + item;
      // Deterministic payload: hash(seed ‖ session ‖ item)
      const h = simpleHash(epochSeed, session, item);
      const id = `synth-stream-${idx}`;
      const queryText = `Session ${session} item ${item} query`;
      const truthText = `Session ${session} item ${item} truth`;

      events.push({
        id,
        family: 'long_horizon',
        taskType: 'stream_evict',
        isProtected: idx < 50, // first 50 are protected
        sourceRef: `synthetic/stream_evict/${idx}`,
        payload: h,
        queryText,
        truthText,
        epochCommitted: epoch,
      });
    }
  }
  return events;
}

function simpleHash(seed: Uint8Array, a: number, b: number): Uint8Array {
  const h = createHash('sha256');
  h.update(seed);
  const abuf = Buffer.allocUnsafe(8);
  abuf.writeUInt32BE(a, 0);
  abuf.writeUInt32BE(b, 4);
  h.update(abuf);
  return new Uint8Array(h.digest());
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function validateFixtureHash(raw: FixtureFile, fixturePath: string): void {
  if (PINNED_CORPUS_HASH === 'FIXTURE_HASH_PLACEHOLDER') return;

  const { corpus_hash: _h, ...rest } = raw;
  const canonical = JSON.stringify(rest, null, 2);
  const computed = createHash('sha256').update(canonical, 'utf8').digest('hex');

  if (computed !== PINNED_CORPUS_HASH) {
    throw new LoaderError(
      'CORPUS_HASH_MISMATCH',
      `LongHorizonLoader: CORPUS_HASH_MISMATCH\n` +
        `  expected: ${PINNED_CORPUS_HASH}\n` +
        `  computed: ${computed}\n` +
        `  fixture:  ${fixturePath}`,
    );
  }
}

function rawToEvent(item: RawLongHorizonItem): CortexEvent {
  return {
    id: item.id,
    family: 'long_horizon',
    taskType: item.config,
    isProtected: item.protected,
    sourceRef: item.source_ref,
    payload: hexToBytes(item.payload_hex),
    queryText: item.query,
    truthText: item.truth,
    epochCommitted: item.epoch_committed,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new RangeError(`hexToBytes: odd-length hex`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
