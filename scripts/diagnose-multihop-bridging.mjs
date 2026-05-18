#!/usr/bin/env node
/**
 * Diagnoses why Phase B fails to bridge multi_hop_relation / long_horizon
 * queries. For each diagnostic family, picks K queries, traces:
 *
 *   1. Stage-1: BGE-M3 cosine top firstStageTopK candidates (substrate-agnostic)
 *   2. For each stage-1 candidate doc, the source event's `event.relations`
 *   3. BFS forward + backward (Phase B bidirectional pattern) up to N hops
 *   4. Whether the answer event (event whose truthDocuments contain the truth) is reached
 *
 * Outputs three buckets:
 *   - REACHABLE: answer reached within hop budget — points to (B) budget too small or (C) code bug
 *   - REACHABLE_BUT_FILTERED: answer reached but filtered by edgeType / domain / etc.
 *   - UNREACHABLE: answer not reachable in any number of hops — points to (A) corpus issue
 *
 * No reranker, no substrate. Pure graph traversal over the corpus.
 */
import { distIndex, distBiEncoder } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const corpusPath = flag('corpus');
const families = (flag('families', 'multi_hop_relation,long_horizon')).split(',');
const queriesPerFamily = Number(flag('queries-per-family', '5'));
const hopBudgets = (flag('hops', '1,2,3,4')).split(',').map(Number);
const reportPath = flag('out', '/var/lib/coretex/reports/diagnose-multihop.json');
const seedHex = flag('seed', '0x' + 'cc'.repeat(32));

if (!corpusPath || !existsSync(corpusPath)) { console.error(`--corpus missing: ${corpusPath}`); exit(1); }

const {
  loadProductionCorpus,
  buildPublicCorpusIndex,
  firstStageCandidates,
} = await import(distIndex);

const { dequantize } = await import(distBiEncoder);

console.error(`[diag-mh] loading corpus`);
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.error(`  ${corpus.events.length} events`);

const publicIndex = buildPublicCorpusIndex(corpus);
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;

// Build event maps: by id, by docId-of-truth.
const eventById = new Map(corpus.events.map((e) => [e.id, e]));
const truthDocOwner = new Map(); // docId → owner event id
for (const e of corpus.events) {
  for (const t of e.truthDocuments) truthDocOwner.set(t.id, e.id);
}

// Build forward + inverse relation index keyed by event id.
const fwdRel = new Map();   // eventId -> [{otherId, edgeType}]
const invRel = new Map();   // eventId -> [{otherId, edgeType}]   (inverse)
for (const e of corpus.events) {
  if (!e.relations) continue;
  for (const r of e.relations) {
    const arr = fwdRel.get(e.id) ?? []; arr.push({ otherId: r.other_id, edgeType: r.edgeType }); fwdRel.set(e.id, arr);
    const inv = invRel.get(r.other_id) ?? []; inv.push({ otherId: e.id, edgeType: r.edgeType }); invRel.set(r.other_id, inv);
  }
}
console.error(`[diag-mh] forward edges: ${[...fwdRel.values()].reduce((s, v) => s + v.length, 0)}, inverse edges: ${[...invRel.values()].reduce((s, v) => s + v.length, 0)}`);

function familyPack(family, packSize) {
  const events = corpus.events.filter((e) => e.family === family && e.split === 'calibration');
  const scored = events.map((e) => ({
    e, s: parseInt(createHash('sha256').update(seedHex + ':' + e.id).digest('hex').slice(0, 8), 16) / 0xffffffff,
  }));
  scored.sort((a, b) => a.s - b.s);
  return scored.slice(0, packSize).map((x) => x.e);
}

