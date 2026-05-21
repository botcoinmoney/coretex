#!/usr/bin/env node
/**
 * One-time embedding cache for Memory Corpus V2 (logical layer).
 * Embeds every doc text + query text once with the pinned BGE-M3 int8/243
 * retrieval key and writes a base64 Float32 cache that Layer 3–6 scripts load
 * without re-paying the model cost.
 *
 * Run DETACHED (heavy torch load — see [[feedback_detached_heavy_jobs]]):
 *   setsid bash -c "node scripts/embed-corpus-v2.mjs CORPUS OUT > /tmp/emb.log 2>&1; echo EXIT=\$? >> /tmp/emb.log" </dev/null >/dev/null 2>&1 & disown
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { embedTexts } from './_embed-v2.mjs';

async function main() {
  const [corpusPath, outPath] = process.argv.slice(2);
  if (!corpusPath || !outPath) { console.error('usage: embed-corpus-v2.mjs <corpus.json> <out.json>'); process.exit(2); }
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const docTexts = corpus.docs.map((d) => d.text);
  const qTexts = corpus.queries.map((q) => q.queryText);
  console.error(`[embed] ${docTexts.length} docs + ${qTexts.length} queries (single model load)…`);
  const t0 = Date.now();
  const all = await embedTexts([...docTexts, ...qTexts]);
  const dim = all[0].length;
  const docVecs = all.slice(0, docTexts.length);
  const qVecs = all.slice(docTexts.length);
  const toB64 = (v) => Buffer.from(new Float32Array(v).buffer).toString('base64');
  const out = {
    specVersion: corpus.specVersion, phase: corpus.phase, dim,
    biEncoder: 'BAAI/bge-m3 int8/243 (pinned)',
    docs: Object.fromEntries(corpus.docs.map((d, i) => [d.id, toB64(docVecs[i])])),
    queries: Object.fromEntries(corpus.queries.map((q, i) => [q.id, toB64(qVecs[i])])),
  };
  writeFileSync(outPath, JSON.stringify(out));
  console.error(`[embed] wrote ${outPath} (dim ${dim}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
main().catch((e) => { console.error(e); process.exit(1); });
