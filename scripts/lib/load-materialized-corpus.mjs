/**
 * Loader for the materialized production-corpus artifact written by
 * scripts/materialize-production-corpus.mjs. This is a CALIBRATION-INTERNAL format that
 * preserves every in-memory field of ProductionCorpusEvent — including `logicalFamily`
 * and `band` which the canonical serializeProductionCorpus drops. As a result, the
 * computeCorpusRoot of the loaded events matches the original buildV2ProductionCorpus
 * output byte-for-byte. (Canonical serializer can't round-trip a build output for the
 * same reason — that is a separate concern; for calibration we just need the artifact
 * to faithfully replace the rebuild.)
 *
 * loadMaterializedCorpus(bundlePath, opts):
 *   - resolves the artifact dir from the bundleHash (tag = bundleHash[2..10])
 *   - asserts manifest matches bundleHash + sourceCorpusSha256 + sourceEmbSha256
 *   - streams events from the NDJSON sidecar with hex→Uint8Array decode
 *   - optional verifyCorpusRoot recomputes the root and compares with the manifest
 *
 * loadMaterializedCorpusSlice(bundlePath, n):
 *   - hydrates only the FIRST N events from the NDJSON sidecar (mechanics smokes only)
 *   - computes a NEW root over the slice; manifest root is NOT expected to match
 */
import { readFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { distIndex, repoRoot } from '../_repo-root.mjs';

const C = await import(distIndex);
const { computeCorpusRoot } = C;

function sha256File(p) { return '0x' + createHash('sha256').update(readFileSync(p)).digest('hex'); }
function hexToU8(hex) { return new Uint8Array(Buffer.from(hex, 'hex')); }

function resolveArtifactPaths(bundlePath) {
  const bundle = JSON.parse(readFileSync(resolve(repoRoot, bundlePath), 'utf8'));
  const tag = (bundle.bundleHash ?? '0xunknown').slice(2, 10);
  const dir = resolve(repoRoot, 'release/calibration/2026-05-21-memory-corpus-v2/materialized', tag);
  return {
    bundle, tag, dir,
    corpusJson: resolve(dir, 'corpus.json'),
    ndjson: resolve(dir, 'corpus.json.events.ndjson'),
    manifest: resolve(dir, 'manifest.json'),
  };
}

function assertManifest(manifestPath, bundleHash, sourceCorpusPath, sourceEmbPath) {
  if (!existsSync(manifestPath)) {
    throw new Error(`HARD FAIL: materialized artifact missing — run scripts/materialize-production-corpus.mjs first. expected: ${manifestPath}`);
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (m.bundleHash !== bundleHash) {
    throw new Error(`HARD FAIL: materialized artifact bundleHash mismatch — artifact=${m.bundleHash} active=${bundleHash}. Re-run materialize.`);
  }
  if (sourceCorpusPath) {
    const actual = sha256File(resolve(repoRoot, sourceCorpusPath));
    if (m.sourceCorpusSha256 !== actual) {
      throw new Error(`HARD FAIL: source corpus sha drift — artifact=${m.sourceCorpusSha256} actual=${actual}. Re-run materialize.`);
    }
  }
  if (sourceEmbPath) {
    const actual = sha256File(resolve(repoRoot, sourceEmbPath));
    if (m.sourceEmbSha256 !== actual) {
      throw new Error(`HARD FAIL: source embeddings sha drift — artifact=${m.sourceEmbSha256} actual=${actual}. Re-run materialize.`);
    }
  }
  return m;
}

function hydrateEvent(e) {
  const out = {};
  for (const k of Object.keys(e)) {
    if (k === 'embeddings') continue;
    out[k] = e[k];
  }
  out.embeddings = {
    modelId: e.embeddings.modelId, revision: e.embeddings.revision, layout: e.embeddings.layout,
    query: hexToU8(e.embeddings.query),
    perTruth: new Map(Object.entries(e.embeddings.perTruth ?? {}).map(([k, v]) => [k, hexToU8(v)])),
    perNegative: new Map(Object.entries(e.embeddings.perNegative ?? {}).map(([k, v]) => [k, hexToU8(v)])),
  };
  return out;
}

function streamEvents(ndjsonPath, maxN) {
  const fd = openSync(ndjsonPath, 'r');
  const events = [];
  try {
    const buf = Buffer.alloc(16 * 1024 * 1024);
    let pending = '';
    while (true) {
      if (maxN != null && events.length >= maxN) break;
      const r = readSync(fd, buf, 0, buf.length, null);
      if (r <= 0) break;
      pending += buf.toString('utf8', 0, r);
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
        if (!line) continue;
        const parsed = JSON.parse(line);
        events.push(hydrateEvent(parsed));
        if (maxN != null && events.length >= maxN) break;
      }
    }
  } finally { closeSync(fd); }
  return events;
}

/**
 * @param {string} bundlePath
 * @param {{sourceCorpusPath?:string, sourceEmbPath?:string, verifyCorpusRoot?:boolean}} [opts]
 */
export function loadMaterializedCorpus(bundlePath, opts = {}) {
  const { bundle, manifest, ndjson, corpusJson } = resolveArtifactPaths(bundlePath);
  const m = assertManifest(manifest, bundle.bundleHash, opts.sourceCorpusPath, opts.sourceEmbPath);
  if (!existsSync(ndjson)) throw new Error(`HARD FAIL: ndjson sidecar missing: ${ndjson}`);
  const head = JSON.parse(readFileSync(corpusJson, 'utf8'));
  const events = streamEvents(ndjson, null);
  if (opts.verifyCorpusRoot) {
    const computed = computeCorpusRoot(events);
    if (computed.toLowerCase() !== m.corpusRoot.toLowerCase()) {
      throw new Error(`HARD FAIL: materialized corpusRoot mismatch — manifest=${m.corpusRoot} computed=${computed}`);
    }
  }
  const corpus = {
    events, byId: new Map(events.map((e) => [e.id, e])),
    ...(head.entities ? { entities: head.entities } : {}),
    corpusRoot: m.corpusRoot.toLowerCase(), corpusEpoch: head.corpusEpoch ?? 0,
    biEncoderModelId: m.biEncoder.modelId, biEncoderRevision: m.biEncoder.revision, biEncoderRetrievalKeyLayout: m.biEncoder.layout,
    labelingModelId: m.labelingModel.modelId, labelingModelRevision: m.labelingModel.revision,
  };
  return { corpus, manifest: m, BE: { modelId: m.biEncoder.modelId, revision: m.biEncoder.revision, retrievalKeyLayout: m.biEncoder.layout }, RR: m.labelingModel, LAYOUT: m.biEncoder.layout };
}

/**
 * Read only the first `n` events from the NDJSON sidecar; mechanics smoke tests.
 * The slice corpus has its OWN corpusRoot (computed over the slice), NOT the manifest root.
 */
export function loadMaterializedCorpusSlice(bundlePath, n) {
  const { bundle, manifest, ndjson } = resolveArtifactPaths(bundlePath);
  const m = assertManifest(manifest, bundle.bundleHash);
  if (!existsSync(ndjson)) throw new Error(`HARD FAIL: ndjson sidecar missing: ${ndjson}`);
  const events = streamEvents(ndjson, n);
  const idsInSlice = new Set(events.map((e) => e.id));
  // Drop events whose truth/neg doc ids are not in-slice — keeps the slice self-consistent
  // for evaluators that lookup truth docs by id.
  const filtered = events.filter((e) => {
    for (const t of e.truthDocuments ?? []) if (!idsInSlice.has(t.id) && !idsInSlice.has(`mem_${t.id}`)) return false;
    for (const h of e.hardNegatives ?? []) if (!idsInSlice.has(h.id) && !idsInSlice.has(`mem_${h.id}`)) return false;
    return true;
  });
  const root = computeCorpusRoot(filtered);
  return {
    corpus: {
      events: filtered, byId: new Map(filtered.map((e) => [e.id, e])),
      corpusRoot: root, corpusEpoch: 0,
      biEncoderModelId: m.biEncoder.modelId, biEncoderRevision: m.biEncoder.revision, biEncoderRetrievalKeyLayout: m.biEncoder.layout,
      labelingModelId: m.labelingModel.modelId, labelingModelRevision: m.labelingModel.revision,
    },
    manifest: m,
    BE: { modelId: m.biEncoder.modelId, revision: m.biEncoder.revision, retrievalKeyLayout: m.biEncoder.layout },
    RR: m.labelingModel, LAYOUT: m.biEncoder.layout,
    sliced: { requested: n, materializedCount: events.length, kept: filtered.length },
  };
}
