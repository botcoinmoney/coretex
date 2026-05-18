# CoreTex Post-Corpus Playbook

> **Status:** Phase A + B substrate hardening SHIPPED (commit 944e2c9). Launch bundle `bundleHash 0x0de6db67…` pinned against `corpusRoot 0x4cfa8594…`. The scoring pipeline is now the v2-lens two-stage retriever with stage-1 BGE-M3 over the full corpus + stage-2 substrate-as-bias + Phase B category-lens BFS over corpus-native relations. Deterministic calibration done (Runs 1-4); Qwen3 refinement of variance/headroom/minImprovement remains as a launch-readiness recalibration trigger (see `CORETEX_SUBSTRATE_EXPANSION_HARDENING.md` §8 + §11).
> **Last updated:** 2026-05-15.
> **Audience:** the next orchestrator agent or human operator running the post-corpus sequence.
> **Companion docs:** `CORETEX_LAUNCH_PLAN_v2.md` (controlling plan), `CORETEX_SUBSTRATE_EXPANSION_HARDENING.md` (current launch blocker), `CORETEX_CALIBRATION_AGENT_RUNBOOK.md` (per-step procedure), `CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md` (8-phase reference), `CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md` (auditor proof).

## Substrate hardening complete — execution log (2026-05-15)

Phase A + Phase B landed. Calibration Runs 1-4 ran end-to-end. v3-lens
bundle pinned. Validation suite A/C/D/I/K + Test G PASS. Detailed
status in `CORETEX_SUBSTRATE_EXPANSION_HARDENING.md` §8.

Pre-hardening checkpoint (kept as historical context):

| Step | Status | Artifact |
|---|---|---|
| 1 validate | ✅ PASS | `/var/lib/coretex/reports/corpus-validation.json` (errors=0, events=678910) |
| 2 determinism fixture | ✅ reused | 200-pair calibration-vintage fixture |
| 3 determinism check ×3 logical hosts | ✅ reused | calibration-vintage reports |
| 4 aggregate determinism | ✅ PASS | P50/P90/P99 = 0 ppm vs 250 tolerance |
| 5 calibrate bundle profile | ✅ PASS | `/etc/coretex/bundle-profile.json` — replayTolerancePpm=250, minImprovementPpm=2500, packSize=128, majorDeltaThreshold=5076 (eval_hidden=101526) |
| 6 build initial bundle manifest | ❌ FAILED + paused | second `readFileSync` over 6.3 GB corpus at `verifyBundleManifest` (separate site from `hashFile` which was fixed at 85a159d) |
| 7-9 baseline-pin / Phase 13 / labeler audit | ⏸ not run | — |

Resume preconditions:
1. Land Phase A of `CORETEX_SUBSTRATE_EXPANSION_HARDENING.md` (two-stage retrieval scorer with stage 1 BGE-M3 over full corpus + stage 2 substrate-as-bias). Without this, step 8 Phase 13 would validate the wrong pipeline.
2. Patch `verifyBundleManifest` in `packages/cortex/src/bundle/index.ts` to use the streaming-sha256 helper added at 85a159d for any file > 2 GiB (mirror change).
3. Recalibrate `baselineVariancePpm` under the new scorer — the value step 5 wrote was measured against the bookmark-cache scorer and will not be accurate for the lens-routing scorer.

When the substrate hardening lands, re-run from step 5 (calibrate). Steps 1-4 stay valid (corpus shape + bi-encoder determinism are unchanged by the scorer refactor).

## Why this doc exists

The prior orchestrator already executed a complete end-to-end calibration pass on **2026-05-10** that validated every step of the pipeline against a 1,752-event interim corpus. The on-disk evidence is preserved at:

- `/var/lib/coretex/reports/` — 10 result artifacts (validation, determinism × 3, aggregate, capacity, Phase 13 log, summary)
- `/etc/coretex/` — 5 bundle artifacts (manifest + profile, v1 + v2 post-pivot)
- `CORETEX_CALIBRATION_2026-05-10.md` — narrative record

The post-corpus run is **not** a from-scratch redo. It is the **same orchestration against the real launch corpus** (≈679k events). This playbook lists, for each step, the input (existing on-disk artifact OR fresh from launch corpus), the script that produces it, the output location, and the prior-run reference values to compare against.

## What's already validated (DO NOT redo)