const results = [];
for (const family of families) {
  console.error(`\n[diag-mh] === family=${family} ===`);
  const pack = familyPack(family, queriesPerFamily);

  for (const q of pack) {
    const queryVec = dequantize(q.embeddings.query, LAYOUT);
    const stage1 = firstStageCandidates(queryVec, publicIndex, 3200);
    const stage1EventIds = new Set(stage1.map((d) => d.eventId));
    const stage1HasOwnerEvent = stage1EventIds.has(q.id);

    // For each truth doc, find its owner event and BFS-trace from stage-1 events.
    const truthDocs = q.truthDocuments;
    const perTruth = [];
    for (const t of truthDocs) {
      const ownerId = truthDocOwner.get(t.id);
      if (!ownerId) {
        perTruth.push({ docId: t.id, ownerEventId: null, status: 'NO_OWNER_EVENT_FOUND' });
        continue;
      }
      // Is the owner event one of the stage-1 source events? Then truth is reachable trivially via stage-1.
      if (stage1EventIds.has(ownerId)) {
        perTruth.push({ docId: t.id, ownerEventId: ownerId, status: 'IN_STAGE1', reachableAtHop: 0 });
        continue;
      }
      // BFS from stage-1 source events; bidirectional, edgeType-agnostic; record min hop.
      let reachedAt = null;
      let visited = new Set(stage1EventIds);
      let frontier = [...stage1EventIds];
      for (let hop = 1; hop <= Math.max(...hopBudgets); hop++) {
        const next = [];
        for (const eid of frontier) {
          for (const r of (fwdRel.get(eid) ?? [])) {
            if (visited.has(r.otherId)) continue;
            visited.add(r.otherId);
            if (r.otherId === ownerId) { reachedAt = hop; break; }
            next.push(r.otherId);
          }
          if (reachedAt !== null) break;
          for (const r of (invRel.get(eid) ?? [])) {
            if (visited.has(r.otherId)) continue;
            visited.add(r.otherId);
            if (r.otherId === ownerId) { reachedAt = hop; break; }
            next.push(r.otherId);
          }
          if (reachedAt !== null) break;
        }
        if (reachedAt !== null) break;
        frontier = next;
      }
      perTruth.push({
        docId: t.id, ownerEventId: ownerId,
        reachableAtHop: reachedAt,
        status: reachedAt === null ? 'UNREACHABLE_BIDI' : (reachedAt <= 2 ? 'REACHABLE_AT_DEFAULT_HOP_BUDGET' : 'REACHABLE_BUT_BEYOND_DEFAULT'),
      });
    }
    // Also check: does THIS query event itself have any forward relations? (does it encode the question→answer path)
    const ownRels = fwdRel.get(q.id) ?? [];
    results.push({
      family, queryId: q.id,
      stage1HasOwnQueryEvent: stage1HasOwnerEvent,
      ownEventForwardRelations: ownRels.length,
      ownEventForwardEdgeTypes: [...new Set(ownRels.map((r) => r.edgeType))],
      truthDocs: perTruth,
    });

    console.error(`  query ${q.id}`);
    console.error(`    stage1HasOwnQueryEvent: ${stage1HasOwnerEvent}, ownEventForwardRels: ${ownRels.length} (${[...new Set(ownRels.map((r) => r.edgeType))].join(',')})`);
    for (const t of perTruth) {
      console.error(`    truth ${t.docId}: owner=${t.ownerEventId ? t.ownerEventId.slice(0, 60) : 'NONE'}, status=${t.status}, reachAt=${t.reachableAtHop}`);
    }
  }
}

// Aggregate buckets
const buckets = {};
for (const r of results) {
  for (const t of r.truthDocs) {
    const key = `${r.family}/${t.status}`;
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
}
console.error(`\n[diag-mh] === buckets ===`);
for (const [k, v] of Object.entries(buckets).sort()) console.error(`  ${k.padEnd(60)} ${v}`);

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify({
  schemaVersion: 'coretex.diagnose-multihop.v1',
  generatedAt: new Date().toISOString(),
  inputs: { corpus: corpusPath, corpusRoot: corpus.corpusRoot, families, queriesPerFamily, hopBudgets, seedHex },
  buckets,
  perQuery: results,
}, null, 2));
console.error(`\n[diag-mh] report → ${reportPath}`);
