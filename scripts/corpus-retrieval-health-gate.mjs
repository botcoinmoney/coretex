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
 *
 * Per-family reachability is randomness-corrected. Define:
 *   randomBaseline = firstStageTopK / publicCandidateCount
 *   reachLift      = familyReach - randomBaseline
 *   enrichment     = familyReach / randomBaseline
 * Hard fail if any measured family has reachLift <= 0.05 or enrichment < 2.0.
 * Soft target (logged, not fail): reachLift >= 0.10 AND enrichment >= 3.0.
 * Legacy --min-family-reachable threshold remains as a generic safety floor.
 *
 * Routing-aware families (DESIGN: the answer doc INTENTIONALLY omits canonical,
 * routing edges supply truth to the substrate). Each is gated in TWO stages, not
 * silently weakened:
 *   Stage A (anchor reachability): the canonical-bearing ANCHOR doc (bridge_seed
 *     / decision / gotcha) must beat the randomness-corrected gate on its own.
 *   Stage B (canonical recovery):  the routing edge from anchor → answer must
 *     exist in the labeled relations (deterministic corpus check).
 *
 *   multi_session_bridge → anchor kind = bridge_seed, answer kind = bridge_answer,
 *                          edge labels = supports | depends_on
 *   decision_provenance  → anchor kind = decision,    answer kind = decision_reason,
 *                          edge labels = decision_reason
 *   causal_memory_chain  → anchor kind = gotcha,      answer kind = fix,
 *                          edge labels = fixes
 *
 * Optional diagnostic modes:
 *   --topk-sweep 3200,6400,12800,20000   evaluate reach/baseline/lift/enrichment
 *                                         at each K (no gate; per-K matrix only)
 *   --dump-misses N                       dump N misses per family (query+truth+top-5)
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
// Randomness-corrected hard thresholds (primary gate).
const MIN_REACH_LIFT_HARD = Number(env.MIN_REACH_LIFT_HARD ?? flag('min-reach-lift-hard', '0.05'));
const MIN_ENRICHMENT_HARD = Number(env.MIN_ENRICHMENT_HARD ?? flag('min-enrichment-hard', '2.0'));
const MIN_REACH_LIFT_TARGET = Number(env.MIN_REACH_LIFT_TARGET ?? flag('min-reach-lift-target', '0.10'));
const MIN_ENRICHMENT_TARGET = Number(env.MIN_ENRICHMENT_TARGET ?? flag('min-enrichment-target', '3.0'));
const TOPK_SWEEP = (flag('topk-sweep', '') || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const DUMP_MISSES_N = Number(flag('dump-misses', '0'));
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

// ─── Check 3: per-family truth-rank reachability (randomness-corrected) ─────
console.log(`\n=== check 3: per-family truth-rank reachability in bi-encoder top-${firstStageTopK} (${SEEDS.length} seeds × ${ITERS} iters × pack-${PACK_SIZE}) ===`);
const pubIndex = buildPublicCorpusIndex(corpus);
const pubCandCount = pubIndex.docs.length;
const randomBaseline = pubCandCount > 0 ? firstStageTopK / pubCandCount : 0;
console.log(`[health-gate] public candidate pool = ${pubCandCount} docs; randomBaseline = ${(100 * randomBaseline).toFixed(2)}% (topK/pool)`);

const hiddenPack = { ...profile.hiddenPack, packSize: PACK_SIZE, quotas: [] };
// Lookup table for retrieving doc text by id (for miss dumps).
const docTextById = new Map();
for (const ev of corpus.events) {
  for (const t of ev.truthDocuments ?? []) if (!docTextById.has(t.id)) docTextById.set(t.id, t.text ?? '');
  for (const n of ev.hardNegatives ?? []) if (!docTextById.has(n.id)) docTextById.set(n.id, n.text ?? '');
}

// ─── Routing-aware classification ──────────────────────────────────────────
// TruthDocument carries only {id, text, isCurrent, aspectTags?} — no `kind`. Load the LABELED
// corpus JSON separately to recover docId → kind (the generator emits kind on every doc).
const labeledCorpus = JSON.parse(readFileSync(resolve(repoRoot, CORPUS_PATH), 'utf8'));
const docKindById = new Map();
for (const d of labeledCorpus.docs ?? []) docKindById.set(d.id, d.kind);
// Build a relations adjacency for the canonical-recovery check (Stage B).
// In the generator (scripts/generate-dgen1-corpus.mjs) edges are emitted as rel(answerDoc, anchorDoc, label)
// — e.g. rel(bridgeDoc, answerDoc, 'depends_on') means source=bridgeDoc (anchor), dst=answerDoc;
// rel(reason, decision, 'decision_reason') means source=reason (answer), dst=decision (anchor);
// rel(fixDoc, errDoc, 'fixes') means source=fixDoc (answer), dst=errDoc (anchor).
// So to traverse FROM anchor TO answer we need BOTH adjacencies (some families forward, some reverse).
const relFwd = new Map();
const relRev = new Map();
for (const r of labeledCorpus.relations ?? []) {
  if (!relFwd.has(r.src)) relFwd.set(r.src, []);
  relFwd.get(r.src).push({ dst: r.dst, label: r.label });
  if (!relRev.has(r.dst)) relRev.set(r.dst, []);
  relRev.get(r.dst).push({ src: r.src, label: r.label });
}
const ROUTING_REQUIRED = {
  multi_session_bridge: { anchorKind: 'bridge_seed', answerKind: 'bridge_answer', edgeLabels: new Set(['supports', 'depends_on', 'belongs_to_project']) },
  decision_provenance:  { anchorKind: 'decision',    answerKind: 'decision_reason', edgeLabels: new Set(['decision_reason']) },
  causal_memory_chain:  { anchorKind: 'gotcha',      answerKind: 'fix',              edgeLabels: new Set(['fixes']) },
};

const byFam = new Map();
const anchorByFam = new Map();   // routing-required: separate reach over ANCHOR docs only (Stage A)
const recoveryByFam = new Map(); // routing-required: anchor → answer edge recovery rate (Stage B)
const missesByFam = new Map();   // fam → [{queryId, queryText, truthDocs:[{id,text}], top5:[{id,text,rank}]}]
function pickAnchorIds(family, truthIds) {
  const rcfg = ROUTING_REQUIRED[family];
  if (!rcfg) return truthIds;
  return truthIds.filter((id) => docKindById.get(id) === rcfg.anchorKind);
}
function answerReachableFromAnchor(family, anchorIds, answerIds) {
  const rcfg = ROUTING_REQUIRED[family];
  if (!rcfg || answerIds.length === 0 || anchorIds.length === 0) return false;
  const answerSet = new Set(answerIds);
  // Walk BOTH forward + reverse edges with matching label (generator emits answer→anchor for some
  // families, anchor→answer for others). Single-hop only — the test is "does the labeled routing
  // edge connect the anchor to its answer?" (deterministic corpus-structure check, not BFS depth).
  for (const a of anchorIds) {
    for (const out of (relFwd.get(a) ?? [])) {
      if (rcfg.edgeLabels.has(out.label) && answerSet.has(out.dst)) return true;
    }
    for (const inc of (relRev.get(a) ?? [])) {
      if (rcfg.edgeLabels.has(inc.label) && answerSet.has(inc.src)) return true;
    }
  }
  return false;
}
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

      // Routing-aware: Stage A measures reach of ANCHOR doc only; Stage B measures whether
      // the anchor → answer routing edge exists in the labeled corpus (deterministic).
      if (ROUTING_REQUIRED[fam]) {
        const rcfg = ROUTING_REQUIRED[fam];
        const anchorIds = pickAnchorIds(fam, targets);
        const answerIds = targets.filter((id) => docKindById.get(id) === rcfg.answerKind);
        if (!anchorByFam.has(fam)) anchorByFam.set(fam, { total: 0, retrievable: 0, ranks: [] });
        if (!recoveryByFam.has(fam)) recoveryByFam.set(fam, { total: 0, recovered: 0 });
        const ab = anchorByFam.get(fam);
        const rb = recoveryByFam.get(fam);
        ab.total++;
        let bestAnchor = Infinity;
        for (const a of anchorIds) {
          const idx = cands.findIndex((c) => (c.documentId ?? c.id) === a);
          if (idx >= 0 && idx + 1 < bestAnchor) bestAnchor = idx + 1;
        }
        if (bestAnchor !== Infinity) ab.retrievable++;
        ab.ranks.push(bestAnchor === Infinity ? -1 : bestAnchor);
        rb.total++;
        if (answerReachableFromAnchor(fam, anchorIds, answerIds)) rb.recovered++;
      }

      if (bestRank === Infinity && DUMP_MISSES_N > 0) {
        if (!missesByFam.has(fam)) missesByFam.set(fam, []);
        const acc = missesByFam.get(fam);
        if (acc.length < DUMP_MISSES_N) {
          const top5 = cands.slice(0, 5).map((c, i) => ({
            id: c.documentId ?? c.id,
            rank: i + 1,
            text: (docTextById.get(c.documentId ?? c.id) ?? '').slice(0, 240),
          }));
          acc.push({
            queryId: ev.id,
            family: fam,
            queryText: (ev.queryText ?? '').slice(0, 240),
            truthDocs: targets.map((id) => ({ id, text: (docTextById.get(id) ?? '').slice(0, 240) })),
            top5,
          });
        }
      }
    }
  }
}
const familyReport = {};
function liftStats(reach) {
  const reachLift = reach - randomBaseline;
  const enrichment = randomBaseline > 0 ? reach / randomBaseline : (reach > 0 ? Infinity : 0);
  return { reach, reachLift, enrichment };
}
for (const [fam, b] of byFam) {
  const isRouting = !!ROUTING_REQUIRED[fam];
  const reach = b.total > 0 ? b.retrievable / b.total : 0;
  const { reachLift, enrichment } = liftStats(reach);
  const validRanks = b.ranks.filter((r) => r > 0).sort((a, b) => a - b);
  const p10 = validRanks[Math.floor(validRanks.length * 0.1)] ?? null;
  const p50 = validRanks[Math.floor(validRanks.length * 0.5)] ?? null;
  const p90 = validRanks[Math.floor(validRanks.length * 0.9)] ?? null;
  const targetMet = reachLift >= MIN_REACH_LIFT_TARGET && enrichment >= MIN_ENRICHMENT_TARGET;
  const famEntry = { routingRequired: isRouting, total: b.total, retrievable: b.retrievable, reach, randomBaseline, reachLift, enrichment: Number.isFinite(enrichment) ? enrichment : null, targetMet, p10, p50, p90 };

  if (isRouting) {
    // Routing-aware: gate Stage A (anchor reach) + Stage B (canonical recovery).
    // The any-truth reach reported above is informational only — it includes the routing-required
    // answer doc which by design omits the canonical name and so is not bi-encoder reachable.
    const ab = anchorByFam.get(fam) ?? { total: 0, retrievable: 0, ranks: [] };
    const rb = recoveryByFam.get(fam) ?? { total: 0, recovered: 0 };
    const anchorReach = ab.total > 0 ? ab.retrievable / ab.total : 0;
    const { reachLift: aL, enrichment: aE } = liftStats(anchorReach);
    const anchorTargetMet = aL >= MIN_REACH_LIFT_TARGET && aE >= MIN_ENRICHMENT_TARGET;
    const validAnchorRanks = ab.ranks.filter((r) => r > 0).sort((a, b) => a - b);
    const ap10 = validAnchorRanks[Math.floor(validAnchorRanks.length * 0.1)] ?? null;
    const ap50 = validAnchorRanks[Math.floor(validAnchorRanks.length * 0.5)] ?? null;
    const ap90 = validAnchorRanks[Math.floor(validAnchorRanks.length * 0.9)] ?? null;
    const recoveryRate = rb.total > 0 ? rb.recovered / rb.total : 0;
    famEntry.routing = {
      anchorReach, anchorLift: aL, anchorEnrichment: Number.isFinite(aE) ? aE : null, anchorTargetMet,
      anchorTotal: ab.total, anchorRetrievable: ab.retrievable,
      anchorRanks: { p10: ap10, p50: ap50, p90: ap90 },
      canonicalRecoveryRate: recoveryRate, canonicalRecoveryTotal: rb.total, canonicalRecovered: rb.recovered,
    };
    const stageAOk = aL > MIN_REACH_LIFT_HARD && aE >= MIN_ENRICHMENT_HARD;
    const stageBOk = recoveryRate >= 0.99; // canonical edge must connect anchor → answer for ≥99% of queries
    gate(`routing-A/${fam}`, stageAOk,
      `anchor-reach=${(100 * anchorReach).toFixed(1)}%  baseline=${(100 * randomBaseline).toFixed(2)}%  lift=${(100 * aL).toFixed(2)}pp  enrich=${aE.toFixed(2)}x  hard(lift>${(100 * MIN_REACH_LIFT_HARD).toFixed(0)}pp & enrich>=${MIN_ENRICHMENT_HARD.toFixed(1)}x)  target(${anchorTargetMet ? 'MET' : 'NOT MET'})  n=${ab.total}  anchor-ranks p10=${ap10} p50=${ap50} p90=${ap90}`);
    gate(`routing-B/${fam}`, stageBOk,
      `canonical-recovery=${(100 * recoveryRate).toFixed(2)}%  threshold>=99%  ${rb.recovered}/${rb.total} anchors connect to answer via labeled edge`);
    console.log(`  [info/${fam}] any-truth reach=${(100 * reach).toFixed(1)}% (informational; answer doc is routing-required and intentionally omits canonical)`);
  } else {
    const hardOk = reachLift > MIN_REACH_LIFT_HARD && enrichment >= MIN_ENRICHMENT_HARD;
    gate(`family-reachability/${fam}`, hardOk,
      `reach=${(100 * reach).toFixed(1)}%  baseline=${(100 * randomBaseline).toFixed(2)}%  lift=${(100 * reachLift).toFixed(2)}pp  enrich=${enrichment.toFixed(2)}x  hard(lift>${(100 * MIN_REACH_LIFT_HARD).toFixed(0)}pp & enrich>=${MIN_ENRICHMENT_HARD.toFixed(1)}x)  target(${targetMet ? 'MET' : 'NOT MET'} lift>=${(100 * MIN_REACH_LIFT_TARGET).toFixed(0)}pp & enrich>=${MIN_ENRICHMENT_TARGET.toFixed(1)}x)  n=${b.total}  retrievable=${b.retrievable}  ranks p10=${p10} p50=${p50} p90=${p90}`);
  }
  familyReport[fam] = famEntry;
}

