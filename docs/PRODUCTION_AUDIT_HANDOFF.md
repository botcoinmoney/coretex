# CoreTex v4 Production Audit Handoff

**Status:** ready for audit / production-readiness review.
**Author:** orchestrator round-2.
**Date:** 2026-05-09.

This document surfaces every gap, quirk, and area of uncertainty that came up during the round-2 production-extension work. Read it before signing off on a paid mainnet launch.

## 1. What now works end-to-end (proven in this session)

`node /root/cortex/test/e2e/phase-11/run.mjs` runs a real multi-iteration mining cycle:

```
load corpus from /root/cortex/benchmark/fixtures/dacr-v0/coretex_dacr.json (5,152 §9-shaped records derived from botcoinmoney/dacr-lt-training)
spawn anvil
forge build + forge script CoreTexE2EFlow (deploy MockERC20 + CortexState + V4, init epoch, stake 10M, screener + iter-1 advance)
loop iter 2..5:
  pick next §9 corpus event
  build SLOT_REPLACE / KEY_UPDATE patch placing event eventId-derived word into substrate
  run off-chain structural screener (mirrors V4 _validateCompactPatch)
  run reranker.score on the (query, query+truth) probe
  encode + sign + broadcast STATE_ADVANCE receipt via forge script
  assert chain stateRoot, transitionCount, credits all advanced
fetch all chain logs
replayV4TransitionsFromLogs reproduces all 5 transitions
asserts every reproducedStateRoot matches local
PASS
```

Final state per the last run:
- 5 on-chain CortexStateAdvanced events
- 5 CoretexPatchBytes events (one per state advance)
- 11 WorkCreditAccepted events (1 screener + 5 advances + 5 implicit per-iteration broadcasts)
- final stateRoot: `0x86a32ece15131f6ac34a9b8a46d9d700e6dd5e65a70a3aa08faf65165b6abe4b`
- final miner credits: 3280 across 5 advances + 100 from screener
- per-iteration advance latency p50: ~2 s (forge subprocess overhead, not chain RPC)

`/root/cortex/scripts/build-corpus-from-dacr.mjs` produces a real production corpus from the published HF dataset, deterministically:
- 28,417 raw_attempts available; bridge admits ~5,152 records (rejection breakdown logged)
- 1,454 sequential pairs available; bridge produces temporal events from chosen+rejected pairs
- corpus root + corpus hash both reproducible

## 2. Gaps that block paid-mainnet launch

### 2.1 Reranker returns 1.0 for every probe in this run

The phase-11 deterministic reranker (`createDeterministicReranker`) is a hashing stub. Because we pass `(query, query+truth)` pairs the document literally contains the query verbatim — every probe scores ~1.0 by similarity. **This proves the wire works; it does not exercise the reward law.** Production must:

- Run with `CORETEX_RERANKER=qwen3` and a pinned `Qwen/Qwen3-Reranker-0.6B` revision + per-file SHA-256 set in the bundle manifest.
- Or run with `CORETEX_RERANKER=minilm` (`Xenova/ms-marco-MiniLM-L-6-v2`, true cross-encoder, fast) for tests.
- The reranker score MUST gate submission: if `score < threshold`, the miner SHOULD NOT submit, and the coordinator MUST NOT sign. Currently phase-11 logs the score but does not gate (intentional for the wire test).

**Calibration handoff:** `replayTolerancePpm = 250` and the gating threshold both need to be calibrated against a held-out CortexBench shard with the real model. Cannot be done without the pinned model load.

### 2.2 Bundle manifest's Qwen3 revision is a placeholder

`qwen3Reranker06BManifest()` defaults to `'v0.1.0'`. Production deployments must override with the real upstream HuggingFace commit + per-file SHA-256. Validation already rejects `'main'`. Until a real revision is pinned, the bundle hash in the production deployment is fake.

### 2.3 Distractor mining covers ~99% of attempts but is not bulletproof

The bridge mines distractors from `trap_metadata.traps[i].wrong_value` (and 6 fallback fields). DACR-LT-Training's `quantum_physics` and `companies` shards have these almost-always populated. `computational_biology` and `scrna_imputation` shards are sparser — the admission filter will reject any record without ≥1 distractor. **Mitigation**: extend the bridge to mine distractors from other miners' wrong attempts on the same `challenge_id` (cross-miner distractor mining). Requires processing attempts in batched-by-challenge order rather than streaming.

