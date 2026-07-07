/**
 * BMU P2 real-embedding certification lane driver (SHARED across families).
 *
 * Drives the CANONICAL production runners — scripts/bi_encoder_runner.py
 * (BGE-M3 dense, CLS pooling, L2 norm, int8 layout) and
 * packages/coretex/scripts/reranker_runner.py (Qwen3-Reranker chat-template,
 * sigmoid(logit yes − logit no)) — over a real-lane job emitted by
 * certify.mjs, and writes per-query score maps for the margin screen.
 *
 * Blank-substrate semantics (§13.2): with no substrate atoms there are no
 * admission or final bonuses, so
 *   preRankScore == biCosine  (cosine over the dequantized pinned layout)
 *   composite    == normalized reranker score (sigmoid ∈ [0,1])
 * which is exactly what this driver measures.
 *
 * RESOURCE DISCIPLINE (live prod host): CPU-only runners, thread cap via
 * --threads (default 3), run under `nice`. The reranker scores ONLY the
 * biCosine top-`rerankerInputTopK` candidates per query (the production cap
 * — docs outside the cap never reach the reranker in production either).
 *
 * Usage:
 *   node certify-real-lane.mjs --job <real-lane-job.json> --out <scores.json>
 *        [--python <bin>] [--threads 3] [--skip-reranker]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const BIENCODER_RUNNER = resolve(repoRoot, 'scripts/bi_encoder_runner.py');
const RERANKER_RUNNER = resolve(repoRoot, 'packages/coretex/scripts/reranker_runner.py');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const jobPath = opt('--job');
const outPath = opt('--out');
const pythonBin = opt('--python', 'python3');
const threads = String(Number(opt('--threads', '3')));
const skipReranker = args.includes('--skip-reranker');
if (!jobPath || !outPath) { console.error('usage: certify-real-lane.mjs --job <job.json> --out <scores.json> [--python bin] [--threads n] [--skip-reranker]'); process.exit(1); }

const job = JSON.parse(readFileSync(jobPath, 'utf8'));
if (job.schema !== 'coretex.bmu-p2-real-lane-job.v1') { console.error(`unexpected job schema ${job.schema}`); process.exit(1); }
const { pins } = job;

function runPy(scriptPath, payload, env, label) {
  const t0 = Date.now();
  const res = spawnSync('nice', ['-n', '15', pythonBin, scriptPath], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256,
  });
  if (res.status !== 0) {
    console.error(`${label} FAILED (exit ${res.status}):\n${(res.stderr ?? '').slice(-4000)}`);
    process.exit(1);
  }
  const lines = res.stdout.trim().split('\n');
  const out = JSON.parse(lines[lines.length - 1]);
  console.error(`${label}: ${Date.now() - t0} ms`);
  return { out, wallMs: Date.now() - t0 };
}

// ─── Stage 1: BGE-M3 embeddings (queries + full doc pool, one process) ──────
const texts = [...job.queries.map((q) => q.text), ...job.docs.map((d) => d.text)];
const { out: encOut, wallMs: encMs } = runPy(
  BIENCODER_RUNNER,
  {
    modelId: pins.biencoder.modelId,
    revision: pins.biencoder.revision,
    layout: pins.biencoder.layout,
    inputs: texts.map((text) => ({ text })),
  },
  {
    CORETEX_BIENCODER_DEVICE: 'cpu',
    BIENCODER_NUM_THREADS: threads,
    OMP_NUM_THREADS: threads,
  },
  `bi-encoder (${texts.length} texts)`,
);

/** Dequantize the production int8 layout: 4-byte BE fp32 scale + dim int8. */
function dequantInt8(hex, dim) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 4 + dim) throw new Error(`int8 embedding: expected ${4 + dim} bytes, got ${buf.length}`);
  const scale = buf.readFloatBE(0);
  const v = new Float64Array(dim);
  for (let i = 0; i < dim; i++) v[i] = buf.readInt8(4 + i) * scale;
  return v;
}
function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

const dim = pins.biencoder.layout.dim;
const vecs = encOut.embeddings.map((hexStr) => dequantInt8(hexStr, dim));
const qVecs = vecs.slice(0, job.queries.length);
const dVecs = vecs.slice(job.queries.length);

const perQuery = job.queries.map((q, qi) => {
  const cosineBy = {};
  for (let di = 0; di < job.docs.length; di++) cosineBy[job.docs[di].id] = cosine(qVecs[qi], dVecs[di]);
  return { id: q.id, cosine: cosineBy, rerank: {} };
});

// ─── Stage 2: Qwen reranker over the top-`rerankerInputTopK` cap only ───────
let rerankMs = null;
let rerankPairs = 0;
if (!skipReranker) {
  const pairs = [];
  const owners = [];
  for (let qi = 0; qi < job.queries.length; qi++) {
    const ranked = Object.entries(perQuery[qi].cosine)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, pins.rerankerInputTopK);
    for (const [docId] of ranked) {
      pairs.push({ query: job.queries[qi].text, document: job.docs.find((d) => d.id === docId).text });
      owners.push({ qi, docId });
    }
  }
  rerankPairs = pairs.length;
  const { out: rrOut, wallMs } = runPy(
    RERANKER_RUNNER,
    { model: pins.reranker.modelId, revision: pins.reranker.revision, pairs },
    {
      RERANKER_NUM_THREADS: threads,
      OMP_NUM_THREADS: threads,
      RERANKER_MAX_SEQ_LEN: '512',
    },
    `reranker (${pairs.length} pairs)`,
  );
  rerankMs = wallMs;
  rrOut.scores.forEach((score, i) => { perQuery[owners[i].qi].rerank[owners[i].docId] = score; });
}

// Runtime fingerprint (transformers 5.x vs the 4.55.0 calibration pin is a
// KNOWN caveat — certification measures hardness, not calibration parity).
const fp = spawnSync(pythonBin, ['-c', 'import sys,torch,transformers;print(sys.version.split()[0], torch.__version__, transformers.__version__)'], { encoding: 'utf8' });

writeFileSync(outPath, JSON.stringify({
  schema: 'coretex.bmu-p2-real-lane-scores.v1',
  family: job.family,
  jobClusters: job.clusters,
  pins,
  perQuery,
  runtime: {
    pythonStack: (fp.stdout ?? '').trim(),
    threads: Number(threads),
    biencoderWallMs: encMs,
    rerankerWallMs: rerankMs,
    rerankerPairs: rerankPairs,
    rerankerCapPerQuery: skipReranker ? 0 : pins.rerankerInputTopK,
    note: 'CPU-only canonical runners; blank-substrate semantics (§13.2): preRank==biCosine, composite==sigmoid reranker score',
  },
}, null, 1) + '\n');
console.log(`wrote ${outPath}`);
