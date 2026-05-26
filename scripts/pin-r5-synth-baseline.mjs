#!/usr/bin/env node
/**
 * Pin the r5 launch-candidate baseline (parent = empty substrate == r5-no-atoms == r4) on the
 * dgen1-r5-synth genesis hidden pack, real Qwen. Mirrors pin-baseline-into-bundle.mjs but uses the
 * in-memory production-corpus builder (the synth candidate isn't serialized to production format).
 * Prints baselineParentScorePpm/baselineVariancePpm/baselineEvalSeedHex; the profile + manifest are
 * patched separately. PRODUCTION launch re-pins against the production launch corpus.
 *
 * Usage: node scripts/pin-r5-synth-baseline.mjs [--reranker gpu] [--eval-seed-hex <hex>] [--samples 1]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const C = await import(distIndex);
const { scoringOptionsFromProfile, deriveQueryPack, evaluateBaseline, createDeterministicReranker } = C;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const rerankerArg = flag('reranker', 'deterministic');
const evalSeedHex = flag('eval-seed-hex', '0x' + 'a5'.repeat(32));
const samples = Number(flag('samples', '1'));
const epochId = Number(flag('epoch-id', '0'));

const r5 = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json'), 'utf8'));
const { corpus, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath: `${base}/dgen1-r5-synth-corpus.json`, embPath: `${base}/dgen1-r5-synth-embeddings.json` });
const reranker = rerankerArg === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const opts = scoringOptionsFromProfile(r5, rt);
const pack = deriveQueryPack(epochId, evalSeedHex, corpus, r5.hiddenPack);
const empty = { words: new Array(1024).fill(0n) };
const b = await evaluateBaseline(empty, corpus, pack, opts, { samples });
const result = { reranker: rerankerArg === 'gpu' ? `Qwen3-Reranker-0.6B@${RR.revision} (gpu)` : 'deterministic', epochId, evalSeedHex, samples, packSize: pack.events.length,
  adapter: process.env.CORETEX_RERANKER_ADAPTER_DIR ?? null,
  baselineParentScorePpm: b.parentScorePpm, baselineVariancePpm: b.variancePpm };
const outArg = (() => { const i = process.argv.indexOf('--out'); return i >= 0 ? process.argv[i + 1] : null; })();
if (outArg) { const { writeFileSync } = await import('node:fs'); writeFileSync(outArg.startsWith('/') ? outArg : resolve(repoRoot, outArg), JSON.stringify(result, null, 2)); }
console.log(JSON.stringify(result, null, 2));
if (typeof reranker.close === 'function') reranker.close();
