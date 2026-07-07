/**
 * BMU P2 generator shared helpers (BMU_SPEC.md rev3.2, commit ad7e523).
 *
 * ANCESTRY (I10): every mechanism here DESCENDS from
 * `scripts/lib/evolve-corpus.mjs` (the Stage 3-G1 typed-cluster minter) —
 * inherited byte-for-byte where possible, with each delta named:
 *   - sha256 `unit`/`prng` helpers: inherited verbatim (evolve-corpus.mjs:20-22).
 *   - attribute rotation: descends from `temporalAttributeForEpochSlot`
 *     (evolve-corpus.mjs:71-81 — qualifier × base grid, series suffix).
 *     DELTA 1: per-cluster stride (not 2/epoch) so EVERY cluster minted in an
 *     epoch carries a window-unique attribute string — required because the
 *     §4.1 GLOBAL m=1 template-partition law is realized by baking the
 *     (attribute, scope) pair into each row's surface-form template (see
 *     `templateId` docs in the family generators): attribute uniqueness per
 *     cluster ⇒ template disjointness per cluster.
 *     DELTA 2: family-namespaced qualifier grids so BMU families never burn
 *     the temporal rotation's attribute space (an attribute is one-shot
 *     headroom under temporalMotifAdmission — evolve-corpus.mjs:36-53).
 *   - eval_hidden id salt-search: descends from the hidden-cluster minter loop
 *     (evolve-corpus.mjs:727-737 — probe `q_<base>_v<stub>_s<probe>` until the
 *     canonical injected `splitOf` says eval_hidden).
 *     DELTA 3: FAIL-CLOSED — the ancestor `continue`d past a stub whose 96
 *     probes all missed, leaving a partial cluster; under BMU a partial
 *     cluster breaks the k=5 law and the §6.7b E_f_min census arithmetic, so
 *     exhaustion throws instead (P(miss all 96) = 0.85^96 ≈ 6e-7 per stub).
 *   - purity: like `evolveCorpusDelta`, generators take the canonical split
 *     assignment as an INJECTED `splitOf(logicalQueryId, liveUpdateEpoch)`
 *     (splitForRecord over the production event id, wired by the caller —
 *     see `makeCanonicalSplitOf`) so the generator itself has no dist import
 *     and stays a pure function of its arguments.
 *
 * BMU constants below MIRROR `packages/coretex/src/eval/bmu-task.ts` on the
 * P3 branch (coretex-bmu-v1, commit d7b0569). Single-sourcing them from the
 * built package is a P7 merge item; until the branches merge, the unit tests
 * pin these values so drift fails loudly.
 */
import { createHash } from 'node:crypto';

// ─── Inherited verbatim (evolve-corpus.mjs:20-22) ────────────────────────────
const h = (s) => createHash('sha256').update(s).digest();
export const unit = (s) => h(s).readUInt32BE(0) / 4294967296; // deterministic [0,1)
export function prng(seedStr) { let st = h(seedStr).readUInt32BE(0); return () => { st = (Math.imul(st ^ (st >>> 15), 0x2c1b3c6d) + 1) >>> 0; return st / 4294967296; }; }

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);
}

// ─── BMU pins (mirror of bmu-task.ts on coretex-bmu-v1; spec §4.1/§4.2/§5.6) ─
export const BMU_FAMILIES = Object.freeze([
  'temporal',
  'conflict_lifecycle',
  'multi_hop_relation',
  'near_collision_abstention',
]);
export const BMU_DEFAULT_BUDGET_B = Object.freeze({
  temporal: 3,
  conflict_lifecycle: 4,
  multi_hop_relation: 4,
  near_collision_abstention: 3,
});
export const BMU_TASK_MAX_BUDGET = 8;
/** §6.7b arm-gate minima (cluster-rounded E_f_min). */
export const BMU_E_F_MIN = Object.freeze({
  temporal: 80,
  conflict_lifecycle: 110,
  multi_hop_relation: 110,
  near_collision_abstention: 80,
});
/** Cluster size law (§4.1 / §6.7b): k rows per cluster, exactly. */
export const BMU_CLUSTER_SIZE_K = 5;

// ─── Attribute rotation (DELTA 1 + DELTA 2 over temporalAttributeForEpochSlot)
/**
 * Deterministic window-unique attribute for (epoch, clusterSlot) inside one
 * BMU family's namespace. `stridePerEpoch` MUST be >= the max clusters any
 * epoch will mint for the family (index = (epoch-base)*stride + slot is then
 * unique per (epoch, slot); (cycle, residue) recovers index uniquely, so the
 * attribute STRING — grid[residue] + series suffix — never repeats, ever).
 */
