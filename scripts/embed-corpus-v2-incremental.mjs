#!/usr/bin/env node
/**
 * Incremental embedding cache for Memory Corpus V2.
 *
 * Reuses an existing embedding cache for every doc/query whose id+text is
 * unchanged vs an OLD corpus, and embeds ONLY the new/changed texts with the
 * pinned BGE-M3 int8/243 key. Lets us re-emit owner-scoped corpora (query text
 * mostly stable; docs byte-identical) without a full 100k re-embed.
 *
 * Run DETACHED for large corpora (heavy torch load — [[feedback_detached_heavy_jobs]]).
 *
 * usage: embed-corpus-v2-incremental.mjs <newCorpus> <oldCorpus|-> <oldCache|-> <outCache>
 *   oldCorpus/oldCache may be '-' (none) → full embed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { embedTexts } from './_embed-v2.mjs';

async function main() {
  const [newPath, oldPath, oldCachePath, outPath] = process.argv.slice(2);
  if (!newPath || !outPath) { console.error('usage: <newCorpus> <oldCorpus|-> <oldCache|-> <out>'); process.exit(2); }
  const corpus = JSON.parse(readFileSync(newPath, 'utf8'));
  const oldCorpus = oldPath && oldPath !== '-' ? JSON.parse(readFileSync(oldPath, 'utf8')) : null;
  const oldCache = oldCachePath && oldCachePath !== '-' ? JSON.parse(readFileSync(oldCachePath, 'utf8')) : null;

  const oldDocText = new Map((oldCorpus?.docs ?? []).map((d) => [d.id, d.text]));
  const oldQText = new Map((oldCorpus?.queries ?? []).map((q) => [q.id, q.queryText]));
  const cacheDocs = oldCache?.docs ?? {};
  const cacheQ = oldCache?.queries ?? {};

  // Partition: reusable (id present, text unchanged, cache has it) vs to-embed.
  const outDocs = {}, outQ = {};
  const toEmbed = []; // { kind:'doc'|'q', id, text }
  let reuseDoc = 0, reuseQ = 0;
  for (const d of corpus.docs) {
    if (oldDocText.get(d.id) === d.text && cacheDocs[d.id]) { outDocs[d.id] = cacheDocs[d.id]; reuseDoc++; }
    else toEmbed.push({ kind: 'doc', id: d.id, text: d.text });
  }
  for (const q of corpus.queries) {
    if (oldQText.get(q.id) === q.queryText && cacheQ[q.id]) { outQ[q.id] = cacheQ[q.id]; reuseQ++; }
    else toEmbed.push({ kind: 'q', id: q.id, text: q.queryText });
  }
  console.error(`[inc-embed] reuse docs=${reuseDoc}/${corpus.docs.length} queries=${reuseQ}/${corpus.queries.length}; embedding ${toEmbed.length} new/changed texts`);

  let dim = oldCache?.dim ?? 243;
  if (toEmbed.length > 0) {
    const t0 = Date.now();
    const vecs = await embedTexts(toEmbed.map((x) => x.text));
    dim = vecs[0].length;
    const toB64 = (v) => Buffer.from(new Float32Array(v).buffer).toString('base64');
    for (let i = 0; i < toEmbed.length; i++) {
      const { kind, id } = toEmbed[i];
      const b64 = toB64(vecs[i]);
      if (kind === 'doc') outDocs[id] = b64; else outQ[id] = b64;
    }
    console.error(`[inc-embed] embedded ${toEmbed.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const out = {
    specVersion: corpus.specVersion, phase: corpus.phase, dim,
    biEncoder: oldCache?.biEncoder ?? 'BAAI/bge-m3 int8/243 (pinned)',
    docs: outDocs, queries: outQ,
  };
  writeFileSync(outPath, JSON.stringify(out));
  console.error(`[inc-embed] wrote ${outPath}: docs=${Object.keys(outDocs).length} queries=${Object.keys(outQ).length} dim=${dim}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