### 2.4 Sessions + bookend pair categories not yet bridged

The HF dataset has 5,713 session_trajectory rows and 1,427 bookend pairs. Phase-11 corpus only uses raw_attempts + sequential pairs. Adding session bridging gives:
- Long-horizon events with multi-step reasoning (currently underrepresented)
- More relations between events (currently mostly empty)

Implementation: extend `dacr-bridge.ts` with `bridgeDacrSession` + `bridgeDacrBookendPair`.

### 2.5 Coordinator endpoint handlers are a route shim, not a live service

`packages/cortex/src/coordinator/endpoints.ts` declares all ten plan §12 routes and routes correctly to a `CoreTexCoordinatorDataSource` interface. **The host coordinator at /root/botcoin-coordinator-live has not mounted this**. Plan §12 wiring needs the operator to:

1. Add `import { handleCoreTexCoordinatorRoute } from '@botcoin/cortex'` in the cortex-server route table.
2. Provide a concrete `CoreTexCoordinatorDataSource`:
   - `screen(body)` → run structural screener + sign a SCREENER_PASS receipt
   - `evaluate(body)` → run reranker + screener + sign a STATE_ADVANCE receipt only if score >= threshold
   - `getCurrentSubstrate()` → fetch from `CortexState.getEpoch(currentEpoch).stateRoot` + serve packed snapshot
   - `getSubstrate(root)` → look up packed snapshot by root in storage
   - `getPatch(hash)` → look up patch bytes from chain events or local cache
   - `getEvalReport(hash)` → look up signed eval report in storage
   - `getChallengeBook(epoch)` → published per-epoch challenge book (the §9 corpus delta)
   - `getCorpusDelta(epoch)` → published delta in `CorpusDelta` shape
   - `getClientBundle(coreVersionHash)` → published bundle manifest (signed)
   - `health()` → readiness check (substrate path reachable, corpus loaded, model loaded)

Until this lands, the `coretex-replay` CLI can run against an Anvil/Base RPC but real miners can't fetch challenges from a live coordinator.

### 2.6 No automated corpus-delta publication per epoch

`buildCorpusDelta` / `applyCorpusDelta` exist. There is no cron job that:
- Reads new V3 challenges from the coordinator's S3 since the last epoch
- Bridges them via `bridgeDacrBatch`
- Admits via `admitCorpusBatch`
- Builds a delta with the previous epoch's corpus root
- Publishes via `getCorpusDelta(epoch)` and signs an epoch-rotation manifest

This is the "infinitely expanding corpus" hook. Implementation lives in coordinator-host.

### 2.7 No on-chain correctness guarantee on coordinator's `scoreAfterPpm`

V4 verifies `scoreAfterPpm > scoreBeforePpm` and `delta >= minImprovementPpm`. Both values are **coordinator-attested**. A misbehaving coordinator could sign a fake improvement. Detection paths:
- Replay client (`coretex-replay watch`) re-runs the eval and compares within `replayTolerancePpm`. Replay disagreement is a public fault.
- Bundle hash binds the evaluator code; tampering with the eval code invalidates the bundle hash.
- Economic incentives: slashing on disputes (not yet implemented in V4 — see plan §6 finalize behavior; deferred to ops response).

For paid mainnet, a public watcher running `coretex-replay watch` against every epoch is essential. Document this in the operator runbook.

### 2.8 No rate-limit / DOS test

Phase-11 broadcasts as fast as forge can submit. Real coordinator must rate-limit:
- Per-miner submission velocity (plan §4 explicit)
- Per-coordinator signing velocity (DOS protection)
- Per-evaluator inference rate (CPU/GPU saturation guard)

The current `handleCoreTexCoordinatorRoute` has no rate-limit hook. Suggest adding `authorize?(req): boolean | Promise<boolean>` to `CoreTexCoordinatorDataSource`.

### 2.9 Base fork test is not run

Tooling is in place (`forge` + `anvil --fork-url`). Needs a Base RPC URL with auth, a known V4 deployment to fork against, and a "replay known mainnet receipts" assertion. Phase-12 hook open.

### 2.10 Difficulty calculator is not yet wired into a coordinator job

