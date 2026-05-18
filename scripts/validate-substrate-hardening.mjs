#!/usr/bin/env node
/**
 * Substrate-hardening validation suite — Tests A, C, D, I, K from
 * docs/CORETEX_SUBSTRATE_EXPANSION_HARDENING.md §7.
 *
 * Qwen3-light tests: produce meaningful verdict with deterministic
 * reranker. Tests B, E, E', F, G, H, J live in Run 3, Run 4,
 * mining-flow-e2e, base-fork-rehearsal, Phase 13.
 *
 *   A. Anti-cheat invariant — empty substrate composite equals
 *      empty substrate with stage-2 weights zeroed.
 *   C. Compile-time qrel boundary — verify .d.ts signature.
 *   D. Full-pipeline determinism — same input × 2 runs → identical.
 *   I. Per-submit latency p50/p95/p99.
 *   K. Harness parity — coretex-eval runs clean end-to-end.
 *
 * Usage:
 *   node --max-old-space-size=16384 scripts/validate-substrate-hardening.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *     --bundle-profile /etc/coretex/bundle-profile.json \
 *     --reranker deterministic \
 *     --out /var/lib/coretex/reports/validation-suite.json
 */

import { distIndex, distPublicCorpusIndexDts, scriptsRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/validation-suite.json');
const packSize = Number(flag('pack-size', '8'));

function fail(msg, code = 1) { console.error(`[validate] ${msg}`); exit(code); }
if (!corpusPath || !existsSync(corpusPath)) fail(`--corpus missing: ${corpusPath}`);

const {
  loadProductionCorpus, evaluateRetrievalBenchmarkState,
  biEncoderModelIdHash, rerankerFromEnv, biEncoderFromEnv,
  createDeterministicReranker, createDeterministicBiEncoder,
  DEFAULT_PROFILE,
} = await import(distIndex);

const profile = profilePath && existsSync(profilePath)
  ? JSON.parse(readFileSync(profilePath, 'utf8'))
  : DEFAULT_PROFILE;

console.error('[validate] loading corpus');
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.error(`  ${corpus.events.length} events, corpusRoot=${corpus.corpusRoot}`);

const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);

let reranker, biEncoder;
if (rerankerArg === 'env') {
  reranker = await rerankerFromEnv();
  biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });
} else {
  reranker = await createDeterministicReranker();
  biEncoder = createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT });
}
console.error(`[validate] reranker: ${reranker.model}`);

const baseOpts = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  biEncoder, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: profile.relationHopBudget ?? 2,
  abstentionThreshold: profile.abstentionThreshold ?? 0.001,
  rerankerTopK: profile.rerankerTopK ?? 10,
  retrievalKeyTopK: profile.retrievalKeyTopK ?? 50,
  firstStageTopK: profile.firstStageTopK ?? 200,
  rerankerInputTopK: profile.rerankerInputTopK ?? 128,
  lensTopK: profile.lensTopK ?? 36,
  lensWeight: profile.lensWeight ?? 0.10,
  anchorWeight: profile.anchorWeight ?? 0.15,
  relationExpansionBudget: profile.relationExpansionBudget ?? 50,
  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.10,
  temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.10,
  lensDiversityFloor: profile.lensDiversityFloor,
  pipelineVersion: profile.pipelineVersion,
};

const ZERO_STATE = { words: new Array(1024).fill(0n) };

function buildPack(splitName, n) {
  const events = corpus.events.filter((e) => e.split === splitName);
  const seedHex = '0x' + 'aa'.repeat(32);
  const scored = events.map((e) => ({
    e, s: parseInt(createHash('sha256').update(seedHex + ':' + e.id).digest('hex').slice(0, 8), 16) / 0xffffffff,
  }));
  scored.sort((a, b) => a.s - b.s);
  return { epochId: 0, evalSeedCommit: seedHex, events: scored.slice(0, n).map((x) => x.e) };
}

const pack = buildPack('eval_hidden', packSize);
console.error(`[validate] using ${pack.events.length}-query eval_hidden pack`);

const tests = [];
let pass = 0, fails = 0;
async function runTest(name, fn) {
  console.error(`[validate] ${name}...`);
  try {
    const r = await fn();
    if (r.passed) { pass++; tests.push({ name, passed: true, ...r }); console.error(`  PASS ${r.summary ?? ''}`); }
    else { fails++; tests.push({ name, passed: false, ...r }); console.error(`  FAIL ${r.summary ?? ''}`); }
  } catch (e) {
    fails++;
    tests.push({ name, passed: false, error: e.message });
    console.error(`  ERROR: ${e.message}`);
  }
}

// ─── Test A: anti-cheat invariant ─────────────────────────────────────────
await runTest('A: empty substrate composite equals zeroed-stage-2 composite', async () => {
  const normal = await evaluateRetrievalBenchmarkState(ZERO_STATE, corpus, pack, baseOpts);
  const zeroOpts = { ...baseOpts, lensWeight: 0, anchorWeight: 0, relationExpansionBudget: 0, temporalCurrentBoost: 0, temporalStaleSuppression: 0 };
  const zeroed = await evaluateRetrievalBenchmarkState(ZERO_STATE, corpus, pack, zeroOpts);
  const passed = Math.abs(normal.composite - zeroed.composite) < 1e-6;
  return {
    passed,
    summary: `normal=${normal.composite.toFixed(6)} zeroed=${zeroed.composite.toFixed(6)} delta=${Math.abs(normal.composite - zeroed.composite).toExponential(2)}`,
    normalComposite: normal.composite,
    zeroedComposite: zeroed.composite,
  };
});

