/**
 * Worker-pool harness for Botcoin Core eval.
 *
 * Production gate (Step 5): the inline-stub worker only emits screener-pass
 * reports tagged `_stub: true`. submit.ts rejects any `_stub` report at the
 * receipt boundary unless `CORTEX_ALLOW_STUB_EVAL=1`. The boot path also
 * fails fast on instantiation if the gate is unset AND no real evaluator
 * has been registered via `setEvaluator()` — production miners cannot earn
 * receipts from a stubbed evaluator.
 *
 * Real-evaluator wiring: index.ts calls installRealEvaluatorFromEnv() before
 * constructing the pool. Operators set CORTEX_REAL_EVAL=1 plus a packed state
 * source for non-genesis roots; otherwise the pool fails closed unless the
 * explicit local-dev CORTEX_ALLOW_STUB_EVAL=1 flag is set.
 *
 * Hard performance budget (§4): <10 ms p50, <50 ms p99 per eval.
 */

import { Worker, type WorkerOptions } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keccakModulePath = path.resolve(__dirname, '../../../cortex/dist/state/keccak256.js');
const keccakModuleUrl = pathToFileURL(keccakModulePath).href;

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
  /** Present only for the local-dev stub evaluator. */
  _stub?: boolean;
  families?: Record<string, number>;
  localModel?: unknown;
  errorCode?: string;
}

export interface EvalResult {
  pass: boolean;
  report: EvalReport;
  evalReportHash: string;
  /** New state root after applying patch (hex) */
  newStateRoot?: string;
}

// ─── Worker inline code ────────────────────────────────────────────────────────
// Inline stub worker — only used when CORTEX_ALLOW_STUB_EVAL=1. Reports are
// tagged `_stub: true`; submit.ts rejects them at the receipt boundary in
// production mode. Uses canonical Keccak-256 (same primitive as on-chain) for
// the deterministic eval-report hash so cross-impl audits don't diverge on
// the report-hash format alone.

const WORKER_INLINE_CODE = `
import { parentPort } from 'node:worker_threads';
const { keccak256 } = await import(${JSON.stringify(
  // Resolved relative to the compiled cortex-server worker module. This stays
  // inside the deployed workspace without hardcoding /root/cortex.
  keccakModuleUrl,
)});

parentPort.on('message', (msg) => {
  const { id, input } = msg;
  const t0 = performance.now();
  const latencyMs = performance.now() - t0;

  // STUB report — _stub flag forces submit.ts production gate to reject.
  const report = {
    scoreDelta: 1000,
    baselineScore: 0,
    candidateScore: 1000,
    protectedRegressionClean: true,
    stateCompliant: true,
    latencyMs,
    _stub: true,
  };

  // Canonical Keccak-256 over canonical-JSON input for the report hash.
  const hashInput = JSON.stringify({ report, patchHex: input.patchHex, epoch: input.epoch, shardId: input.shardId });
  const enc = new TextEncoder();
  const digest = keccak256(enc.encode(hashInput));
  let hex = '0x';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');

  parentPort.postMessage({ id, ok: true, result: { pass: true, report, evalReportHash: hex } });
});
`;

// ─── Pool implementation ────────────────────────────────────────────────────────

interface PendingTask {
  id: number;
  input: EvalInput;
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
    // Production gate: if no real evaluator is registered AND the operator
    // hasn't opted into stub mode, refuse to construct the pool. Better to
    // crash on boot than to issue stubbed receipts.
    if (!_realEvaluator && process.env['CORTEX_ALLOW_STUB_EVAL'] !== '1') {
      throw new Error(
        'cortex-server: refusing to start with stub evaluator. ' +
        'Set CORTEX_ALLOW_STUB_EVAL=1 for development, or call setEvaluator() ' +
        'to wire a real eval before getPool() is invoked.',
      );
    }

    const envPoolSize = Number(process.env['CORTEX_WORKER_POOL_SIZE'] ?? 0);
    const poolSize = size ?? (envPoolSize || Math.min(os.cpus().length, 4));

    this.pending = new Map();
    this.queues = [];
    this.workers = [];

    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(
        WORKER_INLINE_CODE,
        { eval: true, type: 'module' } as WorkerOptions & { type: 'module' },
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
    this.workers[workerIdx]!.postMessage({ id: task.id, input: task.input });
  }

  eval(input: EvalInput): Promise<EvalResult> {
    // If a real evaluator is registered, bypass the worker stub. Real eval
    // requires full state — see setEvaluator() docs.
    if (_realEvaluator) {
      return _realEvaluator(input);
    }

    return new Promise((resolve, reject) => {
      const id = nextId();
      const task: PendingTask = { id, input, resolve, reject };
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
        this.queues[idx]!.queue.push({ id, input, resolve, reject });
      }
    });
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}

// Real evaluator hook. When non-null, EvalPool.eval bypasses the worker stub
// and calls this fn.
type RealEvaluator = (input: EvalInput) => Promise<EvalResult>;
let _realEvaluator: RealEvaluator | null = null;
export function setEvaluator(fn: RealEvaluator | null): void {
  _realEvaluator = fn;
}
export function hasRealEvaluator(): boolean {
  return _realEvaluator !== null;
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
