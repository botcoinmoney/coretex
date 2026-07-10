/**
 * BMU P2 sample-bank emission — family near_collision_abstention.
 *
 * Emits a certification-sized bank (>= 16 clusters / >= 80 rows across >= 3
 * synthetic epochs — sized to the §6.7b near_collision E_f_min = 80) as JSON,
 * plus a manifest with the full generation parameters. The BANK file is a
 * pure function of the parameters below (no wall clock inside); the manifest
 * carries provenance (git sha, timestamp, counts, censuses).
 *
 * Usage: node scripts/lib/bmu-generators/emit-nearcol-sample-bank.mjs <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateNearCollisionAbstentionClusters, NEARCOL_FAMILY } from './near_collision_abstention.mjs';
import { createM1Registry, m1CensusOverRows, makeCanonicalSplitOf, BMU_CLUSTER_SIZE_K } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const { splitForRecord, liveTailQueryId } = await import(resolve(repoRoot, 'packages/coretex/dist/index.js'));

const outDir = process.argv[2];
if (!outDir) { console.error('usage: emit-nearcol-sample-bank.mjs <outDir>'); process.exit(1); }

// ─── Pinned generation parameters (the manifest's `params`) ─────────────────
const PARAMS = {
  family: NEARCOL_FAMILY,
  seed: 'bmu-p2-nearcol-sample-bank-v1',
  corpusEpoch: 136, // live corpus epoch at generation time (split-law input)
  epochs: [
    { epoch: 137, clusterCount: 6, escalationLevel: 0 },
    { epoch: 138, clusterCount: 6, escalationLevel: 1 },
    { epoch: 139, clusterCount: 6, escalationLevel: 2 },
  ],
  subjectBankSize: 60,
  ownerEntityId: 'e_universe',
};

// Synthetic subject bank: deterministic, corpus-convention ids (`_s<i>` tail,
// `-svc-` marks projects), names token-disjoint from the generator's value
// banks so the leak lint stays meaningful.
const subjects = Array.from({ length: PARAMS.subjectBankSize }, (_, i) => ({
  id: `e_bmu_p2n_s${i}`,
  canonicalName: i % 3 === 2 ? `lattice-svc-${i}` : `Persona Vintra${i}`,
}));

const splitOf = makeCanonicalSplitOf({ splitForRecord, liveTailQueryId, corpusEpoch: PARAMS.corpusEpoch });
const registry = createM1Registry(); // shared across epochs → GLOBAL m=1 within the bank window

const perEpoch = [];
const allRows = [];
const allDocs = [];
const allRelations = [];
const allClusters = [];
let operationClassSlotOffset = 0;
for (const spec of PARAMS.epochs) {
  const out = generateNearCollisionAbstentionClusters({
    epoch: spec.epoch, seed: PARAMS.seed, subjects, registry, splitOf,
    clusterCount: spec.clusterCount, escalationLevel: spec.escalationLevel,
    ownerEntityId: PARAMS.ownerEntityId,
    operationClassSlotOffset,
  });
  operationClassSlotOffset += spec.clusterCount;
  perEpoch.push({ epoch: spec.epoch, telemetry: out.telemetry });
  allRows.push(...out.addedQueries);
  allDocs.push(...out.addedDocs);
  allRelations.push(...out.addedRelations);
  allClusters.push(...out.clusters);
}

// ─── Gates before writing (fail-closed emission) ────────────────────────────
const census = m1CensusOverRows(allRows);
if (census.length > 0) { console.error('m=1 census FAILED:\n' + census.join('\n')); process.exit(1); }
if (allClusters.length < 16) { console.error(`cluster count ${allClusters.length} < 16`); process.exit(1); }
if (allRows.length < 80) { console.error(`row count ${allRows.length} < 80 (near_collision E_f_min)`); process.exit(1); }
if (allRows.length !== allClusters.length * BMU_CLUSTER_SIZE_K) { console.error('partial cluster detected'); process.exit(1); }
for (const row of allRows) {
  if (splitForRecord(liveTailQueryId(row.id, row.liveUpdateEpoch), PARAMS.corpusEpoch) !== 'eval_hidden') {
    console.error(`row ${row.id} not eval_hidden under canonical split`); process.exit(1);
  }
}
// §5.4 family-mix gate: exactly one abstain row per cluster (4:1), and every
// abstain row is genuinely unanswerable (its forbidden set includes E).
const abstainRows = allRows.filter((r) => r.bmuTask.abstain);
if (abstainRows.length !== allClusters.length) { console.error(`abstain rows ${abstainRows.length} != clusters ${allClusters.length}`); process.exit(1); }
for (const row of abstainRows) {
  if (row.bmuTask.requiredEvidence.length !== 0 || 'answer' in row.bmuTask || !row.abstain) {
    console.error(`abstain row ${row.id} violates the §4.1 abstain laws`); process.exit(1);
  }
}

const bank = {
  schema: 'coretex.bmu-p2-sample-bank.v1',
  family: NEARCOL_FAMILY,
  params: PARAMS,
  counts: {
    clusters: allClusters.length, rows: allRows.length,
    answerableRows: allRows.length - abstainRows.length, abstainRows: abstainRows.length,
    publicDocs: allDocs.length, relations: allRelations.length,
  },
  clusters: allClusters,
  publicDocs: allDocs,
  relations: allRelations,
  rows: allRows,
};

let gitSha = 'unknown';
try { gitSha = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim(); } catch { /* provenance only */ }

const manifest = {
  schema: 'coretex.bmu-p2-sample-bank-manifest.v1',
  family: NEARCOL_FAMILY,
  specPin: 'BMU_SPEC.md rev3.2 (ad7e523)',
  generator: 'scripts/lib/bmu-generators/near_collision_abstention.mjs',
  generatorRepoSha: gitSha,
  generatedAt: new Date().toISOString(),
  params: PARAMS,
  counts: bank.counts,
  perEpoch,
  gates: {
    m1CensusErrors: census,
    minClusters: 16, minRows: 80,
    allRowsEvalHiddenUnderCanonicalSplit: true,
    wholeClustersOnly: true,
    abstainMixOnePerCluster: true,
    abstainRowsHonorSchemaLaws: true,
  },
  m1Snapshot: registry.snapshot(),
};

mkdirSync(outDir, { recursive: true });
const bankPath = resolve(outDir, 'sample-bank.json');
const manifestPath = resolve(outDir, 'manifest.json');
writeFileSync(bankPath, JSON.stringify(bank, null, 1) + '\n');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
console.log(`wrote ${bankPath} (${allClusters.length} clusters, ${allRows.length} rows [${bank.counts.abstainRows} abstain], ${allDocs.length} docs)`);
console.log(`wrote ${manifestPath}`);
