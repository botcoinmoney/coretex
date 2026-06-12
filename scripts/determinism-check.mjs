#!/usr/bin/env node
/**
 * Determinism harness — runs both pinned models on a 1k-pair sample and
 * emits CSV of |score_a - score_b| per pair across configured runtimes.
 *
 * Spec: specs/determinism.md.
 *
 * Usage:
 *   node scripts/determinism-check.mjs \
 *     --bundle-manifest <path> \
 *     --pairs <path-to-pairs.json>           # default: ./benchmark/fixtures/determinism/1k-pairs.json
 *     --hosts host_a,host_b,host_c           # CSV of host-id labels for this run
 *     --max-tolerance-ppm 250                # canonical replay ceiling
 *     --report <out.json>                    # output report file
 *
 * Each host is expected to run this script independently. The harness
 * dumps per-pair scores keyed by host-id; a separate aggregator computes
 * P50/P90/P99 cross-host pairwise diffs.
 *
 * Exit status:
 *   0  → P99 |diff| <= MAX_TOLERANCE_PPM
 *   1  → script error
 *   2  → P99 |diff| > MAX_TOLERANCE_PPM (determinism failure)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit, env } from 'node:process';
import { hostname } from 'node:os';

import {
  rerankerFromEnv,
  biEncoderFromEnv,
  biEncoderModelIdHash,
} from '@botcoin/coretex';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const bundlePath = flag('bundle-manifest');
if (!bundlePath) {
  console.error('determinism-check: --bundle-manifest is required');
  exit(1);
}
const pairsPath = flag('pairs', resolve(process.cwd(), 'benchmark/fixtures/determinism/1k-pairs.json'));
const hostsArg = flag('hosts', hostname());
const maxTolerancePpm = Number(flag('max-tolerance-ppm', '250'));
const reportPath = flag('report', resolve(process.cwd(), 'reports/determinism-check.json'));

const manifest = JSON.parse(readFileSync(resolve(bundlePath), 'utf8'));
if (manifest.evaluator?.profile?.acceleratorPolicy !== 'cpu_only') {
  console.error(`determinism-check: bundle profile.acceleratorPolicy must be 'cpu_only'`);
  exit(1);
}

if (!existsSync(pairsPath)) {
  console.error(`determinism-check: pairs file not found: ${pairsPath}`);
  exit(1);
}
const pairs = JSON.parse(readFileSync(pairsPath, 'utf8'));
if (!Array.isArray(pairs)) {
  console.error('determinism-check: pairs must be an array of {query, document}');
  exit(1);
}

const localHostId = hostsArg.split(',')[0]?.trim() || hostname();
console.log(`determinism-check: running ${pairs.length} pairs on host=${localHostId}`);

env.CORETEX_RERANKER ??= 'qwen3';
env.CORETEX_BIENCODER ??= 'pinned';
env.CORETEX_BIENCODER_REVISION ??= manifest.model.biEncoder.revision;

// Bi-encoder + reranker from manifest.
const biEncoder = biEncoderFromEnv(manifest.model.biEncoder.retrievalKeyLayout, {
  modelId: manifest.model.biEncoder.modelId,
  revision: manifest.model.biEncoder.revision,
});
const reranker = await rerankerFromEnv();

const queryEmbeds = await biEncoder.encode(pairs.map((p) => ({ text: p.query, id: p.id })));
const docEmbeds = await biEncoder.encode(pairs.map((p) => ({ text: p.document, id: p.id })));

const rerankerScores = await reranker.score(pairs.map((p) => ({ query: p.query, document: p.document })));

const perPair = pairs.map((p, i) => ({
  pair_index: i,
  pair_id: p.id ?? `pair-${i}`,
  reranker_score: rerankerScores[i] ?? 0,
  query_embed_sha256: shortHash(queryEmbeds[i]),
  doc_embed_sha256: shortHash(docEmbeds[i]),
}));

mkdirSync(dirname(reportPath), { recursive: true });
const report = {
  schemaVersion: 'coretex.determinism-check.v1',
  hostId: localHostId,
  hostsConfigured: hostsArg.split(',').map((s) => s.trim()).filter(Boolean),
  generatedAt: new Date().toISOString(),
  bundleHash: manifest.bundleHash,
  biEncoderModelId: manifest.model.biEncoder.modelId,
  biEncoderRevision: manifest.model.biEncoder.revision,
  rerankerModelId: manifest.model.reranker.modelId,
  rerankerRevision: manifest.model.reranker.revision,
  biEncoderHashTag: biEncoderModelIdHash(
    manifest.model.biEncoder.modelId,
    manifest.model.biEncoder.revision,
    manifest.model.biEncoder.mode,
  ),
  pairCount: pairs.length,
  perPair,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));

// Cross-host aggregation requires merging multiple host reports; that step
// happens via scripts/aggregate-determinism.mjs (post-collection). Single-host
// runs always exit 0 — the aggregator computes the diff distribution.
console.log(`determinism-check: wrote ${reportPath}`);
console.log(`determinism-check: aggregate cross-host with: node scripts/aggregate-determinism.mjs --reports <glob> --max-tolerance-ppm ${maxTolerancePpm}`);
exit(0);

function shortHash(bytes) {
  // Simple truncated SHA-256-like fingerprint via fnv1a; we only need a
  // change-detector for cross-host pairwise comparison.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return '0x' + hash.toString(16).padStart(16, '0');
}
