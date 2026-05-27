#!/usr/bin/env node
/**
 * Track A — RERANKER FLYWHEEL VIABILITY PROOF (research gate, NOT launch promotion).
 *
 * Answers: can CoreTex-generated MemoryOps data tune a candidate reranker whose lift is (a) real,
 * (b) IR-dependent or substrate-load-bearing (not merely generic relevance tuning), and (c) survives a
 * future/churn frontier AND a generator/slice-disjoint corpus (not one-corpus leakage)?
 *
 * Reuses adapter A (the corrected full-IR run) + trains adapter B (lower LR → fewer off-family regressions).
 * Eval matrix over THREE heldouts, each reporting the FIVE lift types on the NON-TEMPORAL aggregate
 * (temporal is a sanity arm only):
 *   format_lift     = E0+IR  − E0_raw
 *   tuning_lift     = E1+IR  − E0+IR
 *   raw_tuning_lift = E1_raw − E0_raw
 *   ir_dependency   = E1+IR  − E1_raw          (>0 ⇒ sidecar/IR-conditioned; ≈0 ⇒ generic relevance tuning)
 *   substrate_resid = E1+IR(subON) − E1+IR(subOFF)
 *
 * Heldouts: same_distribution (r5-synth), future_frontier (r5-synth + churn-shuffled substrate cohort),
 * generator_or_slice_disjoint (dgen1-realism-g2 — a different generation the adapter never trained on).
 *
 * Usage: node scripts/run-reranker-flywheel-proof.mjs --memops <merged.jsonl> --adapter-a <dir>
 *        [--train-b] [--reranker gpu] --out <dir>
 */
import { repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const flag = (n, d) => { const a = process.argv.slice(2); const i = a.indexOf(`--${n}`); return i >= 0 && i + 1 < a.length ? a[i + 1] : d; };
const has = (n) => process.argv.slice(2).includes(`--${n}`);
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const memops = flag('memops', `${base}/reranker-epoch-probe-fullir/memoryops-training.jsonl`);
const adapterA = flag('adapter-a', `${base}/reranker-epoch-probe-fullir/adapter`);
const rerankerArg = flag('reranker', 'gpu');
const outDir = flag('out', `${base}/reranker-flywheel`);
const packSize = flag('pack-size', '300');
const GPU = rerankerArg === 'gpu';
const O = (f) => resolve(repoRoot, outDir, f);
mkdirSync(resolve(repoRoot, outDir), { recursive: true });
const adapterB = resolve(repoRoot, outDir, 'adapter-b');
const gpuEnv = 'HF_HOME=/root/hf HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 CORETEX_RERANKER_ALLOW_CUDA=1 CORETEX_RERANKER_PYTHON=/usr/bin/python3 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True NODE_OPTIONS=--max-old-space-size=8192';
const sh = (label, cmd, env = '') => { console.error(`\n=== ${label} ===\n${cmd}`); execSync(`${env} ${cmd}`, { cwd: repoRoot, stdio: 'inherit' }); };
const readJson = (p) => JSON.parse(readFileSync(p.startsWith('/') ? p : resolve(repoRoot, p), 'utf8'));

// corpora + substrates for the three heldouts.
const r5Corpus = `${base}/dgen1-r5-synth-corpus.json`;
const r5State = `${base}/r5-ledger.state.json`;
const r5ChurnLedger = O('r5-churn-ledger.jsonl'); const r5ChurnState = O('r5-churn-ledger.state.json');
const disjointCorpus = `${base}/dgen1-realism-g2-corpus.json`;
const disjointLedger = O('realism-g2-ledger.jsonl'); const disjointState = O('realism-g2-ledger.state.json');

// 0. build the extra substrates (embeddings-free, deterministic): a churn-shuffled r5 frontier + the disjoint corpus.
sh('0a churn-frontier substrate (r5, shuffle-seed 101)',
  `node scripts/emit-accepted-state-ledger.mjs --corpus ${r5Corpus} --split train_visible --shuffle-seed 101 --out ${r5ChurnLedger}`,
  'NODE_OPTIONS=--max-old-space-size=8192');
sh('0b disjoint substrate (dgen1-realism-g2)',
  `node scripts/emit-accepted-state-ledger.mjs --corpus ${disjointCorpus} --split train_visible --out ${disjointLedger}`,
  'NODE_OPTIONS=--max-old-space-size=8192');

// 1. train adapter B (lower LR, fewer steps → reduce off-family regression). Adapter A is reused as-is.
if (has('train-b')) {
  sh('1 train adapter B (lr 3e-5)',
    `python3 scripts/train_memoryops.py --data ${memops} --out ${O('e1b-metrics.json')} --adapter-dir ${adapterB}`
    + ` --epochs 1 --lr 3e-5 --per-family-cap 5000 --objective combined ${GPU ? '' : '--smoke'}`,
    GPU ? gpuEnv : '');
}

// 2. eval matrix. One arm per fullbench call; E0 arms are adapter-independent (once per context).
const fb = (corpus, extra, outF, adapter) => {
  const env = GPU ? (adapter ? `${gpuEnv} CORETEX_RERANKER_ADAPTER_DIR=${adapter}` : gpuEnv) : (adapter ? `CORETEX_RERANKER_ADAPTER_DIR=${adapter}` : '');
  sh(`arm ${outF}`, `node scripts/probe-reranker-fullbench.mjs --reranker ${rerankerArg} --corpus ${corpus} --pack-size ${packSize} ${extra} --out ${O(outF)}`, env);
  return readJson(O(outF));
};
const contexts = [
  { key: 'same_distribution', corpus: r5Corpus, substrate: r5State, seed: null },
  { key: 'future_frontier', corpus: r5Corpus, substrate: r5ChurnState, seed: null },
  { key: 'generator_or_slice_disjoint', corpus: disjointCorpus, substrate: disjointState, seed: null },
];
const adapters = { A: adapterA };
if (has('train-b')) adapters.B = adapterB;

const results = {};
for (const ctx of contexts) {
  const sub = `--substrate ${ctx.substrate}`;
  const R = { E0_raw: fb(ctx.corpus, ``, `${ctx.key}.E0-raw.json`, null),
              E0_ir: fb(ctx.corpus, `--full-ir --ir-source resolved ${sub}`, `${ctx.key}.E0-ir.json`, null) };
  for (const [an, ad] of Object.entries(adapters)) {
    R[`E1_raw_${an}`] = fb(ctx.corpus, ``, `${ctx.key}.E1-raw-${an}.json`, ad);
    R[`E1_ir_${an}`] = fb(ctx.corpus, `--full-ir --ir-source resolved ${sub}`, `${ctx.key}.E1-ir-${an}.json`, ad);
    // substrate residual: only for same_distribution (the load-bearing measurement) to bound GPU.
    if (ctx.key === 'same_distribution') R[`E1_ir_subOFF_${an}`] = fb(ctx.corpus, `--full-ir --ir-source resolved --substrate-off`, `${ctx.key}.E1-ir-subOFF-${an}.json`, ad);
  }
  results[ctx.key] = R;
}

// 3. five lift metrics (NON-TEMPORAL) per context per adapter + per-family regression count.
const nt = (a) => a.non_temporal_nDCG10;
const NONTEMP = (bf) => Object.entries(bf).filter(([k]) => k !== 'temporal_update');
const lifts = {};
for (const ctx of contexts) {
  const R = results[ctx.key]; lifts[ctx.key] = {};
  for (const an of Object.keys(adapters)) {
    const e1ir = R[`E1_ir_${an}`], e1raw = R[`E1_raw_${an}`], e0ir = R.E0_ir, e0raw = R.E0_raw;
    const subOFF = R[`E1_ir_subOFF_${an}`];
    let regress = 0; const perFam = {};
    for (const [f, v] of NONTEMP(e1ir.byFamily)) { const d = +((v.nDCG10 - (e0ir.byFamily[f]?.nDCG10 ?? 0))).toFixed(4); perFam[f] = d; if (d < -0.02) regress++; }
    lifts[ctx.key][an] = {
      format_lift: +(nt(e0ir) - nt(e0raw)).toFixed(4),
      tuning_lift: +(nt(e1ir) - nt(e0ir)).toFixed(4),
      raw_tuning_lift: +(nt(e1raw) - nt(e0raw)).toFixed(4),
      ir_dependency: +(nt(e1ir) - nt(e1raw)).toFixed(4),
      substrate_resid: subOFF ? +(nt(e1ir) - nt(subOFF)).toFixed(4) : null,
      nonTemporal: { E0_raw: nt(e0raw), E0_ir: nt(e0ir), E1_raw: nt(e1raw), E1_ir: nt(e1ir) },
      offFamilyRegressions: regress, perFamilyDelta: perFam,
    };
  }
}

// 4. RESEARCH gate (per adapter): tuning_lift>0 (same) AND disjoint≥~0 AND no major off-family regression AND
//    (substrate_resid>0 OR ir_dependency>0). "flywheel viable" if any adapter passes.
const gateOf = (an) => {
  const same = lifts.same_distribution[an], disj = lifts.generator_or_slice_disjoint[an], fut = lifts.future_frontier[an];
  const pass = same.tuning_lift > 0.005
    && disj.tuning_lift >= -0.01 && fut.tuning_lift >= -0.01
    && same.offFamilyRegressions === 0 && disj.offFamilyRegressions === 0
    && ((same.substrate_resid ?? 0) > 0 || same.ir_dependency > 0);
  return { pass, sameTuning: same.tuning_lift, disjointTuning: disj.tuning_lift, frontierTuning: fut.tuning_lift,
    sameRegress: same.offFamilyRegressions, disjRegress: disj.offFamilyRegressions, substrateResid: same.substrate_resid, irDependency: same.ir_dependency };
};
const gates = Object.fromEntries(Object.keys(adapters).map((an) => [an, gateOf(an)]));
const anyPass = Object.values(gates).some((g) => g.pass);

const verdict = {
  generatedAt: new Date().toISOString(), mode: 'flywheel viability (research gate, NOT launch promotion)',
  adapters: Object.keys(adapters), heldouts: contexts.map((c) => c.key),
  lifts, gates, flywheel_viable: anyPass,
  conclusion: anyPass
    ? 'FLYWHEEL VIABLE: a candidate clears the research gate (real tuning lift, survives disjoint/frontier, no off-family regression, IR-dependent or substrate-load-bearing).'
    : 'flywheel plumbing proven, useful candidate NOT YET found (honest non-pass — acceptable per Track A).',
};
writeFileSync(O('flywheel-verdict.json'), JSON.stringify(verdict, null, 2));
console.log('\n=== FLYWHEEL VERDICT ===\n' + JSON.stringify(verdict, null, 2));

// 5. baseline re-pin DRY RUN if any candidate passes (not launch default).
if (anyPass) {
  const passAn = Object.keys(gates).find((an) => gates[an].pass);
  const env = GPU ? `${gpuEnv} CORETEX_RERANKER_ADAPTER_DIR=${adapters[passAn]}` : `CORETEX_RERANKER_ADAPTER_DIR=${adapters[passAn]}`;
  sh(`6 baseline re-pin DRY RUN (adapter ${passAn})`, `node scripts/pin-r5-synth-baseline.mjs --reranker ${rerankerArg} --out ${O('baseline-repin-dryrun.json')}`, env);
  console.log('baseline re-pin dry run →', O('baseline-repin-dryrun.json'));
}
console.log(`\nflywheel artifacts → ${outDir}`);
