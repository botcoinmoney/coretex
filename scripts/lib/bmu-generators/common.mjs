/**
 * BMU P2 generator shared helpers (BMU_SPEC.md rev3.2, commit ad7e523).
 *
 * CONSOLIDATION NOTE (P2 merge): this file is the semantic union of the two
 * lane variants that grew independently on coretex-bmu-p2-{temporal,multihop}
 * (active-index + skeleton-ngram lint toolkit) and on
 * coretex-bmu-p2-{conflict,nearcol} (BMU pins + attribute rotation + m=1
 * registry + no-leak lint). Export sets were disjoint apart from the verbatim
 * `unit`/`prng` ports; both lint toolkits are kept (they screen different
 * leak modes) with their stopword sets scoped per toolkit.
 *
 * ANCESTRY (I10): every mechanism here DESCENDS from
 * `scripts/lib/evolve-corpus.mjs` (the Stage 3-G1 typed-cluster minter) —
 * inherited byte-for-byte where possible, with each delta named:
 *   - sha256 `unit`/`prng` helpers: inherited verbatim (evolve-corpus.mjs:20-22).
 *   - epoch date derivation `datesForEpoch`: verbatim port (evolve-corpus.mjs:376-377).
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
 *
 * HONESTY NOTE on the active window: in production the active window is the
 * FRONTIER's active set (A2 bounded oldest-first drain + arm-time census —
 * §6.5/§6.7); callers MUST build the index from real frontier state at mint
 * time. `retireAgedClusters` is an OFFLINE age-window model for sample banks
 * and tests only — it is not the production retirement mechanism.
 */
import { createHash } from 'node:crypto';

// ─── Inherited verbatim (evolve-corpus.mjs:20-22) ────────────────────────────
const h = (s) => createHash('sha256').update(s).digest();
export const unit = (s) => h(s).readUInt32BE(0) / 4294967296; // deterministic [0,1)
export function prng(seedStr) {
  let st = h(seedStr).readUInt32BE(0);
  return () => {
    st = (Math.imul(st ^ (st >>> 15), 0x2c1b3c6d) + 1) >>> 0;
    return st / 4294967296;
  };
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);
}

// ─── Opaque BMU identities (audit hardening F3/F8) ─────────────────────────

/**
 * Deterministic document id for a BMU-generated document.  The serialized id
 * intentionally carries no family, cluster, subject, answer/trap role, or
 * ordinal suffix: those fields made the old ids a proposer-visible role
 * oracle.  `slot` remains an INTERNAL generator discriminator and is only
 * committed through SHA-256.
 */
export function opaqueBmuDocId({ seed, epoch, motifGroupId, slot }) {
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('opaqueBmuDocId: non-empty seed required');
  if (!Number.isInteger(epoch) || epoch < 0) throw new Error('opaqueBmuDocId: non-negative integer epoch required');
  if (typeof motifGroupId !== 'string' || motifGroupId.length === 0) throw new Error('opaqueBmuDocId: non-empty motifGroupId required');
  if (typeof slot !== 'string' || slot.length === 0) throw new Error('opaqueBmuDocId: non-empty internal slot required');
  const digest = createHash('sha256')
    .update('coretex-bmu-doc-id-v1\0')
    .update(seed).update('\0')
    .update(String(epoch)).update('\0')
    .update(motifGroupId).update('\0')
    .update(slot)
    .digest('hex');
  return `d_bmu_${digest}`;
}

