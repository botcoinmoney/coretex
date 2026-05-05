#!/usr/bin/env node
// Fail PR CI if a checklist item ([ ] -> [x] or vice-versa) flipped in this PR
// but context.md "Current state" or "Recent decisions" was not touched.
// Heuristic per ORGANISM_CORTEX_STATE_PLAN.md §13.5.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = process.env.GITHUB_BASE_REF || 'main';
const head = process.env.GITHUB_HEAD_REF || 'HEAD';

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' });
}

let diff;
try {
  diff = sh(`git diff origin/${base}...HEAD --unified=0 -- '*.md'`);
} catch {
  diff = sh(`git diff HEAD~1...HEAD --unified=0 -- '*.md'`);
}

const checklistFlipped = /^[+-]\s*-\s*\[[ x]\]/m.test(diff);
const contextTouched = diff.includes('context.md');

if (!checklistFlipped) {
  console.log('No checklist items flipped in this PR. Skipping freshness check.');
  process.exit(0);
}

if (!contextTouched) {
  console.error('FAIL: checklist items flipped but context.md not updated. See §13.5.');
  process.exit(1);
}

const ctx = readFileSync('context.md', 'utf8');
const hasCurrent = /^## Current state$/m.test(ctx);
const hasDecisions = /^## Recent decisions/m.test(ctx);
if (!hasCurrent || !hasDecisions) {
  console.error('FAIL: context.md missing required "Current state" / "Recent decisions" sections.');
  process.exit(1);
}
console.log('OK: context.md is fresh relative to checklist changes.');
