/**
 * BMU P2 hardness-certification harness — temporal/multihop lane design
 * (family-parameterized via the oracle/leak-screen registries below).
 *
 * CONSOLIDATION NOTE (P2 merge): this file was `certify.mjs` on the
 * coretex-bmu-p2-{temporal,multihop} branches; the conflict/nearcol lanes
 * grew an API-incompatible harness under the same name (CERT_PINS /
 * FAMILY_ADAPTERS / buildRealLaneJob design), which kept the `certify.mjs`
 * path at the merge. Both harnesses are preserved verbatim so every lane's
 * pinned certification stays reproducible; unifying them is a P3+ item.
 *
 * Spec: specs/BMU_SPEC.md frozen rev3.2 (ad7e523). Sections enforced here:
 *   - §2.2  per-task utility u(t): binary judge at budget B —
 *           u=1 iff R⊆top-B AND F∩top-B=∅ AND answer∈top-B. For every lane
 *           in this harness the substrate is BLANK (no atoms), so the §5.5
 *           abstention signal can never fire and the last conjunct of the
 *           answerable rule is vacuously satisfied (spec §5.5 consequences).
 *   - G-B3  CPU-cheap trivial baselines FULL-SCALE: BM25 / first-K / random-K
 *           must not recover the answer within top-B without admitting
 *           forbidden items at rates competitive with the oracle. Exact
 *           per-lane rates are recorded; a row is rejected if ANY trivial
 *           baseline achieves u=1 on it.
 *   - G-B2  oracle structural solver (hidden qrels/structure granted) must
 *           reach u=1 on ≥0.90 of tasks. The oracle here is deliberately NOT
 *           a label-reader: it derives evidence from the cluster's document
 *           STRUCTURE (validity/supersession metadata + relations), so its
 *           success doubles as a mint-consistency check between the
 *           generator's bmuTask labels and the minted structure.
 *   - G-B1/I8 (small-scale in this phase) no-substrate real-embedding lane:
 *           BGE-M3 biCosine candidate ordering (+ Qwen3-Reranker-0.6B when
 *           available) must FAIL (u=0) or have low margin at budget B on a
 *           seeded subsample. Results are produced OFFLINE by
 *           real-lane-runner.py and merged via --real-lane; per the
 *           no-silent-caps rule the coverage cap is logged explicitly in the
 *           output (rowsCertified vs rowsTotal, candidate-cap for rerank).
 *   - §13.2 certification margin screen, measured WHERE COMPUTABLE at this
 *           phase: with no substrate only the BLANK state is constructible
 *           outside the full scoring pipeline, so margins are reported for
 *           the blank state in the two §13.2 spaces — admission boundary in
 *           preRankScore space (blank ⇒ preRankScore = biCosine; grid
 *           g_pre=1e-3; boundary = rank-rerankerInputTopK=64) and
 *           final-order boundary in composite space (blank ⇒ composite =
 *           effRerank normalized reranker score, no bonuses; grid g=1e-3;
 *           boundary = rank-B). Parent/oracle-solved-substrate margins
 *           REQUIRE the full retrieval-benchmark pipeline and are deferred
 *           to the dedicated full-bank certification run (cap logged).
 *   - NoLiMa answer-leak screen FULL-SCALE (§5.1 anti-lexical-shortcut):
 *           answer value must not appear in the question; gold-only
 *           vocabulary must not appear in the question; no shared 4-gram
 *           skeleton (slot-collapsed) between question and gold docs; the
 *           lexical dominance of the trap over the golds is recorded as a
 *           diagnostic (BM25 score comparison).
 *
 * Rejected tasks are LISTED with reasons (never silently dropped); the
 * emitted certification.json carries a certifiedSubset the bank manifest can
 * point to.
 *
 * Usage:
 *   node scripts/lib/bmu-generators/certify-lanes.mjs \
 *     --bank <sample-bank.json> --out <certification.json> \
 *     [--real-lane <real-lane-results.json>] [--seed <s>] \
 *     [--budget-override <n>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { prng, tokenize, contentTokens, sharedSkeletonNgrams, containsValue } from './common.mjs';

// ── Judge (§2.2, blank-substrate answerable rule) ────────────────────────────
/** Quantize a score to a grid (§13.2). */
export const quantize = (x, g) => Math.round(x / g);