function normalizeBmuEntityAlias(value) {
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Hidden identity keys used only by the BMU gate→confirm partition law.
 * The canonical subject id plus every canonical name/alias are included, but
 * broad document `entityIds` (owner/universe ids included) are deliberately
 * excluded so one shared owner cannot wipe out the confirm pool.
 */
export function bmuEntityHoldoutKeysForSubject(subject) {
  if (!subject || typeof subject.id !== 'string' || subject.id.length === 0) {
    throw new Error('bmuEntityHoldoutKeysForSubject: subject.id required');
  }
  const CONTROL = /[\u0000-\u001f\u007f]/;
  if (CONTROL.test(subject.id)) throw new Error('bmuEntityHoldoutKeysForSubject: subject.id must not contain control characters');
  const out = new Set([`id:${subject.id}`]);
  const aliases = [subject.canonicalName, ...(Array.isArray(subject.aliases) ? subject.aliases : [])];
  for (const alias of aliases) {
    if (typeof alias !== 'string') throw new Error('bmuEntityHoldoutKeysForSubject: aliases must be strings');
    const normalized = normalizeBmuEntityAlias(alias);
    if (normalized.length === 0) continue;
    if (CONTROL.test(normalized)) throw new Error('bmuEntityHoldoutKeysForSubject: aliases must not contain control characters');
    out.add(`alias:${normalized}`);
  }
  if (out.size > 32) throw new Error(`bmuEntityHoldoutKeysForSubject: ${out.size} keys exceeds cap 32`);
  return [...out].sort();
}

// ── Epoch dates (port of evolve-corpus.mjs:376-377) ─────────────────────────
export function datesForEpoch(epoch) {
  const tsDate = new Date(new Date('2024-01-01').getTime() + (40 + epoch) * 30 * 86400000)
    .toISOString().slice(0, 10);
  const priorDate = new Date(new Date(tsDate).getTime() - 86400000).toISOString().slice(0, 10);
  return { tsDate, priorDate };
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
 * Same salt-search, temporal/multihop lane spelling (slot-keyed, 192 probes).
 * DELTA vs ancestor (I10): the ancestor `continue`d on probe exhaustion,
 * allowing PARTIAL clusters; BMU cluster size k=5 is law, so exhaustion here
 * THROWS (fail-closed). P(miss) per row at 192 probes ≈ 0.85^192 ≈ 3e-14.
 */
export function searchEvalHiddenId({ idBase, slot, splitOf, epoch, maxProbes = 192 }) {
  for (let probe = 0; probe < maxProbes; probe++) {
    const candidate = `q_${idBase}_v${slot}_s${probe}`;
    if (splitOf(candidate, epoch) === 'eval_hidden') return candidate;
  }
  throw new Error(`bmu generator: no eval_hidden id found for '${idBase}' slot ${slot} in ${maxProbes} probes (splitOf misconfigured?)`);
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
/** Shared alias-identity authority for all generator APIs. */
export function createEntityHoldoutIdentityStore(initial = {}) {
  return new Map(Object.entries(initial));
}

export function createM1Registry(initial = {}, identityStore = createEntityHoldoutIdentityStore()) {
  const subjects = new Set(initial.subjectEntityIds ?? []);
  const templates = new Set(initial.templateIds ?? []);
  const identities = identityStore;
  for (const key of initial.entityHoldoutKeys ?? []) {
    if (!identities.has(key)) identities.set(key, 'historical');
  }
  return {
    hasSubject: (id) => subjects.has(id),
    hasTemplate: (id) => templates.has(id),
    hasEntityHoldoutKey: (key) => identities.has(key),
    /** Atomically claim a cluster's subject + template ids; throws on any collision (fail-closed mint). */
    claimCluster({ subjectEntityId, templateIds, entityHoldoutKeys = [], motifGroupId }) {
      if (subjects.has(subjectEntityId)) {
        throw new Error(`m=1 violation: subject '${subjectEntityId}' already in an active cluster (minting ${motifGroupId})`);
      }
      for (const t of templateIds) {
        if (templates.has(t)) throw new Error(`m=1 violation: templateId '${t}' already in an active cluster (minting ${motifGroupId})`);
      }
      for (const key of entityHoldoutKeys) {
        if (identities.has(key)) throw new Error(`m=1 violation: entityHoldoutKey '${key}' already in an active cluster (minting ${motifGroupId})`);
      }
      subjects.add(subjectEntityId);
      for (const t of templateIds) templates.add(t);
      for (const key of entityHoldoutKeys) identities.set(key, motifGroupId);
    },
    /** Retirement hook: release a cluster's keys (subject/attribute reuse may resume). */
    releaseCluster({ subjectEntityId, templateIds, entityHoldoutKeys = [], motifGroupId }) {
      subjects.delete(subjectEntityId);
      for (const t of templateIds) templates.delete(t);
      for (const key of entityHoldoutKeys) {
        if (identities.get(key) === motifGroupId) identities.delete(key);
      }
    },
    snapshot: () => ({
      subjectEntityIds: [...subjects].sort(),
      templateIds: [...templates].sort(),
      entityHoldoutKeys: [...identities.keys()].sort(),
    }),
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
  const motifByIdentity = new Map();
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
    for (const key of t.entityHoldoutKeys ?? []) {
      const priorI = motifByIdentity.get(key);
      if (priorI && priorI !== t.motifGroupId) errors.push(`entityHoldoutKey '${key}' spans motifGroups '${priorI}' and '${t.motifGroupId}'`);
      else motifByIdentity.set(key, t.motifGroupId);
    }
  }
  return errors;
}

// ── GLOBAL m=1 active-cluster index (§4.1 multiplicity mint law) ─────────────
/**
 * Index of ACTIVE clusters keyed by the three §6.3 exclusion-key namespaces.
 * One index instance spans ALL families (the law is GLOBAL).
 */
export function createBmuActiveIndex(identityStore = createEntityHoldoutIdentityStore()) {
  return {
    clusters: new Map(),   // motifGroupId -> { motifGroupId, family, subjectEntityId, templateIds, entityHoldoutKeys, mintEpoch }
    subjects: new Map(),   // subjectEntityId -> motifGroupId
    templates: new Map(),  // templateId -> motifGroupId
    identities: identityStore, // entityHoldoutKey -> motifGroupId; share across all family generators
  };
}

export function indexHasSubject(index, subjectEntityId) {
  return index.subjects.has(subjectEntityId);
}
export function indexHasTemplate(index, templateId) {
  return index.templates.has(templateId);
}
export function indexHasMotifGroup(index, motifGroupId) {
  return index.clusters.has(motifGroupId);
}
export function indexHasEntityHoldoutKey(index, key) {
  return index.identities.has(key);
}

/** Fail-closed registration: throws on ANY m=1 collision (defense in depth —
 *  generators must have already skipped colliding subjects/templates). */
export function registerCluster(index, { motifGroupId, family, subjectEntityId, templateIds, entityHoldoutKeys = [], mintEpoch }) {
  if (index.clusters.has(motifGroupId)) {
    throw new Error(`bmu m=1 violation: motifGroupId '${motifGroupId}' already active`);
  }
  if (index.subjects.has(subjectEntityId)) {
    throw new Error(`bmu m=1 violation: subject '${subjectEntityId}' already in active cluster '${index.subjects.get(subjectEntityId)}'`);
  }
  for (const t of templateIds) {
    if (index.templates.has(t)) {
      throw new Error(`bmu m=1 violation: templateId '${t}' already in active cluster '${index.templates.get(t)}'`);
    }
  }
  for (const key of entityHoldoutKeys) {
    if (index.identities.has(key)) {
      throw new Error(`bmu m=1 violation: entityHoldoutKey '${key}' already in active cluster '${index.identities.get(key)}'`);
    }
  }
  index.clusters.set(motifGroupId, { motifGroupId, family, subjectEntityId, templateIds: [...templateIds], entityHoldoutKeys: [...entityHoldoutKeys], mintEpoch });
  index.subjects.set(subjectEntityId, motifGroupId);
  for (const t of templateIds) index.templates.set(t, motifGroupId);
  for (const key of entityHoldoutKeys) index.identities.set(key, motifGroupId);
}

/** OFFLINE age-window retirement model (see module honesty note). Removes
 *  clusters with epoch - mintEpoch >= maxAge. Returns retired motifGroupIds. */
export function retireAgedClusters(index, epoch, maxAge = 32) {
  const retired = [];
  for (const [mg, c] of index.clusters) {
    if (epoch - c.mintEpoch >= maxAge) retired.push(mg);
  }
  for (const mg of retired) {
    const c = index.clusters.get(mg);
    index.clusters.delete(mg);
    if (index.subjects.get(c.subjectEntityId) === mg) index.subjects.delete(c.subjectEntityId);
    for (const t of c.templateIds) {
      if (index.templates.get(t) === mg) index.templates.delete(t);
    }
    for (const key of c.entityHoldoutKeys ?? []) {
      if (index.identities.get(key) === mg) index.identities.delete(key);
    }
  }
  return retired;
}

/** GLOBAL m=1 census over the index (arm-gate-census shape, §4.1/§6.7):
 *  returns violation strings (empty = law holds). */
export function m1Census(index) {
  const violations = [];
  const bySubject = new Map();
  const byTemplate = new Map();
  const byIdentity = new Map();
  for (const c of index.clusters.values()) {
    const subj = bySubject.get(c.subjectEntityId) ?? [];
    subj.push(c.motifGroupId);
    bySubject.set(c.subjectEntityId, subj);
    for (const t of c.templateIds) {
      const arr = byTemplate.get(t) ?? [];
      arr.push(c.motifGroupId);
      byTemplate.set(t, arr);
    }
    for (const key of c.entityHoldoutKeys ?? []) {
      const arr = byIdentity.get(key) ?? [];
      arr.push(c.motifGroupId);
      byIdentity.set(key, arr);
    }
  }
  for (const [s, mgs] of bySubject) if (mgs.length > 1) violations.push(`subject '${s}' in ${mgs.length} active clusters: ${mgs.join(',')}`);
  for (const [t, mgs] of byTemplate) if (mgs.length > 1) violations.push(`template '${t}' in ${mgs.length} active clusters: ${mgs.join(',')}`);
  for (const [key, mgs] of byIdentity) if (mgs.length > 1) violations.push(`entityHoldoutKey '${key}' in ${mgs.length} active clusters: ${mgs.join(',')}`);
  return violations;
}

// ─── No-answer-leak lint (Qwen-cold-answerability screen, mint-time) ────────
const LINT_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'was', 'are', 'were', 'be', 'been', 'to', 'of', 'for',
  'on', 'in', 'at', 'as', 'and', 'or', 'by', 'with', 'per', 'after', 'still',
  'what', 'which', 'who', 'how', 'now', 'current', 'currently', 'record',
  'recorded', 'records', 'entry', 'note', 's', 'should', 'apply', 'applies',
]);
export function lintTokens(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9.-]+/).filter((t) => t.length > 1 && !LINT_STOPWORDS.has(t)));
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

