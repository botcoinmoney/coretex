import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { repoRoot } from '../_repo-root.mjs';

function sha256Hex(s) {
  return '0x' + createHash('sha256').update(s).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',') + '}';
}

function pct(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function loadCache(cachePath) {
  const out = new Map();
  if (!cachePath || !existsSync(cachePath)) return out;
  for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (typeof row.key === 'string' && typeof row.score === 'number' && Number.isFinite(row.score)) out.set(row.key, row);
    } catch {
      // Ignore a partial final line from an interrupted calibration run.
    }
  }
  return out;
}

export function makeInstrumentedReranker({
  reranker,
  modelId,
  revision,
  profileHash,
  substrateMode,
  memoryIRVersion = 'raw',
  cachePath,
  mode,
  batchSize,
} = {}) {
  if (!reranker || typeof reranker.score !== 'function') throw new Error('makeInstrumentedReranker requires reranker.score');
  const resolvedCachePath = cachePath ? resolve(repoRoot, cachePath) : null;
  if (resolvedCachePath) mkdirSync(dirname(resolvedCachePath), { recursive: true });
  const cache = loadCache(resolvedCachePath);
  const backendBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : null;
  const uniquePairKeys = new Set();
  const batchSizes = [];
  const stats = {
    requestedPairs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    backendPairs: 0,
    backendCalls: 0,
    backendWallMs: 0,
  };

  const keyFor = (pair) => {
    const material = {
      queryTextHash: sha256Hex(pair.query ?? ''),
      renderedCandidateHash: sha256Hex(pair.document ?? ''),
      rerankerModelId: modelId ?? reranker.model ?? 'unknown',
      rerankerRevision: revision ?? 'unknown',
      memoryIRVersion,
      profileHash: profileHash ?? 'unknown',
      substrateMode: substrateMode ?? 'unknown',
    };
    return { material, key: sha256Hex(canonical(material)) };
  };

  const persist = (row) => {
    if (!resolvedCachePath) return;
    appendFileSync(resolvedCachePath, JSON.stringify(row) + '\n');
  };

  return {
    model: reranker.model,
    async score(pairs) {
      if (!pairs?.length) return [];
      const out = new Array(pairs.length);
      const misses = [];
      const seenMiss = new Map();
      stats.requestedPairs += pairs.length;
      batchSizes.push(pairs.length);

      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const { material, key } = keyFor(pair);
        uniquePairKeys.add(key);
        const cached = cache.get(key);
        if (cached) {
          stats.cacheHits++;
          out[i] = cached.score;
          continue;
        }
        stats.cacheMisses++;
        if (!seenMiss.has(key)) {
          seenMiss.set(key, misses.length);
          misses.push({ key, material, pair, positions: [i] });
        } else {
          misses[seenMiss.get(key)].positions.push(i);
        }
      }

      for (let startIdx = 0; startIdx < misses.length; startIdx += (backendBatchSize ?? misses.length)) {
        const chunk = misses.slice(startIdx, startIdx + (backendBatchSize ?? misses.length));
        if (!chunk.length) continue;
        const backendPairs = chunk.map((m) => m.pair);
        const start = Date.now();
        const scores = await reranker.score(backendPairs);
        const wall = Date.now() - start;
        stats.backendCalls++;
        stats.backendPairs += backendPairs.length;
        stats.backendWallMs += wall;
        if (scores.length !== backendPairs.length) throw new Error(`instrumented reranker expected ${backendPairs.length} scores, got ${scores.length}`);
        for (let i = 0; i < chunk.length; i++) {
          const score = scores[i];
          if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error(`instrumented reranker got non-finite score at miss ${i}`);
          const row = { key: chunk[i].key, score, ...chunk[i].material };
          cache.set(row.key, row);
          persist(row);
          for (const pos of chunk[i].positions) out[pos] = score;
        }
      }
      return out;
    },
    telemetrySnapshot() {
      const sortedBatches = [...batchSizes].sort((a, b) => a - b);
      return {
        mode: mode ?? null,
        modelId: modelId ?? reranker.model ?? null,
        revision: revision ?? null,
        requestedPairs: stats.requestedPairs,
        uniqueQueryDocPairs: uniquePairKeys.size,
        cacheHits: stats.cacheHits,
        cacheMisses: stats.cacheMisses,
        backendPairs: stats.backendPairs,
        backendCalls: stats.backendCalls,
        backendWallMs: stats.backendWallMs,
        timePerBackendPairMs: stats.backendPairs ? stats.backendWallMs / stats.backendPairs : null,
        requestBatchSize: {
          configured: batchSize ?? null,
          p50: pct(sortedBatches, 0.5),
          p90: pct(sortedBatches, 0.9),
          max: sortedBatches.length ? sortedBatches[sortedBatches.length - 1] : null,
        },
        cachePath: resolvedCachePath ? resolvedCachePath.replace(repoRoot + '/', '') : null,
      };
    },
    async close() {
      await reranker.close?.();
    },
    modelStartupMs() {
      return typeof reranker.modelStartupMs === 'function' ? reranker.modelStartupMs() : null;
    },
  };
}
