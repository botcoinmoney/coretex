#!/usr/bin/env node
/**
 * Build a corpus-root leaf cache for an existing materialized production corpus.
 *
 * This does NOT regenerate corpus or embeddings. It reads the materialized NDJSON sidecar,
 * computes the same per-event canonical leaf hash used by computeCorpusRoot, writes:
 *
 *   materialized/<bundleHash8>/corpus.json.root-leaves.ndjson
 *
 * Then verifies the cache root equals the manifest corpusRoot.
 */
import { createWriteStream, existsSync, openSync, readFileSync, readSync, closeSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';

const C = await import(distIndex);
const { buildCorpusRootLeafCacheFromLeaves, computeCorpusEventLeafHash } = C;

const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const BUNDLE_PATH = flag('bundle');
if (!BUNDLE_PATH) {
  console.error('HARD FAIL: --bundle required');
  exit(1);
}

const bundle = JSON.parse(readFileSync(resolve(repoRoot, BUNDLE_PATH), 'utf8'));
const tag = (bundle.bundleHash ?? '0xunknown').slice(2, 10);
const dir = resolve(repoRoot, 'release/calibration/2026-05-21-memory-corpus-v2/materialized', tag);
const manifestPath = resolve(dir, 'manifest.json');
const corpusJson = resolve(dir, 'corpus.json');
const ndjson = `${corpusJson}.events.ndjson`;
const outPath = `${corpusJson}.root-leaves.ndjson`;
const tmpPath = `${outPath}.tmp`;

if (!existsSync(manifestPath) || !existsSync(ndjson)) {
  console.error(`HARD FAIL: materialized artifact missing for bundle ${bundle.bundleHash}: ${dir}`);
  exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.bundleHash !== bundle.bundleHash) {
  console.error(`HARD FAIL: manifest bundleHash mismatch artifact=${manifest.bundleHash} active=${bundle.bundleHash}`);
  exit(1);
}

function hexToU8(hex) {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function hydrateEvent(e) {
  const out = {};
  for (const k of Object.keys(e)) {
    if (k === 'embeddings') continue;
    out[k] = e[k];
  }
  out.embeddings = {
    modelId: e.embeddings.modelId,
    revision: e.embeddings.revision,
    layout: e.embeddings.layout,
    query: hexToU8(e.embeddings.query),
    perTruth: new Map(Object.entries(e.embeddings.perTruth ?? {}).map(([k, v]) => [k, hexToU8(v)])),
    perNegative: new Map(Object.entries(e.embeddings.perNegative ?? {}).map(([k, v]) => [k, hexToU8(v)])),
  };
  return out;
}

async function writeLine(stream, line) {
  if (!stream.write(line)) await new Promise((res) => stream.once('drain', res));
}

const t0 = Date.now();
const fd = openSync(ndjson, 'r');
const stream = createWriteStream(tmpPath, { flags: 'w', highWaterMark: 16 * 1024 * 1024 });
const leaves = [];
let count = 0;
try {
  const buf = Buffer.alloc(16 * 1024 * 1024);
  let pending = '';
  while (true) {
    const r = readSync(fd, buf, 0, buf.length, null);
    if (r <= 0) break;
    pending += buf.toString('utf8', 0, r);
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
      if (!line) continue;
      const event = hydrateEvent(JSON.parse(line));
      const hash = computeCorpusEventLeafHash(event);
      const hashHex = Buffer.from(hash).toString('hex');
      leaves.push({ id: event.id, hash });
      await writeLine(stream, JSON.stringify({ id: event.id, hash: hashHex }) + '\n');
      count++;
      if (count % 50_000 === 0) console.log(`[root-cache] progress ${count}/${manifest.eventCount}`);
    }
  }
  if (pending.length > 0) {
    const event = hydrateEvent(JSON.parse(pending));
    const hash = computeCorpusEventLeafHash(event);
    const hashHex = Buffer.from(hash).toString('hex');
    leaves.push({ id: event.id, hash });
    await writeLine(stream, JSON.stringify({ id: event.id, hash: hashHex }) + '\n');
    count++;
  }
} finally {
  closeSync(fd);
  await new Promise((res, rej) => stream.end((err) => err ? rej(err) : res()));
}

const cache = buildCorpusRootLeafCacheFromLeaves(leaves);
if (cache.root.toLowerCase() !== manifest.corpusRoot.toLowerCase()) {
  console.error(`HARD FAIL: root cache mismatch — cache=${cache.root} manifest=${manifest.corpusRoot}`);
  exit(1);
}
renameSync(tmpPath, outPath);

const nextManifest = {
  ...manifest,
  rootLeafCache: {
    schema: cache.schema,
    path: outPath.replace(repoRoot + '/', ''),
    eventCount: cache.eventCount,
    root: cache.root,
    builtFrom: 'materialized events ndjson; no corpus regeneration',
  },
};
writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2));

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[root-cache] wrote ${outPath.replace(repoRoot + '/', '')}`);
console.log(`[root-cache] events=${count} root=${cache.root.slice(0, 18)}… elapsed=${elapsed}s`);
exit(0);