| Capability | Status | Reference |
|---|---|---|
| Corpus generator end-to-end against challenge library | ✅ validated 2026-05-10 on 1,752 events, errors=0 | `reports/corpus-validation.json` |
| Capacity projection at 512 seeds/domain | ✅ projects 678,910 events, 8.83 months no-repeat | `reports/corpus-capacity.json` |
| Determinism × 3 logical hosts on one CPU | ✅ P50/P90/P99 = 0 ppm vs 250 ppm tolerance | `reports/determinism-aggregate.json` |
| Cross-CPU determinism (bi-encoder stage) | ✅ Zen 4 ↔ Zen 3, cosine = 0 ppm | `CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md` |
| Phase 13 e2e (real Qwen3 + BGE-M3) | ✅ 3/5 accepted + adversarial rejected per spec | `reports/phase13-real.log` |
| Mainnet contract bindings (chainId 8453) | ✅ verified at block 45,802,289 | `CORETEX_CALIBRATION_2026-05-10.md §"Mainnet contract bindings"` |
| Bundle profile parameters (`replayTolerancePpm=250`, `minImprovementPpm=2500`, composite weights, floors, hidden pack quotas, 6-type Relations) | ✅ pinned in `bundle-profile-v2.json` | `/etc/coretex/bundle-profile-v2.json` |
| Substrate codec / Merkle / packing | ✅ pinned by per-file SHA-256 in `bundle/index.ts` | `/etc/coretex/bundle-manifest-v2.json` (substrate section) |

**These steps were validated against the methodology, not against the launch corpus content.** The methodology is unchanged for the launch corpus — same scripts, same models, same parameters — only the corpus events themselves are new.

## What MUST run against the launch corpus

In execution order. Each step shows: ① **input** → ② **script** → ③ **output** → ④ **prior-run reference**.

### Step 1: Merge per-shard NDJSONs into canonical launch corpus

The launch corpus is generated as three disjoint domain shards. The original plan partitioned four domains across two hosts; during execution host 1 took the scrna_imputation reassignment after finishing companies (host 2 had already completed comp_bio), so quantum_physics was deliberately dropped in favor of finishing companies + comp_bio + scrna within the wall-clock budget. The three-shard inventory at merge time:

| Shard | Producer | Events | Per-shard corpusRoot | Source NDJSON |
|---|---|---|---|---|
| companies | host 1 (Zen 4 / AVX-512), pre-swap | 353,278 | `0x68fad2293b32abd411bebcf46dd44446f9a923e72c6118265d388a8337e2ebe6` | `/var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson` |
| computational_biology | host 2 (Zen 3 / AVX-2) | 159,744 | `0xde70ec40d97f255894d1d43a202b2a1481e6b2d2bd1854b1016526bc11ce376e` | `/var/lib/coretex/corpus-epoch-0-launch-host2.json.events.ndjson` |
| scrna_imputation | host 1, post-swap | 165,888 | `0xa1b08775c505ddb4d0742a30c153b5eed3202ef290c1fa73373f977ea577383d` | `/var/lib/coretex/corpus-epoch-0-launch-scrna.json.events.ndjson` |
| **total** | | **678,910** | — | — |

Event IDs are domain-prefixed (`coretex_v1:<domain>:s<seed>:m<m>:c<diff>:...`), so the three NDJSONs are disjoint and concatenate cleanly.

**Procedure (host 2 NDJSON is already archived on host 1 per `release/corpus-shards/host2-comp_bio-epoch0.manifest.json`):**

```bash
# 1. Concatenate three shards into a single merged NDJSON. Use a new filename
#    so the per-shard NDJSONs remain intact as audit artifacts.
cat /var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson \
    /var/lib/coretex/corpus-epoch-0-launch-host2.json.events.ndjson \
    /var/lib/coretex/corpus-epoch-0-launch-scrna.json.events.ndjson \
    > /var/lib/coretex/corpus-epoch-0-launch-MERGED.json.events.ndjson

# 2. Verify line count
wc -l /var/lib/coretex/corpus-epoch-0-launch-MERGED.json.events.ndjson
# expected: 678,910

# 3. Verify ID uniqueness across shards
grep -oE '"id":"[^"]+"' /var/lib/coretex/corpus-epoch-0-launch-MERGED.json.events.ndjson \
  | sort | uniq -d | head
# expected: empty (no duplicate ids)
```

### Step 2: Finalize → canonical corpus JSON + corpusRoot

