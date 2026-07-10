/**
 * BMU P2 CONSOLIDATION — cross-family checks over ONE combined multi-epoch
 * sample from all four family generators (BMU_SPEC.md rev3.2 ad7e523).
 *
 * No single family lane could run these; they exist only on the consolidated
 * branch where all four generators coexist:
 *
 *   1. GLOBAL m=1 census (§4.1): one shared active index spans the
 *      temporal+multihop lanes and one shared m=1 registry spans the
 *      conflict+nearcol lanes AT MINT TIME (fail-closed), then a unified
 *      cross-mechanism census over every minted cluster asserts that no
 *      subjectEntityId and no templateId appears in more than one ACTIVE
 *      cluster ACROSS families.
 *   2. Cross-family dedup: row-id / doc-id / doc-text / queryText /
 *      family-agnostic publicIntent-key collision scan across families.
 *   3. Composition sanity: the combined bank is sized EXACTLY to the §6.7b
 *      arm-gate minima (80/110/110/80 = 380 rows = BMU_ARM_GATE_N_MIN) and,
 *      when --pack-law-dist points at a BUILT dist that exports the P3 §6
 *      pack law (origin/coretex-bmu-v1: deriveBmuDualPacks/computeCorpusRoot/
 *      packQuotaCoverage/bmuEventExcluded), the bank is mapped to
 *      production-event shape and must derive a VALID gate+confirm pack pair:
 *      exact packSize, quotas satisfied on both packs, bmuTask on every row,
 *      §6.3 held-out property (confirm shares no motif/subject/template with
 *      the gate), §6.2 fresh slots, and byte-identical re-derivation.
 *      Without --pack-law-dist a schema-level check runs instead (row/bmuTask
 *      field shape + E_f_min census only) and the report says so.
 *
 * Usage:
 *   node scripts/lib/bmu-generators/cross-family-checks.mjs <outDir> \
 *     [--pack-law-dist <path/to/built/coretex/dist>]
 *
 * Epoch window: one shared synthetic window [150,151,152] for all four
 * families (the m=1 law is about co-ACTIVE clusters, so the combined sample
 * must mint them into the same window). Split-law corpusEpoch pins stay
 * per-lane as certified (temporal/multihop 138, conflict/nearcol 136) — the
 * split is a per-lane emission law, not part of the cross-family census.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import { generateTemporalClusters } from './temporal.mjs';
import { generateMultiHopClusters } from './multi_hop_relation.mjs';
import { generateConflictLifecycleClusters, CONFLICT_FAMILY } from './conflict_lifecycle.mjs';
import { generateNearCollisionAbstentionClusters, NEARCOL_FAMILY } from './near_collision_abstention.mjs';
import {
  createBmuActiveIndex, createEntityHoldoutIdentityStore, retireAgedClusters, m1Census,
  createM1Registry, makeCanonicalSplitOf,
  deriveBmuEpochDocIdKeyHex,
  BMU_E_F_MIN, BMU_CLUSTER_SIZE_K,
} from './common.mjs';
import { sampleSubjectBank as temporalSubjectBank } from './emit-temporal-sample-bank.mjs';
import { sampleSubjectBank as multihopSubjectBank } from './emit-multi-hop-sample-bank.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDist = resolve(here, '../../../packages/coretex/dist');
const { splitForRecord } = await import(`${pkgDist}/eval/retrieval-corpus.js`);
const { liveTailQueryId } = await import(`${pkgDist}/corpus/logical-delta-bridge.js`);

// ─── Pinned combined-sample params (§6.7b-exact: 380 rows total) ─────────────
export const COMBINED_PARAMS = Object.freeze({
  spec: 'BMU_SPEC.md rev3.2 ad7e523',
  epochs: [150, 151, 152],
  maxAge: 32,
  // clusters per epoch, sized so each family lands EXACTLY on E_f_min rows
  perFamilyClusters: {
    temporal: [6, 5, 5],                 // 16 clusters = 80 rows
    conflict_lifecycle: [8, 7, 7],       // 22 clusters = 110 rows
    multi_hop_relation: [8, 7, 7],       // 22 clusters = 110 rows
    near_collision_abstention: [6, 5, 5],// 16 clusters = 80 rows
  },
  seeds: {
    temporal: 'bmu-p2-temporal-cert-v1',
    conflict_lifecycle: 'bmu-p2-conflict-sample-bank-v1',
    multi_hop_relation: 'bmu-p2-multihop-cert-v1',
    near_collision_abstention: 'bmu-p2-nearcol-sample-bank-v1',
  },
  corpusEpochPins: { temporalLane: 138, conflictLane: 136 },
  universes: {
    temporal: 'user_scope_bmu_p2_temporal_cert',
    multi_hop_relation: 'user_scope_bmu_p2_multihop_cert',
  },
  ownerEntityId: 'e_universe',
});

/** bmuTask.family → production bucketed family (§5.6). */
const BUCKETED = Object.freeze({
  temporal: 'temporal',
  conflict_lifecycle: 'conflict_lifecycle',
  multi_hop_relation: 'multi_hop_relation',
  near_collision_abstention: 'near_collision',
});

