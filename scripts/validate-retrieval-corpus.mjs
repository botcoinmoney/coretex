#!/usr/bin/env node
/**
 * Validate that a CoreTex retrieval corpus is launch-shaped, not merely
 * parseable. This checks the invariants that matter to the on-chain temporal
 * map benchmark: graded answer-bearing qrels, hidden splits, embedding
 * payloads, temporal/current-stale annotations, multi-hop targets, and
 * deterministic corpus-root reproduction.
 *
 * Memory note:
 *   loadProductionCorpus auto-switches to streaming NDJSON when the sidecar
 *   `<corpus>.events.ndjson` is present, so launch-scale corpora (~6 GB JSON,
 *   ~6 GB NDJSON) load fine in ~8-12 GB heap. For older corpora without a
 *   sidecar, fall back path does whole-file JSON.parse — use
 *   `node --max-old-space-size=8192 ...` for those.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit } from 'node:process';

import {
  loadProductionCorpus,
  splitForRecord,
} from '@botcoin/cortex';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const corpusPath = flag('corpus');
const outPath = flag('out', 'reports/corpus-validation.json');
const minEvents = Number(flag('min-events', '1'));
const minPerFamily = Number(flag('min-per-family', '1'));
const minHardNegatives = Number(flag('min-hard-negatives', '2'));

if (!corpusPath) {
  console.error('validate-retrieval-corpus: --corpus is required');
  exit(1);
}

const corpus = loadProductionCorpus(resolve(corpusPath));
const errors = [];
const warnings = [];

const allowedRelevance = new Set([0, 0.2, 0.4, 0.6, 0.8, 1]);
const families = new Map();
const splits = new Map();
const qrelHistogram = new Map();
const domains = new Map();

if (corpus.events.length < minEvents) {
  errors.push(`event count ${corpus.events.length} < min-events ${minEvents}`);
}

for (const event of corpus.events) {
  families.set(event.family, (families.get(event.family) ?? 0) + 1);
  splits.set(event.split, (splits.get(event.split) ?? 0) + 1);
  domains.set(event.domain, (domains.get(event.domain) ?? 0) + 1);

  if (event.split !== splitForRecord(event.id, corpus.corpusEpoch)) {
    errors.push(`${event.id}: split does not match splitForRecord`);
  }
  if (/TODO|TBD|placeholder/i.test(event.queryText)) {
    errors.push(`${event.id}: query contains placeholder text`);
  }
  const allDocs = [
    ...event.truthDocuments.map((d) => ({ ...d, kind: 'truth' })),
    ...event.hardNegatives.map((d) => ({ ...d, kind: 'negative' })),
  ];
  if (event.truthDocuments.length === 0) errors.push(`${event.id}: missing truth document`);
  if (event.hardNegatives.length < minHardNegatives) {
    errors.push(`${event.id}: hard negative count ${event.hardNegatives.length} < ${minHardNegatives}`);
  }
  for (const doc of allDocs) {
    if (!doc.text || doc.text.trim().length < 12) errors.push(`${event.id}/${doc.id}: document text too short`);
    if (/TODO|TBD|placeholder/i.test(doc.text)) errors.push(`${event.id}/${doc.id}: document contains placeholder text`);
  }

  const docIds = new Set(allDocs.map((d) => d.id));
  const qrelsById = new Map(event.qrels.map((q) => [q.documentId, q.relevance]));
  for (const docId of docIds) {
    if (!qrelsById.has(docId)) errors.push(`${event.id}: missing qrel for ${docId}`);
  }
  for (const qrel of event.qrels) {
    qrelHistogram.set(qrel.relevance, (qrelHistogram.get(qrel.relevance) ?? 0) + 1);
    if (!docIds.has(qrel.documentId)) errors.push(`${event.id}: qrel references unknown document ${qrel.documentId}`);
    if (!allowedRelevance.has(qrel.relevance)) errors.push(`${event.id}: invalid relevance ${qrel.relevance}`);
  }
  for (const truth of event.truthDocuments) {
    const rel = qrelsById.get(truth.id);
    if (truth.isCurrent && rel !== 1) errors.push(`${event.id}/${truth.id}: current truth relevance must be 1.0`);
    if (!truth.isCurrent && (rel ?? 1) > 0.4) errors.push(`${event.id}/${truth.id}: stale truth relevance must be <= 0.4`);
  }
  for (const neg of event.hardNegatives) {
    if ((qrelsById.get(neg.id) ?? 1) > 0.4) {
      errors.push(`${event.id}/${neg.id}: hard negative relevance must be <= 0.4`);
    }
  }

  const expectedBytes = event.embeddings.layout.quantization === 'int8'
    ? event.embeddings.layout.dim + 4
    : event.embeddings.layout.dim * 2;
  if (event.embeddings.query.length < expectedBytes) {
    errors.push(`${event.id}: query embedding length ${event.embeddings.query.length} < ${expectedBytes}`);
  }
  for (const truth of event.truthDocuments) {
    const emb = event.embeddings.perTruth.get(truth.id);
    if (!emb) errors.push(`${event.id}: missing truth embedding ${truth.id}`);
    else if (emb.length < expectedBytes) errors.push(`${event.id}/${truth.id}: truth embedding length ${emb.length} < ${expectedBytes}`);
  }
  for (const neg of event.hardNegatives) {
    const emb = event.embeddings.perNegative.get(neg.id);
    if (!emb) errors.push(`${event.id}: missing negative embedding ${neg.id}`);
    else if (emb.length < expectedBytes) errors.push(`${event.id}/${neg.id}: negative embedding length ${emb.length} < ${expectedBytes}`);
  }

  if (event.family === 'temporal') {
    if (!event.protected) errors.push(`${event.id}: temporal event must be protected`);
    if (!event.temporal?.currentStaleFlag) errors.push(`${event.id}: temporal currentStaleFlag is missing`);
    if (!event.truthDocuments.some((d) => d.isCurrent) || !event.truthDocuments.some((d) => !d.isCurrent)) {
      errors.push(`${event.id}: temporal event needs current and stale truth documents`);
    }
  }

  if (event.family === 'multi_hop_relation') {
    if (!event.relations || event.relations.length === 0) {
      errors.push(`${event.id}: multi-hop event missing relation annotation`);
    } else {
      for (const rel of event.relations) {
        if (!corpus.byId.has(rel.other_id)) errors.push(`${event.id}: relation target ${rel.other_id} not in corpus`);
      }
    }
  }
}

for (const family of ['near_collision', 'temporal', 'long_horizon', 'multi_hop_relation']) {
  const count = families.get(family) ?? 0;
  if (count < minPerFamily) errors.push(`family ${family} count ${count} < ${minPerFamily}`);
}

for (const split of ['train_visible', 'calibration', 'eval_hidden', 'canary']) {
  if (!splits.has(split)) warnings.push(`split ${split} has zero records in this sample`);
}

const report = {
  schemaVersion: 'coretex.corpus-validation.v1',
  generatedAt: new Date().toISOString(),
  corpusPath,
  corpusRoot: corpus.corpusRoot,
  eventCount: corpus.events.length,
  familyCounts: Object.fromEntries(families),
  splitCounts: Object.fromEntries(splits),
  domainCounts: Object.fromEntries(domains),
  qrelHistogram: Object.fromEntries(Array.from(qrelHistogram).sort((a, b) => Number(a[0]) - Number(b[0]))),
  errors,
  warnings,
};

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (errors.length > 0) exit(2);
exit(0);
