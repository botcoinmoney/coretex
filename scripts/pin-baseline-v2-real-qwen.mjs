#!/usr/bin/env node
/**
 * Real-Qwen baseline pin for the V2 logical corpus path.
 *
 * pin-baseline-into-bundle.mjs is the canonical pin script but loads the legacy
 * ProductionCorpus JSON shape (events array). The 100k/300k r5-synth corpora are V2
 * LOGICAL (separate docs/queries arrays), consumed via `buildV2ProductionCorpus`.
 *
 * This script bridges: loads V2 corpus + embeddings, builds ProductionCorpus in memory,
 * derives the profile-pinned hidden query pack, runs evaluateBaseline against the empty
 * substrate (genesis) sampled `samples` times on real Qwen3-Reranker-0.6B via the
 * persistent --stream runner. Writes a baseline-pin JSON sidecar; does NOT mutate the
 * profile (operator regenerates the bundle from the pin manifest).
 *
 * Usage:
 *   CORETEX_RERANKER_PYTHON=/usr/bin/python3 CORETEX_RERANKER_ALLOW_CUDA=1 \
 *   HF_HUB_CACHE=/var/lib/coretex/model-cache HF_HUB_OFFLINE=1 \
 *   node scripts/pin-baseline-v2-real-qwen.mjs \
 *     --corpus release/.../dgen1-r5-synth-100k-corpus.json \
 *     --emb    release/.../dgen1-r5-synth-100k-embeddings.json \
 *     --profile release/bundle/evaluator-profile-v2-dgen1-policy-r5-100k.json \
 *     --samples 3 \
 *     --eval-seed-hex 0xa5a5...a5 \
 *     --out release/calibration/baseline-pin-100k.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';

import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const { evaluateBaseline, deriveQueryPack, scoringOptionsFromProfile } = await import(distIndex);

function flag(name, fb) { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; }

const corpusPath = flag('corpus');
const embPath = flag('emb');
const profilePath = flag('profile');
const samples = Number(flag('samples', '3'));
const epochId = Number(flag('epoch-id', '0'));
const defaultSeed = '0x' + 'a5'.repeat(32);
const evalSeedHex = flag('eval-seed-hex', defaultSeed);
const outPath = flag('out');

if (!corpusPath || !embPath || !profilePath || !outPath) {
  console.error('usage: --corpus <p> --emb <p> --profile <p> --out <p> [--samples 3] [--eval-seed-hex 0x...] [--epoch-id 0]');
  exit(2);
}

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
console.error(`[pin-v2] loading ${corpusPath}`);
const { corpus, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
console.error(`[pin-v2] corpus events=${corpus.events.length} corpusRoot=${corpus.corpusRoot}`);

console.error(`[pin-v2] spawning real Qwen3-Reranker-0.6B (${RR.modelId}@${RR.revision})`);
const reranker = makeStreamReranker({
  model: RR.modelId, revision: RR.revision,
  python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3',
  allowCuda: process.env.CORETEX_RERANKER_ALLOW_CUDA === '1',
});

const opts = scoringOptionsFromProfile(profile, {
  biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT,
});

console.error(`[pin-v2] deriving query pack (epoch=${epochId} seed=${evalSeedHex} packSize=${profile.hiddenPack?.packSize ?? 'default'})`);
const pack = deriveQueryPack(epochId, evalSeedHex, corpus, profile.hiddenPack);
console.error(`[pin-v2] pack derived: ${pack.events.length} events`);

const parent = { words: new Array(1024).fill(0n) };

console.error(`[pin-v2] running evaluateBaseline (samples=${samples}) — this can take several minutes per sample`);
const t0 = Date.now();
const baseline = await evaluateBaseline(parent, corpus, pack, opts, { samples });
const elapsedSec = (Date.now() - t0) / 1000;

console.error(`[pin-v2] DONE in ${elapsedSec.toFixed(1)}s`);
console.error(`[pin-v2]   parentScorePpm = ${baseline.parentScorePpm}`);
console.error(`[pin-v2]   variancePpm    = ${baseline.variancePpm}`);
console.error(`[pin-v2]   samples        = ${baseline.samples}`);
console.error(`[pin-v2]   corpusRoot     = ${baseline.corpusRoot}`);
console.error(`[pin-v2]   epochId        = ${baseline.epochId}`);

const pin = {
  generatedAt: new Date().toISOString(),
  corpus: corpusPath,
  profile: profilePath,
  reranker: `${RR.modelId}@${RR.revision} (real Qwen, GPU)`,
  evalSeedHex,
  epochId,
  packSize: pack.events.length,
  baselineParentScorePpm: baseline.parentScorePpm,
  baselineVariancePpm: baseline.variancePpm,
  baselineSamples: baseline.samples,
  corpusRoot: baseline.corpusRoot,
  elapsedSec,
};
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(pin, null, 2));
console.error(`[pin-v2] wrote ${outPath}`);
try { reranker.close(); } catch {}
exit(0);