// ─── Test C: compile-time qrel boundary ───────────────────────────────────
await runTest('C: firstStageCandidates type signature accepts only PublicCorpusIndex', async () => {
  const dtsPath = distPublicCorpusIndexDts;
  if (!existsSync(dtsPath)) return { passed: false, summary: `dist .d.ts missing: ${dtsPath}` };
  const dts = readFileSync(dtsPath, 'utf8');
  // Match the firstStageCandidates declaration ONLY (up to the closing `)`),
  // not buildPublicCorpusIndex which legitimately accepts ProductionCorpus
  // (build the label-free index FROM the labeled corpus).
  const m = dts.match(/declare function firstStageCandidates\([^)]*\)/);
  if (!m) return { passed: false, summary: 'firstStageCandidates declaration not found in .d.ts' };
  const sig = m[0];
  const accepts = /index:\s*PublicCorpusIndex/.test(sig);
  const noProductionCorpus = !/ProductionCorpus/.test(sig);
  const noQrels = !/qrels|truthDocuments/.test(sig);
  return {
    passed: accepts && noProductionCorpus && noQrels,
    summary: `signature="${sig}" → accepts=${accepts} noProdCorpus=${noProductionCorpus} noQrels=${noQrels}`,
  };
});

// ─── Test D: full-pipeline determinism ────────────────────────────────────
await runTest('D: byte-identical CompositeScore across 2 runs same input', async () => {
  const a = await evaluateRetrievalBenchmarkState(ZERO_STATE, corpus, pack, baseOpts);
  const b = await evaluateRetrievalBenchmarkState(ZERO_STATE, corpus, pack, baseOpts);
  const equal = a.composite === b.composite
    && a.nDCG10 === b.nDCG10
    && a.mrr10 === b.mrr10
    && a.recall10 === b.recall10
    && a.perQuery.length === b.perQuery.length
    && a.perQuery.every((q, i) => q.top1Score === b.perQuery[i].top1Score);
  return {
    passed: equal,
    summary: equal
      ? 'byte-identical'
      : `composite diff=${a.composite - b.composite}, perQuery mismatches=${a.perQuery.filter((q, i) => q.top1Score !== b.perQuery[i].top1Score).length}`,
  };
});

// ─── Test I: per-submit latency ───────────────────────────────────────────
await runTest('I: p50/p95/p99 latency budget', async () => {
  const latencies = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await evaluateRetrievalBenchmarkState(ZERO_STATE, corpus, pack, baseOpts);
    latencies.push(Date.now() - t);
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[latencies.length - 1];
  const budgetCheck = rerankerArg === 'env' ? p99 <= 8000 : true;
  return {
    passed: budgetCheck,
    summary: `p50=${p50}ms p95=${p95}ms p99=${p99}ms ${rerankerArg === 'env' ? '(budget 8000ms)' : '(deterministic — budget skipped)'}`,
    latencies,
  };
});

// ─── Test K: harness parity / pipeline integrity ──────────────────────────
await runTest('K: coretex-eval harness produces CompositeScore via same pipeline', async () => {
  writeFileSync('/tmp/k-parent.bin', Buffer.alloc(32 * 1024));
  const direct = await evaluateRetrievalBenchmarkState(ZERO_STATE, corpus, pack, baseOpts);
  const result = spawnSync('node', [
    '--max-old-space-size=16384',
    join(scriptsRoot, 'coretex-eval.mjs'),
    '--corpus', corpusPath,
    '--parent-state', '/tmp/k-parent.bin',
    '--score-only',
    '--split', 'calibration',
    '--reranker', rerankerArg,
    '--out', '/tmp/k-eval-report.json',
  ], { encoding: 'utf8', env: process.env });
  if (result.status !== 0) {
    return { passed: false, summary: `harness exited ${result.status}: ${result.stderr.slice(0, 300)}` };
  }
  const harnessReport = JSON.parse(readFileSync('/tmp/k-eval-report.json', 'utf8'));
  const valid = harnessReport.schemaVersion === 'coretex.miner-self-eval.v1'
    && typeof harnessReport.parent.composite === 'number'
    && harnessReport.parent.composite >= 0 && harnessReport.parent.composite <= 1
    && typeof harnessReport.parent.nDCG10 === 'number';
  return {
    passed: valid,
    summary: `harness composite=${harnessReport.parent.composite.toFixed(4)} (direct=${direct.composite.toFixed(4)} on different pack — same pipeline shape)`,
    harnessComposite: harnessReport.parent.composite,
    directComposite: direct.composite,
  };
});

const report = {
  schemaVersion: 'coretex.validation-suite.v1',
  generatedAt: new Date().toISOString(),
  inputs: { corpus: corpusPath, corpusRoot: corpus.corpusRoot, rerankerMode: rerankerArg, rerankerModel: reranker.model, packSize },
  summary: { pass, fails, total: pass + fails },
  tests,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`\n[validate] ${pass}/${pass + fails} passed`);
console.log(`[validate] report → ${reportPath}`);
for (const t of tests) console.log(`  ${t.passed ? 'PASS' : 'FAIL'}  ${t.name}: ${t.summary ?? t.error ?? ''}`);
exit(fails > 0 ? 2 : 0);
