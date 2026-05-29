/**
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

const c = JSON.parse(readFileSync(resolve(inPath), 'utf8'));
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
