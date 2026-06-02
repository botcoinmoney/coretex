/**
 * Shared persistent stream reranker client (Qwen3-Reranker via reranker_runner.py
 * --stream). Loads model + CUDA once; implements CrossEncoderReranker
 * `score(pairs) -> number[]`. GPU via CORETEX_RERANKER_ALLOW_CUDA=1 with
 * CUDA_VISIBLE_DEVICES UNSET (the runner's escape hatch); see A100_RUNNER.md.
 *
 * Fail-fast contract:
 *   - readyP rejects if the child exits before printing {"ready": true}
 *   - readyP rejects if spawn errors
 *   - readyP rejects after CORETEX_RERANKER_STARTUP_TIMEOUT_MS (default 600_000)
 *   - all rejection paths propagate the child's stderr (last ~2KB) in the error
 *   - any in-flight score() request after child exit/error is rejected, not left hanging
 *
 * Stderr is captured (not inherited) so the rejection error carries real diagnostic text.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { repoRoot } from '../_repo-root.mjs';

export function makeStreamReranker({ model, revision, python, allowCuda }) {
  const spawnStartMs = Date.now();
  const env = {
    ...process.env,
    CORETEX_RERANKER_STREAM_MODEL_ID: model,
    CORETEX_RERANKER_STREAM_REVISION: revision,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE ?? '/var/lib/coretex/model-cache',
    HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1',
  };
  if (allowCuda) { env.CORETEX_RERANKER_ALLOW_CUDA = '1'; delete env.CUDA_VISIBLE_DEVICES; }
  else { env.CUDA_VISIBLE_DEVICES = ''; }

  const startupTimeoutMs = Number(process.env.CORETEX_RERANKER_STARTUP_TIMEOUT_MS ?? '600000');
  const proc = spawn(python, [resolve(repoRoot, 'scripts/reranker_runner.py'), '--stream'], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Capture stderr for diagnostic output (last ~2KB rolling buffer to bound memory).
  let stderrBuf = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => { stderrBuf = (stderrBuf + chunk).slice(-2048); });

  let stdoutBuf = '';
  let nextId = 0;
  const pending = new Map();
  let exited = false;
  let exitErr = null;
  let ready = false;
  let readyAtMs = null;

  let readyResolve, readyReject;
  const readyP = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  const startupTimer = setTimeout(() => {
    if (!exited) {
      const err = new Error(`reranker startup timed out after ${startupTimeoutMs}ms — stderr tail: ${stderrBuf.slice(-1024)}`);
      readyReject(err);
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }
  }, startupTimeoutMs);
  startupTimer.unref?.();

  function rejectAllPending(err) {
    for (const [id, fn] of pending) fn({ error: err.message });
    pending.clear();
  }

  proc.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (!ready && m.error) {
        exitErr = new Error(`reranker startup error: ${m.error} — stderr tail: ${stderrBuf.slice(-1024)}`);
        clearTimeout(startupTimer);
        readyReject(exitErr);
        try { proc.kill('SIGTERM'); } catch { /* noop */ }
        continue;
      }
      if (m.ready) { ready = true; readyAtMs = Date.now(); clearTimeout(startupTimer); readyResolve(); continue; }
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    }
  });

  proc.on('error', (e) => {
    exited = true;
    exitErr = new Error(`reranker spawn error: ${e.message} — stderr tail: ${stderrBuf.slice(-1024)}`);
    clearTimeout(startupTimer);
    readyReject(exitErr);
    rejectAllPending(exitErr);
  });

  proc.on('exit', (code, signal) => {
    exited = true;
    if (!exitErr) {
      exitErr = new Error(`reranker child exited (code=${code}, signal=${signal}) — stderr tail: ${stderrBuf.slice(-1024)}`);
    }
    clearTimeout(startupTimer);
    // readyReject is idempotent (Promise already settled if ready fired); reject anyway for the not-yet-ready case.
    readyReject(exitErr);
    rejectAllPending(exitErr);
  });

  return {
    model,
    revision,
    mode: allowCuda ? 'gpu' : 'cpu',
    modelStartupMs() {
      return readyAtMs === null ? null : readyAtMs - spawnStartMs;
    },
    async score(pairs) {
      if (!pairs?.length) return [];
      await readyP;
      if (exited) throw exitErr ?? new Error('reranker child no longer running');
      const id = nextId++;
      const p = new Promise((res) => pending.set(id, res));
      proc.stdin.write(JSON.stringify({ id, pairs: pairs.map((x) => ({ query: x.query, document: x.document })) }) + '\n');
      const m = await p;
      if (m.error) throw new Error(m.error);
      return m.scores;
    },
    async close() {
      if (exited) return;
      try { proc.stdin.end(); } catch { /* noop */ }
      await new Promise((res) => {
        if (exited) return res();
        proc.once('exit', () => res());
      });
    },
  };
}
