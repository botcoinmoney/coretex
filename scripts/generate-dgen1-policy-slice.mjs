#!/usr/bin/env node
/**
 * DGEN-1 POLICY SLICE — corroboration-density corpus for the EvidencePolicy 3rd-surface
 * probe (EVIDENCE_POLICY_DESIGN.md realism prerequisite; operator priority #4).
 *
 * WHY: current DGEN-1 has supports-edge in-degree ≈ 1 everywhere (single bridge→answer),
 * so `high_density_evidence` has no signal (empirically: maxInDegree=1, 0 lift). This slice
 * adds REALISTIC corroboration density: important facts are confirmed by K (3-6) INDEPENDENT
 * memories (real memory stores repeat/confirm important facts across sessions). The
 * corroborated answer is lexically DISTANT from the query (low bi-cosine → OFF buries it
 * below the rerank cap) but carries WEAK subject grounding so the reranker can resolve it
 * ONCE the contribution policy admits it. Distractors include OTHER subjects' corroborated
 * facts (also high in-degree) → the policy boosts a CLASS (corroborated facts), NOT a
 * per-query answer map; the reranker + query must still pick the right one. Honesty guards:
 * class-level rule + reranker resolves within class + the probe's random/hillclimb controls.
 *
 * Family `corroborated_fact` → bucketed multi_hop_relation. Answer in-degree = K supports.
 * Ordinary docs have in-degree 0; so the public in-degree distribution discriminates
 * (proposer picks K from its p90). Keeps temporal/bridge families too (realistic universe +
 * cross-family distractors).
 *
 * Usage: node scripts/generate-dgen1-policy-slice.mjs --subjects 300 --depth 22 \
 *   --seed dgen1-policy-2026-05-23 --out <corpus.json>
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const N_SUBJECTS = parseInt(argVal('--subjects', '300'), 10);
const DEPTH = parseInt(argVal('--depth', '22'), 10);
const SEED = argVal('--seed', 'dgen1-policy-2026-05-23');
const PHASE = argVal('--phase', 'DGEN1POLICY');
const OUT = argVal('--out', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-policy-slice-corpus.json');

function hashSeed(s) { let h = 1779033703 ^ s.length; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = mulberry32(hashSeed(SEED));
const ri = (n) => Math.floor(rand() * n);
const pick = (a) => a[ri(a.length)];
const chance = (p) => rand() < p;
function splitFor(id) { const h = parseInt(createHash('sha256').update(`${SEED}:${id}`).digest('hex').slice(0, 8), 16) % 100; return h < 70 ? 'train_visible' : h < 80 ? 'calibration' : h < 95 ? 'eval_hidden' : 'canary'; }

const FIRST = ['Maya', 'Alex', 'Priya', 'Jordan', 'Sam', 'Lena', 'Diego', 'Aisha', 'Tom', 'Nina', 'Omar', 'Grace', 'Ravi', 'Elena', 'Yuki', 'Carlos', 'Hana', 'Marcus', 'Leo', 'Sofia', 'Noah', 'Zara', 'Ivan', 'Mei', 'Kofi'];
const LAST = ['Chen', 'Nadar', 'Sharma', 'Okafor', 'Reyes', 'Petrov', 'Kim', 'Haddad', 'Singh', 'Rossi', 'Mueller', 'Ito', 'Diallo', 'Costa', 'Larsen', 'Mensah', 'Park', 'Novak', 'Tanaka', 'Vega', 'Bauer', 'Osei', 'Lund', 'Cruz', 'Aziz'];
const JOBS = ['UX designer', 'data analyst', 'ER nurse', 'teacher', 'civil engineer', 'product manager', 'pastry chef', 'physical therapist', 'accountant', 'illustrator'];
const CITIES = ['Seattle', 'Austin', 'Denver', 'Portland', 'Chicago', 'Boston', 'Atlanta', 'Toronto', 'Lisbon', 'Berlin', 'Oslo', 'Nairobi'];
const TOPICS = ['onboarding flow', 'billing retries', 'search ranking', 'auth refresh', 'image pipeline', 'export job'];
const DOCTORS = ['Dr. Okonkwo', 'Dr. Brandt', 'Dr. Salazar', 'Dr. Whitfield', 'Dr. Nakamura', 'Dr. Abeln', 'Dr. Castellano', 'Dr. Frye'];
const CLINICS = ['Mercy Clinic', 'Lakeside Health', 'Cedar Family Practice', 'Northgate Medical', 'Harbor Wellness', 'Birchwood Care'];
const MONTHS = ['January', 'March', 'May', 'July', 'September', 'November'];

const universe = 'e_universe';
const entities = [], docs = [], relations = [], queries = [];
let docSeq = 0, qSeq = 0;
const docId = () => `d${String(docSeq++).padStart(7, '0')}`;
const qId = () => `q${String(qSeq++).padStart(7, '0')}`;
const addEntity = (id, canonicalName, aliases) => { entities.push({ id, canonicalName, aliases, lane: 'deep_universe' }); };
function addDoc(d) { const id = docId(); docs.push({ id, split: splitFor(id), ...d }); return id; }
function addRel(src, dst, type, label) { relations.push({ src, dst, type, label }); }
const EDGE = { supports: 'supports', supersedes: 'supersedes', context_of: 'co_occurs_with', causes: 'causes', coreference_of: 'coreference_of' };
const rel = (src, dst, label) => addRel(src, dst, EDGE[label] ?? 'supports', label);
function addQuery(q) { const id = qId(); queries.push({ id, split: splitFor(id), ownerScoped: true, ownerEntityId: universe, ...q }); return id; }
const baseDate = new Date('2024-01-01').getTime();
const ts = (m) => new Date(baseDate + m * 30 * 86400000).toISOString().slice(0, 10);
function band(score, isExh) { if (isExh) return 'exhaustion'; if (score <= 2) return 'easy'; if (score <= 4) return 'medium'; if (score <= 7) return 'hard'; return 'very_hard'; }

addEntity(universe, 'Deep Memory Universe', []);
for (let s = 0; s < N_SUBJECTS; s++) {
  const first = FIRST[(s * 7) % FIRST.length], last = LAST[(s * 13) % LAST.length];
  const subjId = `e_${universe}_s${s}`;
  const canonical = `${first} ${last}`;
  const job = pick(JOBS), city = pick(CITIES);
  addEntity(subjId, canonical, [first, `${first} the ${job}`]);
  const tagU = () => [universe, subjId];
  const introId = addDoc({ lane: 'deep', kind: 'intro', entityIds: tagU(), text: `${canonical} is a ${job} based in ${city}; people sometimes call them ${first}.`, shape: 'intro_record', timestamp: ts(0), currentStaleFlag: true });

  // deep session filler (same-universe distractors)
  const nSessions = DEPTH + ri(Math.floor(DEPTH * 0.6));
  for (let k = 0; k < nSessions; k++) {
    const topic = pick(TOPICS);
    const did = addDoc({ lane: 'deep', kind: 'session', entityIds: tagU(), text: `${first} mentioned a session about ${topic} during the ${pick(MONTHS)} check-in.`, shape: 'session_memory', timestamp: ts(1 + ri(20)), currentStaleFlag: true });
    if (chance(0.4)) rel(did, introId, 'context_of');
  }

  // ── CORROBORATED FACT (the policy-rewarding structure) ──
  // A fact about the subject, CONFIRMED by K independent memories. The answer doc is
  // lexically distant from the query (describes the fact obliquely) with WEAK subject
  // grounding (carries the first name) so the reranker can resolve it once admitted; the
  // K corroborators (varied session contexts) do NOT name the subject strongly (poor
  // stage-1 hits) but each SUPPORTS the answer → answer in-degree = K. Ordinary docs: 0.
  const doctor = DOCTORS[(s * 3) % DOCTORS.length], clinic = CLINICS[(s * 5) % CLINICS.length];
  // REALISTIC GRADIENT (EVIDENCE_POLICY_DESIGN.md Step-2 #1): the eval answer is an IMPORTANT
  // fact (a care provider) that recurs across visits → HEAVILY corroborated (in-degree 4-6).
  // Each subject ALSO has INCIDENTAL facts mentioned once or twice (in-degree 1-2) as same-
  // universe distractors. So the PUBLIC supports in-degree distribution spans {0,1,2,4,5,6}:
  // honest-K (chosen from the public p90 ≈ 5) discriminates important facts; a too-low random-K
  // floods incidental facts, a too-high one misses answers → K is skill-differentiated and the
  // random/hillclimb controls can genuinely fail. This models real corroboration (important
  // facts get repeated), NOT a clean rig — realism only; the Qwen verdict decides.
  const K = 4 + ri(3); // 4-6 corroborators for the IMPORTANT fact
  const answerId = addDoc({ lane: 'deep', kind: 'corroborated_fact', entityIds: tagU(),
    text: `The clinician overseeing ${first}'s care plan is ${doctor}, practising out of ${clinic}.`,
    shape: 'fact_record', timestamp: ts(3 + ri(8)), currentStaleFlag: true });
  for (let c = 0; c < K; c++) {
    const corrId = addDoc({ lane: 'deep', kind: 'corroborator', entityIds: tagU(),
      text: `In the ${MONTHS[c % MONTHS.length]} visit notes, ${doctor} reviewed the care plan and signed off at ${clinic}.`,
      shape: 'corroborator_record', timestamp: ts(3 + c), currentStaleFlag: true });
    rel(corrId, answerId, 'supports');
  }
  // INCIDENTAL facts (lightly corroborated, in-degree 1-2) → gradient + distractors, NOT answers.
  const nIncidental = 2 + ri(2);
  for (let f = 0; f < nIncidental; f++) {
    const topic = pick(TOPICS); const incId = addDoc({ lane: 'deep', kind: 'incidental_fact', entityIds: tagU(),
      text: `A note about the ${topic} for that account referenced ${pick(CITIES)} logistics.`, shape: 'fact_record', timestamp: ts(4 + f), currentStaleFlag: true });
    const incK = 1 + ri(2); // 1-2 light corroborators
    for (let c = 0; c < incK; c++) { const cId = addDoc({ lane: 'deep', kind: 'corroborator', entityIds: tagU(), text: `The ${MONTHS[(f + c) % MONTHS.length]} log mentioned the ${topic} adjustment once.`, shape: 'corroborator_record', timestamp: ts(4 + f + c), currentStaleFlag: true }); rel(cId, incId, 'supports'); }
  }
  const nDist = 1 + ri(3);
  addQuery({ lane: 'deep', family: 'corroborated_fact', queryText: `Who is ${canonical}'s primary care physician?`,
    qrels: [{ docId: answerId, relevance: 1.0, role: 'direct' }],
    hardNegatives: [{ docId: introId, category: 'relation_neighbor' }], band: band(K + nDist, chance(0.15)) });

  // a temporal chain too (cross-family realism + distractors)
  if (chance(0.5)) {
    const nRev = 3 + ri(4); let prev = null; const chain = [];
    for (let r = 0; r < nRev; r++) { const isCur = r === nRev - 1; const val = CITIES[(s + r) % CITIES.length];
      const did = addDoc({ lane: 'deep', kind: 'temporal_city', entityIds: tagU(), text: `${canonical} updated their city to ${val}.`, shape: 'temporal_update_record', timestamp: ts(2 + r * 3), currentStaleFlag: isCur });
      chain.push({ did, isCur }); if (prev) rel(did, prev.did, 'supersedes'); prev = { did }; }
    const cur = chain[chain.length - 1];
    addQuery({ lane: 'deep', family: 'temporal_update', queryText: `What is ${canonical}'s current city?`,
      qrels: [{ docId: cur.did, relevance: 1.0, role: 'direct' }, ...chain.filter((c) => !c.isCur).map((c) => ({ docId: c.did, relevance: 0.2, role: 'stale' }))],
      hardNegatives: chain.filter((c) => !c.isCur).slice(0, 2).map((c) => ({ docId: c.did, category: 'temporal_stale' })), band: band(nRev, false) });
  }
}

// dense same-universe distractors: other subjects' docs of the same kind
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

const out = { specVersion: 'coretex.memory-corpus.dgen1-policy.r1', phase: PHASE, seed: SEED, generator: 'generate-dgen1-policy-slice.mjs',
  params: { subjects: N_SUBJECTS, depth: DEPTH, universes: 1 },
  splitRatios: { trainVisiblePct: 70, calibrationPct: 10, evalHiddenPct: 15, canaryPct: 5 },
  description: 'DGEN-1 POLICY SLICE: corroboration-density corpus for the EvidencePolicy high_density_evidence 3rd-surface probe. Some facts confirmed by K=3-6 independent memories (answer in-degree=K); answer lexically distant + weakly grounded; distractors include other subjects corroborated facts (policy boosts a CLASS, reranker resolves). Cross-family temporal/session realism + distractors. NOT contrived: corroboration is a real memory signal; honesty enforced by class-level rule + reranker + probe controls.',
  dgen1Policy: { universe, families: ['corroborated_fact', 'temporal_update'], continuityLabels: Object.keys(EDGE), bands: ['easy', 'medium', 'hard', 'very_hard', 'exhaustion'] },
  entities, docs, relations, queries };
writeFileSync(OUT, JSON.stringify(out));

// diagnostics: in-degree distribution (the signal the policy keys on)
const inDeg = new Map();
for (const r of relations) { if (r.type === 'supports') inDeg.set(r.dst, (inDeg.get(r.dst) ?? 0) + 1); }
const degVals = [...inDeg.values()].sort((a, b) => a - b);
const maxDeg = degVals.length ? degVals[degVals.length - 1] : 0;
const evalQ = queries.filter((q) => q.split === 'eval_hidden');
const famHist = {}; for (const q of queries) famHist[q.family] = (famHist[q.family] ?? 0) + 1;
console.log(JSON.stringify({ phase: PHASE, subjects: N_SUBJECTS, docs: docs.length, queries: queries.length, evalHidden: evalQ.length,
  relations: relations.length, supportsInDegree: { distinctTargets: inDeg.size, maxInDegree: maxDeg, p90: degVals.length ? degVals[Math.floor(0.9 * degVals.length)] : 0 },
  familyHistogram: famHist }, null, 2));
console.log(`wrote ${OUT}`);
