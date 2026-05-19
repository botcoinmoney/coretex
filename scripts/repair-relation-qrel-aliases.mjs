#!/usr/bin/env node
/**
 * Repair relation-answer alias qrels in an existing CoreTex retrieval corpus.
 *
 * This is intentionally NOT a corpus regeneration path. It reuses every
 * existing document and embedding, adds missing multi_hop_relation qrels that
 * point at relation target truth docs, recomputes the corpus root, and writes a
 * new corpus JSON plus `.events.ndjson` sidecar. No model calls.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';

import {
  addRelationAnswerAliasQrels,
  canonicalJsonForCorpus,
  keccak256,
} from '@botcoin/cortex';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const inPath = resolve(flag('corpus', ''));
const outPath = resolve(flag('out', ''));
const reportPath = flag('report') ? resolve(flag('report')) : null;

if (!inPath || !existsSync(inPath)) {
  console.error('repair-relation-qrel-aliases: --corpus is required');
  exit(1);
}
if (!outPath) {
  console.error('repair-relation-qrel-aliases: --out is required');
  exit(1);
}
if (outPath === inPath) {
  console.error('repair-relation-qrel-aliases: refusing to overwrite input corpus; write a new path');
  exit(2);
}

function bytesToHex(bytes) {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

function readCorpusJsonHeader(path) {
  const HEAD_BYTES = 64 * 1024;
  const TAIL_BYTES = 32 * 1024;
  const fd = openSync(path, 'r');
  let head;
  let tail;
  let fileSize;
  try {
    const headBuf = Buffer.alloc(HEAD_BYTES);
    const headN = readSync(fd, headBuf, 0, headBuf.length, 0);
    head = headBuf.toString('utf8', 0, headN);
    fileSize = fstatSync(fd).size;
    const tailLen = Math.min(TAIL_BYTES, fileSize);
    const tailStart = fileSize - tailLen;
    const tailBuf = Buffer.alloc(tailLen);
    const tailN = readSync(fd, tailBuf, 0, tailBuf.length, tailStart);
    tail = tailBuf.toString('utf8', 0, tailN);
  } finally {
    closeSync(fd);
  }

  const eventsIdx = head.indexOf('"events"');
  if (eventsIdx < 0) throw new Error(`"events" key not found in ${path}`);
  const preTrimmed = head.slice(0, eventsIdx).replace(/,\s*$/, '');
  const preMeta = JSON.parse(`${preTrimmed},"events":[]}`);

  const closeIdx = tail.lastIndexOf('],');
  if (closeIdx < 0) return preMeta;
  const trailerInner = tail.slice(closeIdx + 2).replace(/^\s*,?/, '').replace(/}\s*$/, '');
  if (trailerInner.trim().length === 0) return preMeta;
  const postMeta = JSON.parse(`{${trailerInner}}`);
  return { ...preMeta, ...postMeta };
}

async function* readEventsFromCorpus(path) {
  const ndjsonPath = `${path}.events.ndjson`;
  if (existsSync(ndjsonPath)) {
    const rl = createInterface({ input: createReadStream(ndjsonPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      yield JSON.parse(line);
    }
    return;
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  for (const event of raw.events ?? []) yield event;
}

function merkleRootFromLeaves(leaves) {
  if (leaves.length === 0) return `0x${'00'.repeat(32)}`;
  const zero = new Uint8Array(32);
  let n = 1;
  while (n < leaves.length) n <<= 1;
  while (leaves.length < n) leaves.push(zero);
  while (leaves.length > 1) {
    const next = [];
    for (let i = 0; i < leaves.length; i += 2) {
      const pair = new Uint8Array(64);
      pair.set(leaves[i], 0);
      pair.set(leaves[i + 1], 32);
      next.push(keccak256(pair));
    }
    leaves = next;
  }
  return bytesToHex(leaves[0]);
}

const meta = readCorpusJsonHeader(inPath);
if (meta.schemaVersion !== 'coretex.production-corpus.v1') {
  console.error(`unsupported corpus schemaVersion: ${meta.schemaVersion}`);
  exit(2);
}

console.log(`[repair-qrels] scanning target truth docs from ${inPath}`);
const relationTruthDocumentsByEventId = new Map();
let eventCount = 0;
for await (const event of readEventsFromCorpus(inPath)) {
  eventCount++;
  relationTruthDocumentsByEventId.set(event.id, event.truthDocuments ?? []);
}

mkdirSync(dirname(outPath), { recursive: true });
const outNdjsonPath = `${outPath}.events.ndjson`;
const ndjson = createWriteStream(outNdjsonPath);
const writeNdjson = (s) => new Promise((res) => (ndjson.write(s) ? res() : ndjson.once('drain', res)));

let repairedEvents = 0;
let qrelsAdded = 0;
let qrelsUpgraded = 0;
let candidateTruthDocs = 0;
let fullCredit = 0;
let partialCredit = 0;
const familyTally = Object.create(null);
const splitTally = Object.create(null);
const leavesIndex = [];
const enc = new TextEncoder();

console.log('[repair-qrels] writing repaired events');
for await (const event of readEventsFromCorpus(inPath)) {
  const beforeCount = event.qrels?.length ?? 0;
  const { qrels, stats } = addRelationAnswerAliasQrels(event.qrels ?? [], {
    family: event.family,
    truthDocuments: event.truthDocuments ?? [],
    relations: event.relations,
    relationTruthDocumentsByEventId,
  });
  const repaired = stats.added > 0 || stats.upgraded > 0 ? { ...event, qrels } : event;
  if (stats.added > 0 || stats.upgraded > 0 || qrels.length !== beforeCount) repairedEvents++;
  qrelsAdded += stats.added;
  qrelsUpgraded += stats.upgraded;
  candidateTruthDocs += stats.candidateTruthDocs;
  fullCredit += stats.fullCredit;
  partialCredit += stats.partialCredit;

  familyTally[repaired.family] = (familyTally[repaired.family] ?? 0) + 1;
  splitTally[repaired.split] = (splitTally[repaired.split] ?? 0) + 1;
  leavesIndex.push({ id: repaired.id, leaf: keccak256(enc.encode(canonicalJsonForCorpus(repaired))) });
  await writeNdjson(`${JSON.stringify(repaired)}\n`);
}
await new Promise((res, rej) => ndjson.end((err) => (err ? rej(err) : res())));

leavesIndex.sort((a, b) => a.id.localeCompare(b.id));
const corpusRoot = merkleRootFromLeaves(leavesIndex.map((x) => x.leaf));

console.log('[repair-qrels] writing repaired corpus JSON');
const out = createWriteStream(outPath);
const writeChunk = (s) => new Promise((res) => (out.write(s) ? res() : out.once('drain', res)));
const header = { ...meta, events: undefined, corpusRoot: undefined };
delete header.events;
delete header.corpusRoot;

await writeChunk('{\n');
const headerEntries = Object.entries(header);
for (let i = 0; i < headerEntries.length; i++) {
  const [key, value] = headerEntries[i];
  await writeChunk(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`);
}
await writeChunk('  "events": [\n');
{
  const rl = createInterface({ input: createReadStream(outNdjsonPath), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (!line) continue;
    const reEncoded = JSON.stringify(JSON.parse(line), null, 2)
      .split('\n')
      .map((l, i) => (i === 0 ? l : `    ${l}`))
      .join('\n');
    await writeChunk((first ? '    ' : ',\n    ') + reEncoded);
    first = false;
  }
}
await writeChunk('\n  ],\n');
await writeChunk(`  "corpusRoot": ${JSON.stringify(corpusRoot)}\n`);
await writeChunk('}\n');
await new Promise((res, rej) => out.end((err) => (err ? rej(err) : res())));

const report = {
  schemaVersion: 'coretex.relation-qrel-alias-repair.v1',
  generatedAt: new Date().toISOString(),
  input: { corpus: inPath, corpusRoot: meta.corpusRoot ?? null },
  output: { corpus: outPath, eventsNdjson: outNdjsonPath, corpusRoot },
  eventCount,
  repairedEvents,
  relationAliasQrels: {
    candidateTargetTruthDocs: candidateTruthDocs,
    added: qrelsAdded,
    upgraded: qrelsUpgraded,
    fullCredit,
    partialCredit,
  },
  families: familyTally,
  splits: splitTally,
};

if (reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const reportOut = createWriteStream(reportPath);
  await new Promise((res, rej) => reportOut.end(JSON.stringify(report, null, 2) + '\n', (err) => (err ? rej(err) : res())));
}

console.log(JSON.stringify(report, null, 2));
if (qrelsAdded + qrelsUpgraded === 0) exit(3);
