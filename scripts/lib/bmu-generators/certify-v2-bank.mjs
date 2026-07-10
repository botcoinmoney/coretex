/**
 * BMU v2 bank certification, intentionally split into PUBLIC attackers and a
 * HIDDEN offline solvability oracle.
 *
 * The engine is family-agnostic. A family adapter only declares conservative
 * operation capacity and optional public-only attacker lanes; extraction,
 * random-K, metadata/path attacks, dedup, alias-aware m=1, role retirement,
 * operation census, and the BGE→Qwen no-substrate contract are generic. New
 * multi-hop/near-collision adapters can therefore be registered without
 * changing any gate implementation.
 */
import { createHash } from 'node:crypto';
import { judgeTopB, randomKRank, CERT_PINS } from './certify.mjs';
import { subjectScopedRecencyLane, validityCurrencyLane } from './certify-lanes.mjs';
import { opaqueBmuDocId } from './common.mjs';
import { executableOperationSignature, executeProgramOverRelations, BMU_EXECUTABLE_PROGRAM_CAPACITY } from './operation-program.mjs';

const normText = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Every family's conservative operation capacity is the ONE shared executable
 * program capacity (BMU_EXECUTABLE_PROGRAM_CAPACITY). There are no per-family
 * capacity constants: the executable class bank is family-agnostic (the 6x6
 * disjoint-partition deep-terminal program bank), so the resident/certification capacity a
 * family must exceed is derived from that shared law, not hardcoded per family.
 * All four executable-era families ship a default certification adapter.
 */
const SHARED_OPERATION_CAPACITY = BMU_EXECUTABLE_PROGRAM_CAPACITY;
export const DEFAULT_V2_BANK_ADAPTERS = Object.freeze({
  temporal: Object.freeze({
    conservativeOperationCapacity: SHARED_OPERATION_CAPACITY,
    maxActiveEpochGap: 32,
    publicAttackers: Object.freeze({
      subjectScopedRecency: (row, docs) => subjectScopedRecencyLane(row, docs),
      validityCurrency: (row, docs) => validityCurrencyLane(row, docs),
    }),
  }),
  conflict_lifecycle: Object.freeze({
    conservativeOperationCapacity: SHARED_OPERATION_CAPACITY,
    maxActiveEpochGap: 32,
    publicAttackers: Object.freeze({}),
  }),
  multi_hop_relation: Object.freeze({
    conservativeOperationCapacity: SHARED_OPERATION_CAPACITY,
    maxActiveEpochGap: 32,
    publicAttackers: Object.freeze({}),
  }),
  near_collision_abstention: Object.freeze({
    conservativeOperationCapacity: SHARED_OPERATION_CAPACITY,
    maxActiveEpochGap: 32,
    publicAttackers: Object.freeze({}),
  }),
});

/** Structural bank normalizer. No family switch: either the bank already has
 * top-level arrays or its clusters own rows/docs/relations. */
export function normalizeV2Bank(bank) {
  if (!bank || typeof bank !== 'object') throw new Error('normalizeV2Bank: bank object required');
  const clusters = Array.isArray(bank.clusters) ? bank.clusters : [];
  const docs = Array.isArray(bank.publicDocs) ? bank.publicDocs : clusters.flatMap((cluster) => cluster.docs ?? []);
  const rows = Array.isArray(bank.rows) ? bank.rows : clusters.flatMap((cluster) => cluster.rows ?? []);
  const relations = Array.isArray(bank.relations) ? bank.relations : clusters.flatMap((cluster) => cluster.relations ?? []);
  if (clusters.length === 0 || docs.length === 0 || rows.length === 0) {
    throw new Error('normalizeV2Bank: non-empty clusters/docs/rows required');
  }
  const docById = new Map(docs.map((doc) => [doc.id, doc]));
  const rowsByMotif = new Map();
  for (const row of rows) {
    const motif = row.bmuTask?.motifGroupId;
    const list = rowsByMotif.get(motif) ?? [];
    list.push(row);
    rowsByMotif.set(motif, list);
  }
  const normalizedClusters = clusters.map((cluster) => {
    const clusterRows = cluster.rows ?? rowsByMotif.get(cluster.motifGroupId) ?? [];
    const docIds = cluster.docIds ?? cluster.docs?.map((doc) => doc.id) ?? [];
    const clusterDocs = cluster.docs ?? docIds.map((id) => docById.get(id)).filter(Boolean);
    const ids = new Set(clusterDocs.map((doc) => doc.id));
    const clusterRelations = cluster.relations ?? relations.filter((rel) => ids.has(rel.src) && ids.has(rel.dst));
    return { ...cluster, rows: clusterRows, docs: clusterDocs, relations: clusterRelations };
  });
  return { family: bank.family, params: bank.params ?? {}, clusters: normalizedClusters, docs, rows, relations, docById };
}

