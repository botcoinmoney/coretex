#!/usr/bin/env node
/**
 * Reranker-cache probe.
 *
 * Verifies in 1–5 minutes (instead of hours) whether the LRU score cache
 * is producing the expected cold-vs-warm speedup on the production-faithful
 * hidden-pack path. Three measurements per run:
 *
 *   COLD   — first evaluateRetrievalBenchmarkState call: full reranker work.
 *   WARM   — same call again on same state + same pack: every (query, doc)
 *            pair should hit the cache → reranker time ≈ 0.
 *   CHILD  — same pack against a substrate that touches only a non-routing
 *            field (temporal). Candidate pool is identical → cache should
 *            still cover the full pair set.
 *
 * Expected with cache: WARM ≪ COLD, CHILD ≪ COLD. Without cache (or with
 * too-small cache): WARM ≈ COLD.
 *
 * Usage:
 *   CORETEX_RERANKER_CACHE_SIZE=100000 \
 *   node --max-old-space-size=24576 scripts/probe-reranker-cache.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *     --bundle-profile /etc/coretex/bundle-profile-launch-v3.json
 */
import { distIndex } from './_repo-root.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { argv, exit, env } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}
const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const seedHex = flag('seed', '0x' + 'cc'.repeat(32));
const packSizeOverride = Number(flag('pack-size', '0')) || null;
// Optional production-faithful throughput simulation: N patches each with a
// unique synthetic gateSeed (mimics live submit where every patch's seed
// includes patchHash). Reports per-patch ms and cache hit-rate so the
// production cache-benefit ceiling is measurable.
const uniqueSeedPatches = Number(flag('unique-seed-patches', '0')) || 0;
if (!corpusPath || !existsSync(corpusPath)) { console.error('missing --corpus'); exit(1); }

const {
  loadProductionCorpus, evaluateRetrievalBenchmarkState, deriveQueryPack,
  biEncoderModelIdHash, rerankerFromEnv, biEncoderFromEnv,
  DEFAULT_PROFILE, RANGES,
  getRerankerCacheStats,
} = await import(distIndex);

