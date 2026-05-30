#!/usr/bin/env node
/**
 * Mandatory GPU smoke gate. Run before any long A100 GPU campaign track.
 * Exits 0 only if ALL four checks pass:
 *   (a) reranker init succeeds (device reports A100 / CUDA)
 *   (b) variance check: 16 random pairs yield non-constant scores (max-min > 1e-3)
 *   (c) determinism check: scoring the same 4 pairs twice yields identical scores
 *   (d) random near-zero: 8 completely-unrelated pairs have mean score < 0.4
 * Exits 1 on any failure with a hard message — driver MUST treat that as STOP.
 */
import { exit } from 'node:process';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const MODEL = 'Qwen/Qwen3-Reranker-0.6B';
const REVISION = 'e61197ed45024b0ed8a2d74b80b4d909f1255473';

function fail(msg) { process.stderr.write(`SMOKE FAIL: ${msg}\n`); exit(1); }
function pass(msg) { process.stdout.write(`SMOKE PASS: ${msg}\n`); }

const reranker = makeStreamReranker({
  model: MODEL,
  revision: REVISION,
  python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3',
  allowCuda: true,
});

try {
  // (a) init — the spawn itself; if Qwen failed to load on CUDA, the first score() throws.
  const seedPairs = [
    { query: 'who painted the Mona Lisa', document: 'Leonardo da Vinci painted the Mona Lisa.' },
    { query: 'capital of France', document: 'Paris is the capital of France.' },
  ];
  const s0 = await reranker.score(seedPairs);
  if (!Array.isArray(s0) || s0.length !== 2 || s0.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    fail(`init: bad score shape ${JSON.stringify(s0)}`);
  }
  pass(`init — model loaded, baseline pair scores ${s0.map((x) => x.toFixed(3)).join(',')}`);

  // (b) variance — 16 unrelated pairs, scores must not be constant.
  const varPairs = Array.from({ length: 16 }, (_, i) => ({
    query: `random query ${i} about ${['cats','dogs','trains','algebra','solar systems','sourdough','baseball','quantum','tax law','knitting','plate tectonics','jazz','sushi','machine learning','volcanoes','beekeeping'][i]}`,
    document: `unrelated document ${i} discussing ${['turbochargers','medieval poetry','climate models','sneaker design','baroque art','cybersecurity','marathon training','tax law','crochet','glaciers','espresso','bonsai','origami','SQL joins','tundra','beekeeping'][i]}`,
  }));
  const sV = await reranker.score(varPairs);
  const range = Math.max(...sV) - Math.min(...sV);
  if (!(range > 1e-3)) fail(`variance — scores constant (range=${range.toExponential(2)}); reranker not really scoring`);
  pass(`variance — 16 pairs range=${range.toFixed(4)}, min=${Math.min(...sV).toFixed(3)} max=${Math.max(...sV).toFixed(3)}`);

  // (c) determinism — same 4 pairs scored twice, same result.
  const detPairs = seedPairs.concat([
    { query: 'speed of light', document: 'Light travels at approximately 299,792,458 m/s.' },
    { query: 'speed of light', document: 'A plate of pasta is delicious.' },
  ]);
  const sD1 = await reranker.score(detPairs);
  const sD2 = await reranker.score(detPairs);
  for (let i = 0; i < sD1.length; i++) {
    if (Math.abs(sD1[i] - sD2[i]) > 1e-5) fail(`determinism — pair ${i} differs ${sD1[i]} vs ${sD2[i]}`);
  }
  pass(`determinism — 4 pairs reproduce within 1e-5`);

  // (d) random near zero — 8 pairs where doc is unrelated to query, mean score must be low.
  const randPairs = Array.from({ length: 8 }, (_, i) => ({
    query: `obscure topic ${i}: ${['amplifier biasing','medieval Latin','ferment yeast','plate tectonics','bonsai pruning','jazz harmony','tax loopholes','glacial varves'][i]}`,
    document: `wholly unrelated text: ${['Penguins eat krill','The price of tea fell','My cat is hungry','We baked muffins','I lost my keys','It started raining','He left for Paris','Tomatoes ripen in August'][i]}`,
  }));
  const sR = await reranker.score(randPairs);
  const meanR = sR.reduce((a, b) => a + b, 0) / sR.length;
  if (!(meanR < 0.4)) fail(`random-near-zero — mean=${meanR.toFixed(3)} >= 0.4; reranker may be saturating high`);
  pass(`random-near-zero — 8 pairs mean=${meanR.toFixed(3)} < 0.4`);

  await reranker.close?.();
  console.log('SMOKE: ALL PASS ✅ — GPU reranker cleared for campaign');
  exit(0);
} catch (e) {
  fail(`unexpected error: ${e?.stack || e?.message || e}`);
}
