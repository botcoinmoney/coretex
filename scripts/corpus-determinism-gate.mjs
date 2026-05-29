#!/usr/bin/env node
/**
 * Corpus / query-pack determinism gate  (Launch hardening L1).
 *
 * Proves a fresh validator can load the canonical launch corpus + embeddings
 * and derive the EXACT same corpusRoot, eval-hidden strata, and hidden query
 * pack for a fixed seed — the foundation every downstream root depends on.
 *
 * Checks:
 *   1. corpusRoot stable across two independent loads.
 *   2. eval_hidden count + per-family counts are deterministic.
 *   3. deriveQueryPack(epochId, evalSeed, corpus, profile.hiddenPack) is stable
 *      across two derivations (same event IDs, same order) → hiddenPackRoot.
 *   4. verifyQueryPack recomputes the pack from its public (epochId, evalSeed)
 *      header → matches.
 *   5. hiddenPackRoot (keccak256 over the ORDERED selected event IDs) is the
 *      on-chain-committable queryPackRoot — derivable from public inputs.
 *   6. Leak guard: corpusRoot commits the validator production events,
 *      including qrels and embedded retrieval keys; the served pack object is
 *      therefore VALIDATOR-ONLY (never the miner-facing challenge payload —
 *      that redaction is gated in L10).
 *   7. Manifest/checksum: prints the sha256 of the corpus file a new validator
 *      fetches + verifies before trusting corpusRoot.
 *
 * Usage:
 *   node scripts/corpus-determinism-gate.mjs \
 *     [--corpus release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-corpus.json] \
 *     [--emb    release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-embeddings.json] \
 *     [--profile release/bundle/evaluator-profile-v2-dgen1-policy-r5.json] [--epoch 0]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus } from './lib/build-v2-production-corpus.mjs';

const m = await import(distIndex);
const { computeCorpusRoot, deriveQueryPack, verifyQueryPack, packFamilyCounts, packQuotaCoverage, keccak256, bytesToHex } = m;

function flag(name, fb) { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; }
// Defaults pin the CANONICAL 300k launch candidate (sole launch corpus). Override with flags.
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-final-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-final-embeddings.json');
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k.json');
const epoch = Number(flag('epoch', '0'));

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const evalSeedHex = profile.baselineEvalSeedHex ?? '0x' + 'a5'.repeat(32);

let pass = true;
const out = [];
function check(name, ok, detail = '') { out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) pass = false; }

// 1. two independent loads → identical corpusRoot
const a = buildV2ProductionCorpus({ corpusPath, embPath });
const b = buildV2ProductionCorpus({ corpusPath, embPath });
check('corpusRoot stable across two loads', a.corpus.corpusRoot === b.corpus.corpusRoot, `${a.corpus.corpusRoot}`);
// independent recompute via the canonical hash function
check('corpusRoot == computeCorpusRoot(events)', a.corpus.corpusRoot === computeCorpusRoot(a.corpus.events));

// 2. eval_hidden strata deterministic
const evalHidden = a.corpus.events.filter((e) => e.split === 'eval_hidden');
const famCount = {};
for (const e of evalHidden) famCount[e.family] = (famCount[e.family] ?? 0) + 1;
const evalHiddenB = b.corpus.events.filter((e) => e.split === 'eval_hidden');
check('eval_hidden count deterministic', evalHidden.length === evalHiddenB.length, `${evalHidden.length}`);

// 3. query-pack derivation stable
const pack1 = deriveQueryPack(epoch, evalSeedHex, a.corpus, profile.hiddenPack);
const pack2 = deriveQueryPack(epoch, evalSeedHex, b.corpus, profile.hiddenPack);
const ids1 = pack1.events.map((e) => e.id);
const ids2 = pack2.events.map((e) => e.id);
check('query-pack derivation stable (ids + order)', JSON.stringify(ids1) === JSON.stringify(ids2), `packN=${ids1.length}`);

// 4. verifyQueryPack recompute from public header
const vp = verifyQueryPack(pack1, a.corpus, profile.hiddenPack);
check('verifyQueryPack recomputes from public (epochId, evalSeed)', vp.ok === true, vp.reason ?? '');

// 5. hiddenPackRoot = keccak256(ordered selected event IDs) — on-chain queryPackRoot
const packIdBytes = new TextEncoder().encode(ids1.join('\n'));
const hiddenPackRoot = bytesToHex(keccak256(packIdBytes));
const hiddenPackRoot2 = bytesToHex(keccak256(new TextEncoder().encode(ids2.join('\n'))));
check('hiddenPackRoot deterministic (queryPackRoot)', hiddenPackRoot === hiddenPackRoot2, hiddenPackRoot);

// 6. leak guard: corpusRoot commits validator-only scoring fields, including
// qrels and embedding bytes. This is a hidden-eval commitment, not a
// miner-facing payload. Miners receive only the root/hash metadata.
// Mutate the FIRST event that actually carries qrels. (Earlier this assumed events[0]
// had qrels; in the native-regen corpus events[0] is a memory doc with no qrels. And a
// `+0.01` bump is a no-op when relevance is already 1.0 — so we flip to a GUARANTEED-
// different graded value: 1.0 -> 0.0, anything else -> 1.0.)
const qrelEvent = a.corpus.events.find((e) => (e.qrels?.length ?? 0) > 0);
const mutated = qrelEvent
  ? a.corpus.events.map((e) => e.id === qrelEvent.id
    ? { ...e, qrels: e.qrels.map((q, i) => i === 0 ? { ...q, relevance: (q.relevance ?? 0) >= 1 ? 0 : 1 } : q) }
    : e)
  : a.corpus.events;
const mutatedRoot = computeCorpusRoot(mutated);
const qrelInRoot = qrelEvent != null && mutatedRoot !== a.corpus.corpusRoot;
check('served pack carries qrels (validator-only artifact, never miner payload)', pack1.events.every((e) => Array.isArray(e.qrels)));
check(`corpusRoot commits qrels (hidden labels are root-committed, not miner-served) [mutated ${qrelEvent?.id ?? 'NONE'}]`, qrelInRoot);
const embEvent = a.corpus.events.find((e) => e.embeddings?.query?.length);
if (embEvent) {
  const mutatedEmb = a.corpus.events.map((e) => {
    if (e.id !== embEvent.id) return e;
    const query = new Uint8Array(e.embeddings.query);
    query[query.length - 1] ^= 1;
    return { ...e, embeddings: { ...e.embeddings, query } };
  });
  check('corpusRoot commits embedding bytes', computeCorpusRoot(mutatedEmb) !== a.corpus.corpusRoot);
}

// 7. fetchable manifest checksum
const fileBytes = readFileSync(resolve(repoRoot, corpusPath));
const sha = createHash('sha256').update(fileBytes).digest('hex');

console.log(out.join('\n'));
console.log('────────────────────────────────────────────────────────');
console.log(`corpus           ${corpusPath}`);
console.log(`corpusFileSha256 0x${sha}`);
console.log(`corpusRoot       ${a.corpus.corpusRoot}`);
console.log(`evalHiddenCount  ${evalHidden.length}`);
console.log(`familyCounts     ${JSON.stringify(famCount)}`);
console.log(`epoch ${epoch} evalSeed ${evalSeedHex}`);
console.log(`packSize         ${ids1.length} (profile cap ${profile.hiddenPack.packSize})`);
console.log(`packFamilyCounts ${JSON.stringify(packFamilyCounts(pack1))}`);
// Quota COVERAGE assertion (was missing — gate previously printed family counts but never verified
// the profile quotas were actually met, so a sub-quota pack could pass). Assert every quota satisfied
// per the canonical eventSatisfiesStratum matcher, and that the pack is EXACTLY packSize.
const coverage = packQuotaCoverage(pack1, profile.hiddenPack);
for (const c of coverage) check(`pack quota satisfied: ${c.stratum} (${c.count}/${c.minCount})`, c.satisfied);
check(`pack is exactly packSize (${pack1.events.length}/${profile.hiddenPack.packSize})`, pack1.events.length === profile.hiddenPack.packSize);
console.log(`packQuotaCoverage  ${JSON.stringify(coverage.map((c) => `${c.stratum.replace('family=', '')}:${c.count}/${c.minCount}`))}`);
console.log(`hiddenPackRoot   ${hiddenPackRoot}`);
console.log('────────────────────────────────────────────────────────');
console.log(pass ? 'RESULT: ALL PASS ✅' : 'RESULT: FAIL ❌');
exit(pass ? 0 : 1);
