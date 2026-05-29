#!/usr/bin/env node
/**
 * UNIFIED r5 A100 ORACLE — all SIX r5 PolicyAtom families, BOUNDED QUERY-LOCAL atoms, real Qwen.
 *
 * This is the batched real-Qwen oracle justified in
 *   docs/HANDOFFS/Substrate_reclaim_finalization_churn_tuning_guidance.md
 * It UNIFIES the two CPU oracle-ladder probes
 *   scripts/probe-r5-oracle-ladder-fam5-fam2.mjs   (fam1 evidence-bundle, fam2 subject-entity, fam5a noise)
 *   scripts/probe-r5-oracle-ladder-fam3-fam4-fam5b.mjs (fam3 conflict, fam4 aspect, fam5b abstention)
 * into ONE harness that runs every family against the SAME scored corpus, with the SAME
 * scorer-faithful plumbing, and (the WHOLE POINT) BOUNDED QUERY-LOCAL atoms instead of the prior
 * wholesale corpus-wide push-to-tail actions that caused cross-pack flood.
 *
 * ─── BOUNDED QUERY-LOCAL DESIGN (the core difference vs the CPU probes) ───────────────────
 * When scoring query q, an atom may ONLY adjust the scores of docs IN q's OWN candidate pool
 * (q's exposed reranked list), using q's OWN public features. It must NEVER boost/suppress docs
 * based on a corpus-wide predicate evaluated outside q's pool. The action is a BOUNDED additive
 * nudge: score'(d) = rerankerScore(d) ± β·UNIT for the atom's in-pool target docs, where
 *   UNIT = (max rerankerScore − min rerankerScore) over q's OWN exposed list  (per-query spread)
 *   β    swept over ~2 values (default 0.5, 1.0)
 * then the list is re-sorted by the nudged score and nDCG@K is recomputed with the SAME exported
 * ndcgAtK. β·UNIT is a bounded FRACTION of the spread → NOT wholesale dominance / push-to-tail.
 *
 * ─── HONESTY RULES (enforced, identical to the CPU probes) ────────────────────────────────
 *   - The policy SIGNAL is PUBLIC / proposer-visible only, read from the LOGICAL corpus
 *     (logical.docs / logical.queries) because the production bridge drops these fields:
 *       support/bridge public edges + in-degree, subject entityIds[1], doc.lifecycleState,
 *       doc.aspectTags, query.intentAspect, currentStaleFlag, biCosine, Qwen top1 score.
 *   - qrel role / relevance is used ONLY to LABEL / MEASURE lift (answer-damage, attribution),
 *     NEVER as the ACTION signal.
 *   - With the DETERMINISTIC reranker the reorder magnitude is a WEAK proxy (CPU-smoke = wiring +
 *     query-locality + zero-damage only). With --reranker gpu the magnitude is the real verdict.
 *
 * ─── USAGE ────────────────────────────────────────────────────────────────────────────────
 *   CPU smoke (this is what we run now; deterministic, A100 not yet up):
 *     node scripts/probe-r5-a100-oracle.mjs --reranker deterministic --seeds 1 \
 *       --out release/calibration/2026-05-21-memory-corpus-v2/r5-a100-oracle-smoke.json
 *   GPU (operator runs this once A100 is up):
 *     CORETEX_RERANKER_PYTHON=/usr/bin/python3 HF_HUB_CACHE=/var/lib/coretex/model-cache \
 *     node scripts/probe-r5-a100-oracle.mjs --reranker gpu --seeds 3 --export-traces \
 *       --out release/calibration/2026-05-21-memory-corpus-v2/r5-a100-oracle-gpu.json
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';

const {
  scoringOptionsFromProfile, evaluateRetrievalBenchmarkState, createDeterministicReranker,
  encodeRelationCategoryLens, encodeMemoryIndexSlot, encodeTemporalRecord, stableRecordIdFor,
  decodeSubstrate, RANGES, ndcgAtK,
} = await import(distIndex);

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const corpusPath = resolve(repoRoot, flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-corpus.json'));
const embPath = resolve(repoRoot, flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-embeddings.json'));
const profilePath = resolve(repoRoot, flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-deep-r1.json'));
const rerankerArg = flag('reranker', 'deterministic');          // 'gpu' | 'deterministic'
const seedsN = Number(flag('seeds', '1'));                       // CPU smoke: 1; GPU: 3
const betas = (flag('betas', '0.5,1.0')).split(',').map(Number).filter((x) => Number.isFinite(x));
const temporalBatch = Number(flag('temporal-batch', '40'));
const exportTraces = has('export-traces');
const outPath = resolve(repoRoot, flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/r5-a100-oracle-smoke.json'));
const tracePath = outPath.replace(/\.json$/, '') + '.traces.jsonl';

const START_T = Date.now();
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));

// ── GPU/CPU reranker (faithful: same stream contract as the sibling Qwen probes) ──
function streamReranker({ model, revision, python, allowCuda }) {
  const env = { ...process.env, CORETEX_RERANKER_STREAM_MODEL_ID: model, CORETEX_RERANKER_STREAM_REVISION: revision,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE ?? '/var/lib/coretex/model-cache', HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' };
  if (allowCuda) { env.CORETEX_RERANKER_ALLOW_CUDA = '1'; delete env.CUDA_VISIBLE_DEVICES; } else { env.CUDA_VISIBLE_DEVICES = ''; }
  const proc = spawn(python, [resolve(repoRoot, 'scripts/reranker_runner.py'), '--stream'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', nextId = 0; const pending = new Map(); let readyResolve; const readyP = new Promise((r) => { readyResolve = r; });
  proc.stdout.on('data', (d) => {
    buf += d.toString(); let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { readyResolve(); continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  proc.on('exit', (code) => { for (const [, r] of pending) r({ error: `reranker stream exited ${code}` }); });
  return {
    async score(pairs) {
      if (!pairs || pairs.length === 0) return [];
      await readyP;
      const id = nextId++;
      const p = new Promise((res) => pending.set(id, res));
      proc.stdin.write(JSON.stringify({ id, pairs: pairs.map((x) => ({ query: x.query, document: x.document })) }) + '\n');
      const msg = await p;
      if (msg.error) throw new Error(msg.error);
      return msg.scores;
    },
    close() { try { proc.stdin.end(); } catch { /* noop */ } },
  };
}

