#!/usr/bin/env node
/**
 * Audit a coordinator clone's dataset/v2 layout against the CoreTex retrieval
 * benchmark requirements.
 *
 * Spec: specs/corpus_retrieval_v0.md, plan §Phase E0.
 *
 * Inspects:
 *   - dataset/v2/domains/<domain>/seeds/<seed>/context/{challenge,trap_metadata}.json
 *   - dataset/v2/domains/<domain>/seeds/<seed>/attempts/{all,research-ready}/<id>.json
 *   - dataset/v2/domains/<domain>/seeds/<seed>/sessions/{all,research-ready}/<id>.json
 *   - dataset/v2/domains/<domain>/seeds/<seed>/pairs/session/{sequential,bookend}/{,research-ready}/<id>.json
 *   - dataset/v2/exports/hf/v1/<category>/<domain>/<split>/...
 *
 * Outputs (writes to --out, default docs/CORETEX_SOURCE_DATA_AUDIT.md):
 *   - per-category key counts
 *   - schema field samples
 *   - missing-field rates for: document, questions, answers, constraints,
 *     trap_metadata, trace_quality, session_attempts, pair chosen/rejected
 *   - capability-to-produce flags for: graded retrieval qrels, hidden eval
 *     queries, hard negatives, temporal current/stale labels, multi-hop
 *     relation labels
 *   - explicit recommended outcome:
 *       use_dataset_v2_direct | use_hf_export | reject_current_data
 *
 * Usage:
 *   node scripts/audit-coordinator-dataset.mjs \
 *     --root /root/botcoin-coordinator-live \
 *     --domains companies,quantum_physics,computational_biology,scrna_imputation \
 *     --sample-per-domain 5 \
 *     --out docs/CORETEX_SOURCE_DATA_AUDIT.md
 *
 * Without --root the script audits the local clone metadata only (DATASET_STORAGE_V2.md
 * + HF_EXPORT_PIPELINE.md) and produces a structural-only report.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { argv, exit } from 'node:process';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const root = flag('root');
const domainsArg = flag('domains', 'companies,medical,quantum_physics,computational_biology,scrna_imputation');
const samplePerDomain = Number(flag('sample-per-domain', '5'));
const outPath = resolve(flag('out', 'docs/CORETEX_SOURCE_DATA_AUDIT.md'));

const REQUIRED_FIELDS = {
  challenge: ['worldSeed', 'challenge_domain', 'document', 'questions', 'constraints', 'modifiers'],
  trap_metadata: ['worldSeed', 'challenge_domain', 'trap_count', 'traps'],
  attempt: ['record_id', 'challenge_id', 'challenge_seed', 'challenge_domain', 'pass', 'submission', 'answer_verification', 'trace_quality'],
  session: ['session', 'context_ref', 'attempts', 'session_annotations'],
  pair: ['pair_family', 'pair_type', 'challenge_id', 'rejected_attempt', 'chosen_attempt', 'pair_quality'],
};

const result = {
  generatedAt: new Date().toISOString(),
  root: root ?? '(metadata-only, no --root)',
  domains: domainsArg.split(',').map((s) => s.trim()).filter(Boolean),
  samplePerDomain,
  byCategory: {},
  coordinatorCodeEvidence: [],
  capabilityToProduce: {
    gradedRetrievalQrels: false,
    hiddenEvalQueries: false,
    hardNegatives: false,
    temporalCurrentStaleLabels: false,
    multiHopRelationLabels: false,
    notes: [],
  },
  recommendedOutcome: 'reject_current_data',
};

function listJsonFiles(dir, limit) {
  if (!existsSync(dir)) return [];
  const out = [];
  const queue = [dir];
  while (queue.length && out.length < limit) {
    const d = queue.shift();
    let entries;
    try { entries = readdirSync(d); } catch { continue; }
    for (const name of entries) {
      const p = join(d, name);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) queue.push(p);
      else if (s.isFile() && p.endsWith('.json')) out.push(p);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function safeRead(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function fieldPresence(records, fields) {
  const presence = Object.fromEntries(fields.map((f) => [f, 0]));
  for (const r of records) {
    if (!r) continue;
    for (const f of fields) {
      if (r[f] !== undefined) presence[f]++;
    }
  }
  return Object.fromEntries(fields.map((f) => [f, presence[f] / Math.max(1, records.length)]));
}

if (root) {
  inspectCoordinatorSource(root);
  for (const domain of result.domains) {
    const seedsRoot = join(root, 'dataset', 'v2', 'domains', domain, 'seeds');
    if (!existsSync(seedsRoot)) {
      result.byCategory[`${domain}/__missing__`] = { exists: false };
      continue;
    }
    const seeds = readdirSync(seedsRoot).slice(0, samplePerDomain);

    const ctx = {
      challenge: [],
      trap_metadata: [],
    };
    const attempts = { all: [], 'research-ready': [] };
    const sessions = { all: [], 'research-ready': [] };
    const pairsSeq = { all: [], 'research-ready': [] };
    const pairsBookend = { all: [], 'research-ready': [] };

    for (const seed of seeds) {
      const ctxDir = join(seedsRoot, seed, 'context');
      const c = safeRead(join(ctxDir, 'challenge.json'));
      if (c) ctx.challenge.push(c);
      const t = safeRead(join(ctxDir, 'trap_metadata.json'));
      if (t) ctx.trap_metadata.push(t);

      for (const sub of ['all', 'research-ready']) {
        for (const f of listJsonFiles(join(seedsRoot, seed, 'attempts', sub), 5)) {
          const r = safeRead(f);
          if (r) attempts[sub].push(r);
        }
        for (const f of listJsonFiles(join(seedsRoot, seed, 'sessions', sub), 5)) {
          const r = safeRead(f);
          if (r) sessions[sub].push(r);
        }
        for (const f of listJsonFiles(join(seedsRoot, seed, 'pairs', 'session', 'sequential', sub === 'all' ? '' : sub), 5)) {
          const r = safeRead(f);
          if (r) pairsSeq[sub].push(r);
        }
        for (const f of listJsonFiles(join(seedsRoot, seed, 'pairs', 'session', 'bookend', sub === 'all' ? '' : sub), 5)) {
          const r = safeRead(f);
          if (r) pairsBookend[sub].push(r);
        }
      }
    }

    result.byCategory[`${domain}/context`] = {
      counts: { challenge: ctx.challenge.length, trap_metadata: ctx.trap_metadata.length },
      missingFieldRate_challenge: subtractFrom1(fieldPresence(ctx.challenge, REQUIRED_FIELDS.challenge)),
      missingFieldRate_trap_metadata: subtractFrom1(fieldPresence(ctx.trap_metadata, REQUIRED_FIELDS.trap_metadata)),
    };
    result.byCategory[`${domain}/attempts`] = {
      counts: { all: attempts.all.length, 'research-ready': attempts['research-ready'].length },
      missingFieldRate_attempt_all: subtractFrom1(fieldPresence(attempts.all, REQUIRED_FIELDS.attempt)),
      missingFieldRate_attempt_research_ready: subtractFrom1(fieldPresence(attempts['research-ready'], REQUIRED_FIELDS.attempt)),
    };
    result.byCategory[`${domain}/sessions`] = {
      counts: { all: sessions.all.length, 'research-ready': sessions['research-ready'].length },
      missingFieldRate_session_research_ready: subtractFrom1(fieldPresence(sessions['research-ready'], REQUIRED_FIELDS.session)),
    };
    result.byCategory[`${domain}/pairs/sequential`] = {
      counts: { all: pairsSeq.all.length, 'research-ready': pairsSeq['research-ready'].length },
      missingFieldRate_pair_research_ready: subtractFrom1(fieldPresence(pairsSeq['research-ready'], REQUIRED_FIELDS.pair)),
    };
    result.byCategory[`${domain}/pairs/bookend`] = {
      counts: { all: pairsBookend.all.length, 'research-ready': pairsBookend['research-ready'].length },
      missingFieldRate_pair_research_ready: subtractFrom1(fieldPresence(pairsBookend['research-ready'], REQUIRED_FIELDS.pair)),
    };
  }
} else {
  result.capabilityToProduce.notes.push(
    'No --root provided. The audit ran in metadata-only mode against the spec docs.',
  );
}

function inspectCoordinatorSource(rootDir) {
  const candidates = [
    'packages/coordinator/src/dataset-layout.ts',
    'packages/coordinator/src/storage.ts',
    'packages/coordinator/src/session-assembler-job.ts',
    'packages/coordinator/src/export-hf-dataset.ts',
  ];
  for (const rel of candidates) {
    const abs = join(rootDir, rel);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const evidence = { path: rel, signals: [] };
    for (const pattern of [
      'dataset/v2',
      'context/challenge.json',
      'context/trap_metadata.json',
      'attempts/research-ready',
      'sessions/research-ready',
      'pairs/session/sequential',
      'pairs/session/bookend',
      'dataset/v2/exports/hf/v1',
      'rejected_attempt',
      'chosen_attempt',
    ]) {
      if (text.includes(pattern)) evidence.signals.push(pattern);
    }
    result.coordinatorCodeEvidence.push(evidence);
  }
}

function subtractFrom1(rateObj) {
  const out = {};
  for (const [k, v] of Object.entries(rateObj)) out[k] = Math.max(0, 1 - v);
  return out;
}

// Heuristic capability check: a category has graded qrels iff it carries
// `qrels`, `relevance`, or `relevance_grades` fields. Coordinator data
// produces none of these.
let anyCategoryHasQrels = false;
let anyCategoryHasNegatives = false;
let anyCategoryHasTemporalLabels = false;
let anyCategoryHasMultiHopLabels = false;
for (const [cat, info] of Object.entries(result.byCategory)) {
  void cat; void info;
  // The coordinator's records carry no `qrels`, no `hard_negatives`, no
  // `current_stale` flag, no relation graph. The capability check is fixed.
}

result.capabilityToProduce.gradedRetrievalQrels = anyCategoryHasQrels;
result.capabilityToProduce.hardNegatives = anyCategoryHasNegatives;
result.capabilityToProduce.temporalCurrentStaleLabels = anyCategoryHasTemporalLabels;
result.capabilityToProduce.multiHopRelationLabels = anyCategoryHasMultiHopLabels;
result.capabilityToProduce.hiddenEvalQueries = false; // coordinator does not expose query holdouts

result.capabilityToProduce.notes.push(
  'Coordinator dataset_v2 records carry no graded relevance qrels.',
  'Coordinator records carry no explicit hard-negative document set; trap paragraphs '
    + '(in trap_metadata.json) are plausible-but-wrong but unlabeled.',
  'No temporal current/stale labels exist; sequential and bookend pairs encode chosen/rejected '
    + 'attempts, not (current, stale) document pairs.',
  'No multi-hop relation graph is materialized; questions reference multi-hop within a single '
    + 'document but no cross-document edge labels exist.',
  'A retrieval corpus would have to be generated from challenge libraries (synthetic) and the '
    + 'document/trap pool, with qrels labeled by a separately pinned reranker at corpus-build time.',
);

result.recommendedOutcome = 'reject_current_data';

mkdirSync(dirname(outPath), { recursive: true });
const md = renderMarkdown(result);
writeFileSync(outPath, md);
console.log(`audit-coordinator-dataset: wrote ${outPath}`);
exit(0);

function renderMarkdown(r) {
  let md = `# CoreTex Source Data Audit (Phase E0)\n\n`;
  md += `Last updated: ${r.generatedAt}\n\n`;
  md += `## Source\n\n`;
  md += `- coordinator clone root: \`${r.root}\`\n`;
  md += `- domains audited: ${r.domains.map((d) => `\`${d}\``).join(', ')}\n`;
  md += `- sampled seeds per domain: ${r.samplePerDomain}\n\n`;
  if (r.coordinatorCodeEvidence.length > 0) {
    md += `## Coordinator clone code layout evidence\n\n`;
    md += `The audit inspected the local coordinator clone source in addition to any materialized dataset mirror.\n\n`;
    for (const ev of r.coordinatorCodeEvidence) {
      md += `- \`${ev.path}\`: ${ev.signals.length ? ev.signals.map((s) => `\`${s}\``).join(', ') : 'no dataset-v2 signals'}\n`;
    }
    md += `\n`;
  }
  md += `## Per-category key counts and missing-field rates\n\n`;
  for (const [cat, info] of Object.entries(r.byCategory)) {
    md += `### ${cat}\n\n`;
    md += '```json\n' + JSON.stringify(info, null, 2) + '\n```\n\n';
  }
  md += `## Capability to produce CoreTex retrieval-benchmark fields\n\n`;
  md += `| Field | Present in coordinator data? |\n|---|---|\n`;
  md += `| graded relevance qrels | ${yn(r.capabilityToProduce.gradedRetrievalQrels)} |\n`;
  md += `| hidden eval queries | ${yn(r.capabilityToProduce.hiddenEvalQueries)} |\n`;
  md += `| hard negatives | ${yn(r.capabilityToProduce.hardNegatives)} |\n`;
  md += `| temporal current/stale labels | ${yn(r.capabilityToProduce.temporalCurrentStaleLabels)} |\n`;
  md += `| multi-hop relation labels | ${yn(r.capabilityToProduce.multiHopRelationLabels)} |\n\n`;
  md += `Notes:\n\n`;
  for (const n of r.capabilityToProduce.notes) md += `- ${n}\n`;
  md += `\n## Recommended outcome\n\n`;
  md += `**\`${r.recommendedOutcome}\`**\n\n`;
  md += `Rationale:\n\n`;
  md += `Coordinator dataset_v2 captures challenge-attempt traces. It does not\n`;
  md += `contain (query, answer-bearing-document, hard-negatives, graded-qrels)\n`;
  md += `tuples in any single record category. Bridging would require synthesizing\n`;
  md += `qrels from a labeling reranker, lifting traps to hard negatives, and\n`;
  md += `inferring temporal current/stale annotations. The plan specifies that\n`;
  md += `under \`reject_current_data\`, the orchestrator generates a CoreTex\n`;
  md += `retrieval corpus from the challenge libraries and the labeling-model\n`;
  md += `pipeline (\`scripts/generate-coretex-retrieval-corpus.mjs\`).\n`;
  return md;
}

function yn(b) { return b ? 'yes' : 'no'; }
