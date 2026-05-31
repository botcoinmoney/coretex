#!/usr/bin/env node
/**
 * Corpus retrieval-health gate. Hard-fail check that runs BEFORE any A100 spend on
 * a given corpus artifact. Catches the class of failure documented in
 * release/calibration/2026-05-30-corpus-retrieval-collapse.md (active 300k-final
 * artifact has 82% exact-text duplication → 80%+ exact-embedding duplication →
 * 99.3% of pack queries have no truth doc in first-stage top-K).
 *
 * Three checks:
 *   1. exact text duplicate rate (fraction of memory events in a non-singleton
 *      text cluster) — catches generator template-diversity failures.
 *   2. exact embedding duplicate rate (fraction of memory events in a non-singleton
 *      int8-payload cluster) — catches embedding-pipeline collisions (whether driven
 *      by upstream text duplication OR an actual embedding-pipeline bug).
 *   3. truth-doc topK reachability by family at profile.firstStageTopK (fraction of
 *      pack queries with any truth doc in bi-encoder first-stage) — the calibration
 *      foundation. Substrate cannot help docs that don't enter the candidate pool.
 *
 * SHA-pin discipline: the gate report identifies the corpus + embeddings artifacts
 * by sha256, never just by path (gitignored artifacts can change without a commit).
 *
 * Default thresholds (override via env or CLI):
 *   text-dup-fail >= 20%        --max-text-dup 0.20
 *   embedding-dup-fail >= 20%   --max-emb-dup 0.20
 *   per-family-reachability-fail < 10%  --min-family-reachable 0.10
 *
 * Usage:
 *   node scripts/corpus-retrieval-health-gate.mjs \
 *     --profile release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-calibration.json \
 *     --bundle  release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-calibration.json \
 *     --corpus  release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-final-corpus.json \
 *     --emb     release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-final-embeddings.json \
 *     [--sample 50000] [--seeds a5,b7,c3] [--iters 10] [--pack-size 64]
 *     [--out release/calibration/.../corpus-retrieval-health-<corpusSha8>.json]
 *
 * Exit 0 if all three gates PASS; exit 1 with a structured failure list otherwise.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { argv, env, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { buildV2ProductionCorpus } from './lib/build-v2-production-corpus.mjs';

const C = await import(distIndex);
const { buildPublicCorpusIndex, firstStageCandidates, deriveQueryPack } = C;

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const PROFILE_PATH = flag('profile');
const BUNDLE_PATH = flag('bundle');
const CORPUS_PATH = flag('corpus');
const EMB_PATH = flag('emb');
const SAMPLE_N = Number(flag('sample', '50000'));
const SEEDS = (flag('seeds', 'a5,b7,c3')).split(',');
const ITERS = Number(flag('iters', '10'));
const PACK_SIZE = Number(flag('pack-size', '64'));
const MAX_TEXT_DUP = Number(env.MAX_TEXT_DUP ?? flag('max-text-dup', '0.20'));
const MAX_EMB_DUP = Number(env.MAX_EMB_DUP ?? flag('max-emb-dup', '0.20'));
const MIN_FAM_REACH = Number(env.MIN_FAMILY_REACHABLE ?? flag('min-family-reachable', '0.10'));
const OUT_PATH = flag('out');
// `--inline-build` bypasses the materialized cache: builds the production corpus
// in-memory directly from (corpus, emb, bundle) source files. Required for ad-hoc small
// candidate corpora that don't yet have a bundle/materialization. Bundle is still required
// as the biEncoder pin source.
const INLINE_BUILD = argv.includes('--inline-build');
if (!PROFILE_PATH || !BUNDLE_PATH || !CORPUS_PATH || !EMB_PATH) {
  console.error('HARD FAIL: --profile, --bundle, --corpus, --emb required'); exit(2);
}
if (!existsSync(resolve(repoRoot, CORPUS_PATH))) { console.error(`HARD FAIL: corpus path missing: ${CORPUS_PATH}`); exit(2); }
if (!existsSync(resolve(repoRoot, EMB_PATH))) { console.error(`HARD FAIL: emb path missing: ${EMB_PATH}`); exit(2); }

// ─── SHA-pin: identify artifacts by content hash ───
function sha256File(p) {
  const h = createHash('sha256');
  const buf = readFileSync(resolve(repoRoot, p));
  h.update(buf);
  return h.digest('hex');
}
const corpusSha = sha256File(CORPUS_PATH);
const embSha = sha256File(EMB_PATH);
const profileSha = sha256File(PROFILE_PATH);
const bundleSha = sha256File(BUNDLE_PATH);
console.log(`[health-gate] corpus sha256=${corpusSha}`);
console.log(`[health-gate]    emb sha256=${embSha}`);
console.log(`[health-gate]profile sha256=${profileSha}`);
console.log(`[health-gate] bundle sha256=${bundleSha}`);

// ─── Load corpus (materialized cache OR inline-build) ───
let corpus, BE, LAYOUT, matBundleHash;
if (INLINE_BUILD) {
  console.log('[health-gate] inline-build mode: building production corpus in-memory (no materialized cache) ...');
  const built = buildV2ProductionCorpus({ corpusPath: CORPUS_PATH, embPath: EMB_PATH, bundlePath: BUNDLE_PATH });
  corpus = built.corpus; BE = built.BE; LAYOUT = built.LAYOUT;
  matBundleHash = '(none — inline-build)';
} else {
  console.log('[health-gate] loading materialized corpus ...');
  const loaded = loadMaterializedCorpus(BUNDLE_PATH, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH });
  corpus = loaded.corpus; BE = loaded.BE; LAYOUT = loaded.LAYOUT;
  matBundleHash = loaded.manifest.bundleHash;
}
console.log(`[health-gate] bundleHash=${matBundleHash} corpusRoot=${corpus.corpusRoot.slice(0, 18)}…  events=${corpus.events.length}`);
const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
const firstStageTopK = profile.firstStageTopK ?? 3200;
console.log(`[health-gate] firstStageTopK from profile = ${firstStageTopK}`);

const failures = [];
function gate(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} [${name}] ${detail}`);
  if (!ok) failures.push({ name, detail });
}

// ─── Check 1: exact text duplicate rate ─────────────────────────────────────
console.log('\n=== check 1: exact text duplicate rate (memory events) ===');
const memEvents = corpus.events.filter((e) => e.id.startsWith('mem_'));
const sample = memEvents.slice(0, Math.min(SAMPLE_N, memEvents.length));
console.log(`[health-gate] sample size: ${sample.length} of ${memEvents.length} memory events`);

const textClusters = new Map(); // text-sha → count
let textNullOrEmpty = 0;
for (const ev of sample) {
  // The doc text lives in truthDocuments[0].text for mem_* events emitted by the bridge,
  // OR in queryText (the bridge sets queryText = doc text for mem events). Prefer truth.
  const text = ev.truthDocuments?.[0]?.text ?? ev.queryText ?? '';
  if (!text) { textNullOrEmpty++; continue; }
  const h = createHash('sha256').update(text).digest('hex').slice(0, 16);
  textClusters.set(h, (textClusters.get(h) ?? 0) + 1);
}
const totalText = sample.length - textNullOrEmpty;
const nonSingletonText = [...textClusters.values()].filter((c) => c > 1);
const inDupTextCluster = nonSingletonText.reduce((a, b) => a + b, 0);
const textDupRate = totalText > 0 ? inDupTextCluster / totalText : 0;
const largestTextClusters = [...textClusters.values()].sort((a, b) => b - a).slice(0, 10);
console.log(`[health-gate] unique text payloads: ${textClusters.size} / ${totalText} (${(100 * textClusters.size / totalText).toFixed(2)}% unique)`);
console.log(`[health-gate] non-singleton text clusters: ${nonSingletonText.length} covering ${inDupTextCluster} events`);
console.log(`[health-gate] largest text-cluster sizes (top 10): ${largestTextClusters.join(', ')}`);
gate('text-dup-rate',
  textDupRate <= MAX_TEXT_DUP,
  `dup-rate=${(100 * textDupRate).toFixed(2)}%  threshold=<=${(100 * MAX_TEXT_DUP).toFixed(0)}%  (${inDupTextCluster}/${totalText} in non-singleton clusters)`);

// ─── Check 2: exact embedding duplicate rate ────────────────────────────────
console.log('\n=== check 2: exact embedding duplicate rate (int8 payload, excluding scale header) ===');
const embClusters = new Map();
let embNullOrEmpty = 0;
for (const ev of sample) {
  const e = ev.embeddings?.query;
  if (!e || e.length <= 4) { embNullOrEmpty++; continue; }
  // Skip first 4 bytes (float32 scale header); hash the int8 payload only.
  const payload = e.subarray ? e.subarray(4) : Buffer.from(e).slice(4);
  const h = createHash('sha256').update(payload).digest('hex').slice(0, 16);
  embClusters.set(h, (embClusters.get(h) ?? 0) + 1);
}
const totalEmb = sample.length - embNullOrEmpty;
const nonSingletonEmb = [...embClusters.values()].filter((c) => c > 1);
const inDupEmbCluster = nonSingletonEmb.reduce((a, b) => a + b, 0);
const embDupRate = totalEmb > 0 ? inDupEmbCluster / totalEmb : 0;
const largestEmbClusters = [...embClusters.values()].sort((a, b) => b - a).slice(0, 10);
console.log(`[health-gate] unique int8 payloads: ${embClusters.size} / ${totalEmb} (${(100 * embClusters.size / totalEmb).toFixed(2)}% unique)`);
console.log(`[health-gate] non-singleton embedding clusters: ${nonSingletonEmb.length} covering ${inDupEmbCluster} events`);
console.log(`[health-gate] largest emb-cluster sizes (top 10): ${largestEmbClusters.join(', ')}`);
gate('embedding-dup-rate',
  embDupRate <= MAX_EMB_DUP,
  `dup-rate=${(100 * embDupRate).toFixed(2)}%  threshold=<=${(100 * MAX_EMB_DUP).toFixed(0)}%  (${inDupEmbCluster}/${totalEmb} in non-singleton clusters)`);

// ─── Check 3: per-family truth-rank reachability ────────────────────────────
console.log(`\n=== check 3: per-family truth-rank reachability in bi-encoder top-${firstStageTopK} (${SEEDS.length} seeds × ${ITERS} iters × pack-${PACK_SIZE}) ===`);
const pubIndex = buildPublicCorpusIndex(corpus);
const hiddenPack = { ...profile.hiddenPack, packSize: PACK_SIZE, quotas: [] };
const byFam = new Map();
for (const baseSeed of SEEDS) {
  for (let p = 0; p < ITERS; p++) {
    const seedHex = '0x' + createHash('sha256').update(`${baseSeed}:${p}`).digest('hex');
    const pack = deriveQueryPack(p, seedHex, corpus, hiddenPack);
    for (const ev of pack.events) {
      const fam = ev.logicalFamily ?? ev.family;
      const targets = (ev.truthDocuments ?? []).map((t) => t.id);
      if (targets.length === 0) continue; // skip abstention-pattern queries (no truths)
      if (!byFam.has(fam)) byFam.set(fam, { total: 0, retrievable: 0, ranks: [] });
      const bucket = byFam.get(fam);
      bucket.total++;
      const cands = firstStageCandidates(ev.embeddings.query, pubIndex, firstStageTopK);
      let bestRank = Infinity;
      for (const t of targets) {
        const idx = cands.findIndex((c) => (c.documentId ?? c.id) === t);
        if (idx >= 0 && idx + 1 < bestRank) bestRank = idx + 1;
      }
      if (bestRank !== Infinity) bucket.retrievable++;
      bucket.ranks.push(bestRank === Infinity ? -1 : bestRank);
    }
  }
}
const familyReport = {};
for (const [fam, b] of byFam) {
  const reach = b.total > 0 ? b.retrievable / b.total : 0;
  const validRanks = b.ranks.filter((r) => r > 0).sort((a, b) => a - b);
  const p10 = validRanks[Math.floor(validRanks.length * 0.1)] ?? null;
  const p50 = validRanks[Math.floor(validRanks.length * 0.5)] ?? null;
  const p90 = validRanks[Math.floor(validRanks.length * 0.9)] ?? null;
  familyReport[fam] = { total: b.total, retrievable: b.retrievable, reach, p10, p50, p90 };
  gate(`family-reachability/${fam}`,
    reach >= MIN_FAM_REACH,
    `reach=${(100 * reach).toFixed(1)}%  threshold>=${(100 * MIN_FAM_REACH).toFixed(0)}%  n=${b.total}  retrievable=${b.retrievable}  ranks p10=${p10} p50=${p50} p90=${p90}`);
}

// ─── Emit report ────────────────────────────────────────────────────────────
const report = {
  schema: 'coretex.corpus-retrieval-health-gate.v1',
  generatedAt: new Date().toISOString(),
  artifacts: {
    corpus: { path: CORPUS_PATH, sha256: corpusSha, size: statSync(resolve(repoRoot, CORPUS_PATH)).size },
    embeddings: { path: EMB_PATH, sha256: embSha, size: statSync(resolve(repoRoot, EMB_PATH)).size },
    profile: { path: PROFILE_PATH, sha256: profileSha },
    bundle: { path: BUNDLE_PATH, sha256: bundleSha, bundleHash: matBundleHash },
    corpusRoot: corpus.corpusRoot,
  },
  thresholds: { MAX_TEXT_DUP, MAX_EMB_DUP, MIN_FAM_REACH },
  sample: { requested: SAMPLE_N, actual: sample.length, totalMemoryEvents: memEvents.length },
  text_duplication: { uniquePayloads: textClusters.size, totalEvents: totalText, nullOrEmpty: textNullOrEmpty,
    duplicateRate: textDupRate, nonSingletonClusterCount: nonSingletonText.length,
    eventsInNonSingletonClusters: inDupTextCluster, largestClusterSizes: largestTextClusters },
  embedding_duplication: { uniquePayloads: embClusters.size, totalEvents: totalEmb, nullOrEmpty: embNullOrEmpty,
    duplicateRate: embDupRate, nonSingletonClusterCount: nonSingletonEmb.length,
    eventsInNonSingletonClusters: inDupEmbCluster, largestClusterSizes: largestEmbClusters },
  family_reachability: { firstStageTopK, seeds: SEEDS, iters: ITERS, packSize: PACK_SIZE, perFamily: familyReport },
  verdict: { pass: failures.length === 0, failedGates: failures },
};

const defaultOut = OUT_PATH ?? `release/calibration/2026-05-21-memory-corpus-v2/corpus-retrieval-health-${corpusSha.slice(0, 8)}.json`;
mkdirSync(dirname(resolve(repoRoot, defaultOut)), { recursive: true });
writeFileSync(resolve(repoRoot, defaultOut), JSON.stringify(report, null, 2));
console.log(`\n[health-gate] wrote ${defaultOut}`);

console.log(`\n${report.verdict.pass ? 'HEALTH GATE: ALL PASS ✅' : `HEALTH GATE: HARD FAIL ❌ (${failures.length} gate(s))`}`);
if (!report.verdict.pass) {
  console.log('failed gates:');
  for (const f of failures) console.log(`  • ${f.name} — ${f.detail}`);
  console.log(`\nDo NOT spend A100 time on this corpus artifact (sha ${corpusSha.slice(0, 8)}…) until these gates pass.`);
}
exit(report.verdict.pass ? 0 : 1);