export function makeV2BankAdapter({ conservativeOperationCapacity, maxActiveEpochGap = 32, publicAttackers = {} }) {
  if (!Number.isInteger(conservativeOperationCapacity) || conservativeOperationCapacity < 1) {
    throw new Error('makeV2BankAdapter: positive conservativeOperationCapacity required');
  }
  if (!Number.isInteger(maxActiveEpochGap) || maxActiveEpochGap < 1) throw new Error('makeV2BankAdapter: positive maxActiveEpochGap required');
  for (const [name, lane] of Object.entries(publicAttackers)) {
    if (typeof lane !== 'function') throw new Error(`makeV2BankAdapter: attacker '${name}' must be a function`);
  }
  return Object.freeze({ conservativeOperationCapacity, maxActiveEpochGap, publicAttackers: Object.freeze({ ...publicAttackers }) });
}

function publicMetadata(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  delete copy.id;
  delete copy.text;
  return copy;
}

function terminalTopology(cluster, docId) {
  const path = cluster.publicPath;
  return cluster.relations
    .filter((rel) => rel.src === docId)
    .map((rel) => ({
      type: rel.type,
      label: rel.label ?? null,
      dstClass: rel.dst === path.pivotId ? 'pivot' : rel.dst === path.seedId ? 'seed' : 'other',
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * Deep-terminal route-closure audit (fix 2a/2b hard contract). Executes the
 * cluster's ACTUAL public program from its public seed over the cluster
 * relations and requires:
 *   (a) the executed terminal set equals the declared gold terminal set —
 *       the program routes the operation-required answer terminal(s) and
 *       NOTHING else (no decoy, no forbidden doc);
 *   (b) golds are observationally identical to each other (metadata +
 *       relation-shape), so nothing beyond the routed position separates
 *       them;
 *   (c) decoys are observationally identical to each other and are depth-1
 *       dead ends (zero incoming continuation — never routable).
 * The legacy "gold indistinguishable from decoys" balance is intentionally
 * superseded: under the single-answer-terminal law the route itself is the
 * public pointer at the answer; the reward channel is state execution, not
 * secrecy of the answer position.
 */
export function balancedTerminalAudit(cluster) {
  const path = cluster.publicPath;
  if (!path || !Array.isArray(path.terminalBranchIds) || path.terminalBranchIds.length < 1) {
    return { pass: false, reason: 'missing_publicPath_terminal_branches' };
  }
  const docById = new Map(cluster.docs.map((doc) => [doc.id, doc]));
  const missing = path.terminalBranchIds.filter((id) => !docById.has(id));
  if (missing.length > 0) return { pass: false, reason: 'missing_terminal_docs', missing };
  const gold = new Set(path.goldBranchIds ?? []);
  const decoy = new Set(path.decoyBranchIds ?? []);
  const terminalsAreExactlyGold = path.terminalBranchIds.length === gold.size
    && path.terminalBranchIds.every((id) => gold.has(id))
    && path.terminalBranchIds.every((id) => !decoy.has(id));
  let routeClosure = { pass: false, reason: 'route_execution_failed' };
  try {
    const executed = executeProgramOverRelations({
      program: cluster.bmuOperationProgram,
      relations: cluster.relations,
      seedIds: [path.seedId],
    });
    const executedSet = new Set(executed.terminalIds);
    routeClosure = {
      pass: executedSet.size === gold.size && [...gold].every((id) => executedSet.has(id)),
      executedTerminalIds: [...executedSet].sort(compareId),
      routedDecoys: executed.terminalIds.filter((id) => decoy.has(id)),
    };
  } catch (error) {
    routeClosure = { pass: false, reason: `route_execution_failed: ${String(error?.message ?? error)}` };
  }
  const signatureOf = (id) => JSON.stringify({
    metadata: publicMetadata(docById.get(id)), topology: terminalTopology(cluster, id),
    incoming: cluster.relations.filter((rel) => rel.dst === id).length,
  });
  const goldSignatures = new Set([...gold].map(signatureOf));
  const decoySignatures = new Set([...decoy].map(signatureOf));
  const decoysAreDeadEnds = [...decoy].every((id) =>
    cluster.relations.filter((rel) => rel.dst === id).length === 0);
  return {
    pass: terminalsAreExactlyGold && routeClosure.pass && gold.size > 0 && decoy.size > 0
      && goldSignatures.size === 1 && decoySignatures.size === 1 && decoysAreDeadEnds,
    terminalsAreExactlyGold,
    routeClosure,
    goldObservableClasses: goldSignatures.size,
    decoyObservableClasses: decoySignatures.size,
    decoysAreDeadEnds,
    terminalCount: path.terminalBranchIds.length,
    goldCount: gold.size,
    decoyCount: decoy.size,
  };
}

/** PUBLIC attacker: path membership, public metadata, opaque id and relation
 * structure only. Text, qrels, bmuTask and generator roles are absent from its
 * signature. Terminal candidates sort first; balanced signatures reduce its
 * final choice to opaque id. */
export function idMetadataPathAttacker(row, lane, cluster) {
  const terminals = new Set(cluster.publicPath?.terminalBranchIds ?? []);
  const scored = lane.docs.map((doc) => {
    const inPath = terminals.has(doc.id) ? 1 : 0;
    const signature = inPath
      ? JSON.stringify({ metadata: publicMetadata(doc), topology: terminalTopology(cluster, doc.id) })
      : JSON.stringify({ metadata: publicMetadata(doc), topology: [] });
    return { docId: doc.id, inPath, signature };
  });
  scored.sort((a, b) => b.inPath - a.inPath || a.signature.localeCompare(b.signature) || compareId(a.docId, b.docId));
  return scored.map(({ docId }) => ({ docId, score: 0 }));
}

/** PUBLIC attacker with the path channel REMOVED: opaque id + public metadata
 * only. Under the deep-terminal law the routed-terminal position is public by
 * design (the program points at the answer), so the hard blindness gate is
 * that ids and metadata alone — without executing the public program — solve
 * nothing. */
export function idMetadataOnlyAttacker(row, lane) {
  const scored = lane.docs.map((doc) => ({
    docId: doc.id,
    signature: JSON.stringify({ metadata: publicMetadata(doc) }),
  }));
  scored.sort((a, b) => a.signature.localeCompare(b.signature) || compareId(a.docId, b.docId));
  return scored.map(({ docId }) => ({ docId, score: 0 }));
}

const indexedSlots = (prefix, max = 64, start = 0) =>
  Array.from({ length: max - start + 1 }, (_, index) => `${prefix}:${start + index}`);
const boundedSinkSlots = (prefix) =>
  Array.from({ length: 65 }, (_, group) => [0, 1].map((sink) => `${prefix}:${group}:${sink}`)).flat();

/** Generator source is public, so the known-seed attacker may enumerate every
 * internal slot spelling and a conservative superset of all bounded indices.
 * Supplying motifGroupId directly is stronger than requiring the attacker to
 * recover it from public epoch/subject/pivot text. */
export const GENERATOR_INVERSION_SLOTS = Object.freeze({
  temporal: Object.freeze([
    'current', 'stale_trap', 'change_provenance', 'public_path_pivot',
    ...indexedSlots('escalation_shadow'), ...indexedSlots('current_unrelated_attribute', 3),
  ]),
  conflict_lifecycle: Object.freeze([
    'conflict_candidate_trap', 'conflict_resolved', 'resolution_record', 'public_path_pivot',
    ...indexedSlots('scope_mismatch_decoy'),
  ]),
  multi_hop_relation: Object.freeze([
    'chain_hop1', 'chain_hop2', 'chain_answer', 'offpath_decoy', 'near_bridge_decoy',
    ...indexedSlots('chain_hop2_mirror', 64, 1), ...indexedSlots('offpath_shadow'),
    ...indexedSlots('path_balance_decoy'), ...indexedSlots('path_anchor', 64, 1),
    ...indexedSlots('path_truth_control', 64, 1),
    ...boundedSinkSlots('path_sink'),
  ]),
  near_collision_abstention: Object.freeze([
    'exact_match', 'disambiguation_record', 'scope_lookalike_decoy:0',
    ...indexedSlots('alias_collision_decoy'), ...indexedSlots('attribute_lookalike_decoy'),
    ...indexedSlots('public_path_anchor', 64, 1), ...indexedSlots('public_path_truth_control', 64, 1),
    ...boundedSinkSlots('public_path_sink'),
  ]),
});

function legacySeedOnlyDocId({ seed, epoch, motifGroupId, slot }) {
  return `d_bmu_${createHash('sha256')
    .update('coretex-bmu-doc-id-v1\0')
    .update(seed).update('\0')
    .update(String(epoch)).update('\0')
    .update(motifGroupId).update('\0')
    .update(slot)
    .digest('hex')}`;
}

function knownSeedKeyGuess(seed) {
  return `0x${createHash('sha256').update('coretex-bmu-known-seed-key-guess-v1\0').update(seed).digest('hex')}`;
}

/**
 * PUBLIC known-seed identifier-inversion attacker. It receives the generator
 * seed/source conventions and even the exact motif id, but never the hidden
 * doc-id key, qrels, bmuTask, roles, answers, or text-to-role matching. It
 * tries both the refuted v1 seed-only formula and an HMAC keyed by a public
 * seed-derived guess. Any exact public-id match is a gate failure; the empty
 * ranking on zero matches makes judge success impossible without a fallback
 * shortcut (metadata/text/recency are covered by separate lanes).
 */
export function knownSeedGeneratorInversionAttacker(row, lane, cluster, {
  attackerDocIdKeyHex = knownSeedKeyGuess(lane.params?.seed ?? ''),
} = {}) {
  const seed = lane.params?.seed;
  const family = lane.family;
  const slots = GENERATOR_INVERSION_SLOTS[family];
  if (typeof seed !== 'string' || seed.length === 0 || !slots) {
    return { ranking: [], matchedGuessedDocIds: [], guessedIdCount: 0, error: 'missing_seed_or_family_slot_registry' };
  }
  const actual = new Set(lane.docs.map((doc) => doc.id));
  const guessed = [];
  for (const slot of slots) {
    guessed.push(legacySeedOnlyDocId({ seed, epoch: cluster.epoch, motifGroupId: cluster.motifGroupId, slot }));
    guessed.push(opaqueBmuDocId({ docIdKeyHex: attackerDocIdKeyHex, seed, epoch: cluster.epoch, motifGroupId: cluster.motifGroupId, slot }));
  }
  const matchedGuessedDocIds = [...new Set(guessed.filter((id) => actual.has(id)))].sort(compareId);
  return {
    ranking: matchedGuessedDocIds.map((docId, index) => ({ docId, score: -index })),
    matchedGuessedDocIds,
    guessedIdCount: guessed.length,
    error: null,
  };
}

function hiddenOracleRank(row, docs) {
  const task = row.bmuTask;
  const required = new Set(task.requiredEvidence);
  const forbidden = new Set(task.forbiddenEvidence);
  const middle = docs.map((doc) => doc.id).filter((id) => !required.has(id) && !forbidden.has(id)).sort(compareId);
  return [...task.requiredEvidence, ...middle, ...task.forbiddenEvidence]
    .map((docId, index) => ({ docId, score: -index }));
}

function disjointRepeat(members, maxActiveEpochGap) {
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i]; const b = members[j];
      if (a.subjectEntityId === b.subjectEntityId) continue;
      if ((a.templateIds ?? []).some((id) => (b.templateIds ?? []).includes(id))) continue;
      if ((a.entityHoldoutKeys ?? []).some((key) => (b.entityHoldoutKeys ?? []).includes(key))) continue;
      const epochGap = Math.abs((a.epoch ?? Number.MAX_SAFE_INTEGER) - (b.epoch ?? Number.MIN_SAFE_INTEGER));
      if (!(epochGap < maxActiveEpochGap)) continue;
      return { motifGroupIds: [a.motifGroupId, b.motifGroupId], epochGap, concurrentlyActiveAtSecondMint: true };
    }
  }
  return null;
}

/**
 * §17.9/§18 doctrine: the census counts SIGNATURE-LEVEL executable classes that
 * are DECODED from each cluster's actual public program bank (operationCue +
 * operationProgram), never the generator/semantic label a cluster declares.
 * A declared operationClass that disagrees with the decoded executable
 * signature — or a program that will not decode — is a forgery and hard-fails
 * certification. This makes forged semantic labels (many labels sharing one
 * real cue/program) collapse to a single executable class below capacity, and
 * makes any relabelled real cue/program pair a certification failure.
 */
export function operationClassCensus(lane, capacity, maxActiveEpochGap = 32) {
  const byClass = new Map();
  const labelMismatches = [];
  for (const cluster of lane.clusters) {
    let executableSignature;
    try {
      executableSignature = executableOperationSignature({
        operationCue: cluster.bmuOperationCue,
        operationProgram: cluster.bmuOperationProgram,
      }).executableSignature;
    } catch (error) {
      labelMismatches.push({
        motifGroupId: cluster.motifGroupId ?? null,
        declared: cluster.operationClass ?? cluster.operationFamily ?? null,
        reason: `undecodable_operation_program: ${String(error?.message ?? error)}`,
      });
      continue;
    }
    const declared = cluster.operationClass ?? cluster.operationFamily;
    if (declared !== undefined && declared !== null && declared !== executableSignature) {
      labelMismatches.push({
        motifGroupId: cluster.motifGroupId ?? null,
        declared,
        executableSignature,
        reason: 'declared_label_disagrees_with_executable_signature',
      });
    }
    const members = byClass.get(executableSignature) ?? [];
    members.push(cluster);
    byClass.set(executableSignature, members);
  }
  const classes = [...byClass].map(([operationClass, members]) => ({
    operationClass,
    clusters: members.length,
    disjointRepeat: disjointRepeat(members, maxActiveEpochGap),
  }));
  return {
    capacity,
    distinctClasses: byClass.size,
    margin: byClass.size - capacity,
    classes,
    labelMismatches,
    pass: labelMismatches.length === 0 && byClass.size > capacity
      && classes.every((entry) => entry.clusters >= 2 && entry.disjointRepeat !== null),
  };
}

export function roleRetirementAudit(lane) {
  const roleDocs = lane.docs.filter((doc) => Object.keys(doc).includes('role')).map((doc) => doc.id);
  const roleKinds = lane.docs.filter((doc) => doc.kind !== 'bmu_public_record').map((doc) => ({ id: doc.id, kind: doc.kind }));
  return { pass: roleDocs.length === 0 && roleKinds.length === 0, enumerableRoleDocs: roleDocs, roleCorrelatedKinds: roleKinds };
}

export function globalAliasM1Audit(families) {
  const claims = { motif: new Map(), subject: new Map(), template: new Map(), identity: new Map() };
  const violations = [];
  const claim = (map, key, ref, kind) => {
    if (typeof key !== 'string' || key.length === 0) return;
    const prior = map.get(key);
    if (prior && prior !== ref) violations.push(`${kind} '${key}' shared by ${prior} and ${ref}`);
    else map.set(key, ref);
  };
  for (const [family, lane] of Object.entries(families)) {
    for (const cluster of lane.clusters) {
      const ref = `${family}:${cluster.motifGroupId}`;
      claim(claims.motif, cluster.motifGroupId, ref, 'motifGroupId');
      claim(claims.subject, cluster.subjectEntityId, ref, 'subjectEntityId');
      for (const template of cluster.templateIds ?? []) claim(claims.template, template, ref, 'templateId');
      for (const identity of cluster.entityHoldoutKeys ?? []) claim(claims.identity, identity, ref, 'entityHoldoutKey');
    }
  }
  return { pass: violations.length === 0, violations, counts: Object.fromEntries(Object.entries(claims).map(([key, map]) => [key, map.size])) };
}

function familyAgnosticIntentKey(row) {
  const intent = { ...(row.publicIntent ?? {}), subjectEntityId: row.subjectEntityId ?? row.publicIntent?.subjectEntityId };
  return JSON.stringify(Object.entries(intent).filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => compareId(a, b)));
}