The generator's two-pass finalize step is invoked by re-running with `--resume` against the merged NDJSON and the **three actually-generated domains** (NOT four — quantum_physics was dropped per Step 1). With every tuple already in the touched-set, the generation loop skips entirely and the script goes straight to `writeCorpusOutputStreaming`, which reads the NDJSON, sorts/dedupes, computes the canonical `corpusRoot`, and writes the corpus JSON.

```bash
HF_HUB_CACHE=/var/lib/coretex/model-cache HF_HUB_OFFLINE=1 \
CORETEX_BIENCODER=pinned CORETEX_BIENCODER_MODE=streaming \
CORETEX_BIENCODER_PYTHON=/root/cortex/.venv/bin/python \
BIENCODER_NUM_THREADS=16 BIENCODER_INNER_BATCH=64 \
node --max-old-space-size=8192 \
  /root/cortex/scripts/generate-coretex-retrieval-corpus.mjs \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --challenge-lib-root /root/botcoin-coordinator/packages/challenges \
  --source challenge-library \
  --domains companies,computational_biology,scrna_imputation \
  --seeds-per-domain 512 --resume \
  --out /var/lib/coretex/corpus-epoch-0-launch-MERGED.json
# expected output:
#   [resume] read 678910 existing events covering 24576 tuples
#   wrote 678910 challenge-library events to /var/lib/coretex/corpus-epoch-0-launch-MERGED.json
#   corpusRoot=0x...   (the launch corpusRoot, pin this in the bundle)
```

If the generator emits any "generating tuple" message (not "skipping"), abort — that indicates a tuple is missing from the merged NDJSON and the script would call BGE-M3 to fill it. Stop and investigate before retrying.

**Reference:** the calibration corpusRoot (1,752 events) was `0x8879362da18d0202b3704a48253a0bc3c713cee1819d95750936ef68d5c75f19`. The three per-shard corpusRoots are listed in step 1; the merged launch corpus will produce a **different** root from any of them — that is the canonical launch commitment.

### Step 3: Validate the launch corpus shape

```bash
node --max-old-space-size=8192 /root/cortex/scripts/validate-retrieval-corpus.mjs \
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
  --out /var/lib/coretex/reports/corpus-validation-launch.json
# expect: errors=0, eventCount=678910 (or very close — modifier-counts/difficulties expansion)
```

**Reference:** the 2026-05-10 calibration corpus validated with `errors=0` (`reports/corpus-validation.json`). The whole-file `JSON.parse` requires `--max-old-space-size=8192` at this scale; if `validate-retrieval-corpus.mjs` does not have that flag baked in, pass it via `node --max-old-space-size=...` as shown.

### Step 4: Build the determinism fixture from the launch corpus

```bash
node /root/cortex/scripts/build-determinism-fixture.mjs \
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
  --max-pairs 1000 \
  --out /var/lib/cortex/benchmark/fixtures/determinism/1k-pairs-launch.json
```

This extracts a deterministic 1,000-pair sample (shuffled by `keccak256(pair_id)`, reproducible) that the determinism check consumes. Prior fixture was at the same path with the calibration-corpus pairs.

### Step 5: Determinism check on each host

Run `determinism-check.mjs` on every certified host. Today that means host 1 (Zen 4 / AVX-512) and host 2 (Zen 3 / AVX-2). A third physical host is OPTIONAL given the design's "auditable trust" framing — see `CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md` for the standing 2-host proof.

```bash
# on each host:
node /root/cortex/scripts/determinism-check.mjs \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --fixture /var/lib/cortex/benchmark/fixtures/determinism/1k-pairs-launch.json \
  --host-id host_$(hostname -s) \
  --out /var/lib/coretex/reports/determinism-host-$(hostname -s)-launch.json
```

### Step 6: Aggregate cross-host determinism

```bash
# on host 1, after host 2's report is rsynced over
rsync -aP coretex-2:/var/lib/coretex/reports/determinism-host-*-launch.json \
          /var/lib/coretex/reports/
node /root/cortex/scripts/aggregate-determinism.mjs \
  --reports '/var/lib/coretex/reports/determinism-host-*-launch.json' \
  --max-tolerance-ppm 250 \
  --out /var/lib/coretex/reports/determinism-aggregate-launch.json
# expect: P50/P90/P99 ≤ 250 ppm
```

**Reference:** the 2026-05-10 prior aggregate hit **0 ppm** on 400 pairs across 3 logical hosts (`reports/determinism-aggregate.json`). The launch run will be the first multi-physical-host measurement.

