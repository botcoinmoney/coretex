#!/usr/bin/env node
// Generate the BOTCOIN CoreTex Season 1 corpus fixture.
//
// The output is deterministic and source-rooted: every record is generated
// from a small Apache-2.0 DACR-shaped grammar, then pinned by both a SHA-256
// fixture hash and a Keccak Merkle experienceCorpusRoot. This is intentionally
// large enough for real local/testnet/mainnet dry-run testing, not just Phase 7
// calibration.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k?.startsWith('--')) args.set(k, process.argv[++i] ?? '');
}

const COUNT = Number(args.get('--count') ?? '10000');
const OUT = resolve(REPO, args.get('--out') ?? 'benchmark/fixtures/season1/coretex_season1_10000.json');
if (!Number.isSafeInteger(COUNT) || COUNT < 1000) {
  throw new Error('--count must be a safe integer >= 1000');
}

const { keccak256 } = await import('../packages/cortex/dist/state/keccak256.js');

const FAMILY_PLAN = [
  ['near_collision', 0.22],
  ['temporal_current', 0.14],
  ['temporal_stale', 0.14],
  ['long_horizon', 0.22],
  ['multi_hop_project', 0.10],
  ['preference_drift', 0.08],
  ['tool_api_fact', 0.05],
  ['domain_library_fact', 0.05],
];

const DOMAINS = [
  'botcoin protocol', 'onchain settlement', 'agent memory', 'retrieval routing',
  'temporal reasoning', 'tool calling', 'research synthesis', 'wallet ops',
  'domain libraries', 'validator replay', 'audit trails', 'reward accounting',
];
const PROJECTS = ['Atlas', 'Beacon', 'Cedar', 'Delta', 'Ember', 'Flux', 'Granite', 'Helix'];
const PEOPLE = ['Ari', 'Bea', 'Cal', 'Dee', 'Eli', 'Fia', 'Gus', 'Hal'];
const TOOLS = ['cast', 'forge', 'anvil', 'node', 'sqlite', 'nginx', 'cloudflared', 'systemd'];

function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function pick(seed, salt, arr) {
  const h = createHash('sha256').update(`${seed}:${salt}`).digest();
  return arr[h.readUInt32BE(0) % arr.length];
}

function familyFor(i) {
  const x = (i % 10_000) / 10_000;
  let acc = 0;
  for (const [name, weight] of FAMILY_PLAN) {
    acc += weight;
    if (x < acc) return name;
  }
  return FAMILY_PLAN.at(-1)[0];
}

function makeItem(i) {
  const rawFamily = familyFor(i);
  const seed = `season1:${i}`;
  const domain = pick(seed, 'domain', DOMAINS);
  const project = pick(seed, 'project', PROJECTS);
  const person = pick(seed, 'person', PEOPLE);
  const tool = pick(seed, 'tool', TOOLS);
  const epochCommitted = 1 + (i % 30);
  const protectedItem = i % 17 === 0;
  const id = `s1-${i.toString().padStart(5, '0')}`;
  const sourceRef = `botcoin-dacr-domain-library:season1:apache-2.0:${id}`;

  if (rawFamily === 'near_collision') {
    const code = sha256Hex(`${domain}:${project}:${i}`).slice(0, 12);
    const near = code.slice(0, 11) + (code.endsWith('a') ? 'b' : 'a');
    return {
      id,
      family: 'near_collision',
      source: 'dacr_near_collision',
      protected: protectedItem,
      epoch_committed: epochCommitted,
      source_ref: sourceRef,
      query: `Retrieve the exact ${domain} memory for project ${project} with key ${code}, not the near key ${near}.`,
      truth: `Project ${project} stores ${domain} fact ${code}: route to shard ${i % 64} and ignore near-collision key ${near}.`,
      relevant: true,
      bit_flip_distance: 1 + (i % 5),
    };
  }

  if (rawFamily === 'temporal_current' || rawFamily === 'temporal_stale' || rawFamily === 'preference_drift') {
    const isStale = rawFamily === 'temporal_stale' || (rawFamily === 'preference_drift' && i % 2 === 1);
    const oldValue = pick(seed, 'old', ['blue', 'draft', 'api-v1', 'low-risk', 'manual', 'legacy']);
    const newValue = pick(seed, 'new', ['green', 'final', 'api-v2', 'high-confidence', 'automatic', 'current']);
    return {
      id,
      family: 'temporal',
      task: rawFamily,
      protected: protectedItem,
      epoch_committed: epochCommitted,
      source_ref: sourceRef,
      query: `What is ${person}'s current ${domain} setting for ${project}?`,
      truth: `${person}'s ${domain} setting for ${project} is ${isStale ? oldValue : newValue}.`,
      is_stale: isStale,
    };
  }

  const longFamily = rawFamily === 'long_horizon' ? 'long_horizon' : rawFamily;
  return {
    id,
    family: 'long_horizon',
    config: longFamily,
    protected: protectedItem,
    epoch_committed: epochCommitted,
    source_ref: sourceRef,
    query: `Use the stored ${longFamily.replaceAll('_', ' ')} memory for ${project} when solving a future ${domain} challenge.`,
    truth: `${project} ${longFamily.replaceAll('_', ' ')} fact ${i}: ${tool} is the relevant tool, ${person} owns the handoff, and shard ${i % 128} carries the supporting memory.`,
  };
}

