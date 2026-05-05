/**
 * Worker-pool harness for Botcoin Core eval.
 *
 * Phase 3 fills in the actual eval body inside the worker. This module
 * provides:
 *   - A fixed-size pool of worker_threads (size from CORTEX_WORKER_POOL_SIZE,
 *     default: CPU count or 4).
 *   - A promise-based dispatch API so the HTTP request thread never blocks.
 *   - Round-robin task assignment with per-worker queuing.
 *
 * TODO(Phase 3): replace the STUB_EVAL_RESULT below with a real call to
 * @botcoin/cortex eval once packages/cortex/src/eval/ lands. The interface
 * contract for Phase 3 is:
 *
 *   evalPatch(input: EvalInput): Promise<EvalResult>
 *
 * where EvalInput = { state: CortexState; patch: Patch; shardId: string;
 *                      experienceCorpusRoot: string; coreVersionHash: string }
 * and   EvalResult = { pass: boolean; scoreDelta: number; report: EvalReport }
 *
 * The worker file is packages/cortex/src/workers/eval-worker.js (Phase 3 lands
 * it). Until Phase 3 ships, every submission that passes decode gets a stub
 * screener pass with scoreDelta=1 and a clearly-flagged TODO report.
 *
 * Hard performance budget (§4): <10 ms p50, <50 ms p99 per eval.
 * The pool size should be set so that eval latency targets are met on the
 * production host without blocking the HTTP event loop.
 */

import { Worker, workerData, isMainThread, parentPort } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface EvalInput {
  /** Hex-encoded patch wire bytes */
  patchHex: string;
  /** Hex-encoded parent state root (32 bytes) */
  parentStateRoot: string;
  /** Shard identifier for protected-regression eval */
  shardId: string;
  /** experienceCorpusRoot for this epoch */
  experienceCorpusRoot: string;
  /** coreVersionHash to validate determinism */
  coreVersionHash: string;
  /** Epoch number */
  epoch: number;
}

export interface EvalReport {
  scoreDelta: number;
  baselineScore: number;
  candidateScore: number;
  protectedRegressionClean: boolean;
  stateCompliant: boolean;
  latencyMs: number;
  /** Phase 3 TODO marker — remove when eval is real */
  _stub?: boolean;
  families?: Record<string, number>;
}

export interface EvalResult {
  pass: boolean;
  report: EvalReport;
  evalReportHash: string;
  /** New state root after applying patch (hex) */
  newStateRoot?: string;
}

// ─── Worker inline code ────────────────────────────────────────────────────────
// The actual eval worker code. When Phase 3 ships eval-worker.mjs, import it
// instead of running the stub inline.

const WORKER_INLINE_CODE = `
import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';

// TODO(Phase 3): replace this stub with:
//   import { evalPatch } from '@botcoin/cortex/eval';
// and call evalPatch(msg.input) for real scoring.

parentPort.on('message', (msg) => {
  const { id, input } = msg;
  const t0 = performance.now();

  // ── STUB EVAL ─────────────────────────────────────────────────────────────
  // Phase 3 Core eval is not yet landed. All patches that survived decode
  // are marked as screener-pass with a synthetic scoreDelta=1.
  // This stub MUST be replaced before Cortex goes live.
  const latencyMs = performance.now() - t0;

  const report = {
    scoreDelta: 1,
    baselineScore: 0,
    candidateScore: 1,
    protectedRegressionClean: true,
    stateCompliant: true,
    latencyMs,
    _stub: true,
  };

  // Deterministic report hash (stable: sha256 of JSON-canonical report + input)
  const hashInput = JSON.stringify({ report, patchHex: input.patchHex, epoch: input.epoch, shardId: input.shardId });
  const evalReportHash = '0x' + createHash('sha256').update(hashInput).digest('hex');

  parentPort.postMessage({ id, ok: true, result: { pass: true, report, evalReportHash } });
});
`;

// ─── Pool implementation ────────────────────────────────────────────────────────

interface PendingTask {
  id: number;
  resolve: (r: EvalResult) => void;
  reject: (e: Error) => void;
}

let _nextTaskId = 1;

function nextId(): number {
  return _nextTaskId++;
}

export class EvalPool {
  private readonly workers: Worker[];
  private readonly pending: Map<number, PendingTask>;
  private readonly queues: Array<{ busy: boolean; queue: PendingTask[] }>;
  private workerIndex = 0;

  constructor(size?: number) {
    const envPoolSize = Number(process.env['CORTEX_WORKER_POOL_SIZE'] ?? 0);
    const poolSize = size ?? (envPoolSize || Math.min(os.cpus().length, 4));

    this.pending = new Map();
    this.queues = [];
    this.workers = [];

    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(
        `data:text/javascript,${encodeURIComponent(WORKER_INLINE_CODE)}`,
        { eval: true },
      );

      const slot = { busy: false, queue: [] as PendingTask[] };
      this.queues.push(slot);

      worker.on('message', (msg: { id: number; ok: boolean; result?: EvalResult; error?: string }) => {
        const task = this.pending.get(msg.id);
        if (!task) return;
        this.pending.delete(msg.id);

        if (msg.ok && msg.result) {
          task.resolve(msg.result);
        } else {
          task.reject(new Error(msg.error ?? 'eval-worker unknown error'));
        }

        // Drain the slot queue
        slot.busy = false;
        const next = slot.queue.shift();
        if (next) {
          this._dispatch(i, next);
        }
      });

      worker.on('error', (err) => {
        console.error(`[eval-pool] worker ${i} error:`, err);
      });

      this.workers.push(worker);
    }
  }

  private _dispatch(workerIdx: number, task: PendingTask): void {
    const slot = this.queues[workerIdx]!;
    slot.busy = true;
    this.pending.set(task.id, task);
    this.workers[workerIdx]!.postMessage({ id: task.id, input: null }); // input is part of task data
  }

  eval(input: EvalInput): Promise<EvalResult> {
    return new Promise((resolve, reject) => {
      const id = nextId();
      const task: PendingTask = { id, resolve, reject };
      this.pending.set(id, task);

      // Round-robin to find a non-busy worker; otherwise queue it
      const start = this.workerIndex;
      let assigned = false;
      for (let i = 0; i < this.workers.length; i++) {
        const idx = (start + i) % this.workers.length;
        const slot = this.queues[idx]!;
        if (!slot.busy) {
          this.workerIndex = (idx + 1) % this.workers.length;
          slot.busy = true;
          // Send directly
          this.workers[idx]!.postMessage({ id, input });
          assigned = true;
          break;
        }
      }

      if (!assigned) {
        // All workers busy — enqueue on least-loaded slot
        this.workerIndex = (this.workerIndex + 1) % this.workers.length;
        const idx = this.workerIndex;
        this.pending.delete(id); // Will be re-added when dispatched
        this.queues[idx]!.queue.push({ id, resolve, reject });
      }
    });
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

// Singleton pool — created lazily on first use
let _pool: EvalPool | null = null;

export function getPool(): EvalPool {
  if (!_pool) {
    _pool = new EvalPool();
  }
  return _pool;
}

export async function shutdownPool(): Promise<void> {
  if (_pool) {
    await _pool.shutdown();
    _pool = null;
  }
}
