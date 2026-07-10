/**
 * BMU P2 — multi_hop_relation family adapter + CLI driver for the SHARED
 * hardness-certification harness (certify.mjs).
 *
 * certify.mjs is adopted BYTE-IDENTICALLY from the temporal lane
 * (sha256 f269d4f180b52a2b7d8c8f405f0a1cec8a91f29c08bd3dd4c011cf177467cca2,
 * origin/coretex-bmu-p2-temporal) — the same auto-merge discipline as
 * common.mjs — so this lane registers its family via certifyBank's
 * `oracleLane` / `leakScreen` override parameters instead of editing the
 * shared registries. At the four-lane merge the two adapter functions below
 * fold into ORACLE_LANES / LEAK_SCREENS.
 *
 * Frozen spec: specs/BMU_SPEC.md rev3.2 (ad7e523) §5.3 (family definition:
 * traversal evidence must pay, answer-anchoring alone must not), §6.5
 * (forbidden-trap law), §13 / G-B1..G-B3 (gates), §2.2 (judge).
 *
 * ORACLE (G-B2 — qrels/task-label blind): v2 intentionally makes truth and
 * decoys structurally identical. The oracle first proves that a lexical
 * anchor and a textual truth branch share a public outgoing→incoming sink,
 * then distinguishes the truth from rejected/provisional siblings by the
 * branch assertion itself. This is a semantic-text oracle, not the removed
 * v1 edge/role selector.
 *
 * LEAK SCREEN (NoLiMa anti-lexical-shortcut, full-scale independent re-run
 * over the emitted bank bytes — the mint-time lint in multi_hop_relation.mjs
 * is the fail-closed producer-side twin):
 *   (a) answer value never in the question;
 *   (b) bridge tokens (relay / desk / memo ticket) never in the question —
 *       a bridge token in the query would price the traversal at zero;
 *   (c) chain-doc-only vocabulary never in the question (the wording law of
 *       the template banks: 'ledger'/'register'/'duty'/'memo'/'routing'/
 *       'delegation' live in chain docs only);
 *   (d) no shared 4-gram skeleton (slot fills collapsed) between a question
 *       and any of its required chain docs;
 *   (e) answer value appears in NO cluster doc except the answer doc.
 *   Diagnostic (recorded, not a rejection): the off-path digest decoy should
 *   be lexically DOMINANT over every gold doc under BM25 for the question —
 *   that is the §5.3/§6.5 trap working as designed on a bare substrate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { tokenize, containsValue, collapseSlots, sharedSkeletonNgrams } from './common.mjs';
import { certifyBank, bm25Score } from './certify-lanes.mjs';

export const MULTI_HOP_FAMILY = 'multi_hop_relation';

// ── Oracle structural solver (G-B2) ─────────────────────────────────────────
export function multiHopOracleLane(row, cluster, docs, budget) {
  const clusterDocs = cluster.docs ?? [];
  const anchor = clusterDocs.find((doc) => /(?:delegation review|filed review memo|review memo)/i.test(doc.text));
  const truth = clusterDocs.find((doc) => /confirmed and in force/i.test(doc.text));
  if (!anchor || !truth) return { evidence: [], answerId: null, ranked: [] };
  const outgoing = (id, label) => new Set((cluster.relations ?? [])
    .filter((relation) => relation.src === id && relation.label === label)
    .map((relation) => relation.dst));
  const anchorSinks = outgoing(anchor.id, 'public_path_seed');
  const truthSinks = outgoing(truth.id, 'public_path_branch');
  if (anchorSinks.size === 0 || ![...anchorSinks].some((sink) => truthSinks.has(sink))) {
    return { evidence: [], answerId: null, ranked: [] };
  }
  let answerId;
  switch (row.questionType) {
    case 'chain_endpoint_value':
    case 'offpath_rejection':
    case 'downstream_routing':
      answerId = truth.id; break;
    case 'chain_provenance':
      answerId = anchor.id; break;
    default:
      return { evidence: [], answerId: null, ranked: [] };
  }
  // §5.3 utility required = chain head + terminal (bridge + answer). Intermediate
  // hop-2 remains on the supports path for structure checks but is not required
  // evidence (matches generator requiredEvidence / B=4 budget arithmetic).
  const evidence = [anchor.id, truth.id];
  const clusterIds = new Set(cluster.docs.map((d) => d.id));
  const filler = docs.map((d) => d.id).filter((id) => !clusterIds.has(id)).sort();
  const ranked = [...evidence, ...filler.slice(0, Math.max(0, budget - evidence.length))];
  return { evidence, answerId, ranked };
}

// ── Answer-leak screen (NoLiMa; §5.3 wording law) ────────────────────────────
/** Tokens that appear ONLY in chain (gold) doc templates — see the wording
 *  law in multi_hop_relation.mjs template banks. */
export const MULTI_HOP_GOLD_ONLY_TOKENS = ['ledger', 'register', 'duty', 'memo', 'routing', 'delegation'];

