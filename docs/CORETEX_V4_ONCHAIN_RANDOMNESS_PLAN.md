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

Two domain-separated seeds are derived per patch — the gate pack and
the confirm pack. A patch must clear threshold on BOTH packs to be
accepted. See §"Dual-Pack Confirmation" below for the rationale.

```text
evalSeed_gate = keccak256(
  "coretex-eval-v1-gate",  # gate-pack domain prefix
  epochSecret,             # 32 bytes, committed at epoch start
  blockhash(targetBlock),  # 32 bytes, targetBlock = receivedAtBlock + targetBlockOffset
  uint64(epochId),
  patchHash,               # keccak256(normalized patchBytes)
  parentRoot,              # 32 bytes
  minerAddress,            # 20 bytes
  corpusRoot,              # 32 bytes
  bundleHash               # 32 bytes
)

evalSeed_confirm = keccak256(
  "coretex-eval-v1-confirm",  # confirm-pack domain prefix
  epochSecret, blockhash(targetBlock), uint64(epochId),
  patchHash, parentRoot, minerAddress, corpusRoot, bundleHash
)
```

Distinct domain prefixes → packs are statistically independent draws
from `eval_hidden`. Same blockhash, same wait — no second RPC round-
trip, no additional latency.

Where:

- `targetBlockOffset = 30` (≈ 60 seconds on Base at 2s block time). Pinned in `EvaluatorProfile.baseRpcConfig`. Aligned with the per-miner challenge-submit rate limit (1/minute) — naturally gates submission cadence to match.
- `epochSecret` is committed at epoch start via `CortexState.initializeEpoch(...evalSeedCommit...)` and revealed at epoch close via `revealEvalSeed`. Held in multisig escrow.
- `receivedAtBlock` is the Base block number observed by the coordinator when the patch HTTP request entered the queue. Recorded in the signed receipt; replay watchers cross-check against a per-receipt published submission relay (see §"Receipt honesty").

## Dual-Pack Confirmation

The earlier sealed-eval design had gate + confirm packs for the same
reason this design does: a patch that clears one random pack might be
pack-lucky on a borderline result. Requiring confirmation on a second
independent pack drops the false-acceptance probability from `p` to
`p²`. Strong filter against single-pack noise.

In the per-patch design this is essentially free:

- Same blockhash, same wait — only the domain prefix changes.
- Pack-id sampling is bi-encoder-id-only (no new BGE-M3 forward passes
  per pack; embeddings already attached to corpus events).
