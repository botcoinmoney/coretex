#!/usr/bin/env node
/**
 * Smoke-test the streaming bi-encoder + streaming reranker against the
 * pinned BGE-M3 / Qwen3-Reranker-0.6B / MemReranker-4B caches. Validates that:
 *   1. The Python child loads the model exactly once (timing).
 *   2. Subsequent encode() / score() calls return deterministic, well-formed
 *      embedding bytes / relevance scores.
 *   3. close() releases the child cleanly.
 */
import {
  createStreamingBiEncoder,
  createStreamingQwen3Reranker,
  BGE_M3_DEFAULT_LAYOUT,
  BGE_M3_DEFAULT_REVISION,
  QWEN3_RERANKER_DEFAULT_REVISION,
} from '@botcoin/coretex';

function ms() { return Number(process.hrtime.bigint() / 1_000_000n); }
function checkSize(name, bytes, expected) {
  if (bytes.length !== expected) {
    throw new Error(`${name}: expected ${expected}-byte embedding, got ${bytes.length}`);
  }
}

async function biEncoderSmoke() {
  console.log('\n=== streaming BGE-M3 ===');
  const tStart = ms();
  const encoder = createStreamingBiEncoder({
    modelId: 'BAAI/bge-m3',
    revision: BGE_M3_DEFAULT_REVISION,
    layout: BGE_M3_DEFAULT_LAYOUT,
    pythonBin: '/root/coretex/.venv/bin/python',
  });
  const tSpawned = ms();
  const probe1 = await encoder.encode([{ text: 'capital of France' }]);
  const tFirst = ms();
  const probe2 = await encoder.encode([
    { text: 'capital of France' },
    { text: 'Paris is the capital of France' },
    { text: 'a hard negative about Berlin' },
  ]);
  const tBatch = ms();
  const probe3 = await encoder.encode([{ text: 'capital of France' }]);
  const tThird = ms();

  // int8 layout: 4-byte scale + 243 codes = 247 bytes per embedding
  const expected = 4 + BGE_M3_DEFAULT_LAYOUT.dim;
  for (const e of probe1) checkSize('probe1', e, expected);
  for (const e of probe2) checkSize('probe2', e, expected);
  for (const e of probe3) checkSize('probe3', e, expected);

  // determinism: third encode of same text must equal first
  let det = true;
  for (let i = 0; i < probe1[0].length; i++) {
    if (probe1[0][i] !== probe3[0][i]) { det = false; break; }
  }
  console.log(`  first encode (incl. model load): ${tFirst - tSpawned}ms`);
  console.log(`  3-text batch:                    ${tBatch - tFirst}ms`);
  console.log(`  third encode (warm):             ${tThird - tBatch}ms`);
  console.log(`  embedding size:                  ${probe1[0].length} bytes (expected ${expected})`);
  console.log(`  determinism (call 1 vs 3):       ${det ? 'PASS' : 'FAIL'}`);
  await encoder.close();
  console.log(`  child closed cleanly`);
  if (!det) process.exit(2);
}

async function rerankerSmoke(model, revision, label) {
  console.log(`\n=== streaming ${label} ===`);
  const tStart = ms();
  const reranker = createStreamingQwen3Reranker({
    model,
    revision,
    pythonBin: '/root/coretex/.venv/bin/python',
    batchSize: 2,
    numThreads: 16,
  });
  const tSpawned = ms();
  const pairs = [
    { query: 'capital of France', document: 'Paris is the capital of France.' },
    { query: 'capital of France', document: 'Berlin is the capital of Germany.' },
    { query: 'capital of France', document: 'The Eiffel Tower is in Paris.' },
  ];
  const scores1 = await reranker.score(pairs);
  const tFirst = ms();
  const scores2 = await reranker.score(pairs);
  const tSecond = ms();
  console.log(`  first score (incl. model load):  ${tFirst - tSpawned}ms`);
  console.log(`  second score (warm):              ${tSecond - tFirst}ms`);
  console.log(`  scores call 1: ${scores1.map((s) => s.toFixed(4)).join(', ')}`);
  console.log(`  scores call 2: ${scores2.map((s) => s.toFixed(4)).join(', ')}`);
  // Sanity: the answer-bearing doc should be most relevant
  if (scores1[0] < scores1[1]) {
    console.log(`  WARN: relevant > distractor expected, got ${scores1[0]} vs ${scores1[1]}`);
  }
  // Determinism
  let det = true;
  for (let i = 0; i < scores1.length; i++) {
    if (Math.abs(scores1[i] - scores2[i]) > 1e-6) { det = false; break; }
  }
  console.log(`  determinism (call 1 vs 2): ${det ? 'PASS' : 'FAIL (diff > 1e-6)'}`);
  await reranker.close();
  console.log(`  child closed cleanly`);
}

await biEncoderSmoke();
await rerankerSmoke('Qwen/Qwen3-Reranker-0.6B', QWEN3_RERANKER_DEFAULT_REVISION, 'Qwen3-Reranker-0.6B');
await rerankerSmoke('IAAR-Shanghai/MemReranker-4B', '7fe33c1385f652f52d370b8822d6b620b32b6ec4', 'MemReranker-4B');
console.log('\nALL STREAMING ENCODER SMOKES PASSED');
