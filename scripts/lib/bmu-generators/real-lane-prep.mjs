/**
 * BMU P2 real-lane subsample prep (G-B1/I8, SMALL-SCALE phase).
 *
 * Picks a SEEDED subsample of clusters from a sample bank and emits the input
 * JSON consumed by real-lane-runner.py: every public doc in the bank (the
 * retrieval corpus is the full bank — distractors included) plus the sampled
 * rows' queries. The cap is a logged, deliberate resource constraint for this
 * phase (Track-A agents hold the Qwen box); the full-bank sweep is deferred
 * to the dedicated certification run.
 *
 * Usage: node real-lane-prep.mjs --bank <bank.json> --out <input.json>
 *          [--seed bmu-p2-certify-v1] [--clusters 2] [--rerank-candidates 16]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { prng } from './common.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1], i++;
}
if (!args.bank || !args.out) {
  console.error('usage: real-lane-prep.mjs --bank <bank.json> --out <input.json> [--seed s] [--clusters n] [--rerank-candidates n]');
  process.exit(2);
}
const bank = JSON.parse(readFileSync(args.bank, 'utf8'));
const seed = args.seed ?? 'bmu-p2-certify-v1';
const nClusters = Number(args.clusters ?? 2);
const rerankCandidates = Number(args['rerank-candidates'] ?? 16);

const rand = prng(`${seed}|real-lane-subsample`);
const idx = bank.clusters.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) { // seeded Fisher–Yates, take head
  const j = Math.floor(rand() * (i + 1));
  [idx[i], idx[j]] = [idx[j], idx[i]];
}
const chosen = idx.slice(0, nClusters).sort((a, b) => a - b).map((i) => bank.clusters[i]);

const out = {
  kind: 'bmu-p2-real-lane-input',
  family: bank.family,
  seed,
  sampledClusters: chosen.map((c) => c.motifGroupId),
  rerankCandidates,
  docs: bank.clusters.flatMap((c) => c.docs.map((d) => ({ id: d.id, text: d.text }))),
  rows: chosen.flatMap((c) => c.rows.map((r) => ({ id: r.id, query: r.queryText }))),
};
writeFileSync(args.out, JSON.stringify(out, null, 1));
console.log(`real-lane input: ${out.rows.length} rows over ${out.docs.length} docs (clusters: ${out.sampledClusters.join(', ')})`);