- The two scoring passes (BGE-M3 + Qwen3 over each pack's queries)
  run sequentially on the same in-memory substrate. Total extra cost
  ≈ 1× per-patch eval = ~5–10 s on the pinned profile.

Acceptance rule:

```text
accepted = (score_gate ≥ minImprovementPpm + replayTolerancePpm + baselineVariancePpm)
         AND
           (score_confirm ≥ minImprovementPpm + replayTolerancePpm + baselineVariancePpm)
```

Both scores are committed to the signed receipt. Replay watchers
recompute both and verify the AND. A miner whose patch passes only
one pack receives a `pack-luck-filtered` rejection — the receipt is
still signed (for audit), but no credit is awarded and the state
does not advance.

## Canary Overfitting Watchdog

The corpus split assignment puts ~6 % of events in the `canary` split.
Canary events are deterministic-id-public but never sampled into a
gate or confirm pack (`hidden-query-pack.ts` filters them out at pack
derivation time). They serve two purposes:

1. **Public verifiability** — any third party can run their own
   reranker against canary qrels and reproduce the bundle's canary
   scores, since canary content is unredacted in the corpus.
2. **Overfitting detection** — if a miner's substrate scores well on
   canary queries while NOT being sampled there, it's evidence the
   substrate is memorizing eval_hidden in a way that bleeds into
   canary. Statistical drift on aggregate canary scores → overfitting
   signal.

`scripts/canary-overfitting-watchdog.mjs` (new) runs as a coordinator
cron job:

- Reads the last N accepted patches' eval receipts from
  `/var/lib/coretex/eval-reports/`.
- For each receipt, recomputes the substrate's score against the
  full canary set (deterministic, no model needed — uses the receipt's
  pinned bi-encoder embeddings + bundle's reranker pin).
- Tracks rolling mean and stdev of canary-set composite score.
- Alarms (writes to `/var/lib/coretex/reports/canary-alarms.log` and
  emits a webhook) when the rolling mean drifts > 3σ above the
  bundle's `baselineParentScorePpm` baseline.

Detection-only. The watchdog does not reject patches — operator
investigates alarms and decides whether to retire the corpus delta
(triggering a bundle rotation that invalidates prior overfitting).

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
export const EVAL_SEED_GATE_DOMAIN_PREFIX    = 'coretex-eval-v1-gate';
export const EVAL_SEED_CONFIRM_DOMAIN_PREFIX = 'coretex-eval-v1-confirm';

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

export function deriveGateEvalSeed(input: EvalSeedInput): string;    // 0x + 64 hex
export function deriveConfirmEvalSeed(input: EvalSeedInput): string; // 0x + 64 hex
export function computePatchHash(patchBytes: Uint8Array): string;
export function computeDedupKey(parentRoot: string, normalizedPatchBytes: Uint8Array): string;
```

Pure hashing only. No I/O, no model loads. Two domain-separated
seeds per patch (gate + confirm) — see §"Dual-Pack Confirmation".

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

## Staged Active Root

Full launch-scale corpus generation produces a 512-seeds-per-domain
**reserve**, but day-0 mining doesn't need the entire reserve to be
"active" — that just slows the difficulty ramp and exposes the
whole hidden-set surface immediately. Instead the active root is a
deterministic prefix of the reserve, advanced forward by routine
daily deltas.

Pinned in the bundle profile as `corpusStagingPolicy`:

```ts
{
  initialActiveSeedsPerDomain: 128,        // active root = seeds[0..128) per domain
  routineDeltaMaxMajorFraction: 0.50,      // daily delta ≤ 50% of major-delta-grace threshold
  initialActiveRunwayDays: 60,             // hidden-pack runway requirement (capacity gate)
}
```

The active root is a deterministic prefix:
`reserve.events.filter(e => seedOf(e) < S)` where S =
`initialActiveSeedsPerDomain`. The corpus generator already supports
`--seed-offset` for appending later seeds as deltas, so daily corpus
deltas at launch+N use `--seed-offset (S + N × seedsPerDayDelta)`.

**Selection law** — `scripts/calibrate-initial-active-size.mjs` picks
the smallest S satisfying every existing launch gate:
- **Capacity**: `floor(evalHidden / packSize) / epochsPerDay ≥ runwayDays`
- **Family coverage**: every required family has ≥ `minPerFamily`
  events in the active prefix
- **Routine delta safety**: a 2-seed/domain/day delta (≈1,240 events
  on 4 domains × ~155 events/seed) stays ≤
  `routineDeltaMaxMajorFraction × majorDeltaThreshold`

Why this is safe vs. running the full 512-seed corpus active from
day 0:
- Reserve seeds [S..512) remain bound to the bundle's `corpusRoot`
  (the Merkle root is over the full event set) — they're verifiable
  but not yet sampled into hidden packs.
- Seed determinism is preserved (`--seed-offset` writes new seeds at
  monotone indices; the substrate decoder's per-event provenance
  chain is intact).
- Bundle rotation triggers (major-delta-grace, baseline pin) all
  operate on the active root's `eval_hidden` population, which grows
  in the normal-delta regime.

## Auditor Follow-Ups (queued)

Items flagged by external review that are not blockers for pre-corpus
pure-code phase. Grouped by readiness.

### Post-corpus, model-dependent (task #38 + subtasks)

- **HTTP wiring** for `POST /coretex/evaluate`, `POST /coretex/evaluate-async`,
  `GET /coretex/result/:patchHash` in cortex-server. Per-patch
  orchestrator (`runPerPatchEvaluation`) and replay verifier
  (`verifyPerPatchReceipt`) are landed and tested; HTTP integration
  needs the real models loaded for end-to-end validation.
- **Phase 13 e2e rewrite** to exercise the new flow: mock Base RPC
  schedule, per-patch dual-pack scoring, mock `revealEvalSeed`, replay
  reproduces both seeds + both scores within `replayTolerancePpm`.
  Adversarial sub-test: wrong epochSecret → every receipt fails
  signature.
- **`scripts/check-per-patch-pack-determinism.mjs`** — synthesize 50
  distinct `(patchHash, parentRoot, minerAddress)` triples, derive
  gate + confirm packs 3× each from the launch corpus, assert
  byte-identical reproduction. Needs corpus to derive packs from.

### Post-corpus, gameability + multi-host hardening (launch-blocking)

- **Exhaustive screener-admission gameability tests** — the
  `qualifiedScreenerPassesSinceLastStateAdvance` counter feeds a 4×
  BPS uplift in `work-units.ts`. This is a real economic seam: a
  coordinator or colluding miner that inflates the counter manufactures
  reward, reintroducing exactly the "GPU-monopoly emergence" the credit
  design is meant to prevent. Build an adversarial test suite that
  (a) replays admission against fabricated dedup-key sets,
  (b) verifies per-miner caps are enforced on-chain via watcher
  reconstruction, (c) probes structural / dedup collapse rules with
  synthesized colliding patches, (d) asserts the counter resets
  correctly on every state advance, (e) tests the ramp curve for
  diminishing returns or capping, (f) runs an economic simulation
  sizing how much credit a single high-throughput miner can extract
  vs blind submitters across an epoch. Pre-launch gate.

- **Remove the `GET /coretex/coverage-hints` endpoint** — verified
  live in `packages/cortex/src/coordinator/endpoints.ts:13,42,196-201`
  and `packages/cortex/src/coordinator/retrieval-data-source.ts:52,100-117`.
  The documented production override at
  `CORETEX_COORDINATOR_INTEGRATION_RUNBOOK.md:149` returns per-record
  nDCG contribution — the exact "weakest-covered slots" leak that
  rewards reconnaissance over substrate insight. Strip route, type,
  default impl, override hook, contract test, and 8 doc mentions.

- **Multi-hardware determinism validation (≥3 physically distinct
  CPU configs)** — `CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md`
  mandates this; current calibration ran on one physical host with 3
  logical replicas. Provision two additional CPU configurations
  (different microarchitecture / BLAS dispatch / vendor where
  possible), run `determinism-check.mjs` per host, aggregate via
  `aggregate-determinism.mjs`, require ≥3-physical-host agreement
  within `replayTolerancePpm = 250 ppm` before signing the launch
  bundle.

- **PatchReceivedNotice publisher wiring** — host HTTP ingress for
  `packages/cortex/src/coordinator/patch-received-notice.ts` is not
  invoked by the coordinator; replay-watcher does not require the
  notice. Wire publisher into the host POST flow and gate watcher
  acceptance on notice presence.

- **Hidden-pack replay publication** — no post-epoch publisher of
  accepted patches' gate/confirm pack IDs + qrels exists. Replay
  verifiers cannot reconstruct per-patch pack derivation without it.
  Per-epoch publisher emitting `{patchHash → {gatePackId,
  confirmPackId, qrels}}` to `/var/lib/coretex/eval-reports/`.

- **Runtime fingerprint in determinism report** —
  `scripts/determinism-check.mjs:97-114` omits Python / torch /
  transformers / tokenizers versions, `/proc/cpuinfo` flags, the
  resolved BLAS backend, OMP/MKL/OPENBLAS/NUMEXPR/VECLIB thread
  counts, and BIENCODER/RERANKER inner batch sizes. Without these,
  cross-host disagreement is uninvestigable.

- **Coordinator-affiliated wallet exclusion** —
  `CORETEX_PRODUCTION_RUNBOOK.md` references the exclusion list but
  no on-chain mechanism, no published list, and no test exists.
  Define list contract, publish signed by coordinator, watcher
  assertion that excluded wallets cannot accrue `coretexCredits`.

### Post-calibration

- **Baseline / difficulty publication** in epoch rotation manifests.
  `epoch-rotation.ts` currently does not emit `baselineParentScorePpm`,
  `baselineVariancePpm`, `baselineEvalSeedHex`, or major-delta grace
  state. Finalize after the calibration run pins these values into the
  bundle; the manifest emitter then surfaces them so any watcher can
  reproduce the difficulty calculation from the signed manifest.
- **Composite golden values** locked into `evaluateRetrievalBenchmarkPatch`
  acceptance — currently the scorer only enforces
  `minImprovementPpm`; callers must fold in `replayTolerancePpm` +
  `baselineVariancePpm`. Move the addition into the scorer so it is
  enforced uniformly and can't be skipped at a call site.

### Post-corpus regeneration

The launch corpus is mid-flight; these items require a future corpus
delta or regeneration to take effect, so they don't block launch:

- **Populate `causalDepth` / `relationHopDepth`** on generated events.
  Hidden-pack stratification has depth-predicate quotas
  (`hidden-query-pack.ts`), but the generator doesn't emit these
  fields, so depth predicates always evaluate to 1. Wire the
  challenge-library output into the generator's event constructor
  and re-emit a delta when the calibration corpus is regenerated.
- **Streaming `--previous-corpus`** support in
  `generate-coretex-retrieval-corpus.mjs`. The streaming refactor
  intentionally refuses `--previous-corpus` (would require streaming
  the previous corpus too). Extend if delta builds at launch scale
  are needed; not required for the initial epoch-0 corpus.

### Substrate ladder observability (post-launch, governance-data path)

- **Dead-slot count metric** — per `specs/cortex_state_v0.md` §"Future
  ladder step: 1024 → 2048". After substrate decode each epoch, count
  slots whose bytes are structurally zero across MemoryIndex,
  RetrievalKey, Relations, Temporal, and Codebook ranges. Publish as
  `deadSlotCount` in the signed epoch rotation manifest. Replay
  watchers verify the count from the published state root.
  - Detection-only: NOT a miner reward input, NOT a ladder trigger
  - Governance uses the trend (months of low dead-slot count + flat
    retrieval headroom EMA) to authorize the 1024→2048 ladder
  - Ships alongside the epoch-rotation-manifest baseline/difficulty
    publication in task #38

### Pre-corpus polish (small, low priority)

- ✅ **Seed golden vectors** (`e6f695e`) — `test/fixtures/seed-derivation-golden.json`
  with hand-picked input tuples covering edge cases; loaded by
  `seed-derivation-golden.test.mjs`. Locks the wire format against
  drift across Node versions / keccak implementations.
- ✅ **BLAS / thread-count pinning** (`4037885`) — bi-encoder + reranker
  subprocess envs now propagate `OMP_NUM_THREADS`, `MKL_NUM_THREADS`,
  `OPENBLAS_NUM_THREADS`, `NUMEXPR_NUM_THREADS`, `VECLIB_MAXIMUM_THREADS`
  from the canonical worker thread-count var BEFORE torch import.
  Documented in `specs/determinism_v0.md` §"BLAS thread pinning".
- ✅ **Patch hash duality naming clarity** (`4566371`) —
  `specs/patch_format_v0.md` documents `patchBytesHash` (chain
  domain, raw keccak) vs `evalPatchHash` (eval domain,
  `coretex-patch-hash-v1` prefix). Full code rename queued for a
  follow-up touch when the post-corpus integration lands.
- **`relevantNearCollisionPpm` required at the wire boundary** —
  `work-units.ts:117` currently treats it optional; the runtime
  check is skipped if the field is omitted. The eval pipeline does
  not yet produce the signal (no caller computes it), so making the
  field required at the wire requires a corresponding eval-side
  emit. Tied to the model integration in task #38 — promote to
  required there, alongside computing the value from
  `evalResult.report.families['near_collision']` and wiring it into
  receipts.
- **`replay/per-patch.ts` rejection-receipt hardening** — pre-RPC
  rejection receipts (admission-failed) verify with patchHash +
  dedupKey checks only. For audit completeness, also re-derive the
  admission decision (`liveEvalAdmissionDecision`) from the receipt's
  inputs and assert it produces the same `rejectionReason`. Catches
  a coordinator that fabricates rejection reasons. Defer to task #38
  where the receipt format firms up (the admission decision needs
  per-epoch dedup-set + miner-admission counters from chain state,
  which the watcher reconstructs from accepted-receipt history).

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
