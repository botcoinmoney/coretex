# CoreTex V4 — Per-Patch On-Chain Randomness Hardening Plan

Last updated: 2026-05-11.

Status: pre-launch refinement. **Supersedes** `docs/CORETEX_SEALED_EPOCH_EVAL_HARDENING_PLAN.md` (S0–S6). Coexists with `docs/CORETEX_V4_INDEFINITE_SCALABILITY_HARDENING_PLAN.md` (H1–H3) — different axes (eval-seed unforgeability vs corpus-growth scaling), no overlap.

Audience: calibration / coordinator implementation agent.

## Executive Decision

The auditor's diagnosis stands: **a live `POST /coretex/evaluate` oracle is unsafe if the coordinator can pre-test patches**. Two architectural responses were viable:

1. **Sealed evaluation** (S0–S6): kill the live oracle; commit/reveal flow; per-epoch sealed pack scored after commit close.
2. **Per-patch on-chain randomness**: keep the live oracle; bind each patch's eval seed to a future Base blockhash the coordinator can't observe at receive time.

**Production picks #2.** Rationale:

- Coordinator pre-testing is structurally impossible: at patch-receive time, `blockhash(receivedAtBlock + 30)` does not exist yet on Base; the coordinator cannot know which queries the pack will contain even with full read access to its own database.
- Anti-probing is preserved by per-patch pack uniqueness + duplicate-key caching: each patch derives its own pack from `(patchHash, parentRoot, minerAddress, blockhash, epochSecret, ...)`. Submitting the same patch twice returns the cached verdict (no re-roll). Submitting a different patch produces a different pack.
- Implementation footprint is ~5× smaller than sealed-eval and the audit story is simpler: "anyone can re-derive the seed from public chain data + the post-epoch epochSecret reveal."
- Trust assumption is bounded and auditable: coordinator acts in good faith with `epochSecret` (multisig escrow, committed on-chain at epoch start, revealed at close). Any deviation is detectable by replay watchers.

## Non-Negotiable Invariants

- The coordinator cannot compute any patch's eval seed at the moment that patch is submitted.
- The miner cannot compute any other patch's eval seed (per-patch binding).
- A reveal of the epoch secret lets any third-party reproduce every accepted state advance from public chain data alone.
- The same `(parentRoot, patchBytes)` cannot be evaluated twice — first verdict is cached and returned forever (anti-probing via repeat submission).
- All replay verification runs CPU-only with the bundle's pinned models.

## Seed Formula

```text
evalSeed_patch = keccak256(
  "coretex-eval-v1",      # domain prefix
  epochSecret,            # 32 bytes, committed at epoch start
  blockhash(targetBlock), # 32 bytes, targetBlock = receivedAtBlock + targetBlockOffset
  uint64(epochId),
  patchHash,              # keccak256(normalized patchBytes)
  parentRoot,             # 32 bytes
  minerAddress,           # 20 bytes
  corpusRoot,             # 32 bytes
  bundleHash              # 32 bytes
)
```

Where:

- `targetBlockOffset = 30` (≈ 60 seconds on Base at 2s block time). Pinned in `EvaluatorProfile.baseRpcConfig`. Aligned with the per-miner challenge-submit rate limit (1/minute) — naturally gates submission cadence to match.
- `epochSecret` is committed at epoch start via `CortexState.initializeEpoch(...evalSeedCommit...)` and revealed at epoch close via `revealEvalSeed`. Held in multisig escrow.
- `receivedAtBlock` is the Base block number observed by the coordinator when the patch HTTP request entered the queue. Recorded in the signed receipt; replay watchers cross-check against a per-receipt published submission relay (see §"Receipt honesty").

## Architectural Changes

### Rip (sealed-eval supersession)

**Deleted modules:**
- `packages/cortex/src/coordinator/sealed-eval.ts`
- `packages/cortex/src/coordinator/sealed-eval-orchestration.ts`
- `packages/cortex/src/coordinator/sealed-eval-guard.ts` (if extracted)
- Endpoint handlers for `POST /coretex/commit`, `POST /coretex/reveal`, `GET /coretex/commit/:hash`, `GET /coretex/epoch/:id/status`