console.log(`[probe] CORETEX_RERANKER_CACHE_SIZE=${env.CORETEX_RERANKER_CACHE_SIZE ?? '(default)'}`);
console.log(`[probe] loading corpus`);
const t0 = Date.now();
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.log(`  loaded ${corpus.events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const profile = profilePath && existsSync(profilePath)
  ? (() => { const r = JSON.parse(readFileSync(profilePath, 'utf8')); return r.profile ?? r; })()
  : DEFAULT_PROFILE;

const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);

const reranker = await rerankerFromEnv();
const biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });
console.log(`[probe] reranker: ${reranker.model}`);

// Production-faithful pack derivation from profile.hiddenPack, unless
// --pack-size overrides for a faster probe.
let pack;
if (packSizeOverride) {
  pack = { epochId: 0, evalSeedCommit: seedHex, events: corpus.events.slice(0, packSizeOverride) };
} else if (profile.hiddenPack) {
  pack = deriveQueryPack(0, seedHex, corpus, profile.hiddenPack);
} else {
  pack = { epochId: 0, evalSeedCommit: seedHex, events: corpus.events.slice(0, 8) };
}
console.log(`[probe] pack size=${pack.events.length}`);

const opts = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  biEncoder, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: profile.relationHopBudget ?? 3,
  abstentionThreshold: profile.abstentionThreshold ?? 0.001,
  rerankerTopK: profile.rerankerTopK ?? 10,
  retrievalKeyTopK: profile.retrievalKeyTopK ?? 50,
  firstStageTopK: profile.firstStageTopK ?? 3200,
  rerankerInputTopK: profile.rerankerInputTopK ?? 128,
  lensTopK: profile.lensTopK ?? 36,
  lensWeight: profile.lensWeight ?? 0.4,
  anchorWeight: profile.anchorWeight ?? 0.6,
  relationExpansionBudget: profile.relationExpansionBudget ?? 12,
  categoryLensExpansionBudget: profile.categoryLensExpansionBudget ?? profile.relationExpansionBudget ?? 50,
  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.1,
  temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.1,
  lensDiversityFloor: profile.lensDiversityFloor,
  pipelineVersion: profile.pipelineVersion,
};

const EMPTY = { words: new Array(RANGES.WORD_COUNT).fill(0n) };
// CHILD: flip one temporal-region word. Does not affect anchors/lens/relations →
// stage-1 candidate pools identical to EMPTY → reranker pair cache should
// cover the full working set.
const CHILD = (() => {
  const w = [...EMPTY.words];
  w[RANGES.TEMPORAL_START] = 1n;
  return { words: w };
})();

async function timed(label, state) {
  const t = Date.now();
  const s = await evaluateRetrievalBenchmarkState(state, corpus, pack, opts);
  const ms = Date.now() - t;
  console.log(`  ${label.padEnd(7)} composite=${s.composite.toFixed(4)} elapsed=${(ms / 1000).toFixed(1)}s`);
  return ms;
}

const cold  = await timed('COLD',  EMPTY);
const warm  = await timed('WARM',  EMPTY);
const child = await timed('CHILD', CHILD);

// Optional production-faithful throughput probe.
let uniqueSeedReport = null;
if (uniqueSeedPatches > 0 && profile.hiddenPack) {
  console.log(`[probe] unique-seed patches: ${uniqueSeedPatches} (each patch has its own gateSeed → its own hiddenPack)`);
  const stats0 = getRerankerCacheStats?.(reranker);
  const baseHits = stats0?.hits ?? 0;
  const baseMisses = stats0?.misses ?? 0;
  const perPatch = [];
  for (let i = 0; i < uniqueSeedPatches; i++) {
    // Synthetic patchHash → unique gateSeed; deterministic across reruns.
    const patchHash = '0x' + createHash('sha256').update(`probe-patch-${i}`).digest('hex');
    const gateSeed = '0x' + createHash('sha256').update(patchHash + ':gate').digest('hex');
    const packI = deriveQueryPack(0, gateSeed, corpus, profile.hiddenPack);
    const tParent = Date.now();
    await evaluateRetrievalBenchmarkState(EMPTY, corpus, packI, opts);
    const parentMs = Date.now() - tParent;
    const tChild = Date.now();
    await evaluateRetrievalBenchmarkState(CHILD, corpus, packI, opts);
    const childMs = Date.now() - tChild;
    perPatch.push({ idx: i, parentMs, childMs, totalMs: parentMs + childMs });
    console.log(`  patch[${i}] parent=${(parentMs / 1000).toFixed(1)}s child=${(childMs / 1000).toFixed(1)}s total=${((parentMs + childMs) / 1000).toFixed(1)}s`);
  }
  const stats1 = getRerankerCacheStats?.(reranker);
  const newHits = (stats1?.hits ?? 0) - baseHits;
  const newMisses = (stats1?.misses ?? 0) - baseMisses;
  const hitRate = newHits / Math.max(1, newHits + newMisses);
  const totalSec = perPatch.reduce((s, p) => s + p.totalMs, 0) / 1000;
  uniqueSeedReport = {
    patches: uniqueSeedPatches,
    perPatch,
    rerankerCacheDuringPhase: { hits: newHits, misses: newMisses, hitRate, evictions: (stats1?.evictions ?? 0) },
    totalSeconds: totalSec,
    msPerPatch: (totalSec * 1000) / uniqueSeedPatches,
    patchesPerMinute: (60 * uniqueSeedPatches) / totalSec,
  };
  console.log(`[probe] unique-seed throughput: ${uniqueSeedReport.patchesPerMinute.toFixed(3)} patches/min (${uniqueSeedReport.msPerPatch.toFixed(0)} ms/patch)`);
  console.log(`[probe] cache hit rate during unique-seed phase: ${(hitRate * 100).toFixed(1)}% (${newHits} hits / ${newMisses} misses, ${(stats1?.evictions ?? 0)} evictions)`);
}

const warmSpeedup  = cold / Math.max(1, warm);
const childSpeedup = cold / Math.max(1, child);
console.log(`[probe] WARM speedup vs COLD: ${warmSpeedup.toFixed(1)}× (${warm}ms vs ${cold}ms)`);
console.log(`[probe] CHILD speedup vs COLD: ${childSpeedup.toFixed(1)}× (${child}ms vs ${cold}ms)`);
if (warmSpeedup < 3) {
  console.error(`[probe] FAIL: WARM should be ≫ COLD if the reranker cache is active. Got ${warmSpeedup.toFixed(1)}×.`);
  await reranker.close?.();
  exit(2);
}
console.log('[probe] OK — reranker cache is active.');

// Streaming Qwen3 holds a persistent Python subprocess open via stdin/stdout
// pipes. Without an explicit close() the Node process stays alive after the
// final console.log, waiting on the pipe. Always close.
await reranker.close?.();
exit(0);