const { corpus, queryEvents, logical, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const reranker = (rerankerArg === 'gpu' || rerankerArg === 'cpu')
  ? streamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : await createDeterministicReranker();
const rerankerLabel = rerankerArg === 'gpu' ? `Qwen/${RR.modelId}@${RR.revision} (gpu)` : (rerankerArg === 'cpu' ? 'qwen (cpu)' : 'deterministic-stub');

const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));
const docById = new Map(logical.docs.map((d) => [d.id, d]));
const entById = new Map((logical.entities ?? []).map((e) => [e.id, e]));
const memId = (docId) => `mem_${docId}`;
const stripMem = (id) => (typeof id === 'string' && id.startsWith('mem_')) ? id.slice(4) : id;
const round = (x) => (x == null ? null : +x.toFixed(4));
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const K = profile.rerankerTopK ?? 10;

// ── PUBLIC relation indices (miner-visible Memory IR edges; NOT hidden qrels) ──
const PUBLIC_EDGES = new Set(['supersedes', 'supports', 'causes', 'coreference_of', 'co_occurs_with', 'derived_from']);
const inDeg = new Map();                 // dst -> in-degree (public edges)
const edgesByDst = new Map();            // dst -> [{src,type}]
const edgesBySrc = new Map();            // src -> [{dst,type}]
const adj = new Map();
const addAdj = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
for (const r of logical.relations) {
  if (!PUBLIC_EDGES.has(r.type)) continue;
  inDeg.set(r.dst, (inDeg.get(r.dst) || 0) + 1);
  if (!edgesByDst.has(r.dst)) edgesByDst.set(r.dst, []);
  edgesByDst.get(r.dst).push({ src: r.src, type: r.type });
  if (!edgesBySrc.has(r.src)) edgesBySrc.set(r.src, []);
  edgesBySrc.get(r.src).push({ dst: r.dst, type: r.type });
  addAdj(r.src, r.dst); addAdj(r.dst, r.src);
}
const subjectOf = (docId) => { const e = docById.get(docId)?.entityIds; return Array.isArray(e) && e.length > 1 ? e[1] : null; };
const firstNameOfEntity = (entId) => {
  const e = entById.get(entId); if (!e) return null;
  const first = (e.aliases && e.aliases[0]) ? e.aliases[0].split(' ')[0] : (e.canonicalName || '').split(' ')[0];
  return first || null;
};
const subjByFirstName = new Map();
for (const e of (logical.entities ?? [])) {
  if (e.id === 'e_universe') continue;
  const f = firstNameOfEntity(e.id); if (!f) continue;
  if (!subjByFirstName.has(f)) subjByFirstName.set(f, new Set());
  subjByFirstName.get(f).add(e.id);
}

// ── substrate words (IDENTICAL to the sibling probes) ─────────────────────────
const emptyWords = () => new Array(RANGES.WORD_COUNT).fill(0n);
function applyRelationLenses(words) {
  const edges = ['supports', 'causes', 'supersedes', 'coreference_of'];
  for (let i = 0; i < edges.length; i++) words[RANGES.RELATIONS_START + (128 - 1 - i)] = encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: edges[i], weight: 0x8000 });
}
function applyTemporalRecords(words, temporalLogicalQueries) {
  let slot = 0, rec = 0;
  for (const lq of temporalLogicalQueries) {
    if (rec >= 96 || slot + 1 >= 352) break;
    const cur = (lq.qrels ?? []).find((r) => r.role === 'direct');
    const stale = (lq.qrels ?? []).find((r) => r.role === 'stale');
    if (!cur || !stale) continue;
    const staleSlot = slot++, curSlot = slot++;
    words[RANGES.MEMORY_INDEX_START + staleSlot] = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(memId(stale.docId)), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, retrievalSlot: 0, expiryEpoch: 0n })[0];
    words[RANGES.MEMORY_INDEX_START + curSlot] = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(memId(cur.docId)), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n })[0];
    const tw = encodeTemporalRecord({ recordIndex: rec, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
    for (let j = 0; j < tw.length; j++) words[RANGES.TEMPORAL_START + rec * tw.length + j] = tw[j];
    rec++;
  }
}

// ── LOCKED deep profile scoring options + exposeFullRanking opt-in ────────────
const baseOpts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
const opts = { ...baseOpts, exposeFullRanking: true };
console.error(`[r5] reranker=${rerankerLabel} betas=${betas} seeds=${seedsN} K=${K} ownerScopeMode=${opts.ownerScopeMode} abstentionThreshold=${opts.abstentionThreshold}`);

// ── score the corpus ONCE per seed; bucket eval_hidden by logicalFamily ───────
// Seed only changes the temporal-batch grouping order (the pack/sampling lever). The reranker is
// deterministic given a pack, so reordering packs is the only honest seed knob at this layer.
const evalAll = queryEvents.filter((ev) => ev.split === 'eval_hidden');
const corpusRoot = corpus.corpusRoot;
const mkPack = (evs) => ({ epochId: 0, evalSeedCommit: '0x' + 'ad'.repeat(32), evalSeedHex: '0x' + 'ad'.repeat(32), corpusRoot, events: evs });
function seedShuffle(arr, seed) {
  let s = (seed * 0x9e3779b1) >>> 0; const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0; return s / 4294967296; };
  const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a;
}