`packages/cortex/src/rewards/difficulty.ts` implements plan §7 exactly. Nothing calls it on epoch rotation. The coordinator's epoch-end job needs to:
1. Count `OUTCOME_CORETEX_STATE_ADVANCE` receipts in the past epoch (chain query against `WorkCreditAccepted` filtered by `outcome == 2`)
2. Count "elevated non-bogus attempts" (proof: signed eval reports + observed reranker scores within tolerance, even if no submit happened — the coordinator knows this from its own ledger)
3. Pass to `nextMinImprovementPpm`
4. Set new `minImprovementPpm` via `cortexState.initializeEpoch(nextEpoch, ..., next, ...)` for the next epoch

Quality-attempts counter is coordinator-side (it's not reflected in any contract event). Define the source-of-truth before paid mainnet.

## 3. Areas of uncertainty / followup hardening

### 3.1 EIP-712 typehash drift risk

The receipt typehash includes `uint32 scoreBeforePpm,uint32 scoreAfterPpm`. Plan §6 specifies signed int64. If a future contract upgrade widens to `int64`, the off-chain signer + replay decoder MUST update in lockstep. Today the audit showed the contract uses `uint32`; coordinator and replay agree on `uint32`. Document the type explicitly in the bundle manifest.

### 3.2 Patch type → word range invariant is enforced on-chain (good) but not in the JS encoder

`encodePatch` will happily produce a patch with `patchType=KEY_UPDATE` and `indices=[32]` (memory-index range). The contract rejects (`CompactPatchReservedWord`). The bridge / phase-11 always pick correct word indices, but hostile miners can submit incorrect ones. Cleanup: add a `validatePatchType(patchType, indices)` helper in `state/patch.ts` and call it from miners + coordinator pre-signing.

### 3.3 Replay client doesn't gate on bundle hash unless `--bundle-manifest` is passed

`coretex-replay` has `--bundle-manifest <path> --expected-bundle-hash <0x...>` flags but they are optional. Production replay watchers MUST pass them; otherwise a tampered bundle is silently trusted. Document in operator runbook.

### 3.4 The chain's `coreVersionHash` has no formal binding to the bundle hash on-chain

`CortexState.epoch.coreVersionHash` is a coordinator-attested bytes32. Replay verifies the bundle by hashing files locally and comparing to the manifest's `bundleHash`. If the coordinator publishes `coreVersionHash != manifest.bundleHash` for an epoch, the replay client doesn't notice. Suggest:
- Coordinator commits to `coreVersionHash == bundleHash` at epoch init time.
- Replay client asserts `manifest.bundleHash == epoch.coreVersionHash` on read.

### 3.5 Phase-11 uses retrieval-keys slots 0..4 sequentially

After 36 such advances the region is full. Real production needs slot-rotation policy: when a slot is reused, the previous event becomes "evicted" (no longer scored as active). The eval/corpus.ts scorer treats the slot value verbatim — production should add a soft-deletion flag and protected-regression vetoes against evicting protected events.

### 3.6 Forge script overhead dominates phase-11 latency

Each iteration's ~2s is mostly forge subprocess startup. A direct ethers/viem-based JS submitter would be <50ms per iteration. Worth benchmarking the actual coordinator's signing+broadcast path before committing to capacity numbers.

### 3.7 No replay protection at the coordinator level

If a miner submits the same EIP-712-signed receipt twice, V4 catches it via `coretexNextIndex` (replay protection by chained solveIndex). Confirmed via existing forge tests. **However**, if a coordinator signs the same receipt twice for a different miner (different `miner` field but identical `parentRoot`), the second one will fail with `CortexStateRootMismatch` after the first lands. That's correct behavior. Document explicitly.

### 3.8 V4 stake source is in self-mode in phase-11

The phase-11 deploy uses `stakeSource = address(0)` which defaults V4 to self-mode (V3-inheritance). For real production the coordinator must set `stakeSource = mainnet V3 address` so existing miners' V3 stake is honored. The deploy script (`DeployV4Script` at `/root/botcoin/script/DeployV4.s.sol`) already supports this via `EXISTING_V3` env var.

## 4. Concrete next-steps for paid mainnet (handoff list)

| Owner | Item |
|---|---|
| coordinator-host | Mount `handleCoreTexCoordinatorRoute` + provide live `CoreTexCoordinatorDataSource` |
| coordinator-host | Cron: epoch-end → `nextMinImprovementPpm` calculation + commit to next epoch |
| coordinator-host | Cron: epoch-end → corpus delta from new V3 challenges + publish |
| coordinator-host | Rate-limit + DOS guards per plan §12 |
| evaluator-host | Pin `Qwen/Qwen3-Reranker-0.6B` revision + per-file SHA-256 in bundle manifest |
| evaluator-host | Calibrate reranker threshold + replayTolerancePpm against held-out CortexBench shard |
| ops | Run `coretex-replay watch` against every epoch, alert on replay disagreement |
| ops | Run Base fork rehearsal + replay known-mainnet-precursor receipts |
| ops | Document EIP-712 typehash + `coreVersionHash == bundleHash` invariants |
| corpus-builder | Bridge sessions + bookend pairs from DACR-LT-Training |
| corpus-builder | Cross-miner distractor mining for sparse-trap domains |
| ops | Slot-eviction / protected-regression policy for substrate region rotation |

## 5. Repro & verification commands

```bash
# Build everything
cd /root/cortex && npm run build --workspace @botcoin/cortex
cd /root/botcoin && forge build

# Build a real production corpus from DACR-LT-Training
cd /root/cortex && \
  HF_ACCESS_TOKEN=$(grep ^HF_ACCESS_TOKEN /root/botcoin/.env | cut -d= -f2) \
  node scripts/build-corpus-from-dacr.mjs \
    --domain quantum_physics,companies \
    --max-attempts 1500 --max-pairs 200 \
    --epoch 1 --policy-min-distractors 2

# Run the unit suite
cd /root/cortex && npm run test:unit --workspace @botcoin/cortex
# expect 254+ passing tests, 0 failures

# Run the live full-flow Anvil e2e (single iteration)
cd /root/cortex && node test/e2e/phase-10/run.mjs

# Run the multi-iteration live miner loop (N=5)
cd /root/cortex && node test/e2e/phase-11/run.mjs

# Optional: run with the real MiniLM cross-encoder
CORETEX_RERANKER=minilm node test/e2e/phase-11/run.mjs

# Optional (heavy): run with real Qwen3-Reranker-0.6B (downloads ~1.2GB on first run)
CORETEX_RERANKER=qwen3 node test/e2e/phase-11/run.mjs
```

## 6. Files of record (for the auditor)

- Plan: `/root/botcoin/CORETEX_V4_PRODUCTION_PLAN.md`
- Substrate spec: `/root/cortex/specs/{cortex_state_v0,packing_spec_v0,merkleization_spec_v0,patch_format_v0}.md`
- Coordinator → CoreTex bridge spec: **THIS REPO** `/root/cortex/specs/corpus_bridge_v0.md`
- Bridge code: `/root/cortex/packages/cortex/src/corpus/dacr-bridge.ts`
- Corpus builder: `/root/cortex/scripts/build-corpus-from-dacr.mjs`
- Reranker (real Qwen3 + MiniLM + deterministic): `/root/cortex/packages/cortex/src/eval/reranker.ts`
- Difficulty (plan §7): `/root/cortex/packages/cortex/src/rewards/difficulty.ts`
- Live phase-10 e2e: `/root/cortex/test/e2e/phase-10/run.mjs`
- Live phase-11 multi-iteration miner loop: `/root/cortex/test/e2e/phase-11/run.mjs`
- Forge scripts: `/root/botcoin/script/CoreTexE2EFlow.s.sol`, `/root/botcoin/script/CoreTexAdditionalAdvance.s.sol`
- Round-2 ongoing audit notes: `/root/cortex/ongoing_audit.md`
- Round-2 context: `/root/cortex/context.md`

The session-2 commits on `main` (cortex repo, pushed to private remote at https://github.com/botcoinmoney/cortex.git):

```
34d0e3d coretex: add qwen3 reranker eval path
7b45fd8 coretex: add difficulty calculator per plan §7
a5c3d17 coretex: add §9 corpus pipeline + V3 bridge
3693ba9 coretex: add phase-10 anvil full-flow e2e
ce43c84 coretex: handoff notes for production-extension round 2
(this round): coretex: add DACR HF bridge + phase-11 multi-iteration loop
```

The /root/botcoin commits (local-only, no remote configured):

```
c1bcada coretex: add e2e flow forge script
(this round): coretex: add additional-advance forge script
```
