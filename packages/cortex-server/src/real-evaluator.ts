/**
 * Production CoreTex evaluator wiring for cortex-server.
 *
 * Spec: specs/retrieval_benchmark_v0.md, specs/determinism_v0.md.
 *
 * The HTTP server installs the real retrieval-benchmark scorer when the
 * operator provides:
 *
 *   CORTEX_REAL_EVAL=1
 *   CORETEX_RERANKER_PRODUCTION=1
 *   CORETEX_CORPUS=/path/to/corpus.json
 *   CORETEX_BUNDLE_MANIFEST=/path/to/bundle-manifest.json
 *   CORETEX_EXPECTED_BUNDLE_HASH=0x...
 *   CORETEX_EVAL_SEED_HEX=0x...                  # rotated per epoch
 *   CORETEX_EPOCH_ID=N                            # rotated per epoch
 *   CORTEX_STATE_PACKED_PATH=/path/to/state.bin
 *
 * Refusal modes (specs/determinism_v0.md):
 *   - acceleratorPolicy != cpu_only
 *   - any GPU env var set
 *   - on-chain coreVersionHash != bundleHash
 *   - reranker model id == labeling reranker model id
 *   - missing CORETEX_RERANKER_PRODUCTION in production mode
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyPatch,
  bytesToHex,
  decodePatch,
  hexToBytes,
  keccak256,
  merkleizeState,
  unpack,
  rerankerFromEnv,
  loadProductionCorpus,
  evaluateRetrievalBenchmarkPatch,
  deriveQueryPack,
  biEncoderFromEnv,
  biEncoderModelIdHash,
  type CoreTexBundleManifest,
  type ProductionCorpus,
  type CrossEncoderReranker,
  type CortexState,
  type ScoringOptions,
} from '@botcoin/cortex';
import type { BiEncoder } from '@botcoin/cortex';
import { setEvaluator, type EvalInput, type EvalReport, type EvalResult } from './workers/eval-pool.js';

const SCALE = 1_000_000;

let installed = false;

interface InstalledState {
  corpus: ProductionCorpus;
  reranker: CrossEncoderReranker;
  biEncoder: BiEncoder;
  manifest: CoreTexBundleManifest;
  scoringOpts: ScoringOptions;
  evalSeedHex: string;
  epochId: number;
  bundleHash: string;
}

let state: InstalledState | null = null;

export async function installRealEvaluatorFromEnv(): Promise<void> {
  if (installed) return;

  const enabled = process.env['CORTEX_REAL_EVAL'] === '1';
  if (!enabled) return;

  const productionMode = process.env['CORETEX_RERANKER_PRODUCTION'] === '1';

  const repoRoot = resolve(process.env['CORTEX_REPO_ROOT'] ?? process.cwd());
  const manifestPath = process.env['CORETEX_BUNDLE_MANIFEST'];
  if (!manifestPath) throw new Error('CORETEX_BUNDLE_MANIFEST is required');
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), 'utf8')) as CoreTexBundleManifest;

  const expectedBundleHash = process.env['CORETEX_EXPECTED_BUNDLE_HASH'];
  if (!expectedBundleHash) throw new Error('CORETEX_EXPECTED_BUNDLE_HASH is required');
  if (manifest.bundleHash.toLowerCase() !== expectedBundleHash.toLowerCase()) {
    throw new Error(`bundle manifest hash mismatch: ${manifest.bundleHash} vs ${expectedBundleHash}`);
  }
  if (manifest.evaluator.profile.acceleratorPolicy !== 'cpu_only') {
    throw new Error(`acceleratorPolicy must be cpu_only, got ${manifest.evaluator.profile.acceleratorPolicy}`);
  }
  if (manifest.model.reranker.modelId === manifest.model.labelingReranker.modelId
   && manifest.model.reranker.revision === manifest.model.labelingReranker.revision) {
    throw new Error('labelingReranker must differ from production reranker');
  }
  if (productionMode) {
    refuseGpu();
    if (process.env['CORETEX_RERANKER'] === 'deterministic') {
      throw new Error('CORETEX_RERANKER=deterministic is rejected in production mode');
    }
  }

  const corpusPath = resolve(repoRoot, process.env['CORETEX_CORPUS'] ?? '');
  if (!corpusPath) throw new Error('CORETEX_CORPUS is required');
  const corpus = loadProductionCorpus(corpusPath);

  const reranker = await rerankerFromEnv();
  const biEncoder = biEncoderFromEnv(manifest.model.biEncoder.retrievalKeyLayout, {
    modelId: manifest.model.biEncoder.modelId,
    revision: manifest.model.biEncoder.revision,
  });

  const evalSeedHex = process.env['CORETEX_EVAL_SEED_HEX'];
  if (!evalSeedHex) throw new Error('CORETEX_EVAL_SEED_HEX is required (rotated per epoch)');
  const epochId = Number(process.env['CORETEX_EPOCH_ID'] ?? '0');
  if (!Number.isInteger(epochId) || epochId < 0) throw new Error('CORETEX_EPOCH_ID must be non-negative integer');

  const profile = manifest.evaluator.profile;
  const scoringOpts: ScoringOptions = {
    weights: profile.compositeWeights,
    biEncoder,
    reranker,
    retrievalKeyLayout: manifest.model.biEncoder.retrievalKeyLayout,
    biEncoderHash: biEncoderModelIdHash(
      manifest.model.biEncoder.modelId,
      manifest.model.biEncoder.revision,
      manifest.model.biEncoder.mode,
    ),
    relationHopBudget: profile.relationHopBudget,
    abstentionThreshold: profile.abstentionThreshold,
    rerankerTopK: profile.rerankerTopK,
    retrievalKeyTopK: profile.retrievalKeyTopK,
  };

  state = {
    corpus, reranker, biEncoder, manifest, scoringOpts,
    evalSeedHex, epochId,
    bundleHash: manifest.bundleHash,
  };

  setEvaluator(async (input) => evaluateWithRetrievalBenchmark(input, state!, repoRoot));
  installed = true;
  // eslint-disable-next-line no-console
  console.log(
    `[cortex-server] real CoreTex retrieval-benchmark evaluator installed `
    + `bundleHash=${manifest.bundleHash.slice(0, 10)} `
    + `reranker=${manifest.model.reranker.modelId} `
    + `biEncoder=${manifest.model.biEncoder.modelId} `
    + `weights=retrieval@${profile.compositeWeights.w_retrieval}`,
  );
}

function refuseGpu(): void {
  for (const envVar of ['CORETEX_USE_GPU', 'PYTORCH_USE_MPS']) {
    const v = process.env[envVar];
    if (v && v !== '0') throw new Error(`refuse to start with ${envVar}=${v}`);
  }
  if (process.env['CUDA_VISIBLE_DEVICES']) throw new Error('refuse to start with CUDA_VISIBLE_DEVICES set');
  const ortProviders = process.env['ONNXRUNTIME_PROVIDERS'] ?? '';
  if (ortProviders.includes('CUDA') || ortProviders.includes('MPS')) {
    throw new Error(`refuse to start with ONNXRUNTIME_PROVIDERS=${ortProviders}`);
  }
}

async function evaluateWithRetrievalBenchmark(
  input: EvalInput,
  s: InstalledState,
  repoRoot: string,
): Promise<EvalResult> {
  const t0 = performance.now();
  const patchBytes = hexToBytes(input.patchHex.startsWith('0x') ? input.patchHex : `0x${input.patchHex}`);
  const patch = decodePatch(patchBytes);
  const patchHash = bytesToHex(keccak256(patchBytes));

  if (input.experienceCorpusRoot.toLowerCase() !== s.corpus.corpusRoot.toLowerCase()) {
    return rejectedReport(input, patchHash, input.parentStateRoot, 'E_CORPUS_ROOT_MISMATCH', performance.now() - t0);
  }
  if (input.coreVersionHash.toLowerCase() !== s.bundleHash.toLowerCase()) {
    return rejectedReport(input, patchHash, input.parentStateRoot, 'E_CORE_VERSION_BUNDLE_MISMATCH', performance.now() - t0);
  }

  const parentState = await loadParentState(input.parentStateRoot, repoRoot);
  const parentRoot = bytesToHex(merkleizeState(parentState));
  if (parentRoot.toLowerCase() !== input.parentStateRoot.toLowerCase()) {
    return rejectedReport(input, patchHash, parentRoot, 'E01_PARENT_STATE_SOURCE_MISMATCH', performance.now() - t0);
  }

  const pack = deriveQueryPack(s.epochId, s.evalSeedHex, s.corpus, s.manifest.evaluator.profile.hiddenPack);
  const result = await evaluateRetrievalBenchmarkPatch(parentState, patch, s.corpus, pack, s.scoringOpts, s.manifest.evaluator.profile.patchAcceptanceFloors);

  const applied = applyPatch(parentState, patch);
  const newStateRoot = applied.ok ? bytesToHex(merkleizeState(applied.state)) : undefined;
  const latencyMs = performance.now() - t0;
  const baselineScore = Math.round(result.before.composite * SCALE);
  const candidateScore = Math.round(result.after.composite * SCALE);
  const families: Record<string, number> = {};
  for (const [k, v] of Object.entries(result.perFamilyDelta)) families[k] = v;
  const report: EvalReport = {
    scoreDelta: result.deltaPpm,
    baselineScore,
    candidateScore,
    protectedRegressionClean: result.accepted || (result.reason !== undefined && !result.reason.startsWith('protected_regression')),
    stateCompliant: applied.ok,
    latencyMs,
    families,
    ...(!result.accepted ? { errorCode: result.reason ?? 'NO_RETRIEVAL_IMPROVEMENT' } : {}),
  };
  return {
    pass: result.accepted,
    report,
    evalReportHash: reportHash(input, report, patchHash, newStateRoot ?? null),
    ...(newStateRoot ? { newStateRoot } : {}),
  };
}

async function loadParentState(_parentStateRoot: string, repoRoot: string): Promise<CortexState> {
  const packedPath = process.env['CORTEX_STATE_PACKED_PATH'];
  if (!packedPath) {
    throw new Error('CORTEX_REAL_EVAL requires CORTEX_STATE_PACKED_PATH');
  }
  const abs = resolve(repoRoot, packedPath);
  if (!existsSync(abs)) throw new Error(`CORTEX_STATE_PACKED_PATH not found: ${abs}`);
  const bytes = readFileSync(abs);
  return unpack(new Uint8Array(bytes));
}

function rejectedReport(
  input: EvalInput,
  patchHash: string,
  observedParentRoot: string,
  code: string,
  latencyMs: number,
): EvalResult {
  const report = {
    scoreDelta: 0,
    baselineScore: 0,
    candidateScore: 0,
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
