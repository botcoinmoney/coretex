#!/usr/bin/env node
// Build a §9 production CoreTex corpus from the published DACR-LT-Training
// HuggingFace dataset (botcoinmoney/dacr-lt-training).
//
// Maps coordinator S3 dataset/v2/* → §9 ProductionCorpusEvent via the
// /root/cortex/packages/cortex/src/corpus/dacr-bridge.ts bridge, runs
// the §9 admission filter, and writes a corpus JSON file the existing
// ProductionCorpusLoader can load.
//
// Usage:
//   HF_ACCESS_TOKEN=hf_xxx node scripts/build-corpus-from-dacr.mjs \
//     --domain quantum_physics,companies --max-attempts 1500 --max-pairs 200 \
//     --epoch 1 --out benchmark/fixtures/dacr-v0/coretex_dacr.json
//
// Required env: HF_ACCESS_TOKEN (read access to botcoinmoney/dacr-lt-training).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  bridgeDacrAttempt,
  bridgeDacrSequentialPair,
  admitCorpusBatch,
  DEFAULT_ADMISSION_POLICY,
  computeProductionCorpusRoot,
} from '../packages/cortex/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { domain: 'quantum_physics', maxAttempts: 1500, maxPairs: 200, epoch: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--domain') out.domain = argv[++i];
    else if (a === '--max-attempts') out.maxAttempts = Number(argv[++i]);
    else if (a === '--max-pairs') out.maxPairs = Number(argv[++i]);
    else if (a === '--epoch') out.epoch = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--policy-min-distractors') out.minDistractors = Number(argv[++i]);
  }
  if (!out.out) out.out = join(ROOT, 'benchmark/fixtures/dacr-v0/coretex_dacr.json');
  return out;
}

const HF_REPO = 'botcoinmoney/dacr-lt-training';
const HF_BASE = `https://huggingface.co/datasets/${HF_REPO}/resolve/main`;

async function fetchJsonl(path, token, hardLimit) {
  const url = `${HF_BASE}/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HF fetch ${path} -> ${res.status} ${await res.text()}`);
  const text = await res.text();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_e) {}
    if (hardLimit && out.length >= hardLimit) break;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.HF_ACCESS_TOKEN;
  if (!token) { console.error('HF_ACCESS_TOKEN not set'); process.exit(1); }
  const domains = opts.domain.split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`[build-corpus-from-dacr] domains=${domains.join(',')} maxAttempts=${opts.maxAttempts} maxPairs=${opts.maxPairs}`);

  const allEvents = [];
  for (const domain of domains) {
    console.log(`[build-corpus-from-dacr] fetching raw_attempts/${domain}/part-00000.jsonl`);
    const attempts = await fetchJsonl(`raw_attempts/${domain}/part-00000.jsonl`, token, opts.maxAttempts);
    console.log(`  loaded ${attempts.length} attempt rows`);
    let attemptEvents = 0;
    for (const att of attempts) {
      const events = bridgeDacrAttempt(att, { epochCommitted: opts.epoch, maxDistractors: 4 });
      allEvents.push(...events);
      attemptEvents += events.length;
    }
    console.log(`  emitted ${attemptEvents} retrieval-eval events from attempts`);

    try {
      console.log(`[build-corpus-from-dacr] fetching pairs_sequential/${domain}/part-00000.jsonl`);
      const pairs = await fetchJsonl(`pairs_sequential/${domain}/part-00000.jsonl`, token, opts.maxPairs);
      console.log(`  loaded ${pairs.length} pair rows`);
      let pairEvents = 0;
      for (const pair of pairs) {
        const events = bridgeDacrSequentialPair(pair, { epochCommitted: opts.epoch, maxDistractors: 4 });
        allEvents.push(...events);
        pairEvents += events.length;
      }
      console.log(`  emitted ${pairEvents} temporal events from pairs`);
    } catch (e) { console.warn(`  pairs unavailable for ${domain}: ${e.message}`); }
  }

  console.log(`[build-corpus-from-dacr] total events before admission: ${allEvents.length}`);
  const decision = admitCorpusBatch(allEvents, {
    ...DEFAULT_ADMISSION_POLICY,
    perDomainCap: 5000,
    totalCap: 20000,
    minDistractorsPerRecord: opts.minDistractors ?? 1,
  });
  console.log(`[build-corpus-from-dacr] admitted=${decision.admitted.length} rejected=${decision.rejected.length}`);
  const rejectionsByReason = new Map();
  for (const r of decision.rejected) rejectionsByReason.set(r.reason, (rejectionsByReason.get(r.reason) ?? 0) + 1);
  for (const [reason, count] of rejectionsByReason) console.log(`  rejected[${reason}]=${count}`);

  // Re-shape to the file format the ProductionCorpusLoader expects.
  const items = decision.admitted.map((e) => ({
    id: e.id,
    family: e.family,
    task: e.taskType,
    protected: e.isProtected,
    epoch_committed: e.epochCommitted,
    source_ref: e.sourceRef,
    query: e.queryText,
    truth: e.truthText,
    is_stale: e.isStaleTruth,
    relevant: e.relevant,
    distractors: e.distractors,
    relations: e.relations,
    expected_state_regions: e.expectedStateRegions,
    valid_from_epoch: e.validFromEpoch,
    expires_at_epoch: e.expiresAtEpoch,
    novelty_bucket: e.noveltyBucket,
    hardness_signal: e.hardnessSignal,
  }));
  const corpusRoot = computeProductionCorpusRoot(items);
  const corpus = {
    version: 'coretex-dacr-v0',
    source: HF_REPO,
    record_count: items.length,
    items,
    experience_corpus_root: corpusRoot,
  };
  const withoutHashes = { ...corpus };
  delete withoutHashes.experience_corpus_root;
  delete withoutHashes.corpus_hash;
  corpus.corpus_hash = createHash('sha256').update(JSON.stringify(withoutHashes)).digest('hex');
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(corpus, null, 2));
  console.log(`[build-corpus-from-dacr] wrote ${opts.out} records=${items.length} corpus_hash=${corpus.corpus_hash}`);
  console.log(`  experience_corpus_root=${corpusRoot}`);
}

main().catch((e) => { console.error(e?.stack ?? String(e)); process.exit(1); });
