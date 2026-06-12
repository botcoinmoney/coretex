#!/usr/bin/env node
/**
 * Phase-1 GOLDEN TEST: the protocol Memory-IR renderer is byte-identical across consumers.
 *   export/probe render (compiled TS `renderMemoryIRDoc`, imported here) == trainer render (Python replica).
 * Runs a FIXED candidate set covering every field, omission rule, and the no-header → raw-text case.
 * Exits non-zero on any mismatch — a HARD preflight gate (the prior loop's incompatibility is what this
 * test exists to prevent: trainer and scorer MUST render the same text).
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const C = await import(distIndex);
const { renderMemoryIRDoc } = C;
if (typeof renderMemoryIRDoc !== 'function') { console.error('FAIL: renderMemoryIRDoc not exported from coretex dist'); process.exit(2); }

// Fixed candidate set — every field present/absent, ordering, dedup/sort of path, scope true/false/null,
// density 0/>0, evidence true/false, and the all-default → raw-text case.
const CASES = [
  { ir: { lifecycle: 'current', evidence_role: 'support', relation_path: ['supports'], conflict_state: 'candidate', scope_match: true, has_public_evidence_path: true, answer_density: 2 }, candidate_text: 'Alpha doc text.' },
  { ir: { lifecycle: 'superseded', evidence_role: 'answer', relation_path: ['supersedes', 'causes', 'supersedes'], conflict_state: 'none', scope_match: false, has_public_evidence_path: true, answer_density: 0 }, candidate_text: 'Beta\nmultiline.' },
  { ir: { lifecycle: 'none', evidence_role: 'context', relation_path: [], conflict_state: 'resolved', scope_match: null, has_public_evidence_path: false, answer_density: 5 }, candidate_text: 'Gamma.' },
  { ir: { lifecycle: 'none', evidence_role: 'none', relation_path: [], conflict_state: 'none', scope_match: null, has_public_evidence_path: false, answer_density: 0 }, candidate_text: 'Delta raw — no header.' },
  { ir: { subject_scope: 'e_x_s1', lifecycle: 'current' }, candidate_text: 'Epsilon (subject must NOT render).' },
  { ir: null, candidate_text: 'Zeta null ir.' },
  { ir: { relation_path: ['co_occurs_with'], answer_density: 1 }, candidate_text: 'Eta partial.' },
];

const jsRender = CASES.map((c) => renderMemoryIRDoc(c.ir, c.candidate_text).replace(/\n/g, '\\n'));
const py = execFileSync('python3', [resolve(repoRoot, 'scripts/lib/memory_ir_render.py')], { input: JSON.stringify(CASES), encoding: 'utf8' });
const pyRender = py.replace(/\n$/, '').split('\n');

let fails = 0;
for (let i = 0; i < CASES.length; i++) {
  if (jsRender[i] !== pyRender[i]) {
    fails++;
    console.error(`MISMATCH case ${i}:\n  TS/JS: ${JSON.stringify(jsRender[i])}\n  PYTHON: ${JSON.stringify(pyRender[i])}`);
  } else {
    console.log(`ok  ${i}: ${jsRender[i]}`);
  }
}
// Pin a few expected renders so a silent grammar drift in BOTH languages still fails.
const EXPECT = {
  0: '[memory_ir lifecycle=current; role=support; path=supports; conflict=candidate; scope=match; evidence=true; density=2]\\nAlpha doc text.',
  1: '[memory_ir lifecycle=superseded; role=answer; path=causes,supersedes; scope=differs; evidence=true]\\nBeta\\nmultiline.',
  3: 'Delta raw — no header.',
  4: '[memory_ir lifecycle=current]\\nEpsilon (subject must NOT render).',
  5: 'Zeta null ir.',
};
for (const [i, want] of Object.entries(EXPECT)) {
  if (jsRender[i] !== want) { fails++; console.error(`EXPECT FAIL case ${i}:\n  got:  ${JSON.stringify(jsRender[i])}\n  want: ${JSON.stringify(want)}`); }
}
if (fails) { console.error(`\n❌ GOLDEN TEST FAILED — ${fails} mismatch(es). Render paths are NOT byte-identical.`); process.exit(1); }
console.log(`\n✅ GOLDEN TEST PASS — ${CASES.length} cases byte-identical across TS/JS and Python renderers (+ ${Object.keys(EXPECT).length} pinned).`);