/**
 * Deterministic ordering per §13.2 tiebreak, adapted to a single-score lane:
 * (quantized primary desc, quantized secondary desc, docId asc). CPU lanes
 * pass their lane score as primary with secondary=0 — the docId tiebreak
 * keeps every lane fully deterministic.
 */
export function rankDocs(scored, { grid = 1e-3 } = {}) {
  return [...scored].sort((a, b) => {
    const qa = quantize(a.primary, grid); const qb = quantize(b.primary, grid);
    if (qa !== qb) return qb - qa;
    const sa = quantize(a.secondary ?? 0, grid); const sb = quantize(b.secondary ?? 0, grid);
    if (sa !== sb) return sb - sa;
    return a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0;
  }).map((s) => s.docId);
}

/** u(t) for an ANSWERABLE task on a blank substrate (§2.2; abstention signal
 *  cannot fire with no atoms, §5.5). Returns the full component breakdown. */
export function judgeTopB(rankedDocIds, bmuTask, budgetOverride) {
  const B = budgetOverride ?? bmuTask.budgetB;
  const topB = new Set(rankedDocIds.slice(0, B));
  const requiredCovered = bmuTask.requiredEvidence.every((d) => topB.has(d));
  const forbiddenAdmitted = bmuTask.forbiddenEvidence.filter((d) => topB.has(d));
  const answerInTopB = bmuTask.answer ? topB.has(bmuTask.answer.id) : false;
  const u = requiredCovered && forbiddenAdmitted.length === 0 && answerInTopB ? 1 : 0;
  return { u, requiredCovered, forbiddenAdmitted, answerInTopB, topB: rankedDocIds.slice(0, B) };
}

// ── BM25 (Okapi; k1=1.2, b=0.75 — the standard trivial-baseline setting) ─────
export function buildBm25Index(docs) {
  const docTokens = new Map();
  const df = new Map();
  let totalLen = 0;
  for (const d of docs) {
    const toks = tokenize(d.text);
    docTokens.set(d.id, toks);
    totalLen += toks.length;
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = docs.length;
  const avgdl = totalLen / Math.max(1, N);
  return { docTokens, df, N, avgdl };
}

export function bm25Score(index, queryText, docId, { k1 = 1.2, b = 0.75 } = {}) {
  const toks = index.docTokens.get(docId);
  if (!toks) return 0;
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  for (const q of new Set(tokenize(queryText))) {
    const n = index.df.get(q) ?? 0;
    if (n === 0 || !tf.has(q)) continue;
    const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
    const f = tf.get(q);
    score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (toks.length / index.avgdl)));
  }
  return score;
}

// ── Trivial baseline lanes (G-B3) ────────────────────────────────────────────
export function bm25Lane(row, docs, index) {
  return rankDocs(docs.map((d) => ({ docId: d.id, primary: bm25Score(index, row.queryText, d.id) })));
}

export function firstKLane(row, docs) {
  // Corpus order as emitted by the generator (deterministic bank order).
  return docs.map((d) => d.id);
}

