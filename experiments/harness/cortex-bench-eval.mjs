// Real CortexBench V0 scoring engine for Phase 7 baseline iteration.
//
// Pure JS, deterministic, no I/O beyond reading the committed fixture files.
// Replaces the synthetic SEED-XOR scoring in the old harness with a real
// per-component score driven by the Phase 4 corpus events.
//
// Per benchmark/score.ts the composite score is:
//   S = 0.30·exactRetrieval
//     + 0.15·staleMemoryRejection
//     + 0.15·temporalUpdateCorrectness
//     + 0.30·compressionSurvival
//     + 0.05·routingAccuracy
//     − latencyPenalty(latencyMs, p50=10ms, p99=50ms)
//
// The evaluator is structural: it asks whether the decoded state encodes the
// right slots/keys/temporal entries for each corpus event. This is exactly
// what the on-chain state needs to do for downstream tasks; it gives every
// baseline a real, comparable score that depends on the actual contents of
// its 1024 words.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── score weights (mirrors benchmark/score.ts) ────────────────────────────────
export const WEIGHTS = Object.freeze({
  exactRetrieval:            0.30,
  staleMemoryRejection:      0.15,
  temporalUpdateCorrectness: 0.15,
  compressionSurvival:       0.30,
  routingAccuracy:           0.05,
  latencyPenalty:            0.025,
});
export const SCORE_THRESHOLD = 0.005;

// ── deterministic fixed-width hashes from event ids ──────────────────────────
function sha256Bytes(text) {
  return new Uint8Array(createHash('sha256').update(text).digest());
}
function bytesToBigInt(bytes, hi, lo) {
  let v = 0n;
  for (let i = hi; i >= lo; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}
export function eventIdToKey128(eventId) {
  const h = sha256Bytes(`cortex-key128:${eventId}`);
  return bytesToBigInt(h, 15, 0);
}
export function eventIdToMem128(eventId) {
  const h = sha256Bytes(`cortex-mem128:${eventId}`);
  return bytesToBigInt(h, 15, 0);
}
export function eventIdToTemporal160(eventId) {
  const h = sha256Bytes(`cortex-temporal160:${eventId}`);
  return bytesToBigInt(h, 19, 0);
}

// ── corpus loader ────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

const FIXTURE_PATHS = {
  near_collision: 'benchmark/fixtures/near_collision/limit_nq_hotpotqa_v0.json',
  temporal:       'benchmark/fixtures/temporal/memoryagentbench_v0.json',
  long_horizon:   'benchmark/fixtures/long_horizon/memoryarena_v0.json',
};

/**
 * Load Phase 4 fixture events and convert to a uniform shape.
 * Falls back to empty arrays for any missing fixture so the harness still
 * runs against partial corpora.
 */
export function loadRealCorpus({ repoRoot = REPO_ROOT } = {}) {
  const events = { near_collision: [], temporal: [], long_horizon: [] };
  const sources = {};
  for (const [family, relPath] of Object.entries(FIXTURE_PATHS)) {
    const fp = resolve(repoRoot, relPath);
    if (!existsSync(fp)) {
      sources[family] = { path: relPath, count: 0, missing: true };
      continue;
    }
    const raw = JSON.parse(readFileSync(fp, 'utf8'));
    const items = (raw.items ?? []).map((item) => normaliseRaw(family, item));
    events[family] = items;
    sources[family] = {
      path: relPath,
      count: items.length,
      license: raw.license_spdx ?? raw.licenses ?? null,
      source: raw.source ?? raw.sources ?? null,
    };
  }
  // Augment temporal with the deterministic synthetic stream so the family
  // covers the LoCoMo-shaped breadth (Path B). 60 events per epoch (synthetic
  // generator default), 20 protected.
  events.temporal = events.temporal.concat(synthesizeTemporalEvents(0, 60));
  sources.synthetic_temporal = { count: 60, license: 'Apache-2.0' };

  return { events, sources };
}

function normaliseRaw(family, item) {
  // Common shape across the three fixture families.
  const base = {
    id: item.id,
    family,
    isProtected: item.protected === true,
    epochCommitted: item.epoch_committed ?? 0,
    queryText: item.query ?? '',
    truthText: item.truth ?? item.passage ?? '',
  };
  if (family === 'near_collision') {
    return { ...base, taskType: item.source ?? 'near_collision', isStaleTruth: false };
  }
  if (family === 'temporal') {
    return { ...base, taskType: item.task ?? 'temporal', isStaleTruth: item.is_stale === true };
  }
  if (family === 'long_horizon') {
    return { ...base, taskType: item.config ?? 'long_horizon', isStaleTruth: false };
  }
  return base;
}

function synthesizeTemporalEvents(epoch, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const id = `syn-${epoch}-${i.toString().padStart(4, '0')}`;
    const isStale = (i & 1) === 1; // half stale, half current — matches §5 spec
    out.push({
      id,
      family: 'temporal',
      taskType: isStale ? 'stale_rejection' : 'temporal_update',
      isProtected: i < 20,
      epochCommitted: epoch,
      queryText: `synthetic ${i}`,
      truthText: `truth ${i}`,
      isStaleTruth: isStale,
    });
  }
  return out;
}