**Deleted tests** (6 files, ~440 LOC):
- `test/unit/sealed-eval-commitment.test.mjs`
- `test/unit/sealed-eval-guard.test.mjs`
- `test/unit/sealed-eval-lifecycle.test.mjs`
- `test/unit/sealed-eval-orchestration.test.mjs`
- `test/unit/sealed-eval-randomness.test.mjs`
- `test/unit/sealed-eval-screener-admission.test.mjs`
- `test/unit/sealed-eval-full-session.test.mjs`
- `test/unit/sealed-eval-pack-retirement.test.mjs`

**Survives the rip:** the screener-admission concept (duplicate-key collapse + per-miner cap). Moved to `packages/cortex/src/eval/live-eval-admission.ts` and adapted for the live-eval flow.

### Add

**`packages/cortex/src/eval/seed-derivation.ts`** (new, pure)

```ts
export const EVAL_SEED_DOMAIN_PREFIX = 'coretex-eval-v1';

export interface EvalSeedInput {
  readonly epochSecret: string;       // bytes32 hex
  readonly blockhash: string;         // bytes32 hex
  readonly epochId: bigint | number;
  readonly patchHash: string;         // bytes32 hex
  readonly parentRoot: string;        // bytes32 hex
  readonly minerAddress: string;      // bytes20 hex
  readonly corpusRoot: string;        // bytes32 hex
  readonly bundleHash: string;        // bytes32 hex
}

export function deriveEvalSeed(input: EvalSeedInput): string; // 0x + 64 hex
export function computePatchHash(patchBytes: Uint8Array): string;
export function computeDedupKey(parentRoot: string, normalizedPatchBytes: Uint8Array): string;
```

Pure hashing only. No I/O, no model loads. Same shape as `sealed-eval.ts`'s primitives but per-patch.

**`packages/cortex/src/coordinator/base-blockhash.ts`** (new, thin RPC client)

```ts
export interface BaseRpcClient {
  getLatestBlockNumber(): Promise<number>;
  getBlockHash(blockNumber: number): Promise<string>;
  waitForBlock(blockNumber: number, timeoutMs: number): Promise<{ blockhash: string; timestamp: number }>;
}

export function createBaseRpcClient(rpcUrl: string, opts?: { timeoutMs?: number }): BaseRpcClient;
```

JSON-RPC over fetch. `waitForBlock` polls `eth_blockNumber` every 1s until target reached, then fetches `eth_getBlockByNumber`. Used by coordinator AND replay watchers — same code path on both sides.

**`packages/cortex/src/eval/live-eval-admission.ts`** (extracted from sealed-eval.ts)

Re-exports `screenerAdmissionDecision` adapted: replaces `commitmentHash` with `patchHash`, `admittedDuplicateKeysThisEpoch` with `dedupCache: Map<string, EvalReport>`. Same three rules (structural, dedup, per-miner cap) preserved.

**`packages/cortex/src/replay/v4.ts`** (extended)

`replayV4TransitionFromLogs` now requires `rpcUrl` + post-reveal `epochSecret`. For each accepted state advance:
1. Read receipt; pull `targetBlock`, `blockhash`, `evalSeed`, `patchHash`, `dedupKey`.
2. Assert `getBlockHash(rpcUrl, targetBlock) === blockhash` (chain-state agreement).
3. Recompute `evalSeed` via `deriveEvalSeed`; assert equals receipt's `evalSeed`.
4. Recompute pack via `deriveQueryPack(evalSeed, corpus, hiddenPackProfile)`; assert pack ids match receipt.
5. Re-run BGE-M3 + Qwen3 on CPU; assert `|coordinatorScore - replayScore| ≤ replayTolerancePpm`.

### Modify

**`packages/cortex/src/eval/hidden-query-pack.ts`**

- `deriveQueryPack(evalSeedPatch, corpus, profile)` signature: drop `epochId` (already in `evalSeedPatch`).
- `verifyQueryPack` adapts the same way.
- Internal `digestU256` sampling loop unchanged.

**`packages/cortex/src/eval/retrieval-benchmark.ts`**

- `evaluateRetrievalBenchmarkPatch` signature unchanged.
- Callers now build a per-patch `QueryPack` per `evaluateRetrievalBenchmarkPatch` invocation instead of sharing one pack across patches.

**`packages/cortex-server/src/real-evaluator.ts`**

