#!/usr/bin/env node
/**
 * Offline corpus auditor.
 *
 * Replaces the per-event MemReranker-4B labeling call that the
 * synthesizer-labeled corpus pipeline removed from the production hot
 * path. This script runs once per corpus delta to confirm the bundle's
 * `negCategoryRelevanceMap` is still a faithful proxy for the larger
 * labeling reranker's per-pair score distribution.
 *
 * It samples events from a corpus, runs the bundle's pinned labeling
 * reranker (default MemReranker-4B) on a fraction of (query, hard_neg)
 * pairs, and reports the disagreement rate between MemReranker's
 * bucketed score and the synthesizer's category-derived label. Per-delta
 * cost: ~1% of the per-event labeling cost the old pipeline paid.
 *
 * Audit policy:
 *   - sample N% of events (default 1%, override --sample-pct)
 *   - for each sampled event, score every (query, hard_neg) pair via
 *     the labeling reranker
 *   - bucket the score using the same thresholds the legacy
 *     `labelHardNegative()` used: ≥0.55 → 0.4, ≥0.25 → 0.2, else 0.0
 *   - compare to the synthesizer's category-derived bucket
 *   - report per-category and per-bucket disagreement rates plus a
 *     few representative disagreement examples
 *
 * Exit:
 *   0  → audit complete (always; this is a diagnostic, not a gate)
 *   1  → script error
 *
 * Usage:
 *   node scripts/audit-corpus-with-labeler.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
 *     --bundle-manifest /etc/coretex/bundle-manifest.json \
 *     --sample-pct 1 \
 *     --max-pairs 200 \
 *     --report /var/lib/coretex/reports/corpus-labeler-audit.json
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
const samplePct = Number(flag('sample-pct', '1'));
const maxPairs = Number(flag('max-pairs', '500'));
const reportPath = flag('report', '/var/lib/coretex/reports/corpus-labeler-audit.json');
if (!corpusPath || !bundlePath) {
  console.error('--corpus and --bundle-manifest required');
  exit(1);
}

const corpus = JSON.parse(readFileSync(resolve(corpusPath), 'utf8'));
const bundle = JSON.parse(readFileSync(resolve(bundlePath), 'utf8'));
const map = bundle.evaluator?.profile?.negCategoryRelevanceMap;
if (!map) { console.error('bundle missing negCategoryRelevanceMap'); exit(1); }

// Deterministic event sample: sort all events by sha256(id), take the
// leading samplePct%. This is reproducible across runs given the same
// corpus root.
const events = [...corpus.events];
events.sort((a, b) => {
  const ah = createHash('sha256').update(a.id).digest('hex');
  const bh = createHash('sha256').update(b.id).digest('hex');
  return ah < bh ? -1 : ah > bh ? 1 : 0;
});
const sampleCount = Math.max(1, Math.floor((samplePct / 100) * events.length));
const sampled = events.slice(0, sampleCount);

// Build (query, doc, category, assignedRelevance) pair list, capped at
// --max-pairs after deterministic sort.
const pairs = [];
for (const ev of sampled) {
  for (const n of ev.hardNegatives) {
    if (!n.category) continue;
    pairs.push({
      eventId: ev.id,
      negId: n.id,
      query: ev.queryText,
      document: n.text,
      category: n.category,
      assignedRelevance: map[n.category] ?? null,
    });
  }
}
pairs.sort((a, b) => {
  const ah = createHash('sha256').update(`${a.eventId}::${a.negId}`).digest('hex');
  const bh = createHash('sha256').update(`${b.eventId}::${b.negId}`).digest('hex');
  return ah < bh ? -1 : ah > bh ? 1 : 0;
});
const auditPairs = pairs.slice(0, maxPairs);
console.log(
  `[audit] corpus=${corpus.corpusRoot} sampled ${sampleCount}/${events.length} events ` +
    `(${samplePct}%) → ${auditPairs.length} pairs (capped at ${maxPairs})`,
);

const labelingModelId = bundle.model.labelingReranker.modelId;
const labelingRevision = bundle.model.labelingReranker.revision;
console.log(`[audit] labeling reranker: ${labelingModelId}@${labelingRevision.slice(0, 8)}`);

const reranker = createStreamingQwen3Reranker({
  model: labelingModelId,
  revision: labelingRevision,
  pythonBin: env.CORETEX_RERANKER_PYTHON ?? '/root/cortex/.venv/bin/python',
  batchSize: 8,
  numThreads: Number(env.RERANKER_NUM_THREADS ?? '16'),
});

const start = Date.now();
const scores = await reranker.score(auditPairs.map((p) => ({ query: p.query, document: p.document })));
await reranker.close();
const elapsed = (Date.now() - start) / 1000;
console.log(`[audit] scored ${auditPairs.length} pairs in ${elapsed.toFixed(1)}s ` +
  `(${(auditPairs.length / elapsed).toFixed(2)} pairs/s)`);

// Bucket the labeling reranker's score to the same {0.0, 0.2, 0.4} range
// the legacy per-event labelHardNegative() used.
function bucketScore(score) {
  if (score >= 0.55) return 0.4;
  if (score >= 0.25) return 0.2;
  return 0.0;
}

const perCategory = {};
const disagreementsExamples = [];
for (let i = 0; i < auditPairs.length; i++) {
  const p = auditPairs[i];
  const labelerScore = scores[i];
  const labelerBucket = bucketScore(labelerScore);
  const synthBucket = p.assignedRelevance;
  const agree = synthBucket === labelerBucket;
  const cat = p.category;
  if (!perCategory[cat]) perCategory[cat] = { agree: 0, disagree: 0, scoreSum: 0, count: 0 };
  perCategory[cat].count += 1;
  perCategory[cat].scoreSum += labelerScore;
  if (agree) perCategory[cat].agree += 1;
  else {
    perCategory[cat].disagree += 1;
    if (disagreementsExamples.length < 10) {
      disagreementsExamples.push({
        eventId: p.eventId,
        negId: p.negId,
        category: p.category,
        synthBucket,
        labelerScore,
        labelerBucket,
        queryPrefix: p.query.slice(0, 80),
        docPrefix: p.document.slice(0, 80),
      });
    }
  }
}

const summary = {};
for (const [cat, s] of Object.entries(perCategory)) {
  summary[cat] = {
    assignedBucket: map[cat],
    pairs: s.count,
    agreePct: (100 * s.agree) / s.count,
    disagreePct: (100 * s.disagree) / s.count,
    labelerMeanScore: s.scoreSum / s.count,
  };
}
const totalAgree = Object.values(perCategory).reduce((s, v) => s + v.agree, 0);
const overallAgreePct = (100 * totalAgree) / auditPairs.length;

const report = {
  schemaVersion: 'coretex.corpus-labeler-audit.v1',
  generatedAt: new Date().toISOString(),
  corpusPath: resolve(corpusPath),
  corpusRoot: corpus.corpusRoot,
  bundlePath: resolve(bundlePath),
  bundleHash: bundle.bundleHash,
  labelingModelId,
  labelingRevision,
  negCategoryRelevanceMap: map,
  sampledEvents: sampleCount,
  totalEvents: events.length,
  scoredPairs: auditPairs.length,
  scoringWallSeconds: elapsed,
  overallAgreePct,
  perCategory: summary,
  disagreementsExamples,
};

mkdirSync(dirname(resolve(reportPath)), { recursive: true });
writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2));
console.log(`[audit] wrote ${reportPath}`);
console.log(`[audit] overall agreement: ${overallAgreePct.toFixed(1)}%`);
for (const [cat, s] of Object.entries(summary)) {
  console.log(`  ${cat}: assigned=${s.assignedBucket}, ` +
    `${s.agreePct.toFixed(1)}% agree (${s.pairs} pairs), ` +
    `mean labeler score=${s.labelerMeanScore.toExponential(3)}`);
}
exit(0);
