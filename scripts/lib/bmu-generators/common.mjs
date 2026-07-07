/**
 * BMU v1 offline-generator shared helpers (BMU_SPEC.md §4.1, §6.3, frozen rev3.2 ad7e523).
 *
 * Scope law for this directory: P2 lane additions live ONLY under
 * scripts/lib/bmu-generators/ (+ their unit tests) so the four family lanes
 * never collide. Family generators (temporal.mjs, …) import from here.
 *
 * INHERITANCE (invariant I10 — deltas cited per module): `prng`/`unit` and the
 * epoch date derivation are verbatim ports from the proven ancestor generator
 * `scripts/lib/evolve-corpus.mjs` (:20-22, :376-377). The active-index helpers
 * are NEW machinery required by the rev3.2 GLOBAL m=1 multiplicity mint law
 * (§4.1): a subjectEntityId and a templateId each appear in AT MOST ONE ACTIVE
 * cluster GLOBALLY (all families) within the maxAge(32)-epoch window.
 *
 * HONESTY NOTE on the active window: in production the active window is the
 * FRONTIER's active set (A2 bounded oldest-first drain + arm-time census —
 * §6.5/§6.7); callers MUST build the index from real frontier state at mint
 * time. `retireAgedClusters` is an OFFLINE age-window model for sample banks
 * and tests only — it is not the production retirement mechanism.
 */
import { createHash } from 'node:crypto';

// ── Deterministic randomness (port of evolve-corpus.mjs:20-22) ──────────────
const h = (s) => createHash('sha256').update(s).digest();
export const unit = (s) => h(s).readUInt32BE(0) / 4294967296; // deterministic [0,1)
export function prng(seedStr) {
  let st = h(seedStr).readUInt32BE(0);
  return () => {
    st = (Math.imul(st ^ (st >>> 15), 0x2c1b3c6d) + 1) >>> 0;
    return st / 4294967296;
  };
}

// ── Epoch dates (port of evolve-corpus.mjs:376-377) ─────────────────────────
export function datesForEpoch(epoch) {
  const tsDate = new Date(new Date('2024-01-01').getTime() + (40 + epoch) * 30 * 86400000)
    .toISOString().slice(0, 10);
  const priorDate = new Date(new Date(tsDate).getTime() - 86400000).toISOString().slice(0, 10);
  return { tsDate, priorDate };
}

// ── GLOBAL m=1 active-cluster index (§4.1 multiplicity mint law) ─────────────
/**
 * Index of ACTIVE clusters keyed by the three §6.3 exclusion-key namespaces.
 * One index instance spans ALL families (the law is GLOBAL).
 */
export function createBmuActiveIndex() {
  return {
    clusters: new Map(),   // motifGroupId -> { motifGroupId, family, subjectEntityId, templateIds, mintEpoch }
    subjects: new Map(),   // subjectEntityId -> motifGroupId
    templates: new Map(),  // templateId -> motifGroupId
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

/** Fail-closed registration: throws on ANY m=1 collision (defense in depth —
 *  generators must have already skipped colliding subjects/templates). */
export function registerCluster(index, { motifGroupId, family, subjectEntityId, templateIds, mintEpoch }) {
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
  index.clusters.set(motifGroupId, { motifGroupId, family, subjectEntityId, templateIds: [...templateIds], mintEpoch });
  index.subjects.set(subjectEntityId, motifGroupId);
  for (const t of templateIds) index.templates.set(t, motifGroupId);
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
  }
  return retired;
}

/** GLOBAL m=1 census over the index (arm-gate-census shape, §4.1/§6.7):
 *  returns violation strings (empty = law holds). */
export function m1Census(index) {
  const violations = [];
  const bySubject = new Map();
  const byTemplate = new Map();
  for (const c of index.clusters.values()) {
    const subj = bySubject.get(c.subjectEntityId) ?? [];
    subj.push(c.motifGroupId);
    bySubject.set(c.subjectEntityId, subj);
    for (const t of c.templateIds) {
      const arr = byTemplate.get(t) ?? [];
      arr.push(c.motifGroupId);
      byTemplate.set(t, arr);
    }
  }
  for (const [s, mgs] of bySubject) if (mgs.length > 1) violations.push(`subject '${s}' in ${mgs.length} active clusters: ${mgs.join(',')}`);
  for (const [t, mgs] of byTemplate) if (mgs.length > 1) violations.push(`template '${t}' in ${mgs.length} active clusters: ${mgs.join(',')}`);
  return violations;
}

// ── Canonical eval_hidden id salt-search (ancestor: evolve-corpus.mjs:685-737)
/**
 * The canonical split is an id hash (`splitForRecord` over the PRODUCTION
 * event id — injected as `splitOf` so generators stay pure, exactly like the
 * evolve wiring at scripts/coretex-epoch-evolve.mjs:583). The only honest way
 * to guarantee eval_hidden supply is to mint ids until one lands (~15%).
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

// ── No-answer-leak lint helpers (P2 certification pre-screen) ────────────────
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'what', 'which', 'who', 'when', 'where', 'why', 'how', 'should', 'still', 'for', 'of', 'to',
  'in', 'on', 'at', 'as', 'and', 'or', 'not', 'no', 'now', 'this', 'that', 'it', 'its', 's',
]);

export function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

export function contentTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
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