Per-patch flow (sync variant):
```
1. POST /coretex/evaluate { patch, parentRoot, minerAddress }
2. patchHash = computePatchHash(normalizedPatchBytes)
3. dedupKey = computeDedupKey(parentRoot, normalizedPatchBytes)
4. if (dedupCache.has(dedupKey)) return dedupCache.get(dedupKey)
5. receivedAtBlock = await rpc.getLatestBlockNumber()
6. targetBlock = receivedAtBlock + 30
7. { blockhash } = await rpc.waitForBlock(targetBlock, timeoutMs=120_000)
8. evalSeed = deriveEvalSeed({ epochSecret, blockhash, epochId, patchHash,
                              parentRoot, minerAddress, corpusRoot, bundleHash })
9. pack = deriveQueryPack(evalSeed, corpus, hiddenPackProfile)
10. result = await evaluateRetrievalBenchmarkPatch(parentState, patch, corpus, pack, scoringOpts, floors)
11. receipt = signEvalReport({ ...result, receivedAtBlock, targetBlock, blockhash, evalSeed, patchHash, dedupKey })
12. dedupCache.set(dedupKey, receipt); return receipt
```

Async variant: step 1 returns `{ status:'pending', patchHash, targetBlock }` immediately; coordinator continues steps 5–12 in background; GET `/coretex/result/:patchHash` polls until `dedupCache.has(...)`. Both endpoints ship in the same PR.

**`packages/cortex/src/coordinator/retrieval-data-source.ts`**

- Remove `sealedHiddenEval` option entirely (default behavior is now live + per-patch-bound).
- `evaluate` callback still wired into route shim; implementation now does the lock-then-eval flow internally.
- Add `result` callback for `GET /coretex/result/:patchHash` polling.

**`packages/cortex/src/bundle/index.ts` — `EvaluatorProfile`**

Additions:
- `baseRpcConfig: { chainId: 8453, blockTimeSeconds: 2, targetBlockOffset: 30 }`
- `replayBlockhashLookbackBlocks: 50000` (~28h coverage at 2s blocks; replay grace + 24h epoch)

Removals (sealed-eval residue):
- Any `sealedHiddenEval`, `commitWindowSeconds`, drand-related fields.

`revealGracePeriodSeconds` stays — epoch-secret reveal mechanism still required.

**Contracts:** **no changes.** `CortexState.initializeEpoch` already accepts `evalSeedCommit`. `revealEvalSeed` already exists. Receipts already commit to `evalReportHash` which carries `(targetBlock, blockhash, evalSeed, patchHash, dedupKey)`.

## Receipt Honesty (the one piece that isn't on-chain)

`receivedAtBlock` is the only seed input the coordinator picks unilaterally. A dishonest coordinator could delay processing to wait for a favorable future blockhash. Mitigation requires public observability of submission timing:

**Submission relay:** the coordinator publishes a signed `PatchReceivedNotice { patchHash, receivedAtBlock, timestamp }` to a publicly-readable channel within the same Base block as `receivedAtBlock`. Options, in order of preference:

1. **CortexState event log** — extend the contract to emit `event PatchReceived(bytes32 patchHash, uint64 receivedAtBlock)` callable by the coordinator's signing key. Replay watchers compare the receipt's `receivedAtBlock` against the on-chain event's block number. Mismatch → invalid receipt. **Requires contract change** (the only place this plan touches contracts).
2. **Coordinator notice log** — coordinator writes notices to a public S3-replicated append-only log; watchers poll. No contract change but weaker trust (coordinator could rewrite logs retroactively).

**Recommendation:** ship with #2 for launch (low contract risk, fast iteration), upgrade to #1 in a post-launch contract patch. Document this as an explicit trust degradation in the runbook.

## Per-Patch Pack Cost

Per-patch packs are id-only — pack derivation samples query ids from the corpus's `eval_hidden` split. The bi-encoder embeddings for those ids are already attached to the corpus payload (per the v4 corpus format pinned in the bundle). **No new BGE-M3 forward passes per patch.** Only `evaluateRetrievalBenchmarkPatch` runs BGE-M3 + Qwen3, same as today.

## Calibration-Flow Integration

Modifies `scripts/orchestrate-cpu-calibration.sh`. New step numbering after rip + adds:

