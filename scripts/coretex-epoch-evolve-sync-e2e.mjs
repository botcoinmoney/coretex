#!/usr/bin/env node
/**
 * CPU E2E gate for production epoch evolution:
 *   R0 tiny production corpus -> signed delta/rotation -> validator sync -> R1
 *   stale R0 epoch pin is rejected; R1 pin is accepted.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { argv, exit } from 'node:process';

import { distIndex, repoRoot } from './_repo-root.mjs';

const C = await import(distIndex);
const {
  computeCorpusRoot,
  serializeProductionCorpus,
  splitForRecord,
} = C;

const args = argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const outRoot = resolve(repoRoot, flag('out-dir', `.local-wip/coretex-epoch-evolve-sync-e2e-${process.pid}`));
mkdirSync(outRoot, { recursive: true });

const MANIFEST = 'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json';
const manifest = JSON.parse(readFileSync(resolve(repoRoot, MANIFEST), 'utf8'));
const bundle = JSON.parse(readFileSync(resolve(repoRoot, manifest.bundlePath), 'utf8'));
const BE = bundle.model.biEncoder;
const RR = bundle.model.reranker;
const LAYOUT = {
  dim: BE.retrievalKeyLayout.dim,
  quantization: BE.retrievalKeyLayout.quantization,
  headerBytes: BE.retrievalKeyLayout.headerBytes,
};

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  exit(1);
}
function run(label, cmdArgs, expect = 0) {
  const r = spawnSync(process.execPath, cmdArgs, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== expect) {
    console.error(r.stdout);
    console.error(r.stderr);
    fail(`${label}: expected exit ${expect}, got ${r.status}`);
  }
  return r;
}
function deterministicEmbeddingBytes(text) {
  const out = new Uint8Array(4 + LAYOUT.dim);
  new DataView(out.buffer).setFloat32(0, 1 / 127, false);
  let cursor = Buffer.alloc(0);
  for (let i = 0; i < LAYOUT.dim; i++) {
    if (i % 32 === 0) cursor = createHash('sha256').update(`${text}:${i / 32}`).digest();
    out[4 + i] = (cursor[i % 32] - 128) & 0xff;
  }
  return out;
}
function mkEmb(queryBytes, truthEntries, negativeEntries = []) {
  return {
    modelId: BE.modelId,
    revision: BE.revision,
    layout: LAYOUT,
    query: queryBytes,
    perTruth: new Map(truthEntries),
    perNegative: new Map(negativeEntries),
  };
}

const logical = {
  specVersion: 'coretex.logical-corpus.v1',
  phase: 'epoch-evolve-sync-e2e',
  dgen1: { atomV16Metadata: true },
  entities: [
    { id: 'e_universe', canonicalName: 'Universe' },
    { id: 'person_s0', canonicalName: 'Avery Stone', aliases: ['Avery'] },
    { id: 'person_s1', canonicalName: 'Morgan Reed', aliases: ['Morgan'] },
  ],
  docs: [
    { id: 'd_base_0', lane: 'deep', kind: 'temporal_city', entityIds: ['e_universe', 'person_s0'], text: "Avery Stone's supersession ledger sets city Oslo.", currentStaleFlag: true },
    { id: 'd_base_1', lane: 'deep', kind: 'temporal_city', entityIds: ['e_universe', 'person_s1'], text: "Morgan Reed's supersession ledger sets city Lima.", currentStaleFlag: true },
  ],
  relations: [],
  queries: [],
};
const evalIds = [];
for (let i = 0; evalIds.length < 4 && i < 5000; i++) {
  const id = `q_base_eval_${i}`;
  if (splitForRecord(id, 0) === 'eval_hidden') evalIds.push(id);
}
if (evalIds.length < 4) fail('could not find enough eval_hidden ids');

const baseDocs = logical.docs;
const docEmb = new Map(baseDocs.map((d) => [d.id, deterministicEmbeddingBytes(d.text)]));
const events = [];
for (const d of baseDocs) {
  const emb = docEmb.get(d.id);
  events.push({
    id: `mem_${d.id}`,
    family: 'near_collision',
    domain: d.lane,
    split: 'train_visible',
    queryText: d.text,
    truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag !== false }],
    hardNegatives: [],
    qrels: [{ documentId: d.id, relevance: 1.0 }],
    protected: false,
    relations: [],
    entityIds: d.entityIds,
    provenance: { source: 'e2e', sourceHash: '0x' + '00'.repeat(32) },
    embeddings: mkEmb(emb, [[d.id, emb]]),
  });
}
for (let i = 0; i < evalIds.length; i++) {
  const d = baseDocs[i % baseDocs.length];
  const qText = `What is ${i % 2 === 0 ? 'Avery Stone' : 'Morgan Reed'}'s current city?`;
  const qEmb = deterministicEmbeddingBytes(qText);
  const tEmb = docEmb.get(d.id);
  events.push({
    id: evalIds[i],
    family: 'temporal',
    domain: 'deep',
    split: 'eval_hidden',
    queryText: qText,
    truthDocuments: [{ id: d.id, text: d.text, isCurrent: true }],
    hardNegatives: [],
    qrels: [{ documentId: d.id, relevance: 1.0 }],
    protected: false,
    relations: [],
    provenance: { source: 'e2e', sourceHash: '0x' + '00'.repeat(32) },
    embeddings: mkEmb(qEmb, [[d.id, tEmb]]),
  });
}
const previousCorpus = {
  events,
  byId: new Map(events.map((e) => [e.id, e])),
  entities: logical.entities,
  corpusRoot: computeCorpusRoot(events),
  corpusEpoch: 0,
  biEncoderModelId: BE.modelId,
  biEncoderRevision: BE.revision,
  biEncoderRetrievalKeyLayout: LAYOUT,
  labelingModelId: RR.modelId,
  labelingModelRevision: RR.revision,
};

const logicalPath = resolve(outRoot, 'tiny-logical.json');
const previousCorpusPath = resolve(outRoot, 'tiny-production-corpus.json');
writeFileSync(logicalPath, JSON.stringify(logical, null, 2) + '\n');
writeFileSync(previousCorpusPath, JSON.stringify(serializeProductionCorpus(previousCorpus), null, 2) + '\n');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPath = resolve(outRoot, 'epoch-private.pem');
const publicKeyPath = resolve(outRoot, 'epoch-public.pem');
writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }).toString());

const epochDir = resolve(outRoot, 'epoch-1');
run('coretex:epoch-evolve', [
  'scripts/coretex-epoch-evolve.mjs',
  '--manifest', MANIFEST,
  '--epoch', '1',
  '--source-corpus', logicalPath,
  '--logical-state', logicalPath,
  '--previous-corpus', previousCorpusPath,
  '--out-dir', epochDir,
  '--private-key', privateKeyPath,
  '--public-key', publicKeyPath,
  '--key-id', 'epoch-e2e',
  '--parent-state-root', '0x' + '11'.repeat(32),
  '--mock-embeddings',
  '--churn', '1',
  '--seed', 'epoch-e2e',
]);
const evolveOut = JSON.parse(readFileSync(resolve(epochDir, 'epoch-evolve-output-1.json'), 'utf8'));
if (evolveOut.previousCorpusRoot.toLowerCase() !== previousCorpus.corpusRoot.toLowerCase()) fail('evolve previous root mismatch');
if (evolveOut.nextCorpusRoot.toLowerCase() === previousCorpus.corpusRoot.toLowerCase()) fail('evolve did not advance corpus root');
if (evolveOut.startEpochParams.corpusRoot.toLowerCase() !== evolveOut.nextCorpusRoot.toLowerCase()) fail('startEpoch corpusRoot not R1');
if (evolveOut.startEpochParams.baselineManifestHash.toLowerCase() !== evolveOut.rotationManifestHash.toLowerCase()) fail('rotation manifest hash not bound through baselineManifestHash');

const statePath = resolve(outRoot, 'validator-state.json');
writeFileSync(statePath, JSON.stringify({
  schema: 'coretex.validator-sync-state.v1',
  epoch: 0,
  bundleHash: manifest.bundleHash,
  corpusRoot: previousCorpus.corpusRoot,
  currentCorpusJson: previousCorpusPath.replace(`${repoRoot}/`, ''),
}, null, 2) + '\n');

run('validator:sync accepts R1', [
  'scripts/coretex-validator-sync.mjs',
  '--manifest', MANIFEST,
  '--rotation-manifest', resolve(epochDir, 'epoch-rotation-1.json'),
  '--corpus-delta', resolve(epochDir, 'corpus-delta-epoch-1.json'),
  '--public-key', publicKeyPath,
  '--baseline-manifest-hash', evolveOut.startEpochParams.baselineManifestHash,
  '--epoch-corpus-root', evolveOut.startEpochParams.corpusRoot,
  '--state', statePath,
  '--out-dir', resolve(outRoot, 'validator-current'),
]);

writeFileSync(statePath, JSON.stringify({
  schema: 'coretex.validator-sync-state.v1',
  epoch: 0,
  bundleHash: manifest.bundleHash,
  corpusRoot: previousCorpus.corpusRoot,
  currentCorpusJson: previousCorpusPath.replace(`${repoRoot}/`, ''),
}, null, 2) + '\n');
run('validator:sync rejects stale R0 epoch pin', [
  'scripts/coretex-validator-sync.mjs',
  '--manifest', MANIFEST,
  '--rotation-manifest', resolve(epochDir, 'epoch-rotation-1.json'),
  '--corpus-delta', resolve(epochDir, 'corpus-delta-epoch-1.json'),
  '--public-key', publicKeyPath,
  '--baseline-manifest-hash', evolveOut.startEpochParams.baselineManifestHash,
  '--epoch-corpus-root', previousCorpus.corpusRoot,
  '--state', statePath,
  '--out-dir', resolve(outRoot, 'validator-stale'),
], 1);

if (!existsSync(resolve(outRoot, 'validator-current', 'manifest.json'))) fail('validator sync did not write materialized snapshot');
console.log(JSON.stringify({
  ok: true,
  previousCorpusRoot: previousCorpus.corpusRoot,
  nextCorpusRoot: evolveOut.nextCorpusRoot,
  rotationManifestHash: evolveOut.rotationManifestHash,
  startEpochParams: evolveOut.startEpochParams,
  outDir: outRoot.replace(`${repoRoot}/`, ''),
}, null, 2));
