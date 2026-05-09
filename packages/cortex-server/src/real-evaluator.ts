/**
 * Production CortexBench evaluator wiring for cortex-server.
 *
 * The HTTP server should not ever issue production receipts from the inline
 * stub. This module installs a real evaluator when the operator provides a
 * state source:
 *
 *   CORTEX_REAL_EVAL=1
 *   CORTEX_STATE_PACKED_PATH=/var/lib/cortex/current-state.bin
 *
 * The packed state must be the 32768-byte CortexState whose Merkle root equals
 * the active challenge parentStateRoot. For genesis, operators may omit the
 * file and rely on the frozen Baseline A genesis state in this repo.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyPatch,
  bytesToHex,
  decodePatch,
  evaluatePatchWithReranker,
  hexToBytes,
  keccak256,
  loadProductionCorpus,
  merkleizeState,
  unpack,
  rerankerFromEnv,
} from '@botcoin/cortex';
import type { CortexState, CrossEncoderReranker, ProductionCorpus } from '@botcoin/cortex';
import { setEvaluator, type EvalInput, type EvalReport, type EvalResult } from './workers/eval-pool.js';

const SCALE = 1_000_000;

interface BenchModule {
  loadRealCorpus(opts: { repoRoot: string }): unknown;
  scoreState(
    state: CortexState,
    corpus: unknown,
    opts?: { shardId?: string; evalItemsPerFamily?: number },
  ): { composite: number; familyScores?: Record<string, number> };
}

interface FrozenConfig {
  genesisStateRoot: string;
  winner: string;
}

let installed = false;
let localModelEvalPromise: Promise<{
  evaluatePatchWithLocalModel: Function;
  createTransformersEmbedder: Function;
  embedder: unknown;
}> | null = null;

export async function installRealEvaluatorFromEnv(): Promise<void> {
  if (installed) return;
  const enabled = process.env['CORTEX_REAL_EVAL'] === '1' || Boolean(process.env['CORTEX_STATE_PACKED_PATH']);
  if (!enabled) return;

  const repoRoot = resolve(process.env['CORTEX_REPO_ROOT'] ?? process.cwd());
  const frozen = readFrozen(repoRoot);
  const evalItemsPerFamily = nonNegativeSafeIntFromEnv('CORTEX_EVAL_ITEMS_PER_FAMILY');
  if (process.env['CORTEX_RERANKER_EVAL'] !== '0') {
    const corpusPath = resolve(
      repoRoot,
      process.env['CORETEX_CORPUS']
        ?? process.env['CORTEX_CORPUS_PATH']
        ?? 'benchmark/fixtures/dacr-v0/coretex_dacr.json',
    );
    const corpus = loadProductionCorpus(corpusPath);
    const reranker = await rerankerFromEnv();
    const threshold = rerankerThresholdFromEnv();
    setEvaluator(async (input) => evaluateWithRealReranker(input, corpus, reranker, frozen, repoRoot, threshold));
    installed = true;
    console.log(`[cortex-server] real CoreTex reranker evaluator installed model=${reranker.model} threshold=${threshold}`);
    return;
  }

  const bench = await import(pathToFileURL(resolve(repoRoot, 'experiments/harness/cortex-bench-eval.mjs')).href) as BenchModule;
  const corpus = bench.loadRealCorpus({ repoRoot });
  const threshold = Number(process.env['CORTEX_SCORE_THRESHOLD'] ?? 0);

  setEvaluator(async (input) => evaluateWithRealBench(input, bench, corpus, frozen, repoRoot, threshold, evalItemsPerFamily));
  installed = true;
  console.log('[cortex-server] real CortexBench evaluator installed');
}

async function evaluateWithRealReranker(
  input: EvalInput,
  corpus: ProductionCorpus,
  reranker: CrossEncoderReranker,
  frozen: FrozenConfig,
  repoRoot: string,
  threshold: number,
): Promise<EvalResult> {
  const t0 = performance.now();
  const patchBytes = hexToBytes(input.patchHex.startsWith('0x') ? input.patchHex : `0x${input.patchHex}`);
  const patch = decodePatch(patchBytes);
  const patchHash = bytesToHex(keccak256(patchBytes));

  if (input.experienceCorpusRoot.toLowerCase() !== corpus.corpusRoot.toLowerCase()) {
    return rejectedReport(input, patchHash, input.parentStateRoot, 'E_CORPUS_ROOT_MISMATCH', performance.now() - t0);
  }
  const expectedBundleHash = process.env['CORETEX_EXPECTED_BUNDLE_HASH'];
  if (expectedBundleHash && input.coreVersionHash.toLowerCase() !== expectedBundleHash.toLowerCase()) {
    return rejectedReport(input, patchHash, input.parentStateRoot, 'E_CORE_VERSION_BUNDLE_MISMATCH', performance.now() - t0);
  }

  const parentState = await loadParentState(input.parentStateRoot, frozen, repoRoot);
  const parentRoot = bytesToHex(merkleizeState(parentState));
  if (parentRoot.toLowerCase() !== input.parentStateRoot.toLowerCase()) {
    return rejectedReport(input, patchHash, parentRoot, 'E01_PARENT_STATE_SOURCE_MISMATCH', performance.now() - t0);
  }

  const evaluated = await evaluatePatchWithReranker(parentState, patch, {
    corpus,
    reranker,
    threshold,
  });
  const applied = applyPatch(parentState, patch);
  const newStateRoot = applied.ok ? bytesToHex(merkleizeState(applied.state)) : undefined;
  const latencyMs = performance.now() - t0;
  const report: EvalReport = {
    scoreDelta: evaluated.scoreDelta,
    baselineScore: Math.round(evaluated.before.composite * SCALE),
    candidateScore: Math.round(evaluated.after.composite * SCALE),
    protectedRegressionClean: evaluated.noRegression,
    stateCompliant: applied.ok,
    latencyMs,
    families: evaluated.after.familyHitRates,
    localModel: {
      model: evaluated.after.model ?? reranker.model,
      threshold,
      noRegression: evaluated.noRegression,
      regressions: evaluated.regressions,
      beforeComponents: evaluated.before.components,
      afterComponents: evaluated.after.components,
    },
    ...(!evaluated.pass ? { errorCode: evaluated.errorCode ?? 'RERANKER_THRESHOLD' } : {}),
  };
  return {
    pass: evaluated.pass,
    report,
    evalReportHash: reportHash(input, report, patchHash, newStateRoot ?? null),
    ...(newStateRoot ? { newStateRoot } : {}),
  };
}

async function evaluateWithRealBench(
  input: EvalInput,
  bench: BenchModule,
  corpus: unknown,
  frozen: FrozenConfig,
  repoRoot: string,
  threshold: number,
  evalItemsPerFamily: number,
): Promise<EvalResult> {
  const t0 = performance.now();
  const patchBytes = hexToBytes(input.patchHex.startsWith('0x') ? input.patchHex : `0x${input.patchHex}`);
  const patch = decodePatch(patchBytes);
  const parentState = await loadParentState(input.parentStateRoot, frozen, repoRoot);
  const parentRoot = bytesToHex(merkleizeState(parentState));
  const patchHash = bytesToHex(keccak256(patchBytes));

  if (parentRoot.toLowerCase() !== input.parentStateRoot.toLowerCase()) {
    return rejectedReport(input, patchHash, parentRoot, 'E01_PARENT_STATE_SOURCE_MISMATCH', performance.now() - t0);
  }

  const scoreOpts = {
    shardId: input.shardId,
    ...(evalItemsPerFamily > 0 ? { evalItemsPerFamily } : {}),
  };
  const baseScore = bench.scoreState(parentState, corpus, scoreOpts);
  const applied = applyPatch(parentState, patch);
  if (!applied.ok) {
    return rejectedReport(input, patchHash, parentRoot, applied.code, performance.now() - t0, baseScore.composite);
  }

  const candidateScore = bench.scoreState(applied.state, corpus, scoreOpts);
  const delta = candidateScore.composite - baseScore.composite;
  const scoreDelta = Math.round(delta * SCALE);
  const newStateRoot = bytesToHex(merkleizeState(applied.state));
  const latencyMs = performance.now() - t0;
  let pass = delta > threshold;
  const report: EvalReport = {
    scoreDelta,
    baselineScore: Math.round(baseScore.composite * SCALE),
    candidateScore: Math.round(candidateScore.composite * SCALE),
    protectedRegressionClean: pass,
    stateCompliant: true,
    latencyMs,
    families: candidateScore.familyScores ?? {},
  };

  if (pass && process.env['CORTEX_LOCAL_MODEL_EVAL'] !== '0') {
    const local = await runLocalModelEval(parentState, patch, corpus, repoRoot);
    report.localModel = local.summary;
    pass = local.pass;
    if (!pass) {
      report.protectedRegressionClean = false;
      report.errorCode = 'L02_LOCAL_MODEL_NO_SIGNAL';
    }
  }

  const evalReportHash = reportHash(input, report, patchHash, newStateRoot);
  return { pass, report, evalReportHash, newStateRoot };
}

function nonNegativeSafeIntFromEnv(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function rerankerThresholdFromEnv(): number {
  const ppm = process.env['CORTEX_RERANKER_MIN_DELTA_PPM'] ?? process.env['CORETEX_RERANKER_MIN_DELTA_PPM'];
  if (ppm !== undefined && ppm !== '') return Number(ppm) / SCALE;
  return Number(process.env['CORTEX_RERANKER_MIN_DELTA'] ?? process.env['CORTEX_SCORE_THRESHOLD'] ?? 0.0025);
}

async function runLocalModelEval(
  parentState: CortexState,
  patch: unknown,
  corpus: unknown,
  repoRoot: string,
): Promise<{ pass: boolean; summary: unknown }> {
  if (!localModelEvalPromise) {
    localModelEvalPromise = (async () => {
      const mod = await import(pathToFileURL(resolve(repoRoot, 'experiments/harness/local-model-eval.mjs')).href) as {
        evaluatePatchWithLocalModel: Function;
        createTransformersEmbedder: Function;
        prewarmLocalModelEmbedder: Function;
      };
      const embedder = await mod.createTransformersEmbedder({
        model: process.env['CORTEX_LOCAL_MODEL'],
        cacheDir: process.env['CORTEX_LOCAL_MODEL_CACHE'],
        localOnly: process.env['CORTEX_LOCAL_MODEL_LOCAL_ONLY'] === '1',
      });
      if (process.env['CORTEX_LOCAL_MODEL_PREWARM'] !== '0') {
        const warm = await mod.prewarmLocalModelEmbedder(embedder, corpus);
        console.log(
          `[cortex-server] local model eval prewarmed ${warm.textCount} texts in ${warm.latencyMs.toFixed(1)}ms`,
        );
      }
      return { ...mod, embedder };
    })();
  }

  const { evaluatePatchWithLocalModel, embedder } = await localModelEvalPromise;
  const threshold = Number(process.env['CORTEX_LOCAL_MODEL_MIN_DELTA'] ?? 0);
  const local = await evaluatePatchWithLocalModel(parentState, patch, {
    applyPatch,
    corpus,
    embedder,
    threshold,
  }) as {
    pass: boolean;
    scoreDelta: number;
    delta: number;
    noRegression: boolean;
    regressions: string[];
    before: { composite: number; components: unknown; model?: string };
    after: { composite: number; components: unknown; model?: string };
  };
  return {
    pass: local.pass,
    summary: {
      model: local.after.model ?? local.before.model,
      scoreDelta: local.scoreDelta,
      beforeComposite: Math.round(local.before.composite * SCALE),
      afterComposite: Math.round(local.after.composite * SCALE),
      delta: local.delta,
      minDelta: threshold,
      noRegression: local.noRegression,
      regressions: local.regressions,
      beforeComponents: local.before.components,
      afterComponents: local.after.components,
    },
  };
}

async function loadParentState(parentStateRoot: string, frozen: FrozenConfig, repoRoot: string): Promise<CortexState> {
  const packedPath = process.env['CORTEX_STATE_PACKED_PATH'];
  if (packedPath) {
    const bytes = readFileSync(resolve(repoRoot, packedPath));
    return unpack(new Uint8Array(bytes));
  }

  if (parentStateRoot.toLowerCase() === frozen.genesisStateRoot.toLowerCase()) {
    const baseline = await import(pathToFileURL(resolve(repoRoot, 'experiments/baselines/baseline_a_empty/index.mjs')).href) as {
      genesisState(): CortexState;
    };
    if (frozen.winner !== 'A') {
      throw new Error(`CORTEX_REAL_EVAL genesis fallback only supports frozen winner A, got ${frozen.winner}`);
    }
    return baseline.genesisState();
  }

  throw new Error(
    'CORTEX_REAL_EVAL needs CORTEX_STATE_PACKED_PATH for non-genesis parent roots. ' +
    `No packed state source for ${parentStateRoot}.`,
  );
}

function readFrozen(repoRoot: string): FrozenConfig {
  const fp = resolve(repoRoot, 'ops/v0-frozen.json');
  if (!existsSync(fp)) throw new Error('ops/v0-frozen.json missing; run scripts/freeze-core-version.mjs');
  const j = JSON.parse(readFileSync(fp, 'utf8')) as FrozenConfig;
  if (!j.genesisStateRoot || !j.winner) throw new Error('ops/v0-frozen.json missing genesisStateRoot/winner');
  return j;
}

function rejectedReport(
  input: EvalInput,
  patchHash: string,
  observedParentRoot: string,
  code: string,
  latencyMs: number,
  baseComposite = 0,
): EvalResult {
  const report = {
    scoreDelta: 0,
    baselineScore: Math.round(baseComposite * SCALE),
    candidateScore: Math.round(baseComposite * SCALE),
    protectedRegressionClean: false,
    stateCompliant: false,
    latencyMs,
    families: { rejection: 0 },
    errorCode: code,
    observedParentRoot,
  };
  return {
    pass: false,
    report,
    evalReportHash: reportHash(input, report, patchHash, null),
  };
}

function reportHash(input: EvalInput, report: unknown, patchHash: string, newStateRoot: string | null): string {
  return bytesToHex(keccak256(new TextEncoder().encode(JSON.stringify({
    epoch: input.epoch,
    parentStateRoot: input.parentStateRoot.toLowerCase(),
    experienceCorpusRoot: input.experienceCorpusRoot.toLowerCase(),
    coreVersionHash: input.coreVersionHash.toLowerCase(),
    shardId: input.shardId.toLowerCase(),
    patchHash,
    newStateRoot,
    report,
  }))));
}