| # | Step | Source |
|---|---|---|
| 1 | validate corpus shape | (unchanged) |
| 2 | build determinism fixture | (unchanged) |
| 3 | **seed-derivation golden vectors** | **NEW** — runs `test/unit/seed-derivation.test.mjs` standalone; asserts 100% byte-identical output for 1000 random inputs. Fast (<1s), gates everything downstream. |
| 4 | determinism check (3 hosts) | (unchanged — BGE-M3 + Qwen3 score determinism) |
| 5 | aggregate determinism | (unchanged) |
| 6 | calibrate bundle profile | (unchanged) |
| 7 | build initial bundle manifest | **MODIFIED** — `build-coretex-bundle.mjs` now pins `baseRpcConfig`, `targetBlockOffset=30`, `replayBlockhashLookbackBlocks=50000` into `EvaluatorProfile`. |
| 8 | pin baselineParentScorePpm + variancePpm | (unchanged) |
| 9 | **per-patch QueryPack determinism check** | **NEW** — `scripts/check-per-patch-pack-determinism.mjs --bundle <bundle> --corpus <corpus> --patches 50`. Derives 50 distinct synthetic patches, derives each patch's seed + pack 3× independently, asserts byte-identical pack ids. Gate: 100% reproduction. |
| 10 | Phase 13 e2e against real models | **MODIFIED** — mining loop now: (a) each iteration runs against `MockBaseRpcServer` with deterministic blockhash schedule (committed test fixture); (b) per-patch eval-seed derivation runs through the new module; (c) after N=5 iterations, mock `revealEvalSeed`; (d) replay watcher re-derives every per-patch seed, re-builds packs, re-scores, asserts within `replayTolerancePpm`. Adversarial sub-test: replay with wrong epochSecret → all signatures fail. |
| 11 | offline corpus auditor | (unchanged) |
| 12 | **Base RPC connectivity smoke** | **NEW** — `scripts/verify-base-rpc.mjs --rpc-url $BASE_RPC_URL --lookback 50000`. Calls `eth_blockNumber` + `eth_getBlockByNumber` for a 28h-old block. Asserts both succeed. Documents the chosen RPC tier in `reports/base-rpc-tier.json`. |
| 13 | summary | (unchanged) |

## Testing Checkpoints (eval passes required post-corpus)

Numbered to match the calibration-flow steps above. Each is a hard gate — must be green before the next runs.

1. **Seed-derivation determinism** (step 3)
   - Golden vector: 10 hand-picked input tuples → known bytes32 outputs (committed to repo as `test/fixtures/seed-derivation-golden.json`)
   - Random property test: 1000 random `EvalSeedInput`s × 3 runs each, all byte-identical
   - Cross-platform property test: same 1000 inputs hashed via Node's `crypto.createHash` AND via the `keccak256` import; outputs identical
   - **Pass criterion:** 100% reproduction, no exceptions.

2. **Per-patch QueryPack determinism** (step 9)
   - Synthesize 50 distinct `(patchHash, parentRoot, minerAddress)` triples
   - For each, derive seed + pack 3 times via independent invocations
   - Assert all 3 packs are id-identical for each triple
   - Assert no two triples produce the same pack (collision check)
   - **Pass criterion:** 150 derivations, 150 byte-identical reproductions, 0 collisions across 50 triples.

3. **Phase 13 e2e with per-patch packs** (step 10)
   - N=5 mining iterations
   - Each iteration: submit patch → mock RPC advances 30 blocks → coordinator derives seed + scores → signs receipt
   - After iterations: mock `revealEvalSeed`
   - Replay watcher: for each receipt, recompute seed, rebuild pack, rescore, assert `|coordinatorScore - replayScore| ≤ replayTolerancePpm`
   - **Pass criterion:** all 5 receipts reproduce within tolerance; replay finishes within 5 × per-patch eval budget.

4. **Phase 13 adversarial sub-test** (step 10)
   - Same flow but replay watcher is given a different `epochSecret`
   - Every signature verification must fail
   - **Pass criterion:** 5/5 receipt signatures rejected.

5. **Base RPC connectivity** (step 12)
   - `eth_blockNumber` returns a number > 0
   - `eth_getBlockByNumber(latest - 50000)` returns a valid block with non-zero hash
   - **Pass criterion:** both calls succeed within 10s.

6. **Dedup cache fidelity** (separate unit test, runs in standard test suite)
   - Submit the same `(parentRoot, patchBytes)` 100 times
   - First call invokes the full eval pipeline; calls 2–100 return cached receipt with `<1ms` latency
   - **Pass criterion:** 1 cache miss, 99 cache hits, all 100 receipts byte-identical.

