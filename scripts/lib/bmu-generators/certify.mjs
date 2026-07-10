/**
 * BMU P2 hardness-certification harness (SHARED, family-parameterized).
 *
 * Spec: BMU_SPEC.md rev3.2 (commit ad7e523) §13.2 certification margin
 * screen + I8 (frontier admission = base-stack failure) + handoff gates:
 *   G-B1  no-substrate BGE(+Qwen) scores below target at equal budget,
 *   G-B2  oracle structural solver >= 0.90,
 *   G-B3  BM25 / first-K / random-K cannot reach the screener threshold.
 *
 * Consumes a `coretex.bmu-p2-sample-bank.v1` bank (emit-*-sample-bank.mjs)
 * and produces `certification.json`: per-task verdicts, baseline competitive
 * rates, oracle rate, real-lane margins, rejected tasks WITH reasons (no
 * silent drops), and every capacity cap logged explicitly (no-silent-caps).
 *
 * STAGES
 *   1. CPU-cheap baselines, FULL-SCALE over every row at the row's budget B:
 *      BM25 (Okapi, k1=1.2 b=0.75, docId-asc tiebreak), first-K (bank doc
 *      order), random-K (seeded per row). Judge per §13.2: u(t)=1 iff
 *      requiredEvidence ⊆ top-B AND forbiddenEvidence ∩ top-B = ∅. We also
 *      track ANSWER RECOVERY (answer doc in top-B with zero forbidden
 *      admitted) — the G-B3 phrase — which is weaker than judge success.
 *      Per-task rejection uses the CONTENT-DRIVEN baselines (BM25, first-K);
 *      random-K is a BANK-LEVEL rate gate (a lucky seeded draw says nothing
 *      about one task's structure; a bank-level rate above chance does).
 *   2. Oracle structural solver (family adapter): solves via the bank's
 *      RELATION structure + doc metadata — never reads qrels/bmuTask — and
 *      must judge-succeed on >= 0.90 of rows (G-B2).
 *   3. Answer-leak screen, FULL-SCALE: re-runs the mint lint
 *      (common.mjs lintNoAnswerLeak — NoLiMa-motivated anti-lexical-shortcut
 *      screen) independently over the emitted bank bytes.
 *   4. REAL-EMBEDDING lane (small-scale, cap logged): consumes scores from
 *      certify-real-lane.mjs (canonical bi_encoder_runner.py + Qwen3
 *      reranker_runner.py, production pins). Blank-state-only margins per
 *      §13.2: preRankScore space == biCosine on a blank substrate (no
 *      admission bonuses) with the rank-`rerankerInputTopK` cap boundary,
 *      and final-order space == normalized reranker score (no finalBonus /
 *      policyBonus on blank) with the rank-B boundary; both quantized at
 *      g = 1e-3 with the >= 3-grid-cell rule. Parent and oracle-solved
 *      substrate states need the full scorer pipeline and are DEFERRED to
 *      the dedicated full-bank certification run (logged as a cap).
 *
 * ABSTAIN AWARENESS (near_collision_abstention lane extension, backward-
 * compatible with answerable-only families): abstain rows judge per §2.2's
 * abstention u(t) — zero forbidden admitted AND the §5.5 policy-atom signal
 * fires. The signal never fires for substrate-less stacks, so every baseline
 * lane is u=0 on abstain rows BY LAW; their hardness screen is instead the
 * §5.4 anti-free-abstention law (trap adjacency: content-driven retrieval
 * must ADMIT the collision neighborhood on the absent variant). The oracle
 * derives the abstain decision structurally and returns
 * { ranked, abstainSignal } instead of a bare ranking.
 *
 * Usage:
 *   node certify.mjs --bank <sample-bank.json> --out-dir <dir>
 *        [--emit-real-lane-job <path>]   # write job for certify-real-lane.mjs
 *        [--real-lane-scores <path>]     # consume its output
 *        [--real-clusters <n>]           # subsample size (default 2)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { unit, prng, lintNoAnswerLeak, lintTokens } from './common.mjs';
import { executeProgramOverRelations } from './operation-program.mjs';

// ─── Production pins (mirrors packages/coretex/src/bundle/index.ts; the
//     real-lane driver re-asserts them; single-sourcing is a P7 merge item) ──
export const CERT_PINS = Object.freeze({
  biencoder: Object.freeze({
    modelId: 'BAAI/bge-m3',
    revision: '5617a9f61b028005a4858fdac845db406aefb181', // BGE_M3_DEFAULT_REVISION
    layout: Object.freeze({ dim: 243, quantization: 'int8' }), // BGE_M3_DEFAULT_LAYOUT payload
  }),
  reranker: Object.freeze({
    modelId: 'Qwen/Qwen3-Reranker-0.6B',
    revision: 'e61197ed45024b0ed8a2d74b80b4d909f1255473', // QWEN3_RERANKER_DEFAULT_REVISION
  }),
  rerankerInputTopK: 64,   // §13.2 / §15.8 live cap pin
  judgeScoreGrid: 1e-3,    // §13.2 default g (composite space)
  preRankGrid: 1e-3,       // §13.2 g_pre (preRankScore space)
  marginCellsMin: 3,       // §13.2 certification margin
  oracleMinRate: 0.90,     // G-B2
});

// ─── Tokenizer + Okapi BM25 (k1=1.2, b=0.75, Robertson idf) ─────────────────
export function bm25Tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

export function buildBm25Index(docs, { k1 = 1.2, b = 0.75 } = {}) {
  const N = docs.length;
  const docTokens = docs.map((d) => bm25Tokenize(d.text));
  const docLen = docTokens.map((t) => t.length);
  const avgLen = docLen.reduce((a, x) => a + x, 0) / Math.max(1, N);
  const df = new Map();
  const tf = docTokens.map((tokens) => {
    const m = new Map();
    for (const tok of tokens) m.set(tok, (m.get(tok) ?? 0) + 1);
    for (const tok of m.keys()) df.set(tok, (df.get(tok) ?? 0) + 1);
    return m;
  });
  const idf = new Map();
  for (const [tok, d] of df) idf.set(tok, Math.log(1 + (N - d + 0.5) / (d + 0.5)));
  return { docs, tf, docLen, avgLen, idf, k1, b };
}

/** Full deterministic ordering: score desc, docId asc. */
export function bm25Rank(index, queryText) {
  const qTokens = [...new Set(bm25Tokenize(queryText))];
  const scored = index.docs.map((doc, i) => {
    let s = 0;
    for (const tok of qTokens) {
      const f = index.tf[i].get(tok);
      if (!f) continue;
      const w = index.idf.get(tok) ?? 0;
      s += w * (f * (index.k1 + 1)) / (f + index.k1 * (1 - index.b + index.b * (index.docLen[i] / index.avgLen)));
    }
    return { docId: doc.id, score: s };
  });
  scored.sort((a, bb) => bb.score - a.score || (a.docId < bb.docId ? -1 : 1));
  return scored;
}

