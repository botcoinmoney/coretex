#!/usr/bin/env node
/**
 * CoreTex Memory Corpus V2 — P0 generator (logical layer).
 *
 * Emits the *logical* corpus (docs + queries + public relations + entities) per
 * `CORETEX_MEMORY_CORPUS_V2_SPEC.md`. Embeddings + production-v1 packing happen
 * in a separate step (embed-memory-corpus-v2.mjs) so content is lint-validated
 * before paying the BGE-M3 cost.
 *
 * Blended long-term agent memory:
 *   - conversational lane (~60%): synthetic personal-assistant users
 *   - agent_workflow lane (~40%): synthetic coding projects
 * Deliberate cross-entity name/attribute collisions provide realistic hard
 * negatives. Currency is curated metadata (timestamp/supersedes/currentStaleFlag),
 * never label text. No analytics shapes. Every answer is a stored memory.
 *
 * Usage: node scripts/generate-memory-corpus-v2.mjs [--users N] [--projects M]
 *        [--seed S] [--out path]
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Explicit split assignment (P1.5 #1): deterministic 70/10/15/5
// train_visible/calibration/eval_hidden/canary. No split=null anywhere.
function splitFor(id, seed) {
  const h = parseInt(createHash('sha256').update(`${seed}:${id}`).digest('hex').slice(0, 8), 16) % 100;
  if (h < 70) return 'train_visible';
  if (h < 80) return 'calibration';
  if (h < 95) return 'eval_hidden';
  return 'canary';
}

// ── deterministic RNG (mulberry32 seeded from string) ──
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = process.argv.slice(2);
const argVal = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const N_USERS = parseInt(argVal('--users', '15'), 10);
const N_PROJECTS = parseInt(argVal('--projects', '10'), 10);
const SEED = argVal('--seed', 'p0-2026-05-21');
const OUT = argVal('--out', 'release/calibration/2026-05-21-memory-corpus-v2/p0-corpus.json');

const rand = mulberry32(hashSeed(SEED));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const pickN = (arr, n) => { const c = [...arr]; const o = []; while (o.length < n && c.length) o.push(c.splice(Math.floor(rand() * c.length), 1)[0]); return o; };
const chance = (p) => rand() < p;
const choice = (...variants) => variants[Math.floor(rand() * variants.length)];

// ── banks ──
// First names with DELIBERATE reuse (collisions drive entity_disambiguation).
const FIRST = ['Maya', 'Alex', 'Priya', 'Jordan', 'Sam', 'Lena', 'Diego', 'Aisha', 'Tom', 'Nina',
  'Priya', 'Sam', 'Maya', 'Omar', 'Grace', 'Ravi', 'Elena', 'Jordan', 'Yuki', 'Carlos',
  'Hana', 'Marcus', 'Aisha', 'Leo', 'Sofia'];
const LAST = ['Chen', 'Nadar', 'Sharma', 'Okafor', 'Reyes', 'Petrov', 'Kim', 'Haddad', 'Singh', 'Rossi',
  'Mueller', 'Ito', 'Diallo', 'Costa', 'Larsen', 'Mensah', 'Park', 'Novak', 'Tanaka', 'Vega'];
const CITIES = ['Seattle', 'Austin', 'Denver', 'Portland', 'Chicago', 'Boston', 'Atlanta', 'Toronto', 'Lisbon', 'Berlin'];
const HOMETOWNS = ['Sacramento', 'Tucson', 'Cleveland', 'Fresno', 'Spokane', 'Akron', 'Boise', 'Reno', 'Tulsa', 'Albany'];
const JOBS = ['UX designer', 'data analyst', 'ER nurse', 'high-school teacher', 'civil engineer',
  'product manager', 'pastry chef', 'physical therapist', 'accountant', 'graphic illustrator',
  'paralegal', 'marine biologist', 'sound engineer', 'librarian', 'tax consultant'];
const COMPANIES = ['a fintech startup', 'a regional hospital', 'a logistics firm', 'a design agency',
  'a public school', 'a renewable-energy company', 'a boutique bakery', 'a law office'];
const CARS = ['a blue Subaru Outback', 'a silver Honda Civic', 'a red Mazda3', 'an old Volvo wagon',
  'a white Toyota Prius', 'a green Jeep Wrangler', 'a black Tesla Model 3'];
const PETS = [['border collie', 'Pepper'], ['border collie', 'Scout'], ['tabby cat', 'Mochi'],
  ['golden retriever', 'Biscuit'], ['tabby cat', 'Pixel'], ['parrot', 'Mango'],
  ['beagle', 'Cooper'], ['rabbit', 'Clover'], ['golden retriever', 'Sunny'], ['corgi', 'Pickle']];
const DIETS_OLD = ['keto', 'a strict paleo diet', 'intermittent fasting', 'a low-FODMAP plan'];
const DIETS_NEW = ['a pescatarian diet, eating fish but no other meat', 'a fully vegetarian diet',
  'a Mediterranean diet', 'a gluten-free diet after an intolerance diagnosis'];
const COFFEE = ['black with no sugar', 'a flat white with oat milk', 'an iced americano',
  'a cortado, no sugar', 'drip coffee with a splash of cream'];
const RESTAURANTS_OLD = ['Tavolo, an Italian spot downtown', 'the ramen place on 5th',
  'a taqueria near the office', 'the old French bistro by the park'];
const RESTAURANTS_NEW = ['Bestia', 'a new Thai place called Soi', 'the wood-fired pizza spot Ember',
  'a Korean BBQ joint called Ssam'];
const TRIP_DEST = ['Japan', 'Portugal', 'New Zealand', 'Iceland', 'Vietnam', 'Patagonia'];
const TRIP_MONTH = ['October', 'March', 'December', 'July', 'September'];
const BOOKS = [['Project Hail Mary', 'Andy Weir', 'science fiction'],
  ['The Overstory', 'Richard Powers', 'literary fiction'],
  ['Klara and the Sun', 'Kazuo Ishiguro', 'science fiction'],
  ['Pachinko', 'Min Jin Lee', 'historical fiction'],
  ['The Three-Body Problem', 'Cixin Liu', 'science fiction'],
  ['Circe', 'Madeline Miller', 'mythological fiction']];
const HOBBIES = ['bouldering every Tuesday evening', 'pottery classes on weekends',
  'training for a half-marathon', 'learning the cello', 'urban sketching', 'birdwatching',
  'baking sourdough', 'sea kayaking in the summer'];
const ALLERGIES = ['mildly lactose intolerant and skips milk', 'allergic to shellfish',
  'gluten-sensitive', 'allergic to tree nuts'];
const SIBLING_REL = ['younger brother', 'older brother', 'younger sister', 'older sister'];
const COLLEGES = ['the University of Washington', 'Oberlin College', 'Georgia Tech', 'NYU', 'Reed College'];
const MAJORS = ['marine biology', 'mechanical engineering', 'comparative literature',
  'computer science', 'environmental policy', 'music composition'];
const EPISODIC = [
  'watched a documentary about coral reefs and loved it',
  'mentioned their fiddle-leaf fig finally put out a new leaf',
  'tried a new sourdough recipe over the weekend',
  'is repainting the spare bedroom a soft sage green',
  'got really into a podcast about ancient Rome',
  'started a small balcony herb garden',
  'is planning a surprise party for a friend',
  'switched to a standing desk and likes it',
  'adopted a no-phones rule at dinner',
  'is learning to make hand-pulled noodles',
  'volunteered at a beach cleanup last month',
  'is reorganizing their bookshelf by color',
  'took up indoor cycling for the winter',
  'is trying to read one poem every morning',
  'finally fixed the squeaky cabinet door',
  'has been waking up at 6am to journal',
  'is trying to cut back on screen time before bed',
  'got a new pair of running shoes and broke them in',
  'is saving up for a better espresso machine',
  'mentioned the upstairs neighbor practices drums on Sundays',
  'rearranged the living room to face the window',
  'is taking a beginner watercolor class downtown',
  'started composting kitchen scraps',
  'is binge-watching a Korean cooking show',
  'planted tomatoes that are not doing well',
  'switched dentists after a bad cleaning',
  'is trying to learn a few phrases before the trip',
  'found a great secondhand bookstore near work',
  'is dealing with a slow leak under the kitchen sink',
  'joined a Sunday morning hiking group',
  'is teaching themselves to knit a scarf',
  'finally framed the prints that sat in a closet for a year',
];
// agent-side worklog / runbook filler (provides realistic memory density + noise)
const AGENT_EPISODIC = [
  'bumped the eslint config to the flat format',
  'added a healthcheck endpoint at /healthz',
  'split the monolith CI job into lint, test, and build stages',
  'turned on dependabot for weekly security updates',
  'added structured JSON logging behind a LOG_FORMAT flag',
  'set the request timeout to 30 seconds at the gateway',
  'moved feature flags into a config service',
  'added a pre-commit hook that runs the formatter',
  'documented the local setup in CONTRIBUTING.md',
  'tagged the last release and wrote the changelog',
  'added retry-with-backoff to the outbound webhook client',
  'enabled gzip compression on the static assets',
  'pinned the base Docker image to a digest',
  'added a smoke test that hits the three critical routes',
  'rotated the staging API token after the last contractor left',
  'set up a nightly backup of the staging database',
  'added a rate limiter on the public search endpoint',
  'switched the test runner to run in band to reduce flakiness',
  'added an ADR explaining the queue choice',
  'cleaned up dead feature flags older than two releases',
  'added a metrics dashboard for p95 latency',
  'moved secrets out of the repo into the secret manager',
  'added a CODEOWNERS file for the payments module',
  'set the cache TTL on the product list to five minutes',
  'added a migration to backfill the new status column',
  'wired up Sentry for unhandled promise rejections',
  'added a load test that ramps to 200 concurrent users',
  'documented the on-call escalation steps in the runbook',
  'added a feature flag to gate the new onboarding flow',
  'set up branch protection requiring one approval',
];

// agent banks
const PROJ_NAMES = ['Helios', 'Orion', 'Nimbus', 'Atlas', 'Verdant', 'Quasar', 'Lyra', 'Cobalt',
  'Tundra', 'Maple', 'Beacon', 'Cinder', 'Harbor', 'Pinnacle'];
const WEB_STACKS = ['a Next.js 14 web app deployed on Vercel', 'a SvelteKit app on Cloudflare Pages',
  'a Remix app on Fly.io', 'a Django + HTMX app on Render'];
const DATA_STACKS = ['a Python ETL pipeline orchestrated with Airflow',
  'a Spark batch pipeline on EMR', 'a dbt + Snowflake transformation layer',
  'a Python streaming pipeline using Kafka and Faust'];
const PKG_OLD = ['npm', 'yarn classic', 'pip with requirements.txt', 'poetry'];
const PKG_NEW = ['pnpm', 'yarn berry (PnP)', 'uv', 'pip-tools with a lockfile'];
const DBS_OLD = ['DuckDB', 'SQLite', 'a single Postgres instance', 'MongoDB'];
const DBS_NEW = ['Postgres', 'a Postgres read-replica setup', 'ClickHouse', 'a sharded Postgres cluster'];
const DB_REASON = ['the dataset grew past what fit in memory', 'write contention became a bottleneck',
  'analytics queries needed columnar storage', 'the team needed multi-region replication'];
const ENV_VARS = ['NEXT_PUBLIC_API_URL', 'PUBLIC_API_BASE', 'API_GATEWAY_URL', 'SERVICE_ENDPOINT'];
const ENV_SOURCES = ['the Vercel project environment', 'the Cloudflare dashboard secrets',
  'the Fly.io secrets store', 'the Render environment group'];
const GOTCHAS = [
  ['the checkout end-to-end test', 'it races with the database seed script, so a single rerun almost always goes green'],
  ['the image-upload test', 'it depends on a fixture that is cleaned up too early, so it fails on the first run after a cache wipe'],
  ['the nightly export job', 'it interprets naive datetimes as UTC, so local-time schedules silently shift by the offset'],
  ['the auth integration test', 'it shares a Redis key with another suite and flakes when tests run in parallel'],
];
const SECRETS = ['the warehouse credentials', 'the third-party API keys', 'the signing secret', 'the SMTP password'];
const CI_CACHE = ['caches pip wheels under ~/.cache/pip keyed by the hash of requirements.txt',
  'caches the pnpm store keyed by the lockfile hash', 'reuses a warm Docker layer cache from the previous build',
  'caches the Gradle dependencies between runs'];
const NODE_PINS = [['Node 20', 'Node 18', 'a top-level await in the build script'],
  ['Python 3.12', 'Python 3.10', 'use of the new type-parameter syntax'],
  ['Node 22', 'Node 20', 'the native fetch keepalive default']];

// ── doc / entity / relation / query accumulators ──
const entities = [];
const docs = [];
const relations = [];
const queries = [];
let qseq = 0;

function addEntity(id, canonicalName, aliases, lane) { entities.push({ id, canonicalName, aliases, lane }); }
function addDoc(d) { docs.push(d); return d.id; }
function addRel(src, dst, type) { relations.push({ src, dst, type }); }

// stable-ish timestamps spread over ~16 months
function ts(monthOffset) {
  const base = new Date('2025-01-01');
  const d = new Date(base.getTime() + monthOffset * 30 * 86400000 + Math.floor(rand() * 20) * 86400000);
  return d.toISOString().slice(0, 10);
}

// ── conversational users ──
const userMeta = [];
for (let u = 0; u < N_USERS; u++) {
  const eid = `e_u${u}`;
  const first = FIRST[u % FIRST.length];
  const last = pick(LAST);
  const name = `${first} ${last}`;
  addEntity(eid, name, [first], 'conversational');
  const D = (kind, text, extra = {}) => addDoc({ id: `u${u}_${kind}`, lane: 'conversational', userId: u, kind, text, entityIds: [eid], ...extra });

  const meta = { u, eid, first, last, name, docs: {} };
  meta.docs.job = D('job', `${name} works as ${choice('a', 'an')} ${pick(JOBS)} at ${pick(COMPANIES)}.`, { shape: 'entity_profile', timestamp: ts(0) });
  meta.docs.hometown = D('hometown', `${first} grew up in ${pick(HOMETOWNS)} before moving to ${pick(CITIES)}.`, { shape: 'distilled_fact', timestamp: ts(1) });
  meta.docs.car = D('car', `${first} drives ${pick(CARS)}.`, { shape: 'distilled_fact', timestamp: ts(2) });
  const bm = 1 + Math.floor(rand() * 12), bd = 1 + Math.floor(rand() * 27);
  meta.docs.birthday = D('birthday', `${first}'s birthday is on ${['January','February','March','April','May','June','July','August','September','October','November','December'][bm - 1]} ${bd}.`, { shape: 'distilled_fact', timestamp: ts(3) });
  if (chance(0.6)) { const am = 1 + Math.floor(rand() * 12), ad = 1 + Math.floor(rand() * 27); meta.docs.anniversary = D('anniversary', `${first}'s wedding anniversary is on ${['January','February','March','April','May','June','July','August','September','October','November','December'][am - 1]} ${ad}.`, { shape: 'distilled_fact', timestamp: ts(4) }); }

  // pet + causal vet event
  const [ptype, pname] = PETS[u % PETS.length];
  meta.pet = { ptype, pname };
  meta.docs.pet_intro = D('pet_intro', `${first} adopted ${choice('a', 'a')} ${ptype} named ${pname} in the spring.`, { shape: 'entity_profile', timestamp: ts(2) });
  meta.docs.pet_vet = D('pet_vet', `${pname} needed emergency surgery last month because ${choice('she', 'he')} swallowed a ${choice('sock', 'small toy', 'corn cob')} and it caused a blockage.`, { shape: 'causal_record', timestamp: ts(13) });
  addRel(meta.docs.pet_vet, meta.docs.pet_intro, 'supports');
  addRel(meta.docs.pet_vet, meta.docs.pet_intro, 'causes');

  // sibling: intro + attribute (bridge) + alias (coref)
  const rel = pick(SIBLING_REL);
  const sibFirst = pick(FIRST.filter((f) => f !== first));
  const sibAlias = sibFirst.slice(0, 2); // e.g. "Al" for "Alex"-ish short alias
  meta.sib = { rel, sibFirst, sibAlias };
  meta.docs.sib_intro = D('sib_intro', `${first}'s ${rel} ${sibFirst} started ${choice('his', 'her', 'their')} first year at ${pick(COLLEGES)} this fall.`, { shape: 'entity_profile', timestamp: ts(8) });
  meta.docs.sib_major = D('sib_major', `${sibFirst} declared a major in ${pick(MAJORS)}.`, { shape: 'distilled_fact', timestamp: ts(12) });
  addRel(meta.docs.sib_major, meta.docs.sib_intro, 'supports');
  if (chance(0.7)) {
    meta.docs.sib_alias = D('sib_alias', `${first}: "${sibAlias} is flying home for the holidays, I can't wait."`, { shape: 'raw_dialogue', timestamp: ts(10) });
    addRel(meta.docs.sib_alias, meta.docs.sib_intro, 'coreference_of');
    meta.sib.hasAlias = true;
  }

  // coffee preference (+ decaf refinement)
  meta.docs.coffee = D('coffee', `${first} takes ${choice('her', 'his', 'their')} coffee ${pick(COFFEE)}.`, { shape: 'preference_record', timestamp: ts(1) });
  if (chance(0.5)) meta.docs.coffee_decaf = D('coffee_decaf', `${first} now drinks decaf after 2pm so it doesn't affect ${choice('her', 'his', 'their')} sleep.`, { shape: 'preference_record', timestamp: ts(14) });

  // diet old -> new (temporal)
  const dietOldKind = `diet_old`, dietNewKind = `diet_new`;
  meta.docs.diet_old = addDoc({ id: `u${u}_${dietOldKind}`, lane: 'conversational', userId: u, kind: dietOldKind, text: `${first} said ${choice('she', 'he', 'they')} had been doing ${pick(DIETS_OLD)} for a few months.`, entityIds: [eid], shape: 'temporal_update_record', timestamp: ts(2), currentStaleFlag: false, supersededByDocId: `u${u}_${dietNewKind}` });
  meta.docs.diet_new = addDoc({ id: `u${u}_${dietNewKind}`, lane: 'conversational', userId: u, kind: dietNewKind, text: `${first} mentioned ${choice('she', 'he', 'they')} stopped that and switched to ${pick(DIETS_NEW)}.`, entityIds: [eid], shape: 'temporal_update_record', timestamp: ts(14), currentStaleFlag: true, supersedesDocId: `u${u}_${dietOldKind}` });
  addRel(meta.docs.diet_new, meta.docs.diet_old, 'supersedes');

  // restaurant old -> new (temporal)
  meta.docs.rest_old = addDoc({ id: `u${u}_rest_old`, lane: 'conversational', userId: u, kind: 'rest_old', text: `${first}'s favorite restaurant is ${pick(RESTAURANTS_OLD)}.`, entityIds: [eid], shape: 'preference_record', timestamp: ts(1), currentStaleFlag: false, supersededByDocId: `u${u}_rest_new` });
  meta.docs.rest_new = addDoc({ id: `u${u}_rest_new`, lane: 'conversational', userId: u, kind: 'rest_new', text: `That place closed, so ${first}'s new go-to dinner spot is ${pick(RESTAURANTS_NEW)}.`, entityIds: [eid], shape: 'temporal_update_record', timestamp: ts(13), currentStaleFlag: true, supersedesDocId: `u${u}_rest_old` });
  addRel(meta.docs.rest_new, meta.docs.rest_old, 'supersedes');

  // trip old -> new (temporal / references stale plan)
  const dest = pick(TRIP_DEST), mo = pick(TRIP_MONTH);
  meta.trip = { dest, mo };
  meta.docs.trip_old = addDoc({ id: `u${u}_trip_old`, lane: 'conversational', userId: u, kind: 'trip_old', text: `${first} is planning a two-week trip to ${dest} this ${mo}.`, entityIds: [eid], shape: 'temporal_update_record', timestamp: ts(7), currentStaleFlag: false, supersededByDocId: `u${u}_trip_new` });
  meta.docs.trip_new = addDoc({ id: `u${u}_trip_new`, lane: 'conversational', userId: u, kind: 'trip_new', text: `${first} pushed the ${dest} trip to next spring because of a work deadline.`, entityIds: [eid], shape: 'temporal_update_record', timestamp: ts(15), currentStaleFlag: true, supersedesDocId: `u${u}_trip_old` });
  addRel(meta.docs.trip_new, meta.docs.trip_old, 'supersedes');

  // book specific + broad genre (granularity)
  const [title, author, genre] = BOOKS[u % BOOKS.length];
  meta.book = { title, author, genre };
  meta.docs.book_specific = D('book_specific', `${first} is currently reading ${title} by ${author}.`, { shape: 'distilled_fact', timestamp: ts(15) });
  meta.docs.book_broad = D('book_broad', `${first} generally enjoys ${genre} novels.`, { shape: 'preference_record', timestamp: ts(0) });

  meta.docs.allergy = D('allergy', `${first} is ${pick(ALLERGIES)}.`, { shape: 'distilled_fact', timestamp: ts(9) });
  meta.docs.hobby = D('hobby', `${first} is into ${pick(HOBBIES)}.`, { shape: 'distilled_fact', timestamp: ts(11) });

  // episodic filler across ~5-8 sessions (noise / distractors / realistic density)
  const nEp = 38 + Math.floor(rand() * 14);
  const epPool = [...EPISODIC];
  for (let k = 0; k < nEp; k++) {
    const ep = epPool.length ? epPool.splice(Math.floor(rand() * epPool.length), 1)[0] : pick(EPISODIC);
    const lead = choice('', 'In a recent session, ', 'Last month ', 'A while back, ', 'Earlier this year ');
    const verb = ep.startsWith('mentioned') || ep.startsWith('is ') || ep.startsWith('has ') || ep.startsWith('got ') || ep.startsWith('took ') || ep.startsWith('started') || ep.startsWith('switched') || ep.startsWith('tried') || ep.startsWith('joined') || ep.startsWith('found') || ep.startsWith('planted') || ep.startsWith('finally') || ep.startsWith('volunteered') || ep.startsWith('adopted') || ep.startsWith('rearranged') ? '' : 'is ';
    addDoc({ id: `u${u}_ep${k}`, lane: 'conversational', userId: u, kind: 'episodic', text: `${lead}${first} ${verb}${ep}.`.replace('  ', ' '), entityIds: [eid], shape: 'raw_dialogue', timestamp: ts(Math.floor(rand() * 16)) });
  }
  userMeta.push(meta);
}

// ── agent projects ──
const projMeta = [];
for (let p = 0; p < N_PROJECTS; p++) {
  const eid = `e_p${p}`;
  const pname = PROJ_NAMES[p % PROJ_NAMES.length] + (p >= PROJ_NAMES.length ? `-${Math.floor(p / PROJ_NAMES.length)}` : '');
  addEntity(eid, `Project ${pname}`, [pname], 'agent_workflow');
  const isWeb = chance(0.55);
  const D = (kind, text, extra = {}) => addDoc({ id: `p${p}_${kind}`, lane: 'agent_workflow', projectId: p, kind, text, entityIds: [eid], ...extra });
  const meta = { p, eid, pname, isWeb, docs: {} };

  meta.docs.stack = D('stack', `Project ${pname} is ${isWeb ? pick(WEB_STACKS) : pick(DATA_STACKS)}.`, { shape: 'entity_profile', timestamp: ts(0) });

  if (isWeb) {
    meta.docs.deploy_staging = D('deploy_staging', `To deploy ${pname} to the staging preview environment, run \`pnpm deploy:staging\`.`, { shape: 'workflow_note', timestamp: ts(4) });
    meta.docs.deploy_prod = D('deploy_prod', `To deploy ${pname} to production, run \`pnpm deploy:prod\`; it requires a manual prod-env approval first.`, { shape: 'workflow_note', timestamp: ts(4) });
    addRel(meta.docs.deploy_prod, meta.docs.deploy_staging, 'co_occurs_with');
    const ev = pick(ENV_VARS), es = pick(ENV_SOURCES);
    meta.env = { ev, es };
    meta.docs.env_var = D('env_var', `In production ${pname} reads ${ev} from ${es}, not from a local .env file.`, { shape: 'workflow_note', timestamp: ts(6) });
    const [newp, oldp, why] = pick(NODE_PINS);
    meta.docs.node_pin = D('node_pin', `${pname} pins ${newp}; CI fails on ${oldp} because of ${why}.`, { shape: 'workflow_note', timestamp: ts(10) });
  } else {
    meta.docs.schedule = D('schedule', `The ${pname} nightly job runs at 02:00 UTC and backfills the previous day.`, { shape: 'workflow_note', timestamp: ts(3) });
    meta.docs.ci_cache = D('ci_cache', `${pname} CI ${pick(CI_CACHE)}.`, { shape: 'workflow_note', timestamp: ts(7) });
  }

  // pkg manager old -> new (temporal)
  meta.docs.pkg_old = addDoc({ id: `p${p}_pkg_old`, lane: 'agent_workflow', projectId: p, kind: 'pkg_old', text: `${pname} manages dependencies with ${pick(PKG_OLD)}.`, entityIds: [eid], shape: 'temporal_update_record', timestamp: ts(1), currentStaleFlag: false, supersededByDocId: `p${p}_pkg_new` });
  meta.docs.pkg_new = addDoc({ id: `p${p}_pkg_new`, lane: 'agent_workflow', projectId: p, kind: 'pkg_new', text: `${pname} migrated to ${pick(PKG_NEW)}; the old lockfile was removed and the new one is the source of truth.`, entityIds: [eid], shape: 'conflict_record', timestamp: ts(12), currentStaleFlag: true, supersedesDocId: `p${p}_pkg_old` });
  addRel(meta.docs.pkg_new, meta.docs.pkg_old, 'supersedes');

  // db decision old -> new (temporal + decision provenance)
  const dbOld = pick(DBS_OLD), dbNew = pick(DBS_NEW), why = pick(DB_REASON);
  meta.db = { dbOld, dbNew, why };
  meta.docs.db_old = addDoc({ id: `p${p}_db_old`, lane: 'agent_workflow', projectId: p, kind: 'db_old', text: `Chose ${dbOld} for the ${pname} staging warehouse because it was fast to set up and fit the early needs.`, entityIds: [eid], shape: 'temporal_update_record', timestamp: ts(5), currentStaleFlag: false, supersededByDocId: `p${p}_db_new` });
  meta.docs.db_new = addDoc({ id: `p${p}_db_new`, lane: 'agent_workflow', projectId: p, kind: 'db_new', text: `Moved the ${pname} staging warehouse from ${dbOld} to ${dbNew} after ${why}.`, entityIds: [eid], shape: 'conflict_record', timestamp: ts(13), currentStaleFlag: true, supersedesDocId: `p${p}_db_old` });
  addRel(meta.docs.db_new, meta.docs.db_old, 'supersedes');
  addRel(meta.docs.db_new, meta.docs.db_old, 'causes');

  // gotcha + secret
  const [feat, cause] = pick(GOTCHAS);
  meta.gotcha = { feat, cause };
  meta.docs.gotcha = D('gotcha', `${pname}: ${feat} is unreliable on CI — ${cause}.`, { shape: 'gotcha_note', timestamp: ts(11) });
  meta.docs.secret = D('secret', `Never commit the .env.${pname.toLowerCase()} file; it holds ${pick(SECRETS)} and should stay in .gitignore.`, { shape: 'gotcha_note', timestamp: ts(2) });

  // worklog / runbook filler across ~5-8 sessions (realistic agent-memory density + noise)
  const nWl = 40 + Math.floor(rand() * 16);
  const wlPool = [...AGENT_EPISODIC];
  for (let k = 0; k < nWl; k++) {
    const wl = wlPool.length ? wlPool.splice(Math.floor(rand() * wlPool.length), 1)[0] : pick(AGENT_EPISODIC);
    const lead = choice('', 'In the last sprint, we ', 'We ', 'Recently the team ', 'At some point we ');
    addDoc({ id: `p${p}_wl${k}`, lane: 'agent_workflow', projectId: p, kind: 'worklog', text: `${pname}: ${lead}${wl}.`.replace('  ', ' '), entityIds: [eid], shape: 'workflow_note', timestamp: ts(Math.floor(rand() * 16)) });
  }
  projMeta.push(meta);
}

// ── doc indexes for hard-negative selection ──
const docsByKind = new Map();
for (const d of docs) {
  if (!docsByKind.has(d.kind)) docsByKind.set(d.kind, []);
  docsByKind.get(d.kind).push(d);
}
const allIds = docs.map((d) => d.id);

function otherKind(kind, excludeId, n = 3) {
  return (docsByKind.get(kind) ?? []).filter((d) => d.id !== excludeId).slice(0, 50);
}
function sampleNoise(excludeSet, n) {
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 30) {
    const id = allIds[Math.floor(rand() * allIds.length)];
    if (!excludeSet.has(id)) { out.push(id); excludeSet.add(id); }
  }
  return out;
}

// pad to a target neg count with categorized noise
function padNegs(negs, answerIds, target = 10) {
  const used = new Set([...negs.map((n) => n.docId), ...answerIds]);
  const need = Math.max(0, target - negs.length);
  for (const id of sampleNoise(used, need)) negs.push({ docId: id, category: 'unrelated' });
  return negs;
}

function addQuery(q) { q.id = `q${String(++qseq).padStart(4, '0')}`; queries.push(q); }

// ── query generators (round-robin over entities to hit family quotas) ──
// Helper: build near-collision negs from same-kind docs of OTHER entities.
function nearColl(kind, answerId, cat, n = 3) {
  return pickN(otherKind(kind, answerId), n).map((d) => ({ docId: d.id, category: cat }));
}

for (const m of userMeta) {
  const d = m.docs;
  // I1 single_hop (pet)
  addQuery({ lane: 'conversational', family: 'single_hop_memory', invariant: 'I1',
    queryText: `What kind of pet does ${m.first} have?`,
    qrels: [{ docId: d.pet_intro, relevance: 1.0, role: 'direct' }],
    hardNegatives: padNegs([...nearColl('pet_intro', d.pet_intro, 'near_collision_entity', 4), { docId: d.pet_vet, category: 'relation_neighbor' }], [d.pet_intro]) });

  // I2 preference (coffee)
  const coffeeNegs = [...nearColl('coffee', d.coffee, 'near_collision_attribute', 4)];
  const coffeeQrels = [{ docId: d.coffee, relevance: 1.0, role: 'direct' }];
  if (d.coffee_decaf) coffeeQrels.push({ docId: d.coffee_decaf, relevance: 0.4, role: 'partial' });
  addQuery({ lane: 'conversational', family: 'preference_recall', invariant: 'I2',
    queryText: `How does ${m.first} like ${chance(0.5) ? 'her' : 'their'} coffee?`,
    qrels: coffeeQrels, hardNegatives: padNegs(coffeeNegs, coffeeQrels.map((q) => q.docId)) });

  // I3 temporal (diet)
  addQuery({ lane: 'conversational', family: 'temporal_update', invariant: 'I3',
    queryText: `What is ${m.first} eating these days?`,
    qrels: [{ docId: d.diet_new, relevance: 1.0, role: 'direct' }, { docId: d.diet_old, relevance: 0.2, role: 'stale' }],
    hardNegatives: padNegs([{ docId: d.diet_old, category: 'temporal_stale' }, ...nearColl('diet_new', d.diet_new, 'near_collision_attribute', 3)], [d.diet_new]) });

  // I3 temporal (restaurant) — only for some users to vary
  if (chance(0.5)) addQuery({ lane: 'conversational', family: 'temporal_update', invariant: 'I3',
    queryText: `Where does ${m.first} like to go for dinner now?`,
    qrels: [{ docId: d.rest_new, relevance: 1.0, role: 'direct' }, { docId: d.rest_old, relevance: 0.2, role: 'stale' }],
    hardNegatives: padNegs([{ docId: d.rest_old, category: 'temporal_stale' }, ...nearColl('rest_new', d.rest_new, 'near_collision_attribute', 3)], [d.rest_new]) });

  // I4 multi_session_bridge (sibling major)
  addQuery({ lane: 'conversational', family: 'multi_session_bridge', invariant: 'I4',
    queryText: `What is ${m.first}'s ${m.sib.rel.includes('brother') ? 'brother' : 'sister'} studying in college?`,
    qrels: [{ docId: d.sib_major, relevance: 1.0, role: 'direct' }, { docId: d.sib_intro, relevance: 0.6, role: 'bridge' }],
    hardNegatives: padNegs(nearColl('sib_major', d.sib_major, 'near_collision_entity', 4), [d.sib_major, d.sib_intro]) });

  // I5 coref (alias) — only if alias exists
  if (m.sib.hasAlias) addQuery({ lane: 'conversational', family: 'coreference_resolution', invariant: 'I5',
    queryText: `When is ${m.sib.sibAlias} coming to visit ${m.first}?`,
    qrels: [{ docId: d.sib_alias, relevance: 1.0, role: 'direct' }, { docId: d.sib_intro, relevance: 0.4, role: 'bridge' }],
    hardNegatives: padNegs(nearColl('sib_alias', d.sib_alias, 'near_collision_entity', 3), [d.sib_alias, d.sib_intro]) });

  // I7 causal (pet vet) — for some
  if (chance(0.6)) addQuery({ lane: 'conversational', family: 'causal_memory_chain', invariant: 'I7',
    queryText: `Why did ${m.first}'s ${m.pet.ptype.includes('cat') ? 'cat' : m.pet.ptype.includes('dog') || m.pet.ptype.includes('collie') || m.pet.ptype.includes('retriever') || m.pet.ptype.includes('beagle') || m.pet.ptype.includes('corgi') ? 'dog' : 'pet'} need surgery?`,
    qrels: [{ docId: d.pet_vet, relevance: 1.0, role: 'direct' }, { docId: d.pet_intro, relevance: 0.4, role: 'bridge' }],
    hardNegatives: padNegs(nearColl('pet_vet', d.pet_vet, 'near_collision_entity', 3), [d.pet_vet, d.pet_intro]) });

  // I9 granularity (book) — for some
  if (chance(0.6)) addQuery({ lane: 'conversational', family: 'granularity_mismatch', invariant: 'I9',
    queryText: `Which specific book is ${m.first} reading right now?`,
    qrels: [{ docId: d.book_specific, relevance: 1.0, role: 'direct' }, { docId: d.book_broad, relevance: 0.2, role: 'partial' }],
    hardNegatives: padNegs([{ docId: d.book_broad, category: 'near_collision_attribute' }, ...nearColl('book_specific', d.book_specific, 'near_collision_entity', 3)], [d.book_specific]) });

  // I13 buried-in-noise — date answer among many date/lexical distractors
  if (d.anniversary && chance(0.5)) {
    addQuery({ lane: 'conversational', family: 'answer_buried_in_noise', invariant: 'I13',
      queryText: `What date is ${m.first}'s wedding anniversary?`,
      qrels: [{ docId: d.anniversary, relevance: 1.0, role: 'direct' }],
      hardNegatives: padNegs([{ docId: d.birthday, category: 'near_collision_attribute' }, { docId: d.trip_old, category: 'lexical_distractor' }, { docId: d.trip_new, category: 'lexical_distractor' }], [d.anniversary], 12) });
  } else if (chance(0.6)) {
    addQuery({ lane: 'conversational', family: 'answer_buried_in_noise', invariant: 'I13',
      queryText: `When is ${m.first}'s birthday?`,
      qrels: [{ docId: d.birthday, relevance: 1.0, role: 'direct' }],
      hardNegatives: padNegs([...(d.anniversary ? [{ docId: d.anniversary, category: 'near_collision_attribute' }] : []), { docId: d.trip_old, category: 'lexical_distractor' }, { docId: d.trip_new, category: 'lexical_distractor' }, ...nearColl('birthday', d.birthday, 'near_collision_attribute', 3)], [d.birthday], 12) });
  }

  // I2 dietary restriction (preference w/ stale trap) — for some
  if (chance(0.4)) addQuery({ lane: 'conversational', family: 'preference_recall', invariant: 'I2',
    queryText: `Does ${m.first} have any dietary restrictions to keep in mind when cooking?`,
    qrels: [{ docId: d.allergy, relevance: 1.0, role: 'direct' }, { docId: d.diet_new, relevance: 0.6, role: 'partial' }],
    hardNegatives: padNegs([{ docId: d.diet_old, category: 'temporal_stale' }, ...nearColl('allergy', d.allergy, 'near_collision_attribute', 3)], [d.allergy, d.diet_new]) });

  // I6 entity_disambiguation (job, against same-first-name users) — for users whose first name repeats
  const sameName = userMeta.filter((o) => o.first === m.first && o.u !== m.u);
  if (sameName.length > 0 && chance(0.8)) {
    const negs = sameName.map((o) => ({ docId: o.docs.job, category: 'near_collision_entity' }));
    addQuery({ lane: 'conversational', family: 'entity_disambiguation', invariant: 'I6',
      queryText: `What does ${m.first} ${m.last} do for work?`,
      qrels: [{ docId: d.job, relevance: 1.0, role: 'direct' }],
      hardNegatives: padNegs(negs, [d.job]) });
  }
}

for (const m of projMeta) {
  const d = m.docs;
  // I1 single hop (stack)
  addQuery({ lane: 'agent_workflow', family: 'single_hop_memory', invariant: 'I1',
    queryText: `What is Project ${m.pname} built with?`,
    qrels: [{ docId: d.stack, relevance: 1.0, role: 'direct' }],
    hardNegatives: padNegs(nearColl('stack', d.stack, 'near_collision_entity', 5), [d.stack]) });

  // I3 temporal (pkg)
  addQuery({ lane: 'agent_workflow', family: 'temporal_update', invariant: 'I3',
    queryText: `Which package manager should I use for ${m.pname} now?`,
    qrels: [{ docId: d.pkg_new, relevance: 1.0, role: 'direct' }, { docId: d.pkg_old, relevance: 0.2, role: 'stale' }],
    hardNegatives: padNegs([{ docId: d.pkg_old, category: 'temporal_stale' }, ...nearColl('pkg_new', d.pkg_new, 'near_collision_attribute', 3)], [d.pkg_new]) });

  // I12 decision_provenance (db)
  addQuery({ lane: 'agent_workflow', family: 'decision_provenance', invariant: 'I12',
    queryText: `What database does ${m.pname} staging use now, and why did it change?`,
    qrels: [{ docId: d.db_new, relevance: 1.0, role: 'direct' }, { docId: d.db_old, relevance: 0.4, role: 'bridge' }],
    hardNegatives: padNegs([{ docId: d.db_old, category: 'temporal_stale' }, ...nearColl('db_new', d.db_new, 'near_collision_attribute', 3)], [d.db_new, d.db_old]) });

  // I8 conditional_constraint (deploy staging) — web only
  if (d.deploy_staging) addQuery({ lane: 'agent_workflow', family: 'conditional_constraint', invariant: 'I8',
    queryText: `How do I deploy ${m.pname} to the staging environment?`,
    qrels: [{ docId: d.deploy_staging, relevance: 1.0, role: 'direct' }],
    hardNegatives: padNegs([{ docId: d.deploy_prod, category: 'trap' }, ...nearColl('deploy_staging', d.deploy_staging, 'near_collision_entity', 3)], [d.deploy_staging]) });

  // I10 workflow_knowledge (env var web / ci cache data)
  if (d.env_var) addQuery({ lane: 'agent_workflow', family: 'workflow_knowledge', invariant: 'I10',
    queryText: `Where does ${m.pname} read its public API URL from in production?`,
    qrels: [{ docId: d.env_var, relevance: 1.0, role: 'direct' }],
    hardNegatives: padNegs([{ docId: d.secret, category: 'near_collision_attribute' }, ...nearColl('env_var', d.env_var, 'near_collision_entity', 3)], [d.env_var]) });
  if (d.ci_cache) addQuery({ lane: 'agent_workflow', family: 'workflow_knowledge', invariant: 'I10',
    queryText: `How does ${m.pname} CI speed up dependency installation?`,
    qrels: [{ docId: d.ci_cache, relevance: 1.0, role: 'direct' }],
    hardNegatives: padNegs(nearColl('ci_cache', d.ci_cache, 'near_collision_entity', 4), [d.ci_cache]) });

  // I11 environment_gotcha
  addQuery({ lane: 'agent_workflow', family: 'environment_gotcha', invariant: 'I11',
    queryText: `Something keeps intermittently failing in ${m.pname} on CI — any known reason?`,
    qrels: [{ docId: d.gotcha, relevance: 1.0, role: 'direct' }],
    hardNegatives: padNegs(nearColl('gotcha', d.gotcha, 'near_collision_attribute', 4), [d.gotcha]) });

  // I1 single hop (node pin / why CI fails) web only
  if (d.node_pin) addQuery({ lane: 'agent_workflow', family: 'single_hop_memory', invariant: 'I1',
    queryText: `Why does ${m.pname} CI fail on the older runtime version?`,
    qrels: [{ docId: d.node_pin, relevance: 1.0, role: 'direct' }],
    hardNegatives: padNegs([{ docId: d.gotcha, category: 'near_collision_attribute' }, ...nearColl('node_pin', d.node_pin, 'near_collision_entity', 3)], [d.node_pin]) });
}

// ── abstention queries (corpus-level, I14) — EXPANDED for Layer-8 threshold stats (P1.5 #5) ──
// (1) not-stored attribute; (2) HARD: attribute that exists for a DIFFERENT same-first-name person/project
// (plausible-but-wrong, strong trap); ~1 per 4 users + 1 per 3 projects → healthy abstention sample.
const ABSTAIN_CONV = ['blood type', 'social security number', 'shoe size', 'passport number', 'credit score', 'apartment number'];
const ABSTAIN_AGENT = ['AWS region for the production deployment', 'on-call PagerDuty rotation', 'cloud monthly bill', 'SOC2 audit date', 'Datadog dashboard URL', 'PCI compliance scope'];
for (let i = 0; i < userMeta.length; i += 4) {
  const m = userMeta[i];
  // hard abstention: ask for a stored-attribute KIND about this person, but the trap is ANOTHER same-first-name
  // person's matching doc (plausible-but-wrong); the answer is NOT stored for THIS person.
  const sameName = userMeta.filter((o) => o.first === m.first && o.u !== m.u);
  const hard = sameName.length > 0 && chance(0.5);
  addQuery({ lane: 'conversational', family: 'abstention', invariant: 'I14', abstain: true,
    queryText: hard
      ? `What breed of dog does ${m.first} ${m.last} have?` // trap: other ${first}'s pet docs; this person's pet may be a cat/none
      : `What is ${m.first}'s ${ABSTAIN_CONV[(i / 4) % ABSTAIN_CONV.length]}?`,
    qrels: [],
    hardNegatives: padNegs(hard
      ? sameName.slice(0, 3).map((o) => ({ docId: o.docs.pet_intro, category: 'trap' }))
      : [{ docId: m.docs.allergy, category: 'trap' }, { docId: m.docs.job, category: 'trap' }], [], 6) });
}
for (let i = 0; i < projMeta.length; i += 3) {
  const m = projMeta[i];
  const sameName = projMeta.filter((o) => o.pname.split('-')[0] === m.pname.split('-')[0] && o.p !== m.p);
  const hard = sameName.length > 0 && chance(0.5);
  addQuery({ lane: 'agent_workflow', family: 'abstention', invariant: 'I14', abstain: true,
    queryText: hard
      ? `What is ${m.pname}'s staging database password?` // never stored (secret doc says don't commit, not the value)
      : `What is the ${ABSTAIN_AGENT[(i / 3) % ABSTAIN_AGENT.length]} for ${m.pname}?`,
    qrels: [],
    hardNegatives: padNegs([{ docId: m.docs.stack, category: 'trap' }, { docId: m.docs.secret, category: 'trap' },
      ...(d_secret_others(projMeta, m).slice(0, 2))], [], 6) });
}
function d_secret_others(arr, me) { return arr.filter((o) => o.p !== me.p).slice(0, 2).map((o) => ({ docId: o.docs.secret, category: 'trap' })); }

// ── explicit splits (P1.5 #1): every query + doc gets a non-null split ──
// Memory docs are proposer-visible stored memories → train_visible. Queries → deterministic 70/10/15/5.
for (const d of docs) d.split = 'train_visible';
for (const q of queries) q.split = splitFor(q.id, SEED);
const splitCount = queries.reduce((a, q) => (a[q.split] = (a[q.split] || 0) + 1, a), {});

// ── assemble + write ──
const corpus = {
  specVersion: 'coretex.memory-corpus.v2-spec.r1',
  phase: 'P0',
  seed: SEED,
  generator: 'scripts/generate-memory-corpus-v2.mjs',
  params: { users: N_USERS, projects: N_PROJECTS },
  splitRatios: { train_visible: 70, calibration: 10, eval_hidden: 15, canary: 5 },
  description: 'Synthetic blended long-term agent memory (conversational + agent_workflow). Logical layer; embed separately. No analytics; currency is curated metadata. Explicit splits (no null).',
  entities, docs, relations, queries,
};

writeFileSync(OUT, JSON.stringify(corpus, null, 1));
const laneCount = docs.reduce((a, d) => (a[d.lane] = (a[d.lane] || 0) + 1, a), {});
const famCount = queries.reduce((a, q) => (a[q.family] = (a[q.family] || 0) + 1, a), {});
console.log(`wrote ${OUT}`);
console.log(`docs=${docs.length} (${JSON.stringify(laneCount)}) queries=${queries.length} relations=${relations.length} entities=${entities.length}`);
console.log(`families: ${JSON.stringify(famCount)}`);
console.log(`query splits: ${JSON.stringify(splitCount)}`);
