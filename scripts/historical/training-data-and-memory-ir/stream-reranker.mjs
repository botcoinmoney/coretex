/**
 * Shared persistent stream reranker client (Qwen3-Reranker via reranker_runner.py
 * --stream). Loads model + CUDA once; implements CrossEncoderReranker
 * `score(pairs) -> number[]`. GPU via CORETEX_RERANKER_ALLOW_CUDA=1 with
 * CUDA_VISIBLE_DEVICES UNSET (the runner's escape hatch); see A100_RUNNER.md.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { repoRoot } from '../_repo-root.mjs';

export function makeStreamReranker({ model, revision, python, allowCuda }) {
  const env = { ...process.env, CORETEX_RERANKER_STREAM_MODEL_ID: model, CORETEX_RERANKER_STREAM_REVISION: revision,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE ?? '/var/lib/coretex/model-cache', HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' };
  if (allowCuda) { env.CORETEX_RERANKER_ALLOW_CUDA = '1'; delete env.CUDA_VISIBLE_DEVICES; } else { env.CUDA_VISIBLE_DEVICES = ''; }
  const proc = spawn(python, [resolve(repoRoot, 'scripts/reranker_runner.py'), '--stream'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', nextId = 0; const pending = new Map(); let readyR; const readyP = new Promise((r) => { readyR = r; });
  proc.stdout.on('data', (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.ready) { readyR(); continue; } if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  proc.on('exit', (c) => { for (const [, r] of pending) r({ error: `reranker stream exited ${c}` }); });
  return {
    async score(pairs) { if (!pairs?.length) return []; await readyP; const id = nextId++; const p = new Promise((res) => pending.set(id, res)); proc.stdin.write(JSON.stringify({ id, pairs: pairs.map((x) => ({ query: x.query, document: x.document })) }) + '\n'); const m = await p; if (m.error) throw new Error(m.error); return m.scores; },
    close() { try { proc.stdin.end(); } catch { /* noop */ } },
  };
}
