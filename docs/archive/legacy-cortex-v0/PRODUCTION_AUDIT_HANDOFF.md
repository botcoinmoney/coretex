# CoreTex v4 Production Audit Handoff

**Status:** production-hardening closure applied; historical findings below retained for audit traceability.
**Author:** orchestrator round-2.
**Date:** 2026-05-09.

This document surfaces every gap, quirk, and area of uncertainty that came up during the round-2 production-extension work. Read it before signing off on a paid mainnet launch.

## 0. 2026-05-09 Closure Addendum

The blocker list in section 2 is historical. The production-hardening pass closed it in these commits:

- `d2830bd coretex: enforce production provenance gates`
- `e1dfa5d coretex: complete DACR corpus rotation and reranker gates`

Closure summary:

- Qwen3-Reranker-0.6B is pinned to Hugging Face commit `e61197ed45024b0ed8a2d74b80b4d909f1255473` with per-file SHA-256 and byte counts in the default bundle manifest.
- Bundle validation rejects mutable refs/placeholders and requires a 40-hex Qwen3 revision.
- `coretex-replay watch` now requires `--bundle-manifest` and `--expected-bundle-hash` or `--core-version-hash` unless `--allow-unverified-bundle` is explicitly passed.
- `encodePatch`, `applyPatch`, and `applyPatchOntoCurrent` reject patch type/index mismatches client-side.
- DACR bridge now does cross-miner distractor mining, per-question family override, session trajectory bridging, and bookend pair bridging.
- Corpus deltas include `addedRecords`; `applyCorpusDelta` no longer relies on pre-merged additions.
- Epoch rotation manifests bind delta/challenge-book/bundle/difficulty observations and can be signed/verified.
- `scripts/build-corpus-delta-from-dacr.mjs` is the cron entrypoint for per-epoch DACR ingestion and manifest publication.
- `cortex-server` real eval path uses `evaluatePatchWithReranker`, enforces corpus-root match, optional expected bundle-hash match, and refuses passes below threshold.
- `createQwen3Reranker` runs the native Python Hugging Face `transformers`/`torch` path for Qwen3-Reranker-0.6B; a pinned-model smoke passed on 2026-05-09 with relevant score higher than unrelated score.
- Phase-11 gates every iteration on reranker score.
- `CoreTexCoordinatorDataSource` has `authorize` and `rateLimit` hooks.
- `/root/botcoin-coordinator-live` has the reference `/coretex/*` mount and env contract in `packages/coordinator/src/coretex-live.ts`, `server.ts`, and `.env.example`.
- `selectSubstrateSlot` defines deterministic substrate-region rotation with protected-slot skip/fail-closed behavior and is used by phase-11.

Detailed context for future agents is in `docs/CORETEX_V4_PRODUCTION_CONTEXT.md`.

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

## 2. Historical blocker list, now closed

The subsections below are retained as the original audit trail. They no longer describe open CoreTex implementation gaps after the closure commits listed above.

### 2.1 Reranker production path and gate

Resolved. Production mode refuses deterministic rerankers, the Qwen3 path uses the pinned default revision, `cortex-server` enforces the reranker threshold, and phase-11 gates before submission.

### 2.2 Bundle manifest provenance

Resolved. The default Qwen3 manifest pins commit `e61197ed45024b0ed8a2d74b80b4d909f1255473`, includes per-file SHA-256/byte metadata, and validation rejects mutable or placeholder revisions.

### 2.3 Sparse-domain distractor mining

Resolved. `bridgeDacrBatch` mines cross-miner wrong answers. Sparse-domain validation for `computational_biology,scrna_imputation` admitted 10,293 records with 0 `insufficient_distractors` rejections.

### 2.4 Sessions and bookend pairs

Resolved. `bridgeDacrSession` emits long-horizon multi-step events and `bridgeDacrBookendPair` emits current/stale temporal pairs. The DACR build script ingests both categories.

### 2.5 Coordinator endpoint wiring

Resolved in the cloned host repo. `/root/botcoin-coordinator-live` has an additive `/coretex/*` mount, bearer auth, per-IP rate limiting, artifact-backed fetch routes, evaluator proxying, and an `.env.example` contract for EC2 deployment.

### 2.6 Corpus-delta publication per epoch

Resolved. `scripts/build-corpus-delta-from-dacr.mjs` produces self-contained `CorpusDelta` artifacts and signed epoch-rotation manifests with next-epoch difficulty.

