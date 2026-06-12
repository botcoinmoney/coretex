#!/usr/bin/env node
/**
 * Resumable, checkpointed BGE-M3 embedder for Memory Corpus V2.
 *
 * Replaces the monolithic `embed-corpus-v2-incremental.mjs` for large corpora (100k/300k).
 * That script calls one giant `embedTexts([...all])` and writes ONLY at completion — any
 * instance death (vast box termination, host crash, network drop) loses everything.
 *
 * This script:
 *   - reuses the persistent `bi_encoder_runner.py --stream` (model loads once, processes
 *     per-chunk requests, never reloads between chunks);
 *   - reads an existing checkpoint if present and SKIPS doc/query IDs already embedded
 *     (resumable across reruns);
 *   - embeds in chunks (default 2048; tunable via `--chunk-size`);
 *   - writes the checkpoint atomically after EVERY chunk (tmp → rename) so the worst-case
 *     loss is a single chunk, not the entire run;
 *   - emits the same on-disk cache format (`{ specVersion, phase, dim, biEncoder, docs, queries }`)
 *     that `embed-corpus-v2-incremental.mjs` and `lib/build-v2-production-corpus.mjs` consume;
 *   - logs completed/remaining/rate every chunk so wall-clock progress is observable.
 *
 * Usage:
 *   node scripts/embed-corpus-v2-resumable.mjs <newCorpus> <outCache> \
 *     [--checkpoint <path>] [--chunk-size 2048] [--threads N]
 *
 *   - Default checkpoint path is `<outCache>.partial.json`.
 *   - Threads honor `BIENCODER_NUM_THREADS` env (default 8, tuned for BGE-M3 CPU + ≥16-core hosts).
 *   - Inner-batch honors `BIENCODER_INNER_BATCH` (default 64).
 *
 * Recommended local invocation (Ryzen 9 7950X / 32-thread / 124 GiB RAM):
 *   export CORETEX_BIENCODER_PYTHON=/root/coretex/.venv/bin/python
 *   export CORTEX_LOCAL_MODEL_CACHE=/var/lib/coretex/model-cache
 *   export HF_HUB_OFFLINE=1
 *   export BIENCODER_NUM_THREADS=8
 *   export BIENCODER_INNER_BATCH=64
 *   node scripts/embed-corpus-v2-resumable.mjs \
 *     release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-100k-corpus.json \
 *     release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-100k-embeddings.json \
 *     --chunk-size 2048
 *
 * Operator notes:
 *   - The streaming runner emits one JSON line per chunk request (`{ id, embeddings: [...] }`).
 *     We send one chunk at a time and await its response before sending the next; this matches
 *     the runner's request-loop semantics and avoids head-of-line blocking.
 *   - Checkpoint format is the SAME schema as the final cache, so a checkpoint can be loaded
 *     as-is by `build-v2-production-corpus.mjs` if you ever need to consume a partial.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { argv, exit } from 'node:process';

import { repoRoot } from './_repo-root.mjs';

const MANIFEST = resolve(repoRoot, 'release/bundle/bundle-manifest-v2-ownerscope-candidate.json');
const CACHE_DIR = process.env.CORTEX_LOCAL_MODEL_CACHE ?? '/var/lib/coretex/model-cache';
const PYTHON = process.env.CORETEX_BIENCODER_PYTHON ?? resolve(repoRoot, '.venv/bin/python');

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb;
}

function fail(msg) { process.stderr.write(`[resumable-embed] ABORT: ${msg}\n`); exit(2); }
function info(msg) { process.stderr.write(`[resumable-embed] ${msg}\n`); }

// ── CLI ─────────────────────────────────────────────────────────────────────
const newPath = argv[2];
const outPath = argv[3];
if (!newPath || !outPath) {
  fail('usage: embed-corpus-v2-resumable.mjs <newCorpus> <outCache> [--checkpoint p] [--chunk-size 2048]');
}
const checkpointPath = flag('checkpoint', `${outPath}.partial.json`);
const chunkSize = Math.max(1, Number(flag('chunk-size', '2048')));
const cliThreads = flag('threads', null);

// ── Load manifest + corpus ──────────────────────────────────────────────────
if (!existsSync(MANIFEST)) fail(`bundle manifest not found: ${MANIFEST}`);
if (!existsSync(newPath)) fail(`corpus not found: ${newPath}`);

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const be = manifest.model.biEncoder;
const layout = {
  dim: be.retrievalKeyLayout.dim,
  quantization: be.retrievalKeyLayout.quantization,
};

info(`Loading corpus ${newPath} (${(statSync(newPath).size / 1e6).toFixed(1)} MB)`);
const corpus = JSON.parse(readFileSync(newPath, 'utf8'));
const docs = corpus.docs ?? [];
const queries = corpus.queries ?? [];
info(`corpus: docs=${docs.length} queries=${queries.length}`);

// ── Work queue ──────────────────────────────────────────────────────────────
const items = [];
for (const d of docs) items.push({ kind: 'doc', id: d.id, text: d.text ?? '' });
for (const q of queries) items.push({ kind: 'q', id: q.id, text: q.queryText ?? '' });

// ── Checkpoint ──────────────────────────────────────────────────────────────
let cache = {
  specVersion: corpus.specVersion,
  phase: corpus.phase,
  dim: layout.dim,
  biEncoder: 'BAAI/bge-m3 int8/243 (pinned)',
  docs: {},
  queries: {},
};
if (existsSync(checkpointPath)) {
  try {
    const ck = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    if (ck.docs && ck.queries) {
      cache = { ...cache, ...ck, docs: { ...ck.docs }, queries: { ...ck.queries } };
      info(`Resumed checkpoint ${checkpointPath}: docs=${Object.keys(cache.docs).length} queries=${Object.keys(cache.queries).length}`);
    }
  } catch (e) {
    info(`WARN: checkpoint ${checkpointPath} unreadable (${e.message}); starting fresh`);
  }
}

// Filter out already-embedded IDs (resume semantics).
const todo = items.filter((it) => (it.kind === 'doc' ? !cache.docs[it.id] : !cache.queries[it.id]));
const initialDone = items.length - todo.length;
info(`work: total=${items.length} done=${initialDone} todo=${todo.length} chunkSize=${chunkSize}`);
if (todo.length === 0) {
  info('Nothing to embed; finalizing.');
  finalize(cache, checkpointPath, outPath);
  exit(0);
}

// ── Spawn streaming runner ──────────────────────────────────────────────────
const envThreads = cliThreads ?? process.env.BIENCODER_NUM_THREADS ?? '8';
const innerBatch = process.env.BIENCODER_INNER_BATCH ?? '64';
info(`Spawning bi_encoder_runner --stream (threads=${envThreads}, innerBatch=${innerBatch}, model=${be.modelId}@${be.revision})`);

const proc = spawn(PYTHON, [resolve(repoRoot, 'scripts/bi_encoder_runner.py'), '--stream'], {
  env: {
    ...process.env,
    HF_HUB_CACHE: CACHE_DIR,
    HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1',
    CUDA_VISIBLE_DEVICES: '',
    BIENCODER_NUM_THREADS: String(envThreads),
    BIENCODER_INNER_BATCH: innerBatch,
    CORETEX_BIENCODER_STREAM_MODEL_ID: be.modelId,
    CORETEX_BIENCODER_STREAM_REVISION: be.revision,
    CORETEX_BIENCODER_STREAM_LAYOUT_JSON: JSON.stringify(layout),
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

// readiness handshake + per-correlation-id response queue.
let ready = false;
const pending = new Map();   // corr-id → { resolve, reject }

rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.ready) { ready = true; return; }
  const id = m.id;
  if (id == null) return;
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (m.error) entry.reject(new Error(m.error));
  else entry.resolve(m.embeddings);
});

proc.on('error', (e) => fail(`runner spawn error: ${e.message}`));
proc.on('exit', (code) => {
  if (code !== 0 && pending.size > 0) {
    for (const [, p] of pending) p.reject(new Error(`runner exited ${code}`));
  }
});

function sendChunk(corrId, texts) {
  return new Promise((resolveP, rejectP) => {
    pending.set(corrId, { resolve: resolveP, reject: rejectP });
    proc.stdin.write(JSON.stringify({ id: corrId, inputs: texts.map((t) => ({ text: t })) }) + '\n');
  });
}

// Wait for readiness.
const t0 = Date.now();
while (!ready) {
  await new Promise((r) => setTimeout(r, 50));
  if (Date.now() - t0 > 5 * 60_000) fail('runner did not become ready within 5 min');
}
info(`runner ready in ${((Date.now() - t0) / 1000).toFixed(1)}s; embedding ${todo.length} texts in chunks of ${chunkSize}`);

// ── Drive chunks sequentially ───────────────────────────────────────────────
const decodeHexToFloat32 = (hex, dim) => {
  const buf = Buffer.from(hex, 'hex');
  const scale = buf.readFloatBE(0);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    let v = buf[4 + i];
    if (v > 127) v -= 256;
    out[i] = v * scale;
  }
  return out;
};
const toB64 = (vec) => Buffer.from(new Float32Array(vec).buffer).toString('base64');

const tStart = Date.now();
let totalDone = 0;
const chunkCount = Math.ceil(todo.length / chunkSize);

for (let c = 0; c < chunkCount; c++) {
  const chunk = todo.slice(c * chunkSize, (c + 1) * chunkSize);
  const tChunk = Date.now();
  let embeddings;
  try {
    embeddings = await sendChunk(`c${c}`, chunk.map((x) => x.text));
  } catch (e) {
    fail(`chunk ${c + 1}/${chunkCount} failed: ${e.message}`);
  }
  if (!Array.isArray(embeddings) || embeddings.length !== chunk.length) {
    fail(`chunk ${c + 1} returned ${embeddings?.length} embeddings; expected ${chunk.length}`);
  }
  for (let j = 0; j < chunk.length; j++) {
    const vec = decodeHexToFloat32(embeddings[j], layout.dim);
    const b64 = toB64(vec);
    if (chunk[j].kind === 'doc') cache.docs[chunk[j].id] = b64;
    else cache.queries[chunk[j].id] = b64;
  }
  totalDone += chunk.length;

  // Atomic checkpoint: tmp → rename.
  const tmpPath = `${checkpointPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cache));
  renameSync(tmpPath, checkpointPath);

  const chunkSec = (Date.now() - tChunk) / 1000;
  const totalSec = (Date.now() - tStart) / 1000;
  const rate = totalDone / totalSec;
  const remaining = todo.length - totalDone;
  const etaMin = remaining / rate / 60;
  info(`chunk ${c + 1}/${chunkCount}: +${chunk.length} in ${chunkSec.toFixed(1)}s | done ${totalDone}/${todo.length} | rate ${rate.toFixed(1)} t/s | eta ${etaMin.toFixed(1)} min | cp ${checkpointPath}`);
}

// ── Finalize ────────────────────────────────────────────────────────────────
try { proc.stdin.end(); } catch {}
finalize(cache, checkpointPath, outPath);
info(`DONE: docs=${Object.keys(cache.docs).length} queries=${Object.keys(cache.queries).length} dim=${cache.dim} in ${((Date.now() - tStart) / 60_000).toFixed(1)} min`);
exit(0);

function finalize(cache_, cpPath, finalPath) {
  // Write final cache atomically too, then drop the checkpoint.
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cache_));
  renameSync(tmpPath, finalPath);
  // Keep checkpoint until final is on disk, then remove it.
  try { if (existsSync(cpPath)) unlinkSync(cpPath); } catch {}
}
