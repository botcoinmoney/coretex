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
 * ORACLE (G-B2 — hidden STRUCTURE only, never bmuTask labels / qrels):
 *   The chain is reconstructed from the cluster's `supports` relation edges
 *   alone — hop docs and the answer doc form the unique supports-path
 *   (head = a supports-src that is never a supports-dst); every decoy hangs
 *   off `co_occurs_with` edges (§6.5 noise-edge hazard) and is therefore
 *   structurally excluded without reading forbiddenEvidence. Per question
 *   type the answer doc is the chain TERMINAL (endpoint/rejection/routing)
 *   or the chain HEAD (provenance); evidence = the full chain (§5.3
 *   evidence law). Oracle success therefore doubles as a mint-consistency
 *   check between generator labels and minted structure.
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
import { certifyBank, bm25Score } from './certify.mjs';

export const MULTI_HOP_FAMILY = 'multi_hop_relation';

// ── Oracle structural solver (G-B2) ─────────────────────────────────────────
export function multiHopOracleLane(row, cluster, docs, budget) {
  const supports = (cluster.relations ?? []).filter((r) => r.type === 'supports');
  const dsts = new Set(supports.map((r) => r.dst));
  const heads = [...new Set(supports.map((r) => r.src))].filter((s) => !dsts.has(s));
  if (heads.length !== 1) return { evidence: [], answerId: null, ranked: [] };
  const next = new Map(supports.map((r) => [r.src, r.dst]));
  const chain = [heads[0]];
  while (next.has(chain[chain.length - 1]) && chain.length <= cluster.docs.length) {
    chain.push(next.get(chain[chain.length - 1]));
  }
  if (chain.length > cluster.docs.length) return { evidence: [], answerId: null, ranked: [] }; // cycle guard
  let answerId;
  switch (row.questionType) {
    case 'chain_endpoint_value':
    case 'offpath_rejection':
    case 'downstream_routing':
      answerId = chain[chain.length - 1]; break; // duty-register terminal
    case 'chain_provenance':
      answerId = chain[0]; break;                // filed arrangement = chain head
    default:
      return { evidence: [], answerId: null, ranked: [] };
  }
  const evidence = [...chain]; // §5.3: the FULL chain, every question type
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