### 2.7 Coordinator-attested `scoreAfterPpm` trust model

Resolved at the CoreTex/replay layer. `coretex-replay watch` now requires a verified bundle manifest and expected bundle/core-version hash by default; bundle hash binds the evaluator code, corpus bridge, replay code, coordinator route contract, and slot policy.

### 2.8 Rate-limit / DOS hooks

Resolved. `CoreTexCoordinatorDataSource` exposes `authorize` and `rateLimit`; unit coverage verifies denial behavior, and the live clone mount includes a per-IP minute limiter.

### 2.9 Base fork rehearsal

Resolved for the available fork suite. `forge test --root contracts --match-path test/CortexFork.t.sol -vv` passed 6 Base-fork tests with 0 failures.

### 2.10 Difficulty calculator epoch wiring

Resolved. `buildEpochRotationManifest` calls `nextMinImprovementPpm` from observed advances and quality attempts, and the delta cron script emits the signed next-epoch value.

## 3. Hardening items resolved or operationalized

### 3.1 EIP-712 typehash drift risk

Resolved. The bundle evaluator profile now explicitly documents `scorePpmEncoding: uint32-0-to-1000000` and `patchScoreDeltaEncoding: int64-ppm`.

### 3.2 Patch type → word range invariant is enforced on-chain (good) but not in the JS encoder

Resolved. `validatePatchType` is called by `encodePatch`, `applyPatch`, and `applyPatchOntoCurrent`; unit tests cover client-side rejection.

### 3.3 Replay client doesn't gate on bundle hash unless `--bundle-manifest` is passed

Resolved. `coretex-replay watch` requires `--bundle-manifest` and an expected bundle/core-version hash unless `--allow-unverified-bundle` is explicitly passed.

### 3.4 The chain's `coreVersionHash` has no formal binding to the bundle hash on-chain

Resolved at the coordinator/evaluator boundary. The live clone env contract includes `CORETEX_EXPECTED_BUNDLE_HASH`, client bundle fetches enforce the expected hash, and `cortex-server` can reject evaluator submissions whose `coreVersionHash` does not match.

### 3.5 Substrate slot rotation

Resolved. `selectSubstrateSlot` rotates retrieval-key slots after 36 advances and memory-index slots after 44 advances, skips protected slots, and fails closed if no writable slot remains. Phase-11 uses the policy.

### 3.6 Forge script overhead dominates phase-11 latency

Operationalized. Phase-11 remains a correctness harness, not the coordinator capacity benchmark. The live coordinator reference mount proxies/evaluates directly; production signing should use the coordinator's normal direct signer path.

### 3.7 No replay protection at the coordinator level

If a miner submits the same EIP-712-signed receipt twice, V4 catches it via `coretexNextIndex` (replay protection by chained solveIndex). Confirmed via existing forge tests. **However**, if a coordinator signs the same receipt twice for a different miner (different `miner` field but identical `parentRoot`), the second one will fail with `CortexStateRootMismatch` after the first lands. That's correct behavior. Document explicitly.

### 3.8 V4 stake source is in self-mode in phase-11

The phase-11 deploy uses `stakeSource = address(0)` which defaults V4 to self-mode (V3-inheritance). For real production the coordinator must set `stakeSource = mainnet V3 address` so existing miners' V3 stake is honored. The deploy script (`DeployV4Script` at `/root/botcoin/script/DeployV4.s.sol`) already supports this via `EXISTING_V3` env var.

## 4. Operator activation checklist

| Owner | Item |
|---|---|
| coordinator-host | Deploy the `/root/botcoin-coordinator-live` `/coretex/*` mount to the actual EC2 coordinator and set the env contract from `.env.example` |
| coordinator-host | Schedule `scripts/build-corpus-delta-from-dacr.mjs` at epoch rotation and publish the generated corpus delta / challenge book / signed manifest artifacts |
| evaluator-host | Run `CORTEX_REAL_EVAL=1 CORETEX_RERANKER=qwen3` with the pinned Qwen3 revision and the expected bundle hash |
| ops | Run `coretex-replay watch` for every epoch with `--bundle-manifest` and `--expected-bundle-hash` |
| ops | Keep Base fork rehearsal in release CI using the authenticated `BASE_RPC_URL` |

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
# expect 275+ passing tests, 0 failures

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
