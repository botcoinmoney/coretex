#!/usr/bin/env node
/**
 * Throughput benchmark for the streaming bi-encoder + reranker against
 * the pinned MemReranker-4B / BGE-M3 caches. Sweeps thread counts and
 * batch sizes to locate the actual CPU bottleneck (compute, memory
 * bandwidth, or Python round-trip) so the launch corpus parallelism can
 * be tuned with real numbers, not guesses.
 *
 * Each cell runs:
 *   - one streaming child with N threads
 *   - one warm-up batch (model load is excluded from rate)
 *   - K timed batches of B prompts each (K × B = TARGET pair count)
 * Prints rate (pair/s) per (threads, batchSize).
 *
 * Usage:
 *   node scripts/benchmark-encoders.mjs --component reranker --target 64
 *   node scripts/benchmark-encoders.mjs --component biencoder --target 256
 */
import {
  createStreamingBiEncoder,
  createStreamingQwen3Reranker,
  BGE_M3_DEFAULT_LAYOUT,
  BGE_M3_DEFAULT_REVISION,
} from '@botcoin/cortex';
import { argv } from 'node:process';

const MEMRERANKER_REVISION = '7fe33c1385f652f52d370b8822d6b620b32b6ec4';
const PYTHON = '/root/cortex/.venv/bin/python';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}
const component = flag('component', 'reranker');
const target = Number(flag('target', '64'));

function makePrompts(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      query: `What is the capital of country ${i % 50}?`,
      document: `The capital of country ${i % 50} has historical significance dating back centuries; it sits on a major river and is known for the great library of ${i}.`,
    });
  }
  return out;
}

function makeTexts(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ text: `Capital city number ${i}: this paragraph describes how it became one of the major centers of learning during the era of expansion.` });
  }
  return out;
}

async function benchOneReranker(threads, batchSize) {
  process.env.RERANKER_NUM_THREADS = String(threads);
  process.env.RERANKER_INNER_BATCH = String(batchSize);
  const reranker = createStreamingQwen3Reranker({
    model: 'IAAR-Shanghai/MemReranker-4B',
    revision: MEMRERANKER_REVISION,
    pythonBin: PYTHON,
    batchSize,
    numThreads: threads,
  });
  // warm up
  await reranker.score(makePrompts(batchSize));
  const start = Date.now();
  // K iterations to reach target
  let processed = 0;
  while (processed < target) {
    const remaining = Math.min(batchSize, target - processed);
    await reranker.score(makePrompts(remaining));
    processed += remaining;
  }
  const elapsed = (Date.now() - start) / 1000;
  await reranker.close();
  const rate = processed / elapsed;
  return { threads, batchSize, processed, elapsed, rate };
}

async function benchOneBiEncoder(threads, batchSize) {
  process.env.BIENCODER_NUM_THREADS = String(threads);
  process.env.BIENCODER_INNER_BATCH = String(batchSize);
  const enc = createStreamingBiEncoder({
    modelId: 'BAAI/bge-m3',
    revision: BGE_M3_DEFAULT_REVISION,
    layout: BGE_M3_DEFAULT_LAYOUT,
    pythonBin: PYTHON,
  });
  await enc.encode(makeTexts(batchSize));
  const start = Date.now();
  let processed = 0;
  while (processed < target) {
    const remaining = Math.min(batchSize, target - processed);
    await enc.encode(makeTexts(remaining));
    processed += remaining;
  }
  const elapsed = (Date.now() - start) / 1000;
  await enc.close();
  const rate = processed / elapsed;
  return { threads, batchSize, processed, elapsed, rate };
}

const grid = component === 'reranker'
  ? [
      [4, 4],
      [8, 8],
      [16, 8],
      [32, 8],
      [16, 16],
      [16, 32],
    ]
  : [
      [4, 16],
      [8, 16],
      [16, 16],
      [32, 16],
      [16, 32],
      [16, 64],
    ];

console.log(`benchmarking ${component}, target=${target} pairs/texts per cell`);
console.log('  threads, batchSize, processed, elapsed_s, rate_per_s');
for (const [t, b] of grid) {
  const fn = component === 'reranker' ? benchOneReranker : benchOneBiEncoder;
  const r = await fn(t, b);
  console.log(`  ${r.threads.toString().padStart(2)}      ${r.batchSize.toString().padStart(2)}        ${r.processed.toString().padStart(4)}        ${r.elapsed.toFixed(2)}      ${r.rate.toFixed(2)}`);
}
console.log('done');
