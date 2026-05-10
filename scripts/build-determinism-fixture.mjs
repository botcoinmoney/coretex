#!/usr/bin/env node
/**
 * Build the determinism-check fixture (`{query, document, id}` pairs) from
 * an existing CoreTex production corpus. Pulls one pair per qrel entry
 * (truth + hard negatives) and emits a deterministic, hash-derived order.
 *
 * Usage:
 *   node scripts/build-determinism-fixture.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0.json \
 *     --out benchmark/fixtures/determinism/1k-pairs.json \
 *     --max-pairs 1000
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}
const corpusPath = flag('corpus');
const outPath = flag('out', 'benchmark/fixtures/determinism/1k-pairs.json');
const maxPairs = Number(flag('max-pairs', '1000'));
if (!corpusPath) { console.error('--corpus required'); exit(1); }

const corpus = JSON.parse(readFileSync(resolve(corpusPath), 'utf8'));
const pairs = [];
for (const event of corpus.events) {
  for (const td of event.truthDocuments) pairs.push({ id: `${event.id}::truth::${td.id}`, query: event.queryText, document: td.text });
  for (const n of event.hardNegatives) pairs.push({ id: `${event.id}::neg::${n.id}`, query: event.queryText, document: n.text });
}
// Deterministic shuffle by hash of id, then take the first maxPairs.
pairs.sort((a, b) => {
  const ah = createHash('sha256').update(a.id).digest('hex');
  const bh = createHash('sha256').update(b.id).digest('hex');
  return ah < bh ? -1 : ah > bh ? 1 : 0;
});
const selected = pairs.slice(0, maxPairs);
mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), JSON.stringify(selected, null, 2));
console.log(`wrote ${selected.length} pairs (from ${pairs.length} candidates) to ${outPath}`);
