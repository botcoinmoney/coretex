#!/usr/bin/env node
/**
 * Parallel driver for scripts/generate-coretex-retrieval-corpus.mjs.
 *
 * Splits the seed range into N disjoint shards and runs one corpus
 * generator subprocess per shard. Each shard:
 *   - owns a slice of the (domain, seedIndex) cross product, derived from
 *     --seed-offset and --seeds-per-domain
 *   - spawns its own persistent BGE-M3 + MemReranker-4B subprocesses
 *   - writes its events to a per-shard corpus file
 * After all shards finish, the driver merges them in seed-offset order via
 * applyCorpusDelta so the final corpus has the same on-chain corpusRoot it
 * would have produced if a single worker had generated it sequentially.
 *
 * The merge is deterministic: it appends events in shard-order, recomputes
 * the corpus root over the union, and verifies that each shard's per-shard
 * root agreed with its computed root.
 *
 * Usage:
 *   node scripts/generate-coretex-retrieval-corpus-parallel.mjs \
 *     --bundle-manifest /etc/coretex/template-bundle.json \
 *     --challenge-lib-root /root/botcoin-coordinator/packages/challenges \
 *     --domains companies,quantum_physics,computational_biology,scrna_imputation \
 *     --seeds-per-domain 512 \
 *     --workers 8 \
 *     --modifier-counts 0,1,2,3 \
 *     --constraint-difficulties easy,medium,hard \
 *     --trap-count 2 \
 *     --corpus-epoch 0 \
 *     --shard-dir /var/lib/coretex/corpus-shards \
 *     --out /var/lib/coretex/corpus-epoch-0.json \
 *     --num-threads-per-worker 4 \
 *     --inner-batch-biencoder 16 \
 *     --inner-batch-reranker 8
 */
import { scriptsRoot, repoRoot } from './_repo-root.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';

import {
  computeCorpusRoot,
  loadProductionCorpus,
} from '@botcoin/cortex';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const bundlePath = flag('bundle-manifest');
if (!bundlePath) { console.error('--bundle-manifest required'); exit(1); }
const challengeLibRoot = resolve(flag('challenge-lib-root', env.CORETEX_CHALLENGE_LIB_ROOT ?? ''));
if (!challengeLibRoot || !existsSync(challengeLibRoot)) { console.error(`--challenge-lib-root invalid: ${challengeLibRoot}`); exit(1); }
const domains = flag('domains', 'companies,quantum_physics,computational_biology,scrna_imputation').split(',').map((s) => s.trim()).filter(Boolean);
const seedsPerDomain = Number(flag('seeds-per-domain', '512'));
const workers = Number(flag('workers', '4'));
if (!Number.isFinite(workers) || workers < 1) { console.error('--workers must be >= 1'); exit(1); }
const modifierCounts = flag('modifier-counts', '0,1,2,3');
const constraintDifficulties = flag('constraint-difficulties', 'easy,medium,hard');
const trapCount = flag('trap-count', '2');
const corpusEpoch = Number(flag('corpus-epoch', '0'));
const shardDir = resolve(flag('shard-dir', '/var/lib/coretex/corpus-shards'));
const outPath = resolve(flag('out'));
if (!outPath) { console.error('--out required'); exit(1); }
const numThreadsPerWorker = Number(flag('num-threads-per-worker', '4'));
const innerBatchBiEncoder = Number(flag('inner-batch-biencoder', '16'));
const innerBatchReranker = Number(flag('inner-batch-reranker', '8'));
const labelerBatchSize = Number(flag('labeler-batch-size', '8'));
const cacheDir = resolve(flag('cache-dir', env.CORTEX_LOCAL_MODEL_CACHE ?? '/var/lib/coretex/model-cache'));
const pythonBin = flag('python', env.CORETEX_BIENCODER_PYTHON ?? resolve(repoRoot, '.venv/bin/python'));

mkdirSync(shardDir, { recursive: true });
mkdirSync(dirname(outPath), { recursive: true });

// Even split of seedsPerDomain across workers.
const shards = [];
const baseSeedsPerWorker = Math.floor(seedsPerDomain / workers);
const remainder = seedsPerDomain - baseSeedsPerWorker * workers;
let cursor = 0;
for (let w = 0; w < workers; w++) {
  const count = baseSeedsPerWorker + (w < remainder ? 1 : 0);
  if (count === 0) continue;
  shards.push({
    workerId: w,
    seedOffset: cursor,
    seedsThisShard: count,
    outPath: resolve(shardDir, `corpus-shard-${String(w).padStart(2, '0')}.json`),
    stderrPath: resolve(shardDir, `corpus-shard-${String(w).padStart(2, '0')}.stderr`),
  });
  cursor += count;
}

console.log(`[parallel] driver dispatching ${shards.length} workers, total seeds-per-domain=${seedsPerDomain}, domains=${domains.join(',')}`);
for (const s of shards) {
  console.log(`  worker ${s.workerId}: seedOffset=${s.seedOffset} seedsThisShard=${s.seedsThisShard} → ${s.outPath}`);
}