export function firstKRank(docs) {
  return docs.map((d) => ({ docId: d.id, score: 0 }));
}

/** Seeded partial Fisher-Yates: deterministic random ordering per row. */
export function randomKRank(docs, seedStr) {
  const rnd = prng(seedStr);
  const idx = docs.map((_, i) => i);
  for (let i = 0; i < idx.length - 1; i++) {
    const j = i + Math.floor(rnd() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.map((i) => ({ docId: docs[i].id, score: 0 }));
}

// ─── The deterministic judge (§13.2 read for offline certification) ─────────
/**
 * Abstain-aware per spec §2.2 u(t):
 *   ANSWERABLE — u=1 iff R ⊆ top-B AND F ∩ top-B = ∅ AND (a ∈ top-B, implied
 *     by the §4.1 `answer.id ∈ requiredEvidence` invariant the bank recheck
 *     enforces) AND the §5.5 abstention signal does NOT fire (false-abstain
 *     counterweight);
 *   ABSTAIN (`abstain: true`, R = ∅, answer absent) — u=1 iff F ∩ top-B = ∅
 *     AND the §5.5 signal FIRES. The signal is the policy-ATOM abstention
 *     decision; the r5 no-atom fallback is explicitly NOT part of BMU u(t)
 *     (§5.5), so substrate-less stacks (CPU baselines, blank BGE/Qwen) can
 *     NEVER judge-succeed on abstain rows — `signalFires` defaults false and
 *     only the structural ORACLE derives it. `retrievalClean` reports the
 *     retrieval half (zero forbidden admitted) as telemetry either way.
 */
export function judgeTopB(ranked, bmuTask, { signalFires = false } = {}) {
  const topB = ranked.slice(0, bmuTask.budgetB).map((r) => r.docId);
  const topSet = new Set(topB);
  const requiredHit = bmuTask.requiredEvidence.filter((d) => topSet.has(d));
  const forbiddenAdmitted = bmuTask.forbiddenEvidence.filter((d) => topSet.has(d));
  const retrievalClean = forbiddenAdmitted.length === 0;
  if (bmuTask.abstain === true) {
    return { topB, requiredHit: 0, requiredTotal: 0, forbiddenAdmitted, answerInTopB: null, answerNoForbidden: false, retrievalClean, signalFires, judgeSuccess: retrievalClean && signalFires };
  }
  const answerInTopB = topSet.has(bmuTask.answer.id);
  const judgeSuccess = requiredHit.length === bmuTask.requiredEvidence.length && forbiddenAdmitted.length === 0 && !signalFires;
  const answerNoForbidden = answerInTopB && forbiddenAdmitted.length === 0;
  return { topB, requiredHit: requiredHit.length, requiredTotal: bmuTask.requiredEvidence.length, forbiddenAdmitted, answerInTopB, answerNoForbidden, retrievalClean, signalFires, judgeSuccess };
}

// ─── Family adapters (oracle = structure-only; NEVER reads qrels/bmuTask) ───
/**
 * conflict_lifecycle oracle: the real memory operation per spec §5.2 —
 * follow the `contradicts` edge to find (winner=resolved, loser=candidate)
 * for the query's subject AND scope, follow `resolution_of` from the same
 * loser to the resolution record; rank {winner, resolution} first, neutral
 * (other-subject) docs in the middle, and structurally-excluded docs (the
 * contradicted candidate + every same-subject scope-mismatch doc) LAST.
 */
export function conflictLifecycleOracleRank(row, { docs, docById, relations }) {
  const subj = row.subjectEntityId;
  const scope = row.publicIntent?.lifecycleScope;
  if (!scope) return null;
  const isSubject = (d) => Array.isArray(d.entityIds) && d.entityIds.includes(subj);
  let winner = null; let loser = null;
  for (const rel of relations) {
    if (rel.label !== 'contradicts') continue;
    const src = docById.get(rel.src); const dst = docById.get(rel.dst);
    if (!src || !dst || !isSubject(src) || !isSubject(dst)) continue;
    if (src.lifecycleScope !== scope) continue;
    winner = src.id; loser = dst.id; break;
  }
  if (!winner || !loser) return null;
  let resolution = null;
  for (const rel of relations) {
    if (rel.label !== 'resolution_of' || rel.dst !== loser) continue;
    const src = docById.get(rel.src);
    if (src && isSubject(src)) { resolution = src.id; break; }
  }
  if (!resolution) return null;
  const top = [winner, resolution];
  const topSet = new Set(top);
  const excluded = []; const neutral = [];
  for (const d of docs) {
    if (topSet.has(d.id)) continue;
    if (isSubject(d)) excluded.push(d.id); // contradicted candidate + scope mismatches
    else neutral.push(d.id);
  }
  neutral.sort(); excluded.sort();
  return [...top, ...neutral, ...excluded].map((docId, i) => ({ docId, score: -i }));
}

/** conflict primary trap = the PUBLIC contradicted target. No lifecycle role
 * metadata is consulted. */
function conflictPrimaryTrapDocId(row, { relations }) {
  const forbidden = new Set(row.bmuTask.forbiddenEvidence);
  for (const rel of relations) {
    if (rel.label === 'contradicts' && forbidden.has(rel.dst)) return rel.dst;
  }
  return row.bmuTask.forbiddenEvidence[0];
}

/**
 * conflict leak-sensitive secret (mirrors the generator's mint lint): the
 * RESOLVED value valB on EVERY row of the cluster — provenance/verification
 * rows carry composite answer strings that legitimately name the trap's own
 * value valA (mirrored verbatim in the trap doc, never gold-only), so
 * linting those strings verbatim would false-positive. valB is recovered
 * from the sibling current_for_scope row of the same motifGroup.
 */
function conflictLeakSensitiveValue(row, { rowsByMotif }) {
  const siblings = rowsByMotif.get(row.bmuTask.motifGroupId) ?? [];
  const current = siblings.find((r) => r.questionType === 'current_for_scope');
  if (!current) throw new Error(`conflictLeakSensitiveValue: motifGroup ${row.bmuTask.motifGroupId} has no current_for_scope row`);
  return current.bmuTask.answer.value;
}

/**
 * near_collision_abstention oracle: the real memory operation per spec §5.4 —
 * DISCRIMINATION over the bounded v2 public-path bundle. The cluster manifest
 * supplies only the bounded document ids. Public text identifies the registry
 * review anchor and standing filing; the relation graph must then prove the
 * disjoint diamond D --outgoing--> pivot <--incoming-- E. The queried scope
 * comes from PUBLIC intent. Never reads qrels/bmuTask or hidden doc metadata.
 *
 * ANSWERABLE (standing filing E covers the queried scope): rank [E, D] first
 * (covers required sets [E], [E,D], [D,E] at B=3), neutral docs next, the
 * rest of N (the sibling decoy set = forbidden) LAST; signal must NOT fire.
 * ABSTAIN (no doc in N covers the queried scope): the §5.5 MISSING_EVIDENCE
 * decision fires structurally — rank neutral docs first, D (not forbidden)
 * next, the rest of N (forbidden = E + decoys) LAST, abstainSignal: true.
 */
export function nearCollisionOracleRank(row, { docs, docById, relations, clusterByRowId }) {
  const scopeQ = row.publicIntent?.collisionScope;
  const cluster = clusterByRowId?.get(row.id);
  if (!scopeQ || !cluster) return null;
  const clusterIds = new Set(cluster.docIds);
  const clusterDocs = cluster.docIds.map((id) => docById.get(id)).filter(Boolean);
  const exactDoc = clusterDocs.find((doc) => / in the registry workspace filing\.$/i.test(doc.text));
  const disambigDoc = clusterDocs.find((doc) => /^Registry review /i.test(doc.text));
  if (!exactDoc || !disambigDoc) return null;

  const program = row.bmuOperationProgram;
  if (!program || program.branchLimit !== 4 || !Array.isArray(program.steps)) return null;
  // Deep-terminal law: execute the row's actual public program from the
  // disambiguation anchor and require the exact-match doc to be a routed
  // TERMINAL — the same walk the compiled scorer runs.
  let executed;
  try {
    executed = executeProgramOverRelations({
      program,
      relations: relations.filter((rel) => clusterIds.has(rel.src) || clusterIds.has(rel.dst)),
      seedIds: [disambigDoc.id],
    });
  } catch {
    return null;
  }
  if (!executed.terminalIds.includes(exactDoc.id)) return null;

  const neutral = []; const excluded = [];
  for (const d of docs) {
    if (d.id === exactDoc.id || d.id === disambigDoc.id) continue;
    if (clusterIds.has(d.id)) excluded.push(d.id);
    else neutral.push(d.id);
  }
  neutral.sort(); excluded.sort();

  const exactCoversScope = exactDoc.text.toLowerCase().includes(`for the ${String(scopeQ).toLowerCase()} to `);
  if (exactCoversScope) {
    // Standing filing covers the queried variant — answerable; no abstain.
    return { ranked: [exactDoc.id, disambigDoc.id, ...neutral, ...excluded].map((docId, i) => ({ docId, score: -i })), abstainSignal: false };
  }
  // An uncovered scope is a structural missing-evidence decision. Reject an
  // ambiguous bank if some other standing-filing text claims that exact scope.
  const coverageNeedle = `for the ${String(scopeQ).toLowerCase()} to `;
  if (clusterDocs.some((doc) => doc.id !== exactDoc.id && doc.text.toLowerCase().includes(coverageNeedle))) return null;
  return { ranked: [...neutral, disambigDoc.id, exactDoc.id, ...excluded].map((docId, i) => ({ docId, score: -i })), abstainSignal: true };
}

/**
 * near-collision primary trap: answerable rows — the duplicate-name alias
 * collision (§5.4 PRIMARY trap, `collisionRole` pin); abstain rows — the
 * answerable sibling E (§5.4: E is itself the plausible decoy for the
 * absent variant).
 */
function nearCollisionPrimaryTrapDocId(row) {
  return row.bmuTask.forbiddenEvidence[0];
}

/**
 * near-collision leak-sensitive secret (mirrors the generator's mint lint):
 * the cluster's exact-match value V on EVERY row — the
 * lookalike_status_verification row's composite answer legitimately names
 * the trap's own value (mirrored verbatim in the trap doc, never gold-only),
 * and abstain rows have no answer; V is recovered from the sibling
 * exact_variant_lookup row of the same motifGroup.
 */
function nearCollisionLeakSensitiveValue(row, { rowsByMotif }) {
  const siblings = rowsByMotif.get(row.bmuTask.motifGroupId) ?? [];
  const exactRow = siblings.find((r) => r.questionType === 'exact_variant_lookup');
  if (!exactRow) throw new Error(`nearCollisionLeakSensitiveValue: motifGroup ${row.bmuTask.motifGroupId} has no exact_variant_lookup row`);
  return exactRow.bmuTask.answer.value;
}

export const FAMILY_ADAPTERS = Object.freeze({
  conflict_lifecycle: Object.freeze({
    oracleRank: conflictLifecycleOracleRank,
    primaryTrapDocId: conflictPrimaryTrapDocId,
    leakSensitiveValue: conflictLeakSensitiveValue,
  }),
  near_collision_abstention: Object.freeze({
    oracleRank: nearCollisionOracleRank,
    primaryTrapDocId: nearCollisionPrimaryTrapDocId,
    leakSensitiveValue: nearCollisionLeakSensitiveValue,
  }),
  // other family lanes register here (temporal / multi_hop_relation) —
  // keep certify.mjs shared across lanes.
});

// ─── §4.1 fail-closed input recheck (certification is meaningless on a
//     structurally invalid bank) ─────────────────────────────────────────────
export function validateBankRow(row, docById) {
  const errors = [];
  const t = row.bmuTask;
  if (!t) return [`${row.id}: missing bmuTask`];
  const qrelBy = new Map(row.qrels.map((q) => [q.docId, q.relevance]));
  for (const d of t.requiredEvidence) {
    if (!docById.has(d)) errors.push(`${row.id}: required '${d}' not in public docs`);
    if ((qrelBy.get(d) ?? 0) < 0.5) errors.push(`${row.id}: required '${d}' has qrel < 0.5`);
  }
  for (const d of t.forbiddenEvidence) {
    if (!docById.has(d)) errors.push(`${row.id}: forbidden '${d}' not in public docs`);
    if ((qrelBy.get(d) ?? 0) >= 0.5) errors.push(`${row.id}: forbidden '${d}' has qrel >= 0.5`);
    if (t.requiredEvidence.includes(d)) errors.push(`${row.id}: '${d}' both required and forbidden`);
  }
  if (t.requiredEvidence.length > t.budgetB) errors.push(`${row.id}: |required| > budget B`);
  if (t.abstain === true) {
    // §4.1: abstain=true ⇒ requiredEvidence = [], answer ABSENT; §5.4: the
    // forbidden set is the collision neighborhood — it must be non-empty
    // (abstention with nothing to resist admitting is free blank utility).
    if (t.requiredEvidence.length !== 0) errors.push(`${row.id}: abstain row has non-empty requiredEvidence`);
    if (t.answer !== undefined) errors.push(`${row.id}: abstain row carries an answer`);
    if (t.forbiddenEvidence.length === 0) errors.push(`${row.id}: abstain row has empty forbiddenEvidence (nothing to resist admitting)`);
  } else if (!t.requiredEvidence.includes(t.answer.id)) {
    errors.push(`${row.id}: answer '${t.answer.id}' not in requiredEvidence`);
  }
  return errors;
}

// ─── Real-lane subsample: deterministic, epoch-spread (escalation coverage) ─
export function selectRealLaneClusters(bank, n = 2) {
  const seed = bank.params.seed;
  const epochs = [...new Set(bank.clusters.map((c) => c.epoch))].sort((a, b) => a - b);
  // Spread across the escalation range: first epoch, last epoch, then inward.
  const order = [];
  for (let lo = 0, hi = epochs.length - 1; lo <= hi; lo++, hi--) {
    order.push(epochs[lo]);
    if (hi !== lo) order.push(epochs[hi]);
  }
  const picked = [];
  for (let i = 0; picked.length < n && i < order.length; i++) {
    const epoch = order[i];
    const candidates = bank.clusters
      .filter((c) => c.epoch === epoch && !picked.includes(c))
      .sort((a, b) => unit(`${seed}:realLane:${a.motifGroupId}`) - unit(`${seed}:realLane:${b.motifGroupId}`));
    if (candidates.length > 0) picked.push(candidates[0]);
  }
  if (picked.length < n) throw new Error(`selectRealLaneClusters: only ${picked.length} clusters available for n=${n}`);
  return picked;
}

// ─── §13.2 margins: quantize, then grid-cell distance to a rank boundary ────
const qcells = (score, grid) => Math.round(score / grid);
/**
 * For each doc of interest: side of the rank-`k` boundary it landed on and
 * its quantized distance (grid cells) to the boundary score. Boundary score
 * = quantized score of the rank-k item (the last one in). A doc INSIDE
 * measures against the first item OUT (rank k+1); a doc OUTSIDE against the
 * last item IN (rank k) — i.e. the gap it would need to cross to flip.
 */
export function boundaryMargins(ranked, k, grid, docIds) {
  if (ranked.length <= k) {
    return { boundary: null, note: `pool ${ranked.length} <= k=${k}; every doc in-cap`, perDoc: docIds.map((docId) => ({ docId, side: 'in', cells: null })) };
  }
  const scoreBy = new Map(ranked.map((r) => [r.docId, r.score]));
  const rankBy = new Map(ranked.map((r, i) => [r.docId, i]));
  const lastInQ = qcells(ranked[k - 1].score, grid);
  const firstOutQ = qcells(ranked[k].score, grid);
  const perDoc = docIds.map((docId) => {
    const rank = rankBy.get(docId);
    if (rank === undefined) return { docId, side: 'absent', cells: null };
    const q = qcells(scoreBy.get(docId), grid);
    const inside = rank < k;
    const cells = inside ? q - firstOutQ : lastInQ - q;
    return { docId, rank, side: inside ? 'in' : 'out', cells };
  });
  return { boundary: { lastInQ, firstOutQ }, perDoc };
}

// ─── Main certification ──────────────────────────────────────────────────────
export function certifyBank(bank, { realLaneScores = null, realClusters = 2, pins = CERT_PINS } = {}) {
  const adapter = FAMILY_ADAPTERS[bank.family];
  if (!adapter) throw new Error(`certifyBank: no family adapter for '${bank.family}'`);
  const docs = bank.publicDocs;
  const docById = new Map(docs.map((d) => [d.id, d]));
  const relations = bank.relations;
  const rowsByMotif = new Map();
  for (const row of bank.rows) {
    const list = rowsByMotif.get(row.bmuTask?.motifGroupId) ?? [];
    list.push(row);
    rowsByMotif.set(row.bmuTask?.motifGroupId, list);
  }
  const clusterByRowId = new Map(bank.clusters.flatMap((cluster) =>
    cluster.rowIds.map((rowId) => [rowId, cluster])));
  const ctx = { docs, docById, relations, rowsByMotif, clusterByRowId };

  // Fail-closed input recheck.
  const bankErrors = [];
  for (const row of bank.rows) bankErrors.push(...validateBankRow(row, docById));
  if (bankErrors.length > 0) throw new Error(`certifyBank: bank failed §4.1 recheck:\n  ${bankErrors.join('\n  ')}`);

  const bm25 = buildBm25Index(docs);
  const firstK = firstKRank(docs);

  // Real-lane subsample (deterministic) — resolved whether or not scores are
  // present so the job emission and the consume pass agree byte-for-byte.
  const realLaneClusterPick = selectRealLaneClusters(bank, realClusters);
  const realRowIds = new Set(realLaneClusterPick.flatMap((c) => c.rowIds));
  const realScoresByQuery = new Map((realLaneScores?.perQuery ?? []).map((q) => [q.id, q]));

  const perTask = [];
  for (const row of bank.rows) {
    const t = row.bmuTask;
    const lanes = {
      bm25: judgeTopB(bm25Rank(bm25, row.queryText), t),
      firstK: judgeTopB(firstK, t),
      randomK: judgeTopB(randomKRank(docs, `${bank.params.seed}:certify:randomK:${row.id}`), t),
    };
    // Oracle: adapters return either a plain ranking (answerable-only
    // families) or { ranked, abstainSignal } (families with abstain rows —
    // the oracle derives the §5.5 decision structurally).
    const oracleOut = adapter.oracleRank(row, ctx);
    const oracleRanked = Array.isArray(oracleOut) ? oracleOut : oracleOut?.ranked;
    const oracleSignal = Array.isArray(oracleOut) ? false : (oracleOut?.abstainSignal ?? false);
    const oracle = oracleRanked ? judgeTopB(oracleRanked, t, { signalFires: oracleSignal }) : { judgeSuccess: false, error: 'oracle_no_structural_solution' };

    // Answer-leak screen (full-scale, independent re-run over emitted bytes).
    // Abstain rows mirror the generator's mint lint: no primary-trap
    // dominance / gold-only checks (no answer doc exists), but the cluster's
    // leak-sensitive secret must still stay out of the question text.
    const trapDocId = adapter.primaryTrapDocId(row, ctx);
    const leakErrors = lintNoAnswerLeak({
      rowId: row.id,
      queryText: row.queryText,
      answerValue: adapter.leakSensitiveValue(row, ctx),
      requiredDocTexts: t.requiredEvidence.map((d) => docById.get(d).text),
      forbiddenDocTexts: t.forbiddenEvidence.map((d) => docById.get(d).text),
      ...(t.abstain === true ? {} : {
        primaryTrapText: docById.get(trapDocId)?.text,
        answerDocText: docById.get(t.answer.id)?.text,
      }),
    });
    // Extra lexical-shortcut telemetry: query-token overlap of answer doc vs
    // the max over forbidden docs (NoLiMa: lexical match must not point gold;
    // abstain rows have no gold — forbidden overlap alone documents that the
    // collision neighborhood lexically out-pulls on the absent variant).
    const qTok = lintTokens(row.queryText);
    const overlap = (text) => { const s = lintTokens(text); let n = 0; for (const x of qTok) if (s.has(x)) n++; return n; };
    const goldOverlap = t.abstain === true ? null : overlap(docById.get(t.answer.id).text);
    const maxForbiddenOverlap = Math.max(...t.forbiddenEvidence.map((d) => overlap(docById.get(d).text)));

    // Real lane (subsample only; caps logged at the report level).
    let realLane = null;
    if (realRowIds.has(row.id) && realScoresByQuery.has(row.id)) {
      const s = realScoresByQuery.get(row.id);
      const marginDocs = [...t.requiredEvidence, ...t.forbiddenEvidence];
      const cosRanked = Object.entries(s.cosine).map(([docId, score]) => ({ docId, score }))
        .sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : 1));
      const bge = judgeTopB(cosRanked, t);
      const capMargins = boundaryMargins(cosRanked, pins.rerankerInputTopK, pins.preRankGrid, marginDocs);
      let rerank = null; let rerankMargins = null;
      if (s.rerank && Object.keys(s.rerank).length > 0) {
        // Blank-state composite == reranker sigmoid score (no bonuses);
        // §13.2 tiebreak (quantized composite, quantized rerankerScore,
        // docId) degenerates to (quantized score, docId) here.
        const g = pins.judgeScoreGrid;
        const rr = Object.entries(s.rerank).map(([docId, score]) => ({ docId, score }))
          .sort((a, b) => (qcells(b.score, g) - qcells(a.score, g)) || (a.docId < b.docId ? -1 : 1));
        rerank = judgeTopB(rr, t);
        rerankMargins = boundaryMargins(rr, t.budgetB, g, marginDocs.filter((d) => rr.some((x) => x.docId === d)));
      }
      const finalJudge = rerank ?? bge;
      const finalMargins = rerank ? rerankMargins : boundaryMargins(cosRanked, t.budgetB, pins.judgeScoreGrid, marginDocs);
      const lowMargin = [...(finalMargins.perDoc ?? []), ...(capMargins.perDoc ?? [])]
        .some((m) => m.cells !== null && m.cells < pins.marginCellsMin);
      realLane = {
        bge, rerank, capMargins, finalMargins, lowMargin,
        // I8: the no-substrate stack must FAIL or succeed only marginally.
        confidentSuccess: finalJudge.judgeSuccess && !lowMargin,
      };
    }

    // Verdict. Rejection reasons are exhaustive — nothing is silently dropped.
    const reasons = [];
    if (!oracle.judgeSuccess) reasons.push(oracle.error ?? 'oracle_judge_failed');
    if (lanes.bm25.judgeSuccess) reasons.push('bm25_judge_success');
    else if (lanes.bm25.answerNoForbidden) reasons.push('bm25_answer_recovery');
    if (lanes.firstK.judgeSuccess) reasons.push('firstk_judge_success');
    else if (lanes.firstK.answerNoForbidden) reasons.push('firstk_answer_recovery');
    if (leakErrors.length > 0) reasons.push('answer_leak');
    if (realLane?.confidentSuccess) reasons.push('real_lane_confident_success');
    // Abstain trap adjacency (§5.4 anti-free-abstention law): the abstain row
    // must sit INSIDE the collision neighborhood — a content-driven baseline
    // querying the absent variant must ADMIT at least one forbidden sibling
    // into top-B, else abstention here resists nothing and a blanket
    // abstention atom would earn the row without the discrimination
    // operation (modulo only the §5.5 confidence gate).
    if (t.abstain === true && lanes.bm25.retrievalClean) reasons.push('abstain_trap_not_adjacent_bm25');

    perTask.push({
      rowId: row.id, motifGroupId: t.motifGroupId, questionType: row.questionType,
      abstain: t.abstain === true,
      epoch: row.liveUpdateEpoch, budgetB: t.budgetB,
      baselines: lanes, oracle,
      leak: { errors: leakErrors, goldOverlap, maxForbiddenOverlap },
      realLane,
      certified: reasons.length === 0,
      rejectionReasons: reasons,
    });
  }

  // Aggregates. Lane rates are split answerable/abstain where the bank mixes
  // them: abstain rows can never baseline-judge-succeed (§5.5, no signal), so
  // pooled judge-success rates would understate baseline competitiveness on
  // the answerable rows if left unsplit.
  const answerable = perTask.filter((p) => !p.abstain);
  const abstains = perTask.filter((p) => p.abstain);
  const rate = (f) => perTask.filter(f).length / perTask.length;
  const rateOf = (subset, f) => (subset.length === 0 ? null : subset.filter(f).length / subset.length);
  const laneRates = (lane) => ({
    judgeSuccessRate: rate((p) => p.baselines[lane].judgeSuccess),
    answerRecoveryNoForbiddenRate: rateOf(answerable, (p) => p.baselines[lane].answerNoForbidden),
    answerInTopBRate: rateOf(answerable, (p) => p.baselines[lane].answerInTopB),
    forbiddenAdmissionRate: rate((p) => p.baselines[lane].forbiddenAdmitted.length > 0),
    ...(abstains.length > 0 ? {
      answerableJudgeSuccessRate: rateOf(answerable, (p) => p.baselines[lane].judgeSuccess),
      abstainForbiddenAdmissionRate: rateOf(abstains, (p) => p.baselines[lane].forbiddenAdmitted.length > 0),
      abstainRetrievalCleanRate: rateOf(abstains, (p) => p.baselines[lane].retrievalClean),
    } : {}),
  });
  const oracleRate = rate((p) => p.oracle.judgeSuccess);
  const realTasks = perTask.filter((p) => p.realLane);
  const rejected = perTask.filter((p) => !p.certified);
  const reasonHistogram = {};
  for (const p of rejected) for (const r of p.rejectionReasons) reasonHistogram[r] = (reasonHistogram[r] ?? 0) + 1;

  // Bank-level gates.
  const randomKRate = laneRates('randomK');
  const gates = {
    'G-B2_oracle': { rate: oracleRate, min: pins.oracleMinRate, pass: oracleRate >= pins.oracleMinRate },
    'G-B3_bm25': { ...laneRates('bm25'), pass: perTask.every((p) => !p.baselines.bm25.judgeSuccess) },
    'G-B3_firstK': { ...laneRates('firstK'), pass: perTask.every((p) => !p.baselines.firstK.judgeSuccess) },
    // random-K: bank-level rate must sit at chance (B/N per-doc; joint success
    // for 2 required docs ~ (B/N)^2 order). Gate: rate <= 0.05.
    'G-B3_randomK': { ...randomKRate, pass: randomKRate.judgeSuccessRate <= 0.05 },
    'G-B1_realLane_noSubstrate': {
      rowsMeasured: realTasks.length,
      pass: realTasks.length > 0 && realTasks.every((p) => !p.realLane.confidentSuccess),
      confidentSuccesses: realTasks.filter((p) => p.realLane.confidentSuccess).map((p) => p.rowId),
    },
    leakScreen: { pass: perTask.every((p) => p.leak.errors.length === 0) },
    ...(abstains.length > 0 ? {
      // §5.4 anti-free-abstention: every abstain row's collision neighborhood
      // must out-pull under content-driven retrieval (BM25 admits >= 1
      // forbidden sibling at budget B).
      family_abstainTrapAdjacency_bm25: {
        abstainRows: abstains.length,
        pass: abstains.every((p) => !p.baselines.bm25.retrievalClean),
        cleanRows: abstains.filter((p) => p.baselines.bm25.retrievalClean).map((p) => p.rowId),
      },
    } : {}),
  };

  return {
    schema: 'coretex.bmu-p2-certification.v1',
    family: bank.family,
    specPin: 'BMU_SPEC.md rev3.2 (ad7e523) §13.2 / I8 / G-B1..G-B3',
    pins,
    counts: { rows: perTask.length, answerable: answerable.length, abstain: abstains.length, certified: perTask.length - rejected.length, rejected: rejected.length },
    gates,
    baselineRates: { bm25: laneRates('bm25'), firstK: laneRates('firstK'), randomK: randomKRate },
    oracle: { rate: oracleRate },
    realLane: {
      clusterIds: realLaneClusterPick.map((c) => c.motifGroupId),
      rowsCertified: realTasks.length,
      rowsTotal: perTask.length,
      caps: [
        `real-embedding lane ran on ${realTasks.length}/${perTask.length} rows (${realLaneClusterPick.length} clusters) — SMALL-SCALE by design; full-bank real-Qwen sweep deferred to the dedicated certification run (Track-A gate agents hold the Qwen resources)`,
        'margins measured on the BLANK substrate state only; parent and oracle-solved substrate states (§13.2 three-state rule) need the full scorer pipeline and are deferred with the full-bank sweep',
      ],
      runtime: realLaneScores?.runtime ?? null,
    },
    rejected: rejected.map((p) => ({ rowId: p.rowId, motifGroupId: p.motifGroupId, questionType: p.questionType, reasons: p.rejectionReasons })),
    rejectionReasonHistogram: reasonHistogram,
    certifiedRowIds: perTask.filter((p) => p.certified).map((p) => p.rowId),
    perTask,
  };
}

