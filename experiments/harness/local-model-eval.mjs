// Local model-assisted memory evaluator for elevated Cortex proposals.
//
// Consensus still uses the deterministic structural CortexBench scorer. This
// sidecar adds the missing empirical layer: after CortexState says "these
// memory handles are available", a small local embedding model ranks the
// actual memory texts for each benchmark query. This answers the practical
// question: would a lightweight model retrieve the right memory content?

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  WEIGHTS,
  computeComposite,
  eventIdToKey128,
  eventIdToMem128,
  loadRealCorpus,
} from './cortex-bench-eval.mjs';

const MEMORY_INDEX_START = 32;
const MEMORY_INDEX_SLOTS = 44;
const RETRIEVAL_KEYS_START = 384;
const RETRIEVAL_KEY_SLOTS = 36;
const RELATIONS_START = 672;
const RELATIONS_END = 799;

export const DEFAULT_LOCAL_MODEL = 'Xenova/multi-qa-MiniLM-L6-cos-v1';

export function memoryText(event) {
  const answer = event.passage ?? event.truthText ?? event.truth ?? '';
  return `${event.queryText ?? event.query ?? ''}\n${answer}`.trim();
}

export function extractStateMemoryView(state, corpus) {
  const words = state.words;
  const activeMemIds = new Set();
  const revokedMemIds = new Set();
  const activeKeyIds = new Set();
  let filledRelations = 0;

  for (let s = 0; s < MEMORY_INDEX_SLOTS; s++) {
    const w0 = words[MEMORY_INDEX_START + s * 8] ?? 0n;
    if (w0 === 0n) continue;
    const eventId = (w0 >> 128n) & ((1n << 128n) - 1n);
    if (eventId === 0n) continue;
    const flags = Number((w0 >> 64n) & 0xFFFFn);
    const valid = (flags & 0x0001) !== 0;
    const revoked = (flags & 0x0002) !== 0;
    if (!valid) continue;
    if (revoked) revokedMemIds.add(eventId.toString());
    else activeMemIds.add(eventId.toString());
  }

  for (let s = 0; s < RETRIEVAL_KEY_SLOTS; s++) {
    const w0 = words[RETRIEVAL_KEYS_START + s * 8] ?? 0n;
    if (w0 === 0n) continue;
    const keyId = (w0 >> 128n) & ((1n << 128n) - 1n);
    if (keyId === 0n) continue;
    const flags = Number((w0 >> 80n) & 0xFFFFn);
    if ((flags & 0x0001) !== 0) activeKeyIds.add(keyId.toString());
  }

  for (let i = RELATIONS_START; i <= RELATIONS_END; i++) {
    const w = words[i] ?? 0n;
    const weight = Number((w >> 192n) & 0xFFFFn);
    if (weight > 0) filledRelations++;
  }

  const flat = flattenCorpus(corpus);
  const byId = new Map(flat.map((event) => [event.id, event]));
  const activeMemoryEvents = flat.filter((event) => activeMemIds.has(eventIdToMem128(event.id).toString()));
  const revokedMemoryEvents = flat.filter((event) => revokedMemIds.has(eventIdToMem128(event.id).toString()));
  const activeKeyEvents = flat.filter((event) => activeKeyIds.has(eventIdToKey128(event.id).toString()));

  return {
    byId,
    activeMemIds,
    revokedMemIds,
    activeKeyIds,
    activeMemoryEvents,
    revokedMemoryEvents,
    activeKeyEvents,
    routingAccuracy: filledRelations / (RELATIONS_END - RELATIONS_START + 1),
  };
}