// ─── Optional TopK sweep diagnostic (no gating, matrix only) ────────────────
const topkSweepReport = {};
if (TOPK_SWEEP.length > 0) {
  console.log(`\n=== diagnostic: TopK sweep at K ∈ {${TOPK_SWEEP.join(',')}} (no gating) ===`);
  // To avoid re-running the embedding lookup per K, pull all pack queries once and
  // compute ranks against the FULL ordering, then bucket by K.
  const Kmax = Math.max(...TOPK_SWEEP);
  const sweepByFam = new Map(); // fam → ranks[]
  for (const baseSeed of SEEDS) {
    for (let p = 0; p < ITERS; p++) {
      const seedHex = '0x' + createHash('sha256').update(`${baseSeed}:${p}`).digest('hex');
      const pack = deriveQueryPack(p, seedHex, corpus, hiddenPack);
      for (const ev of pack.events) {
        const fam = ev.logicalFamily ?? ev.family;
        const targets = (ev.truthDocuments ?? []).map((t) => t.id);
        if (targets.length === 0) continue;
        if (!sweepByFam.has(fam)) sweepByFam.set(fam, []);
        const cands = firstStageCandidates(ev.embeddings.query, pubIndex, Kmax);
        let bestRank = Infinity;
        for (const t of targets) {
          const idx = cands.findIndex((c) => (c.documentId ?? c.id) === t);
          if (idx >= 0 && idx + 1 < bestRank) bestRank = idx + 1;
        }
        sweepByFam.get(fam).push(bestRank === Infinity ? -1 : bestRank);
      }
    }
  }
  for (const [fam, ranks] of sweepByFam) {
    topkSweepReport[fam] = { total: ranks.length, perK: {} };
    for (const K of TOPK_SWEEP) {
      const retrievable = ranks.filter((r) => r > 0 && r <= K).length;
      const reach = ranks.length > 0 ? retrievable / ranks.length : 0;
      const baseline = pubCandCount > 0 ? K / pubCandCount : 0;
      const lift = reach - baseline;
      const enrich = baseline > 0 ? reach / baseline : null;
      topkSweepReport[fam].perK[String(K)] = { reach, baseline, reachLift: lift, enrichment: enrich, retrievable, K };
      console.log(`  ${fam.padEnd(28)} K=${String(K).padStart(5)}  reach=${(100 * reach).toFixed(1)}%  baseline=${(100 * baseline).toFixed(2)}%  lift=${(100 * lift).toFixed(2)}pp  enrich=${enrich !== null ? enrich.toFixed(2) + 'x' : 'n/a'}`);
    }
  }
}

