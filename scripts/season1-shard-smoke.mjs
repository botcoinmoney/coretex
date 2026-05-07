#!/usr/bin/env node
// Season 1 corpus smoke: prove that the 10k corpus remains mineable at the
// 1-4 word patch scale when evaluated through a deterministic hidden shard.

import { loadRealCorpus, scoreState, selectScoredEvents, eventIdToMem128 } from '../experiments/harness/cortex-bench-eval.mjs';

const SHARD_ID = process.env.CORTEX_SEASON1_SMOKE_SHARD_ID ?? `0x${'42'.repeat(16)}`;
const EVAL_ITEMS_PER_FAMILY = Number(process.env.CORTEX_EVAL_ITEMS_PER_FAMILY ?? 256);
const REQUIRED_DELTA_PPM = Number(process.env.CORTEX_SEASON1_REQUIRED_DELTA_PPM ?? 500);
if (!Number.isSafeInteger(EVAL_ITEMS_PER_FAMILY) || EVAL_ITEMS_PER_FAMILY <= 0) {
  throw new Error('CORTEX_EVAL_ITEMS_PER_FAMILY must be a positive safe integer for this smoke');
}

process.env.CORTEX_CORPUS_SEASON = 'season1';
const corpus = loadRealCorpus();
const selected = selectScoredEvents(corpus.events, {
  shardId: SHARD_ID,
  evalItemsPerFamily: EVAL_ITEMS_PER_FAMILY,
});

const targetEvents = selected.long_horizon.slice(0, 4);
if (targetEvents.length < 4) throw new Error('season1 smoke needs at least 4 long_horizon shard events');

const before = { words: new Array(1024).fill(0n) };
const after = { words: [...before.words] };
for (let i = 0; i < targetEvents.length; i++) {
  const eventId = eventIdToMem128(targetEvents[i].id);
  after.words[32 + i * 8] =
    (eventId << 128n)
    | (1n << 96n)    // domainCode
    | (1n << 80n)    // objType
    | (1n << 64n);   // VALID flag
}

const scoreOpts = { shardId: SHARD_ID, evalItemsPerFamily: EVAL_ITEMS_PER_FAMILY };
const base = scoreState(before, corpus, scoreOpts);
const candidate = scoreState(after, corpus, scoreOpts);
const deltaPpm = Math.round((candidate.composite - base.composite) * 1_000_000);

const result = {
  season: 'season1',
  recordCount: corpus.sources.season1.count,
  experienceCorpusRoot: corpus.sources.season1.experienceCorpusRoot,
  shardId: SHARD_ID,
  evalItemsPerFamily: EVAL_ITEMS_PER_FAMILY,
  targetEventIds: targetEvents.map((e) => e.id),
  baselineScorePpm: Math.round(base.composite * 1_000_000),
  candidateScorePpm: Math.round(candidate.composite * 1_000_000),
  deltaPpm,
  requiredDeltaPpm: REQUIRED_DELTA_PPM,
  pass: deltaPpm >= REQUIRED_DELTA_PPM,
};
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);
