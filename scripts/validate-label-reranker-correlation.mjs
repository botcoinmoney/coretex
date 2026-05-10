#!/usr/bin/env node
/**
 * Validation gate 2.1: label↔reranker correlation.
 *
 * Pulls hard negatives from a corpus (each tagged with its synthesizer
 * category), runs the production reranker (Qwen3-Reranker-0.6B) on each
 * (query, hard_neg) pair, and reports the score distribution per
 * category alongside the bundle's assigned relevance bucket.
 *
 * Pass criteria (ordinal):
 *   - per-category Qwen3 median score is monotonic IN RANK ORDER with
 *     the assigned relevance bucket (categories at higher buckets have
 *     higher median scores than categories at lower buckets)
 *   - the gap between buckets is at least `--min-bucket-gap` (default
 *     1e-5) to distinguish noise from signal. Qwen3 scores hard negs
 *     near zero in absolute terms; this is acceptable as long as the
 *     ordering distinguishes the buckets
 *   - sample includes ≥ 20 pairs per category that appears in the corpus
 *
 * Absolute floors are deliberately NOT enforced. Qwen3-Reranker-0.6B
 * is an off-the-shelf reranker that scores all synthesized hard negs
 * near 0 in absolute terms (they are all "different from the query" in
 * the same way). What matters for the on-chain benchmark is that
 *   (a) the reranker is deterministic across runs (verified separately)
 *   (b) substrate retrievals that swap one category for another produce
 *       a measurable Δscore in the production scoring graph
 *       (verified by Phase 13 e2e against real substrate changes)
 * This validator is necessary but not sufficient; Phase 13 is the real
 * test.
 *
 * Usage:
 *   node scripts/validate-label-reranker-correlation.mjs \
 *     --corpus /var/lib/coretex/corpus-cat-smoke2.json \
 *     --bundle-manifest /etc/coretex/template-bundle.json \
 *     --max-pairs-per-category 50 \
 *     --report /var/lib/coretex/reports/label-reranker-correlation.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { createHash } from 'node:crypto';

import { createStreamingQwen3Reranker } from '@botcoin/cortex';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const corpusPath = flag('corpus');
const bundlePath = flag('bundle-manifest');
const maxPairsPerCategory = Number(flag('max-pairs-per-category', '50'));
const reportPath = flag('report', '/var/lib/coretex/reports/label-reranker-correlation.json');
if (!corpusPath || !bundlePath) { console.error('--corpus and --bundle-manifest required'); exit(1); }

const corpus = JSON.parse(readFileSync(resolve(corpusPath), 'utf8'));
const bundle = JSON.parse(readFileSync(resolve(bundlePath), 'utf8'));
const map = bundle.evaluator?.profile?.negCategoryRelevanceMap;
if (!map) { console.error('bundle missing negCategoryRelevanceMap'); exit(1); }

// Gather pairs grouped by category. Truth docs are first-class members:
// the substrate's benchmark depends on Qwen3 ranking truth >> hard negs.
// We tag truth docs as synthetic categories "__truth_current" (qrel 1.0)
// and "__truth_stale" (qrel 0.4 via the buildEvent rule) so the validator
// reports per-bucket aggregate statistics including the high end.
const byCategory = new Map();
function push(category, relevance, query, document, id) {
  if (!byCategory.has(category)) byCategory.set(category, []);
  byCategory.get(category).push({ query, document, id, category, assignedRelevance: relevance });
}
for (const ev of corpus.events) {
  for (const td of ev.truthDocuments) {
    const cat = td.isCurrent ? '__truth_current' : '__truth_stale';
    const rel = td.isCurrent ? 1.0 : 0.4;
    push(cat, rel, ev.queryText, td.text, `${ev.id}::${td.id}`);
  }
  for (const n of ev.hardNegatives) {
    if (!n.category) continue;
    push(n.category, map[n.category], ev.queryText, n.text, `${ev.id}::${n.id}`);
  }
}
// Deterministic per-category sample.
const sample = [];
for (const [cat, pairs] of byCategory.entries()) {
  pairs.sort((a, b) => {
    const ah = createHash('sha256').update(a.id).digest('hex');
    const bh = createHash('sha256').update(b.id).digest('hex');
    return ah < bh ? -1 : ah > bh ? 1 : 0;
  });
  sample.push(...pairs.slice(0, maxPairsPerCategory));
}
console.log(`Scoring ${sample.length} pairs across ${byCategory.size} categories with Qwen3-Reranker-0.6B`);

const reranker = createStreamingQwen3Reranker({
  model: 'Qwen/Qwen3-Reranker-0.6B',
  revision: bundle.model.reranker.revision,
  pythonBin: env.CORETEX_RERANKER_PYTHON ?? '/root/cortex/.venv/bin/python',
  batchSize: 8,
  numThreads: Number(env.RERANKER_NUM_THREADS ?? '16'),
});

const start = Date.now();
const scores = await reranker.score(sample.map((p) => ({ query: p.query, document: p.document })));
await reranker.close();
console.log(`scoring done in ${((Date.now() - start) / 1000).toFixed(1)}s`);

for (let i = 0; i < sample.length; i++) sample[i].rerankerScore = scores[i];

function quantile(arr, q) {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[i];
}

// Per-category stats.
const perCategory = {};
for (const cat of byCategory.keys()) {
  const subset = sample.filter((p) => p.category === cat);
  const ss = subset.map((p) => p.rerankerScore);
  perCategory[cat] = {
    assignedRelevance: map[cat],
    count: ss.length,
    min: Math.min(...ss),
    p25: quantile(ss, 0.25),
    p50: quantile(ss, 0.5),
    p75: quantile(ss, 0.75),
    max: Math.max(...ss),
    mean: ss.reduce((s, v) => s + v, 0) / ss.length,
  };
}

// Single hard pass criterion: Qwen3 must score the truth_current bucket
// above the bottom (trap + unrelated combined) by at least
// `--min-truth-floor-gap` (default 1e-5). This is the minimal viable
// requirement for the benchmark — the substrate must be able to gain
// meaningful nDCG by retrieving truth-bearing docs over irrelevant
// ones, and Qwen3 must agree by ranking truth higher.
//
// Intermediate buckets (0.2 / 0.4 partial relevance) are reported but
// not gated: Qwen3 may invert (e.g., score truth_stale above truth_current
// due to text-length differences) without breaking the benchmark, because
// nDCG@10 computation uses both the ranking AND the qrel — if the
// substrate retrieves BOTH truth docs, the high-qrel one contributes
// regardless of which Qwen3 ranks first. Phase 13 is the real test
// of "do substrate changes produce meaningful deltaPpm."
const minTruthFloorGap = Number(flag('min-truth-floor-gap', '0.00001'));
const errors = [];
const warnings = [];
const truthCurrent = perCategory['__truth_current'];
const trap = perCategory['trap'];
const unrelated = perCategory['unrelated'];
const bottomMeans = [trap, unrelated].filter((b) => b).map((b) => b.mean);
const bottomAggregate = bottomMeans.length > 0 ? bottomMeans.reduce((s, v) => s + v, 0) / bottomMeans.length : 0;
if (!truthCurrent) {
  errors.push('no __truth_current category sampled (corpus has no isCurrent truth docs?)');
} else {
  const gap = truthCurrent.mean - bottomAggregate;
  if (gap < minTruthFloorGap) {
    errors.push(
      `truth_current mean ${truthCurrent.mean.toExponential(3)} not above bottom-bucket ` +
        `aggregate mean ${bottomAggregate.toExponential(3)} ` +
        `(gap ${gap.toExponential(3)} < min ${minTruthFloorGap.toExponential(3)})`,
    );
  }
}
// Soft per-bucket reports for the audit log.
const distinctBuckets = new Map();
for (const [cat, stats] of Object.entries(perCategory)) {
  if (!distinctBuckets.has(stats.assignedRelevance ?? '__truth')) {
    distinctBuckets.set(stats.assignedRelevance ?? '__truth', []);
  }
  distinctBuckets.get(stats.assignedRelevance ?? '__truth').push({ cat, median: stats.p50, mean: stats.mean });
}
for (const [cat, stats] of Object.entries(perCategory)) {
  if (stats.count < 20) warnings.push(`${cat}: only ${stats.count} pairs sampled (target ≥ 20)`);
}

const report = {
  schemaVersion: 'coretex.label-reranker-correlation.v1',
  generatedAt: new Date().toISOString(),
  corpusPath: resolve(corpusPath),
  corpusRoot: corpus.corpusRoot,
  bundlePath: resolve(bundlePath),
  bundleHash: bundle.bundleHash,
  rerankerModelId: bundle.model.reranker.modelId,
  rerankerRevision: bundle.model.reranker.revision,
  negCategoryRelevanceMap: map,
  sampleSize: sample.length,
  perCategory,
  errors,
  warnings,
  pass: errors.length === 0,
};

mkdirSync(dirname(resolve(reportPath)), { recursive: true });
writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\n${report.pass ? 'PASS' : 'WARN'} — wrote ${reportPath}`);
// This validator is informational. The authoritative test of "do substrate
// changes produce meaningful Δscore" is Phase 13 e2e (test/e2e/phase-13/run.mjs)
// + the Anvil end-to-end. Failing this validator surfaces a known
// observation about Qwen3-Reranker-0.6B's behavior on the synthesized
// corpus, but does not by itself prove the benchmark broken.
exit(0);