// ─── Combined multi-epoch generation (shared mint-time m=1 structures) ───────
export function buildCombinedSample(params = COMBINED_PARAMS, { docIdMasterKeyHex } = {}) {
  const laneSplit = (corpusEpoch) => makeCanonicalSplitOf({ splitForRecord, liveTailQueryId, corpusEpoch });
  const splitTemporalLane = laneSplit(params.corpusEpochPins.temporalLane);
  const splitConflictLane = laneSplit(params.corpusEpochPins.conflictLane);

  // ONE active index across temporal+multihop, ONE registry across
  // conflict+nearcol — cross-family collisions inside each mechanism throw
  // at mint time; the unified census below covers the cross-mechanism pairs.
  const identityStore = createEntityHoldoutIdentityStore();
  const activeIndex = createBmuActiveIndex(identityStore);
  const registry = createM1Registry({}, identityStore);

  const conflictSubjects = Array.from({ length: 60 }, (_, i) => ({
    id: `e_bmu_p2c_s${i}`,
    canonicalName: i % 3 === 2 ? `corevault-svc-${i}` : `Persona Halden${i}`,
  }));
  const nearcolSubjects = Array.from({ length: 60 }, (_, i) => ({
    id: `e_bmu_p2n_s${i}`,
    canonicalName: i % 3 === 2 ? `lattice-svc-${i}` : `Persona Vintra${i}`,
  }));

  const families = {
    temporal: { clusters: [], rows: [], docs: [], relations: [] },
    conflict_lifecycle: { clusters: [], rows: [], docs: [], relations: [] },
    multi_hop_relation: { clusters: [], rows: [], docs: [], relations: [] },
    near_collision_abstention: { clusters: [], rows: [], docs: [], relations: [] },
  };
  const operationSequence = {
    temporal: 0,
    conflict_lifecycle: 0,
    multi_hop_relation: 0,
    near_collision_abstention: 0,
  };

  params.epochs.forEach((epoch, epochIdx) => {
    const docIdKeyHex = deriveBmuEpochDocIdKeyHex(docIdMasterKeyHex, epoch);
    retireAgedClusters(activeIndex, epoch, params.maxAge);

    const t = generateTemporalClusters({
      epoch, seed: params.seeds.temporal, docIdKeyHex, subjects: temporalSubjectBank(),
      universe: params.universes.temporal,
      clusterCount: params.perFamilyClusters.temporal[epochIdx],
      splitOf: splitTemporalLane, activeIndex,
      operationSequenceOffset: operationSequence.temporal,
    });
    operationSequence.temporal += params.perFamilyClusters.temporal[epochIdx];
    families.temporal.clusters.push(...t.clusters);
    for (const c of t.clusters) {
      families.temporal.rows.push(...c.rows);
      families.temporal.docs.push(...c.docs);
      families.temporal.relations.push(...c.relations);
    }

    const m = generateMultiHopClusters({
        epoch, seed: params.seeds.multi_hop_relation, docIdKeyHex, subjects: multihopSubjectBank(),
      universe: params.universes.multi_hop_relation,
      clusterCount: params.perFamilyClusters.multi_hop_relation[epochIdx],
      splitOf: splitTemporalLane, activeIndex,
      operationClassSlotOffset: operationSequence.multi_hop_relation,
    });
    operationSequence.multi_hop_relation += params.perFamilyClusters.multi_hop_relation[epochIdx];
    families.multi_hop_relation.clusters.push(...m.clusters);
    for (const c of m.clusters) {
      families.multi_hop_relation.rows.push(...c.rows);
      families.multi_hop_relation.docs.push(...c.docs);
      families.multi_hop_relation.relations.push(...c.relations);
    }

    const c = generateConflictLifecycleClusters({
      epoch, seed: params.seeds.conflict_lifecycle, docIdKeyHex, subjects: conflictSubjects,
      registry, splitOf: splitConflictLane,
      clusterCount: params.perFamilyClusters.conflict_lifecycle[epochIdx],
      escalationLevel: epochIdx, ownerEntityId: params.ownerEntityId,
      operationSequenceOffset: operationSequence.conflict_lifecycle,
    });
    operationSequence.conflict_lifecycle += params.perFamilyClusters.conflict_lifecycle[epochIdx];
    families.conflict_lifecycle.clusters.push(...c.clusters);
    families.conflict_lifecycle.rows.push(...c.addedQueries);
    families.conflict_lifecycle.docs.push(...c.addedDocs);
    families.conflict_lifecycle.relations.push(...c.addedRelations);

    const n = generateNearCollisionAbstentionClusters({
        epoch, seed: params.seeds.near_collision_abstention, docIdKeyHex, subjects: nearcolSubjects,
      registry, splitOf: splitConflictLane,
      clusterCount: params.perFamilyClusters.near_collision_abstention[epochIdx],
      escalationLevel: epochIdx, ownerEntityId: params.ownerEntityId,
      operationClassSlotOffset: operationSequence.near_collision_abstention,
    });
    operationSequence.near_collision_abstention += params.perFamilyClusters.near_collision_abstention[epochIdx];
    families.near_collision_abstention.clusters.push(...n.clusters);
    families.near_collision_abstention.rows.push(...n.addedQueries);
    families.near_collision_abstention.docs.push(...n.addedDocs);
    families.near_collision_abstention.relations.push(...n.addedRelations);
  });

  return { params, families, mintTimeM1: { activeIndexCensus: m1Census(activeIndex), registrySnapshot: registry.snapshot() } };
}

