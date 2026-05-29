#!/usr/bin/env node
/**
 * Live-update churn endurance gate — proves the evolveCorpus delta path reconstructs corpusRoot
 * with real pinned-bi-encoder embeddings. Closes the handoff churn gate:
 *   "added docs embedded by pinned bi-encoder; buildCorpusDelta -> applyCorpusDelta reconstruct same corpusRoot".
 *
 * Steps:
 *   1. base    = buildV2ProductionCorpus(baseCorpus, baseEmb)
 *   2. evolved = buildV2ProductionCorpus(evolvedCorpus, evolvedEmb)   (base + live deltas, real embeddings)
 *   3. additions = evolved.events \ base.events  (the live-update docs/queries)
 *   4. delta = buildCorpusDelta({previousCorpus: base, additions, ...})  (validates split + bi-encoder pin)
 *   5. reconstructed = applyCorpusDelta(base, delta)                      (validates previousRoot continuity)
 *   6. assert reconstructed.corpusRoot === delta.nextRoot === evolved.corpusRoot  (+ determinism re-run)
 *
 * Usage: node scripts/churn-delta-reconstruct.mjs --base <c> --base-emb <e> --evolved <c2> --evolved-emb <e2>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus } from './lib/build-v2-production-corpus.mjs';
const C = await import(distIndex);
const { buildCorpusDelta, applyCorpusDelta } = C;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = flag('base'), baseEmb = flag('base-emb'), evolved = flag('evolved'), evolvedEmb = flag('evolved-emb');

let pass = true;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) pass = false; };

console.log('[churn-delta] building base production corpus ...');
const baseProd = buildV2ProductionCorpus({ corpusPath: base, embPath: baseEmb }).corpus;
console.log('[churn-delta] building evolved production corpus ...');
const evolvedProd = buildV2ProductionCorpus({ corpusPath: evolved, embPath: evolvedEmb }).corpus;

const additions = evolvedProd.events.filter((e) => !baseProd.byId.has(e.id));
console.log(`[churn-delta] base events=${baseProd.events.length} evolved=${evolvedProd.events.length} additions=${additions.length}`);
check('live deltas present (additions > 0)', additions.length > 0, `${additions.length} added events`);

const labelingProvenance = {
  modelId: 'Qwen/Qwen3-Reranker-0.6B', revision: 'e61197ed45024b0ed8a2d74b80b4d909f1255473',
  runtime: 'coretex-retrieval-v2-policy-r5', batchHash: '0x' + '00'.repeat(32),
};
const delta = buildCorpusDelta({ previousCorpus: baseProd, additions, removals: [], epoch: 1, labelingProvenance, generatedAt: '2026-05-29T00:00:00.000Z' });
check('delta.previousRoot === base.corpusRoot (continuity)', delta.previousRoot.toLowerCase() === baseProd.corpusRoot.toLowerCase(), delta.previousRoot);
check('delta added all live-update records', delta.addedIds.length === additions.length, `${delta.addedIds.length}/${additions.length}`);

const reconstructed = applyCorpusDelta(baseProd, delta);
check('applyCorpusDelta reconstructs delta.nextRoot', reconstructed.corpusRoot.toLowerCase() === delta.nextRoot.toLowerCase(), reconstructed.corpusRoot);
check('reconstructed corpusRoot === independently-built evolved corpusRoot', reconstructed.corpusRoot.toLowerCase() === evolvedProd.corpusRoot.toLowerCase(), `recon=${reconstructed.corpusRoot.slice(0,18)} evolved=${evolvedProd.corpusRoot.slice(0,18)}`);

// determinism: rebuild delta from the same inputs → identical nextRoot
const delta2 = buildCorpusDelta({ previousCorpus: baseProd, additions, removals: [], epoch: 1, labelingProvenance, generatedAt: '2026-05-29T00:00:00.000Z' });
check('buildCorpusDelta deterministic (nextRoot stable)', delta2.nextRoot === delta.nextRoot, delta.nextRoot);

console.log('────────────────────────────────────────────');
console.log(`base.corpusRoot      ${baseProd.corpusRoot}`);
console.log(`delta.nextRoot       ${delta.nextRoot}`);
console.log(`evolved.corpusRoot   ${evolvedProd.corpusRoot}`);
console.log(`addedRecords         ${delta.addedRecords.length}`);
console.log(`RESULT: ${pass ? 'ALL PASS ✅' : 'FAIL ❌'}`);
process.exit(pass ? 0 : 1);
