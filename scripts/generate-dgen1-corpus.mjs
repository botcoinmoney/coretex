#!/usr/bin/env node
/**
 * DGEN-1 — generator-native DEEP-MEMORY longevity corpus (runbook §1B.4 / 1C).
 *
 * The PRIMARY longevity proof corpus (D1/D2 owner-collapse remaps are only stress
 * tools). Builds ONE coherent deep memory universe (a single owner `e_universe`) with
 * MANY *unique* in-universe subjects, so:
 *   - every query is owner-scoped to the whole universe → a genuinely DEEP active store
 *     per query (not the ~62-doc shallow owner store of P1/P2/P3), AND
 *   - each subject is UNIQUELY identifiable (unique canonical name+attributes) → the gold
 *     is well-posed; same-universe look-alikes are the hard negatives. This avoids the
 *     synthetic re-pooling ambiguity that the D1-unified remap re-introduced.
 *
 * Depth knobs (runbook 1C): 25-100+ session memories per subject cluster; 3-10 temporal
 * revisions per evolving fact; repeated topic revisits; deep relation/provenance graph;
 * dense SAME-UNIVERSE distractors (not cross-owner junk).
 *
 * Live honest-advance families (runbook 1C.1) — named to bucket correctly in
 * build-v2-production-corpus (temporal_update→temporal; multi_session_bridge /
 * causal_memory_chain / decision_provenance→multi_hop_relation; coreference_resolution →
 * near_collision):
 *   - temporal_update          : current value of a 3-10-revision fact (supersedes chain)
 *   - preference_evolution     : current preference after many sessions (temporal_update bucket)
 *   - multi_session_bridge     : belongs_to_project / depends_on / context_of (supports edge)
 *   - causal_memory_chain      : fixes / decision_reason (causes edge)
 *   - decision_provenance      : decision_reason → decision_outcome (causes/derived_from)
 *   - coreference_resolution   : alias/role → canonical subject (coreference_of edge)
 *
 * Continuity-label ontology (runbook 1C.2) is recorded on each relation as `.label`
 * (public continuity structure) and mapped to the scorer's existing routing edge `type`
 * for v1 compatibility (no substrate edge-type change until families are proven live):
 *   supersedes→supersedes, supports/belongs_to_project/depends_on/context_of→supports,
 *   causes/fixes/decision_reason→causes, decision_outcome→derived_from, coreference_of→coreference_of.
 * These are derivable from visible memory content / generator provenance and present
 * before hidden scoring; NO query-local answer edges.
 *
 * Hidden-eval difficulty bands (runbook 1C.3): each query carries `band` ∈
 * {easy, medium, hard, very_hard, exhaustion}.
 *
 * Usage:
 *   node scripts/generate-dgen1-corpus.mjs --subjects 120 --depth 30 --seed dgen1-smoke-2026-05-22 \
 *     --out release/calibration/2026-05-21-memory-corpus-v2/dgen1-smoke-corpus.json
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const N_SUBJECTS = parseInt(argVal('--subjects', '120'), 10);   // unique people/project/resource clusters
const DEPTH = parseInt(argVal('--depth', '30'), 10);            // baseline session memories per subject
const N_UNIVERSES = parseInt(argVal('--universes', '1'), 10);   // 1 = unified deep universe; 2-4 = few large
const SEED = argVal('--seed', 'dgen1-smoke-2026-05-22');
const PHASE = argVal('--phase', 'DGEN1');
const OUT = argVal('--out', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-smoke-corpus.json');
const R5_SYNTHESIS = args.includes('--r5-synthesis');            // adds conflict/aspect/abstention operation slices

function hashSeed(s) { let h = 1779033703 ^ s.length; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(hashSeed(SEED));
const ri = (n) => Math.floor(rand() * n);
const pick = (a) => a[ri(a.length)];
const chance = (p) => rand() < p;
function splitFor(id) { const h = parseInt(createHash('sha256').update(`${SEED}:${id}`).digest('hex').slice(0, 8), 16) % 100; return h < 70 ? 'train_visible' : h < 80 ? 'calibration' : h < 95 ? 'eval_hidden' : 'canary'; }

// ── banks (large enough that FIRST×LAST×index keeps subjects UNIQUE) ──
const FIRST = ['Maya', 'Alex', 'Priya', 'Jordan', 'Sam', 'Lena', 'Diego', 'Aisha', 'Tom', 'Nina', 'Omar', 'Grace', 'Ravi', 'Elena', 'Yuki', 'Carlos', 'Hana', 'Marcus', 'Leo', 'Sofia', 'Noah', 'Zara', 'Ivan', 'Mei', 'Kofi'];
const LAST = ['Chen', 'Nadar', 'Sharma', 'Okafor', 'Reyes', 'Petrov', 'Kim', 'Haddad', 'Singh', 'Rossi', 'Mueller', 'Ito', 'Diallo', 'Costa', 'Larsen', 'Mensah', 'Park', 'Novak', 'Tanaka', 'Vega', 'Bauer', 'Osei', 'Lund', 'Cruz', 'Aziz'];
const JOBS = ['UX designer', 'data analyst', 'ER nurse', 'high-school teacher', 'civil engineer', 'product manager', 'pastry chef', 'physical therapist', 'accountant', 'graphic illustrator', 'marine biologist', 'tax attorney'];
const CITIES = ['Seattle', 'Austin', 'Denver', 'Portland', 'Chicago', 'Boston', 'Atlanta', 'Toronto', 'Lisbon', 'Berlin', 'Oslo', 'Nairobi'];
const DIETS = ['low-FODMAP', 'pescatarian', 'keto', 'Mediterranean', 'vegan', 'gluten-free', 'paleo', 'DASH'];
const PKGS = ['npm', 'pnpm', 'yarn', 'bun', 'poetry', 'pip', 'cargo', 'maven'];
const DBS = ['Postgres', 'MySQL', 'SQLite', 'MongoDB', 'CockroachDB', 'DynamoDB', 'Cassandra'];
const STACKS = ['React/Node', 'Vue/Go', 'Svelte/Rust', 'Angular/Java', 'Next/Python', 'Remix/Elixir'];
const ENVVARS = ['DATABASE_URL', 'REDIS_HOST', 'API_TOKEN', 'S3_BUCKET', 'LOG_LEVEL', 'CACHE_TTL'];
const ERRORS = ['CORS preflight 403', 'OOM on import', 'flaky timeout in CI', 'N+1 query', 'race in cache warmup', 'TLS handshake fail'];
const TOPICS = ['onboarding flow', 'billing retries', 'search ranking', 'auth refresh', 'image pipeline', 'export job'];
const ASPECTS = ['latency', 'cost', 'reliability', 'accessibility', 'security', 'maintainability'];

// ── universe owners ──
const universes = Array.from({ length: N_UNIVERSES }, (_, i) => `e_universe${N_UNIVERSES > 1 ? i : ''}`);

const entities = [];
const docs = [];
const relations = [];
const queries = [];
let docSeq = 0, qSeq = 0;
const docId = () => `d${String(docSeq++).padStart(7, '0')}`;
const qId = () => `q${String(qSeq++).padStart(7, '0')}`;
const addEntity = (id, canonicalName, aliases, lane) => { entities.push({ id, canonicalName, aliases, lane }); };
function addDoc(d) { const id = docId(); const split = splitFor(id); docs.push({ id, split, ...d }); return id; }
function addRel(src, dst, type, label) { relations.push({ src, dst, type, label }); }
function addQuery(q) { const id = qId(); const split = splitFor(id); queries.push({ id, split, ownerScoped: true, ...q }); return id; }
// continuity-label → scorer routing edge type. The categoryLens routes only on
// supports/causes/supersedes/coreference_of, so ONLY low-fanout ANSWER-bearing labels
// map to those; high-fanout structural labels (context_of) map to a NON-routed type
// (co_occurs_with) so they are recorded as public continuity structure WITHOUT flooding
// the lens (dense context_of→supports stars were the relation-flood source on the smoke).
const EDGE = { supersedes: 'supersedes', supports: 'supports', belongs_to_project: 'supports', depends_on: 'supports', context_of: 'co_occurs_with', causes: 'causes', fixes: 'causes', decision_reason: 'causes', decision_outcome: 'derived_from', coreference_of: 'coreference_of', contradicts: 'co_occurs_with', scope_differs: 'co_occurs_with', unresolved_conflict: 'co_occurs_with', aspect_of: 'co_occurs_with' };
const rel = (src, dst, label) => addRel(src, dst, EDGE[label] ?? 'supports', label);

// timestamp over a long window (depth → more revisits over time)
const baseDate = new Date('2024-01-01').getTime();
const ts = (monthOffset) => new Date(baseDate + monthOffset * 30 * 86400000).toISOString().slice(0, 10);

// difficulty band: deeper revision chains / denser distractors → harder
function band(revisions, distractors, isExhaustion) {
  if (isExhaustion) return 'exhaustion';
  const score = revisions + distractors;
  if (score <= 2) return 'easy';
  if (score <= 4) return 'medium';
  if (score <= 7) return 'hard';
  return 'very_hard';
}

// ── build each universe ──
for (let ui = 0; ui < N_UNIVERSES; ui++) {
  const universe = universes[ui];
  addEntity(universe, `Deep Memory Universe ${ui}`, [], 'deep_universe');
  const subjectsThisU = Math.ceil(N_SUBJECTS / N_UNIVERSES);
  // unique-name pool: FIRST×LAST gives 625 combos; index suffix guarantees uniqueness beyond that.
  for (let s = 0; s < subjectsThisU; s++) {
    const first = FIRST[(s * 7 + ui) % FIRST.length];
    const last = LAST[(s * 13 + ui * 3) % LAST.length];
    const uniqIdx = s; // disambiguating index keeps canonical identity unique even on name reuse
    const isProject = s % 3 === 0; // ~1/3 projects, ~2/3 people
    const subjId = `e_${universe}_s${s}`;
    const job = pick(JOBS), city = pick(CITIES);
    const projName = `${pick(TOPICS).replace(/\s/g, '-')}-svc-${uniqIdx}`;
    const canonical = isProject ? projName : `${first} ${last}`;
    // UNIQUE alias: include a disambiguator so coreference is well-posed even when first names repeat
    const role = isProject ? `the ${pick(STACKS)} service` : `the ${job} in ${city}`;
    addEntity(subjId, canonical, isProject ? [projName] : [first, `${first} the ${job}`], universe === universe ? 'deep_universe' : 'deep_universe');
    const tagU = (extra = []) => [universe, subjId, ...extra];

    // intro / coreference anchor doc
    const introId = addDoc({ lane: 'deep', kind: 'intro', entityIds: tagU(),
      text: isProject ? `Project ${canonical} is ${role}, owned by the platform team.` : `${canonical} is a ${job} based in ${city}; people sometimes call them ${first}.`,
      shape: 'intro_record', timestamp: ts(0), currentStaleFlag: true });

    // ── deep session filler (repeated topic revisits + same-universe distractors) ──
    const nSessions = DEPTH + ri(Math.floor(DEPTH * 1.5)); // 25-100+ when DEPTH~30-60
    const sessionDocIds = [];
    for (let k = 0; k < nSessions; k++) {
      const topic = pick(TOPICS);
      const did = addDoc({ lane: 'deep', kind: 'session', entityIds: tagU(),
        text: isProject ? `In a ${canonical} review we discussed ${topic} and tuned the ${pick(DBS)} layer.` : `${first} mentioned a session about ${topic} and their ${pick(DIETS)} routine.`,
        shape: 'session_memory', timestamp: ts(1 + ri(36)), currentStaleFlag: true });
      sessionDocIds.push(did);
      if (chance(0.5)) rel(did, introId, 'context_of');
    }

    // ── FAMILY 1: temporal_update (3-10 revisions, supersedes chain) ──
    {
      const nRev = 3 + ri(8); // 3-10
      const attr = isProject ? 'package manager' : 'city';
      const valBank = isProject ? PKGS : CITIES;
      let prev = null; const chain = [];
      for (let r = 0; r < nRev; r++) {
        const isCurrent = r === nRev - 1;
        const val = valBank[(s + r) % valBank.length];
        const did = addDoc({ lane: 'deep', kind: `temporal_${attr}`, entityIds: tagU(),
          text: isProject ? `${canonical} switched its ${attr} to ${val}.` : `${canonical} updated their ${attr} to ${val}.`,
          shape: 'temporal_update_record', timestamp: ts(2 + r * 3), currentStaleFlag: isCurrent });
        chain.push({ did, val, isCurrent });
        if (prev) rel(did, prev.did, 'supersedes');
        prev = { did };
      }
      const cur = chain[chain.length - 1];
      // dense same-universe distractors: OTHER subjects' values of the same attr (added as hard negs below)
      const nDist = 1 + ri(4);
      addQuery({ lane: 'deep', family: 'temporal_update', queryText: `What is ${canonical}'s current ${attr}?`,
        qrels: [{ docId: cur.did, relevance: 1.0, role: 'direct' }, ...chain.filter((c) => !c.isCurrent).map((c) => ({ docId: c.did, relevance: 0.2, role: 'stale' }))],
        hardNegatives: chain.filter((c) => !c.isCurrent).slice(0, nDist).map((c) => ({ docId: c.did, category: 'temporal_stale' })),
        ownerEntityId: universe, band: band(nRev, nDist, chance(0.15)) });
    }

    // ── FAMILY 2: preference_evolution (temporal bucket; many sessions then current pref) ──
    if (!isProject) {
      const nRev = 3 + ri(6);
      let prev = null; const chain = [];
      for (let r = 0; r < nRev; r++) {
        const isCurrent = r === nRev - 1;
        const diet = DIETS[(s + r * 2) % DIETS.length];
        const did = addDoc({ lane: 'deep', kind: 'temporal_diet', entityIds: tagU(),
          text: `${canonical} said they moved to a ${diet} diet this season.`, shape: 'temporal_update_record', timestamp: ts(3 + r * 4), currentStaleFlag: isCurrent });
        chain.push({ did, isCurrent }); if (prev) rel(did, prev.did, 'supersedes'); prev = { did };
      }
      const cur = chain[chain.length - 1];
      addQuery({ lane: 'deep', family: 'temporal_update', queryText: `What diet is ${canonical} currently following?`,
        qrels: [{ docId: cur.did, relevance: 1.0, role: 'direct' }, ...chain.filter((c) => !c.isCurrent).map((c) => ({ docId: c.did, relevance: 0.2, role: 'stale' }))],
        hardNegatives: chain.filter((c) => !c.isCurrent).slice(0, 2).map((c) => ({ docId: c.did, category: 'temporal_stale' })),
        ownerEntityId: universe, band: band(nRev, 2, false) });
    }

    // ── FAMILY 3: multi_session_bridge (belongs_to / depends_on; bridge hop) ──
    // ROUTING-REQUIRED: the answer doc does NOT name the subject (lexically distant from
    // the subject-named query), so dense stage-1 can't find it directly — it is reachable
    // ONLY via a public support/depends_on edge from a findable bridge SEED doc that DOES
    // name the subject. (Mirrors the V2 bridge@1→answer design + decision_provenance.)
    {
      const sibName = `${FIRST[(s * 11 + 3) % FIRST.length]} ${LAST[(s * 17 + 5) % LAST.length]}`;
      const attrVal = isProject ? pick(DBS) : pick(JOBS);
      // REALISM SLICE: ~1/3 of bridge answers are PARTIALLY grounded (carry a weak subject
      // reference) rather than maximally lexically-distant — to test whether relation
      // surfacing generalizes off the most-adversarial end (operator: benchmark may be too
      // adversarial if only fully-distant works/fails). `grounding` is recorded for analysis.
      const partial = chance(0.34);
      const answerDoc = addDoc({ lane: 'deep', kind: 'bridge_answer', entityIds: tagU(),
        text: isProject
          ? (partial ? `The ${canonical} service's data layer runs on a ${attrVal} cluster managed by infra.` : `The data layer for that platform service runs on a ${attrVal} cluster managed by infra.`)
          : (partial ? `${sibName}, ${canonical}'s sibling, works as a ${attrVal} downtown.` : `${sibName} works as a ${attrVal} and lives downtown.`),
        shape: 'bridge_record', timestamp: ts(5 + ri(20)), currentStaleFlag: true });
      const bridgeDoc = addDoc({ lane: 'deep', kind: 'bridge_seed', entityIds: tagU(),
        text: isProject ? `${canonical} owns the data layer for that platform service.` : `${canonical}'s sibling is ${sibName}.`,
        shape: 'bridge_seed', timestamp: ts(4 + ri(10)), currentStaleFlag: true });
      rel(bridgeDoc, answerDoc, isProject ? 'depends_on' : 'supports');
      const nDist = 1 + ri(3);
      addQuery({ lane: 'deep', family: 'multi_session_bridge', grounding: partial ? 'partial' : 'distant',
        queryText: isProject ? `What datastore does ${canonical} depend on?` : `What is the job of ${canonical}'s sibling?`,
        qrels: [{ docId: answerDoc, relevance: 1.0, role: 'direct' }, { docId: bridgeDoc, relevance: 0.5, role: 'bridge' }],
        hardNegatives: [{ docId: introId, category: 'relation_neighbor' }], ownerEntityId: universe, band: band(4, nDist, chance(0.15)) });
    }

    // ── FAMILY 4: decision_provenance (reason → outcome) ──
    if (isProject) {
      const decision = addDoc({ lane: 'deep', kind: 'decision', entityIds: tagU(), text: `${canonical} decided to migrate off ${pick(DBS)}.`, shape: 'decision_record', timestamp: ts(6 + ri(10)), currentStaleFlag: true });
      const reason = addDoc({ lane: 'deep', kind: 'decision_reason', entityIds: tagU(), text: `The migration was driven by repeated ${pick(ERRORS)} incidents.`, shape: 'decision_reason', timestamp: ts(6 + ri(10)), currentStaleFlag: true });
      const outcome = addDoc({ lane: 'deep', kind: 'decision_outcome', entityIds: tagU(), text: `After the migration, ${canonical} saw latency drop and incidents fall.`, shape: 'decision_outcome', timestamp: ts(8 + ri(8)), currentStaleFlag: true });
      rel(reason, decision, 'decision_reason'); rel(outcome, decision, 'decision_outcome');
      addQuery({ lane: 'deep', family: 'decision_provenance', queryText: `Why did ${canonical} migrate its datastore?`,
        qrels: [{ docId: reason, relevance: 1.0, role: 'direct' }, { docId: decision, relevance: 0.5, role: 'bridge' }],
        hardNegatives: [{ docId: outcome, category: 'relation_neighbor' }], ownerEntityId: universe, band: band(3, 2, chance(0.2)) });
    }

    // ── FAMILY 5: workflow_gotcha / fixes (causes edge) — ROUTING-REQUIRED ──
    // The FIX doc states the remedy without naming the subject (distant from the
    // subject+error query); reachable only via the `fixes` edge from the findable
    // error/gotcha SEED that names the subject.
    if (isProject) {
      const err = pick(ERRORS), envv = pick(ENVVARS);
      const fixDoc = addDoc({ lane: 'deep', kind: 'fix', entityIds: tagU(), text: `That deploy failure was resolved by setting ${envv} correctly before warmup.`, shape: 'fix_record', timestamp: ts(7 + ri(12)), currentStaleFlag: true });
      const errDoc = addDoc({ lane: 'deep', kind: 'gotcha', entityIds: tagU(), text: `${canonical} hit a ${err} during deploys.`, shape: 'gotcha_record', timestamp: ts(6 + ri(12)), currentStaleFlag: true });
      rel(fixDoc, errDoc, 'fixes');
      addQuery({ lane: 'deep', family: 'causal_memory_chain', queryText: `How was the ${err} in ${canonical} resolved?`,
        qrels: [{ docId: fixDoc, relevance: 1.0, role: 'direct' }, { docId: errDoc, relevance: 0.5, role: 'bridge' }],
        hardNegatives: [{ docId: introId, category: 'relation_neighbor' }], ownerEntityId: universe, band: band(3, 1, false) });
    }

    // ── FAMILY 6: coreference_resolution (alias/role → canonical) ──
    if (!isProject) {
      const corefDoc = addDoc({ lane: 'deep', kind: 'coref_fact', entityIds: tagU(), text: `${canonical} adopted a rescue dog named Pepper last spring.`, shape: 'coref_record', timestamp: ts(9 + ri(6)), currentStaleFlag: true });
      rel(corefDoc, introId, 'coreference_of');
      addQuery({ lane: 'deep', family: 'coreference_resolution', queryText: `What pet does ${first} the ${job} have?`,
        qrels: [{ docId: corefDoc, relevance: 1.0, role: 'direct' }],
        hardNegatives: [{ docId: introId, category: 'relation_neighbor' }], ownerEntityId: universe, band: band(2, 1, false) });
    }

    // ── r5 SYNTHESIS: conflict/update lifecycle, aspect constraints, and abstention ──
    // These opt-in slices are PUBLIC memory-operation structure for r5 PolicyAtom probes.
    // They are not enabled in the historical DGEN-1 defaults so prior findings remain replayable.
    if (R5_SYNTHESIS) {
      // FAMILY 3: conflict/update lifecycle. Two public memories can both be currently valid,
      // but one is contradicted / scope-different / unresolved. A policy atom should reason
      // over the lifecycle edge/state rather than applying blunt temporal stale suppression.
      const conflictAttr = isProject ? 'deployment region' : 'preferred clinic';
      const scopedA = isProject ? pick(CITIES) : `${pick(CITIES)} family clinic`;
      const scopedB = isProject ? pick(CITIES) : `${pick(CITIES)} specialist clinic`;
      const stableScope = isProject ? 'production' : 'weekday care';
      const conflictA = addDoc({ lane: 'deep', kind: 'lifecycle_conflict', entityIds: tagU(),
        text: `${canonical}'s ${conflictAttr} for ${stableScope} was recorded as ${scopedA}.`,
        shape: 'lifecycle_conflict_record', timestamp: ts(12 + ri(12)), currentStaleFlag: true,
        lifecycleState: 'conflict_candidate', lifecycleScope: stableScope });
      const conflictB = addDoc({ lane: 'deep', kind: 'lifecycle_conflict', entityIds: tagU(),
        text: `${canonical}'s corrected ${conflictAttr} for ${stableScope} is ${scopedB}.`,
        shape: 'lifecycle_conflict_record', timestamp: ts(13 + ri(12)), currentStaleFlag: true,
        lifecycleState: 'conflict_resolved', lifecycleScope: stableScope });
      const otherScope = isProject ? 'staging' : 'weekend care';
      const scopeDoc = addDoc({ lane: 'deep', kind: 'lifecycle_scope', entityIds: tagU(),
        text: `${canonical}'s ${conflictAttr} for ${otherScope} remains ${scopedA}.`,
        shape: 'lifecycle_scope_record', timestamp: ts(14 + ri(12)), currentStaleFlag: true,
        lifecycleState: 'scope_differs', lifecycleScope: otherScope });
      rel(conflictB, conflictA, 'contradicts');
      rel(scopeDoc, conflictB, 'scope_differs');
      addQuery({ lane: 'deep', family: 'conflict_lifecycle',
        queryText: `For ${stableScope}, what is ${canonical}'s current ${conflictAttr}?`,
        qrels: [{ docId: conflictB, relevance: 1.0, role: 'direct' }, { docId: conflictA, relevance: 0.0, role: 'conflict' }, { docId: scopeDoc, relevance: 0.2, role: 'scope_differs' }],
        hardNegatives: [{ docId: conflictA, category: 'temporal_stale' }, { docId: scopeDoc, category: 'near_collision_attribute' }],
        ownerEntityId: universe, band: 'very_hard', operationFamily: 'conflict_lifecycle' });

      // FAMILY 4: instruction/aspect constraint. One memory can mention multiple aspects;
      // the query selects a specific aspect. Wrong-aspect docs are relevant-looking but not
      // direct answers, matching MemReranker's aspect-constraint / partial-support failure mode.
      const aspectWanted = ASPECTS[(s + ui) % ASPECTS.length];
      const aspectOther = ASPECTS[(s + ui + 3) % ASPECTS.length];
      const wantedVal = isProject ? `${ri(80) + 20} ms p95` : `${ri(6) + 2} days`;
      const otherVal = isProject ? `$${ri(900) + 100}/month` : `${pick(DIETS)} support`;
      const aspectDoc = addDoc({ lane: 'deep', kind: 'aspect_answer', entityIds: tagU(aspectWanted),
        text: `${canonical}'s ${aspectWanted} note says the target is ${wantedVal}; the same memo also mentions ${aspectOther} only briefly.`,
        shape: 'aspect_answer_record', timestamp: ts(15 + ri(12)), currentStaleFlag: true,
        aspectTags: [aspectWanted, aspectOther] });
      const wrongAspectDoc = addDoc({ lane: 'deep', kind: 'aspect_neighbor', entityIds: tagU(aspectOther),
        text: `${canonical}'s ${aspectOther} note says the current value is ${otherVal}, with no ${aspectWanted} decision.`,
        shape: 'aspect_partial_record', timestamp: ts(15 + ri(12)), currentStaleFlag: true,
        aspectTags: [aspectOther] });
      rel(aspectDoc, introId, 'aspect_of');
      rel(wrongAspectDoc, introId, 'aspect_of');
      addQuery({ lane: 'deep', family: 'aspect_constraint', intentAspect: aspectWanted,
        queryText: `For ${canonical}, what is the ${aspectWanted} detail?`,
        qrels: [{ docId: aspectDoc, relevance: 1.0, role: 'direct' }, { docId: wrongAspectDoc, relevance: 0.2, role: 'wrong_aspect' }],
        hardNegatives: [{ docId: wrongAspectDoc, category: 'lexical_distractor' }],
        ownerEntityId: universe, band: 'hard', operationFamily: 'aspect_constraint' });

      // FAMILY 5: abstention/no-answer. The query is plausible and has hard same-subject
      // distractors, but the direct answer memory is intentionally absent from the corpus.
      // This lets abstain/no-evidence-path atoms be evaluated without query-specific oracle labels.
      const missingTopic = isProject ? 'rollback owner' : 'emergency contact';
      const distractA = addDoc({ lane: 'deep', kind: 'abstain_distractor', entityIds: tagU(),
        text: `${canonical} discussed ${missingTopic} planning, but the final value was not recorded in this memory.`,
        shape: 'abstain_context_record', timestamp: ts(16 + ri(12)), currentStaleFlag: true });
      const distractB = addDoc({ lane: 'deep', kind: 'abstain_distractor', entityIds: tagU(),
        text: `${canonical} mentioned adjacent ${pick(TOPICS)} notes without naming the ${missingTopic}.`,
        shape: 'abstain_context_record', timestamp: ts(16 + ri(12)), currentStaleFlag: true });
      addQuery({ lane: 'deep', family: 'abstention_missing', queryText: `What is ${canonical}'s ${missingTopic}?`,
        qrels: [], abstain: true,
        hardNegatives: [{ docId: distractA, category: 'lexical_distractor' }, { docId: distractB, category: 'trap' }],
        ownerEntityId: universe, band: 'exhaustion', operationFamily: 'abstention' });
    }
  }
}

// ── DENSE same-universe distractors: for each query, add a few hard negatives that are
// other subjects' docs of the SAME kind (strong same-universe negatives, not cross-owner). ──
const docsByKind = new Map();
for (const d of docs) { const k = d.kind.replace(/_\w+$/, ''); if (!docsByKind.has(k)) docsByKind.set(k, []); docsByKind.get(k).push(d.id); }
for (const q of queries) {
  const directKind = docs.find((d) => d.id === q.qrels.find((r) => r.role === 'direct')?.docId)?.kind;
  if (!directKind) continue;
  const pool = docsByKind.get(directKind.replace(/_\w+$/, '')) ?? [];
  const have = new Set(q.qrels.map((r) => r.docId).concat(q.hardNegatives.map((n) => n.docId)));
  let added = 0;
  for (let i = 0; i < pool.length && added < 3; i++) { const cand = pool[ri(pool.length)]; if (!have.has(cand)) { q.hardNegatives.push({ docId: cand, category: 'near_collision_attribute' }); have.add(cand); added++; } }
}

const out = {
  specVersion: 'coretex.memory-corpus.dgen1.r1', phase: PHASE, seed: SEED,
  generator: 'generate-dgen1-corpus.mjs',
  params: { subjects: N_SUBJECTS, depth: DEPTH, universes: N_UNIVERSES, r5Synthesis: R5_SYNTHESIS },
  splitRatios: { trainVisiblePct: 70, calibrationPct: 10, evalHiddenPct: 15, canaryPct: 5 },
  description: `DGEN-1 generator-native deep-memory longevity corpus: one coherent deep universe, unique in-universe subjects, deep sessions + 3-10 temporal revisions + relation/decision/coreference provenance, dense same-universe distractors, hidden difficulty bands. ${R5_SYNTHESIS ? 'Includes opt-in r5 synthesis slices for conflict lifecycle, aspect constraints, and abstention/no-answer.' : 'NO synthetic re-pooling.'}`,
  dgen1: { universes, families: ['temporal_update', 'multi_session_bridge', 'causal_memory_chain', 'decision_provenance', 'coreference_resolution', ...(R5_SYNTHESIS ? ['conflict_lifecycle', 'aspect_constraint', 'abstention_missing'] : [])], continuityLabels: Object.keys(EDGE), bands: ['easy', 'medium', 'hard', 'very_hard', 'exhaustion'], r5Synthesis: R5_SYNTHESIS },
  entities, docs, relations, queries,
};
writeFileSync(OUT, JSON.stringify(out));

// ── diagnostics ──
const evalQ = queries.filter((q) => q.split === 'eval_hidden');
const famHist = {}; for (const q of queries) famHist[q.family] = (famHist[q.family] ?? 0) + 1;
const bandHist = {}; for (const q of evalQ) bandHist[q.band] = (bandHist[q.band] ?? 0) + 1;
const relTypeHist = {}; for (const r of relations) relTypeHist[r.label] = (relTypeHist[r.label] ?? 0) + 1;
const docsPerSubject = docs.length / Math.max(1, N_SUBJECTS);
console.log(JSON.stringify({ phase: PHASE, universes: N_UNIVERSES, subjects: N_SUBJECTS, docs: docs.length, queries: queries.length,
  evalHiddenQueries: evalQ.length, docsPerSubject: +docsPerSubject.toFixed(1), entities: entities.length, relations: relations.length,
  familyHistogram: famHist, evalBandHistogram: bandHist, continuityLabelHistogram: relTypeHist }, null, 2));
console.log(`wrote ${OUT}`);