// ─── Check 1: unified GLOBAL m=1 census across ALL four families ────────────
export function globalM1Census(families) {
  const bySubject = new Map();   // subjectEntityId -> [{family, motifGroupId}]
  const byTemplate = new Map();  // templateId -> [{family, motifGroupId}]
  const byIdentity = new Map();  // alias/canonical identity key -> [{family, motifGroupId}]
  const byMotif = new Map();     // motifGroupId -> family (motif ids must be globally unique too)
  const violations = [];
  for (const [family, lane] of Object.entries(families)) {
    for (const cluster of lane.clusters) {
      if (byMotif.has(cluster.motifGroupId)) {
        violations.push(`motifGroupId '${cluster.motifGroupId}' minted by both '${byMotif.get(cluster.motifGroupId)}' and '${family}'`);
      } else byMotif.set(cluster.motifGroupId, family);
      const s = bySubject.get(cluster.subjectEntityId) ?? [];
      s.push({ family, motifGroupId: cluster.motifGroupId });
      bySubject.set(cluster.subjectEntityId, s);
      for (const t of cluster.templateIds) {
        const arr = byTemplate.get(t) ?? [];
        arr.push({ family, motifGroupId: cluster.motifGroupId });
        byTemplate.set(t, arr);
      }
      for (const key of cluster.entityHoldoutKeys ?? []) {
        const arr = byIdentity.get(key) ?? [];
        arr.push({ family, motifGroupId: cluster.motifGroupId });
        byIdentity.set(key, arr);
      }
    }
  }
  for (const [subj, refs] of bySubject) {
    if (refs.length > 1) violations.push(`subject '${subj}' in ${refs.length} active clusters: ${refs.map((r) => `${r.family}:${r.motifGroupId}`).join(', ')}`);
  }
  for (const [tpl, refs] of byTemplate) {
    if (refs.length > 1) violations.push(`templateId '${tpl}' in ${refs.length} active clusters: ${refs.map((r) => `${r.family}:${r.motifGroupId}`).join(', ')}`);
  }
  for (const [key, refs] of byIdentity) {
    if (refs.length > 1) violations.push(`entityHoldoutKey '${key}' in ${refs.length} active clusters: ${refs.map((r) => `${r.family}:${r.motifGroupId}`).join(', ')}`);
  }
  return {
    violations,
    holds: violations.length === 0,
    counts: {
      clusters: byMotif.size,
      distinctSubjects: bySubject.size,
      distinctTemplates: byTemplate.size,
      distinctEntityHoldoutKeys: byIdentity.size,
    },
  };
}