export function crossFamilyDedupAudit(families) {
  const indices = { docId: new Map(), queryId: new Map(), publicIntent: new Map(), docText: new Map(), queryText: new Map() };
  const add = (map, key, ref) => { const refs = map.get(key) ?? []; refs.push(ref); map.set(key, refs); };
  for (const [family, lane] of Object.entries(families)) {
    for (const doc of lane.docs) {
      add(indices.docId, doc.id, `${family}:${doc.id}`);
      add(indices.docText, normText(doc.text), `${family}:${doc.id}`);
    }
    for (const row of lane.rows) {
      add(indices.queryId, row.id, `${family}:${row.id}`);
      add(indices.queryText, normText(row.queryText), `${family}:${row.id}`);
      add(indices.publicIntent, familyAgnosticIntentKey(row), `${family}:${row.id}`);
    }
  }
  const duplicate = (map) => [...map.entries()].filter(([, refs]) => refs.length > 1).map(([key, refs]) => ({ key, refs }));
  const collisions = Object.fromEntries(Object.entries(indices).map(([name, map]) => [name, duplicate(map)]));
  return { pass: Object.values(collisions).every((entries) => entries.length === 0), collisions };
}

export function buildNoSubstrateScoringJob(families, { pins = CERT_PINS, sourceCheckout = null } = {}) {
  const docs = Object.values(families).flatMap((lane) => lane.docs).map((doc) => ({ id: doc.id, text: doc.text }));
  const queries = Object.entries(families).flatMap(([family, lane]) => lane.rows.map((row) => ({
    id: row.id, family, text: row.queryText, budgetB: row.bmuTask.budgetB,
  })));
  const identityPayload = {
    sourceCheckout,
    noSubstrate: true,
    pins: { biencoder: pins.biencoder, reranker: pins.reranker, rerankerInputTopK: pins.rerankerInputTopK },
    queries, docs,
  };
  return {
    schema: 'coretex.bmu-v2.no-substrate-scoring-job.v1',
    ...identityPayload,
    identity: createHash('sha256').update(JSON.stringify(identityPayload)).digest('hex'),
  };
}