This step closes **task #13** in the active task list.

### Step 7: Calibrate the bundle profile against the launch corpus

```bash
node /root/cortex/scripts/calibrate.mjs \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --calibration-corpus /var/lib/coretex/corpus-epoch-0-launch.json \
  --determinism-aggregate /var/lib/coretex/reports/determinism-aggregate-launch.json \
  --out /etc/coretex/bundle-profile-launch.json
```

**Reference:** prior `bundle-profile-v2.json` parameters (mostly spec defaults, not data-driven from the small smoke):
- `replayTolerancePpm = 250` (← from aggregate)
- `minImprovementPpm = 2500` (10× safety margin above replayTolerance)
- `compositeWeights = { w_retrieval: 0.75, w_temporal: 0.08, w_relation_recall: 0.07, w_abstention: 0.05, w_structural_sanity: 0.05 }`
- `patchAcceptanceFloors = { minImprovementPpm: 2500, structuralFloor: 0.95, protectedRegressionFloor: 0.05, familyCatastrophicFloor: 0.85 }`
- `splitRatios = { trainVisible: 70, calibration: 10, evalHidden: 15, canary: 5 }`
- `hiddenPack = { packSize: 103, stratum quotas pinned per family }`

If the launch-corpus calibration produces materially different numbers, that's a flag to investigate before locking the bundle. Expected behavior: numbers either match v2 exactly (spec defaults) or shift by single-digit percentages (data-driven refinement). A 2× change in any weight is suspicious and should be diffed before commit.

### Step 8: Rebuild the bundle manifest with the launch `corpusRoot`

```bash
node /root/cortex/scripts/build-coretex-bundle.mjs \
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
  --profile /etc/coretex/bundle-profile-launch.json \
  --out /etc/coretex/bundle-manifest-launch.json
# capture the new bundleHash from stdout
```

**Reference:** prior `bundle-manifest-v2.json` bundleHash was `0x7260c1203607c192f0505d9ee63038c03780f8afcf987ef225c32c1b7f2abaee`; the launch bundle will have a **different** hash because `corpusRoot` is different. The substrate region (`packedBytes=32768`, `wordCount=1024`), spec SHAs, and implementation SHAs are unchanged.

### Step 9: Pin baseline + variance into the bundle

```bash
node /root/cortex/scripts/pin-baseline-into-bundle.mjs \
  --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
  --eval-seed-hex "$(openssl rand -hex 32)" \
  --epoch-id 0 \
  --samples 1
# writes baselineParentScorePpm, baselineVariancePpm into the bundle
```

### Step 9.5: Active-root size calibration (launch-binding policy)

This step chooses `initialActiveSeedsPerDomain` for launch and binds the
launch corpus root policy used by bundle/on-chain artifacts.

**Provisional launch default:** `initialActiveSeedsPerDomain=128` unless the
final empirical post-corpus run strongly supports a smaller passing value.

**Goal:** avoid both extremes:
- **Too small:** weak family/depth coverage or insufficient hidden-pack runway.
- **Too large:** day-0 surface too broad, poor staged-expansion headroom.

**9.5.a Preflight (script/version and units sanity)**

Before trusting results from this step, verify the active-size calibrator
implementation includes:
- `--daily-seeds-per-domain`
- empirical per-domain seed-density stats (`min/p50/p90/max/mean`)
- conservative p90 routine-delta output telemetry
- candidate-by-candidate gate telemetry

If the script is still on the older fixed-estimate implementation, patch it
before continuing (do not run launch sizing on stale logic).

**Critical units rule:** routine-delta safety is an `eval_hidden` gate. The
safety comparison must be conservative **daily eval_hidden delta** against
`majorDeltaThreshold` (which is computed from `eval_hidden`), not total daily
events. If tooling output is unit-mismatched, stop and fix tooling before
proceeding.

**9.5.b Capacity + coverage + routine-delta safety (no model work)**

```bash
node /root/cortex/scripts/calibrate-initial-active-size.mjs \
  --reserve-corpus /var/lib/coretex/corpus-epoch-0-launch.json \
  --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
  --candidates 64,96,128,160,192,224,256 \
  --runway-days 60 \
  --epochs-per-day 1 \
  --pack-size 128 \
  --daily-seeds-per-domain 2 \
  --seeds-per-domain-total 512 \
  --out /var/lib/coretex/reports/initial-active-size-launch.json
```

