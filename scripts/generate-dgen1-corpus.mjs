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

// ── PER-SUBJECT STABLE TOKENS (text-diversity fix 2026-05-31) ──
// The prior generator emitted universe-generic templates ("The data layer for that platform service
// runs on a ${attrVal} cluster managed by infra.") that repeated EXACT across subjects, producing
// an 82.5% text-duplicate rate at 300k → ~99% truth-doc unreachable in bi-encoder first-stage
// (see release/calibration/2026-05-30-corpus-retrieval-collapse.md, gate report
// release/calibration/2026-05-21-memory-corpus-v2/corpus-retrieval-health-86275800.json). These
// stable-per-subject token banks let every text emission carry 2-3 subject-derived semantic
// tokens, keeping "ROUTING-REQUIRED" docs subject-anonymous (canonical name absent) while
// guaranteeing per-subject uniqueness via combinatorial codename + infraTag + region + version.
const COLORS = ['amber', 'azure', 'cobalt', 'crimson', 'emerald', 'jade', 'magenta', 'ochre', 'sable', 'scarlet', 'teal', 'violet', 'beige', 'fuchsia', 'indigo', 'mauve', 'olive', 'sepia', 'topaz', 'umber'];
const ANIMALS = ['falcon', 'otter', 'lynx', 'heron', 'badger', 'narwhal', 'gecko', 'caracal', 'tapir', 'puma', 'orca', 'koi', 'wren', 'wallaby', 'mongoose', 'bison', 'civet', 'dingo', 'egret', 'fennec'];
const REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-southeast-2', 'sa-east-1', 'ca-central-1', 'me-south-1', 'af-south-1', 'eu-north-1', 'ap-northeast-1', 'ap-south-1', 'eu-west-3'];
const QUARTERS = ['Q1 2022', 'Q2 2022', 'Q3 2022', 'Q4 2022', 'Q1 2023', 'Q2 2023', 'Q3 2023', 'Q4 2023', 'Q1 2024', 'Q2 2024', 'Q3 2024', 'Q4 2024', 'Q1 2025', 'Q2 2025'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PETS = ['Pepper', 'Mochi', 'Nala', 'Ziggy', 'Biscuit', 'Juno', 'Pixel', 'Saffron', 'Tofu', 'Marble', 'Ember', 'Onyx'];
const PROFESSIONALS = ['nutritionist', 'cardiologist', 'sports physiologist', 'family GP', 'naturopath', 'dietitian'];
const CAUSES = ['a flaky cron', 'a stale TLS chain', 'a queue saturation', 'a misconfigured retry', 'a hidden N+1', 'a dropped feature flag'];
// Session-noise vocabulary: kept DISJOINT from DIETS/PROFESSIONALS/ASPECTS so session distractor
// docs don't share lexical neighborhoods with truth docs (the 2026-05-31 retrieval-health
// miss-dumps showed top-5 returns for "Maya Chen current diet" were all session docs sharing
// "sports physiologist" + "routine" + DIETS overlap — bi-encoder anchored on shared template
// boilerplate instead of subject name).
const SESSION_ACTIVITIES = ['standup notes', 'a Friday writeup', 'a Monday huddle', 'a sprint retro', 'a planning sync', 'a backlog grooming'];
const SESSION_OUTCOMES = ['action items logged', 'follow-ups assigned', 'a doc updated', 'tickets filed', 'a ticket closed', 'a new note created'];

// 2026-06-01 v10: project-name restructure (operator path C). The prior `${TOPIC}-svc-${idx}`
// pattern (e.g. "auth-refresh-svc-1761") created a BGE-M3 compound-name cluster: at 1500
// project subjects across 6 TOPICS, each topic-prefix had 250 docs that share exact leading
// tokens, leaving only the trailing digit to disambiguate — and BGE-M3 dim 243 int8 cannot
// distinguish digit-suffixes reliably (this was the root cause of decision_provenance Stage A
// 0.32x and multi_session_bridge Stage A 1.05x at 100k v8c). New names use 4 semantic tokens
// (adjective + domain + service-type + 3-hex suffix) for ~49M unique combinations vs ~1500
// subjects → zero collision. Each subject gets a SEMANTICALLY DISTINCT natural-language name.
const PROJ_ADJ = ['Granite', 'Velvet', 'Copper', 'Sapphire', 'Cinder', 'Maple', 'Cobalt', 'Ember', 'Flint', 'Glade', 'Harbor', 'Ivory', 'Juniper', 'Kestrel', 'Larch', 'Mocha', 'Nimbus', 'Opal', 'Pebble', 'Quartz', 'Ridge', 'Sage', 'Thistle', 'Umbra', 'Verdant', 'Wren', 'Xenon', 'Yarrow', 'Zephyr', 'Amber', 'Bramble', 'Cedar', 'Driftwood', 'Echo', 'Fjord', 'Glacier', 'Hazel', 'Iris', 'Jade', 'Klein'];
const PROJ_DOMAIN = ['Billing', 'Auth', 'Search', 'Imaging', 'Export', 'Onboarding', 'Notification', 'Inventory', 'Reporting', 'Analytics', 'Webhook', 'Sync', 'Archive', 'Ingest', 'Discovery', 'Telemetry', 'Catalog', 'Dispatch', 'Replay', 'Audit'];
const PROJ_TYPE = ['Pipeline', 'Forge', 'Gateway', 'Hub', 'Ledger', 'Queue', 'Stack', 'Engine', 'Bridge', 'Console', 'Workbench', 'Mill', 'Bank', 'Loom', 'Vault'];
function projectName(s, seed) {
  const h = createHash('sha256').update(`proj-name:${seed}:${s}`).digest('hex');
  const adj = PROJ_ADJ[parseInt(h.slice(0, 4), 16) % PROJ_ADJ.length];
  const dom = PROJ_DOMAIN[parseInt(h.slice(4, 8), 16) % PROJ_DOMAIN.length];
  const typ = PROJ_TYPE[parseInt(h.slice(8, 12), 16) % PROJ_TYPE.length];
  const suffix = h.slice(12, 15).toUpperCase();
  return `${adj} ${dom} ${typ} ${suffix}`;
}
// Per-subject natural project-context phrase: a short descriptive tag that adds
// discriminative natural-language content to project anchor docs (decision, bridge_seed,
// conflict). Per operator: "Ensure decision/multi-session/conflict anchors contain
// discriminative natural project context."
const PROJ_CONTEXT = ['internal-tools group', 'platform-services group', 'infrastructure team', 'data-platform org', 'customer-facing group', 'developer-experience team', 'reliability org', 'partner-integrations team', 'commerce platform', 'observability stack'];
function projectContext(s, seed) {
  const h = createHash('sha256').update(`proj-ctx:${seed}:${s}`).digest('hex');
  return PROJ_CONTEXT[parseInt(h.slice(0, 4), 16) % PROJ_CONTEXT.length];
}
// Per-subject token derivation. Uses subject index `s` + SEED for byte-deterministic uniqueness.
// codename / infraTag namespaces are ENORMOUS (20*20*99*hex6) so cross-subject collisions are
// vanishingly rare even at 300k subjects. None of these tokens duplicate the subject's canonical
// name, so "ROUTING-REQUIRED" docs that previously omitted canonical can keep doing so.
function subjectTokens(s, seed) {
  const hexTag = createHash('sha256').update(`subj-tokens:${seed}:${s}`).digest('hex');
  return {
    codename: `${COLORS[s % COLORS.length]}-${ANIMALS[(s * 7 + 3) % ANIMALS.length]}-${(s % 99).toString().padStart(2, '0')}`,
    infraTag: `ix-${hexTag.slice(0, 6)}`,
    deployId: `deploy-${(1000 + s).toString()}`,
    region: REGIONS[s % REGIONS.length],
    quarter: QUARTERS[(s * 3 + 1) % QUARTERS.length],
    month: MONTHS[(s + 2) % MONTHS.length],
    year: 2020 + (s % 6),
    version: `v${1 + (s % 9)}.${(s * 7) % 9}.${(s * 11) % 9}`,
    pet: PETS[s % PETS.length],
    professional: PROFESSIONALS[(s * 5) % PROFESSIONALS.length],
    cause: CAUSES[(s * 9 + 2) % CAUSES.length],
  };
}

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
// PUBLIC subject grounding: the subject entity a query is ABOUT (set per-subject below). Emitted on
// every query so the scorer resolves the subject by exact id, not by name text (canonical names
// collide up to 112-way at 300k → name matching floods r5 policy admission = the "zero signal" bug).
let CURRENT_SUBJECT_ID = null;
function addQuery(q) { const id = qId(); const split = splitFor(id); queries.push({ id, split, ownerScoped: true, ...(CURRENT_SUBJECT_ID ? { subjectEntityId: CURRENT_SUBJECT_ID } : {}), ...q }); return id; }
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
    CURRENT_SUBJECT_ID = subjId; // public grounding for every query about this subject
    const job = pick(JOBS), city = pick(CITIES);
    // v10: high-distance project naming (operator path C). See PROJ_ADJ/PROJ_DOMAIN/PROJ_TYPE.
    const projName = projectName(s, SEED);
    const projCtx = projectContext(s, SEED);
    const canonical = isProject ? projName : `${first} ${last}`;
    // UNIQUE alias: include a disambiguator so coreference is well-posed even when first names repeat
    const role = isProject ? `the ${pick(STACKS)} service` : `the ${job} in ${city}`;
    addEntity(subjId, canonical, isProject ? [projName] : [first, `${first} the ${job}`], universe === universe ? 'deep_universe' : 'deep_universe');
    const tagU = (extra = []) => [universe, subjId, ...extra];
    // Per-subject stable semantic tokens (see subjectTokens definition near banks).
    const tok = subjectTokens(s, SEED);

    // v11: intro doc drops "is a ${job}" AND "${first} the ${job}" patterns — the v10 100k
    // miss-dumps showed intro docs flooded multi_session "job of sibling" queries because
    // each of 1500 intro docs contained the "job" token + name pattern. Job-alias mapping
    // moved EXCLUSIVELY to coref doc (one per person, 1500 total) to limit job-token flood.
    const introId = addDoc({ lane: 'deep', kind: 'intro', entityIds: tagU(),
      text: isProject
        ? `Project ${canonical} is ${role} in ${tok.region}. ${canonical}'s codename is ${tok.codename}; the platform team has owned ${canonical} since ${tok.quarter}.`
        : `${canonical} is based in ${city} (region ${tok.region}); ${canonical} sometimes goes by ${first}. Account ${tok.codename}.`,
      shape: 'intro_record', timestamp: ts(0), currentStaleFlag: true });

    // ── deep session filler (same-universe distractors) ──
    // 2026-05-31 v5 retrieval-health fix:
    //  - Halve session count (DEPTH/2 + small jitter) — sessions were ~50% of corpus, drowning
    //    truth docs in top-K via shared phrasal patterns.
    //  - Use per-subject UNIQUE codename + infraTag + sessTag as the dominant lex content;
    //    keep filler phrases minimal so no phrasal pattern repeats heavily across subjects.
    //  - Canonical NOT repeated: sessions are distractors, not truth.
    const nSessions = Math.max(4, Math.floor(DEPTH / 2)) + ri(Math.max(2, Math.floor(DEPTH / 4)));
    const sessionDocIds = [];
    for (let k = 0; k < nSessions; k++) {
      const topic = pick(TOPICS);
      const sessTag = `s${(k + 1).toString().padStart(3, '0')}`;
      const sessMonth = MONTHS[(s + k * 5) % MONTHS.length];
      const did = addDoc({ lane: 'deep', kind: 'session', entityIds: tagU(),
        text: isProject
          ? `Note ${sessTag} (${tok.codename}, ${sessMonth} ${tok.year}): ${topic} log entry, infra ${tok.infraTag}.`
          : `Note ${sessTag} (${tok.codename}, ${sessMonth} ${tok.year}): ${topic} reminder.`,
        shape: 'session_memory', timestamp: ts(1 + ri(36)), currentStaleFlag: true });
      sessionDocIds.push(did);
      if (chance(0.5)) rel(did, introId, 'context_of');
    }

    // ── FAMILY 1: temporal_update (3-10 revisions, supersedes chain) ──
    // 2026-05-31 v6: deterministic 4-shape rotation per subject — same intent-mirror
    // ("current X is Y" / "previously was Y") but different syntactic positions so the
    // template doesn't form a single embedding cluster across 300 subjects.
    {
      // v7b: 3-5 revisions instead of 3-10 to halve the temporal-template corpus volume that
      // was flooding top-K for other families (conflict/decision/multi_session misses all had
      // wrong-subject temporal stale docs as top-1). Temporal surface still tested per subject.
      const nRev = 3 + ri(3); // 3-5
      const attr = isProject ? 'package manager' : 'city';
      const valBank = isProject ? PKGS : CITIES;
      const tShape = s % 4;
      let prev = null; const chain = [];
      for (let r = 0; r < nRev; r++) {
        const isCurrent = r === nRev - 1;
        const val = valBank[(s + r) % valBank.length];
        const revMonth = MONTHS[(s + r * 3) % MONTHS.length];
        const revYear = tok.year + Math.floor(r / 4);
        const codeLabel = isProject ? `codename ${tok.codename}` : `account ${tok.codename}`;
        let text;
        if (tShape === 0) {
          text = isCurrent
            ? `${canonical}'s current ${attr} is ${val} (since ${revMonth} ${revYear}, ${codeLabel}).`
            : `${canonical}'s ${attr} was previously ${val} (set ${revMonth} ${revYear}, ${codeLabel}).`;
        } else if (tShape === 1) {
          text = isCurrent
            ? `As of ${revMonth} ${revYear}, ${canonical} uses ${val} for its ${attr} (${codeLabel}).`
            : `Earlier, ${val} served as ${canonical}'s ${attr} (${revMonth} ${revYear}, ${codeLabel}).`;
        } else if (tShape === 2) {
          text = isCurrent
            ? `${val} is now ${canonical}'s ${attr}; effective ${revMonth} ${revYear} (${codeLabel}).`
            : `${val} used to be ${canonical}'s ${attr} until a later switch (${revMonth} ${revYear}, ${codeLabel}).`;
        } else {
          text = isCurrent
            ? `${canonical} adopted ${val} as its current ${attr} in ${revMonth} ${revYear} (${codeLabel}).`
            : `${canonical} once had ${val} as its ${attr} (${revMonth} ${revYear}, ${codeLabel}).`;
        }
        const did = addDoc({ lane: 'deep', kind: `temporal_${attr}`, entityIds: tagU(),
          text,
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
    // 2026-05-31 v6: same 4-shape rotation as temporal_update, intent-mirror "currently
    // follows" / "previously followed" but varied syntactic shape per subject.
    if (!isProject) {
      // v7b: 3-4 revisions (was 3-9) — same flood reduction as temporal_update.
      const nRev = 3 + ri(2);
      const tShape = s % 4;
      let prev = null; const chain = [];
      for (let r = 0; r < nRev; r++) {
        const isCurrent = r === nRev - 1;
        const diet = DIETS[(s + r * 2) % DIETS.length];
        const revMonth = MONTHS[(s * 2 + r * 5) % MONTHS.length];
        const revYear = tok.year + Math.floor(r / 3);
        let text;
        if (tShape === 0) {
          text = isCurrent
            ? `${canonical} currently follows a ${diet} diet (since ${revMonth} ${revYear}, case ${tok.codename}).`
            : `${canonical} previously followed a ${diet} diet (${revMonth} ${revYear}, case ${tok.codename}).`;
        } else if (tShape === 1) {
          text = isCurrent
            ? `${canonical}'s current diet is ${diet}, adopted in ${revMonth} ${revYear} (case ${tok.codename}).`
            : `${canonical}'s diet was earlier ${diet} (around ${revMonth} ${revYear}, case ${tok.codename}).`;
        } else if (tShape === 2) {
          text = isCurrent
            ? `${diet} is now ${canonical}'s diet of record (effective ${revMonth} ${revYear}, case ${tok.codename}).`
            : `${diet} used to be ${canonical}'s diet of record (${revMonth} ${revYear}, case ${tok.codename}).`;
        } else {
          text = isCurrent
            ? `As of ${revMonth} ${revYear}, ${canonical} is on a ${diet} diet (case ${tok.codename}).`
            : `Earlier, ${canonical} was on a ${diet} diet (${revMonth} ${revYear}, case ${tok.codename}).`;
        }
        const did = addDoc({ lane: 'deep', kind: 'temporal_diet', entityIds: tagU(),
          text,
          shape: 'temporal_update_record', timestamp: ts(3 + r * 4), currentStaleFlag: isCurrent });
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
      // Distant text MUST omit canonical (routing-required), but it can carry per-subject
      // codename/infraTag/region tokens so each "distant" doc is uniquely embeddable. The
      // canonical-bearing bridge SEED below is still the only way a query about ${canonical}
      // links to the answer (canonical is in seed text + supports/depends_on edge does the work).
      const answerDoc = addDoc({ lane: 'deep', kind: 'bridge_answer', entityIds: tagU(),
        text: isProject
          ? (partial
              ? `${canonical}'s data layer runs on a ${attrVal} cluster (${tok.region}, ${tok.version}); ${canonical} owns that ${attrVal} backend.`
              : `The ${tok.codename} platform layer runs on a ${attrVal} cluster (${tok.region}, ${tok.version}); infra ${tok.infraTag}.`)
          : (partial
              ? `${sibName}, ${canonical}'s sibling, works as a ${attrVal} (${tok.region} crew, id ${tok.infraTag}).`
              : `${sibName} works as a ${attrVal} (${tok.codename}, ${tok.region}); team id ${tok.infraTag}.`),
        shape: 'bridge_record', timestamp: ts(5 + ri(20)), currentStaleFlag: true });
      // v10: project bridge_seed includes per-subject natural context phrase (projCtx) for
      // discriminative anchoring (operator path C). People bridge_seed unchanged from v8c.
      const bridgeDoc = addDoc({ lane: 'deep', kind: 'bridge_seed', entityIds: tagU(),
        text: isProject
          ? `${canonical} (${projCtx}) depends on its datastore at the ${tok.codename} backend in ${tok.region}.`
          : `${canonical}'s sibling ${sibName} has a different job (contact ${tok.infraTag}, ${tok.region}).`,
        shape: 'bridge_seed', timestamp: ts(4 + ri(10)), currentStaleFlag: true });
      rel(bridgeDoc, answerDoc, isProject ? 'depends_on' : 'supports');
      const nDist = 1 + ri(3);
      addQuery({ lane: 'deep', family: 'multi_session_bridge', grounding: partial ? 'partial' : 'distant',
        queryText: isProject ? `What datastore does ${canonical} depend on?` : `What is the job of ${canonical}'s sibling?`,
        qrels: [{ docId: answerDoc, relevance: 1.0, role: 'direct' }, { docId: bridgeDoc, relevance: 0.4, role: 'bridge' }],
        hardNegatives: [{ docId: introId, category: 'relation_neighbor' }], ownerEntityId: universe, band: band(4, nDist, chance(0.15)) });
    }

    // ── FAMILY 4: decision_provenance (reason → outcome) ──
    if (isProject) {
      const fromDb = pick(DBS), incident = pick(ERRORS);
      // v11: lead decision text with the exact query-anchor phrase "${canonical}'s datastore
      // migration" — query says "Why did X migrate its datastore?" so the truth that LEADS
      // with "X's datastore migration:" will lex-anchor against the temporal-stale "X's city
      // was previously Y" flood that beat decision at v10 100k.
      const decisionText = `${canonical}'s datastore migration: ${canonical} moved off ${fromDb} after the ${tok.quarter} planning review (${projCtx}, codename ${tok.codename}).`;
      const decision = addDoc({ lane: 'deep', kind: 'decision', entityIds: tagU(),
        text: decisionText,
        shape: 'decision_record', timestamp: ts(6 + ri(10)), currentStaleFlag: true });
      // Reason is the DISTANT doc (no canonical); per-subject codename + infraTag + cause
      // keep it unique while remaining routing-required (canonical only via decision_reason edge).
      const reason = addDoc({ lane: 'deep', kind: 'decision_reason', entityIds: tagU(),
        text: `Repeated ${incident} incidents traced to ${tok.infraTag} drove the ${tok.codename} migration; root cause was ${tok.cause}, escalating through ${tok.quarter}.`,
        shape: 'decision_reason', timestamp: ts(6 + ri(10)), currentStaleFlag: true });
      const outcome = addDoc({ lane: 'deep', kind: 'decision_outcome', entityIds: tagU(),
        text: `After the migration in ${tok.month} ${tok.year}, ${canonical} saw latency drop; ${incident}-class incidents on ${canonical}'s stack fell to weekly checks (${tok.region}, codename ${tok.codename}).`,
        shape: 'decision_outcome', timestamp: ts(8 + ri(8)), currentStaleFlag: true });
      rel(reason, decision, 'decision_reason'); rel(outcome, decision, 'decision_outcome');
      addQuery({ lane: 'deep', family: 'decision_provenance', queryText: `Why did ${canonical} migrate its datastore?`,
        qrels: [{ docId: reason, relevance: 1.0, role: 'direct' }, { docId: decision, relevance: 0.4, role: 'bridge' }],
        hardNegatives: [{ docId: outcome, category: 'relation_neighbor' }], ownerEntityId: universe, band: band(3, 2, chance(0.2)) });
    }

    // ── FAMILY 5: workflow_gotcha / fixes (causes edge) — ROUTING-REQUIRED ──
    // The FIX doc states the remedy without naming the subject (distant from the
    // subject+error query); reachable only via the `fixes` edge from the findable
    // error/gotcha SEED that names the subject.
    if (isProject) {
      const err = pick(ERRORS), envv = pick(ENVVARS);
      // Fix is the DISTANT doc; per-subject codename + deployId + region preserve uniqueness
      // while the canonical-bearing gotcha SEED stays the only anchor query can match.
      const fixDoc = addDoc({ lane: 'deep', kind: 'fix', entityIds: tagU(),
        text: `Setting ${envv} correctly before warmup resolved the deploy failure on the ${tok.codename} ${tok.deployId} (${tok.region}); root cause was ${tok.cause}, infra ${tok.infraTag}.`,
        shape: 'fix_record', timestamp: ts(7 + ri(12)), currentStaleFlag: true });
      // Gotcha seed: canonical 2x, error verbatim from query, codename for uniqueness.
      const errDoc = addDoc({ lane: 'deep', kind: 'gotcha', entityIds: tagU(),
        text: `${canonical} hit a ${err} during the ${tok.codename} deploys in ${tok.quarter}; ${canonical}'s team filed the incident under ${tok.deployId}.`,
        shape: 'gotcha_record', timestamp: ts(6 + ri(12)), currentStaleFlag: true });
      rel(fixDoc, errDoc, 'fixes');
      addQuery({ lane: 'deep', family: 'causal_memory_chain', queryText: `How was the ${err} in ${canonical} resolved?`,
        qrels: [{ docId: fixDoc, relevance: 1.0, role: 'direct' }, { docId: errDoc, relevance: 0.4, role: 'bridge' }],
        hardNegatives: [{ docId: introId, category: 'relation_neighbor' }], ownerEntityId: universe, band: band(3, 1, false) });
    }

    // ── FAMILY 6: coreference_resolution (alias/role → canonical) ──
    // v8c form (v9 canonical-led parenthetical regressed coref from 3.72x to 2.27x at 100k).
    if (!isProject) {
      const corefDoc = addDoc({ lane: 'deep', kind: 'coref_fact', entityIds: tagU(),
        text: `${first} the ${job}, also known as ${canonical}, has a pet named ${tok.pet} (case ${tok.codename}).`,
        shape: 'coref_record', timestamp: ts(9 + ri(6)), currentStaleFlag: true });
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
      // Distinct cities so the "corrected" value never equals the original (degenerate conflict =
      // no contradiction to discover). Same RNG draw count as before; collision falls back to the
      // next city deterministically.
      const cityA = pick(CITIES);
      let cityB = pick(CITIES);
      if (cityB === cityA) cityB = CITIES[(CITIES.indexOf(cityA) + 1) % CITIES.length];
      const scopedA = isProject ? cityA : `${cityA} family clinic`;
      const scopedB = isProject ? cityB : `${cityB} specialist clinic`;
      const stableScope = isProject ? 'production' : 'weekday care';
      // 2026-05-31 v8 fix: 8-shape rotation with VARIED structural positions for
      // canonical/scope/attr/value — v7's "leading prefix" became a 1500-doc cluster
      // attracting any name-like query. Each shape places canonical/attr/scope/value in
      // different syntactic positions so no single structural pattern dominates >12.5% of
      // conflict docs across 1500 project + 1500 person subjects.
      const otherScope = isProject ? 'staging' : 'weekend care';
      const cs = s % 8;
      const cap = (str) => str.charAt(0).toUpperCase() + str.slice(1);
      const csCap = cap(stableScope);
      const coCap = cap(otherScope);
      let conflictAText, conflictBText, scopeDocText;
      // v10: shape 0 includes projCtx for projects only (people don't have a project context).
      const ctxParen = isProject ? `, ${projCtx}` : '';
      if (cs === 0) {
        conflictAText = `${canonical}${ctxParen} once used ${scopedA} for ${stableScope} ${conflictAttr} (${tok.quarter}, ${tok.codename}).`;
        conflictBText = `${canonical}${ctxParen} now uses ${scopedB} for ${stableScope} ${conflictAttr}, replacing ${scopedA} (${tok.month} ${tok.year}, ${tok.codename}).`;
        scopeDocText  = `${canonical}${ctxParen} keeps ${scopedA} for ${otherScope} ${conflictAttr} (separate from ${stableScope}, ${tok.codename}).`;
      } else if (cs === 1) {
        conflictAText = `Previously ${scopedA} was the ${stableScope} ${conflictAttr} for ${canonical} (${tok.quarter}, ${tok.codename}).`;
        conflictBText = `Currently ${scopedB} is the ${stableScope} ${conflictAttr} for ${canonical} (replaced ${scopedA}, ${tok.month} ${tok.year}, ${tok.codename}).`;
        scopeDocText  = `On ${otherScope}, ${canonical}'s ${conflictAttr} stays ${scopedA} (independent of ${stableScope}, ${tok.codename}).`;
      } else if (cs === 2) {
        conflictAText = `${tok.codename}: ${canonical}'s ${stableScope} ${conflictAttr} was ${scopedA} (${tok.quarter}).`;
        conflictBText = `${tok.codename}: ${canonical}'s ${stableScope} ${conflictAttr} is now ${scopedB}, switched from ${scopedA} (${tok.month} ${tok.year}).`;
        scopeDocText  = `${tok.codename}: ${canonical}'s ${otherScope} ${conflictAttr} remains ${scopedA} (separate ${stableScope}).`;
      } else if (cs === 3) {
        conflictAText = `${canonical}'s ${stableScope} ${conflictAttr}: prior value ${scopedA} (${tok.quarter}, ${tok.codename}).`;
        conflictBText = `${canonical}'s ${stableScope} ${conflictAttr}: current value ${scopedB}, switched from ${scopedA} (${tok.month} ${tok.year}, ${tok.codename}).`;
        scopeDocText  = `${canonical}'s ${otherScope} ${conflictAttr}: kept at ${scopedA} (distinct from ${stableScope}, ${tok.codename}).`;
      } else if (cs === 4) {
        conflictAText = `Earlier on ${stableScope}, ${canonical} had ${scopedA} as its ${conflictAttr} (${tok.quarter}, ${tok.codename}).`;
        conflictBText = `As of ${tok.month} ${tok.year}, ${canonical}'s ${stableScope} ${conflictAttr} is ${scopedB} (was ${scopedA}, ${tok.codename}).`;
        scopeDocText  = `For ${otherScope}, ${canonical} has ${scopedA} as its ${conflictAttr} (not the ${stableScope} value, ${tok.codename}).`;
      } else if (cs === 5) {
        conflictAText = `${scopedA} was assigned to ${canonical} for ${stableScope} ${conflictAttr} (${tok.quarter}, ${tok.codename}).`;
        conflictBText = `${scopedB} is now assigned to ${canonical} for ${stableScope} ${conflictAttr}, in place of ${scopedA} (${tok.month} ${tok.year}, ${tok.codename}).`;
        scopeDocText  = `${scopedA} is assigned to ${canonical} for ${otherScope} ${conflictAttr} (not ${stableScope}, ${tok.codename}).`;
      } else if (cs === 6) {
        conflictAText = `${canonical} ran ${scopedA} for ${stableScope} ${conflictAttr} in ${tok.quarter} (codename ${tok.codename}).`;
        conflictBText = `${canonical} runs ${scopedB} for ${stableScope} ${conflictAttr} as of ${tok.month} ${tok.year}, replacing ${scopedA} (codename ${tok.codename}).`;
        scopeDocText  = `${canonical} runs ${scopedA} for ${otherScope} ${conflictAttr}, separate from ${stableScope} (codename ${tok.codename}).`;
      } else {
        conflictAText = `${canonical} mapped ${stableScope} ${conflictAttr} to ${scopedA} (${tok.quarter}, ${tok.codename}).`;
        conflictBText = `${canonical} maps ${stableScope} ${conflictAttr} to ${scopedB} now, from earlier ${scopedA} (${tok.month} ${tok.year}, ${tok.codename}).`;
        scopeDocText  = `${canonical} maps ${otherScope} ${conflictAttr} to ${scopedA}, kept apart from ${stableScope} (${tok.codename}).`;
      }
      const conflictA = addDoc({ lane: 'deep', kind: 'lifecycle_conflict', entityIds: tagU(),
        text: conflictAText,
        shape: 'lifecycle_conflict_record', timestamp: ts(12 + ri(12)), currentStaleFlag: true,
        lifecycleState: 'conflict_candidate', lifecycleScope: stableScope });
      const conflictB = addDoc({ lane: 'deep', kind: 'lifecycle_conflict', entityIds: tagU(),
        text: conflictBText,
        shape: 'lifecycle_conflict_record', timestamp: ts(13 + ri(12)), currentStaleFlag: true,
        lifecycleState: 'conflict_resolved', lifecycleScope: stableScope });
      const scopeDoc = addDoc({ lane: 'deep', kind: 'lifecycle_scope', entityIds: tagU(),
        text: scopeDocText,
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
      // v5b: don't use DIETS as aspect-other value for people — collided with temporal_diet
      // queries (top-2 for "Diego Reyes diet" was Omar Mensah's aspect doc saying "DASH support").
      const otherVal = isProject ? `$${ri(900) + 100}/month` : `${ri(2) + 1} hours/week`;
      // Aspect lives in aspectTags, NOT entityIds. tagU expects an ARRAY and spreads it; the
      // old code passed the aspect STRING and it was spread char-by-char into entityIds
      // ("latency" → ["l","a","t","e","n","c","y"]). Aspect is the QUERY's intentAspect filter,
      // not an entity reference; entityIds carries just universe + subject.
      // 2026-05-31 v5 fix: revert "For X, ..." prefix (shared template across aspect+conflict
      // was a top bi-encoder anchor). Keep canonical as natural sentence subject; carry the
      // aspect word + value as the discriminative content. Drop the second sentence — fewer
      // tokens means more weight on subject + aspect.
      const aspectDoc = addDoc({ lane: 'deep', kind: 'aspect_answer', entityIds: tagU(),
        text: `${canonical}'s ${aspectWanted} measurement is ${wantedVal} as of ${tok.quarter} (codename ${tok.codename}, ${tok.version}).`,
        shape: 'aspect_answer_record', timestamp: ts(15 + ri(12)), currentStaleFlag: true,
        aspectTags: [aspectWanted, aspectOther] });
      const wrongAspectDoc = addDoc({ lane: 'deep', kind: 'aspect_neighbor', entityIds: tagU(),
        text: `${canonical}'s ${aspectOther} measurement is ${otherVal} per the ${tok.month} ${tok.year} review (codename ${tok.codename}).`,
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
      // 2026-05-31 v5 fix: the v4 "but the final value was not recorded in this memory" tail
      // was a magnet for any "What is X's Y?" query — top-3 across temporal/conflict misses
      // were abstain docs for unrelated subjects. Keep the per-subject anchor, drop the
      // open-ended denial phrase that pattern-matched too many queries.
      const missingTopic = isProject ? 'rollback owner' : 'emergency contact';
      const distractA = addDoc({ lane: 'deep', kind: 'abstain_distractor', entityIds: tagU(),
        text: `${canonical} planning note from ${tok.month} ${tok.year} touched ${missingTopic} only in passing (codename ${tok.codename}).`,
        shape: 'abstain_context_record', timestamp: ts(16 + ri(12)), currentStaleFlag: true });
      const distractB = addDoc({ lane: 'deep', kind: 'abstain_distractor', entityIds: tagU(),
        text: `${canonical} adjacent ${pick(TOPICS)} notes around ${tok.quarter} did not cover ${missingTopic} (codename ${tok.codename}, infra ${tok.infraTag}).`,
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
