#!/usr/bin/env node
/**
 * Generate a CoreTex retrieval-benchmark corpus from challenge-library
 * synthesis primitives.
 *
 * Spec: specs/corpus_retrieval_v0.md, plan §Phase E (reject_current_data branch).
 *
 * This is the corpus generator selected by Phase E0 when the coordinator's
 * dataset_v2 does not carry retrieval-shaped records.
 *
 * Strategy:
 *   1. For each (domain, seed), synthesize a small "world" of entities and
 *      facts using deterministic per-seed PRNG.
 *   2. From each fact, generate a query, an answer-bearing document, and
 *      hard negatives that perturb the entity or attribute.
 *   3. Materialize four families: near_collision, temporal, long_horizon,
 *      multi_hop_relation.
 *   4. Compute embeddings for query + truth + negatives via the bundle's
 *      pinned bi-encoder (`pinned`) or the deterministic stub (`deterministic`).
 *   5. Compute graded qrels via the labeling reranker (production: pinned
 *      stronger reranker; CI/offline: deterministic stub).
 *   6. Write a `coretex.production-corpus.v1` JSON file with computed root.
 *
 * Usage:
 *   node scripts/generate-coretex-retrieval-corpus.mjs \
 *     --bundle-manifest <path>                # provides bi-encoder + labeling model pins
 *     --source challenge-library              # default; imports coordinator challenge package
 *     --challenge-lib-root <path>             # default /root/botcoin-coordinator-live/packages/challenges
 *     --domains companies,quantum_physics,...
 *     --seeds-per-domain 32
 *     --modifier-counts 0,1,2,3
 *     --constraint-difficulties easy,medium,hard
 *     --corpus-epoch 0
 *     --out corpus/coretex_retrieval_v0.json
 *
 * Env:
 *   CORETEX_BIENCODER=deterministic|pinned    # default deterministic for offline gen
 *   CORETEX_LABELER=deterministic|pinned      # default deterministic for offline gen
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argv, exit, env } from 'node:process';
import { createHash } from 'node:crypto';

import {
  splitForRecord,
  computeCorpusRoot,
  biEncoderFromEnv,
  createStreamingBiEncoder,
  createQwen3Reranker,
  createStreamingQwen3Reranker,
  loadProductionCorpus,
  buildCorpusDelta,
  serializeCorpusDelta,
} from '@botcoin/cortex';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const bundlePath = flag('bundle-manifest');
if (!bundlePath) { console.error('--bundle-manifest required'); exit(1); }
const manifest = JSON.parse(readFileSync(resolve(bundlePath), 'utf8'));

const domainsArg = flag('domains', 'companies,quantum_physics,computational_biology,scrna_imputation');
const domains = domainsArg.split(',').map((s) => s.trim()).filter(Boolean);
const seedsPerDomain = Number(flag('seeds-per-domain', '32'));
const seedOffset = Number(flag('seed-offset', '0'));
const corpusEpoch = Number(flag('corpus-epoch', '0'));
const epoch = Number(flag('epoch', String(corpusEpoch)));
const outPath = resolve(flag('out', 'corpus/coretex_retrieval_v0.json'));
const previousCorpusPath = flag('previous-corpus');
const deltaOutPath = flag('delta-out');
const source = flag('source', 'challenge-library');
const challengeLibRoot = resolve(flag(
  'challenge-lib-root',
  env.CORETEX_CHALLENGE_LIB_ROOT ?? '/root/botcoin-coordinator-live/packages/challenges',
));
const modifierCounts = flag('modifier-counts', '0,1,2,3')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0);
const constraintDifficulties = flag('constraint-difficulties', 'easy,medium,hard')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const trapCount = Math.max(0, Math.min(2, Number(flag('trap-count', '2'))));

env.CORETEX_BIENCODER ??= 'deterministic';
env.CORETEX_BIENCODER_REVISION ??= manifest.model.biEncoder.revision;
env.CORETEX_LABELER ??= 'deterministic';
const productionCorpusMode =
  env.CORETEX_CORPUS_PRODUCTION === '1' ||
  env.CORTEX_REAL_EVAL === '1' ||
  env.CORETEX_RERANKER_PRODUCTION === '1';
// Production corpus generation refuses a non-pinned bi-encoder and any
// source other than the challenge library. The labeler is no longer on
// the production hot path — qrels for hard negatives are derived from
// the synthesizer's construction-time category through the bundle's
// negCategoryRelevanceMap (see resolveNegRelevancesFromCategories below).
// CORETEX_LABELER=pinned is still honored as an A/B opt-in to compare
// the synthesizer's labels against the 4B reranker's labels on the
// same corpus, but it is not required.
if (productionCorpusMode && env.CORETEX_BIENCODER !== 'pinned') {
  console.error('generate-coretex-retrieval-corpus: production corpus generation requires CORETEX_BIENCODER=pinned');
  exit(2);
}
if (productionCorpusMode && source !== 'challenge-library') {
  console.error('generate-coretex-retrieval-corpus: production corpus generation requires --source challenge-library');
  exit(2);
}

const layout = manifest.model.biEncoder.retrievalKeyLayout;

// Production corpus generation always uses the persistent-subprocess encoder
// (model loaded once, NDJSON stdin/stdout) — the per-call spawn variant pays
// the full BGE-M3 model-load cost on every text and is unusable past a few
// hundred events on a CPU host. Non-production paths keep the legacy factory.
const biEncoder = productionCorpusMode
  ? createStreamingBiEncoder({
      modelId: manifest.model.biEncoder.modelId,
      revision: manifest.model.biEncoder.revision,
      layout,
    })
  : biEncoderFromEnv(layout, {
      modelId: manifest.model.biEncoder.modelId,
      revision: manifest.model.biEncoder.revision,
    });

// Same persistent-subprocess treatment for the labeling reranker. The pinned
// labeler is typically MemReranker-4B, which takes 30-60s to load on CPU; the
// per-batch spawn variant cannot finish a launch-scale corpus.
const labeler = env.CORETEX_LABELER === 'pinned'
  ? (productionCorpusMode
      ? createStreamingQwen3Reranker({
          model: manifest.model.labelingReranker.modelId,
          revision: manifest.model.labelingReranker.revision,
          cacheDir: env.CORTEX_LOCAL_MODEL_CACHE,
          localOnly: env.CORTEX_LOCAL_MODEL_LOCAL_ONLY === '1',
          batchSize: Number(env.CORETEX_LABELER_BATCH_SIZE ?? '8'),
          numThreads: Number(env.CORETEX_LABELER_NUM_THREADS ?? '0') || undefined,
        })
      : await createQwen3Reranker({
          model: manifest.model.labelingReranker.modelId,
          revision: manifest.model.labelingReranker.revision,
          cacheDir: env.CORTEX_LOCAL_MODEL_CACHE,
          localOnly: env.CORTEX_LOCAL_MODEL_LOCAL_ONLY === '1',
          batchSize: Number(env.CORETEX_LABELER_BATCH_SIZE ?? '2'),
        }))
  : null;

// ─── Synthesis ───────────────────────────────────────────────────────────────

const ATTRIBUTE_TEMPLATES = {
  companies: ['headquarters', 'founder', 'founded_year', 'industry', 'ceo'],
  medical: ['mechanism_of_action', 'half_life', 'first_line_indication', 'contraindication'],
  quantum_physics: ['energy_eigenstate', 'spin', 'parity', 'symmetry_group'],
  computational_biology: ['orf_count', 'gene_family', 'expression_tissue', 'pathway'],
  scrna_imputation: ['dropout_rate', 'imputation_method', 'cell_type', 'marker_gene'],
};

const DOMAIN_NOUNS = {
  companies: ['Acme Robotics', 'Vanguard Systems', 'Helix Industries', 'Arborlight Foundry', 'Northstar Compute'],
  medical: ['avalozentin', 'hexalitran', 'pemvelidib', 'rocuxonate', 'flumitazepam'],
  quantum_physics: ['the |1s〉 state of caesium-133', 'the helical-edge mode at the QSH boundary',
                    'the J = 5/2 multiplet of cerium', 'the coherent π/4 rotation in NV-diamond'],
  computational_biology: ['the BRCA2 c.6275_6276delTT variant', 'the IL10 +1082A allele',
                          'KRAS G12C in the LUAD model', 'the CYP2D6 *3 polymorphism'],
  scrna_imputation: ['the 10x Genomics 3\' v3 chemistry sample', 'the Smart-seq3 plate',
                     'the BD Rhapsody library', 'the Drop-seq plate'],
};

function rng(seed) {
  // xorshift32 on a 32-bit seed derived from a string key
  let s = parseInt(seed.toString(16).padStart(8, '0').slice(-8), 16) >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

function pick(arr, r) { return arr[Math.floor(r() * arr.length)]; }

function genFact(domain, entityName, attribute, r) {
  const value = `${attribute}-${Math.floor(r() * 10000)}`;
  return { entity: entityName, attribute, value };
}

function buildDocument(facts) {
  return facts.map((f) => `${f.entity}'s ${f.attribute} is ${f.value}.`).join(' ');
}

function buildHardNegatives(fact, otherFacts, r) {
  // Returns an array of { text, category } records. Categories are known
  // by construction at each branch; the corpus generator threads them
  // through to buildEvent which resolves them to qrel relevances via the
  // bundle's negCategoryRelevanceMap (no per-event 4B reranker call).
  const out = [];
  const noise = otherFacts.slice(0, 4);
  for (const n of noise) {
    if (n === fact) continue;
    if (r() < 0.5) {
      // Wrong value, right entity + attribute → near_collision_attribute
      // (the substrate knows the right entity but picks the wrong value).
      out.push({
        text: `${fact.entity}'s ${fact.attribute} is ${n.value}.`,
        category: 'near_collision_attribute',
      });
    } else {
      // Right value, wrong entity → near_collision_entity
      // (different entity that surface-matches the query's attribute+value).
      out.push({
        text: `${n.entity}'s ${fact.attribute} is ${fact.value}.`,
        category: 'near_collision_entity',
      });
    }
  }
  while (out.length < 3) {
    // Synthetic padding filler — no signal, true negative.
    out.push({
      text: `${fact.entity}'s ${fact.attribute} is redacted-${Math.floor(r() * 10000)} in the distractor archive.`,
      category: 'unrelated',
    });
  }
  return out.slice(0, 4);
}

const FAMILY_BY_INDEX = ['near_collision', 'temporal', 'long_horizon', 'multi_hop_relation'];

function familyFor(entityIdx, factIdx) {
  return FAMILY_BY_INDEX[(entityIdx + factIdx * 7) % FAMILY_BY_INDEX.length];
}

function buildQuestion(family, fact, targetFact = fact) {
  switch (family) {
    case 'near_collision': return `What is ${fact.entity}'s ${fact.attribute}?`;
    case 'temporal':       return `As of the latest record, what is ${fact.entity}'s ${fact.attribute}?`;
    case 'long_horizon':   return `Across all available context, what is ${fact.entity}'s ${fact.attribute}?`;
    case 'multi_hop_relation':
      return `What is the ${targetFact.attribute} of the entity linked from ${fact.entity}?`;
  }
}

// Deterministic 5-bin labeling stub (CI/offline). Real production uses a
// pinned labeling reranker that returns scores in [0, 1] which are binned.
function labelStub(query, document) {
  const h = createHash('sha256').update(query + '|' + document).digest();
  const v = (h[0] * 256 + h[1]) % 1000 / 1000;
  if (v >= 0.85) return 1.0;
  if (v >= 0.65) return 0.8;
  if (v >= 0.45) return 0.6;
  if (v >= 0.25) return 0.4;
  if (v >= 0.10) return 0.2;
  return 0.0;
}

async function labelHardNegative(query, document) {
  if (!labeler) {
    return Math.min(0.4, labelStub(query, document));
  }
  const [score] = await labeler.score([{ query, document }]);
  if (score >= 0.55) return 0.4;
  if (score >= 0.25) return 0.2;
  return 0.0;
}

// ─── Synthesizer-category relevance resolver ─────────────────────────────────
//
// Replaces the per-event 4B-reranker labeling call. The corpus generator
// knows the structural category of every hard negative at construction
// time; the bundle's negCategoryRelevanceMap turns that into a qrel
// relevance bucket deterministically. This is what makes corpus
// expansion CPU-cheap forever and matches the design intent of an
// indefinitely growing on-chain temporal map substrate.
const negCategoryRelevanceMap = manifest.evaluator?.profile?.negCategoryRelevanceMap;
if (productionCorpusMode && !negCategoryRelevanceMap) {
  console.error(
    'generate-coretex-retrieval-corpus: production corpus generation requires ' +
      'manifest.evaluator.profile.negCategoryRelevanceMap (rebuild template-bundle.json ' +
      'against the current @botcoin/cortex)',
  );
  exit(2);
}

function resolveNegRelevancesFromCategories(hardNegs) {
  return hardNegs.map((n) => {
    if (!n.category) {
      throw new Error(
        `hard negative ${n.id} has no category — corpus generator must tag every ` +
          `neg with a structural category at construction time`,
      );
    }
    const r = negCategoryRelevanceMap[n.category];
    if (typeof r !== 'number') {
      throw new Error(
        `negCategoryRelevanceMap missing category ${n.category} for neg ${n.id}`,
      );
    }
    return r;
  });
}

function relevanceFromScore(score) {
  if (score >= 0.55) return 0.4;
  if (score >= 0.25) return 0.2;
  return 0.0;
}

async function labelHardNegativesBatched(query, hardNegs) {
  if (hardNegs.length === 0) return [];
  if (!labeler) {
    return hardNegs.map((n) => Math.min(0.4, labelStub(query, n.text)));
  }
  const scores = await labeler.score(hardNegs.map((n) => ({ query, document: n.text })));
  return scores.map(relevanceFromScore);
}

async function encodeEventTexts(query, truthDocs, hardNegs) {
  const inputs = [
    { text: query, id: '__query' },
    ...truthDocs.map((td) => ({ text: td.text, id: td.id })),
    ...hardNegs.map((n) => ({ text: n.text, id: n.id })),
  ];
  const out = await biEncoder.encode(inputs);
  let i = 0;
  const queryHex = bytesToHex(out[i++]);
  const perTruthHex = {};
  for (const td of truthDocs) perTruthHex[td.id] = bytesToHex(out[i++]);
  const perNegHex = {};
  for (const n of hardNegs) perNegHex[n.id] = bytesToHex(out[i++]);
  return { queryHex, perTruthHex, perNegHex };
}

async function closeStreamingChildren() {
  const closeIfStreaming = async (obj, label) => {
    if (obj && typeof obj.close === 'function') {
      try { await obj.close(); } catch (e) { console.warn(`${label}.close failed: ${(e && e.message) || e}`); }
    }
  };
  await closeIfStreaming(biEncoder, 'biEncoder');
  await closeIfStreaming(labeler, 'labeler');
}

if (source === 'challenge-library') {
  try { await generateChallengeLibraryCorpus(); }
  finally { await closeStreamingChildren(); }
  exit(0);
}
if (source !== 'synthetic') {
  console.error(`generate-coretex-retrieval-corpus: unsupported --source ${source}`);
  exit(2);
}

// ─── Build records ───────────────────────────────────────────────────────────

const events = [];
let recordCounter = 0;

for (const domain of domains) {
  const nouns = DOMAIN_NOUNS[domain] ?? DOMAIN_NOUNS.companies;
  const attrs = ATTRIBUTE_TEMPLATES[domain] ?? ATTRIBUTE_TEMPLATES.companies;

  for (let s = seedOffset; s < seedOffset + seedsPerDomain; s++) {
    const seedKey = `${domain}:${s}`;
    const r = rng(`${corpusEpoch}:${seedKey}`);
    const numEntities = Math.max(2, Math.floor(r() * 5));

    const entities = [];
    for (let e = 0; e < numEntities; e++) {
      const name = `${pick(nouns, r)} #${e}`;
      const factsForEntity = [];
      const numFacts = Math.max(2, Math.floor(r() * attrs.length));
      for (let f = 0; f < numFacts; f++) {
        const attr = attrs[f % attrs.length];
        factsForEntity.push(genFact(domain, name, attr, r));
      }
      entities.push({ name, facts: factsForEntity });
    }

    const allFacts = entities.flatMap((e) => e.facts);
    const factId = new Map();
    for (let e = 0; e < entities.length; e++) {
      for (let f = 0; f < entities[e].facts.length; f++) {
        factId.set(entities[e].facts[f], `coretex_v1:${domain}:s${s}:e${e}:f${f}`);
      }
    }

    for (let e = 0; e < entities.length; e++) {
      for (let f = 0; f < entities[e].facts.length; f++) {
        const fact = entities[e].facts[f];
        const family = familyFor(e, f);
        let answerFact = fact;
        let relationTargetId;
        if (family === 'multi_hop_relation' && allFacts.length > 1) {
          const sourceIdx = allFacts.indexOf(fact);
          answerFact = allFacts[(sourceIdx + 1) % allFacts.length];
          relationTargetId = factId.get(answerFact);
        }
        const question = buildQuestion(family, fact, answerFact);
        const truthDocText = buildDocument([answerFact]);
        const negs = buildHardNegatives(answerFact, allFacts.filter((g) => g !== answerFact), r);

        const id = `coretex_v1:${domain}:s${s}:e${e}:f${f}`;
        recordCounter++;

        const truthDocs = [{ id: `${id}::truth`, text: truthDocText, isCurrent: true }];
        // negs are { text, category } records emitted by buildHardNegatives;
        // attach an event-scoped id so they can be referenced in qrels.
        const hardNegs = negs.map((n, i) => ({ id: `${id}::neg${i}`, text: n.text, category: n.category }));

        // Temporal family: add a "stale" truth document.
        let temporal;
        if (family === 'temporal') {
          const stalePrev = `${fact.entity}'s ${fact.attribute} was previously ${pick(allFacts, r).value}.`;
          truthDocs.push({ id: `${id}::stale`, text: stalePrev, isCurrent: false });
          temporal = {
            validFromEpoch: corpusEpoch,
            validUntilEpoch: 1 << 30,
            currentStaleFlag: true,
          };
        }

        // Multi-hop: add a relation annotation between this and a neighboring fact.
        let relations;
        if (family === 'multi_hop_relation' && relationTargetId && relationTargetId !== id) {
            relations = [{ other_id: relationTargetId, edgeType: 'coreference_of' }];
          }

        // Embeddings via bi-encoder; one batched encode per event
        // (1 query + truth docs + hard negatives) so the persistent
        // subprocess only pays one round-trip + one padded forward pass.
        const { queryHex, perTruthHex, perNegHex } = await encodeEventTexts(question, truthDocs, hardNegs);

        // Qrels: truth at 1.0 (current) or 0.4 (stale temporal); hard
        // negatives resolved via the bundle's negCategoryRelevanceMap from
        // the construction-time category — no per-event reranker call.
        const negRelevances = resolveNegRelevancesFromCategories(hardNegs);
        const qrels = [];
        for (const td of truthDocs) qrels.push({ documentId: td.id, relevance: td.isCurrent ? 1.0 : 0.4 });
        for (let ni = 0; ni < hardNegs.length; ni++) qrels.push({ documentId: hardNegs[ni].id, relevance: negRelevances[ni] });

        const split = splitForRecord(id, corpusEpoch);

        events.push({
          id,
          family,
          domain,
          split,
          queryText: question,
          truthDocuments: truthDocs,
          hardNegatives: hardNegs,
          qrels,
          protected: family === 'temporal',
          temporal,
          relations,
          provenance: {
            source: 'synthetic_challenge',
            challengeSeed: `0x${(BigInt(s) * 0x9e3779b97f4a7c15n).toString(16).padStart(32, '0').slice(-32)}`,
            challengeId: `${domain}/${s}`,
            sourceHash: `0x${createHash('sha256').update(id).digest('hex')}`,
          },
          embeddings: {
            modelId: manifest.model.biEncoder.modelId,
            revision: manifest.model.biEncoder.revision,
            layout,
            query: queryHex,
            perTruth: perTruthHex,
            perNegative: perNegHex,
          },
        });
      }
    }
  }
}

async function generateChallengeLibraryCorpus() {
  const challengeIndex = resolve(challengeLibRoot, 'dist/index.js');
  if (!existsSync(challengeIndex)) {
    console.error(
      'generate-coretex-retrieval-corpus: challenge-library source requires a built coordinator challenge package at ' +
      `${challengeIndex}. Run the coordinator challenge package build first or pass --source synthetic explicitly.`,
    );
    exit(2);
  }

  const challengeLib = await import(pathToFileURL(challengeIndex).href);
  if (typeof challengeLib.generateInterchangeableChallenge !== 'function') {
    console.error(`generate-coretex-retrieval-corpus: ${challengeIndex} does not export generateInterchangeableChallenge`);
    exit(2);
  }

  const generated = [];
  // Live throughput reporter so the parallel driver (and a human watching
  // a single-worker run) can see events/sec in real time instead of only
  // the final summary at writeCorpusOutput. Emits a tagged line every
  // PROGRESS_INTERVAL_MS (default 5s) and at every 1000-event milestone.
  const progressIntervalMs = Number(env.CORETEX_PROGRESS_INTERVAL_MS ?? '5000');
  const tStart = Date.now();
  let lastReport = tStart;
  let lastCount = 0;
  function reportProgress(force = false) {
    const now = Date.now();
    const elapsed = (now - tStart) / 1000;
    const sinceLast = (now - lastReport) / 1000;
    if (!force && sinceLast < progressIntervalMs / 1000 && (generated.length - lastCount) < 1000) return;
    const ratePerSec = generated.length / Math.max(elapsed, 0.001);
    const recentRate = (generated.length - lastCount) / Math.max(sinceLast, 0.001);
    console.log(
      `[progress] events=${generated.length} elapsed=${elapsed.toFixed(1)}s ` +
        `overall=${ratePerSec.toFixed(2)}/s recent=${recentRate.toFixed(2)}/s`,
    );
    lastReport = now;
    lastCount = generated.length;
  }
  for (const domain of domains) {
    const questionMeta = loadDomainQuestionMetadata(domain);
    for (let s = seedOffset; s < seedOffset + seedsPerDomain; s++) {
      for (const modifierCount of modifierCounts) {
        for (const constraintDifficulty of constraintDifficulties) {
          const worldSeed = deriveWorldSeed(domain, s, modifierCount, constraintDifficulty);
          const challenge = challengeLib.generateInterchangeableChallenge(
            worldSeed,
            {
              trapCount,
              modifierCount,
              constraintDifficulty,
            },
            domain,
          );
          const challengeKey = `${domain}/seed-${s}/m${modifierCount}/${constraintDifficulty}`;
          generated.push(...await recordsFromChallenge({
            challenge,
            domain,
            sourceSeed: s,
            modifierCount,
            constraintDifficulty,
            challengeKey,
            questionMeta,
          }));
          reportProgress();
        }
      }
    }
  }
  reportProgress(true);

  await writeCorpusOutput(generated, 'challenge-library');
}

function deriveWorldSeed(domain, seed, modifierCount, constraintDifficulty) {
  const h = createHash('sha256')
    .update(`coretex-corpus-v1|${corpusEpoch}|${domain}|${seed}|${modifierCount}|${constraintDifficulty}`)
    .digest('hex');
  return BigInt(`0x${h.slice(0, 32)}`);
}

function loadDomainQuestionMetadata(domain) {
  const out = new Map();
  const path = resolve(challengeLibRoot, 'domains', domain, 'domain_library.json');
  if (!existsSync(path)) return out;
  const library = JSON.parse(readFileSync(path, 'utf8'));
  for (const q of library.questions ?? []) {
    out.set(q.id, {
      isChain: Array.isArray(q.answer_logic?.chain) && q.answer_logic.chain.length > 1,
      hasFilter: Boolean(q.answer_logic?.filter),
      aggregation: q.answer_logic?.aggregation,
      attribute: q.answer_logic?.attribute,
    });
  }
  return out;
}

async function recordsFromChallenge({
  challenge,
  domain,
  sourceSeed,
  modifierCount,
  constraintDifficulty,
  challengeKey,
  questionMeta,
}) {
  const entities = extractEntities(challenge);
  const entityDocs = new Map(entities.map((entity) => [String(entity.name), entityDocument(domain, entity)]));
  const directIdsByName = new Map();
  const records = [];

  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    const id = `${recordPrefix(domain, sourceSeed, modifierCount, constraintDifficulty)}:entity:${stableSegment(entity.name)}`;
    directIdsByName.set(String(entity.name), id);
    records.push(await buildEvent({
      id,
      family: 'near_collision',
      domain,
      queryText: `Which ${domainLabel(domain)} record is the exact profile for ${entity.name}?`,
      truthDocuments: [{ id: `${id}::truth`, text: entityDocs.get(String(entity.name)), isCurrent: true }],
      // Other-entity documents in the same domain — surface-similar but
      // different entity. Synthesizer category: near_collision_entity.
      hardNegativeRecords: nearestEntityDocs(entities, entity.name, entityDocs, 4)
        .map((text) => ({ text, category: 'near_collision_entity' })),
      protectedRecord: false,
      provenance: provenanceFor(challenge, challengeKey, sourceSeed, {
        questionId: `entity:${entity.name}`,
        sourcePayload: entity,
      }),
    }));
  }

  for (const modifier of challenge.modifiers ?? []) {
    const entityDoc = entityDocs.get(String(modifier.entityName)) ?? `${modifier.entityName} is present in ${challengeKey}.`;
    const id = `${recordPrefix(domain, sourceSeed, modifierCount, constraintDifficulty)}:temporal:${stableSegment(modifier.entityName)}:${stableSegment(modifier.attribute)}`;
    const currentText =
      `Current validated ${domainLabel(domain)} state after ${modifier.eventType ?? 'event'}: ` +
      `${modifier.entityName}'s ${modifier.attribute} is ${formatValue(modifier.derivedValue)}. ${entityDoc}`;
    const staleText =
      `Superseded stale ${domainLabel(domain)} state before ${modifier.eventType ?? 'event'}: ` +
      `${modifier.entityName}'s ${modifier.attribute} was ${formatValue(modifier.baseValue)}.`;
    records.push(await buildEvent({
      id,
      family: 'temporal',
      domain,
      queryText: `After the latest ${modifier.eventType ?? 'event'}, what is ${modifier.entityName}'s current ${modifier.attribute}?`,
      truthDocuments: [
        { id: `${id}::truth_current`, text: currentText, isCurrent: true },
        { id: `${id}::truth_stale`, text: staleText, isCurrent: false },
      ],
      // Modifier (temporal) record's hard negs are other-entity docs in
      // the same temporal context (near_collision_entity). The
      // temporal-partial-relevance signal is encoded via the
      // truth_stale entry above (isCurrent=false → qrel relevance 0.4
      // by the buildEvent truth-rule), not as a hard neg — adding a
      // duplicate staleText to hardNegativeRecords would be deduped
      // by buildEvent anyway and ends up dead code.
      hardNegativeRecords: nearestEntityDocs(entities, modifier.entityName, entityDocs, 4)
        .map((text) => ({ text, category: 'near_collision_entity' })),
      protectedRecord: true,
      temporal: {
        validFromEpoch: corpusEpoch,
        validUntilEpoch: 1 << 30,
        currentStaleFlag: true,
      },
      relations: directIdsByName.has(String(modifier.entityName))
        ? [{ other_id: directIdsByName.get(String(modifier.entityName)), edgeType: 'supersedes' }]
        : undefined,
      provenance: provenanceFor(challenge, challengeKey, sourceSeed, {
        questionId: `modifier:${modifier.entityName}:${modifier.attribute}`,
        sourcePayload: modifier,
      }),
    }));
  }

  for (const trap of challenge.silentTraps ?? []) {
    const id = `${recordPrefix(domain, sourceSeed, modifierCount, constraintDifficulty)}:trap-temporal:${stableSegment(trap.entityName)}:${stableSegment(trap.attribute)}`;
    const entityDoc = entityDocs.get(String(trap.entityName)) ?? `${trap.entityName} is present in ${challengeKey}.`;
    const currentText =
      `Validated current value: ${trap.entityName}'s ${trap.attribute} is ${formatValue(trap.correctValue)}. ${entityDoc}`;
    const staleText =
      `Superseded distractor value: ${trap.entityName}'s ${trap.attribute} was listed as ${formatValue(trap.wrongValue)} in an obsolete planning note.`;
    records.push(await buildEvent({
      id,
      family: 'temporal',
      domain,
      queryText: `What is the validated current ${trap.attribute} for ${trap.entityName}, rejecting superseded planning values?`,
      truthDocuments: [
        { id: `${id}::truth_current`, text: currentText, isCurrent: true },
        { id: `${id}::truth_stale`, text: staleText, isCurrent: false },
      ],
      // Trap-temporal record's hard negs: other-entity docs in the
      // same trap context (near_collision_entity). The stale
      // designed-decoy is encoded via truth_stale above
      // (isCurrent=false → qrel 0.4 partial relevance) — duplicating
      // it as a hard neg would be deduped by buildEvent.
      hardNegativeRecords: nearestEntityDocs(entities, trap.entityName, entityDocs, 4)
        .map((text) => ({ text, category: 'near_collision_entity' })),
      protectedRecord: true,
      temporal: {
        validFromEpoch: corpusEpoch,
        validUntilEpoch: 1 << 30,
        currentStaleFlag: true,
      },
      relations: directIdsByName.has(String(trap.entityName))
        ? [{ other_id: directIdsByName.get(String(trap.entityName)), edgeType: 'supersedes' }]
        : undefined,
      provenance: provenanceFor(challenge, challengeKey, sourceSeed, {
        questionId: `trap:${trap.entityName}:${trap.attribute}`,
        sourcePayload: trap,
      }),
    }));
  }

  for (const q of challenge.questions ?? []) {
    const answerName = String(q.answer);
    const truthText = entityDocs.get(answerName)
      ?? `The canonical answer for ${challengeKey} question ${q.id} is ${answerName}.`;
    const id = `${recordPrefix(domain, sourceSeed, modifierCount, constraintDifficulty)}:question:${stableSegment(q.id)}`;
    let family = classifyChallengeQuestion(q, questionMeta.get(q.id), modifierCount);
    const relations = [];
    const targetId = directIdsByName.get(answerName);
    if (family === 'multi_hop_relation' && !targetId) family = 'long_horizon';
    if (targetId) {
      relations.push({
        other_id: targetId,
        edgeType: family === 'multi_hop_relation' ? 'derived_from' : 'supports',
      });
    }
    // Question record's negs: other answer-entity docs (near_collision_entity)
    // plus any trap texts produced for this question (trap — designed
    // adversarial decoys that the substrate must learn to reject).
    const hardNegativeRecords = nearestEntityDocsByAnswer(entities, answerName, entityDocs, 4)
      .map((text) => ({ text, category: 'near_collision_entity' }));
    for (const trapText of trapTextsForQuestion(challenge, q, entityDocs)) {
      hardNegativeRecords.push({ text: trapText, category: 'trap' });
    }
    records.push(await buildEvent({
      id,
      family,
      domain,
      queryText: q.text,
      truthDocuments: [{ id: `${id}::truth`, text: truthText, isCurrent: true }],
      hardNegativeRecords,
      protectedRecord: family === 'temporal',
      temporal: family === 'temporal'
        ? { validFromEpoch: corpusEpoch, validUntilEpoch: 1 << 30, currentStaleFlag: true }
        : undefined,
      relations: relations.length > 0 ? relations : undefined,
      provenance: provenanceFor(challenge, challengeKey, sourceSeed, {
        questionId: q.id,
        sourcePayload: q,
      }),
    }));
  }

  return records;
}

async function buildEvent({
  id,
  family,
  domain,
  queryText,
  truthDocuments,
  hardNegativeRecords,
  protectedRecord,
  temporal,
  relations,
  provenance,
}) {
  // De-dup on text, drop any neg that matches a truth doc verbatim,
  // cap at 6. Each surviving neg carries its synthesizer category.
  const truthTexts = new Set(truthDocuments.map((td) => td.text));
  const seen = new Set();
  const deduped = [];
  for (const rec of hardNegativeRecords ?? []) {
    if (!rec?.text || seen.has(rec.text) || truthTexts.has(rec.text)) continue;
    seen.add(rec.text);
    deduped.push(rec);
    if (deduped.length >= 6) break;
  }
  const hardNegatives = deduped.map((rec, i) => ({
    id: `${id}::neg${i}`,
    text: rec.text,
    category: rec.category,
  }));
  while (hardNegatives.length < 3) {
    // Padding filler — true negative, no signal. The substrate is not
    // expected to learn anything from these; the qrel is 0.0.
    hardNegatives.push({
      id: `${id}::neg${hardNegatives.length}`,
      text: `Non-answer distractor for ${id}: this record mentions ${domain} but does not contain the requested answer.`,
      category: 'unrelated',
    });
  }

  const { queryHex, perTruthHex, perNegHex } = await encodeEventTexts(queryText, truthDocuments, hardNegatives);
  // Synthesizer-category relevance (default). The labeler path is still
  // honored if CORETEX_LABELER=pinned is set explicitly, so an operator
  // can A/B compare the synthesizer's labels against MemReranker-4B's
  // labels on the same corpus by toggling the env var.
  const useLabeler = labeler && env.CORETEX_LABELER === 'pinned';
  const negRelevances = useLabeler
    ? await labelHardNegativesBatched(queryText, hardNegatives)
    : resolveNegRelevancesFromCategories(hardNegatives);

  const qrels = [];
  for (const td of truthDocuments) qrels.push({ documentId: td.id, relevance: td.isCurrent ? 1.0 : 0.4 });
  for (let ni = 0; ni < hardNegatives.length; ni++) qrels.push({ documentId: hardNegatives[ni].id, relevance: negRelevances[ni] });

  return {
    id,
    family,
    domain,
    split: splitForRecord(id, corpusEpoch),
    queryText,
    truthDocuments,
    hardNegatives,
    qrels,
    protected: protectedRecord,
    temporal,
    relations,
    provenance,
    embeddings: {
      modelId: manifest.model.biEncoder.modelId,
      revision: manifest.model.biEncoder.revision,
      layout,
      query: queryHex,
      perTruth: perTruthHex,
      perNegative: perNegHex,
    },
  };
}

function extractEntities(challenge) {
  const raw = challenge.world?.companies ?? challenge.world?.entities;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`challenge_world_has_no_entities:${challenge.challengeDomain}:${String(challenge.worldSeed)}`);
  }
  return raw.map((entity) => ({ ...entity, name: String(entity.name) }));
}

function entityDocument(domain, entity) {
  const fields = Object.entries(entity)
    .filter(([key]) => key !== 'name')
    .map(([key, value]) => `${humanize(key)} is ${formatValue(value)}`)
    .join('; ');
  return `${domainLabel(domain)} ${entity.name}: ${fields}.`;
}

function nearestEntityDocs(entities, entityName, entityDocs, limit) {
  return entities
    .filter((entity) => String(entity.name) !== String(entityName))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .slice(0, limit)
    .map((entity) => entityDocs.get(String(entity.name)));
}

function nearestEntityDocsByAnswer(entities, answerName, entityDocs, limit) {
  const answer = String(answerName);
  const lexical = entities
    .filter((entity) => String(entity.name) !== answer)
    .map((entity) => ({
      entity,
      score: sharedPrefixLength(answer.toLowerCase(), String(entity.name).toLowerCase()),
    }))
    .sort((a, b) => b.score - a.score || String(a.entity.name).localeCompare(String(b.entity.name)));
  return lexical.slice(0, limit).map(({ entity }) => entityDocs.get(String(entity.name)));
}

function trapTextsForQuestion(challenge, question, entityDocs) {
  const out = [];
  for (const trap of challenge.silentTraps ?? []) {
    if (question.answer === trap.entityName) {
      out.push(`Superseded trap document: ${trap.entityName}'s ${trap.attribute} was incorrectly listed as ${formatValue(trap.wrongValue)}.`);
    }
  }
  if (out.length === 0 && challenge.silentTraps?.length) {
    const trap = challenge.silentTraps[0];
    const doc = entityDocs.get(String(trap.entityName));
    out.push(`Plausible trap record for ${trap.entityName}: ${trap.attribute} was incorrectly listed as ${formatValue(trap.wrongValue)}. ${doc ?? ''}`);
  }
  return out;
}

function classifyChallengeQuestion(question, meta) {
  if (question.id?.startsWith?.('conditional_') || meta?.isChain) return 'multi_hop_relation';
  if (meta?.hasFilter || /among|across|which|highest|lowest|largest|smallest|most|fewest|broadest/i.test(question.text)) {
    return 'long_horizon';
  }
  return 'near_collision';
}

function provenanceFor(challenge, challengeKey, sourceSeed, extra) {
  const sourcePayload = {
    challengeDomain: challenge.challengeDomain,
    worldSeed: String(challenge.worldSeed),
    rulesVersion: challenge.rulesVersion,
    challengeKey,
    sourceSeed,
    ...extra,
  };
  return {
    source: 'synthetic_challenge',
    challengeSeed: `0x${BigInt(challenge.worldSeed).toString(16).padStart(32, '0').slice(-32)}`,
    challengeId: challengeKey,
    questionId: extra.questionId,
    sourceHash: `0x${createHash('sha256').update(JSON.stringify(sourcePayload)).digest('hex')}`,
  };
}

function recordPrefix(domain, seed, modifierCount, constraintDifficulty) {
  return `coretex_v1:${domain}:s${seed}:m${modifierCount}:c${constraintDifficulty}`;
}

function stableSegment(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function humanize(value) {
  return String(value).replace(/[_.-]+/g, ' ');
}

function domainLabel(domain) {
  return humanize(domain).replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatValue(value) {
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (value === null) return 'not applicable';
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString('en-US') : String(value);
  return String(value);
}

function uniqueTexts(texts) {
  const seen = new Set();
  const out = [];
  for (const text of texts) {
    const normalized = String(text ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function sharedPrefixLength(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

async function writeCorpusOutput(events, sourceName) {
  const previousRaw = previousCorpusPath
    ? JSON.parse(readFileSync(resolve(previousCorpusPath), 'utf8'))
    : null;
  const outputEvents = previousRaw ? [...previousRaw.events, ...events] : events;
  const corpusRoot = computeCorpusRoot(eventsToMemory(outputEvents));

  const corpus = {
    schemaVersion: 'coretex.production-corpus.v1',
    corpusEpoch,
    source: sourceName,
    challengeLibrary: {
      root: challengeLibRoot,
      modifierCounts,
      constraintDifficulties,
      trapCount,
    },
    biEncoder: {
      modelId: manifest.model.biEncoder.modelId,
      revision: manifest.model.biEncoder.revision,
      layout,
    },
    labelingModel: {
      modelId: manifest.model.labelingReranker.modelId,
      revision: manifest.model.labelingReranker.revision,
    },
    events: outputEvents,
    corpusRoot,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(corpus, null, 2));
  console.log(`generate-coretex-retrieval-corpus: wrote ${events.length} ${sourceName} events to ${outPath}`);
  if (previousRaw) console.log(`  totalEvents=${outputEvents.length} previousEvents=${previousRaw.events.length}`);
  console.log(`  corpusRoot=${corpusRoot}`);
  console.log(`  splits=${tally(outputEvents.map((e) => e.split))}`);
  console.log(`  families=${tally(outputEvents.map((e) => e.family))}`);

  if (deltaOutPath) {
    if (!previousCorpusPath) {
      console.error('generate-coretex-retrieval-corpus: --delta-out requires --previous-corpus');
      exit(2);
    }
    const previousCorpus = loadProductionCorpus(resolve(previousCorpusPath));
    const delta = buildCorpusDelta({
      previousCorpus,
      additions: eventsToMemory(events),
      removals: [],
      epoch,
      labelingProvenance: {
        modelId: manifest.model.labelingReranker.modelId,
        revision: manifest.model.labelingReranker.revision,
        runtime: 'torch-transformers/cpu',
        batchHash: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
      },
    });
    mkdirSync(dirname(resolve(deltaOutPath)), { recursive: true });
    writeFileSync(resolve(deltaOutPath), JSON.stringify(serializeCorpusDelta(delta), null, 2));
    console.log(`  delta=${resolve(deltaOutPath)} added=${delta.addedIds.length} nextRoot=${delta.nextRoot}`);
  }
}

async function encodeOne(text) {
  const out = await biEncoder.encode([{ text }]);
  return out[0];
}

function bytesToHex(bytes) {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

const previousRaw = previousCorpusPath
  ? JSON.parse(readFileSync(resolve(previousCorpusPath), 'utf8'))
  : null;
const outputEvents = previousRaw ? [...previousRaw.events, ...events] : events;
const corpusRoot = computeCorpusRoot(eventsToMemory(outputEvents));

function hexToUint8(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const corpus = {
  schemaVersion: 'coretex.production-corpus.v1',
  corpusEpoch,
  biEncoder: {
    modelId: manifest.model.biEncoder.modelId,
    revision: manifest.model.biEncoder.revision,
    layout,
  },
  labelingModel: {
    modelId: manifest.model.labelingReranker.modelId,
    revision: manifest.model.labelingReranker.revision,
  },
  events: outputEvents,
  corpusRoot,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(corpus, null, 2));
console.log(`generate-coretex-retrieval-corpus: wrote ${events.length} events to ${outPath}`);
if (previousRaw) console.log(`  totalEvents=${outputEvents.length} previousEvents=${previousRaw.events.length}`);
console.log(`  corpusRoot=${corpusRoot}`);
console.log(`  splits=${tally(outputEvents.map((e) => e.split))}`);
console.log(`  families=${tally(outputEvents.map((e) => e.family))}`);

if (deltaOutPath) {
  if (!previousCorpusPath) {
    console.error('generate-coretex-retrieval-corpus: --delta-out requires --previous-corpus');
    exit(2);
  }
  const previousCorpus = loadProductionCorpus(resolve(previousCorpusPath));
  const delta = buildCorpusDelta({
    previousCorpus,
    additions: eventsToMemory(events),
    removals: [],
    epoch,
    labelingProvenance: {
      modelId: manifest.model.labelingReranker.modelId,
      revision: manifest.model.labelingReranker.revision,
      runtime: 'torch-transformers/cpu',
      batchHash: createHash('sha256').update(JSON.stringify(events)).digest('hex'),
    },
  });
  mkdirSync(dirname(resolve(deltaOutPath)), { recursive: true });
  writeFileSync(resolve(deltaOutPath), JSON.stringify(serializeCorpusDelta(delta), null, 2));
  console.log(`  delta=${resolve(deltaOutPath)} added=${delta.addedIds.length} nextRoot=${delta.nextRoot}`);
}

await closeStreamingChildren();

function tally(arr) {
  const m = {};
  for (const x of arr) m[x] = (m[x] ?? 0) + 1;
  return JSON.stringify(m);
}

function eventsToMemory(records) {
  return records.map((e) => ({
    ...JSON.parse(JSON.stringify(e)),
    embeddings: {
      ...e.embeddings,
      query: hexToUint8(e.embeddings.query),
      perTruth: new Map(Object.entries(e.embeddings.perTruth).map(([k, v]) => [k, hexToUint8(v)])),
      perNegative: new Map(Object.entries(e.embeddings.perNegative).map(([k, v]) => [k, hexToUint8(v)])),
    },
  }));
}