export function bmuAttributeForClusterSlot(epoch, clusterSlot, {
  qualifiers, bases, baseEpoch, stridePerEpoch = 32,
}) {
  if (!Number.isInteger(epoch) || !Number.isInteger(clusterSlot) || clusterSlot < 0) {
    throw new Error('bmuAttributeForClusterSlot: integer epoch and clusterSlot >= 0 required');
  }
  if (clusterSlot >= stridePerEpoch) {
    throw new Error(`bmuAttributeForClusterSlot: clusterSlot ${clusterSlot} >= stridePerEpoch ${stridePerEpoch} (uniqueness law would break)`);
  }
  const grid = [];
  for (const qualifier of qualifiers) for (const [base, bank] of bases) grid.push([`${qualifier} ${base}`, bank]);
  const index = (epoch - baseEpoch) * stridePerEpoch + clusterSlot;
  if (index < 0) throw new Error(`bmuAttributeForClusterSlot: epoch ${epoch} precedes baseEpoch ${baseEpoch}`);
  const cycle = Math.floor(index / grid.length);
  const [attr, bank] = grid[index % grid.length];
  return { attr: cycle > 0 ? `${attr} (series ${cycle + 1})` : attr, bank };
}

// ─── eval_hidden id salt-search (DELTA 3: fail-closed) ──────────────────────
/**
 * Find a logical query id landing in eval_hidden under the CANONICAL injected
 * splitOf. Throws on probe exhaustion (never emits a partial cluster).
 */
export function evalHiddenQueryId({ idBase, stubIndex, epoch, splitOf, maxProbes = 96 }) {
  for (let probe = 0; probe < maxProbes; probe++) {
    const candidate = `q_${idBase}_v${stubIndex}_s${probe}`;
    if (splitOf(candidate, epoch) === 'eval_hidden') return candidate;
  }
  throw new Error(`evalHiddenQueryId: exhausted ${maxProbes} probes for q_${idBase}_v${stubIndex} (fail-closed: no partial clusters under the k=${BMU_CLUSTER_SIZE_K} law)`);
}

/**
 * Canonical splitOf builder for callers that hold the built package (tests,
 * sample-emission harnesses, the epoch runner). Mirrors the epoch runner's
 * wiring (scripts/coretex-epoch-evolve.mjs:583-587): the split is computed
 * over the PRODUCTION event id (live-tail `zz_e<epoch>_q_<logicalId>`) at the
 * previous corpus's corpusEpoch.
 */
export function makeCanonicalSplitOf({ splitForRecord, liveTailQueryId, corpusEpoch }) {
  if (typeof splitForRecord !== 'function' || typeof liveTailQueryId !== 'function') {
    throw new Error('makeCanonicalSplitOf: canonical splitForRecord + liveTailQueryId required');
  }
  if (!Number.isInteger(corpusEpoch) || corpusEpoch < 0) throw new Error('makeCanonicalSplitOf: corpusEpoch must be a non-negative integer');
  return (logicalQueryId, liveUpdateEpoch) => splitForRecord(
    liveUpdateEpoch !== undefined && liveUpdateEpoch !== null ? liveTailQueryId(logicalQueryId, liveUpdateEpoch) : logicalQueryId,
    corpusEpoch,
  );
}

// ─── GLOBAL m=1 registry (§4.1 multiplicity mint law) ────────────────────────
/**
 * Mint-side view of the GLOBAL m=1 census: a subjectEntityId and a templateId
 * each live in AT MOST ONE ACTIVE cluster ACROSS ALL FAMILIES within the
 * maxAge window. Generators consult the registry before minting a cluster and
 * register what they minted; the caller persists it across epochs and drops
 * entries when their cluster RETIRES (attribute/subject reuse WAITS for
 * retirement — spec §14.2). The arm-gate census (§6.7b) re-checks globally.
 */
