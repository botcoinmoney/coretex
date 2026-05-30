#!/usr/bin/env node
/**
 * Category-A abstention margin-gate sweep (real Qwen).
 *
 * The abstention decision is a SPLIT: miner atom = public no-evidence-path selector; operator profile =
 * a CONFIDENCE gate. r5.1 shipped a top1-only gate (7/10 caught, ~6.7–21% false). Category A adds a
 * top1−top2 MARGIN gate (low margin = no clear winner / weak bundle) combined with top1 (never top1 alone).
 *
 * This probe runs ONE real-Qwen scoring pass over the largest derivable pack, exports each query's
 * top1 + top2 (margin) + logical family, then sweeps (top1Thr, marginThr) OFFLINE — no per-threshold
 * reranking. Reports, per operating point: abstainCorrect (over abstention_missing) and falseAbstention
 * (over answerable). Isolates whether the margin gate lowers false-abstention at fixed abstain-recall.
 *
 * Usage: node scripts/probe-r5-abstention-margin.mjs [--pack-size 200] [--reranker gpu] [--out ..]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadV2CompatBundle } from './lib/load-materialized-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const C = await import(distIndex);
const { scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState, createDeterministicReranker } = C;

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-r5-synth-embeddings.json`);
const r5ProfilePath = flag('r5-profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json');
const packSize = Number(flag('pack-size', '200'));
const outPath = flag('out', `${base}/r5-abstention-margin.json`);
const rerankerArg = flag('reranker', 'deterministic');
const bundlePath = flag('bundle');
if (!bundlePath) { console.error('HARD FAIL: --bundle <path> required (calibration uses materialized corpus)'); process.exit(1); }

const r5Profile = JSON.parse(readFileSync(resolve(repoRoot, r5ProfilePath), 'utf8'));
const { corpus, logical, LAYOUT, BE, RR, biEncoderHash } = loadV2CompatBundle(bundlePath, corpusPath, embPath);
const reranker = rerankerArg === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const opts = { ...scoringOptionsFromProfile(r5Profile, rt), exposeFullRanking: true };

const seedHex = '0x' + createHash('sha256').update('r5-abstention-margin').digest('hex');
const pack = deriveQueryPack(1, seedHex, corpus, { ...r5Profile.hiddenPack, packSize, quotas: [] });
const famOf = new Map(logical.queries.map((q) => [q.id, q.family]));
console.error(`[abst] pack=${pack.events.length} q`);

const empty = { words: new Array(1024).fill(0n) };
const R = await evaluateRetrievalBenchmarkState(empty, corpus, pack, opts);

// per-query top1/top2 (margin) + logical family
const rows = [];
for (const q of R.perQuery) {
  const fr = q.finalRankingTop20 ?? [];
  const top1 = fr[0]?.rerankerScore ?? q.top1Score ?? 0;
  const top2 = fr[1]?.rerankerScore ?? 0;
  rows.push({ id: q.recordId, family: famOf.get(q.recordId) ?? q.family, top1, top2, margin: top1 - top2 });
}
const abst = rows.filter((r) => r.family === 'abstention_missing');
const ans = rows.filter((r) => r.family !== 'abstention_missing');
console.error(`[abst] abstention=${abst.length} answerable=${ans.length}`);

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const stats = (rs) => ({ n: rs.length, top1Mean: +mean(rs.map((r) => r.top1)).toFixed(5), marginMean: +mean(rs.map((r) => r.margin)).toFixed(5) });

// separation AUC for top1 (abstention SHOULD score lower) and for margin
function auc(pos, neg, key) { // P(neg[key] > pos[key]) — answerable should out-score abstention on top1
  let c = 0, t = 0; for (const a of pos) for (const b of neg) { t++; if (b[key] > a[key]) c++; else if (b[key] === a[key]) c += 0.5; } return t ? +(c / t).toFixed(4) : 0;
}

// sweep (top1Thr, marginThr): abstain iff top1<top1Thr AND margin<marginThr
const top1Grid = [...new Set([...abst, ...ans].map((r) => +r.top1.toFixed(4)))].sort((a, b) => a - b);
const t1Cands = [0, ...top1Grid.filter((_, i) => i % Math.max(1, Math.floor(top1Grid.length / 12)) === 0), 1.0001];
const marginCands = [0.00005, 0.0001, 0.0002, 0.0003, 0.0005, 0.001, 0.002, 0.005, 0.01, 1.0];
const sweep = [];
for (const t1 of t1Cands) for (const mg of marginCands) {
  const correct = abst.filter((r) => r.top1 < t1 && r.margin < mg).length;
  const false_ = ans.filter((r) => r.top1 < t1 && r.margin < mg).length;
  sweep.push({ top1Thr: +t1.toFixed(4), marginThr: mg, abstainCorrect: correct, abstainRecall: +(correct / Math.max(1, abst.length)).toFixed(3), falseAbstain: false_, falseAbstentionRate: +(false_ / Math.max(1, ans.length)).toFixed(4) });
}
// best operating points: maximize abstainRecall subject to falseAbstentionRate <= target
const pick = (maxFalse) => sweep.filter((s) => s.falseAbstentionRate <= maxFalse).sort((a, b) => b.abstainCorrect - a.abstainCorrect || a.falseAbstain - b.falseAbstain)[0] ?? null;

const report = {
  probe: 'r5-abstention-margin (Category A). One real-Qwen pass; thresholds swept offline.',
  generatedAt: new Date().toISOString(), corpus: corpusPath, reranker: rerankerArg === 'gpu' ? 'Qwen3-Reranker-0.6B (gpu)' : 'deterministic-stub',
  counts: { abstention: abst.length, answerable: ans.length },
  distributions: { abstention: stats(abst), answerable: stats(ans) },
  separationAUC: { top1: auc(abst, ans, 'top1'), margin: auc(abst, ans, 'margin'), note: 'P(answerable out-scores abstention); higher = better separation' },
  bestOperatingPoints: { 'falseAbst<=0.05': pick(0.05), 'falseAbst<=0.10': pick(0.10), 'falseAbst<=0.15': pick(0.15) },
  marginGateEffect: { note: 'compare same top1Thr at marginThr=1.0 (top1-only) vs a tight marginThr — does adding the margin gate cut falseAbstain without losing abstainCorrect?' },
  sweep,
};
mkdirSync(resolve(repoRoot, base), { recursive: true });
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ counts: report.counts, distributions: report.distributions, separationAUC: report.separationAUC, bestOperatingPoints: report.bestOperatingPoints }, null, 2));
if (typeof reranker.close === 'function') reranker.close();