// ── Skeleton-ngram lint toolkit (temporal/multihop certification pre-screen) ─
const CONTENT_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'what', 'which', 'who', 'when', 'where', 'why', 'how', 'should', 'still', 'for', 'of', 'to',
  'in', 'on', 'at', 'as', 'and', 'or', 'not', 'no', 'now', 'this', 'that', 'it', 'its', 's',
]);

export function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

export function contentTokens(text) {
  return tokenize(text).filter((t) => !CONTENT_STOPWORDS.has(t));
}

/**
 * Collapse every slot value (subject canonical name, attribute, values, …) to
 * a single marker token so n-gram overlap measures SHARED PHRASING, not shared
 * slot fills (slot fills appear in gold AND trap docs alike, so they are not
 * discriminative and must not trip the lint — e.g. a two-word attribute plus a
 * value forms a 4-token run in both a question and its gold doc by design).
 */
export function collapseSlots(text, slotValues) {
  let out = String(text).toLowerCase();
  const sorted = [...slotValues].filter(Boolean).map(String).sort((a, b) => b.length - a.length);
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i].toLowerCase();
    while (out.includes(v)) out = out.replace(v, ` slotval${i} `);
  }
  return out;
}

export function wordNgrams(text, n) {
  const toks = tokenize(text);
  const grams = new Set();
  for (let i = 0; i + n <= toks.length; i++) grams.add(toks.slice(i, i + n).join(' '));
  return grams;
}

/** Shared word n-grams between two texts AFTER slot collapse. */
export function sharedSkeletonNgrams(a, b, slotValues, n = 4) {
  const ga = wordNgrams(collapseSlots(a, slotValues), n);
  const gb = wordNgrams(collapseSlots(b, slotValues), n);
  const shared = [];
  for (const g of ga) if (gb.has(g)) shared.push(g);
  return shared;
}

/** True iff `value` appears as a token (or multi-token run) in `text`. */
export function containsValue(text, value) {
  const vToks = tokenize(value);
  if (vToks.length === 0) return false;
  const toks = tokenize(text);
  outer: for (let i = 0; i + vToks.length <= toks.length; i++) {
    for (let j = 0; j < vToks.length; j++) {
      if (toks[i + j] !== vToks[j]) continue outer;
    }
    return true;
  }
  return false;
}