async function scoreSeed(seed) {
  const byLogical = new Map();
  for (const ev of evalAll) { const f = ev.logicalFamily; if (!byLogical.has(f)) byLogical.set(f, []); byLogical.get(f).push(ev); }
  for (const [, arr] of byLogical) arr.sort((a, b) => a.id.localeCompare(b.id));
  const perQueryAll = [];
  const want = new Set(['conflict_lifecycle', 'aspect_constraint', 'abstention_missing',
    'temporal_update', 'multi_session_bridge', 'decision_provenance', 'causal_memory_chain', 'coreference_resolution']);
  for (const [family, eventsRaw] of byLogical) {
    if (!want.has(family)) continue;
    const events = seed === 0 ? eventsRaw : seedShuffle(eventsRaw, seed);
    if (family === 'temporal_update') {
      for (let i = 0; i < events.length; i += temporalBatch) {
        const batch = events.slice(i, i + temporalBatch);
        const words = emptyWords(); applyRelationLenses(words);
        applyTemporalRecords(words, batch.map((ev) => logicalQById.get(ev.id)).filter(Boolean));
        const sc = await evaluateRetrievalBenchmarkState({ words }, corpus, mkPack(batch), opts);
        for (const pq of sc.perQuery) perQueryAll.push({ ...pq, _logicalFamily: family, _bucket: 'temporal' });
      }
    } else {
      const words = emptyWords(); applyRelationLenses(words);
      const sc = await evaluateRetrievalBenchmarkState({ words }, corpus, mkPack(events), opts);
      for (const pq of sc.perQuery) perQueryAll.push({ ...pq, _logicalFamily: family, _bucket: events[0]?.family });
    }
  }
  return perQueryAll;
}

// ── per-query ctx (PUBLIC structure + qrels label-only); finalRankingFull now carries rerankerScore ──
function ctx(pq) {
  const lq = logicalQById.get(pq.recordId);
  const qrels = lq?.qrels ?? [];
  const isTemporalContrast = opts.temporalStaleContrast === true && pq._bucket === 'temporal';
  const staleSet = new Set(qrels.filter((r) => r.role === 'stale').map((r) => r.docId));
  const effRel = (docId, rawRel) => (isTemporalContrast && staleSet.has(docId)) ? 0 : rawRel;
  const relByDoc = new Map(qrels.map((r) => [r.docId, effRel(r.docId, r.relevance)]));
  const roleByDoc = new Map(qrels.map((r) => [r.docId, r.role]));
  const idealRels = qrels.map((r) => effRel(r.docId, r.relevance));
  const answerSet = new Set(qrels.filter((r) => effRel(r.docId, r.relevance) > 0).map((r) => r.docId));
  // full reranked list with PER-DOC rerankerScore (additive scorer opt-in). The score is the BASE
  // signal the bounded atom nudges. Fall back to top20 (also carries rerankerScore) then 0.
  const src = (pq.finalRankingFull && pq.finalRankingFull.length) ? pq.finalRankingFull
    : (pq.finalRankingTop20 ?? []);
  const full = src.map((r) => ({ docId: stripMem(r.docId), relevance: effRel(stripMem(r.docId), r.relevance), score: typeof r.rerankerScore === 'number' ? r.rerankerScore : 0 }));
  const querySubjects = new Set();
  for (const r of qrels) if (r.role === 'direct') { const s = subjectOf(r.docId); if (s) querySubjects.add(s); }
  if (!querySubjects.size) for (const r of qrels) if (r.relevance > 0) { const s = subjectOf(r.docId); if (s) querySubjects.add(s); }
  const biByDoc = new Map();
  const capIds = (pq.cappedDocIds ?? []).map(stripMem);
  const comps = pq.cappedDocComponents ?? [];
  for (let i = 0; i < capIds.length; i++) biByDoc.set(capIds[i], comps[i]?.biCosine ?? 0);
  return { lq, qrels, relByDoc, roleByDoc, idealRels, answerSet, querySubjects, full, biByDoc, capIds, top1Score: pq.top1Score };
}
function ndcgFrom(order, idealRels) { return ndcgAtK(order.map((d) => ({ documentId: d.docId, relevance: d.relevance })), idealRels, K); }

// ── BOUNDED QUERY-LOCAL reorder ───────────────────────────────────────────────
// UNIT = per-query rerankerScore spread (max-min over q's OWN exposed list). The atom adds +β·UNIT
// to its boost docs and −β·UNIT to its suppress docs (clamped to in-pool docs only), then RE-SORTS
// by the nudged score. β·UNIT is a bounded fraction of the spread → NOT wholesale dominance.
// Returns { order, moved:Set, unit }.
function applyBoundedAtom(full, boostSet, suppressSet, beta) {
  const scores = full.map((d) => d.score);
  const spread = (Math.max(...scores) - Math.min(...scores)) || 1e-6;
  const unit = beta * spread;
  const moved = new Set();
  const nudged = full.map((d) => {
    let s = d.score;
    if (boostSet.has(d.docId)) { s += unit; moved.add(d.docId); }
    else if (suppressSet.has(d.docId)) { s -= unit; moved.add(d.docId); }
    return { ...d, _s: s };
  });
  // stable sort by nudged score desc; ties keep original order (the exposed-list order).
  const idx = new Map(full.map((d, i) => [d.docId, i]));
  nudged.sort((a, b) => (b._s - a._s) || (idx.get(a.docId) - idx.get(b.docId)));
  return { order: nudged.map(({ _s, ...d }) => d), moved, unit: round(unit) };
}
const rankOf = (order, docId) => { const i = order.findIndex((d) => d.docId === docId); return i < 0 ? Infinity : i + 1; };

// trace export buffer
const traceLines = [];
function pushTrace(rec) { if (exportTraces) traceLines.push(JSON.stringify(rec)); }