// ─── Check 2: cross-family dedup scan ────────────────────────────────────────
const normText = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

/** publicIntent identity WITHOUT family/epoch dimensions (the §6.4
 *  dedupePublicIntent key includes family+epoch, which can never collide
 *  across families by construction — this scan is strictly stronger). */
function familyAgnosticIntentKey(row) {
  const pi = row.publicIntent ?? {};
  const entries = Object.entries({ ...pi, subjectEntityId: row.subjectEntityId ?? pi.subjectEntityId })
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify(entries);
}

export function crossFamilyDedup(families) {
  const scans = {
    rowId: new Map(), docId: new Map(), docText: new Map(),
    queryText: new Map(), publicIntentKey: new Map(),
  };
  const put = (map, key, family, ref) => {
    const arr = map.get(key) ?? [];
    arr.push({ family, ref });
    map.set(key, arr);
  };
  for (const [family, lane] of Object.entries(families)) {
    for (const row of lane.rows) {
      put(scans.rowId, row.id, family, row.id);
      put(scans.queryText, normText(row.queryText), family, row.id);
      put(scans.publicIntentKey, familyAgnosticIntentKey(row), family, row.id);
    }
    for (const doc of lane.docs) {
      put(scans.docId, doc.id, family, doc.id);
      put(scans.docText, normText(doc.text), family, doc.id);
    }
  }
  const report = {};
  for (const [name, map] of Object.entries(scans)) {
    const all = [...map.values()].filter((refs) => refs.length > 1);
    const crossFamily = all.filter((refs) => new Set(refs.map((r) => r.family)).size > 1);
    report[name] = {
      keys: map.size,
      duplicateKeys: all.length,
      crossFamilyDuplicateKeys: crossFamily.length,
      crossFamilyExamples: crossFamily.slice(0, 5).map((refs) => refs.map((r) => `${r.family}:${r.ref}`)),
      // within-family exact duplicates are also a defect for text/ids:
      withinFamilyDuplicateKeys: all.length - crossFamily.length,
    };
  }
  const clean = Object.values(report).every((r) => r.crossFamilyDuplicateKeys === 0)
    && report.rowId.duplicateKeys === 0 && report.docId.duplicateKeys === 0;
  return { clean, report };
}

// ─── Check 3: composition sanity (schema level always; pack law if dist) ────
function rowToProductionEvent(row) {
  return {
    id: liveTailQueryId(row.id, row.liveUpdateEpoch),
    family: BUCKETED[row.bmuTask.family],
    logicalFamily: row.family,
    domain: 'bmu_p2_combined',
    split: 'eval_hidden',
    queryText: row.queryText,
    truthDocuments: [],
    hardNegatives: [],
    qrels: (row.qrels ?? []).map((q) => ({ documentId: q.docId ?? q.documentId, relevance: q.relevance })),
    protected: false,
    ownerEntityId: row.ownerEntityId,
    subjectEntityId: row.subjectEntityId,
    publicIntent: row.publicIntent,
    band: row.band,
    bmuTask: row.bmuTask,
    ...(row.bmuOperationCue ? { bmuOperationCue: row.bmuOperationCue } : {}),
    ...(row.bmuOperationProgram ? { bmuOperationProgram: row.bmuOperationProgram } : {}),
    provenance: { source: 'synthetic_challenge', sourceHash: `0x${'00'.repeat(32)}` },
  };
}

export function schemaLevelCompositionCheck(families) {
  const errors = [];
  const perFamily = {};
  for (const [family, lane] of Object.entries(families)) {
    const rows = lane.rows;
    perFamily[family] = { rows: rows.length, clusters: lane.clusters.length, eFMin: BMU_E_F_MIN[family] };
    if (rows.length < BMU_E_F_MIN[family]) errors.push(`${family}: ${rows.length} rows < E_f_min ${BMU_E_F_MIN[family]}`);
    if (rows.length !== lane.clusters.length * BMU_CLUSTER_SIZE_K) errors.push(`${family}: partial cluster (${rows.length} rows != ${lane.clusters.length} * k=${BMU_CLUSTER_SIZE_K})`);
    for (const row of rows) {
      const t = row.bmuTask;
      if (!t) { errors.push(`${row.id}: missing bmuTask`); continue; }
      if (t.family !== family) errors.push(`${row.id}: bmuTask.family '${t.family}' != lane '${family}'`);
      if (!t.motifGroupId || !t.templateId) errors.push(`${row.id}: missing motifGroupId/templateId`);
      if (!Number.isInteger(t.budgetB) || t.budgetB < 1) errors.push(`${row.id}: bad budgetB`);
      if (!Array.isArray(t.requiredEvidence) || !Array.isArray(t.forbiddenEvidence)) errors.push(`${row.id}: missing evidence arrays`);
      if (t.abstain) {
        if (t.requiredEvidence.length !== 0 || 'answer' in t) errors.push(`${row.id}: abstain row carries required/answer`);
      } else if (!t.answer || !t.answer.id) errors.push(`${row.id}: answerable row missing answer.id`);
    }
  }
  const total = Object.values(perFamily).reduce((n, f) => n + f.rows, 0);
  if (total !== 380) errors.push(`combined bank has ${total} rows (spec §6.7b N_min target is exactly 380 for this check)`);
  return { level: 'schema', errors, ok: errors.length === 0, perFamily, totalRows: total };
}