// ── component scoring ────────────────────────────────────────────────────────

const MEMORY_INDEX_START = 32;
const MEMORY_INDEX_SLOTS = 44;
const RETRIEVAL_KEYS_START = 384;
const RETRIEVAL_KEY_SLOTS = 36;
const RELATIONS_START = 672;
const RELATIONS_END = 799;

/**
 * Score a raw CortexState against the corpus. Reads word-level fields
 * directly per cortex_state_v0.md so the scorer is independent of the typed
 * decoder. Stale rejection / temporal update correctness are signalled by
 * the memory_index slot's REVOKED bit (per the spec, REVOKED is bit 65 of
 * the slot's word 0, encoded as bit 1 of VALIDITY_FLAGS at 79:64).
 *
 * Returns { components, composite, familyScores, hits, totals, latencyMs }.
 */
export function scoreState(state, corpus, opts = {}) {
  const latencyMs = opts.latencyMs ?? 0;
  const words = state.words;

  const activeMemIds = new Set();
  const revokedMemIds = new Set();
  for (let s = 0; s < MEMORY_INDEX_SLOTS; s++) {
    const w0 = words[MEMORY_INDEX_START + s * 8] ?? 0n;
    if (w0 === 0n) continue;
    const eventId = (w0 >> 128n) & ((1n << 128n) - 1n);
    if (eventId === 0n) continue;
    const flags = Number((w0 >> 64n) & 0xFFFFn);
    const valid = (flags & 0x0001) !== 0;
    const revoked = (flags & 0x0002) !== 0;
    if (!valid) continue;
    if (revoked) revokedMemIds.add(eventId);
    else activeMemIds.add(eventId);
  }

  const activeKeyIds = new Set();
  for (let s = 0; s < RETRIEVAL_KEY_SLOTS; s++) {
    const w0 = words[RETRIEVAL_KEYS_START + s * 8] ?? 0n;
    if (w0 === 0n) continue;
    const keyId = (w0 >> 128n) & ((1n << 128n) - 1n);
    if (keyId === 0n) continue;
    const flags = Number((w0 >> 80n) & 0xFFFFn);
    const active = (flags & 0x0001) !== 0;
    if (active) activeKeyIds.add(keyId);
  }

  let filledRel = 0;
  const totalRel = RELATIONS_END - RELATIONS_START + 1;
  for (let i = RELATIONS_START; i <= RELATIONS_END; i++) {
    const w = words[i] ?? 0n;
    const weight = Number((w >> 192n) & 0xFFFFn);
    if (weight > 0) filledRel++;
  }

  const nc = corpus.events.near_collision;
  const lh = corpus.events.long_horizon;
  const stale = corpus.events.temporal.filter((e) => e.isStaleTruth === true);
  const current = corpus.events.temporal.filter((e) => e.isStaleTruth === false);

  let ncHits = 0;
  for (const e of nc) if (activeKeyIds.has(eventIdToKey128(e.id))) ncHits++;
  const exactRetrieval = nc.length === 0 ? 0 : ncHits / nc.length;

  let staleRej = 0;
  for (const e of stale) if (revokedMemIds.has(eventIdToMem128(e.id))) staleRej++;
  const staleMemoryRejection = stale.length === 0 ? 0 : staleRej / stale.length;

  let curMatched = 0;
  for (const e of current) if (activeMemIds.has(eventIdToMem128(e.id))) curMatched++;
  const temporalUpdateCorrectness = current.length === 0 ? 0 : curMatched / current.length;

  let lhCov = 0;
  for (const e of lh) if (activeMemIds.has(eventIdToMem128(e.id))) lhCov++;
  const compressionSurvival = lh.length === 0 ? 0 : lhCov / lh.length;

  const routingAccuracy = totalRel === 0 ? 0 : filledRel / totalRel;

  const components = {
    exactRetrieval,
    staleMemoryRejection,
    temporalUpdateCorrectness,
    compressionSurvival,
    routingAccuracy,
    latencyMs,
  };
  const composite = computeComposite(components);
  const familyScores = {
    near_collision: exactRetrieval,
    temporal:       (staleMemoryRejection + temporalUpdateCorrectness) / 2,
    long_horizon:
      (compressionSurvival * WEIGHTS.compressionSurvival +
        routingAccuracy * WEIGHTS.routingAccuracy) /
      (WEIGHTS.compressionSurvival + WEIGHTS.routingAccuracy),
  };

  return {
    components,
    composite,
    familyScores,
    hits: { near_collision: ncHits, stale: staleRej, current: curMatched, long_horizon: lhCov, relations: filledRel },
    totals: { near_collision: nc.length, stale: stale.length, current: current.length, long_horizon: lh.length, relations: totalRel },
  };
}