This report now computes routine-delta pressure from **empirical per-domain
events/seed density** in the actual launch reserve (`p50` expected and `p90`
conservative), not a fixed constant.

**Decision rule (hard gate):**
- Choose the **smallest** candidate `S` with `pass=true`.
- If no candidate passes, do not launch staging policy; re-run with expanded
  candidate set and record why each gate failed.
- Tie-break policy: if both 96 and 128 pass, prefer `128` unless `96` shows
  clearly comfortable conservative margin in the routine-delta gate.

**9.5.c Reranker sanity at launch scale (model work)**

```bash
node /root/cortex/scripts/validate-label-reranker-correlation.mjs \
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
  --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
  --max-pairs-per-category 50 \
  --report /var/lib/coretex/reports/label-reranker-correlation-launch.json

node -e "const r=require('/var/lib/coretex/reports/label-reranker-correlation-launch.json'); if(!r.pass){console.error('label-reranker correlation failed'); process.exit(1)}"
```

**Decision rule (hard gate):**
- `label-reranker-correlation-launch.json.pass` must be `true`.

**9.5.d Baseline-noise sanity (reuse Step 9 output)**

From `/etc/coretex/bundle-manifest-launch.json` after Step 9:
- `baselineVariancePpm`
- `replayTolerancePpm`
- `minImprovementPpm`

**Decision rule (hard gate):**
- `baselineVariancePpm <= replayTolerancePpm`
- `minImprovementPpm >= (replayTolerancePpm + baselineVariancePpm)`

These prevent launching a policy where score noise is too close to acceptance
difficulty.

**9.5.e Anti-overtune tie-breaker (only when multiple S pass)**

If multiple candidates pass 9.5.a/9.5.b/9.5.c:
1. pick the smallest `S` with runway >= target (`runwayDays`) and
2. `dailyDeltaEventsConservative / majorDeltaThreshold <= 0.50` already true
   by gate, then
3. prefer the smallest `S` unless operator has a written reason to increase.

No manual weight tuning, no hand-set ad-hoc thresholds beyond the gates above.

**9.5.f Launch root binding rule (required)**

Once `S` is selected:
- Materialize a deterministic active-prefix corpus artifact:
  - `/var/lib/coretex/corpus-epoch-0-active-S<S>.json`
- Validate and record its `corpusRoot`.
- Launch bundle and on-chain epoch pinning must reference the **active-prefix**
  `corpusRoot`.
- Keep the full reserve corpus root as an operator/audit artifact only; it is
  not the launch root.

This prevents ambiguity between reserve-root and launch-root semantics.

**9.5.g Target-advances launch posture**

For initial launch posture with staged active root:
- set epoch-rotation `targetAdvances=10` for `nextMinImprovementPpm`
- keep corpus-size choice and target-advances choice as separate knobs:
  - corpus size sets search terrain breadth
  - target advances sets feedback pressure on threshold dynamics

**Deliverables to archive:**
- `/var/lib/coretex/reports/initial-active-size-launch.json`
- `/var/lib/coretex/reports/label-reranker-correlation-launch.json`
- `/var/lib/coretex/corpus-epoch-0-active-S<S>.json`
- `/etc/coretex/bundle-manifest-launch.json` (baseline pinned, active-root bound)
- one-line decision record: `chosen initialActiveSeedsPerDomain=<S>`

### Step 10: Phase 13 e2e against the launch bundle + launch corpus

```bash
ITERATIONS=25 \
CORETEX_RERANKER=qwen3 CORTEX_REAL_EVAL=1 CORETEX_RERANKER_PRODUCTION=1 \
CORETEX_BIENCODER=pinned CORETEX_RERANKER_MODE=streaming \
node /root/cortex/test/e2e/phase-13/run.mjs \
  --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json
# expected: all iterations behave per spec (accept above floor, reject below floor,
# reject adversarial), final result PASS, log at /var/lib/coretex/reports/phase13-launch.log
```

**Reference:** prior 5-iteration Phase 13 (`phase13-real.log`) on calibration corpus:
- iter 0: ACCEPTED, deltaPpm=7009
- iter 1: ACCEPTED, deltaPpm=3505
- iter 2: ACCEPTED, deltaPpm=2542
- iter 3: REJECTED, deltaPpm=910 (no_retrieval_improvement)
- iter 4: REJECTED, deltaPpm=310 (family_catastrophic:near_collision)
- adversarial: REJECTED (no_retrieval_improvement)