export function certifyNoSubstrateScoring(job, output, rowById) {
  const errors = [];
  const expectedIdentity = createHash('sha256').update(JSON.stringify({
    sourceCheckout: job.sourceCheckout,
    noSubstrate: job.noSubstrate,
    pins: job.pins,
    queries: job.queries,
    docs: job.docs,
  })).digest('hex');
  if (job.schema !== 'coretex.bmu-v2.no-substrate-scoring-job.v1') errors.push('bad job schema');
  if (job.noSubstrate !== true) errors.push('job not stamped noSubstrate=true');
  if (job.identity !== expectedIdentity) errors.push('job identity is not self-consistent');
  if (output?.schema !== 'coretex.bmu-v2.no-substrate-scoring-output.v1') errors.push('bad output schema');
  if (job.sourceCheckout?.clean !== true || !/^[0-9a-f]{40}$/.test(job.sourceCheckout?.commit ?? '')) errors.push('job sourceCheckout is not clean and commit-bound');
  if (output?.jobIdentity !== job.identity) errors.push('job identity mismatch');
  if (output?.freshScoring !== true || output?.cacheRebound === true) errors.push('fresh scoring contract violated');
  if (output?.noSubstrate !== true) errors.push('output not stamped noSubstrate=true');
  if (output?.pins?.biencoder !== job.pins.biencoder
      || output?.pins?.reranker !== job.pins.reranker
      || output?.pins?.rerankerInputTopK !== job.pins.rerankerInputTopK) errors.push('model/cap pins mismatch');
  const resultById = new Map((output?.perQuery ?? []).map((entry) => [entry.id, entry]));
  if (resultById.size !== job.queries.length) errors.push('query result cardinality mismatch');
  const docIds = job.docs.map((doc) => doc.id).sort(compareId);
  const perQuery = [];
  for (const query of job.queries) {
    const result = resultById.get(query.id);
    if (!result) { errors.push(`missing query ${query.id}`); continue; }
    const bge = result.bge ?? [];
    const bgeIds = bge.map((entry) => entry.docId).sort(compareId);
    if (JSON.stringify(bgeIds) !== JSON.stringify(docIds) || !bge.every((entry) => finite(entry.score))) {
      errors.push(`${query.id}: BGE must score every job doc exactly once with finite scores`);
      continue;
    }
    const expectedQwenIds = [...bge].sort((a, b) => b.score - a.score || compareId(a.docId, b.docId))
      .slice(0, Math.min(job.pins.rerankerInputTopK, bge.length)).map((entry) => entry.docId);
    const actualInput = result.qwenInputDocIds ?? [];
    if (JSON.stringify(actualInput) !== JSON.stringify(expectedQwenIds)) errors.push(`${query.id}: Qwen input is not exact BGE top-K`);
    const qwen = result.qwen ?? [];
    if (JSON.stringify(qwen.map((entry) => entry.docId).sort(compareId)) !== JSON.stringify([...expectedQwenIds].sort(compareId))
        || !qwen.every((entry) => finite(entry.score))) errors.push(`${query.id}: Qwen scores must cover exact input ids`);
    const ranked = [...qwen].sort((a, b) => b.score - a.score || compareId(a.docId, b.docId));
    const row = rowById.get(query.id);
    const judge = row ? judgeTopB(ranked, row.bmuTask) : { judgeSuccess: false };
    perQuery.push({ id: query.id, judgeSuccess: judge.judgeSuccess });
  }
  return {
    contractPass: errors.length === 0,
    hardnessPass: errors.length === 0 && perQuery.every((entry) => !entry.judgeSuccess),
    errors,
    confidentSuccesses: perQuery.filter((entry) => entry.judgeSuccess).map((entry) => entry.id),
  };
}

