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
  hexToBytes,
  keccak256,
  merkleizeState,
  unpack,
} from '@botcoin/cortex';
import type { CortexState } from '@botcoin/cortex';
import { setEvaluator, type EvalInput, type EvalResult } from './workers/eval-pool.js';

const SCALE = 1_000_000;

interface BenchModule {
  loadRealCorpus(opts: { repoRoot: string }): unknown;
  scoreState(state: CortexState, corpus: unknown): { composite: number; familyScores?: Record<string, number> };
}

interface FrozenConfig {
  genesisStateRoot: string;
  winner: string;
}

let installed = false;

export async function installRealEvaluatorFromEnv(): Promise<void> {
  if (installed) return;
  const enabled = process.env['CORTEX_REAL_EVAL'] === '1' || Boolean(process.env['CORTEX_STATE_PACKED_PATH']);
  if (!enabled) return;

  const repoRoot = resolve(process.env['CORTEX_REPO_ROOT'] ?? process.cwd());
  const bench = await import(pathToFileURL(resolve(repoRoot, 'experiments/harness/cortex-bench-eval.mjs')).href) as BenchModule;
  const corpus = bench.loadRealCorpus({ repoRoot });
  const frozen = readFrozen(repoRoot);
  const threshold = Number(process.env['CORTEX_SCORE_THRESHOLD'] ?? 0);

  setEvaluator(async (input) => evaluateWithRealBench(input, bench, corpus, frozen, repoRoot, threshold));
  installed = true;
  console.log('[cortex-server] real CortexBench evaluator installed');
}

async function evaluateWithRealBench(
  input: EvalInput,
  bench: BenchModule,
  corpus: unknown,
  frozen: FrozenConfig,
  repoRoot: string,
  threshold: number,
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

  const baseScore = bench.scoreState(parentState, corpus);
  const applied = applyPatch(parentState, patch);
  if (!applied.ok) {
    return rejectedReport(input, patchHash, parentRoot, applied.code, performance.now() - t0, baseScore.composite);
  }

  const candidateScore = bench.scoreState(applied.state, corpus);
  const delta = candidateScore.composite - baseScore.composite;
  const scoreDelta = Math.round(delta * SCALE);
  const newStateRoot = bytesToHex(merkleizeState(applied.state));
  const latencyMs = performance.now() - t0;
  const pass = delta > threshold;
  const report = {
    scoreDelta,
    baselineScore: Math.round(baseScore.composite * SCALE),
    candidateScore: Math.round(candidateScore.composite * SCALE),
    protectedRegressionClean: pass,
    stateCompliant: true,
    latencyMs,
    families: candidateScore.familyScores ?? {},
  };
  const evalReportHash = reportHash(input, report, patchHash, newStateRoot);
  return { pass, report, evalReportHash, newStateRoot };
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
