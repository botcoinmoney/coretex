#!/usr/bin/env node
/**
 * Build a DEEP-MEMORY track by remapping owner-scope namespaces of an existing V2
 * logical corpus (runbook Phase 1E experimental-remap fallback — clearly a STRESS
 * artifact, not canonical generator output).
 *
 * Owner-scope retrieval matches query.ownerEntityId against doc event.entityIds[] via
 * the entity-scope index (retrieval-benchmark.ts getOrBuildEntityScopeIndex). So:
 *   - D1 unified-deep  (--namespaces 1): every doc + every scoped query → ONE shared
 *     owner → each query retrieves over the FULL active store (deep universe).
 *   - D2 few-namespace-deep (--namespaces 4|16): hash each original owner into N
 *     buckets; a query and its gold docs share the original owner → same bucket →
 *     gold stays reachable, but each namespace is now very large.
 * Doc embeddings are label-independent (text-only), so the existing embeddings cache
 * is reused unchanged — no re-embed.
 *
 * Pooled families (ownerScoped===false: entity_disambiguation, abstention) are left
 * untouched (they already search the full pool).
 *
 * Usage:
 *   node scripts/remap-v2-deep-namespaces.mjs --corpus .../p3-corpus.json \
 *     --namespaces 1 --phase D1 --out .../d1-corpus.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p3-corpus.json');
const nNamespaces = Number(flag('namespaces', '1'));
const phase = flag('phase', nNamespaces === 1 ? 'D1' : `D2-${nNamespaces}`);
const outPath = flag('out', `release/calibration/2026-05-21-memory-corpus-v2/${phase.toLowerCase()}-corpus.json`);

function hseed(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const bucket = (eid) => nNamespaces === 1 ? 'e_deep_unified' : `e_deep_ns${hseed(eid) % nNamespaces}`;

const c = JSON.parse(readFileSync(resolve(corpusPath), 'utf8'));
const sourcePhase = c.phase;
let docsRemapped = 0, qRemapped = 0, qPooled = 0;

// docs: remap each doc's entityIds → its bucket owner(s) (dedup). Docs with no
// entityIds (rare) get tagged into every namespace so they remain retrievable.
const allBuckets = nNamespaces === 1 ? ['e_deep_unified'] : Array.from({ length: nNamespaces }, (_, i) => `e_deep_ns${i}`);
for (const d of c.docs) {
  if (Array.isArray(d.entityIds) && d.entityIds.length) {
    d.entityIds = [...new Set(d.entityIds.map(bucket))];
  } else {
    d.entityIds = allBuckets.slice(); // ubiquitous doc: visible in every namespace
  }
  docsRemapped++;
}
// queries: scoped families → bucket(ownerEntityId); pooled families untouched.
for (const q of c.queries) {
  if (q.ownerScoped !== false && q.ownerEntityId) {
    q.ownerEntityId = bucket(q.ownerEntityId);
    q.ownerScoped = true;
    qRemapped++;
  } else {
    qPooled++;
  }
}

// entity table: keep original entities (relation/alias semantics) AND add the deep
// namespace owners so canonicalName lookups don't break.
c.entities = [...(c.entities ?? []), ...allBuckets.map((b) => ({ id: b, canonicalName: b, aliases: [], lane: 'deep_remap' }))];

// ── corpus diagnostics (runbook 1D) ──
const docsPerNs = {};
for (const d of c.docs) for (const e of d.entityIds) docsPerNs[e] = (docsPerNs[e] ?? 0) + 1;
// active-store size per scoped query = #docs tagged with the query's owner bucket.
const storeSizes = c.queries.filter((q) => q.ownerScoped !== false && q.ownerEntityId).map((q) => docsPerNs[q.ownerEntityId] ?? 0);
storeSizes.sort((a, b) => a - b);
const pct = (p) => storeSizes.length ? storeSizes[Math.min(storeSizes.length - 1, Math.floor(p * storeSizes.length))] : 0;
// in-namespace same-canonical-name collisions: entities sharing a first-name alias within a bucket
// (proxy: count of docs whose entity alias collides — measured at query level via hardNegatives is more direct, skip heavy calc here)
// temporal-chain length histogram (supersedes links) and relation fanout (out-degree).
const supersedeChain = {}; // docId -> chain length following supersedesDocId
const relOut = {};
for (const r of (c.relations ?? [])) relOut[r.src] = (relOut[r.src] ?? 0) + 1;
const fanoutHist = {}; for (const v of Object.values(relOut)) fanoutHist[v] = (fanoutHist[v] ?? 0) + 1;
const tempPairs = c.docs.filter((d) => d.supersedesDocId || d.supersededByDocId).length;

c.phase = phase;
c.deepRemap = { source: corpusPath, sourcePhase, namespaces: nNamespaces, experimental: true,
  note: 'STRESS ARTIFACT (runbook Phase 1E): owner-scope namespaces collapsed to test deep active-store retrieval; reuse source embeddings; NOT canonical generator output.' };
c.deepDiagnostics = {
  totalDocs: c.docs.length, totalQueries: c.queries.length, totalEntities: c.entities.length,
  namespaceCount: nNamespaces, docsRemapped, queriesRemapped: qRemapped, queriesPooled: qPooled,
  docsPerNamespace: docsPerNs,
  activeStorePerScopedQuery: { min: storeSizes[0] ?? 0, p50: pct(0.5), p95: pct(0.95), max: storeSizes.at(-1) ?? 0 },
  temporalChainDocPairs: tempPairs, relationFanoutHistogram: fanoutHist,
};

writeFileSync(resolve(outPath), JSON.stringify(c));
console.log(`# deep-remap ${sourcePhase} → ${phase} (${nNamespaces} namespace${nNamespaces > 1 ? 's' : ''})`);
console.log(JSON.stringify({ phase, namespaces: nNamespaces, docs: c.docs.length, queries: c.queries.length,
  queriesRemapped: qRemapped, queriesPooled: qPooled, activeStorePerScopedQuery: c.deepDiagnostics.activeStorePerScopedQuery,
  temporalChainDocPairs: tempPairs }, null, 2));
console.log(`wrote ${outPath} (reuse embeddings: ${sourcePhase}-embeddings.json)`);
