# CoreTex Post-Corpus Playbook

> **Status:** authoritative execution checklist for the work that runs **after** the launch corpus generation completes.
> **Last updated:** 2026-05-13.
> **Audience:** the next orchestrator agent or human operator running the post-corpus sequence.
> **Companion docs:** `CORETEX_LAUNCH_PLAN_v2.md` (controlling plan), `CORETEX_CALIBRATION_AGENT_RUNBOOK.md` (per-step procedure), `CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md` (8-phase reference), `CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md` (auditor proof).

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

### Step 1: Merge dual-host NDJSONs into canonical launch corpus

The corpus generation is running on two hosts with disjoint domain partition:

| Host | Domains | Output NDJSON |
|---|---|---|
| Host 1 (Zen 4) | `companies, quantum_physics` | `/var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson` |
| Host 2 (Zen 3, `coretex-2`) | `computational_biology, scrna_imputation` | `/var/lib/coretex/corpus-epoch-0-launch-host2.json.events.ndjson` |

The event IDs are domain-prefixed (`coretex_v1:<domain>:s<seed>:m<m>:c<diff>:...`), so the two NDJSONs are disjoint and concatenate cleanly.

**Procedure:**

```bash
# 1. wait for both hosts to report 'corpus-epoch-0-launch: wrote ... events' in their logs
# 2. rsync host 2's NDJSON to host 1
rsync -aP coretex-2:/var/lib/coretex/corpus-epoch-0-launch-host2.json.events.ndjson \
          /var/lib/coretex/
# 3. concatenate — order does not matter; the generator's finalize step sorts by id
cat /var/lib/coretex/corpus-epoch-0-launch-host2.json.events.ndjson \
    >> /var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson
# 4. validate line count and ID uniqueness BEFORE finalization
wc -l /var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson
# expect ≈ 678,910 lines
grep -oE '"id":"[^"]+"' /var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson \
  | sort | uniq -d | head
# expect EMPTY output (no duplicates)
```

### Step 2: Finalize → canonical corpus JSON + corpusRoot

The generator's two-pass finalize step is invoked by re-running with `--resume` and ALL four domains. With every tuple already in the touched-set, the generation loop skips entirely and the script goes straight to `writeCorpusOutputStreaming`, which reads the NDJSON, sorts/dedupes, computes the canonical `corpusRoot`, and writes the corpus JSON.

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
  --domains companies,quantum_physics,computational_biology,scrna_imputation \
  --seeds-per-domain 512 --resume \
  --out /var/lib/coretex/corpus-epoch-0-launch.json
# expected output:
#   wrote 678910 challenge-library events to /var/lib/coretex/corpus-epoch-0-launch.json
#   corpusRoot=0x...   (the launch corpusRoot, pin this in the bundle)
```

**Reference:** the calibration corpusRoot (1,752 events) was `0x8879362da18d0202b3704a48253a0bc3c713cee1819d95750936ef68d5c75f19`. The launch corpus will produce a **different** root that becomes the canonical commitment.

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
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
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
  --template /etc/coretex/template-bundle.json \
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
  --profile /etc/coretex/bundle-profile-launch.json \
  --out /etc/coretex/bundle-manifest-launch.json
# capture the new bundleHash from stdout
```

**Reference:** prior `bundle-manifest-v2.json` bundleHash was `0x7260c1203607c192f0505d9ee63038c03780f8afcf987ef225c32c1b7f2abaee`; the launch bundle will have a **different** hash because `corpusRoot` is different. The substrate region (`packedBytes=32768`, `wordCount=1024`), spec SHAs, and implementation SHAs are unchanged.

### Step 9: Pin baseline + variance into the bundle

```bash
node /root/cortex/scripts/pin-baseline-into-bundle.mjs \
  --bundle /etc/coretex/bundle-manifest-launch.json \
  --corpus /var/lib/coretex/corpus-epoch-0-launch.json
# writes baselineParentScorePpm, baselineVariancePpm into the bundle
```

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

## After all 11 steps: launch readiness gates

| Gate | Source | Closed by |
|---|---|---|
| Corpus events ≥ 600,000 | capacity gate | step 2 |
| Corpus validation errors = 0 | `reports/corpus-validation-launch.json` | step 3 |
| Cross-host P99 score divergence ≤ 250 ppm | `reports/determinism-aggregate-launch.json` | step 6, **task #13** |
| Bundle profile params within sane bounds vs v2 reference | manual diff vs prior | step 7 |
| Phase 13 all iterations behave per spec + adversarial rejected | `reports/phase13-launch.log` | step 10 |
| `final-launch-summary.md` references launch corpusRoot + launch bundleHash | summary | step 11 |
| Screener gameability suite passes | `test/unit/screener-admission-gameability.test.mjs` | **task #6** (handed off to parallel agent, see `HANDOFFS/HANDOFF_2026-05-13_PARALLEL_WORK.md`) |
| Coordinator-affiliated wallet exclusion mechanism | `CORETEX_PRODUCTION_RUNBOOK.md` | wiring backlog (**task #10**) |
| Per-patch coordinator wiring complete | `CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md §"Auditor Follow-Ups"` + §"gameability + multi-host hardening" | **task #10** wiring backlog |

## Out of scope for THIS playbook

- Live coordinator integration (separate wiring sequence — task #10 backlog)
- Mainnet contract upgrade epoch (per `CORETEX_PRODUCTION_RUNBOOK.md` operator procedure)
- Third physical CPU host for determinism (intentionally deferred — auditable-trust framing)
- 1024 → 2048 substrate ladder execution (post-launch lever, triggers pinned in `specs/cortex_state_v0.md`)
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
