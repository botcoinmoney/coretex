#!/usr/bin/env node
// Cron-friendly DACR → CoreTex corpus delta publisher.
//
// Example:
//   HF_ACCESS_TOKEN=... node scripts/build-corpus-delta-from-dacr.mjs \
//     --previous benchmark/fixtures/dacr-v0/coretex_dacr.json \
//     --domain quantum_physics,companies --epoch 2 --bundle-hash 0x... \
//     --out-dir ops/coretex-epochs/2

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bridgeDacrBatch,
  admitCorpusBatch,
  DEFAULT_ADMISSION_POLICY,
  buildCorpusDelta,
  buildEpochRotationManifest,
  loadProductionCorpus,
  nextMinImprovementPpm,
  signEpochRotationManifest,
} from '../packages/cortex/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const HF_REPO = 'botcoinmoney/dacr-lt-training';
const HF_BASE = `https://huggingface.co/datasets/${HF_REPO}/resolve/main`;

function parseArgs(argv) {
  const out = {
    domain: 'quantum_physics',
    maxAttempts: 1500,
    maxPairs: 200,
    maxSessions: 200,
    maxBookends: 200,
    epoch: 1,
    currentMinImprovementPpm: 2500,
    targetAdvances: 24,
    observedAdvances: 0,
    qualityAttempts: 0,
    outDir: join(ROOT, 'ops/coretex-epochs'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--previous') out.previous = argv[++i];
    else if (a === '--domain') out.domain = argv[++i];
    else if (a === '--max-attempts') out.maxAttempts = Number(argv[++i]);
    else if (a === '--max-pairs') out.maxPairs = Number(argv[++i]);
    else if (a === '--max-sessions') out.maxSessions = Number(argv[++i]);
    else if (a === '--max-bookends') out.maxBookends = Number(argv[++i]);
    else if (a === '--epoch') out.epoch = Number(argv[++i]);
    else if (a === '--bundle-hash') out.bundleHash = argv[++i];
    else if (a === '--current-min-improvement-ppm') out.currentMinImprovementPpm = Number(argv[++i]);
    else if (a === '--target-advances') out.targetAdvances = Number(argv[++i]);
    else if (a === '--observed-advances') out.observedAdvances = Number(argv[++i]);
    else if (a === '--quality-attempts') out.qualityAttempts = Number(argv[++i]);
    else if (a === '--out-dir') out.outDir = argv[++i];
  }
  if (!out.previous) throw new Error('missing --previous <corpus.json>');
  if (!out.bundleHash || !/^0x[0-9a-fA-F]{64}$/.test(out.bundleHash)) throw new Error('missing --bundle-hash 0x...');
  return out;
}

async function fetchJsonl(path, token, hardLimit) {
  const url = `${HF_BASE}/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HF fetch ${path} -> ${res.status} ${await res.text()}`);
  const text = await res.text();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
    if (hardLimit && out.length >= hardLimit) break;
  }
  return out;
}

function toCorpusItem(e) {
  return {
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
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.HF_ACCESS_TOKEN;
  if (!token) throw new Error('HF_ACCESS_TOKEN not set');
  const previousCorpus = loadProductionCorpus(resolve(opts.previous));
  const existingIds = new Set(Object.values(previousCorpus.events).flat().map((event) => event.id));
  const domains = opts.domain.split(',').map((s) => s.trim()).filter(Boolean);
  const candidates = [];

  for (const domain of domains) {
    const attempts = await fetchJsonl(`raw_attempts/${domain}/part-00000.jsonl`, token, opts.maxAttempts);
    const pairs = await fetchJsonl(`pairs_sequential/${domain}/part-00000.jsonl`, token, opts.maxPairs).catch(() => []);
    const sessions = await fetchJsonl(`sessions/${domain}/part-00000.jsonl`, token, opts.maxSessions).catch(() => []);
    const bookends = await fetchJsonl(`pairs_bookend/${domain}/part-00000.jsonl`, token, opts.maxBookends).catch(() => []);
    candidates.push(...bridgeDacrBatch(
      attempts,
      pairs,
      { epochCommitted: opts.epoch, maxDistractors: 4 },
      sessions,
      bookends,
    ));
  }

  const additions = admitCorpusBatch(candidates, {
    ...DEFAULT_ADMISSION_POLICY,
    totalCap: 25_000,
    perDomainCap: 5_000,
  }).admitted.filter((event) => !existingIds.has(event.id));

  const delta = buildCorpusDelta(previousCorpus, additions, [], opts.epoch);
  const challengeBook = {
    schemaVersion: 'coretex.challenge-book.v1',
    epoch: opts.epoch,
    source: HF_REPO,
    previousCorpusRoot: delta.previousRoot,
    nextCorpusRoot: delta.nextRoot,
    recordCount: additions.length,
    items: additions.map(toCorpusItem),
  };
  const difficulty = nextMinImprovementPpm({
    current: BigInt(opts.currentMinImprovementPpm),
    observedAdvances: opts.observedAdvances,
    targetAdvances: opts.targetAdvances,
    qualityAttempts: opts.qualityAttempts,
  });
  let manifest = buildEpochRotationManifest({
    epoch: opts.epoch,
    delta,
    challengeBook,
    bundleHash: opts.bundleHash,
    minImprovementPpm: Number(difficulty.next),
    advancesObserved: opts.observedAdvances,
    qualityAttemptsObserved: opts.qualityAttempts,
  });

  const privateKeyPath = process.env.CORETEX_EPOCH_MANIFEST_PRIVATE_KEY_PATH;
  const privateKeyPem = process.env.CORETEX_EPOCH_MANIFEST_PRIVATE_KEY_PEM
    ?? (privateKeyPath ? readFileSync(privateKeyPath, 'utf8') : undefined);
  if (privateKeyPem) {
    manifest = signEpochRotationManifest(
      manifest,
      privateKeyPem,
      process.env.CORETEX_EPOCH_MANIFEST_KEY_ID ?? 'coretex-epoch-operator',
    );
  }

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, 'corpus_delta.json'), JSON.stringify(delta, null, 2));
  writeFileSync(join(opts.outDir, 'challenge_book.json'), JSON.stringify(challengeBook, null, 2));
  writeFileSync(join(opts.outDir, 'epoch_rotation_manifest.json'), JSON.stringify(manifest, null, 2));
  const summary = {
    epoch: opts.epoch,
    additions: additions.length,
    previousCorpusRoot: delta.previousRoot,
    nextCorpusRoot: delta.nextRoot,
    deltaSha256: createHash('sha256').update(JSON.stringify(delta)).digest('hex'),
    nextMinImprovementPpm: Number(difficulty.next),
    difficultyReason: difficulty.reason,
  };
  writeFileSync(join(opts.outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