export function randomKLane(row, docs, seed) {
  const rand = prng(`${seed}|randomK|${row.id}`);
  const arr = docs.map((d) => d.id);
  for (let i = arr.length - 1; i > 0; i--) { // seeded Fisher–Yates
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Oracle structural solvers (G-B2) — family registry ──────────────────────
/**
 * temporal (§5.1): the oracle performs the SUPERSESSION memory operation on
 * hidden structure — it never reads bmuTask labels or qrel relevances:
 *   - superseded docs = validity.supersededBy present (stale trap + shadows);
 *   - provenance doc  = kind '*_provenance' (equivalently the src of the
 *     'derived_from'/records_supersession_of relation);
 *   - current doc     = the cluster doc that is neither superseded nor the
 *     provenance record (open validity).
 * Evidence law mirrors §5.1 per question type; top-B is padded with benign
 * out-of-cluster docs (deterministic id order) — an oracle that has evicted
 * every superseded doc has performed the operation, padding is inert filler.
 */
function temporalOracleLane(row, cluster, docs, budget) {
  const clusterDocs = cluster.docs;
  const superseded = new Set(clusterDocs.filter((d) => d.validity?.supersededBy).map((d) => d.id));
  const provenance = clusterDocs.find((d) => typeof d.kind === 'string' && d.kind.endsWith('_provenance'));
  const current = clusterDocs.find((d) => !superseded.has(d.id) && d !== provenance);
  if (!provenance || !current) return { evidence: [], answerId: null, ranked: [] };
  let evidence; let answerId;
  switch (row.questionType) {
    case 'current_value':
    case 'downstream_application':
      evidence = [current.id]; answerId = current.id; break;
    case 'stale_verification':
      evidence = [provenance.id, current.id]; answerId = provenance.id; break;
    case 'change_provenance':
      evidence = [provenance.id]; answerId = provenance.id; break;
    default:
      return { evidence: [], answerId: null, ranked: [] };
  }
  const clusterIds = new Set(clusterDocs.map((d) => d.id));
  const filler = docs.map((d) => d.id).filter((id) => !clusterIds.has(id)).sort();
  const ranked = [...evidence, ...filler.slice(0, Math.max(0, budget - evidence.length))];
  return { evidence, answerId, ranked };
}

export const ORACLE_LANES = {
  temporal: temporalOracleLane,
  // conflict_lifecycle / multi_hop_relation / near_collision lanes plug in here.
};

// ── Answer-leak screen (NoLiMa; §5.1 anti-lexical-shortcut) — family registry ─
/** Gold-only vocabulary for the temporal family: tokens that appear ONLY in
 *  gold (current/provenance) doc templates — their presence in a question
 *  would be a lexical pointer to the gold docs (see temporal.mjs mint lint). */
const TEMPORAL_GOLD_ONLY_TOKENS = ['superseded', 'supersession', 'replaced', 'ledger'];

function temporalLeakScreen(row, cluster, bm25Index) {
  const reasons = [];
  // (a) answer value must not appear in the question (stale value is
  //     trap-claimed and ALLOWED — it points at the trap, not the gold).
  if (containsValue(row.queryText, cluster.currentValue)) {
    reasons.push(`answer_value_in_question:${cluster.currentValue}`);
  }
  // (b) gold-only vocabulary must not appear in the question.
  const qToks = new Set(tokenize(row.queryText));
  for (const t of TEMPORAL_GOLD_ONLY_TOKENS) {
    if (qToks.has(t)) reasons.push(`gold_only_vocab_in_question:${t}`);
  }
  // (c) no shared 4-gram skeleton with any gold doc (slot fills collapsed).
  const slotValues = [cluster.canonicalName, cluster.attribute, cluster.currentValue,
    cluster.staleValue, ...(cluster.decoyValues ?? [])];
  const goldDocs = cluster.docs.filter((d) => row.bmuTask.requiredEvidence.includes(d.id));
  for (const d of goldDocs) {
    const shared = sharedSkeletonNgrams(row.queryText, d.text, slotValues, 4);
    if (shared.length > 0) reasons.push(`shared_4gram_skeleton_with_gold:${d.id}:${shared[0]}`);
  }
  // (d) DIAGNOSTIC (recorded, not a rejection): trap lexical dominance —
  //     the stale trap should be at least competitive with every gold under
  //     BM25 for this question (the trap carries exact-question vocabulary).
  const trap = cluster.docs.find((d) => d.role === 'stale_trap');
  const trapScore = trap ? bm25Score(bm25Index, row.queryText, trap.id) : 0;
  const goldMax = Math.max(0, ...goldDocs.map((d) => bm25Score(bm25Index, row.queryText, d.id)));
  return { pass: reasons.length === 0, reasons, trapLexicallyDominant: trapScore >= goldMax, trapScore, goldMax };
}

export const LEAK_SCREENS = {
  temporal: temporalLeakScreen,
};

// ── §13.2 margins for the real lane (blank state; measured where computable) ─
export function blankStateMargins(row, realRow, { capK = 64, gridPre = 1e-3, gridJudge = 1e-3, budget }) {
  const out = { state: 'blank', notes: [] };
  const marked = new Set([...row.bmuTask.requiredEvidence, ...row.bmuTask.forbiddenEvidence]);
  // Admission boundary in preRankScore space (blank ⇒ preRankScore = biCosine).
  if (realRow?.cosine) {
    const entries = Object.entries(realRow.cosine)
      .map(([docId, s]) => ({ docId, primary: s }));
    const ranked = rankDocs(entries, { grid: gridPre });
    if (ranked.length > capK) {
      const qOf = (docId) => quantize(realRow.cosine[docId], gridPre);
      const boundaryQ = qOf(ranked[capK - 1]); // last admitted cell
      out.admission = [...marked].map((docId) => ({
        docId,
        inCap: ranked.indexOf(docId) < capK,
        cellsFromBoundary: qOf(docId) - boundaryQ,
        marginOk: Math.abs(qOf(docId) - boundaryQ) >= 3,
      }));
    } else {
      out.notes.push(`corpus ${ranked.length} ≤ capK ${capK}: admission boundary not binding on this bank`);
    }
  } else out.notes.push('no cosine scores: admission margins not computable');
  // Final-order boundary in composite space (blank ⇒ composite = effRerank).
  if (realRow?.rerank) {
    const entries = Object.entries(realRow.rerank).map(([docId, s]) => ({ docId, primary: s }));
    const ranked = rankDocs(entries, { grid: gridJudge });
    const qOf = (docId) => (docId in realRow.rerank ? quantize(realRow.rerank[docId], gridJudge) : null);
    const boundaryQ = qOf(ranked[Math.min(budget, ranked.length) - 1]);
    out.finalOrder = [...marked].map((docId) => {
      const q = qOf(docId);
      return {
        docId,
        inTopB: ranked.indexOf(docId) >= 0 && ranked.indexOf(docId) < budget,
        cellsFromBoundary: q === null ? null : q - boundaryQ,
        marginOk: q === null ? true : Math.abs(q - boundaryQ) >= 3, // not admitted to rerank = deterministically out
        admittedToRerank: q !== null,
      };
    });
  } else out.notes.push('no rerank scores: final-order margins not computable');
  out.notes.push('parent/oracle-solved-state margins DEFERRED: require the full retrieval-benchmark pipeline (logged cap)');
  return out;
}

// ── Main certification run ───────────────────────────────────────────────────
export function certifyBank(bank, {
  seed = 'bmu-p2-certify-v1',
  realLane = null,           // { params, rows: { [rowId]: { cosine, rerank } } }
  budgetOverride = null,
  oracleLane = null,         // override for tests
  leakScreen = null,
} = {}) {
  const family = bank.family;
  const oracle = oracleLane ?? ORACLE_LANES[family];
  const screen = leakScreen ?? LEAK_SCREENS[family];
  if (!oracle) throw new Error(`certify: no oracle lane registered for family '${family}'`);
  if (!screen) throw new Error(`certify: no leak screen registered for family '${family}'`);

  const docs = bank.clusters.flatMap((c) => c.docs);
  const seen = new Set();
  for (const d of docs) {
    if (seen.has(d.id)) throw new Error(`certify: duplicate doc id '${d.id}' in bank`);
    seen.add(d.id);
  }
  const bm25Index = buildBm25Index(docs);

  const perTask = [];
  const laneTotals = {
    bm25: { u: 0, answerInTopB: 0, requiredCovered: 0, forbiddenAdmitted: 0 },
    firstK: { u: 0, answerInTopB: 0, requiredCovered: 0, forbiddenAdmitted: 0 },
    randomK: { u: 0, answerInTopB: 0, requiredCovered: 0, forbiddenAdmitted: 0 },
    oracle: { u: 0, answerInTopB: 0, requiredCovered: 0, forbiddenAdmitted: 0 },
  };
  let leakPass = 0; let trapDominant = 0;
  const realRows = [];

  for (const cluster of bank.clusters) {
    for (const row of cluster.rows) {
      const B = budgetOverride ?? row.bmuTask.budgetB;
      const reasons = [];

      const lanes = {
        bm25: judgeTopB(bm25Lane(row, docs, bm25Index), row.bmuTask, budgetOverride),
        firstK: judgeTopB(firstKLane(row, docs), row.bmuTask, budgetOverride),
        randomK: judgeTopB(randomKLane(row, docs, seed), row.bmuTask, budgetOverride),
      };
      const o = oracle(row, cluster, docs, B);
      lanes.oracle = judgeTopB(o.ranked, row.bmuTask, budgetOverride);

      for (const [lane, res] of Object.entries(lanes)) {
        laneTotals[lane].u += res.u;
        laneTotals[lane].answerInTopB += res.answerInTopB ? 1 : 0;
        laneTotals[lane].requiredCovered += res.requiredCovered ? 1 : 0;
        laneTotals[lane].forbiddenAdmitted += res.forbiddenAdmitted.length > 0 ? 1 : 0;
      }
      for (const lane of ['bm25', 'firstK', 'randomK']) {
        if (lanes[lane].u === 1) reasons.push(`trivial_baseline_solves:${lane}`);
      }
      if (lanes.oracle.u !== 1) reasons.push(`oracle_failed:required=${lanes.oracle.requiredCovered},forbidden=${lanes.oracle.forbiddenAdmitted.join('+') || 'none'},answer=${lanes.oracle.answerInTopB}`);

      const leak = screen(row, cluster, bm25Index);
      if (leak.pass) leakPass += 1; else reasons.push(...leak.reasons.map((r) => `leak_screen:${r}`));
      if (leak.trapLexicallyDominant) trapDominant += 1;

      // Real lane (small-scale subsample; G-B1/I8 no-substrate must fail).
      let real = null;
      if (realLane?.rows?.[row.id]) {
        const rr = realLane.rows[row.id];
        const cosRanked = rankDocs(Object.entries(rr.cosine ?? {}).map(([docId, s]) => ({ docId, primary: s })));
        const capK = realLane.params?.rerankerInputTopK ?? 64;
        const admitted = cosRanked.slice(0, capK);
        // Judge ordering: reranked head (composite = effRerank on blank), then
        // remaining admitted candidates by biCosine (§13.2 single total order).
        const rerankedHead = rr.rerank
          ? rankDocs(Object.entries(rr.rerank).map(([docId, s]) => ({ docId, primary: s })))
          : [];
        const rest = admitted.filter((d) => !(rr.rerank && d in rr.rerank));
        const finalOrder = [...rerankedHead, ...rest];
        const bgeOnly = judgeTopB(cosRanked, row.bmuTask, budgetOverride);
        const bgeQwen = judgeTopB(finalOrder, row.bmuTask, budgetOverride);
        real = {
          bgeOnly: { u: bgeOnly.u, topB: bgeOnly.topB, forbiddenAdmitted: bgeOnly.forbiddenAdmitted },
          bgeQwen: { u: bgeQwen.u, topB: bgeQwen.topB, forbiddenAdmitted: bgeQwen.forbiddenAdmitted },
          margins: blankStateMargins(row, rr, { capK, budget: B }),
        };
        if (bgeQwen.u === 1) reasons.push('real_lane_no_substrate_solves:bge+qwen');
        realRows.push(row.id);
      }

      perTask.push({
        rowId: row.id,
        motifGroupId: cluster.motifGroupId,
        questionType: row.questionType,
        budgetB: B,
        certified: reasons.length === 0,
        reasons,
        lanes: Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, {
          u: v.u, answerInTopB: v.answerInTopB, requiredCovered: v.requiredCovered,
          forbiddenAdmitted: v.forbiddenAdmitted, topB: v.topB,
        }])),
        oracleDerived: { evidence: o.evidence, answerId: o.answerId },
        leakScreen: leak,
        realLane: real,
      });
    }
  }

  const nRows = perTask.length;
  const rate = (x) => nRows === 0 ? 0 : x / nRows;
  const certified = perTask.filter((t) => t.certified);
  const rejected = perTask.filter((t) => !t.certified);
  const rejectedReasonHistogram = {};
  for (const t of rejected) for (const r of t.reasons) {
    const key = r.split(':')[0];
    rejectedReasonHistogram[key] = (rejectedReasonHistogram[key] ?? 0) + 1;
  }

  return {
    kind: 'bmu-p2-certification',
    family,
    spec: 'BMU_SPEC.md rev3.2 ad7e523 (§2.2 judge, §13.2 margins, G-B1..G-B3)',
    seed,
    corpusDefinition: `all ${docs.length} public docs in the sample bank (cross-cluster docs act as distractors)`,
    totals: {
      rows: nRows,
      certified: certified.length,
      rejected: rejected.length,
      certificationRate: rate(certified.length),
      oracleRate: rate(laneTotals.oracle.u),
      leakScreenPassRate: rate(leakPass),
      trapLexicallyDominantRate: rate(trapDominant),
    },
    baselineRates: Object.fromEntries(['bm25', 'firstK', 'randomK', 'oracle'].map((lane) => [lane, {
      uRate: rate(laneTotals[lane].u),
      answerInTopBRate: rate(laneTotals[lane].answerInTopB),
      requiredCoveredRate: rate(laneTotals[lane].requiredCovered),
      forbiddenAdmittedRate: rate(laneTotals[lane].forbiddenAdmitted),
    }])),
    realLaneCoverage: realLane ? {
      rowsCertified: realRows.length,
      rowsTotal: nRows,
      cap: `SMALL-SCALE by design this phase (Track-A agents hold the Qwen box): ${realRows.length}/${nRows} rows; rerank candidate cap ${realLane.params?.rerankCandidates ?? 'n/a'} of rerankerInputTopK=${realLane.params?.rerankerInputTopK ?? 64}; blank-state margins only (parent/oracle-solved states deferred to the full-bank certification run)`,
      params: realLane.params ?? null,
      rows: realRows,
    } : { rowsCertified: 0, rowsTotal: nRows, cap: 'real lane NOT RUN in this invocation' },
    rejectedTasks: rejected.map((t) => ({ rowId: t.rowId, reasons: t.reasons })),
    rejectedReasonHistogram,
    certifiedSubset: certified.map((t) => t.rowId),
    perTask,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1], i++;
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bank || !args.out) {
    console.error('usage: certify-lanes.mjs --bank <sample-bank.json> --out <certification.json> [--real-lane <json>] [--seed <s>] [--budget-override <n>]');
    process.exit(2);
  }
  const bankRaw = readFileSync(args.bank);
  const bank = JSON.parse(bankRaw.toString('utf8'));
  const realLane = args['real-lane'] ? JSON.parse(readFileSync(args['real-lane'], 'utf8')) : null;
  const report = certifyBank(bank, {
    seed: args.seed ?? 'bmu-p2-certify-v1',
    realLane,
    budgetOverride: args['budget-override'] ? Number(args['budget-override']) : null,
  });
  report.bankSha256 = createHash('sha256').update(bankRaw).digest('hex');
  if (args['real-lane']) report.realLaneResultsSha256 = createHash('sha256').update(readFileSync(args['real-lane'])).digest('hex');
  const json = JSON.stringify(report, null, 1);
  writeFileSync(args.out, json);
  // Certified-subset pointer on the bank manifest (generator handshake).
  if (args['update-manifest']) {
    const manifest = JSON.parse(readFileSync(args['update-manifest'], 'utf8'));
    if (manifest.sampleBankSha256 !== report.bankSha256) {
      throw new Error(`manifest/bank sha mismatch: manifest pins ${manifest.sampleBankSha256}, certified bank is ${report.bankSha256}`);
    }
    manifest.certification = {
      path: args.out,
      certificationSha256: createHash('sha256').update(json).digest('hex'),
      certifiedSubsetSize: report.certifiedSubset.length,
      rowsTotal: report.totals.rows,
      certifiedSubset: report.certifiedSubset,
      rejectedTasks: report.rejectedTasks,
    };
    writeFileSync(args['update-manifest'], JSON.stringify(manifest, null, 1));
    console.log(`manifest updated with certified-subset pointer: ${args['update-manifest']}`);
  }
  console.log(`certification written: ${args.out}`);
  console.log(JSON.stringify({ totals: report.totals, baselineRates: report.baselineRates, realLaneCoverage: report.realLaneCoverage.cap, rejectedReasonHistogram: report.rejectedReasonHistogram }, null, 1));
}
