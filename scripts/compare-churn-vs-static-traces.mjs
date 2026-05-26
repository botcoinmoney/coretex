#!/usr/bin/env node
/**
 * Phase-7 churn-vs-static MemoryOps training-data comparison (PLUMBING proof — "just prove it can run").
 *
 * Static frontier mines one cohort of accepted advances; a churn frontier rotates to a DIFFERENT cohort.
 * Do they produce more diverse / more portable MemoryOps training data, or just rotating homework? This
 * computes, for each, the diversity metrics the question needs — family entropy, Memory-IR field entropy,
 * resolved-lifecycle coverage, operation reuse (overlap of resolved entities) — and proves the comparison
 * runs. NO model training here; churn + reranker tuning stay separate (the directive's separation rule).
 *
 * Usage: node scripts/compare-churn-vs-static-traces.mjs --static <memops_static.jsonl> --churn <memops_churn.jsonl> [--out ..]
 */
import { repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const flag = (n, d) => { const a = process.argv.slice(2); const i = a.indexOf(`--${n}`); return i >= 0 && i + 1 < a.length ? a[i + 1] : d; };
const staticPath = flag('static', '/tmp/memops-static.jsonl');
const churnPath = flag('churn', '/tmp/memops-churn.jsonl');
const out = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/churn-vs-static-traces.json');

const load = (p) => readFileSync(resolve(repoRoot, p), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const entropy = (counts) => { const t = Object.values(counts).reduce((a, b) => a + b, 0); if (!t) return 0; let h = 0; for (const n of Object.values(counts)) { if (!n) continue; const p = n / t; h -= p * Math.log2(p); } return +h.toFixed(4); };
const dist = (rows, f) => { const m = {}; for (const r of rows) { const k = f(r); m[k] = (m[k] ?? 0) + 1; } return m; };

function analyze(rows) {
  const lifecycleResolved = rows.filter((r) => r.memory_ir.lifecycle !== 'none');
  const resolvedSubjects = new Set(lifecycleResolved.map((r) => r.memory_ir.subject_scope));
  return {
    examples: rows.length,
    familyEntropyBits: entropy(dist(rows, (r) => r.family)),
    lifecycleFieldEntropyBits: entropy(dist(rows, (r) => r.memory_ir.lifecycle)),
    evidenceRoleEntropyBits: entropy(dist(rows, (r) => r.memory_ir.evidence_role)),
    conflictStateEntropyBits: entropy(dist(rows, (r) => r.memory_ir.conflict_state)),
    resolvedLifecycleExamples: lifecycleResolved.length,
    resolvedSubjects: resolvedSubjects.size,
    _subjects: resolvedSubjects,
  };
}

const S = analyze(load(staticPath)), Ch = analyze(load(churnPath));
// operation reuse: do the SAME operation families/fields recur across cohorts (portable) vs disjoint doc-IDs?
const subjOverlap = [...S._subjects].filter((x) => Ch._subjects.has(x)).length;
const subjUnion = new Set([...S._subjects, ...Ch._subjects]).size;
delete S._subjects; delete Ch._subjects;
const report = {
  probe: 'phase7 churn-vs-static MemoryOps trace comparison (plumbing — comparison runs)',
  generatedAt: new Date().toISOString(), static: staticPath, churn: churnPath,
  staticArm: S, churnArm: Ch,
  resolvedSubjectOverlap: subjOverlap, resolvedSubjectUnion: subjUnion,
  churnNewSubjectsVsStatic: Ch.resolvedSubjects - subjOverlap,
  interpretation: 'churn rotating to a different cohort SHOULD resolve a DIFFERENT subject set (new minable units) while keeping the SAME Memory-IR grammar (field entropy comparable) — examples rotate, semantics fixed. churnNewSubjectsVsStatic>0 with comparable field entropy = controlled distributional renewal (portable ops on fresh entities), NOT a moving target. Full train-then-eval-on-future-frontier A/B is the next GPU step (kept separate from churn).',
};
writeFileSync(resolve(repoRoot, out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