7. **Async variant end-to-end** (separate integration test)
   - POST `/coretex/evaluate` returns `{ status:'pending', patchHash, targetBlock }` within 100ms
   - GET `/coretex/result/:patchHash` returns 202 while pending
   - GET returns 200 + full receipt after targetBlock + eval complete
   - **Pass criterion:** sync receipt and async receipt for same patch are byte-identical.

## Acceptance Criteria

After all above:

- `bundle-manifest.json` pins `baseRpcConfig`, `targetBlockOffset=30`, `replayBlockhashLookbackBlocks=50000`.
- `bundleHash` includes those pins (rotation triggers contract update via existing `coreVersionHash` mechanism).
- Sealed-eval is fully removed: `grep -r "sealed_eval\|sealedHidden\|commitmentRoot\|GATE_SEED_DOMAIN" packages/cortex/src/` returns nothing.
- `screenerAdmissionDecision` is available at `eval/live-eval-admission.ts` and exported from `@botcoin/cortex`.
- All 7 testing checkpoints green.
- Independent replay watcher reproduces every transition from public chain data + revealed epochSecret + bundle + corpus + Base RPC. CPU-only, byte-identical within `replayTolerancePpm`.

## Specs to Rewrite

After implementation lands, update:
- `specs/hidden_query_pack_v0.md` §Sampling rule — per-patch seed formula; drop coordinator-trust window.
- `specs/determinism_v0.md` — add `blockhash(targetBlock)` to canonical input chain.
- `specs/retrieval_benchmark_v0.md` — clarify per-patch pack lifecycle (sampled once, cached forever by dedup-key).

## Docs to Update (in this PR, alongside the rip)

- `docs/CORETEX_SEALED_EPOCH_EVAL_HARDENING_PLAN.md` — header banner: "SUPERSEDED by per-patch on-chain randomness. Retained for design history."
- `docs/CORETEX_PRODUCTION_RUNBOOK.md` §1.5 — Base RPC env block; replay-watcher RPC requirement.
- `docs/CORETEX_COORDINATOR_QUICKSTART.md` §3a — replace sealed-eval cross-link with live-eval cross-link (`real-evaluator.ts`, `seed-derivation.ts`, `base-blockhash.ts`, `live-eval-admission.ts`).
- `docs/CORETEX_MAINNET_LAUNCH_CHECKLIST.md` — drop drand bring-up; add Base RPC connectivity verification under §3 or new §3.5.
- `docs/CORETEX_LAUNCH_PLAN_v2.md` — align "sealed evaluation" section with per-patch model.

## What This Plan Will Not Do

- **No new contract changes** beyond the optional `PatchReceived` event (deferred to post-launch, ship with off-chain notice log).
- **No new model loads or new evaluator paths** — `evaluateRetrievalBenchmarkPatch` stays as-is.
- **No drand, no lock-anchors, no time-lock encryption.** The Base blockhash is the randomness source.
- **No knobs.** `targetBlockOffset` is bundle-pinned; not operator-configurable at runtime.
- **No GPU path.** All inference stays CPU-only.

## Phasing

**Pre-corpus-completion (now, while launch corpus runs ~58h remaining):**
- Rip sealed-eval (delete files + remove endpoint handlers + update tests). Pure-code, no model.
- Write `seed-derivation.ts` + golden vector tests. Pure hashing.
- Write `base-blockhash.ts` + mock server for tests. Pure I/O, no model.
- Write `live-eval-admission.ts` (move screenerAdmissionDecision). Pure code.
- Bundle profile: add new fields, update validators.
- Update docs (sealed-eval banner, hardening plan cross-link, mainnet checklist).

**Post-corpus-completion (after launch corpus generates):**
- Wire `real-evaluator.ts` to use new modules. Needs model integration.
- Phase 13 e2e rewrite with mock RPC. Model work.
- Run calibration-flow steps 3 + 9 + 10 + 12.
- Final bundle build with new pins.
- Push everything.

**Post-launch (deferred):**
- Optional contract patch: `PatchReceived` event.
- `verifyEpoch` CLI updated to take `--rpc-url` for blockhash lookup.
- Replay-watcher topology doc updated.