// ─── Real-lane job emission (input for certify-real-lane.mjs) ────────────────
export function buildRealLaneJob(bank, { realClusters = 2, pins = CERT_PINS } = {}) {
  const clusters = selectRealLaneClusters(bank, realClusters);
  const rowIds = new Set(clusters.flatMap((c) => c.rowIds));
  const rows = bank.rows.filter((r) => rowIds.has(r.id));
  return {
    schema: 'coretex.bmu-p2-real-lane-job.v1',
    family: bank.family,
    pins,
    clusters: clusters.map((c) => c.motifGroupId),
    queries: rows.map((r) => ({ id: r.id, text: r.queryText })),
    docs: bank.publicDocs.map((d) => ({ id: d.id, text: d.text })),
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const bankPath = opt('--bank');
  const outDir = opt('--out-dir');
  const emitJob = opt('--emit-real-lane-job', null);
  const scoresPath = opt('--real-lane-scores', null);
  const realClusters = Number(opt('--real-clusters', '2'));
  if (!bankPath || !outDir) { console.error('usage: certify.mjs --bank <sample-bank.json> --out-dir <dir> [--emit-real-lane-job <p>] [--real-lane-scores <p>] [--real-clusters n]'); process.exit(1); }

  const bankBytes = readFileSync(bankPath);
  const bank = JSON.parse(bankBytes.toString('utf8'));

  if (emitJob) {
    const job = buildRealLaneJob(bank, { realClusters });
    writeFileSync(emitJob, JSON.stringify(job, null, 1) + '\n');
    console.log(`wrote real-lane job ${emitJob} (${job.queries.length} queries × ${job.docs.length} docs, clusters: ${job.clusters.join(', ')})`);
  }

  const realLaneScores = scoresPath ? JSON.parse(readFileSync(scoresPath, 'utf8')) : null;
  const report = certifyBank(bank, { realLaneScores, realClusters });
  report.provenance = {
    bankPath: resolve(bankPath),
    bankSha256: createHash('sha256').update(bankBytes).digest('hex'),
    generatedAt: new Date().toISOString(),
    realLaneScoresPath: scoresPath ? resolve(scoresPath) : null,
  };
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, 'certification.json');
  const outBytes = JSON.stringify(report, null, 1) + '\n';
  writeFileSync(outPath, outBytes);
  console.log(`wrote ${outPath}`);

  // Certified-subset pointer on the generator's bank manifest (the bank
  // itself stays byte-frozen; consumers select rows via the pointer).
  // Lane conventions differ on the manifest basename — probe both.
  const manifestPath = ['sample-bank.manifest.json', 'manifest.json']
    .map((name) => resolve(bankPath, '..', name))
    .find((p) => { try { readFileSync(p); return true; } catch { return false; } })
    ?? resolve(bankPath, '..', 'sample-bank.manifest.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.certification = {
      path: 'certification.json',
      sha256: createHash('sha256').update(outBytes).digest('hex'),
      rowsTotal: report.counts.rows,
      certified: report.counts.certified,
      rejected: report.counts.rejected,
      realLaneRowsMeasured: report.realLane.rowsCertified,
      gates: Object.fromEntries(Object.entries(report.gates).map(([k, v]) => [k, v.pass])),
      certifiedRowIdsField: 'certifiedRowIds (in certification.json)',
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
    console.log(`updated ${manifestPath} with certified-subset pointer`);
  } catch (err) {
    console.error(`WARNING: could not update bank manifest (${manifestPath}): ${err.message}`);
  }
  console.log(JSON.stringify({ counts: report.counts, gates: Object.fromEntries(Object.entries(report.gates).map(([k, v]) => [k, v.pass])), oracleRate: report.oracle.rate, reasons: report.rejectionReasonHistogram }, null, 1));
}
