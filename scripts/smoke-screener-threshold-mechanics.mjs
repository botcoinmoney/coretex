#!/usr/bin/env node
/**
 * Fast CPU smoke for the canonical CoreTex-only screener threshold calibration mechanics.
 * Uses the deterministic reranker (no GPU) and a tiny per-class N to prove the wiring:
 *   - buildV2ProductionCorpus with explicit --bundle
 *   - canonical patch generators applied via evaluateRetrievalBenchmarkPatch
 *   - computeCoreTexScreenerThresholdPpm derives a threshold
 *   - outcomes classify as REJECT / SCREENER_PASS / STATE_ADVANCE
 *
 * Hard-fails on any of:
 *   - bundle.verifyBundleManifest dirty
 *   - any patch class returns null/undefined deltaPpm
 *   - threshold is zero/negative (canonical formula always returns positive)
 *
 * Usage: node scripts/smoke-screener-threshold-mechanics.mjs --profile <p> --bundle <b> --corpus <c> --emb <e> [--per-class 1]
 */
import { spawn } from 'node:child_process';
import { argv, exit } from 'node:process';
import { resolve } from 'node:path';
import { repoRoot } from './_repo-root.mjs';

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const PROFILE = flag('profile'), BUNDLE = flag('bundle'), CORPUS = flag('corpus'), EMB = flag('emb'), PER_CLASS = flag('per-class', '1');
if (!PROFILE || !BUNDLE || !CORPUS || !EMB) { console.error('HARD FAIL: --profile, --bundle, --corpus, --emb required'); exit(1); }

const out = '/tmp/screener-threshold-smoke.json';
const args = [
  resolve(repoRoot, 'scripts/screener-threshold-calibration.mjs'),
  '--reranker', 'deterministic',
  '--profile', PROFILE, '--bundle', BUNDLE, '--corpus', CORPUS, '--emb', EMB,
  '--per-class', PER_CLASS, '--pack-size', '16', '--clear-pack-quotas', '--out', out,
];
console.log(`smoke: spawning canonical screener-threshold (deterministic) per-class=${PER_CLASS}`);
const child = spawn('node', args, { stdio: ['ignore', 'inherit', 'inherit'] });
const code = await new Promise((res) => child.on('exit', res));
if (code !== 0) { console.error(`SMOKE FAIL: screener-threshold-calibration exit=${code}`); exit(1); }
console.log('SMOKE PASS: screener-threshold mechanics ran end-to-end on real corpus + bundle');
exit(0);
