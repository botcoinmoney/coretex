#!/usr/bin/env node
/**
 * Phase-6 candidate-reranker EPOCH probe — CORRECTED full-IR, multi-family loop (2026-05-26):
 *   merged DGEN1+r5 accepted-state export (FULL Memory-IR) → 6 mandatory gates (incl. full-IR train/serve
 *   byte-equality) → train candidate reranker_{N+1} (ranking-aligned, family-balanced) → 6 full-IR eval arms
 *   → baseline rerun → automatic multi-family promotion verdict. Human-intervention-free.
 *
 * The prior run trained multi-field IR but SERVED lifecycle-only F2 (incompatible) and let temporal dominate.
 * This run uses ONE shared renderer across export/train/serve and judges the NON-TEMPORAL/multi-family lift.
 *
 * Arms (all the shared full-IR renderer): E0-raw, E0+fullIR, E1-raw, E1+fullIR, E1+fullIR substrate-OFF,
 *   E1+fullIR heldout-future (distinct held-out sample). Promote iff: E1+fullIR > E0+fullIR (non-temporal)
 *   AND non-temporal lift > 0 AND substrate residual > 0 AND heldout-future non-temporal does not collapse
 *   AND no off-family (non-temporal) regression. Pipeline SUCCESS regardless (plumbing ran end-to-end).
 *
 * Usage: node scripts/run-reranker-epoch-probe.mjs --primary-ledger <l> --supplement-ledger <l2>
 *        --primary-corpus <c> --supplement-corpus <c2> --eval-corpus <c> --out <dir> [--reranker gpu]
 */
import { repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const flag = (n, d) => { const a = process.argv.slice(2); const i = a.indexOf(`--${n}`); return i >= 0 && i + 1 < a.length ? a[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const primaryCorpus = flag('primary-corpus', `${base}/dgen1-corpus.json`);
const primaryLedger = flag('primary-ledger', null);
const suppCorpus = flag('supplement-corpus', `${base}/dgen1-r5-synth-corpus.json`);
const suppLedger = flag('supplement-ledger', null);
const evalCorpus = flag('eval-corpus', `${base}/dgen1-r5-synth-corpus.json`);   // full family palette for the multi-family verdict
const evalSubstrate = flag('eval-substrate', suppLedger ? suppLedger.replace(/\.jsonl$/, '') + '.state.json' : null);
const split = flag('split', 'train_visible');
const rerankerArg = flag('reranker', 'gpu');
const perFamilyCap = flag('per-family-cap', '5000');
const objective = flag('objective', 'combined');
const epochs = flag('epochs', '1');
const packSize = flag('pack-size', '200');
const outDir = flag('out', `${base}/reranker-epoch-probe-fullir`);
if (!primaryLedger) { console.error('required: --primary-ledger <ledger.jsonl> (from emit-accepted-state-ledger.mjs)'); process.exit(2); }
const O = (f) => resolve(repoRoot, outDir, f);
mkdirSync(resolve(repoRoot, outDir), { recursive: true });
const adapterDir = resolve(repoRoot, outDir, 'adapter');
const GPU = rerankerArg === 'gpu';
const gpuEnv = 'HF_HOME=/root/hf HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 CORETEX_RERANKER_ALLOW_CUDA=1 CORETEX_RERANKER_PYTHON=/usr/bin/python3 NODE_OPTIONS=--max-old-space-size=8192';
const run = (label, cmd, env = '') => { console.error(`\n=== ${label} ===\n${cmd}`); execSync(`${env} ${cmd}`, { cwd: repoRoot, stdio: 'inherit' }); };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const memops = O('memoryops-training.jsonl');

// 1. export FULL-IR MemoryOps training data (merged primary DGEN1 + supplement r5-synth, resolved-state-derived).
run('1 export MemoryOps (full IR, merged)',
  `node scripts/export-memoryops-training-data.mjs --corpus ${primaryCorpus} --from-ledger ${primaryLedger}`
  + ` --supplement ${suppCorpus} --supplement-ledger ${suppLedger} --split ${split} --out ${memops}`,
  'NODE_OPTIONS=--max-old-space-size=8192');
// 2. MANDATORY gates (incl. full-IR train/serve byte-equality) on the EVAL corpus slice.
run('2 validate gates',
  `node scripts/validate-memoryops-pipeline.mjs --ledger ${suppLedger} --memops ${memops} --corpus ${suppCorpus}`
  + ` --emb ${suppCorpus.replace('-corpus.json', '-embeddings.json')} --split ${split}`
  + ` --supplement ${suppCorpus} --supplement-ledger ${suppLedger}`,
  'NODE_OPTIONS=--max-old-space-size=8192');
// 3. train candidate reranker_{N+1}: ranking-aligned (BCE+pairwise+listwise), family-balanced. Base never written.
run('3 train E1 (full IR, ranking-aligned)',
  `python3 scripts/train_memoryops.py --data ${memops} --out ${O('e1-metrics.json')} --adapter-dir ${adapterDir}`
  + ` --epochs ${epochs} --per-family-cap ${perFamilyCap} --objective ${objective} ${GPU ? '' : '--smoke'}`,
  GPU ? gpuEnv : '');

// 4. six FULL-IR eval arms. Resolved-IR arms use the eval corpus's resolved substrate (lifecycle EARNED).
const sub = evalSubstrate ? `--substrate ${evalSubstrate}` : '';
const fb = (extra) => `node scripts/probe-reranker-fullbench.mjs --reranker ${rerankerArg} --corpus ${evalCorpus} --pack-size ${packSize} ${extra}`;
const adapterEnv = `${gpuEnv} CORETEX_RERANKER_ADAPTER_DIR=${adapterDir}`;
const e0Env = GPU ? gpuEnv : '';
const e1Env = GPU ? adapterEnv : `CORETEX_RERANKER_ADAPTER_DIR=${adapterDir}`;
run('4a E0-raw', fb(`--out ${O('eval-E0-raw.json')}`), e0Env);
run('4b E0+fullIR', fb(`--full-ir --ir-source resolved ${sub} --out ${O('eval-E0-ir.json')}`), e0Env);
run('4c E1-raw', fb(`--out ${O('eval-E1-raw.json')}`), e1Env);
run('4d E1+fullIR', fb(`--full-ir --ir-source resolved ${sub} --out ${O('eval-E1-ir.json')}`), e1Env);
run('4e E1+fullIR substrate-OFF', fb(`--full-ir --ir-source resolved --substrate-off --out ${O('eval-E1-ir-substrate-off.json')}`), e1Env);
run('4f E1+fullIR heldout-future', fb(`--full-ir --ir-source resolved ${sub} --seed-hex 0x${'7a'.repeat(32)} --out ${O('eval-E1-ir-heldout.json')}`), e1Env);

// 5. baseline rerun with the candidate reranker (adapter) — proves the baseline loop loads the candidate.
run('5 baseline rerun (candidate)', `node scripts/pin-r5-synth-baseline.mjs --reranker ${rerankerArg} --out ${O('baseline-rerun.json')}`, e1Env);

// 6. automatic MULTI-FAMILY promotion verdict (judged on NON-TEMPORAL; temporal is a sanity arm only).
const A = (f) => readJson(O(f));
const E0raw = A('eval-E0-raw.json'), E0ir = A('eval-E0-ir.json'), E1raw = A('eval-E1-raw.json');
const E1ir = A('eval-E1-ir.json'), E1off = A('eval-E1-ir-substrate-off.json'), E1held = A('eval-E1-ir-heldout.json');
const e1m = existsSync(O('e1-metrics.json')) ? readJson(O('e1-metrics.json')) : {};
const nt = (a) => a.non_temporal_nDCG10;
const formatLift = +(nt(E0ir) - nt(E0raw)).toFixed(4);            // does full IR help the FROZEN base (non-temporal)?
const tuningLift = +(nt(E1ir) - nt(E0ir)).toFixed(4);            // does TUNING beat E0+fullIR (non-temporal)? — the verdict
const substrateResidual = +(nt(E1ir) - nt(E1off)).toFixed(4);    // IR header value after killing temporal modulation
const heldoutDelta = +(nt(E1held) - nt(E1ir)).toFixed(4);        // heldout-future collapse?
// per-family non-temporal regression vs E0+fullIR (off-family damage gate).
const fams = [...new Set(Object.keys(E1ir.byFamily ?? {}))].filter((f) => f !== 'temporal_update');
const perFamDelta = {}; let regressions = 0;
for (const f of fams) { const d = +(((E1ir.byFamily[f]?.nDCG10 ?? 0) - (E0ir.byFamily[f]?.nDCG10 ?? 0))).toFixed(4); perFamDelta[f] = d; if (d < -0.02) regressions++; }
const heldoutHolds = heldoutDelta > -0.05;
const promote = tuningLift > 0.005 && nt(E1ir) > nt(E0raw) && substrateResidual > 0 && heldoutHolds && regressions === 0;
const verdict = {
  generatedAt: new Date().toISOString(), reranker: rerankerArg, mode: 'full-IR multi-family (corrected)',
  primaryCorpus, suppCorpus, evalCorpus, adapterDir,
  arms_non_temporal_nDCG10: { E0_raw: nt(E0raw), E0_fullIR: nt(E0ir), E1_raw: nt(E1raw), E1_fullIR: nt(E1ir), E1_fullIR_substrate_off: nt(E1off), E1_fullIR_heldout: nt(E1held) },
  arms_temporal_nDCG10_SANITY: { E0_raw: E0raw.temporal_nDCG10, E0_fullIR: E0ir.temporal_nDCG10, E1_fullIR: E1ir.temporal_nDCG10 },
  formatLift_nonTemporal: formatLift, tuningLift_nonTemporal: tuningLift, substrateResidual_nonTemporal: substrateResidual,
  heldoutFutureDelta_nonTemporal: heldoutDelta, heldoutHolds, perFamilyDelta_E1ir_vs_E0ir: perFamDelta, offFamilyRegressions: regressions,
  e1_pairwise: e1m, baselineRerun: readJson(O('baseline-rerun.json')),
  promote, pipelineSuccess: true,
  reason: promote
    ? 'E1+fullIR beats E0+fullIR on NON-TEMPORAL multi-family, substrate residual>0, heldout holds, no off-family regression → PROMOTE candidate reranker_{N+1}'
    : 'tuning did not clear the multi-family bar (non-temporal lift≤0 OR no residual OR heldout collapse OR off-family regression) → keep reranker_N frozen; pipeline SUCCESS (full-IR loop ran end-to-end, byte-equal render, gates auto, no leakage)',
};
writeFileSync(O('promotion-verdict.json'), JSON.stringify(verdict, null, 2));
console.log('\n=== PROMOTION VERDICT (full-IR, multi-family) ===\n' + JSON.stringify(verdict, null, 2));
console.log(`\nepoch probe artifacts → ${outDir}`);