export function certifyV2Banks(rawBanks, {
  adapters = DEFAULT_V2_BANK_ADAPTERS,
  seed = 'bmu-v2-bank-certification-v1',
  noSubstrateOutput = null,
  sourceCheckout = null,
} = {}) {
  const families = {};
  for (const raw of rawBanks) {
    const lane = normalizeV2Bank(raw);
    if (!lane.family || families[lane.family]) throw new Error(`certifyV2Banks: missing/duplicate family '${lane.family}'`);
    if (!adapters[lane.family]) throw new Error(`certifyV2Banks: no adapter for '${lane.family}'`);
    families[lane.family] = lane;
  }
  const perFamily = {};
  for (const [family, lane] of Object.entries(families)) {
    const adapter = adapters[family];
    const clusterByMotif = new Map(lane.clusters.map((cluster) => [cluster.motifGroupId, cluster]));
    const randomResults = [];
    const metadataResults = [];
    const pathAttackerResults = [];
    const inversionResults = [];
    const inversionMatches = new Set();
    const inversionErrors = new Set();
    const inversionByMotif = new Map();
    const shortcutResults = Object.fromEntries(Object.keys(adapter.publicAttackers).map((name) => [name, []]));
    const hiddenResults = [];
    for (const row of lane.rows) {
      const cluster = clusterByMotif.get(row.bmuTask?.motifGroupId);
      if (!cluster) throw new Error(`${family}:${row.id}: no cluster for motif ${row.bmuTask?.motifGroupId}`);
      randomResults.push(judgeTopB(randomKRank(lane.docs, `${seed}|${family}|${row.id}`), row.bmuTask));
      metadataResults.push(judgeTopB(idMetadataOnlyAttacker(row, lane), row.bmuTask));
      pathAttackerResults.push(judgeTopB(idMetadataPathAttacker(row, lane, cluster), row.bmuTask));
      const inversion = inversionByMotif.get(cluster.motifGroupId)
        ?? knownSeedGeneratorInversionAttacker(row, lane, cluster);
      inversionByMotif.set(cluster.motifGroupId, inversion);
      inversionResults.push(judgeTopB(inversion.ranking, row.bmuTask));
      for (const id of inversion.matchedGuessedDocIds) inversionMatches.add(id);
      if (inversion.error) inversionErrors.add(inversion.error);
      for (const [name, attacker] of Object.entries(adapter.publicAttackers)) {
        const ids = attacker(row, lane.docs);
        shortcutResults[name].push(judgeTopB(ids.map((docId) => ({ docId, score: 0 })), row.bmuTask));
      }
      hiddenResults.push(judgeTopB(hiddenOracleRank(row, lane.docs), row.bmuTask, { signalFires: row.bmuTask.abstain === true }));
    }
    const rate = (results) => results.filter((result) => result.judgeSuccess).length / results.length;
    const balanced = lane.clusters.map((cluster) => ({ motifGroupId: cluster.motifGroupId, ...balancedTerminalAudit(cluster) }));
    const metadataIdGuesses = lane.clusters.map((cluster) => {
      const ids = [...cluster.publicPath.terminalBranchIds].sort(compareId);
      return (cluster.publicPath.goldBranchIds ?? []).includes(ids[0]);
    });
    const goldFraction = lane.clusters.reduce((sum, cluster) =>
      sum + cluster.publicPath.goldBranchIds.length / cluster.publicPath.terminalBranchIds.length, 0) / lane.clusters.length;
    const opaqueIdGoldGuessRate = metadataIdGuesses.filter(Boolean).length / metadataIdGuesses.length;
    perFamily[family] = {
      gates: {
        randomK: { rate: rate(randomResults), max: 0.05, pass: rate(randomResults) <= 0.05 },
        idMetadataPathAttacker: {
          // Blindness gate: ids + metadata WITHOUT the public-path channel
          // must solve nothing. The path-walking variant succeeding is now
          // EXPECTED under the deep-terminal law (the public program routes
          // exactly the answer terminal) and is recorded as a diagnostic,
          // not a failure — route soundness is gated by the route-closure
          // audit in balancedTerminalBranches.
          judgeSuccessRate: rate(metadataResults),
          pathExecutionEquivalentJudgeSuccessRate: rate(pathAttackerResults),
          opaqueIdGoldGuessRate,
          chanceGoldFraction: goldFraction,
          pass: rate(metadataResults) === 0 && balanced.every((entry) => entry.pass)
            && opaqueIdGoldGuessRate <= goldFraction + 0.10,
        },
        generatorInversionAttacker: {
          judgeSuccessRate: rate(inversionResults),
          matchedGuessedDocIds: [...inversionMatches].sort(compareId),
          errors: [...inversionErrors],
          pass: rate(inversionResults) === 0 && inversionMatches.size === 0 && inversionErrors.size === 0,
          rule: 'known generator seed/source plus exact motif inputs must match zero HMAC document ids and solve zero rows',
        },
        balancedTerminalBranches: { pass: balanced.every((entry) => entry.pass), failures: balanced.filter((entry) => !entry.pass) },
        operationClassCensus: operationClassCensus(lane, adapter.conservativeOperationCapacity, adapter.maxActiveEpochGap),
        roleRetirement: roleRetirementAudit(lane),
        ...Object.fromEntries(Object.entries(shortcutResults).map(([name, results]) => [name, {
          judgeSuccessRate: rate(results), pass: rate(results) === 0,
        }])),
      },
      // This oracle explicitly consumes hidden bmuTask/qrel-derived truth and
      // is never presented as a public attacker or mineable strategy.
      offlineHiddenOracle: { rate: rate(hiddenResults), pass: hiddenResults.every((result) => result.judgeSuccess), inputAuthority: 'hidden_bmuTask_only' },
    };
  }
  const globalGates = {
    crossFamilyDedup: crossFamilyDedupAudit(families),
    globalAliasM1: globalAliasM1Audit(families),
  };
  const noSubstrateJob = buildNoSubstrateScoringJob(families, { sourceCheckout });
  const rowById = new Map(Object.values(families).flatMap((lane) => lane.rows).map((row) => [row.id, row]));
  const noSubstrate = noSubstrateOutput
    ? certifyNoSubstrateScoring(noSubstrateJob, noSubstrateOutput, rowById)
    : { contractPass: false, hardnessPass: false, pending: true, errors: ['fresh full-bank BGE+Qwen output not supplied'] };
  const cheapPass = Object.values(perFamily).every((report) =>
    Object.values(report.gates).every((gate) => gate.pass === true) && report.offlineHiddenOracle.pass)
    && Object.values(globalGates).every((gate) => gate.pass);
  return {
    schema: 'coretex.bmu-v2.bank-certification.v1',
    cheapPass,
    fullPass: cheapPass && noSubstrate.contractPass && noSubstrate.hardnessPass,
    perFamily,
    globalGates,
    noSubstrate: { ...noSubstrate, job: noSubstrateJob },
    caps: [
      'Cheap certification uses text-free/public-only attackers and synthetic score-contract fixtures only.',
      'GREEN hardness still requires fresh full-bank BGE-M3 + Qwen output on the emitted no-substrate job; cache rebinding is forbidden.',
      'Parent and oracle-solved three-state margins remain a full scorer certification lane, not this light harness.',
    ],
  };
}