export async function packLawCompositionCheck(families, packLawDistPath) {
  const dist = await import(pathToFileURL(resolve(packLawDistPath, 'index.js')).href);
  const { deriveBmuDualPacks, computeCorpusRoot, packQuotaCoverage, bmuEventExcluded, bmuExclusionKeySetForPack } = dist;
  if (typeof deriveBmuDualPacks !== 'function') {
    return { level: 'schema', packLaw: 'dist at --pack-law-dist does not export deriveBmuDualPacks — pack-law check skipped' };
  }
  const events = Object.values(families).flatMap((lane) => lane.rows.map(rowToProductionEvent));
  const corpus = {
    events,
    byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot: computeCorpusRoot(events),
    corpusEpoch: 0,
    biEncoderModelId: 'bge-m3', biEncoderRevision: '5617a9f6',
    biEncoderRetrievalKeyLayout: { dim: 8, headerBytes: 9, quantization: 'int8' },
    labelingModelId: 'offline', labelingModelRevision: 'p2',
  };
  // §6.2 v1 shape: packSize 64, quotas 10/15/15/10, familySlots 3/3/3/3.
  const profile = {
    packSize: 64,
    quotas: [
      { stratum: 'family=temporal', minCount: 10 },
      { stratum: 'family=conflict_lifecycle', minCount: 15 },
      { stratum: 'family=multi_hop_relation', minCount: 15 },
      { stratum: 'family=near_collision', minCount: 10 },
    ],
  };
  const law = {
    limit: 12,
    familyPriority: ['temporal_update', 'conflict_lifecycle', 'multi_session_bridge', 'abstention_missing'],
    familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 3 },
    freshWindow: 2,
  };
  const epochId = 152;
  const gateSeedHex = `0x${'a2'.repeat(32)}`;
  const confirmSeedHex = `0x${'b3'.repeat(32)}`;
  const activeLiveEval = { activeIds: new Set(events.map((e) => e.id)), law };

  const errors = [];
  const dual = deriveBmuDualPacks({ epochId, gateSeedHex, confirmSeedHex, corpus, profile, activeLiveEval });

  for (const [name, pack] of [['gate', dual.gate], ['confirm', dual.confirm]]) {
    if (pack.events.length !== profile.packSize) errors.push(`${name}: ${pack.events.length} rows != packSize ${profile.packSize}`);
    for (const cov of packQuotaCoverage(pack, profile)) {
      if (!cov.satisfied) errors.push(`${name}: quota ${cov.stratum} ${cov.count}/${cov.minCount}`);
    }
    for (const e of pack.events) if (!e.bmuTask) errors.push(`${name}: row ${e.id} lacks bmuTask`);
  }
  for (const e of dual.confirm.events) {
    if (bmuEventExcluded(e, dual.exclusionKeys)) errors.push(`held-out violation: confirm row ${e.id} collides with gate exclusion set`);
  }
  const gateKeys = [...bmuExclusionKeySetForPack(dual.gate)].sort();
  if (JSON.stringify(gateKeys) !== JSON.stringify([...dual.exclusionKeys].sort())) errors.push('exclusionKeys != gate pack key set');
  const freshPrefixes = [151, 152].map((ep) => `zz_e${String(ep).padStart(12, '0')}_`);
  const freshPerFam = { temporal: 0, conflict_lifecycle: 0, multi_hop_relation: 0, near_collision_abstention: 0 };
  for (const e of dual.gate.events) {
    if (freshPrefixes.some((p) => e.id.startsWith(p))) freshPerFam[e.bmuTask.family] += 1;
  }
  for (const [fam, n] of Object.entries(freshPerFam)) {
    if (n < law.familySlots[fam]) errors.push(`gate fresh slots: family ${fam} has ${n} fresh-window rows < ${law.familySlots[fam]}`);
  }
  const again = deriveBmuDualPacks({ epochId, gateSeedHex, confirmSeedHex, corpus, profile, activeLiveEval });
  if (JSON.stringify(again.gate.events.map((e) => e.id)) !== JSON.stringify(dual.gate.events.map((e) => e.id))
    || JSON.stringify(again.confirm.events.map((e) => e.id)) !== JSON.stringify(dual.confirm.events.map((e) => e.id))) {
    errors.push('re-derivation not byte-identical');
  }
  const overlap = dual.gate.events.filter((e) => dual.confirm.events.some((c) => c.id === e.id));
  if (overlap.length > 0) errors.push(`gate/confirm share ${overlap.length} row ids`);

  return {
    level: 'full-pack-law',
    ok: errors.length === 0,
    errors,
    packLawPins: { epochId, gateSeedHex, confirmSeedHex, profile, law },
    gate: { size: dual.gate.events.length, ids: dual.gate.events.map((e) => e.id) },
    confirm: { size: dual.confirm.events.length, ids: dual.confirm.events.map((e) => e.id) },
    exclusionKeyCount: dual.exclusionKeys.size,
    gateFreshPerFamily: freshPerFam,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = {};
  const positional = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) { args[a.slice(2)] = process.argv[++i]; } else positional.push(a);
  }
  const outDir = positional[0];
  if (!outDir) { console.error('usage: cross-family-checks.mjs <outDir> [--pack-law-dist <dist>]'); process.exit(1); }
  mkdirSync(outDir, { recursive: true });

  const { params, families, mintTimeM1 } = buildCombinedSample(COMBINED_PARAMS, {
    docIdMasterKeyHex: process.env.CORETEX_BMU_DOC_ID_KEY_HEX,
  });
  const census = globalM1Census(families);
  const dedup = crossFamilyDedup(families);
  const schema = schemaLevelCompositionCheck(families);
  const composition = args['pack-law-dist']
    ? await packLawCompositionCheck(families, args['pack-law-dist'])
    : { level: 'schema', note: 'no --pack-law-dist given: schema-level check only (see `schema`)' };

  const bank = {
    kind: 'bmu-p2-combined-cross-family-sample',
    spec: params.spec,
    params,
    perFamily: Object.fromEntries(Object.entries(families).map(([f, lane]) => [f, {
      clusters: lane.clusters.length,
      rows: lane.rows.length,
      docs: lane.docs.length,
    }])),
    families,
  };
  const bankJson = JSON.stringify(bank, null, 1);
  writeFileSync(resolve(outDir, 'combined-sample-bank.json'), bankJson);

  const report = {
    kind: 'bmu-p2-cross-family-checks',
    spec: params.spec,
    generatedAt: new Date().toISOString(),
    combinedBankSha256: createHash('sha256').update(bankJson).digest('hex'),
    mintTimeM1: { activeIndexCensusViolations: mintTimeM1.activeIndexCensus, registryClaims: {
      subjects: mintTimeM1.registrySnapshot.subjectEntityIds.length,
      templates: mintTimeM1.registrySnapshot.templateIds.length,
    } },
    check1_globalM1Census: census,
    check2_crossFamilyDedup: dedup,
    check3_composition: { schema, packLaw: composition },
    ok: census.holds && dedup.clean && schema.ok && (composition.level !== 'full-pack-law' || composition.ok),
  };
  writeFileSync(resolve(outDir, 'cross-family-report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({
    ok: report.ok,
    census: { holds: census.holds, ...census.counts, violations: census.violations.slice(0, 5) },
    dedup: { clean: dedup.clean },
    schema: { ok: schema.ok, totalRows: schema.totalRows, errors: schema.errors.slice(0, 5) },
    composition: composition.level === 'full-pack-law'
      ? { level: composition.level, ok: composition.ok, errors: (composition.errors ?? []).slice(0, 8), gateSize: composition.gate?.size, confirmSize: composition.confirm?.size, exclusionKeyCount: composition.exclusionKeyCount, gateFreshPerFamily: composition.gateFreshPerFamily }
      : composition,
  }, null, 1));
  if (!report.ok) process.exit(1);
}
