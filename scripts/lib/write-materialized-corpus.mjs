import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { distValidator, repoRoot } from '../_repo-root.mjs';

const C = await import(distValidator);
const { computeCorpusEventLeafHash, buildCorpusRootLeafCacheFromLeaves } = C;

const u8ToHex = (u8) => Buffer.from(u8.buffer ?? u8, u8.byteOffset ?? 0, u8.byteLength ?? u8.length).toString('hex');

function eventOnDisk(e) {
  const out = {};
  for (const k of Object.keys(e)) {
    if (k === 'embeddings') continue;
    out[k] = e[k];
  }
  out.embeddings = {
    modelId: e.embeddings.modelId,
    revision: e.embeddings.revision,
    layout: e.embeddings.layout,
    query: u8ToHex(e.embeddings.query),
    perTruth: Object.fromEntries(Array.from(e.embeddings.perTruth.entries()).map(([k, v]) => [k, u8ToHex(v)])),
    perNegative: Object.fromEntries(Array.from(e.embeddings.perNegative.entries()).map(([k, v]) => [k, u8ToHex(v)])),
  };
  return out;
}

async function writeLine(stream, line) {
  if (!stream.write(line)) await new Promise((resolveDrain) => stream.once('drain', resolveDrain));
}

export async function writeMaterializedCorpusSnapshot({
  corpus,
  outDir,
  bundleHash,
  profileHash = null,
  bundlePath = null,
  profilePath = null,
  source = {},
}) {
  mkdirSync(outDir, { recursive: true });
  const corpusJson = resolve(outDir, 'corpus.json');
  const ndjson = `${corpusJson}.events.ndjson`;
  const rootLeavesPath = `${corpusJson}.root-leaves.ndjson`;
  const manifestPath = resolve(outDir, 'manifest.json');
  const header = {
    schemaVersion: 'coretex.production-corpus.v1',
    corpusEpoch: corpus.corpusEpoch,
    biEncoder: {
      modelId: corpus.biEncoderModelId,
      revision: corpus.biEncoderRevision,
      layout: corpus.biEncoderRetrievalKeyLayout,
    },
    labelingModel: {
      modelId: corpus.labelingModelId,
      revision: corpus.labelingModelRevision,
    },
    events: [],
    ...(corpus.entities ? { entities: corpus.entities } : {}),
    corpusRoot: corpus.corpusRoot,
  };
  writeFileSync(corpusJson, JSON.stringify(header, null, 2));

  const eventStream = createWriteStream(ndjson, { flags: 'w', highWaterMark: 16 * 1024 * 1024 });
  const rootStream = createWriteStream(rootLeavesPath, { flags: 'w', highWaterMark: 16 * 1024 * 1024 });
  const leaves = [];
  for (const e of corpus.events) {
    await writeLine(eventStream, JSON.stringify(eventOnDisk(e)) + '\n');
    const hash = computeCorpusEventLeafHash(e);
    leaves.push({ id: e.id, hash });
    await writeLine(rootStream, JSON.stringify({ id: e.id, hash: Buffer.from(hash).toString('hex') }) + '\n');
  }
  await new Promise((res, rej) => { eventStream.end((err) => err ? rej(err) : res()); });
  await new Promise((res, rej) => { rootStream.end((err) => err ? rej(err) : res()); });

  const rootCache = buildCorpusRootLeafCacheFromLeaves(leaves);
  if (rootCache.root.toLowerCase() !== corpus.corpusRoot.toLowerCase()) {
    throw new Error(`writeMaterializedCorpusSnapshot: root cache ${rootCache.root} != corpus ${corpus.corpusRoot}`);
  }
  const manifest = {
    schema: 'coretex.materialized-production-corpus.v1',
    materializedAtNote: 'validator sync snapshot; deterministic from previous corpus plus signed CorpusDelta',
    bundleHash,
    profileHash,
    corpusRoot: corpus.corpusRoot,
    biEncoder: {
      modelId: corpus.biEncoderModelId,
      revision: corpus.biEncoderRevision,
      layout: corpus.biEncoderRetrievalKeyLayout,
    },
    labelingModel: {
      modelId: corpus.labelingModelId,
      revision: corpus.labelingModelRevision,
    },
    bundlePath,
    profilePath,
    eventCount: corpus.events.length,
    materializedCorpusJson: corpusJson.replace(`${repoRoot}/`, ''),
    materializedEventsNdjson: ndjson.replace(`${repoRoot}/`, ''),
    rootLeafCache: {
      schema: rootCache.schema,
      path: rootLeavesPath.replace(`${repoRoot}/`, ''),
      eventCount: rootCache.eventCount,
      root: rootCache.root,
      builtFrom: 'validator-sync',
    },
    ...source,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { outDir, corpusJson, ndjson, rootLeavesPath, manifestPath, manifest };
}
