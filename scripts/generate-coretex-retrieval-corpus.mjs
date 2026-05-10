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
 *     --domains companies,quantum_physics,...
 *     --seeds-per-domain 32
 *     --corpus-epoch 0
 *     --out corpus/coretex_retrieval_v0.json
 *
 * Env:
 *   CORETEX_BIENCODER=deterministic|pinned    # default deterministic for offline gen
 *   CORETEX_LABELER=deterministic|pinned      # default deterministic for offline gen
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit, env } from 'node:process';
import { createHash } from 'node:crypto';

import {
  splitForRecord,
  computeCorpusRoot,
  biEncoderFromEnv,
  createQwen3Reranker,
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

env.CORETEX_BIENCODER ??= 'deterministic';
env.CORETEX_BIENCODER_REVISION ??= manifest.model.biEncoder.revision;
env.CORETEX_LABELER ??= 'deterministic';
const productionCorpusMode =
  env.CORETEX_CORPUS_PRODUCTION === '1' ||
  env.CORTEX_REAL_EVAL === '1' ||
  env.CORETEX_RERANKER_PRODUCTION === '1';
if (productionCorpusMode && env.CORETEX_LABELER !== 'pinned') {
  console.error('generate-coretex-retrieval-corpus: production corpus generation requires CORETEX_LABELER=pinned');
  exit(2);
}

const layout = manifest.model.biEncoder.retrievalKeyLayout;
const biEncoder = biEncoderFromEnv(layout, {
  modelId: manifest.model.biEncoder.modelId,
  revision: manifest.model.biEncoder.revision,
});

const labeler = env.CORETEX_LABELER === 'pinned'
  ? await createQwen3Reranker({
      model: manifest.model.labelingReranker.modelId,
      revision: manifest.model.labelingReranker.revision,
      cacheDir: env.CORTEX_LOCAL_MODEL_CACHE,
      localOnly: env.CORTEX_LOCAL_MODEL_LOCAL_ONLY === '1',
      batchSize: Number(env.CORETEX_LABELER_BATCH_SIZE ?? '2'),
    })
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
  const out = [];
  const noise = otherFacts.slice(0, 4);
  for (const n of noise) {
    if (n === fact) continue;
    if (r() < 0.5) {
      out.push(`${fact.entity}'s ${fact.attribute} is ${n.value}.`);   // wrong value, right entity+attr
    } else {
      out.push(`${n.entity}'s ${fact.attribute} is ${fact.value}.`);   // right value, wrong entity
    }
  }
  while (out.length < 3) {
    out.push(`${fact.entity}'s ${fact.attribute} is redacted-${Math.floor(r() * 10000)} in the distractor archive.`);
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
        const hardNegs = negs.map((t, i) => ({ id: `${id}::neg${i}`, text: t }));

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

        // Embeddings via bi-encoder (deterministic stub by default).
        // Real production runs this with CORETEX_BIENCODER=pinned.
        const queryHex = bytesToHex(await encodeOne(question));
        const perTruthHex = {};
        for (const td of truthDocs) perTruthHex[td.id] = bytesToHex(await encodeOne(td.text));
        const perNegHex = {};
        for (const n of hardNegs) perNegHex[n.id] = bytesToHex(await encodeOne(n.text));

        // Qrels: bin labelStub scores
        const qrels = [];
        for (const td of truthDocs) qrels.push({ documentId: td.id, relevance: td.isCurrent ? 1.0 : 0.4 });
        for (const n of hardNegs) qrels.push({ documentId: n.id, relevance: await labelHardNegative(question, n.text) });

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
