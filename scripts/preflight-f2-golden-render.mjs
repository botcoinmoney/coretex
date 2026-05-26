#!/usr/bin/env node
/**
 * HARD PREFLIGHT GATE (auditor-mandated): train/serve F2 render byte-equality.
 *
 * The step-5 reranker epoch is only valid if the F2 doc string the E1 adapter TRAINS on (from
 * `build-reranker-format-traces.mjs --launch-header`) is BYTE-IDENTICAL to the F2 doc string the
 * scorer SERVES at benchmark time (`rerankerMemoryIRFormat='F2'`). If they differ, E1 trains on one
 * format and is evaluated on another → misleading "tuning lift". This gate runs BOTH real code paths
 * and asserts equality for every doc rendered by both. Exit non-zero on any mismatch → blocks step 5.
 *
 * Usage: node scripts/preflight-f2-golden-render.mjs
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';

const C = await import(distIndex);
const { scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState } = C;
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = `${base}/dgen1-r5-synth-corpus.json`;

// 1) REAL builder output (train side): launch-header F2 over temporal + routing.
execSync(`node scripts/build-reranker-format-traces.mjs --format F2 --kind both --launch-header --out /tmp/golden-builder-F2.json`, { cwd: repoRoot, stdio: 'ignore' });
const built = JSON.parse(readFileSync('/tmp/golden-builder-F2.json', 'utf8'));
const builderRender = new Map();  // docId -> rendered string (as the adapter trains on)
for (const t of built.triples) { builderRender.set(t.posId, t.posText); builderRender.set(t.negId, t.negText); }

// 2) REAL scorer output (serve side): capturing reranker records the exact (query, document) strings.
const { corpus, LAYOUT, BE, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath: `${base}/dgen1-r5-synth-embeddings.json` });
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
// UNIQUE-text docs only: alias-collision docs (e.g. "Lena Bauer updated their city to Lisbon" shared by
// s40/s65/s115) have identical text but different subjects, so text→docId matching would be ambiguous.
// Restrict the gate to docs whose text is unique → unambiguous serve↔train pairing. (Alias-collision
// subject ambiguity is a separate, already-documented corpus concern, not a train/serve-skew bug.)
const textCount = new Map();
for (const d of rawCorpus.docs) textCount.set(d.text, (textCount.get(d.text) ?? 0) + 1);
const textToDoc = new Map();
for (const d of rawCorpus.docs) if (textCount.get(d.text) === 1) textToDoc.set(d.text, d.id);
const captured = [];
const capturingReranker = { async score(pairs) { for (const p of pairs) captured.push(p.document); return pairs.map(() => 0.5); } };
const r5 = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json'), 'utf8'));
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker: capturingReranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const opts = { ...scoringOptionsFromProfile(r5, rt), rerankerMemoryIRFormat: 'F2', policyGenericEntityIds: ['e_universe'] };
// pack covering both temporal + routing families (large) so the scorer pool overlaps the builder docs.
const pack = deriveQueryPack(1, '0x' + 'cc'.repeat(32), corpus, { ...r5.hiddenPack, packSize: 200, quotas: [] });
await evaluateRetrievalBenchmarkState({ words: new Array(1024).fill(0n) }, corpus, pack, opts);

// 3) compare: for every scorer-served F2 string whose doc the builder also rendered, assert byte-identical.
let compared = 0; const mismatches = [];
for (const s of captured) {
  if (!s.startsWith('[lifecycle=')) continue;
  const sep = s.indexOf('] ');
  if (sep < 0) continue;
  const rawtext = s.slice(sep + 2);
  const docId = textToDoc.get(rawtext);
  if (!docId || !builderRender.has(docId)) continue;
  compared++;
  if (s !== builderRender.get(docId)) mismatches.push({ docId, serve: s.slice(0, 90), train: builderRender.get(docId).slice(0, 90) });
}

console.log(JSON.stringify({ builderDocs: builderRender.size, capturedStrings: captured.length, compared, mismatches: mismatches.length }, null, 2));
if (mismatches.length > 0) {
  console.error('\n❌ GOLDEN RENDER GATE FAILED — train/serve F2 strings DIFFER:');
  for (const m of mismatches.slice(0, 5)) console.error(`  doc ${m.docId}\n   SERVE: ${m.serve}\n   TRAIN: ${m.train}`);
  process.exit(1);
}
if (compared === 0) { console.error('\n❌ GATE INCONCLUSIVE — 0 docs compared (pool/builder overlap empty); widen the pack.'); process.exit(2); }
console.log(`\n✅ GOLDEN RENDER GATE PASSED — ${compared} docs render BYTE-IDENTICAL train (builder --launch-header) == serve (scorer F2). Step 5 unblocked.`);