export function buildModelEvalTasks(corpus, view, { maxTasksPerFamily = 64 } = {}) {
  const tasks = [];

  const nearByQuery = new Map();
  for (const event of corpus.events.near_collision) {
    const key = event.queryText ?? event.query ?? '';
    if (!nearByQuery.has(key)) nearByQuery.set(key, []);
    nearByQuery.get(key).push(event);
  }
  for (const [query, group] of nearByQuery) {
    const positives = group.filter((event) => event.relevant !== false);
    if (positives.length === 0) continue;
    const candidates = group.filter((event) => view.activeKeyIds.has(eventIdToKey128(event.id).toString()));
    tasks.push({
      family: 'near_collision',
      kind: 'exact_retrieval',
      query,
      positiveIds: positives.map((event) => event.id),
      candidates,
      requireCandidate: true,
    });
  }

  const activeLong = corpus.events.long_horizon.filter((event) =>
    view.activeMemIds.has(eventIdToMem128(event.id).toString()));
  for (const event of corpus.events.long_horizon) {
    tasks.push({
      family: 'long_horizon',
      kind: 'compression_survival',
      query: event.queryText ?? event.query ?? '',
      positiveIds: [event.id],
      candidates: activeLong,
      requireCandidate: true,
    });
  }

  const activeTemporal = corpus.events.temporal.filter((event) =>
    view.activeMemIds.has(eventIdToMem128(event.id).toString()));
  for (const event of corpus.events.temporal) {
    const memId = eventIdToMem128(event.id).toString();
    if (event.isStaleTruth === true) {
      tasks.push({
        family: 'temporal_stale',
        kind: 'stale_memory_rejection',
        query: event.queryText ?? event.query ?? '',
        positiveIds: [],
        rejectedId: event.id,
        structurallyRevoked: view.revokedMemIds.has(memId),
        candidates: activeTemporal,
        requireCandidate: false,
      });
    } else {
      tasks.push({
        family: 'temporal_current',
        kind: 'temporal_update_correctness',
        query: event.queryText ?? event.query ?? '',
        positiveIds: [event.id],
        candidates: activeTemporal,
        requireCandidate: true,
      });
    }
  }

  return capTasks(tasks, maxTasksPerFamily);
}

export async function evaluateStateWithLocalModel(state, corpus, opts = {}) {
  const t0 = performance.now();
  const embedder = opts.embedder ?? createHashingEmbedder();
  const view = extractStateMemoryView(state, corpus);
  const tasks = buildModelEvalTasks(corpus, view, opts);
  const textKeys = [];
  const textByKey = new Map();

  for (const task of tasks) {
    const qKey = `q:${task.family}:${task.kind}:${task.query}`;
    if (!textByKey.has(qKey)) {
      textByKey.set(qKey, task.query);
      textKeys.push(qKey);
    }
    for (const candidate of task.candidates) {
      const cKey = `c:${candidate.id}`;
      if (!textByKey.has(cKey)) {
        textByKey.set(cKey, memoryText(candidate));
        textKeys.push(cKey);
      }
    }
  }

  const vectors = new Map();
  if (textKeys.length > 0) {
    const rows = await embedder.embedTexts(textKeys.map((key) => textByKey.get(key)));
    for (let i = 0; i < textKeys.length; i++) vectors.set(textKeys[i], rows[i]);
  }

  const family = {
    near_collision: { hits: 0, total: 0 },
    long_horizon: { hits: 0, total: 0 },
    temporal_stale: { hits: 0, total: 0 },
    temporal_current: { hits: 0, total: 0 },
  };

  const examples = [];
  for (const task of tasks) {
    family[task.family].total++;
    const qKey = `q:${task.family}:${task.kind}:${task.query}`;
    const ranked = rankCandidates(vectors.get(qKey), task.candidates, vectors);
    const top = ranked[0] ?? null;
    let hit = false;
    if (task.kind === 'stale_memory_rejection') {
      hit = task.structurallyRevoked === true && (!top || top.id !== task.rejectedId);
    } else if (!task.requireCandidate && !top) {
      hit = true;
    } else {
      hit = Boolean(top && task.positiveIds.includes(top.id));
    }
    if (hit) family[task.family].hits++;
    if (examples.length < 12) {
      examples.push({
        family: task.family,
        kind: task.kind,
        query: task.query,
        topId: top?.id ?? null,
        positiveIds: task.positiveIds,
        hit,
      });
    }
  }

  const exactRetrieval = ratio(family.near_collision);
  const compressionSurvival = ratio(family.long_horizon);
  const staleMemoryRejection = ratio(family.temporal_stale);
  const temporalUpdateCorrectness = ratio(family.temporal_current);
  const latencyMs = performance.now() - t0;
  // The structural Core scorer owns the production latency penalty. This
  // sidecar measures retrieval usefulness with a local model, and reports
  // model wall-clock separately so cold model loads do not erase real signal.
  const components = {
    exactRetrieval,
    staleMemoryRejection,
    temporalUpdateCorrectness,
    compressionSurvival,
    routingAccuracy: view.routingAccuracy,
    latencyMs: 0,
  };

  return {
    model: embedder.model ?? 'hashing-embedder',
    components,
    composite: computeComposite(components),
    family,
    examples,
    modelLatencyMs: latencyMs,
    weights: WEIGHTS,
  };
}