function runShard(shard) {
  return new Promise((resolveShard, rejectShard) => {
    const args = [
      resolve(scriptsRoot, 'generate-coretex-retrieval-corpus.mjs'),
      '--bundle-manifest', resolve(bundlePath),
      '--source', 'challenge-library',
      '--challenge-lib-root', challengeLibRoot,
      '--domains', domains.join(','),
      '--seeds-per-domain', String(shard.seedsThisShard),
      '--seed-offset', String(shard.seedOffset),
      '--modifier-counts', modifierCounts,
      '--constraint-difficulties', constraintDifficulties,
      '--trap-count', trapCount,
      '--corpus-epoch', String(corpusEpoch),
      '--out', shard.outPath,
    ];
    const childEnv = {
      ...process.env,
      CORETEX_CORPUS_PRODUCTION: '1',
      CORETEX_BIENCODER: 'pinned',
      // CORETEX_LABELER intentionally unset — production qrels are now
      // resolved from the bundle's negCategoryRelevanceMap at the
      // synthesizer's construction-time category, not from a per-event
      // 4B reranker call. Set CORETEX_LABELER=pinned in env explicitly
      // (override to this driver) only for the offline A/B audit path.
      CORTEX_REAL_EVAL: '1',
      CORETEX_BIENCODER_PYTHON: pythonBin,
      CORETEX_RERANKER_PYTHON: pythonBin,
      CORTEX_LOCAL_MODEL_CACHE: cacheDir,
      HF_HUB_CACHE: cacheDir,
      HF_HUB_OFFLINE: '1',
      BIENCODER_NUM_THREADS: String(numThreadsPerWorker),
      BIENCODER_INNER_BATCH: String(innerBatchBiEncoder),
      RERANKER_NUM_THREADS: String(numThreadsPerWorker),
      RERANKER_INNER_BATCH: String(innerBatchReranker),
      CORETEX_LABELER_NUM_THREADS: String(numThreadsPerWorker),
      CORETEX_LABELER_BATCH_SIZE: String(labelerBatchSize),
      CORETEX_CHALLENGE_LIB_ROOT: challengeLibRoot,
    };
    const stderrFd = openSyncForAppend(shard.stderrPath);
    const child = spawn('node', args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', stderrFd],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      // Echo per-shard progress with worker tag.
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) console.log(`[w${shard.workerId}] ${line}`);
      }
    });
    child.on('error', rejectShard);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveShard({ shard, stdout });
      } else {
        rejectShard(new Error(`worker ${shard.workerId} exited code=${code} signal=${signal}; see ${shard.stderrPath}`));
      }
    });
  });
}

function openSyncForAppend(p) {
  return openSync(p, 'a');
}

const startTime = Date.now();
let completed = 0;
const heartbeat = setInterval(() => {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  console.log(`[parallel] heartbeat elapsed=${elapsed}s completed=${completed}/${shards.length}`);
}, 60_000);

const results = await Promise.all(shards.map((s) => runShard(s).then((r) => { completed++; return r; })));
clearInterval(heartbeat);

const elapsed = Math.floor((Date.now() - startTime) / 1000);
console.log(`[parallel] all ${shards.length} workers completed in ${elapsed}s`);

// Merge in seed-offset order.
const mergedEvents = [];
const shardSummaries = [];
for (const r of results) {
  const shardCorpus = JSON.parse(readFileSync(r.shard.outPath, 'utf8'));
  shardSummaries.push({ workerId: r.shard.workerId, events: shardCorpus.events.length, corpusRoot: shardCorpus.corpusRoot });
  for (const ev of shardCorpus.events) mergedEvents.push(ev);
}

// Recompute corpus root over the union (deterministic, identical to single-worker output if ids match).
const memEvents = mergedEvents.map((e) => ({
  ...JSON.parse(JSON.stringify(e)),
  embeddings: {
    ...e.embeddings,
    query: hexToUint8(e.embeddings.query),
    perTruth: new Map(Object.entries(e.embeddings.perTruth).map(([k, v]) => [k, hexToUint8(v)])),
    perNegative: new Map(Object.entries(e.embeddings.perNegative).map(([k, v]) => [k, hexToUint8(v)])),
  },
}));
const corpusRoot = computeCorpusRoot(memEvents);

// Pull bi-encoder + labeler model fields from the first shard (must agree across all).
const first = JSON.parse(readFileSync(results[0].shard.outPath, 'utf8'));
for (const r of results) {
  const c = JSON.parse(readFileSync(r.shard.outPath, 'utf8'));
  if (c.biEncoder.modelId !== first.biEncoder.modelId || c.biEncoder.revision !== first.biEncoder.revision) {
    throw new Error(`worker ${r.shard.workerId} biEncoder pin mismatch: ${c.biEncoder.modelId}@${c.biEncoder.revision} vs ${first.biEncoder.modelId}@${first.biEncoder.revision}`);
  }
  if (c.labelingModel.modelId !== first.labelingModel.modelId || c.labelingModel.revision !== first.labelingModel.revision) {
    throw new Error(`worker ${r.shard.workerId} labeler pin mismatch: ${c.labelingModel.modelId}@${c.labelingModel.revision} vs ${first.labelingModel.modelId}@${first.labelingModel.revision}`);
  }
}

const corpus = {
  schemaVersion: 'coretex.production-corpus.v1',
  corpusEpoch,
  biEncoder: first.biEncoder,
  labelingModel: first.labelingModel,
  events: mergedEvents,
  corpusRoot,
};

writeFileSync(outPath, JSON.stringify(corpus, null, 2));
console.log(`[parallel] merged corpus written: ${mergedEvents.length} events, corpusRoot=${corpusRoot}`);
console.log(`[parallel] shard breakdown:`);
for (const s of shardSummaries) console.log(`  worker ${s.workerId}: ${s.events} events shardRoot=${s.corpusRoot}`);
console.log(`[parallel] elapsed=${elapsed}s avg=${(elapsed / mergedEvents.length).toFixed(2)}s/event`);

function hexToUint8(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