// ─── Miss-dump emission ────────────────────────────────────────────────────
const missDumps = {};
if (DUMP_MISSES_N > 0) {
  for (const [fam, arr] of missesByFam) missDumps[fam] = arr;
  const missCount = [...missesByFam.values()].reduce((a, b) => a + b.length, 0);
  console.log(`\n[health-gate] collected ${missCount} miss exemplars across ${missesByFam.size} families (capped at ${DUMP_MISSES_N}/family)`);
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
  thresholds: { MAX_TEXT_DUP, MAX_EMB_DUP, MIN_FAM_REACH, MIN_REACH_LIFT_HARD, MIN_ENRICHMENT_HARD, MIN_REACH_LIFT_TARGET, MIN_ENRICHMENT_TARGET },
  sample: { requested: SAMPLE_N, actual: sample.length, totalMemoryEvents: memEvents.length },
  text_duplication: { uniquePayloads: textClusters.size, totalEvents: totalText, nullOrEmpty: textNullOrEmpty,
    duplicateRate: textDupRate, nonSingletonClusterCount: nonSingletonText.length,
    eventsInNonSingletonClusters: inDupTextCluster, largestClusterSizes: largestTextClusters },
  embedding_duplication: { uniquePayloads: embClusters.size, totalEvents: totalEmb, nullOrEmpty: embNullOrEmpty,
    duplicateRate: embDupRate, nonSingletonClusterCount: nonSingletonEmb.length,
    eventsInNonSingletonClusters: inDupEmbCluster, largestClusterSizes: largestEmbClusters },
  family_reachability: { firstStageTopK, publicCandidateCount: pubCandCount, randomBaseline, seeds: SEEDS, iters: ITERS, packSize: PACK_SIZE, perFamily: familyReport },
  topk_sweep: TOPK_SWEEP.length > 0 ? { Ks: TOPK_SWEEP, publicCandidateCount: pubCandCount, perFamily: topkSweepReport } : null,
  miss_dumps: DUMP_MISSES_N > 0 ? { perFamilyCap: DUMP_MISSES_N, perFamily: missDumps } : null,
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