export function multiHopLeakScreen(row, cluster, bm25Index) {
  const reasons = [];
  // (a) answer value never in the question.
  if (containsValue(row.queryText, cluster.answerValue)) {
    reasons.push(`answer_value_in_question:${cluster.answerValue}`);
  }
  // (b) bridge tokens never in the question.
  for (const tok of cluster.bridgeTokens ?? []) {
    if (containsValue(row.queryText, tok)) reasons.push(`bridge_token_in_question:${tok}`);
  }
  // (c) chain-doc-only vocabulary never in the question SKELETON. Checked on
  //     the slot-collapsed question: slot fills (e.g. the 'duty owner' target
  //     attribute) legitimately carry these words into questions AND decoys
  //     alike — only the template skeleton must stay free of chain-doc-only
  //     vocabulary (same slot-collapse rationale as sharedSkeletonNgrams).
  const alias = String(cluster.canonicalName).split(/\s+/)[0] ?? cluster.canonicalName;
  const slotValues = [
    cluster.canonicalName, alias, cluster.topic, cluster.targetAttribute,
    cluster.answerValue, ...(cluster.decoyValues ?? []), ...(cluster.bridgeTokens ?? []),
    cluster.subjectEntityId,
  ];
  const qSkeletonToks = new Set(tokenize(collapseSlots(row.queryText, slotValues)));
  for (const t of MULTI_HOP_GOLD_ONLY_TOKENS) {
    if (qSkeletonToks.has(t)) reasons.push(`gold_only_vocab_in_question:${t}`);
  }
  // (d) no shared 4-gram skeleton with any required chain doc (slots collapsed).
  const goldDocs = cluster.docs.filter((d) => row.bmuTask.requiredEvidence.includes(d.id));
  for (const d of goldDocs) {
    const shared = sharedSkeletonNgrams(row.queryText, d.text, slotValues, 4);
    if (shared.length > 0) reasons.push(`shared_4gram_skeleton_with_gold:${d.id}:${shared[0]}`);
  }
  // (e) answer value in NO cluster doc except the answer doc.
  const answerDoc = cluster.docs.find((d) => d.role === 'chain_answer');
  for (const d of cluster.docs) {
    if (answerDoc && d.id !== answerDoc.id && containsValue(d.text, cluster.answerValue)) {
      reasons.push(`answer_value_in_non_answer_doc:${d.id}`);
    }
  }
  // Diagnostic: off-path digest decoy lexically dominant over every gold (§6.5).
  const trap = cluster.docs.find((d) => d.role === 'offpath_decoy');
  const trapScore = trap ? bm25Score(bm25Index, row.queryText, trap.id) : 0;
  const goldMax = Math.max(0, ...goldDocs.map((d) => bm25Score(bm25Index, row.queryText, d.id)));
  return { pass: reasons.length === 0, reasons, trapLexicallyDominant: trapScore >= goldMax, trapScore, goldMax };
}

// ── certifyBank wrapper with the family adapter wired in ────────────────────
export function certifyMultiHopBank(bank, opts = {}) {
  if (bank.family !== MULTI_HOP_FAMILY) {
    throw new Error(`certify-multi-hop: bank family '${bank.family}' ≠ '${MULTI_HOP_FAMILY}'`);
  }
  return certifyBank(bank, {
    ...opts,
    oracleLane: opts.oracleLane ?? multiHopOracleLane,
    leakScreen: opts.leakScreen ?? multiHopLeakScreen,
  });
}

// ── CLI (mirrors certify.mjs, family pre-wired) ──────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1], i++;
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bank || !args.out) {
    console.error('usage: certify-multi-hop.mjs --bank <sample-bank.json> --out <certification.json> [--real-lane <json>] [--seed <s>] [--budget-override <n>] [--update-manifest <manifest.json>]');
    process.exit(2);
  }
  const bankRaw = readFileSync(args.bank);
  const bank = JSON.parse(bankRaw.toString('utf8'));
  const realLane = args['real-lane'] ? JSON.parse(readFileSync(args['real-lane'], 'utf8')) : null;
  const report = certifyMultiHopBank(bank, {
    seed: args.seed ?? 'bmu-p2-certify-v1',
    realLane,
    budgetOverride: args['budget-override'] ? Number(args['budget-override']) : null,
  });
  report.bankSha256 = createHash('sha256').update(bankRaw).digest('hex');
  if (args['real-lane']) report.realLaneResultsSha256 = createHash('sha256').update(readFileSync(args['real-lane'])).digest('hex');
  const json = JSON.stringify(report, null, 1);
  writeFileSync(args.out, json);
  if (args['update-manifest']) {
    const manifest = JSON.parse(readFileSync(args['update-manifest'], 'utf8'));
    if (manifest.sampleBankSha256 !== report.bankSha256) {
      throw new Error(`manifest/bank sha mismatch: manifest pins ${manifest.sampleBankSha256}, certified bank is ${report.bankSha256}`);
    }
    manifest.certification = {
      path: args.out,
      certificationSha256: createHash('sha256').update(json).digest('hex'),
      certifiedSubsetSize: report.certifiedSubset.length,
      rowsTotal: report.totals.rows,
      certifiedSubset: report.certifiedSubset,
      rejectedTasks: report.rejectedTasks,
    };
    writeFileSync(args['update-manifest'], JSON.stringify(manifest, null, 1));
    console.log(`manifest updated with certified-subset pointer: ${args['update-manifest']}`);
  }
  console.log(`certification written: ${args.out}`);
  console.log(JSON.stringify({ totals: report.totals, baselineRates: report.baselineRates, realLaneCoverage: report.realLaneCoverage.cap, rejectedReasonHistogram: report.rejectedReasonHistogram }, null, 1));
}
