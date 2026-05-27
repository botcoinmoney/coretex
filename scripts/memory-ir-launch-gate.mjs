#!/usr/bin/env node
/**
 * Memory-IR render launch-safety gate  (Launch hardening L5).
 *
 * Complements scripts/test-memory-ir-render-golden.mjs (which proves TS/JS/Python
 * BYTE equality of the renderer) with the launch-path safety properties:
 *
 *   1. Empty substrate → no header: renderMemoryIRDoc(null, text) === text, and
 *      a MemoryIR with all-default fields renders no header (→ raw candidate).
 *   2. Earned fields render: lifecycle + conflict_state + evidence/role/density
 *      render into the fixed protocol header grammar.
 *   3. Grammar is protocol-owned + fixed: every rendered token is a known keyword;
 *      provenance-only fields (subject_scope) are NEVER rendered.
 *   4. No trainable IDs: rendered headers contain no doc/query/qrel ID tokens.
 *   5. Launch profile does NOT silently enable an experimental reranker header:
 *      scoringOptionsFromProfile(launch) → rerankerMemoryIRFormat ≠ 'F2' AND
 *      rerankerMemoryIRMode ≠ 'full' (substrate channel earns the lift; the F2
 *      sidecar header is NOT shipped). If a source is set it must be 'resolved'
 *      (resolved MemoryState), never 'corpus' convenience labels.
 *
 * Usage: node scripts/memory-ir-launch-gate.mjs [--profile release/bundle/evaluator-profile-v2-dgen1-policy-r5.json]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';

const m = await import(distIndex);
const { renderMemoryIRHeader, renderMemoryIRDoc, scoringOptionsFromProfile } = m;

function flag(name, fb) { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; }
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json');
const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));

let pass = true;
const log = [];
function check(name, ok, detail = '') { log.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) pass = false; }

// 1. empty substrate → no header
check('empty/null IR → raw text (no header)', renderMemoryIRDoc(null, 'RAW') === 'RAW');
check('all-default IR → no header', renderMemoryIRHeader({ lifecycle: 'none', evidence_role: 'none', conflict_state: 'none' }) === null);

// 2. earned fields render (incl. conflict_state when a profile enables conflict atoms)
const earned = renderMemoryIRHeader({ lifecycle: 'current', evidence_role: 'answer', relation_path: ['supports'], conflict_state: 'resolved', scope_match: true, has_public_evidence_path: true, answer_density: 3, subject_scope: 'bucket-42' });
check('earned fields render into header', typeof earned === 'string' && earned.includes('lifecycle=current') && earned.includes('conflict=resolved') && earned.includes('density=3'), earned ?? 'null');

// 3. fixed grammar; provenance-only subject_scope never rendered
check('subject_scope (provenance) NOT rendered', !earned.includes('bucket-42') && !earned.includes('subject_scope'));
const tokenRe = /^\[memory_ir ((lifecycle|role|path|conflict|scope|evidence|density)=[^;\]]+)(; (lifecycle|role|path|conflict|scope|evidence|density)=[^;\]]+)*\]$/;
check('header matches fixed protocol grammar', tokenRe.test(earned), earned);

// 4. no trainable IDs in rendered header (no doc/query/qrel id-looking tokens)
const idRe = /\b(doc|query|qrel|q|d|ev|event|mem)[-_]?\d{2,}\b/i;
check('no doc/query/qrel IDs in rendered header', !idRe.test(earned));

// 5. launch profile does not silently enable an experimental reranker header
// scoringOptionsFromProfile passes scorer-affecting knobs through; we only read the MemoryIR flags here.
const stubBE = { modelId: 'stub', revision: '0', layout: { dim: 8, quantization: 'int8', headerBytes: 4 }, encode() { throw new Error('unused'); } };
const opts = scoringOptionsFromProfile(profile, { biEncoder: stubBE, reranker: { async score() { return []; } }, biEncoderHash: '0x00', retrievalKeyLayout: stubBE.layout });
check('launch profile: reranker MemoryIR F2 header OFF', opts.rerankerMemoryIRFormat !== 'F2', `format=${opts.rerankerMemoryIRFormat ?? 'undefined(off)'}`);
check('launch profile: reranker MemoryIR full-mode OFF', opts.rerankerMemoryIRMode !== 'full', `mode=${opts.rerankerMemoryIRMode ?? 'undefined(off)'}`);
check('launch profile: MemoryIR source is resolved (never corpus labels)', opts.rerankerMemoryIRSource === undefined || opts.rerankerMemoryIRSource === 'resolved', `source=${opts.rerankerMemoryIRSource ?? 'undefined'}`);

console.log(log.join('\n'));
console.log('────────────────────────────────────────────────────────');
console.log(`profile           ${profilePath}`);
console.log(`sample header     ${earned}`);
console.log(`rerankerMemoryIR  format=${opts.rerankerMemoryIRFormat ?? 'off'} mode=${opts.rerankerMemoryIRMode ?? 'off'} source=${opts.rerankerMemoryIRSource ?? 'n/a'}`);
console.log('Note: TS/JS/Python byte-equality is proven by scripts/test-memory-ir-render-golden.mjs;');
console.log('      empty-substrate earned-state + train/serve equality by scripts/validate-memoryops-pipeline.mjs.');
console.log(pass ? 'RESULT: ALL PASS ✅' : 'RESULT: FAIL ❌');
exit(pass ? 0 : 1);