The launch run should show the same shape: a mix of clean accepts above 2,500 ppm, clean rejects below the floor, and the adversarial sub-test rejecting cleanly. Iteration count is configurable; `ITERATIONS=25` per the calibration runbook recommendation for pre-launch acceptance.

### Step 11: Update the orchestrate.log + final-launch-summary.md

The bash orchestrator script `/root/cortex/scripts/orchestrate-cpu-calibration.sh` is idempotent and chains steps 3–10 (skipping steps 1–2 which are the corpus merge). Simply invoke it with the launch corpus path:

```bash
CORPUS=/var/lib/coretex/corpus-epoch-0-launch.json \
  bash /root/cortex/scripts/orchestrate-cpu-calibration.sh
```

It writes the chained log to `/var/lib/coretex/reports/orchestrate.log` (appending — preserves the prior 2026-05-10 entries) and the human-readable summary to `/var/lib/coretex/reports/final-launch-summary.md`.

This step closes **task #14** in the active task list (the canonical corpus is produced; the rest of the orchestration runs against it).

**Commit point** (after step 11): commit the calibration write-down doc (next section) + any updated `/etc/coretex/*` configs that travel with the repo. Do **not** commit `/var/lib/coretex/reports/` artifacts; they are runtime evidence — capture their SHA-256s in the write-down doc instead.

### Step 12: Build mining-flow fixtures (outside-perspective harness inputs)

The mining-flow e2e and integration tests need three pre-mined patches with annotated expected outcomes:

| Bucket | Expected envelope | What triggers it |
|---|---|---|
| `screener_reject` | `{ status: 'rejected', code: 'rejected' }` (opaque) | malformed bytes, oversized newWords, wrong patchType, etc. |
| `screener_pass_no_advance` | `{ status: 'accepted', patchHash, evalReportHash }` (no `receipt`) | valid patch that admits but produces `deltaPpm < minImprovementPpm` |
| `state_advance` | `{ status: 'accepted', patchHash, evalReportHash, receipt }` | valid patch with `deltaPpm >> minImprovementPpm`; would trigger on-chain `submitWorkReceipt` |

The fixtures are persisted at `benchmark/fixtures/mining-flow/epoch-0.fixtures.json` (committed) so the integration test is CI-fast and the e2e script can run in replay mode.

```bash
node /root/cortex/scripts/mining-flow-e2e.mjs \
  --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
  --persist-fixtures benchmark/fixtures/mining-flow/epoch-0.fixtures.json \
  --max-iterations 200 \
  --out /var/lib/coretex/reports/mining-flow-fixtures-launch.json
# exits 0 once all 3 outcome buckets observed at least once; persists the
# 3 sample patches that triggered each bucket
```

If the script exhausts `--max-iterations` without observing all 3 buckets, that is a calibration signal: either `minImprovementPpm` is too tight (no state-advance ever) or too loose (no pass-but-no-advance bucket).

### Step 13: Mining-flow e2e through the HTTP shim (closes gap A+B+F)

Re-run the same script in replay mode to assert the three persisted fixtures produce the expected envelopes when driven through the actual `createCoreTexCoordinatorRouteHandler` route table:

```bash
node /root/cortex/scripts/mining-flow-e2e.mjs \
  --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
  --fixtures benchmark/fixtures/mining-flow/epoch-0.fixtures.json \
  --mode replay \
  --base-url in-process \
  --out /var/lib/coretex/reports/mining-flow-e2e-launch.json
# expected: 3/3 envelopes match annotated outcomes
```

`--base-url in-process` mounts the handler directly; pass an http URL (e.g. `http://127.0.0.1:18081`) to drive a real TCP server instead. The fixtures travel with the repo so this step is reproducible from any fresh clone.

**Commit point** (after step 13): commit `benchmark/fixtures/mining-flow/epoch-0.fixtures.json` and reference it in the calibration write-down.

### Step 14: Base fork rehearsal of on-chain state advance (closes gap C)

Drives the `state_advance` fixture through `BotcoinMiningV4.submitWorkReceipt` against a Base-mainnet fork at the pinned production addresses (`CortexState 0x5d3B…555d`, `BotcoinMiningV4 0x12ff…94A4`). Uses `anvil_impersonateAccount` on the coordinator signer `0x6463…F635`; no real signature required, no real funds touched.

