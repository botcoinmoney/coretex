/**
 * Memory Corpus V2 — bi-encoder embedding helper (CPU, pinned BGE-M3).
 *
 * Wraps scripts/bi_encoder_runner.py (one-shot mode) with the bundle's pinned
 * bi-encoder + retrieval-key layout, so diagnostic dense vectors match the
 * production stage-1 retrieval key (int8, dim from the manifest). Returns
 * dequantized Float32 vectors (codes * per-vector scale); cosine over these
 * equals cosine over the int8 codes.
 *
 * Memory-bandwidth note: single worker, many threads (BIENCODER_NUM_THREADS).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { repoRoot } from './_repo-root.mjs';

const MANIFEST = resolve(repoRoot, 'release/bundle/bundle-manifest-v2-ownerscope-candidate.json');
const CACHE_DIR = process.env.CORTEX_LOCAL_MODEL_CACHE ?? '/var/lib/coretex/model-cache';
const PYTHON = process.env.CORETEX_BIENCODER_PYTHON ?? resolve(repoRoot, '.venv/bin/python');

function bundleBiEncoder() {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const be = m.model.biEncoder;
  return {
    modelId: be.modelId,
    revision: be.revision,
    layout: { dim: be.retrievalKeyLayout.dim, quantization: be.retrievalKeyLayout.quantization },
  };
}

function decodeHex(hex, dim) {
  const buf = Buffer.from(hex, 'hex');
  // int8 layout: 4-byte BE float32 scale, then `dim` int8 codes.
  const scale = buf.readFloatBE(0);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    let v = buf[4 + i];
    if (v > 127) v -= 256; // int8
    out[i] = v * scale;
  }
  return out;
}

/**
 * Embed an array of strings. Returns Float32Array[] (same order).
 * Single one-shot subprocess: model loads once, processes all inputs.
 */
export async function embedTexts(texts, { threads } = {}) {
  const be = bundleBiEncoder();
  // Honor BIENCODER_NUM_THREADS from the environment (was being silently overridden by cpus().length
  // which causes BLAS thread contention on big-core hosts — see the 7950X / Xeon Gold investigation).
  // Default to min(16, cpus().length) — BGE-M3 CPU scaling is sub-linear past ~16 threads.
  const envThreads = process.env.BIENCODER_NUM_THREADS ? Number(process.env.BIENCODER_NUM_THREADS) : null;
  const nThreads = String(threads ?? envThreads ?? Math.min(16, Math.max(1, cpus().length)));
  const payload = JSON.stringify({
    modelId: be.modelId, revision: be.revision, layout: be.layout,
    inputs: texts.map((t) => ({ text: t })),
  });
  return new Promise((res, rej) => {
    const proc = spawn(PYTHON, [resolve(repoRoot, 'scripts/bi_encoder_runner.py')], {
      env: {
        ...process.env,
        HF_HUB_CACHE: CACHE_DIR,
        HF_HUB_OFFLINE: '1',
        CUDA_VISIBLE_DEVICES: '',
        BIENCODER_NUM_THREADS: nThreads,
        BIENCODER_INNER_BATCH: process.env.BIENCODER_INNER_BATCH ?? '32',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', rej);
    proc.on('close', (code) => {
      if (code !== 0) return rej(new Error(`bi_encoder_runner exited ${code}`));
      let parsed;
      try { parsed = JSON.parse(out); } catch (e) { return rej(new Error(`bad runner output: ${e.message}: ${out.slice(0, 300)}`)); }
      if (parsed.error) return rej(new Error(`runner error: ${parsed.error}`));
      res(parsed.embeddings.map((h) => decodeHex(h, be.layout.dim)));
    });
    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export { bundleBiEncoder };