// Compatibility alias.
export function scoreDecodedState(_decoded, corpus, opts = {}) {
  // Some callers still reach for this name. The decoded state has the raw
  // words on `_decoded`, but the new scorer wants the raw state. We can
  // reconstruct by reading the indexed fields where present, but to keep
  // the callers consistent the harness should pass the raw state via
  // scoreState. This shim accepts a state-like object with .words.
  if (_decoded && Array.isArray(_decoded.words)) return scoreState(_decoded, corpus, opts);
  throw new Error('scoreDecodedState: pass the raw state via scoreState() instead');
}

export function computeComposite(c, opts = {}) {
  const p50 = opts.latencyP50Ms ?? 10;
  const p99 = opts.latencyP99Ms ?? 50;
  let lp = 0;
  if (c.latencyMs > p50) {
    if (c.latencyMs >= p99) lp = WEIGHTS.latencyPenalty;
    else lp = ((c.latencyMs - p50) / (p99 - p50)) * WEIGHTS.latencyPenalty;
  }
  const raw =
    WEIGHTS.exactRetrieval * c.exactRetrieval +
    WEIGHTS.staleMemoryRejection * c.staleMemoryRejection +
    WEIGHTS.temporalUpdateCorrectness * c.temporalUpdateCorrectness +
    WEIGHTS.compressionSurvival * c.compressionSurvival +
    WEIGHTS.routingAccuracy * c.routingAccuracy -
    lp;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Marginal-gain evaluator factory: returns a function compatible with the
 * Phase 6 reducer / live-epoch `MarginalEvaluator` signature.
 *
 *   marginalEvaluator(currentState: CortexState, patch: Patch) → bigint
 *
 * Computes baselineScore vs candidateScore via the real corpus and returns
 * the delta scaled by `scale` (default 1e6) as a bigint, matching the
 * `scoreDelta×1e6` convention used elsewhere in the codebase.
 */
export function makeRealMarginalEvaluator({ corpus, decode, applyPatch, scale = 1_000_000n } = {}) {
  if (typeof decode !== 'function' || typeof applyPatch !== 'function') {
    throw new Error('makeRealMarginalEvaluator: decode + applyPatch required');
  }
  if (!corpus) throw new Error('makeRealMarginalEvaluator: corpus required');

  return (currentState, patch) => {
    const baseDecoded = decode(currentState);
    if (!baseDecoded.ok) return 0n;
    const baseScore = scoreDecodedState(baseDecoded.decoded, corpus).composite;
    const applied = applyPatch(currentState, patch);
    if (!applied.ok) return 0n;
    const newDecoded = decode(applied.state);
    if (!newDecoded.ok) return 0n;
    const newScore = scoreDecodedState(newDecoded.decoded, corpus).composite;
    const delta = newScore - baseScore;
    return BigInt(Math.round(delta * Number(scale)));
  };
}