```bash
BASE_RPC_URL=<your authenticated Base RPC> \
  node /root/cortex/scripts/base-fork-rehearsal.mjs \
    --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
    --fixtures benchmark/fixtures/mining-flow/epoch-0.fixtures.json \
    --out /var/lib/coretex/reports/base-fork-rehearsal-launch.json
# expected: tx mined on the fork; CortexStateAdvanced + WorkCreditAccepted
# events emitted at the pinned addresses; new stateRoot matches the patch's
# newStateRoot field
```

This step does NOT touch mainnet. It only confirms the wire shape and signature scaffolding are correct against the exact production contracts.

### Step 15: Replay watcher independent verification (closes gap E)

A fresh-clone auditor must be able to reconstruct every state advance from on-chain logs without trusting the coordinator. Verify the watcher reads the fork-emitted events:

```bash
RPC_URL=http://127.0.0.1:8545 \
CORTEX_STATE_ADDRESS=0x5d3B9D9b246cf8457F320Bb27f008186B69D555d \
BOTCOIN_MINING_V4_ADDRESS=0x12ff0B47389AE6d6293d44991B0D6A27394494A4 \
  node /root/cortex/packages/cortex/dist/replay-cli.js watch \
    --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
    --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
    --from-block <fork start block> \
    --out /var/lib/coretex/reports/replay-watcher-launch.json
# expected: watcher reproduces the patch byte-identically (patchHash
# matches), recomputes deltaPpm within replayTolerancePpm of the
# coordinator's evaluation
```

### Step 16: Controlled mainnet canary (gap D — operator-gated, NO SCRIPT)

This step is intentionally NOT scripted. It is the only post-corpus step that touches real mainnet funds and gas. The procedure lives in `docs/CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md` Phase 6; the safety rails are:

1. Dry-run preflight via `cast call` against the pinned `BotcoinMiningV4` contract (returns the call result without submitting).
2. Hard `--gas-limit` ceiling (default: 2 × dry-run estimate, never above the rate-limit `perMinerCap` for the epoch).
3. Single-receipt cap — refuse to submit if the operator passes more than one patch in a batch.
4. Abort if patch byte size is greater than 4 words (the production substrate cap).
5. The replay watcher (step 15) must already be running and confirm pickup within 5 blocks before submitting a second canary.
6. Operator must pass `--i-confirm-mainnet` explicitly. There is no env-var override.

After the canary, the watcher report must show: `coordinatorPatchHash === watcherPatchHash`, `coordinatorDeltaPpm` within `replayTolerancePpm` of `watcherDeltaPpm`, and `CortexStateAdvanced` event observed on mainnet at the pinned `CortexState` address.

**Commit point** (after step 16): commit the canary's audit-trail entry to `docs/CORETEX_CALIBRATION_<date>.md`.

## Calibration write-down format

Every post-corpus run captures its evidence in a single dated narrative doc at `docs/CORETEX_CALIBRATION_<YYYY-MM-DD>.md`. The 2026-05-10 calibration doc (`docs/CORETEX_CALIBRATION_2026-05-10.md`) is the canonical template — mirror its section structure exactly so cross-epoch diffs are trivial.

Required sections, in order:

1. **Summary** — one-paragraph plain-language outcome (PASS / PARTIAL / FAIL), date, operator handle, host inventory.
2. **Inputs** — paths + SHA-256 of: launch corpus JSON, bundle manifest, evalSeed (commit-hash only; preimage stays in the secure store), challenge-library root revision, both pinned model revisions.
3. **Per-step results** — one row per playbook step (1–16) with: command run, output artifact path, output SHA-256, pass/fail, reference value from the 2026-05-10 calibration.
4. **Mining-flow report excerpt** — copy the 3 bucket records from `mining-flow-e2e-launch.json` (the bucket name, the patchHash, the deltaPpm, the envelope echo).
5. **Base fork rehearsal** — tx hash on the fork (synthetic), CortexStateAdvanced event payload, new stateRoot.
6. **Replay watcher reconciliation** — the watcher's reproduction of each accepted patch's deltaPpm, with the cross-comparison diff in ppm.
7. **Deltas vs 2026-05-10** — any number that changed materially (>5% on a profile weight, or >250 ppm on a determinism number) with operator-written rationale.
8. **Mainnet canary** (only if step 16 was executed) — receipt hash on mainnet, gas consumed, block, mempool inclusion latency, replay-watcher reconciliation.
9. **Open follow-ups** — any item that came out of this run and needs to land before the next epoch.