export function createM1Registry(initial = {}) {
  const subjects = new Set(initial.subjectEntityIds ?? []);
  const templates = new Set(initial.templateIds ?? []);
  return {
    hasSubject: (id) => subjects.has(id),
    hasTemplate: (id) => templates.has(id),
    /** Atomically claim a cluster's subject + template ids; throws on any collision (fail-closed mint). */
    claimCluster({ subjectEntityId, templateIds, motifGroupId }) {
      if (subjects.has(subjectEntityId)) {
        throw new Error(`m=1 violation: subject '${subjectEntityId}' already in an active cluster (minting ${motifGroupId})`);
      }
      for (const t of templateIds) {
        if (templates.has(t)) throw new Error(`m=1 violation: templateId '${t}' already in an active cluster (minting ${motifGroupId})`);
      }
      subjects.add(subjectEntityId);
      for (const t of templateIds) templates.add(t);
    },
    /** Retirement hook: release a cluster's keys (subject/attribute reuse may resume). */
    releaseCluster({ subjectEntityId, templateIds }) {
      subjects.delete(subjectEntityId);
      for (const t of templateIds) templates.delete(t);
    },
    snapshot: () => ({ subjectEntityIds: [...subjects].sort(), templateIds: [...templates].sort() }),
  };
}

/**
 * Offline census over emitted rows (unit tests + sample-bank manifest): every
 * subjectEntityId and templateId appears in at most one motifGroup, globally.
 * Returns error strings (empty = clean).
 */
export function m1CensusOverRows(rows) {
  const errors = [];
  const motifBySubject = new Map();
  const motifByTemplate = new Map();
  for (const row of rows) {
    const t = row.bmuTask;
    if (!t) { errors.push(`${row.id}: missing bmuTask`); continue; }
    const subj = row.subjectEntityId;
    const priorS = motifBySubject.get(subj);
    if (priorS && priorS !== t.motifGroupId) errors.push(`subject '${subj}' spans motifGroups '${priorS}' and '${t.motifGroupId}'`);
    else motifBySubject.set(subj, t.motifGroupId);
    const priorT = motifByTemplate.get(t.templateId);
    if (priorT && priorT !== t.motifGroupId) errors.push(`templateId '${t.templateId}' spans motifGroups '${priorT}' and '${t.motifGroupId}'`);
    else motifByTemplate.set(t.templateId, t.motifGroupId);
  }
  return errors;
}

// ─── No-answer-leak lint (Qwen-cold-answerability screen, mint-time) ────────
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'was', 'are', 'were', 'be', 'been', 'to', 'of', 'for',
  'on', 'in', 'at', 'as', 'and', 'or', 'by', 'with', 'per', 'after', 'still',
  'what', 'which', 'who', 'how', 'now', 'current', 'currently', 'record',
  'recorded', 'records', 'entry', 'note', 's', 'should', 'apply', 'applies',
]);
export function lintTokens(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9.-]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t)));
}

/**
 * Mint-time no-leak lint for one row (spec §14.2: hardness certification
 * replaces wording tuning, but a question that CONTAINS its answer or
 * gold-only vocabulary is structurally headroom-free and must never mint):
 *   (1) no token of the answer value appears in the question;
 *   (2) no question token is GOLD-ONLY (present in some required doc, absent
 *       from every forbidden doc) — cold lexical match must not prefer gold;
 *   (3) trap lexical dominance: the primary trap doc's token overlap with the
 *       question is >= the answer doc's overlap (the trap "out-ranks
 *       honestly", spec §2.2 / evolve-corpus.mjs:120-123 stale-trap pattern).
 * Returns error strings (empty = clean).
 */
export function lintNoAnswerLeak({ rowId, queryText, answerValue, requiredDocTexts, forbiddenDocTexts, primaryTrapText, answerDocText }) {
  const errors = [];
  const q = lintTokens(queryText);
  if (answerValue) {
    for (const tok of lintTokens(answerValue)) {
      if (q.has(tok)) errors.push(`${rowId}: answer token '${tok}' leaks into the question text`);
    }
  }
  const forbidden = new Set();
  for (const t of forbiddenDocTexts) for (const tok of lintTokens(t)) forbidden.add(tok);
  const goldOnly = new Set();
  for (const t of requiredDocTexts) for (const tok of lintTokens(t)) if (!forbidden.has(tok)) goldOnly.add(tok);
  for (const tok of q) {
    if (goldOnly.has(tok)) errors.push(`${rowId}: question token '${tok}' is gold-only vocabulary (cold lexical shortcut)`);
  }
  if (primaryTrapText !== undefined && answerDocText !== undefined) {
    const trap = lintTokens(primaryTrapText);
    const gold = lintTokens(answerDocText);
    let trapOverlap = 0; let goldOverlap = 0;
    for (const tok of q) { if (trap.has(tok)) trapOverlap++; if (gold.has(tok)) goldOverlap++; }
    if (trapOverlap < goldOverlap) {
      errors.push(`${rowId}: trap lexical overlap ${trapOverlap} < gold overlap ${goldOverlap} (trap must out-rank honestly)`);
    }
  }
  return errors;
}
