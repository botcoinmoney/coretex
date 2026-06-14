#!/usr/bin/env node
/**
 * Layer 4 — Qwen-0.6B verifier-candidate test for Corpus V2.
 *
 * Question (Layer 4 gate): does routing BETTER EVIDENCE into the reranker
 * improve final metrics — not by leaking labels, but because the answer now
 * reaches the reranker? Compares two candidate pools at a cheap cap K:
 *   - dense   : stage-1 dense top-K (BGE-M3 int8/243)
 *   - teacher : Layer-3 teacher top-K (hybrid + entity + temporal + relation hop)
 * Each pool is reranked by the pinned Qwen3-Reranker-0.6B; we score recall@10
 * and NDCG@10 against qrels, plus "answer-in-pool" rate (the routing precondition).
 *
 * Defaults to the 3 lever families (temporal_update / multi_session_bridge /
 * causal_memory_chain) to keep the CPU Qwen workload bounded.
 *
 * Run DETACHED (heavy Qwen load — [[feedback_detached_heavy_jobs]]).
 * Usage: node scripts/verifier-qwen-v2.mjs <corpus.json> <rankings.json> [--cap 20] [--families all] [--out dir]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { cpus } from 'node:os';
import { repoRoot } from './_repo-root.mjs';

const MANIFEST = resolve(repoRoot, 'release/bundle/bundle-manifest-v2-ownerscope-candidate.json');
const PYTHON = process.env.CORETEX_RERANKER_PYTHON ?? resolve(repoRoot, '.venv/bin/python');
const CACHE_DIR = process.env.CORTEX_LOCAL_MODEL_CACHE ?? '/var/lib/coretex/model-cache';
const LEVER = new Set(['temporal_update', 'multi_session_bridge', 'causal_memory_chain']);

function rerank(pairs, threads) {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8')).model.reranker;
  const payload = JSON.stringify({ model: m.modelId, revision: m.revision, pairs });
  // GPU on the A100 box: set CORETEX_RERANKER_ALLOW_CUDA=1 and leave CUDA_VISIBLE_DEVICES unset.
  // Default (local): CPU-only (CUDA_VISIBLE_DEVICES='').
  const allowCuda = process.env.CORETEX_RERANKER_ALLOW_CUDA === '1';
  const env = { ...process.env, HF_HUB_CACHE: CACHE_DIR, HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1', RERANKER_NUM_THREADS: String(threads ?? Math.max(1, cpus().length)) };
  if (!allowCuda) env.CUDA_VISIBLE_DEVICES = '';
  return new Promise((res, rej) => {
    const proc = spawn(PYTHON, [resolve(repoRoot, 'scripts/reranker_runner.py')], {
      env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    proc.stdout.on('data', (d) => out += d.toString());
    proc.on('error', rej);
    proc.on('close', (code) => {
      if (code !== 0) return rej(new Error(`reranker exited ${code}`));
      try { const p = JSON.parse(out); if (p.error) return rej(new Error(p.error)); res(p.scores); } catch (e) { rej(new Error(`bad reranker output: ${e.message}: ${out.slice(0, 200)}`)); }
    });
    proc.stdin.write(payload); proc.stdin.end();
  });
}

const ndcg10 = (rankedRel) => {
  const dcg = rankedRel.slice(0, 10).reduce((s, rel, i) => s + (Math.pow(2, rel) - 1) / Math.log2(i + 2), 0);
  const ideal = [...rankedRel].sort((a, b) => b - a).slice(0, 10).reduce((s, rel, i) => s + (Math.pow(2, rel) - 1) / Math.log2(i + 2), 0);
  return ideal > 0 ? dcg / ideal : 0;
};

async function main() {
  const args = process.argv.slice(2);
  const [corpusPath, rankingsPath] = args.filter((a) => !a.startsWith('--'));
  const cap = parseInt((() => { const i = args.indexOf('--cap'); return i >= 0 ? args[i + 1] : '20'; })(), 10);
  const famMode = (() => { const i = args.indexOf('--families'); return i >= 0 ? args[i + 1] : 'lever'; })();
  const poolMode = (() => { const i = args.indexOf('--pools'); return i >= 0 ? args[i + 1] : 'both'; })();
  const wantPools = poolMode === 'both' ? ['dense', 'teacher'] : [poolMode];
  const outDir = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : 'release/calibration/2026-05-21-memory-corpus-v2'; })();
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const docText = new Map(corpus.docs.map((d) => [d.id, d.text]));
  const rankings = JSON.parse(readFileSync(rankingsPath, 'utf8'));
  const qs = rankings.filter((r) => famMode === 'all' ? true : LEVER.has(r.family));

  // build all pairs (dense pool then teacher pool) with index bookkeeping
  const pairs = [];
  const meta = []; // {qi, pool, docId}
  for (let i = 0; i < qs.length; i++) {
    const r = qs[i];
    for (const [pool, list] of [['dense', r.denseTop], ['teacher', r.teacherTop]]) {
      if (!wantPools.includes(pool)) continue;
      for (const docId of list.slice(0, cap)) { pairs.push({ query: r.query, document: docText.get(docId) ?? '' }); meta.push({ qi: i, pool, docId }); }
    }
  }
  console.error(`[layer4] reranking ${pairs.length} pairs (${qs.length} queries × ${cap} cap × 2 pools) on Qwen3-0.6B…`);
  const t0 = Date.now();
  const scores = await rerank(pairs);
  console.error(`[layer4] reranked in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // regroup scores per query/pool
  const byQP = new Map(); // `${qi}|${pool}` -> [{docId,score}]
  scores.forEach((sc, k) => { const { qi, pool, docId } = meta[k]; const key = `${qi}|${pool}`; if (!byQP.has(key)) byQP.set(key, []); byQP.get(key).push({ docId, score: sc }); });

  const fam = {};
  const ensure = (f) => fam[f] ?? (fam[f] = { n: 0, dense: { recall10: 0, ndcg10: 0, inPool: 0 }, teacher: { recall10: 0, ndcg10: 0, inPool: 0 } });
  const perQuery = [];
  for (let i = 0; i < qs.length; i++) {
    const r = qs[i];
    const relOf = new Map((r.qrels ?? []).map((q) => [q.docId, q.relevance]));
    const directIds = new Set((r.qrels ?? []).filter((q) => q.relevance >= 0.8).map((q) => q.docId));
    const F = ensure(r.family); const A = ensure('__all__'); F.n++; A.n++;
    const row = { queryId: r.queryId, family: r.family };
    for (const pool of ['dense', 'teacher']) {
      const cand = (byQP.get(`${i}|${pool}`) ?? []).slice().sort((a, b) => b.score - a.score);
      const top10 = cand.slice(0, 10);
      const recall10 = top10.some((c) => directIds.has(c.docId)) ? 1 : 0;
      const rankedRel = cand.map((c) => relOf.get(c.docId) ?? 0);
      const nd = ndcg10(rankedRel);
      const inPool = cand.some((c) => directIds.has(c.docId)) ? 1 : 0;
      F[pool].recall10 += recall10; F[pool].ndcg10 += nd; F[pool].inPool += inPool;
      A[pool].recall10 += recall10; A[pool].ndcg10 += nd; A[pool].inPool += inPool;
      row[pool] = { recall10, ndcg10: +nd.toFixed(3), inPool };
    }
    perQuery.push(row);
  }

  const lines = [];
  lines.push(`# Layer 4 — Qwen-0.6B verifier (cap ${cap}, families=${famMode})`);
  lines.push('');
  lines.push(`Pinned Qwen3-Reranker-0.6B reranks dense-stage1 vs teacher-routed top-${cap} pools. Metrics vs qrels.`);
  lines.push('"inPool" = answer present in the cap pool at all (the routing precondition Qwen cannot fix).');
  lines.push('');
  lines.push('| family | n | dense recall@10 | teacher recall@10 | dense ndcg@10 | teacher ndcg@10 | dense inPool | teacher inPool |');
  lines.push('|---|--:|--:|--:|--:|--:|--:|--:|');
  const fmt = (o, pool, k) => o.n ? +(o[pool][k] / o.n).toFixed(2) : null;
  for (const f of [...Object.keys(fam).filter((x) => x !== '__all__').sort(), '__all__']) {
    const o = fam[f];
    lines.push(`| ${f} | ${o.n} | ${fmt(o, 'dense', 'recall10')} | ${fmt(o, 'teacher', 'recall10')} | ${fmt(o, 'dense', 'ndcg10')} | ${fmt(o, 'teacher', 'ndcg10')} | ${fmt(o, 'dense', 'inPool')} | ${fmt(o, 'teacher', 'inPool')} |`);
  }
  const report = { specVersion: corpus.specVersion, phase: corpus.phase, cap, famMode, reranker: 'Qwen/Qwen3-Reranker-0.6B (pinned)', families: fam, perQuery };
  writeFileSync(resolve(outDir, `LAYER4_QWEN_cap${cap}.json`), JSON.stringify(report, null, 2));
  writeFileSync(resolve(outDir, `LAYER4_QWEN_cap${cap}.md`), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
main().catch((e) => { console.error(e); process.exit(1); });
