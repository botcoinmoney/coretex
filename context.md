# CoreTex Context

The previous CoreTex context file is superseded.

Current production planning authority:

```text
/root/botcoin/CORETEX_V4_PRODUCTION_PLAN.md
```

Current substrate authority remains in this repo's specs and reference implementations:

- `docs/state-spec.md`
- `specs/cortex_state.md`
- `specs/cortex_schema.json`
- `specs/packing_spec.md`
- `specs/merkleization_spec.md`
- `specs/patch_format.md`
- `packages/cortex/src/state/`
- `packages/cortex-py/cortex_py/`

Old audit-window, multisig, merge-bonus, sidecar, and handoff text is historical only. Do not use it to override the v4 production plan.

Current execution posture:

- run the 0.6B memory evaluator locally for development/testing
- use `/root/botcoin-coordinator-live` as the local coordinator clone
- wire coordinator integration additively
- prove production readiness through local Anvil, Base fork, local coordinator, local model, client-bundle replay, and negative-control tests
- commit and push coherent checkpoints to `https://github.com/botcoinmoney/cortex.git`
- treat every commit as future-public: no secrets, no private data, no unlicensed datasets
- prefer CoreTex in product/docs language; retain lowercase `cortex` only for actual paths/packages/identifiers

## Recent Implementation Notes

2026-05-08:

- Added the CoreTex client-bundle manifest module in `packages/cortex/src/bundle/`.
- Added `botcoin-cortex bundle-manifest build|verify` with corpus, snapshot, evaluator, substrate, and pinned model hash validation.
- Added `coretex-replay` with `tx`, `current`, and polling `watch` modes over V4 `CoretexPatchBytes` and `CortexStateAdvanced` logs.
- Replay now checks compact patch bytes against `patchHash`, parent state root, applied new root, 32 KB packed-state snapshots, and ordered multi-transition batches.
- Added unit coverage for bundle manifests, replay tamper failures, and multi-transition replay.
- Fixed the package unit-test script glob so `npm run test:unit --workspace @botcoin/cortex` executes the full unit suite.
- Added `ProductionCorpusLoader` in `packages/cortex/src/eval/corpus.ts` for deterministic raw-state scoring against the pinned Season 1 corpus shape.
- `botcoin-cortex eval` can now use `--corpus-file` and `--eval-items-per-family`; the previous stub loader remains available for compatibility.
- Season 1 corpus loading verifies the embedded SHA-256 and `experience_corpus_root`, then scores shard-selected near-collision, temporal, long-horizon, and routing signals.
- Added `packages/cortex/src/coordinator/endpoints.ts`, a small raw-HTTP-friendly contract for additive `/coretex/*` coordinator routes.
- The coordinator endpoint contract covers screen/evaluate, substrate, patch, eval-report, challenge-book, corpus-delta, client-bundle, and health routes while explicitly ignoring `/v1/challenge`.

Latest local checks for this slice:

```text
npm run build --workspace @botcoin/cortex
npm run test:unit --workspace @botcoin/cortex
```

Both passed after the replay/bundle slice; unit suite was 181 passing tests at that checkpoint.
They also passed after the production corpus loader slice; unit suite was 184 passing tests at that checkpoint.
They also passed after the coordinator endpoint contract slice; unit suite was 188 passing tests at that checkpoint.

2026-05-08 final hardening notes:

- Reconciled the production corpus scorer with the launch bundle profile: 20% near-collision retrieval, 20% temporal current/stale, 20% long-horizon compression, 20% relation/multi-hop routing, 10% codebook compression, 10% local model agreement proxy.
- Added a unit guard proving a complete structural state scores 1.0 under that 20/20/20/20/10/10 profile.
- Fixed `test/e2e/phase-4/run.mjs` for pure ESM execution by removing a stale inline `require`.
- Added optional `coretex-replay --bundle-manifest ... --expected-bundle-hash ...` verification so replay can assert the installed bundle hash against on-chain `coreVersionHash`/policy metadata before processing events.
- Full e2e was run with Node 22.22.2 via `npx -y node@22 scripts/run-e2e.mjs`; phases 1 through 9 passed, with environment-gated network/mainnet tests skipped where required env vars were absent.

2026-05-09 production-extension slices (orchestrator handoff round 2):

Closed five gaps the auditor flagged against plan §13. Each slice
landed as a separate commit (see `git log --oneline`).