The doc is committed at the end of step 11 (initial form) and amended after steps 13, 14, 15, 16 (further commit points). Do not write transient findings docs — everything lands in this one file.

## Commit cadence summary

Per-step commit/push markers introduced above, consolidated:

| After step | What to commit |
|---|---|
| 11 | Initial `docs/CORETEX_CALIBRATION_<date>.md` with sections 1–3 populated, plus any `/etc/coretex/*` config that the repo tracks |
| 13 | `benchmark/fixtures/mining-flow/epoch-0.fixtures.json` + sections 4–5 of the calibration doc + reference to `mining-flow-e2e-launch.json` SHA-256 |
| 14 | Section 5 final values (fork tx hash, event payload) |
| 15 | Section 6 (replay reconciliation) |
| 16 | Section 8 (mainnet canary), only after explicit operator confirmation |

Push to `origin/main` after each commit so the public CoreTex repo reflects post-corpus state in real time.

## After all 11 steps: launch readiness gates

| Gate | Source | Closed by |
|---|---|---|
| Corpus events ≥ 600,000 | capacity gate | step 2 |
| Corpus validation errors = 0 | `reports/corpus-validation-launch.json` | step 3 |
| Cross-host P99 score divergence ≤ 250 ppm | `reports/determinism-aggregate-launch.json` | step 6, **task #13** |
| Bundle profile params within sane bounds vs v2 reference | manual diff vs prior | step 7 |
| Active-root launch root is unambiguous (active-prefix root pinned, reserve root archival only) | `corpus-epoch-0-active-S<S>.json`, launch `bundle-manifest`, epoch pinning records | step 9.5 |
| Active-root size decision is gated by empirical reserve density + reranker + baseline-noise checks | `initial-active-size-launch.json`, `label-reranker-correlation-launch.json`, baseline fields in launch bundle | step 9.5 |
| Phase 13 all iterations behave per spec + adversarial rejected | `reports/phase13-launch.log` | step 10 |
| `final-launch-summary.md` references launch corpusRoot + launch bundleHash | summary | step 11 |
| Screener gameability suite passes | `test/unit/screener-admission-gameability.test.mjs` | **task #6** (handed off to parallel agent, see `HANDOFFS/HANDOFF_2026-05-13_PARALLEL_WORK.md`) |
| Coordinator-affiliated wallet exclusion mechanism | `CORETEX_PRODUCTION_RUNBOOK.md` | wiring backlog (**task #10**) |
| Per-patch coordinator wiring complete | `CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md §"Auditor Follow-Ups"` + §"gameability + multi-host hardening" | **task #10** wiring backlog |

## Out of scope for THIS playbook

- Live coordinator integration (separate wiring sequence — task #10 backlog)
- Mainnet contract upgrade epoch (per `CORETEX_PRODUCTION_RUNBOOK.md` operator procedure)
- Third physical CPU host for determinism (intentionally deferred — auditable-trust framing)
- 1024 → 2048 substrate ladder execution (post-launch lever, triggers pinned in `specs/cortex_state.md`)
- Future typed/weighted Relations scorer activation (post-launch difficulty lever, task #12)

## Operator quick reference

| Action | Command |
|---|---|
| Watch corpus live | `journalctl -u coretex-corpus -f` |
| Cross-host health log | `tail -f /var/lib/coretex/cross-host-health.log` |
| Stop corpus on a host | `systemctl stop coretex-corpus` |
| Start corpus on a host | `systemctl start coretex-corpus` |
| Drive host 2 from host 1 | `ssh coretex-2 '<any command>'` |
| Verify a host has not been reaped by user-session SIGKILL | `systemctl show coretex-corpus -p Slice` (must print `Slice=coretex.slice`) |
| Fire the stuck-watchdog manually | `systemctl start corpus-stuck-watchdog.service` |

If the launch corpus generator dies for any reason, the systemd unit's `Restart=on-failure` + `--resume` path will revive it from the last clean tuple within 15 seconds. The `corpus-stuck-watchdog.timer` catches alive-but-deadlocked at 5-min cadence. Both are immune to user-session lifecycle because the unit is in `coretex.slice`, not `user.slice`.

---

**This playbook supersedes ad-hoc post-corpus procedure documented elsewhere. The 11-step sequence is the canonical execution order; deviation requires a written reason in the post-corpus run log.**