export async function prewarmLocalModelEmbedder(embedder, corpus) {
  const texts = [];
  const seen = new Set();
  for (const event of flattenCorpus(corpus)) {
    for (const text of [event.queryText ?? event.query ?? '', memoryText(event)]) {
      if (!text || seen.has(text)) continue;
      seen.add(text);
      texts.push(text);
    }
  }
  const t0 = performance.now();
  if (texts.length > 0) await embedder.embedTexts(texts);
  return { textCount: texts.length, latencyMs: performance.now() - t0 };
}

export async function evaluatePatchWithLocalModel(parentState, patch, { applyPatch, corpus, embedder, threshold = 0 } = {}) {
  if (typeof applyPatch !== 'function') throw new Error('evaluatePatchWithLocalModel: applyPatch required');
  const benchCorpus = corpus ?? loadRealCorpus();
  const before = await evaluateStateWithLocalModel(parentState, benchCorpus, { embedder });
  const applied = applyPatch(parentState, patch);
  if (!applied.ok) {
    return { pass: false, scoreDelta: 0, before, after: before, errorCode: applied.code };
  }
  const after = await evaluateStateWithLocalModel(applied.state, benchCorpus, { embedder });
  const delta = after.composite - before.composite;
  const regressions = componentRegressions(before.components, after.components);
  const noRegression = regressions.length === 0 && after.composite + 1e-12 >= before.composite;
  return {
    pass: noRegression && delta + 1e-12 >= threshold,
    scoreDelta: Math.round(delta * 1_000_000),
    delta,
    noRegression,
    regressions,
    before,
    after,
  };
}

export function createHashingEmbedder({ dims = 256 } = {}) {
  return withEmbeddingCache({
    model: `deterministic-hashing-${dims}`,
    async embedTexts(texts) {
      return texts.map((text) => normalise(hashVector(text, dims)));
    },
  });
}

export async function createTransformersEmbedder(opts = {}) {
  const model = opts.model ?? process.env.CORTEX_LOCAL_MODEL ?? DEFAULT_LOCAL_MODEL;
  const localOnly = opts.localOnly ?? process.env.CORTEX_LOCAL_MODEL_LOCAL_ONLY === '1';
  const cacheDir = opts.cacheDir ?? process.env.CORTEX_LOCAL_MODEL_CACHE;
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch (err) {
    throw new Error(
      'Local model eval requires optional dependency @huggingface/transformers. ' +
      'Install it or pass createHashingEmbedder() for deterministic tests. ' +
      `Original error: ${err?.message ?? String(err)}`,
    );
  }

  const { pipeline, env } = transformers;
  if (cacheDir && env) env.cacheDir = cacheDir;
  if (env && localOnly) {
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
  }
  const extractor = await pipeline('feature-extraction', model);

  return withEmbeddingCache({
    model,
    async embedTexts(texts) {
      const rows = [];
      const batchSize = opts.batchSize ?? 16;
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const out = await extractor(batch, { pooling: 'mean', normalize: true });
        rows.push(...tensorToRows(out, batch.length));
      }
      return rows;
    },
  });
}