1. **Real Qwen3-Reranker-0.6B reward-law evaluator** —
   `packages/cortex/src/eval/reranker.ts` and `reranker-eval.ts`.
   `createQwen3Reranker` loads `Qwen/Qwen3-Reranker-0.6B` via
   `@huggingface/transformers` (`AutoModelForCausalLM` +
   `AutoTokenizer`), formats the Qwen3 IM chat template, and
   computes `sigmoid(logit[yes] − logit[no])` over the final
   position. `createMiniLMReranker` wraps
   `Xenova/ms-marco-MiniLM-L-6-v2` for fast tests.
   `createDeterministicReranker` is a pure-hashing stub for CI.
   `rerankerFromEnv()` selects via `CORETEX_RERANKER`.
   `evaluatePatchWithReranker` mirrors the patch-eval contract
   and weights families 20/20/20/20/10/10 per plan §9. Bundle
   manifest's `qwen3Reranker06BManifest()` accepts a pinned
   `revision`.

2. **Difficulty calculator (plan §7)** —
   `packages/cortex/src/rewards/difficulty.ts`.
   `nextMinImprovementPpm()` with five branches, bigint-safe
   ratios, clamped to `[2_500n, 150_000n]`. Plus
   `difficultyHistogram()` for sweeps.

3. **§9 corpus pipeline + V3-to-V4 bridge** —
   `packages/cortex/src/corpus/v3-bridge.ts`, `admission.ts`,
   `delta.ts`. `bridgeV3ToV4` reshapes a V3 challenge into the
   §9 record schema (distractors, relations,
   expected_state_regions, hardness_signal, novelty_bucket).
   `admitCorpusBatch` enforces six rules. `buildCorpusDelta` /
   `applyCorpusDelta` give recurrent corpus root publication
   with hash continuity. Backward compatible — Season 1 still
   loads with safe defaults.

4. **Live Anvil full-flow E2E (plan §13 scenarios 2-5,8)** —
   `test/e2e/phase-10/run.mjs` (here) +
   `/root/botcoin/script/CoreTexE2EFlow.s.sol`. Real chain, real
   contracts, real submissions. Spawns `anvil`, runs `forge
   build` + `forge script CoreTexE2EFlow --broadcast`, deploys
   `MockERC20` + `CortexState` + `BotcoinMiningV4`, inits +
   freezes a CortexState epoch with a precomputed JS-merkleized
   parent root, mints + stakes 10M botcoin, submits a SCREENER
   receipt (asserts state unchanged + credits earned), submits
   a STATE_ADVANCE receipt with a real KEY_UPDATE compact patch
   at word 384 (EIP-712 signed via `vm.sign`), then queries
   chain to assert `CortexState.stateRoot` advanced to the
   precomputed `newStateRoot` and `transitionCount == 1`. The
   JS replay client then runs `replayV4TransitionsFromLogs`
   against the chain logs and asserts
   `reproducedStateRoot === newStateRoot` and `scoreDeltaPpm`
   matches. Two `WorkCreditAccepted` events are observed.

   This is the first non-simulated full mining loop end to end:
   deploy → stake → screener → state advance → replay
   reproduction. Run with `node test/e2e/phase-10/run.mjs`.
   Auto-discovered by `scripts/run-e2e.mjs`.

5. **(via this slice)** the existing route shim at
   `packages/cortex/src/coordinator/endpoints.ts` is unchanged
   but referenced — wiring it into the live coordinator host
   remains a separate, host-side integration step (see
   "outstanding" below).

Post-slice verification:

```text
cd /root/cortex
npm run build --workspace @botcoin/cortex                  # exit 0
npm run test:unit --workspace @botcoin/cortex              # 254+ tests, 0 failures
node test/e2e/phase-10/run.mjs                             # PASS — live Anvil e2e
```

### Known outstanding work (NOT closed in this round)

- **Live `/root/botcoin-coordinator-live` integration.** The
  route shim + endpoint contract test live in this repo, but the
  production coordinator host has not been patched. Plan §12
  wiring needs the host operator to mount
  `handleCoreTexCoordinatorRoute` and provide a
  `CoreTexCoordinatorDataSource` backed by the live evaluator,
  corpus loader, and bundle manifest store. Routes are additive
  — existing V3 endpoints stay unchanged.

- **Pinned production Qwen3-Reranker-0.6B revision + file hashes.**
  `qwen3Reranker06BManifest()` defaults the revision to a
  placeholder. Production deployments must override with the
  real upstream commit + per-file SHA-256 from the pinned
  HF snapshot. Validation already rejects `revision === 'main'`.

- **Production corpus volume.** Season 1 (10k synthetic) + ~150
  real-source records is what's checked in. Plan §9 wants ≥10k
  records with the §9 distribution before paid mainnet epochs.
  The V3 bridge + admission filters now exist; populating them
  requires access to the V3 challenge archive (coordinator-side).

- **Base fork rehearsal.** Tooling is in place; needs a Base RPC
  URL with auth. Phase-12 hook open.

These four are explicit handoff items. The CoreTex substrate,
replay, evaluator, difficulty, reward law, and one full live-chain
mining cycle are now self-consistent end to end.
