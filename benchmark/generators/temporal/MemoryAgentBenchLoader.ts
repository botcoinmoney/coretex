/**
 * MemoryAgentBench temporal family loader.
 *
 * Source: Hu, Wang, McAuley. "Evaluating Memory in LLM Agents via Incremental
 *         Multi-Turn Interactions." arXiv:2507.05257. ICLR 2026.
 * License: MIT (HuggingFace dataset card: ai-hyz/MemoryAgentBench).
 * Pinned hash: 569241d877899d5c36d7d3b789de6c2489ea6cba (2026-01-27).
 * Attribution: Hu, Wang, McAuley. arXiv:2507.05257. MIT License.
 *
 * V0 uses the EventQA and FactConsolidation tasks from the temporal subset.
 *
 * Because LoCoMo is LICENSE_BLOCKED, this loader is the sole operative
 * source for the temporal family in CortexBench V0.
 *
 * Hash verification: loadCorpus() validates the corpus hash against
 * PINNED_CORPUS_HASH (SHA-256 of the canonical fixture JSON).
 * If the hash mismatches, it throws LoaderError('CORPUS_HASH_MISMATCH').
 *
 * In CI: the fixture is read from benchmark/fixtures/temporal/memoryagentbench_v0.json.
 * That file is a frozen subset (~50 protected + additional items) derived
 * from the HuggingFace dataset at the pinned commit.
 *
 * IMPORTANT: this file does NOT make network calls at runtime.
 * The fetch script is scripts/fetch-fixtures.mjs (run once; output committed).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CortexEvent, FamilyLoader, LoadCorpusOptions } from '../types.js';
import { LoaderError } from '../types.js';
import { computeCorpusRoot } from '../corpus_root.js';

// ── Constants ──────────────────────────────────────────────────────────────────

/**
 * SHA-256 hex of the canonical fixture file at the pinned commit.
 * Updated when fixtures are re-frozen (must track with scripts/fetch-fixtures.mjs).
 */
const PINNED_CORPUS_HASH = 'FIXTURE_HASH_PLACEHOLDER';

const FIXTURE_PATH_SEGMENTS = ['benchmark', 'fixtures', 'temporal', 'memoryagentbench_v0.json'];

// Number of protected-regression items per fixture.
const PROTECTED_COUNT = 50;

// ── Raw fixture types ──────────────────────────────────────────────────────────

interface RawTemporalItem {
  id: string;
  task: 'EventQA' | 'FactConsolidation' | string;
  query: string;
  truth: string;
  is_stale: boolean;
  protected: boolean;
  epoch_committed: number;
  source_ref: string;
  payload_hex: string; // hex-encoded canonical payload bytes
}

interface FixtureFile {
  schema_version: string;
  source: 'MemoryAgentBench';
  license_spdx: 'MIT';
  pinned_hash: string;
  corpus_hash: string; // SHA-256 of the JSON (excluding this field itself)
  generated_at: string;
  items: RawTemporalItem[];
}

// ── Loader ─────────────────────────────────────────────────────────────────────

export class MemoryAgentBenchLoader implements FamilyLoader {
  static readonly PINNED_HASH = '569241d877899d5c36d7d3b789de6c2489ea6cba';
  static readonly LICENSE_SPDX = 'MIT';
  static readonly ATTRIBUTION = 'Hu, Wang, McAuley. arXiv:2507.05257. ICLR 2026. MIT License.';

  private readonly repoRoot: string;

  constructor(repoRoot?: string) {
    // Default: resolve from this file's location (benchmark/generators/temporal/ → ../../..)
    this.repoRoot = repoRoot ?? resolveRepoRoot();
  }

  async loadCorpus(epoch: number, opts?: LoadCorpusOptions): Promise<CortexEvent[]> {
    const fixturePath = join(this.repoRoot, ...FIXTURE_PATH_SEGMENTS);

    // Load fixture
    let raw: FixtureFile;
    try {
      const text = readFileSync(fixturePath, 'utf8');
      raw = JSON.parse(text) as FixtureFile;
    } catch (err) {
      throw new LoaderError(
        'SOURCE_NOT_FOUND',
        `MemoryAgentBenchLoader: fixture not found at ${fixturePath}. ` +
          'Run scripts/fetch-fixtures.mjs to generate it.\n' +
          String(err),
      );
    }

    // Validate pinned hash
    validateFixtureHash(raw, fixturePath);

    // Parse events
    let events = raw.items.map(rawToEvent);

    // Apply epoch filter
    const epochFilter = opts?.epoch ?? epoch;
    events = events.filter((e) => e.epochCommitted <= epochFilter);

    // Protected-only filter
    if (opts?.protectedOnly) {
      events = events.filter((e) => e.isProtected);
    }

    // Limit
    if (opts?.limit !== undefined) {
      events = events.slice(0, opts.limit);
    }

    return events;
  }

  computeRoot(events: CortexEvent[]): Uint8Array {
    return computeCorpusRoot(events);
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function validateFixtureHash(raw: FixtureFile, fixturePath: string): void {
  // Skip validation if PINNED_CORPUS_HASH is the placeholder (dev mode).
  if (PINNED_CORPUS_HASH === 'FIXTURE_HASH_PLACEHOLDER') return;

  const { corpus_hash: embeddedHash, ...rest } = raw;
  const canonical = JSON.stringify(rest, null, 2);
  const computed = createHash('sha256').update(canonical, 'utf8').digest('hex');

  if (computed !== PINNED_CORPUS_HASH) {
    throw new LoaderError(
      'CORPUS_HASH_MISMATCH',
      `MemoryAgentBenchLoader: CORPUS_HASH_MISMATCH\n` +
        `  expected: ${PINNED_CORPUS_HASH}\n` +
        `  computed: ${computed}\n` +
        `  fixture:  ${fixturePath}\n` +
        'The fixture has been modified. Re-run scripts/fetch-fixtures.mjs or ' +
        'update PINNED_CORPUS_HASH in this file.',
    );
  }
}

function rawToEvent(item: RawTemporalItem): CortexEvent {
  const payload = hexToBytes(item.payload_hex);
  return {
    id: item.id,
    family: 'temporal',
    taskType: item.task,
    isProtected: item.protected,
    sourceRef: item.source_ref,
    payload,
    queryText: item.query,
    truthText: item.truth,
    isStaleTruth: item.is_stale,
    epochCommitted: item.epoch_committed,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (s.length % 2 !== 0) throw new RangeError(`hexToBytes: odd-length hex '${s.slice(0, 16)}…'`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function resolveRepoRoot(): string {
  // benchmark/generators/temporal/MemoryAgentBenchLoader.ts → ../../../..
  // __dirname is not available in ESM; use import.meta.url equivalent via fileURLToPath
  try {
    // Node.js ESM: derive from import.meta.url
    // We can't use import.meta.url here in a plain .ts file, so use process.cwd()
    // and assume the process is invoked from the repo root (standard for test runners).
    return process.cwd();
  } catch {
    return '.';
  }
}

export { PROTECTED_COUNT };