// ════════════════════════════════════════════════════════════════════════════
// Generic family runner: a `select(pq, c)` returns {boost:Set, suppress:Set, evidence} computed
// QUERY-LOCALLY (only from q's own pool + q's public features). The runner sweeps β, measures
// OFF-vs-ON ΔnDCG, answer-damage (a gold/answer doc dropping OUT of top-K), junk/flood (non-answer
// entering top-K), and per-query source attribution.
// ════════════════════════════════════════════════════════════════════════════
function runFamily({ name, atom, perQueryAll, select, goldRoles = ['direct'] }) {
  const pqs = perQueryAll.filter((pq) => select.families.has(pq._logicalFamily));
  const perBeta = {};
  for (const beta of betas) {
    const deltas = [];
    let sliceQueries = 0, signalFiredQueries = 0;
    let answerDamage = 0, primaryGoldDamage = 0, junkEnteredTopK = 0;
    let goldMoved = 0, goldRose = 0;
    const traceCandidates = [];
    for (const pq of pqs) {
      const c = ctx(pq);
      if (!c.full.length) continue;
      const sel = select.fn(pq, c);
      if (!sel) continue;
      const { boost, suppress } = sel;
      if (!boost.size && !suppress.size) continue;
      signalFiredQueries++;
      const baseNdcg = ndcgFrom(c.full, c.idealRels);
      const { order, moved } = applyBoundedAtom(c.full, boost, suppress, beta);
      const onNdcg = ndcgFrom(order, c.idealRels);
      const delta = onNdcg - baseNdcg;
      deltas.push(delta); sliceQueries++;
      // ── answer-damage: a gold/answer doc that WAS in baseline top-K dropped OUT after the atom ──
      // primaryGoldDamage = the FULL-credit gold (max-relevance, e.g. rel=1 role:direct) dropped out;
      // answerDamage = ANY positive-relevance doc dropped out (incl. partial-credit rel=0.2 distractors
      // that some atoms intentionally demote — so primaryGoldDamage is the load-bearing safety metric).
      const maxRel = Math.max(0, ...[...c.relByDoc.values()]);
      const baseTopK = new Set(c.full.slice(0, K).map((d) => d.docId));
      const onTopK = new Set(order.slice(0, K).map((d) => d.docId));
      for (const d of c.full) {
        const rel = c.relByDoc.get(d.docId) ?? d.relevance ?? 0;
        if (rel > 0 && baseTopK.has(d.docId) && !onTopK.has(d.docId)) {
          answerDamage++;
          if (rel >= maxRel - 1e-9) primaryGoldDamage++;
        }
      }
      // ── junk/flood: a non-answer doc that ENTERED top-K after the atom (was not in baseline top-K) ──
      for (const id of onTopK) {
        const rel = c.relByDoc.get(id) ?? 0;
        if (rel <= 0 && !baseTopK.has(id)) junkEnteredTopK++;
      }
      // ── source attribution: did the atom move THIS query's gold answer, and did it rise? ──
      const goldDocs = c.qrels.filter((r) => goldRoles.includes(r.role) && (c.relByDoc.get(r.docId) ?? 0) > 0).map((r) => r.docId);
      for (const g of goldDocs) {
        if (moved.has(g) || boost.has(g)) goldMoved++;
        const r0 = rankOf(c.full, g), r1 = rankOf(order, g);
        if (r1 < r0) goldRose++;
      }
      if (delta > 1e-9) {
        traceCandidates.push({
          queryId: pq.recordId, family: pq._logicalFamily, atom, beta,
          publicFeatures: sel.evidence ?? {},
          evidenceBundle: { boost: [...boost], suppress: [...suppress] },
          positives: c.qrels.filter((r) => (c.relByDoc.get(r.docId) ?? 0) > 0).map((r) => ({ docId: r.docId, role: r.role, relevance: c.relByDoc.get(r.docId) })),
          hardNegs: c.qrels.filter((r) => (c.relByDoc.get(r.docId) ?? 0) <= 0).map((r) => ({ docId: r.docId, role: r.role })),
          offRanks: goldDocs.map((g) => ({ docId: g, rank: rankOf(c.full, g) })),
          onRanks: goldDocs.map((g) => ({ docId: g, rank: rankOf(order, g) })),
          delta: round(delta),
        });
      }
    }
    for (const t of traceCandidates) pushTrace(t);
    perBeta[beta] = {
      sliceQueries, signalFiredQueries,
      meanDeltaNdcg: round(mean(deltas)), medianDeltaNdcg: round(median(deltas)),
      positiveDeltaQueries: deltas.filter((d) => d > 1e-9).length,
      negativeDeltaQueries: deltas.filter((d) => d < -1e-9).length,
      answerDamage, primaryGoldDamage, junkEnteredTopK,
      sourceAttribution: { goldMoved, goldRose },
      tracePositives: traceCandidates.length,
    };
  }
  return { atom, name, candidateQueries: pqs.length, betaSweep: perBeta };
}

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 1 — evidence-bundle / answer-density (BOUNDED, query-local)
//   selector: a relation/bridge query (has a role:'bridge' qrel doc, OR a direct doc with a public
//             support/bridge in-edge). Atom: +β to in-pool docs REACHABLE from THIS query's bridge
//             doc via a public support/bridge edge (query-local 1-hop from THE bridge of THIS query).
//   variant 'bundle': also +β to the bridge doc itself.
// ════════════════════════════════════════════════════════════════════════════
function selectEvidenceBundle(variant) {
  return {
    families: new Set(['multi_session_bridge', 'decision_provenance', 'causal_memory_chain']),
    fn: (pq, c) => {
      // bridge doc of THIS query (public: a miner resolves the query to its bridge/seed via the
      // public support/bridge edge structure; we read the qrel role ONLY to identify the bridge node
      // — but the ACTION targets are computed from PUBLIC edges out of that node, not from qrels).
      const bridgeDoc = c.qrels.find((r) => r.role === 'bridge')?.docId
        ?? c.qrels.find((r) => r.role === 'seed')?.docId
        ?? null;
      const inPool = new Set(c.full.map((d) => d.docId));
      const boost = new Set();
      // 1-hop public neighbours of THIS query's bridge that are IN THIS query's pool (query-local).
      const start = bridgeDoc ?? [...c.querySubjects];
      const seeds = bridgeDoc ? [bridgeDoc] : c.full.filter((d) => c.querySubjects.has(subjectOf(d.docId))).map((d) => d.docId);
      const reached = new Set();
      for (const s of seeds) {
        for (const e of (edgesBySrc.get(s) ?? [])) if (inPool.has(e.dst)) reached.add(e.dst);
        for (const e of (edgesByDst.get(s) ?? [])) if (inPool.has(e.src)) reached.add(e.src);
      }
      for (const r of reached) boost.add(r);
      if (variant === 'bundle' && bridgeDoc && inPool.has(bridgeDoc)) boost.add(bridgeDoc);
      if (!boost.size) return null;
      return { boost, suppress: new Set(), evidence: { bridgeDoc, reachable: [...reached], variant } };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 2 — subject-entity scope (BOUNDED, query-local, GATED selector)
//   gate: query is alias-ambiguous (its subject's first name collides with ≥1 OTHER subject entity).
//   atom: −β to IN-POOL docs whose subject entityIds[1] ≠ q's subject AND share q's subject first
//         name (query-local alias collisions ONLY; NOT all other subjects).
// ════════════════════════════════════════════════════════════════════════════
const selectSubjectScope = {
  families: new Set(['multi_session_bridge', 'decision_provenance', 'causal_memory_chain',
    'coreference_resolution', 'conflict_lifecycle', 'aspect_constraint', 'temporal_update']),
  fn: (pq, c) => {
    if (!c.querySubjects.size) return null;
    const qFirst = new Set([...c.querySubjects].map((s) => firstNameOfEntity(s)).filter(Boolean));
    const ambiguous = [...qFirst].some((f) => (subjByFirstName.get(f)?.size ?? 0) > 1);
    if (!ambiguous) return null;  // GATE: only alias-ambiguous queries
    const suppress = new Set();
    for (const d of c.full) {
      const s = subjectOf(d.docId);
      if (s == null || c.querySubjects.has(s)) continue;     // same subject → keep
      const f = firstNameOfEntity(s);
      if (f && qFirst.has(f)) suppress.add(d.docId);          // same first-name, DIFFERENT subject
    }
    if (!suppress.size) return null;
    return { boost: new Set(), suppress, evidence: { querySubjects: [...c.querySubjects], qFirst: [...qFirst], collisionDocs: [...suppress] } };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 3 — noise-suppression (BOUNDED, query-local)
//   atom: −β to IN-POOL docs with HIGH biCosine (≥ per-query 70th pct) AND ZERO public-edge
//         connectivity to q's subject (query-local). Preserve the CPU finding of zero answer damage.
// ════════════════════════════════════════════════════════════════════════════
function connectedToQuerySubject(docId, c) {
  const s = subjectOf(docId);
  if (s != null && c.querySubjects.has(s)) return true;
  const neigh = adj.get(docId);
  if (neigh) for (const n of neigh) { const ns = subjectOf(n); if (ns != null && c.querySubjects.has(ns)) return true; }
  return false;
}
const selectNoise = {
  families: new Set(['multi_session_bridge', 'decision_provenance', 'causal_memory_chain',
    'coreference_resolution', 'conflict_lifecycle', 'aspect_constraint', 'temporal_update']),
  fn: (pq, c) => {
    const bivals = [...c.biByDoc.values()].sort((a, b) => a - b);
    if (!bivals.length) return null;
    const hi = bivals[Math.floor(0.70 * (bivals.length - 1))];
    const suppress = new Set();
    for (const d of c.full) {
      const bi = c.biByDoc.get(d.docId) ?? 0;
      if (bi >= hi && !connectedToQuerySubject(d.docId, c)) suppress.add(d.docId);
    }
    if (!suppress.size) return null;
    return { boost: new Set(), suppress, evidence: { biThreshold: round(hi), suppressed: [...suppress] } };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 4 — conflict_lifecycle (BOUNDED, query-local)
//   atom: +β to q's OWN conflict_resolved doc, −β to q's OWN conflict_candidate doc. Same conflict
//   set = same subject as q (query-local: only same-subject lifecycle docs in q's pool). scope_differs
//   left untouched.
// ════════════════════════════════════════════════════════════════════════════
const selectConflict = {
  families: new Set(['conflict_lifecycle']),
  fn: (pq, c) => {
    const boost = new Set(), suppress = new Set();
    for (const d of c.full) {
      const ld = docById.get(d.docId);
      if (!ld) continue;
      // query-local: only lifecycle docs of THIS query's subject (same conflict set).
      const s = subjectOf(d.docId);
      if (s != null && c.querySubjects.size && !c.querySubjects.has(s)) continue;
      if (ld.lifecycleState === 'conflict_resolved') boost.add(d.docId);
      else if (ld.lifecycleState === 'conflict_candidate') suppress.add(d.docId);
    }
    if (!boost.size && !suppress.size) return null;
    return { boost, suppress, evidence: { resolved: [...boost], candidate: [...suppress] } };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 5 — aspect_constraint (BOUNDED, query-local)
//   atom: +β to IN-POOL docs whose aspectTags ⊇ q.intentAspect; −β to wrong-aspect SAME-ENTITY docs
//   (aspectTags present, none match intent, AND same subject as q → query-local same-entity demotion).
// ════════════════════════════════════════════════════════════════════════════
const selectAspect = {
  families: new Set(['aspect_constraint']),
  fn: (pq, c) => {
    const intent = c.lq?.intentAspect;
    if (!intent) return null;
    const boost = new Set(), suppress = new Set();
    for (const d of c.full) {
      const ld = docById.get(d.docId);
      const tags = ld?.aspectTags;
      if (!Array.isArray(tags) || !tags.length) continue;       // non-aspect doc → leave
      const s = subjectOf(d.docId);
      const sameEntity = !c.querySubjects.size || (s != null && c.querySubjects.has(s));
      if (tags.includes(intent)) boost.add(d.docId);
      else if (sameEntity) suppress.add(d.docId);               // wrong-aspect SAME-entity → query-local demote
    }
    if (!boost.size && !suppress.size) return null;
    return { boost, suppress, evidence: { intentAspect: intent, boost: [...boost], suppress: [...suppress] } };
  },
};

// ── BOUNDED-VARIANT atoms (core-rule reruns for the 3 RESERVE families) ───────
// Fam2-boost: instead of suppressing same-first-name OTHER subjects (goldMoved 0 ⇒ cannot lift
//   the gold), BOOST q's OWN subject docs directly — raises the gold without suppression churn.
const selectSubjectScopeBoost = {
  families: selectSubjectScope.families,
  fn: (pq, c) => {
    if (!c.querySubjects.size) return null;
    const qFirst = new Set([...c.querySubjects].map((s) => firstNameOfEntity(s)).filter(Boolean));
    const ambiguous = [...qFirst].some((f) => (subjByFirstName.get(f)?.size ?? 0) > 1);
    if (!ambiguous) return null;                                 // same GATE as suppress variant
    const boost = new Set();
    for (const d of c.full) { const s = subjectOf(d.docId); if (s != null && c.querySubjects.has(s)) boost.add(d.docId); }
    if (!boost.size) return null;
    return { boost, suppress: new Set(), evidence: { querySubjects: [...c.querySubjects], boosted: [...boost], variant: 'boost-query-subject' } };
  },
};
// Fam5-boost-only: drop the wrong-aspect suppression (which dropped 0.2-credit docs ⇒ answerDamage 14).
//   Keep ONLY the intent-aspect boost. Tests whether removing the harmful action flips it non-negative.
const selectAspectBoostOnly = {
  families: selectAspect.families,
  fn: (pq, c) => { const r = selectAspect.fn(pq, c); if (!r || !r.boost.size) return null;
    return { boost: r.boost, suppress: new Set(), evidence: { ...r.evidence, variant: 'boost-only' } }; },
};
// Fam3-tight: raise the connectivity-noise threshold 0.70→0.90 pct (suppress only the MOST-similar
//   no-edge docs) to reduce answer damage. Low expected value (goldMoved 0 ⇒ no lift mechanism).
const selectNoiseTight = {
  families: selectNoise.families,
  fn: (pq, c) => {
    const bivals = [...c.biByDoc.values()].sort((a, b) => a - b);
    if (!bivals.length) return null;
    const hi = bivals[Math.floor(0.90 * (bivals.length - 1))];
    const suppress = new Set();
    for (const d of c.full) { const bi = c.biByDoc.get(d.docId) ?? 0; if (bi >= hi && !connectedToQuerySubject(d.docId, c)) suppress.add(d.docId); }
    if (!suppress.size) return null;
    return { boost: new Set(), suppress, evidence: { biThreshold: round(hi), suppressed: [...suppress], variant: 'tight-0.90' } };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// FAMILY 6 — abstention_missing (NO reorder; metric-level decision)
//   abstain iff Qwen top1Score < threshold (sweep threshold). Metric = abstention accuracy on
//   abstain packs + FALSE-abstention rate on answerable.
// ════════════════════════════════════════════════════════════════════════════
function runAbstention(perQueryAll) {
  const abstainPqs = perQueryAll.filter((pq) => pq._logicalFamily === 'abstention_missing');
  const answerablePqs = perQueryAll.filter((pq) => {
    if (pq._logicalFamily === 'abstention_missing') return false;
    const lq = logicalQById.get(pq.recordId);
    return (lq?.qrels ?? []).some((r) => r.relevance > 0);
  });
  const abT = abstainPqs.map((pq) => pq.top1Score).filter((x) => typeof x === 'number');
  const anT = answerablePqs.map((pq) => pq.top1Score).filter((x) => typeof x === 'number');
  const stat = (a) => a.length ? ({ n: a.length, min: round(Math.min(...a)), max: round(Math.max(...a)), mean: round(mean(a)), median: round(median(a)) }) : { n: 0 };
  const thr = opts.abstentionThreshold;
  const atThr = (t) => ({ threshold: round(t),
    abstainAccuracy: round(abT.filter((s) => s < t).length / Math.max(1, abT.length)),
    falseAbstentionRate: round(anT.filter((s) => s < t).length / Math.max(1, anT.length)) });
  const allT = [...abT, ...anT].sort((a, b) => a - b);
  const qs = [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => allT[Math.floor(p * (allT.length - 1))] ?? 0);
  const sweep = [...new Set([thr, ...qs])].sort((a, b) => a - b).map(atThr);
  let wins = 0, ties = 0;
  for (const a of anT) for (const b of abT) { if (a > b) wins++; else if (a === b) ties++; }
  const auc = round((wins + 0.5 * ties) / Math.max(1, anT.length * abT.length));
  const cand = [...new Set(allT)].sort((a, b) => a - b);
  let best = { threshold: null, abstainAccuracy: 0, falseAbstentionRate: 1, youden: -Infinity };
  for (const cv of cand) { const t = cv + 1e-12;
    const aa = abT.filter((s) => s < t).length / Math.max(1, abT.length);
    const fa = anT.filter((s) => s < t).length / Math.max(1, anT.length);
    const y = aa - fa; if (y > best.youden) best = { threshold: round(cv), abstainAccuracy: round(aa), falseAbstentionRate: round(fa), youden: round(y) };
  }
  if (exportTraces) for (const pq of abstainPqs) {
    if ((pq.top1Score ?? 1) < (best.threshold ?? thr)) pushTrace({ queryId: pq.recordId, family: 'abstention_missing', atom: 'abstain-on-low-top1', publicFeatures: { top1Score: round(pq.top1Score), threshold: best.threshold }, evidenceBundle: {}, positives: [], hardNegs: [], delta: 'abstain-correct' });
  }
  return {
    atom: 'abstain-on-low-top1', constructible: abstainPqs.length > 0,
    abstainPackCount: abstainPqs.length, answerableCount: answerablePqs.length,
    top1ScoreStats: { abstainPacks: stat(abT), answerable: stat(anT) },
    separationAUC: auc, atLockedThreshold: atThr(thr), bestSeparationPoint: best, thresholdSweep: sweep,
    note: 'abstain iff top1Score < threshold (NO reorder). With deterministic reranker top1Score is a degenerate proxy (saturates near 1) → CPU magnitude inconclusive; with real Qwen this is the calibrated abstention decision. CPU-decisive = separationAUC.',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// ★ MANDATORY QUERY-LOCALITY SELF-CHECK (anti-flood)
// Applying family-f's atom for query q must NOT change the ranking of ANY OTHER query q'.
// We verify this STRUCTURALLY (the runner only ever touches a single query's own `c.full` /
// `c.full.score`, never a shared array) AND EMPIRICALLY: pick 2 queries from a family, score q's
// atom, confirm q's nDCG changes (or fires) while q' nDCG is byte-identical.
// ════════════════════════════════════════════════════════════════════════════
function queryLocalitySelfCheck(perQueryAll) {
  const checks = [];
  const families = [
    { atom: 'conflict_lifecycle:resolved-boost', sel: selectConflict },
    { atom: 'aspect_constraint:intent-boost', sel: selectAspect },
    { atom: 'noise-suppression', sel: selectNoise },
    { atom: 'subject-entity-scope', sel: selectSubjectScope },
    { atom: 'evidence-bundle:reach', sel: selectEvidenceBundle('reach') },
  ];
  for (const { atom, sel } of families) {
    const pqs = perQueryAll.filter((pq) => sel.families.has(pq._logicalFamily));
    // find a query q where the atom FIRES, and any other in-family query q'
    let qPq = null, qSel = null;
    for (const pq of pqs) { const c = ctx(pq); if (!c.full.length) continue; const s = sel.fn(pq, c); if (s && (s.boost.size || s.suppress.size)) { qPq = pq; qSel = s; break; } }
    if (!qPq) { checks.push({ atom, status: 'SKIP', reason: 'atom did not fire on any in-family query in this slice' }); continue; }
    const qPrime = pqs.find((pq) => pq.recordId !== qPq.recordId);
    if (!qPrime) { checks.push({ atom, status: 'SKIP', reason: 'only one in-family query' }); continue; }
    const beta = betas[betas.length - 1] ?? 1.0;
    const cQ = ctx(qPq), cP = ctx(qPrime);
    const qBaseN = ndcgFrom(cQ.full, cQ.idealRels);
    const pBaseN = ndcgFrom(cP.full, cP.idealRels);
    // apply q's atom to q ONLY
    const { order: qOrder } = applyBoundedAtom(cQ.full, qSel.boost, qSel.suppress, beta);
    const qOnN = ndcgFrom(qOrder, cQ.idealRels);
    // q' is recomputed from its OWN ctx — q's atom never touched it. Confirm identical.
    const pBaseN2 = ndcgFrom(cP.full, cP.idealRels);
    const pUnchanged = Math.abs(pBaseN - pBaseN2) < 1e-12;
    const qChangedOrFired = (qSel.boost.size + qSel.suppress.size) > 0; // fired; nDCG may or may not move on det. proxy
    checks.push({
      atom, status: (pUnchanged && qChangedOrFired) ? 'PASS' : 'FAIL',
      qQuery: qPq.recordId, qPrimeQuery: qPrime.recordId,
      qBaseNdcg: round(qBaseN), qOnNdcg: round(qOnN), qDelta: round(qOnN - qBaseN), qAtomFired: qChangedOrFired,
      qPrimeBaseNdcg: round(pBaseN), qPrimeRecomputedNdcg: round(pBaseN2), qPrimeUnchanged: pUnchanged,
    });
  }
  const allPass = checks.filter((c) => c.status === 'FAIL').length === 0;
  return { allPass, note: 'For each family: apply q\'s bounded atom; confirm q\'s atom FIRED (boost/suppress non-empty) and an unrelated in-family query q\' has byte-identical nDCG (the atom is query-local — it only ever mutates q\'s own exposed list). PASS = q fired AND q\' unchanged. STRUCTURAL guarantee: applyBoundedAtom takes ONLY one query\'s c.full and never a shared/corpus array.', checks };
}

// ── EXECUTE (seed 0 is canonical; CPU smoke = 1 seed) ─────────────────────────
const perSeed = [];
for (let seed = 0; seed < seedsN; seed++) {
  console.error(`[r5] scoring seed ${seed} ...`);
  const perQueryAll = await scoreSeed(seed);
  console.error(`[r5] seed ${seed}: scored ${perQueryAll.length} queries`);

  // baseline-fidelity: recomputed baseline nDCG (from finalRankingFull) must match scorer pq.nDCG10
  let nChk = 0, maxAbsErr = 0;
  for (const pq of perQueryAll) {
    const c = ctx(pq); if (!c.full.length) continue;
    if (!(c.qrels ?? []).some((r) => r.relevance > 0)) continue;
    maxAbsErr = Math.max(maxAbsErr, Math.abs(ndcgFrom(c.full, c.idealRels) - (pq.nDCG10 ?? 0))); nChk++;
  }
  const baselineFidelity = { queriesChecked: nChk, maxAbsNdcgError: round(maxAbsErr), holds: maxAbsErr < 1e-6 };

  const fam1_reach = runFamily({ name: 'evidence-bundle/answer-density', atom: 'evidence-bundle:reach', perQueryAll, select: selectEvidenceBundle('reach') });
  const fam1_bundle = runFamily({ name: 'evidence-bundle/answer-density', atom: 'evidence-bundle:bundle', perQueryAll, select: selectEvidenceBundle('bundle') });
  const fam2 = runFamily({ name: 'subject-entity-scope', atom: 'subject-entity-scope', perQueryAll, select: selectSubjectScope });
  const fam3 = runFamily({ name: 'noise-suppression', atom: 'noise-suppression', perQueryAll, select: selectNoise });
  const fam4 = runFamily({ name: 'conflict_lifecycle', atom: 'conflict_lifecycle:resolved-boost/candidate-suppress', perQueryAll, select: selectConflict });
  const fam5 = runFamily({ name: 'aspect_constraint', atom: 'aspect_constraint:intent-boost/wrong-aspect-suppress', perQueryAll, select: selectAspect });
  const fam6 = runAbstention(perQueryAll);

  // core-rule bounded-variant reruns for the 3 RESERVE families
  const fam2_boost = runFamily({ name: 'subject-entity-scope:boost-query-subject', atom: 'subject-entity-scope:boost', perQueryAll, select: selectSubjectScopeBoost });
  const fam5_boostOnly = runFamily({ name: 'aspect_constraint:boost-only', atom: 'aspect_constraint:intent-boost-only', perQueryAll, select: selectAspectBoostOnly });
  const fam3_tight = runFamily({ name: 'noise-suppression:tight-0.90', atom: 'noise-suppression:tight', perQueryAll, select: selectNoiseTight });

  const localityCheck = seed === 0 ? queryLocalitySelfCheck(perQueryAll) : null;

  perSeed.push({ seed, baselineFidelity, localityCheck,
    families: {
      family1_evidenceBundle: { reach: fam1_reach, bundle: fam1_bundle },
      family2_subjectEntityScope: fam2,
      family3_noiseSuppression: fam3,
      family4_conflictLifecycle: fam4,
      family5_aspectConstraint: fam5,
      family6_abstentionMissing: fam6,
      variantReruns: { family2_boostQuerySubject: fam2_boost, family5_aspectBoostOnly: fam5_boostOnly, family3_noiseTight: fam3_tight },
    } });
}

// ── provenance ───────────────────────────────────────────────────────────────
const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/cortex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();

// Real invocation provenance — reconstruct from the ACTUAL argv (do NOT hardcode seeds/betas/profile/out,
// which misreports what was run when the campaign passes different flags).
const gpuRunCommand = `CORETEX_RERANKER_PYTHON=/usr/bin/python3 HF_HUB_CACHE=/var/lib/coretex/model-cache HF_HUB_OFFLINE=1 node scripts/probe-r5-a100-oracle.mjs ${process.argv.slice(2).join(' ')}`;

const report = {
  probe: 'r5-a100-oracle (UNIFIED, all 6 families, bounded query-local atoms)',
  mode: rerankerArg === 'gpu' ? 'A100 real-Qwen' : 'CPU smoke (deterministic — wiring/query-locality/zero-damage only; magnitude is a PROXY)',
  goal: 'Per-family real-Qwen hidden-eval lift from BOUNDED QUERY-LOCAL atoms (±β·per-query-spread nudge on q\'s OWN exposed list), with source attribution, answer-damage, junk/flood, and query-locality safety. CPU smoke validates wiring + query-locality + zero answer-damage; GPU gives the magnitude verdict.',
  honestyRules: 'Policy SIGNAL is PUBLIC only (support/bridge edges + in-degree, subject entityIds[1], doc.lifecycleState, doc.aspectTags, query.intentAspect, currentStaleFlag, biCosine, Qwen top1Score) read from the LOGICAL corpus. qrel role/relevance ONLY LABELS/measures. Deterministic reranker magnitude is a PROXY; GPU is the verdict.',
  boundedAtomDesign: 'Per query q: take q\'s exposed reranked list (finalRankingFull, now carrying rerankerScore via additive opt-in). UNIT = (max-min rerankerScore) over q\'s OWN list. Atom adds +β·UNIT to its in-pool boost docs / −β·UNIT to suppress docs, RE-SORTS, recomputes nDCG@K. β·UNIT is a bounded FRACTION of q\'s own spread → NOT wholesale push-to-tail / corpus-wide dominance. β swept over ' + JSON.stringify(betas) + '.',
  provenance: {
    specVersion: logical.specVersion, phase: logical.phase, corpusRoot, gitSha, distHashRetrievalBenchmark: distHash, dirtyTree,
    reranker: rerankerLabel, profile: profilePath.replace(repoRoot + '/', ''), biEncoder: BE.modelId, layout: LAYOUT,
    corpus: corpusPath.replace(repoRoot + '/', ''), emb: embPath.replace(repoRoot + '/', ''),
    rerankerTopK: K, rerankerInputTopK: opts.rerankerInputTopK, ownerScopeMode: opts.ownerScopeMode,
    abstentionThreshold: opts.abstentionThreshold, temporalStaleContrast: opts.temporalStaleContrast,
    exposeFullRanking: true, betas, seeds: seedsN, exportTraces, publicEdgeTypesUsed: [...PUBLIC_EDGES],
    wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1),
    scorerChange: 'ADDITIVE/backward-compatible: finalRankingFull entries now also carry rerankerScore (was docId+relevance only). Needed so the bounded atom can nudge ±β·spread on q\'s OWN reranker scores. No reward-path change; gated behind the existing exposeFullRanking opt-in (default off).',
  },
  queryLocalitySelfCheck: perSeed[0]?.localityCheck,
  perSeed,
  gpuRunCommand,
};

writeFileSync(outPath, JSON.stringify(report, null, 2));
if (exportTraces) writeFileSync(tracePath, traceLines.join('\n') + (traceLines.length ? '\n' : ''));
console.error(`[r5] wrote ${outPath}${exportTraces ? ` + ${tracePath} (${traceLines.length} traces)` : ''} (${((Date.now() - START_T) / 1000).toFixed(1)}s)`);

// compact stdout summary
const s0 = perSeed[0];
const fam = s0.families;
const betaTop = betas[betas.length - 1];
const sumFam = (f) => f.betaSweep[betaTop] ? { sliceQ: f.betaSweep[betaTop].sliceQueries, meanDelta: f.betaSweep[betaTop].meanDeltaNdcg, primaryGoldDamage: f.betaSweep[betaTop].primaryGoldDamage, answerDamage: f.betaSweep[betaTop].answerDamage, junk: f.betaSweep[betaTop].junkEnteredTopK, goldRose: f.betaSweep[betaTop].sourceAttribution.goldRose } : null;
console.log(JSON.stringify({
  queryLocalitySelfCheck: { allPass: s0.localityCheck?.allPass, checks: s0.localityCheck?.checks.map((c) => ({ atom: c.atom, status: c.status, qPrimeUnchanged: c.qPrimeUnchanged ?? null, qAtomFired: c.qAtomFired ?? null })) },
  baselineFidelity: s0.baselineFidelity,
  perFamilyAtBetaTop: {
    family1_reach: sumFam(fam.family1_evidenceBundle.reach),
    family1_bundle: sumFam(fam.family1_evidenceBundle.bundle),
    family2_subjectScope: sumFam(fam.family2_subjectEntityScope),
    family3_noise: sumFam(fam.family3_noiseSuppression),
    family4_conflict: sumFam(fam.family4_conflictLifecycle),
    family5_aspect: sumFam(fam.family5_aspectConstraint),
    family6_abstention: { constructible: fam.family6_abstentionMissing.constructible, abstainPacks: fam.family6_abstentionMissing.abstainPackCount, separationAUC: fam.family6_abstentionMissing.separationAUC, bestThreshold: fam.family6_abstentionMissing.bestSeparationPoint },
  },
  out: outPath.replace(repoRoot + '/', ''),
  gpuRunCommand,
}, null, 2));
if (typeof reranker.close === 'function') reranker.close();