export function withEmbeddingCache(embedder) {
  const cache = new Map();
  return {
    ...embedder,
    async embedTexts(texts) {
      const rows = new Array(texts.length);
      const missing = [];
      const missingIdx = [];
      for (let i = 0; i < texts.length; i++) {
        const key = String(texts[i]);
        if (cache.has(key)) rows[i] = cache.get(key);
        else {
          missing.push(key);
          missingIdx.push(i);
        }
      }
      if (missing.length > 0) {
        const computed = await embedder.embedTexts(missing);
        for (let i = 0; i < missing.length; i++) {
          cache.set(missing[i], computed[i]);
          rows[missingIdx[i]] = computed[i];
        }
      }
      return rows;
    },
  };
}

function flattenCorpus(corpus) {
  return [
    ...corpus.events.near_collision,
    ...corpus.events.temporal,
    ...corpus.events.long_horizon,
  ];
}

function rankCandidates(queryVec, candidates, vectors) {
  if (!queryVec || candidates.length === 0) return [];
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: dot(queryVec, vectors.get(`c:${candidate.id}`) ?? []),
    }))
    .sort((a, b) => b.score - a.score);
}

function capTasks(tasks, maxTasksPerFamily) {
  if (!Number.isFinite(maxTasksPerFamily) || maxTasksPerFamily <= 0) return tasks;
  const seen = new Map();
  const out = [];
  for (const task of tasks) {
    const n = seen.get(task.family) ?? 0;
    if (n >= maxTasksPerFamily) continue;
    seen.set(task.family, n + 1);
    out.push(task);
  }
  return out;
}

function ratio(x) {
  return x.total === 0 ? 0 : x.hits / x.total;
}

function componentRegressions(before, after, epsilon = 1e-12) {
  const fields = [
    'exactRetrieval',
    'staleMemoryRejection',
    'temporalUpdateCorrectness',
    'compressionSurvival',
    'routingAccuracy',
  ];
  return fields.filter((field) => (after[field] ?? 0) + epsilon < (before[field] ?? 0));
}

function hashVector(text, dims) {
  const v = new Array(dims).fill(0);
  const tokens = String(text).toLowerCase().match(/[a-z0-9$]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    addToken(v, tokens[i], 1);
    if (i + 1 < tokens.length) addToken(v, `${tokens[i]} ${tokens[i + 1]}`, 0.5);
  }
  return v;
}

function addToken(v, token, weight) {
  const h = createHash('sha256').update(token).digest();
  const idx = h.readUInt32BE(0) % v.length;
  const sign = (h[4] & 1) === 0 ? 1 : -1;
  v[idx] += sign * weight;
}

function normalise(v) {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function dot(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function tensorToRows(out, expectedRows) {
  if (typeof out?.tolist === 'function') {
    const arr = out.tolist();
    if (Array.isArray(arr[0]) && Array.isArray(arr[0][0])) {
      return arr.map((row) => row[0]);
    }
    if (Array.isArray(arr[0])) return arr;
    return [arr];
  }
  if (out?.data && Array.isArray(out.dims)) {
    const data = Array.from(out.data);
    const dims = out.dims;
    if (dims.length === 2) {
      const [rows, cols] = dims;
      return chunk(data, cols).slice(0, rows);
    }
    if (dims.length === 3) {
      const [rows, _tokens, cols] = dims;
      return chunk(data, cols).slice(0, rows);
    }
  }
  if (Array.isArray(out) && Array.isArray(out[0])) return out;
  if (expectedRows === 1 && Array.isArray(out)) return [out];
  throw new Error('Unsupported Transformers.js tensor output shape');
}

function chunk(data, size) {
  const rows = [];
  for (let i = 0; i < data.length; i += size) rows.push(data.slice(i, i + size));
  return rows;
}
