/**
 * ⚠️ CPU-DIAGNOSTIC ONLY — NOT a launch / A100 scoring corpus path. ⚠️
 * This derives subjectEntityId FROM qrel/gold docs, which is acceptable ONLY for "is the selector bug
 * real?" probing. Using a qrel-derived subjectEntityId as a scorer/selector input at launch would turn a
 * public field into HIDDEN-LABEL LEAKAGE. The launch/A100 corpus MUST emit subjectEntityId natively from
 * the generator's PUBLIC task structure (generate-dgen1-corpus.mjs already does this) — regenerate; do
 * NOT score launch/A100 against this grounded output. Output is tagged `_diagnosticOnly: true`.
 *
 * Ground an EXISTING logical corpus for CPU reopen-probes WITHOUT re-embedding.
 *
 * `subjectEntityId` is query metadata (does not change query/doc TEXT), and grade clamps + family
 * de-collapse are label-only — so the existing embedding cache stays valid. This injects, per query:
 *   - subjectEntityId  = entityIds[1] (the subject slot) of its direct/positive qrel doc (else a
 *                        hard-negative's subject) — exactly what the regenerated generator emits;
 *   - clamps any off-scale qrel grade to the nearest legal grade (the historical bridge 0.5 → 0.4).
 * Lets the reopen-probe ladder run against corrected subject grounding using the cached embeddings,
 * before the heavy A100 regen+re-embed.
 *
 *   node scripts/ground-existing-corpus.mjs --in <logical.json> --out <grounded.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const inPath = flag('in'); const outPath = flag('out');
if (!inPath || !outPath) { console.error('--in and --out required'); process.exit(2); }

console.error('⚠️  ground-existing-corpus.mjs: CPU-DIAGNOSTIC ONLY — qrel-derived subjectEntityId. Do NOT use for launch/A100 scoring (regenerate natively instead).');
const c = JSON.parse(readFileSync(resolve(inPath), 'utf8'));
c._diagnosticOnly = true;
c._diagnosticNote = 'subjectEntityId derived from qrel/gold docs — CPU probe only, NOT launch-safe (hidden-label-leakage risk). Regenerate natively for launch/A100.';
const docs = new Map((c.docs ?? []).map((d) => [d.id, d]));
const UNIVERSE_RE = /universe/i;
const LEGAL = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
const clamp = (g) => LEGAL.includes(g) ? g : LEGAL.reduce((b, x) => Math.abs(x - g) < Math.abs(b - g) ? x : b, 1.0);
const subjOfDoc = (docId) => { const d = docs.get(docId); return d && (d.entityIds ?? []).find((e) => e !== 'e_universe' && !/^e_universe$/.test(e)); };

let covered = 0, gradeFixed = 0;
for (const q of c.queries ?? []) {
  // subject = subject of the highest-relevance qrel doc; fall back to any qrel / hard-neg doc.
  let sid;
  const ranked = [...(q.qrels ?? [])].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  for (const r of ranked) { sid = subjOfDoc(r.docId); if (sid) break; }
  if (!sid) for (const n of q.hardNegatives ?? []) { sid = subjOfDoc(n.docId); if (sid) break; }
  if (sid) { q.subjectEntityId = sid; covered++; }
  for (const r of q.qrels ?? []) { const cl = clamp(r.relevance); if (cl !== r.relevance) { r.relevance = cl; gradeFixed++; } }
}
writeFileSync(resolve(outPath), JSON.stringify(c));
console.log(JSON.stringify({
  in: inPath, out: outPath,
  queries: (c.queries ?? []).length,
  subjectEntityId_coverage: +((c.queries ?? []).length ? covered / c.queries.length : 0).toFixed(4),
  gradeFixed,
}, null, 2));