const items = Array.from({ length: COUNT }, (_, i) => makeItem(i));
const counts = {};
for (const item of items) counts[item.config ?? item.task ?? item.source ?? item.family] = (counts[item.config ?? item.task ?? item.source ?? item.family] ?? 0) + 1;

const fixtureWithoutHashes = {
  version: 'coretex-season1-v1',
  source: 'Botcoin DACR-shaped synthetic memory corpus',
  license_spdx: 'Apache-2.0',
  generated_at: '2026-05-07T00:00:00.000Z',
  record_count: COUNT,
  counts,
  notes: [
    'Designed for real CoreTex local/testnet/mainnet dry-run testing.',
    'Content is deterministic synthetic source-of-truth, not user-private data.',
    'Use CORTEX_CORPUS_SEASON=season1 and CORTEX_EVAL_ITEMS_PER_FAMILY for hidden-shard eval.',
  ],
  items,
};

const corpusHash = createHash('sha256')
  .update(JSON.stringify(fixtureWithoutHashes))
  .digest('hex');

const experienceCorpusRoot = bytesToHex(computeRoot(items.map(toEvent)));
const fixture = {
  ...fixtureWithoutHashes,
  corpus_hash: corpusHash,
  experience_corpus_root: experienceCorpusRoot,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
console.log(JSON.stringify({ out: OUT, count: COUNT, corpusHash, experienceCorpusRoot, counts }, null, 2));

function toEvent(item) {
  const payload = new TextEncoder().encode(JSON.stringify({
    family: item.family,
    task: item.task ?? item.config ?? item.source ?? item.family,
    query: item.query,
    truth: item.truth,
    is_stale: item.is_stale === true,
    epoch_committed: item.epoch_committed,
    source_ref: item.source_ref,
  }));
  return { id: item.id, payload };
}

function computeRoot(events) {
  if (events.length === 0) return new Uint8Array(32);
  let nodes = events
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((event) => {
      const idBytes = new TextEncoder().encode(event.id);
      const leaf = new Uint8Array(4 + idBytes.length + event.payload.length);
      leaf[0] = (idBytes.length >>> 24) & 0xff;
      leaf[1] = (idBytes.length >>> 16) & 0xff;
      leaf[2] = (idBytes.length >>> 8) & 0xff;
      leaf[3] = idBytes.length & 0xff;
      leaf.set(idBytes, 4);
      leaf.set(event.payload, 4 + idBytes.length);
      return keccak256(leaf);
    });
  const zero = new Uint8Array(32);
  let n = 1;
  while (n < nodes.length) n <<= 1;
  while (nodes.length < n) nodes.push(zero);
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const pair = new Uint8Array(64);
      pair.set(nodes[i], 0);
      pair.set(nodes[i + 1], 32);
      next.push(keccak256(pair));
    }
    nodes = next;
  }
  return nodes[0];
}

function bytesToHex(bytes) {
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
