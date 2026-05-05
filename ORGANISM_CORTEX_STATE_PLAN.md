## 0. North-star design

**Working name**: Botcoin Cortex.

**One-sentence protocol**: Botcoin Cortex is a credit-unified mining lane in which miners propose tiny patches to a compact on-chain-rooted memory codec; Botcoin Core verifies improvements deterministically against an anchored benchmark, screener-pass patches earn credits at the miner's current on-chain tier through the same `BotcoinMining.submitReceipt` path, and merged (real) improvements pay a multiplier-uplift bonus through a small peer `CortexMergeBonus` contract that mirrors the existing `BonusEpoch` pattern.

**What it adds to Botcoin**

Current Botcoin proves: I solved this LLM-native deterministic challenge.
Cortex mining proves: I improved the shared memory substrate that future Botcoin agents read through Core — and I get paid through the same receipt path I already use, plus a sister-contract bonus when my patch is merged.

The current SWCP challenge system is unchanged. `BotcoinMiningV3` is unchanged. Cortex is parallel, not separate-economy. No new reward currency, no new claim flow, no replacement of the existing tier system. Two new contracts only: `CortexRegistry` (state anchor, zero rewards) and `CortexMergeBonus` (multiplier payout, mirrors existing `BonusEpoch`).

## 1. Core architectural choice

Do not store full model weights on-chain. Do store a compact on-chain-rooted memory codec.

```
CortexState = 1024 uint256 words = 32 KB active state
```

**On chain (in CortexRegistry, separate from BotcoinMining)**:
- `stateRoot`
- `coreVersionHash`
- `benchmarkCommitment`
- `experienceCorpusRoot` (immutable corpus the current epoch grades against)
- `patchSetRoot`
- `scoreRoot / metadataRoot`

**In events (calldata, not just hashes)**: each accepted patch event MUST carry the compact patch payload itself — target indices, old words, new words, patch type, score delta. Reconstruction-from-chain is binding, not aspirational. Hashes alone are not data availability.

**Periodic full-state snapshot on chain**: every `SNAPSHOT_EPOCH_INTERVAL` (V0 default: 100 epochs), commit the raw 1024 words via calldata. Bounds replay cost — without this, syncing a fresh auditor at epoch 5000 requires scanning every accepted patch since genesis.

Rolling reconstruction = parent snapshot + accepted patches + reducer order. The contract stores roots only.

This is the right split because Ethereum-style systems already rely on cryptographic roots to commit to large state, and Merkle/SSZ-style trees give clients verifiable views without making the contract a 32 KB mutable database. The organism is on-chain-rooted, not contract-storage-resident.

## 2. Why this state shape is research-backed

Scalable agent memory should not collapse everything into one dense embedding or one prose summary. Single-vector retrieval has structural limits (LIMIT) and saturates as corpora grow. Late-interaction multi-vector retrieval is becoming much more efficient (WARP). The Experience Compression Spectrum frames memory, skills, and rules as different compression levels — Botcoin Cortex is exactly that experiment.

So state is many tiny interaction points:

- binary keys
- multi-vector slots
- relation codes
- routing weights
- validity intervals
- revocation bits
- small codebook entries

Not one vector, one summary, one note, or one adapter.

## 3. What goes into Cortex state

The state is not raw memories. It is a compact codec over a public, on-chain-anchored experience corpus.

**Source corpus** — committed via `experienceCorpusRoot` at epoch start:
A. Synthetic CortexBench memory events (from anchored benchmark families, §5).
B. A frozen snapshot of real Botcoin SWCP attempt records, taken at corpus-snapshot cadence (default every 100 epochs). The frozen snapshot is hashed into `experienceCorpusRoot`. Only events covered by the current corpus root score for the current epoch — corpus drift mid-epoch is forbidden.

**Active state layout V0 (1024 words)**:

```
Words 0–31      protocol header, schema hash fragments, score counters, epoch metadata
Words 32–383    memory-object index slots (event ids, type, validity, domain code, checksum)
Words 384–671   binary / multi-vector retrieval keys
Words 672–799   relation and routing weights
Words 800–895   temporal validity / revocation map
Words 896–991   codebook / operator table
Words 992–1023  reserved / experimental / future compatibility
```

The state stores how to find, route, update, and invalidate memory — not the memory itself.

## 4. Botcoin Core V0 decoder

Lives in a new workspace `packages/cortex` (decoder, evaluator, CLI, test vectors). Importable by the cortex process and runnable standalone by auditors.

V0 decoder responsibilities:

1. Parse 1024-word CortexState into typed slots.
2. Build retrieval keys and routes.
3. Resolve temporal validity / revocation.
4. Run deterministic CortexBench tasks against `experienceCorpusRoot`.
5. Apply candidate patches.
6. Recompute state root.
7. Emit reproducible eval report.

**Hard performance budget**: a single patch-eval call SHOULD complete in <10 ms p50 on commodity CPU and MUST complete in <50 ms p99. Eval runs in a worker pool — never on the HTTP request thread. Otherwise legitimate submission volume DDoSes the API.

No frontier model inside consensus. No API model inside canonical scoring. Miners may use any LLM externally to propose patches; the canonical verifier is pinned: same Core version, same state, same benchmark seed, same `experienceCorpusRoot`, same scoring formula → same output.

## 5. Benchmark strategy — anchored, not invented

Anchor to reputable existing benchmarks first; only invent where their configurations don't fit a 32 KB on-chain codec. Each Cortex family pulls task definitions and data directly from a published benchmark, configured for our budget.

**Family 1 — Near-collision retrieval** (~20% of score)
- Anchored on **LIMIT** (Weller et al., 2025) plus **MTEB Retrieval / BEIR** subsets.
- Public query/passage pairs, standard metrics (Recall@K, MRR@10).
- Perturbation operators: bit-flip distance d ∈ {1,2,4} on derived binary keys; controlled cosine-distance ε on dense-key variants.
- No bespoke "near-collision" generator.

**Family 2 — Temporal update / revocation** (~20% of score)
- Anchored on **LoCoMo** (long conversational memory) and **MemoryAgentBench**'s temporal subset.
- Public records carry stale-vs-current truth labels; Cortex must reject stale and surface current.
- Records re-encoded into Cortex event format under `experienceCorpusRoot`.

**Family 3 — Long-horizon compression** (~60% of score)
- Anchored on **MemoryArena** (multi-session loops) plus a synthetic stream-and-evict generator parameterized to force capacity pressure on 1024 words.
- Long-horizon is the only family that does not saturate as the codec improves — that is why it carries the dominant weight. Without this, the organism stops evolving by ~epoch 200.

**Score formula** (each component ∈ [0,1]; weights frozen in `cortex_bench_v0.md` before Phase 4 lock):

```
+ exact retrieval                w = 0.30
+ stale-memory rejection         w = 0.15
+ temporal update correctness    w = 0.15
+ compression survival           w = 0.30
+ routing accuracy               w = 0.05
- latency penalty                w = 0.025  (subtracted)
state-size compliance            hard veto, not weighted
protected-regression set         hard veto on any drop in the protected anchors
```

A patch is valid iff:
- `candidateScore > baselineScore + threshold`
- `protectedRegression == 0` (no drop on any protected anchor)
- `patchSize <= budget`
- evaluation reproducible byte-identically on a clean machine

**Pass-rate targets** — tightened from earlier draft:
- random / no-op: ~0%
- weak heuristic miners: 5–10%
- strong miners: 20–30%

A 40–60% target across the board rewards finding shard quirks, not improving the substrate.

**Hidden shards via commit/reveal** — reuses existing coordinator machinery:
- Per-epoch hidden seed `H_e` is committed on-chain at epoch start (mirrors `setEpochCommit` in `epoch.ts:168`).
- A miner's assigned shard is `keccak(H_e ‖ miner ‖ solveIndex ‖ parentStateRoot)`, derived through the existing `deriveWorldSeedU128(...)` (`epoch.ts:257`). No new randomness machinery.
- Hidden seed revealed at epoch end (mirrors `revealEpochSecret`). Auditors replay the full epoch.
- Continuous shard generation: shards are derived on demand from `H_e`, not drawn from a static pool. Probing across many epochs cannot enumerate the space because each `H_e` is fresh.
- A miner sees their assigned `shardId` at challenge time. Their patch is silently re-evaluated against `K=4` random other shards as protected-regression at merge time.

## 6. Mining flow

**Lightweight miner path** — same auth/tier system as SWCP:

```
GET /v1/cortex/challenge
```

Explicit path-prefixed routing — not `?lane=cortex` — so nginx upstream selection is purely by path and a misroute can never silently fall through to the SWCP handler. Behind nginx, `/v1/cortex/*` routes to a separate `cortex-server` process (own PID, own SQLite, own worker pool) mounted under the same coordinator origin (`coordinator.agentmoney.net`). The cortex process and the SWCP coordinator share: chain RPC, the signing key (via internal RPC, never duplicated), epoch state, rate-limit budget, and outstanding-challenge state.

Response shape:

```json
{
  "lane": "cortex",
  "epoch": 812,
  "parentStateRoot": "0x...",
  "experienceCorpusRoot": "0x...",
  "coreVersionHash": "0x...",
  "patchObjective": "KEY_UPDATE",
  "patchBudget": 4,
  "shardId": "0x...",
  "shardDescriptor": { "...": "..." },
  "submissionFormat": "...",
  "creditsPerSolve": "<from getTier()>"
}
```

`creditsPerSolve` reflects the miner's **current on-chain tier** as reported by `BotcoinMiningV3.getTier()` / `_creditsForBalance()` — the live V3 system is stake-based and dynamic across 1–10 tiers with arbitrary scaled credit values, not a fixed 1 / 2 / 3 table. No separate Cortex tier table.

**Single outstanding challenge across lanes**: before the cortex process serves a challenge, it queries `/internal/outstanding-challenge?miner=0x...` on the SWCP process. If the miner has an unsubmitted SWCP or Cortex challenge that has not expired, the cortex process returns 409. Same guard runs on the SWCP side. This avoids a `nextIndex` / `lastReceiptHash` race in which a miner who holds one of each receipt has whichever lands first invalidate the other.

```
POST /v1/cortex/submit
```

The cortex process runs Botcoin Core in a worker. On screener pass, it requests a signed receipt from the SWCP signer over the existing `BotcoinMining` EIP-712 domain — no new contract domain in V0. The receipt struct is reused with a published field mapping:

| `BotcoinMining` field | Cortex meaning |
|---|---|
| `worldSeed` (uint128) | u128 derived from `keccak(H_e ‖ miner ‖ solveIndex ‖ parentStateRoot)` |
| `docHash` | `parentStateRoot` |
| `questionsHash` | `experienceCorpusRoot` |
| `constraintsHash` | `shardCommitment` |
| `answersHash` | `patchHash` |
| `rulesVersion` | reserved Cortex value (e.g. `0xC0`) |

The contract validates the signature and updates `lastReceiptHash` / `nextIndex` agnostically. Credit accrual is identical to SWCP. Auditors and explorers disambiguate via `rulesVersion`.

This is honestly a soft-coupling: the on-chain schema labels say "doc/questions/constraints/answers" and explorers will see them as such. It is acceptable for V0 because the contract does not introspect semantics — only the signature. **V1 path**: a contract upgrade adding `submitCortexReceipt(...)` as a sister function with explicit field names. Tracked in Phase 9 release notes.

If a screener-pass patch is also accepted by the epoch reducer, the multiplier is paid through a peer **`CortexMergeBonus`** contract — the coordinator cannot retroactively reweight credits because `BotcoinMiningV3.claim()` reads `epochReward × minerCredits / totalCredits` directly from on-chain state. The bonus contract mirrors the existing `BonusEpoch` pattern (`BonusEpochManager`, sister contract at `0xA185...6Ba8`):

1. At epoch finalization (after the audit window closes), the coordinator computes for each merging miner: `bonusBOTCOIN = (MERGE_MULTIPLIER − 1) × claimBaseForMerger(epoch, miner)`, where `claimBaseForMerger` is that miner's own pro-rata share of the epoch reward across both lanes' receipts.
2. The coordinator funds `CortexMergeBonus` for that epoch.
3. Miners claim via `claimMergeBonus(uint64[] epochIds)` — coordinator returns pre-encoded calldata via `GET /v1/cortex/merge-bonus/claim-calldata?epochs=...`, identical UX to existing `BonusEpoch` claims.

`MERGE_MULTIPLIER = 1.5` in V0, capped per miner per epoch (single merge sufficient — additional merges in the same epoch grant no extra uplift).

**Core runner / auditor path**:

```
botcoin-cortex verify-epoch 812
```

Reconstructs from chain alone: parent snapshot + post-snapshot accepted patches + reducer order + `H_e` reveal + `experienceCorpusRoot` + Core version → re-derives `stateRoot`. Auditable end-to-end without coordinator trust for the *state*; an optimistic challenge window protects credit settlement (§9 Phase 2 / Phase 9).

## 7. Credits and anti-centralization

Per protocol direction: integrate into the existing tier system; merge bonus = epoch-wide multiplier on all credits. No independent Cortex reward currency.

**Layer A — screener credits (broad)**
- Cortex screener-pass receipt = miner's current on-chain tier credits, queried live from `BotcoinMiningV3.getTier()` via `/internal/miner-tier`. Same value the SWCP lane returns. No fixed table.
- Per-miner submit cap is shared across lanes (single rate-limit budget in the SWCP process). A miner cannot bypass SWCP rate limits by switching lanes.
- Single outstanding challenge across lanes (§6) — `nextIndex` / `lastReceiptHash` race avoided by serializing per-miner challenges, not per-lane.
- Gates: hidden-shard pass, protected-regression clean, patch within budget, non-noop, byte-reproducible.

**Layer B — merge multiplier (selective, paid via `CortexMergeBonus`)**
- Epoch reducer selects a non-conflicting set of patches via deterministic greedy-by-marginal-gain (`reducer_v0.md`):
  1. Sort screener-pass patches by `(scoreDelta, -patchSize, patchHash)` descending.
  2. Apply patches in order against the parent state. Skip any patch whose target indices intersect already-accepted indices, **or** whose evaluated marginal gain on top of currently-accepted patches drops below threshold (semantic conflict).
  3. Result: deterministic `patchSetRoot` and `newStateRoot`. Public, replayable, anyone re-runs from chain logs.
- Multiplier payout via `CortexMergeBonus` contract (§6 mining flow). Layer B never touches `BotcoinMiningV3` — V3's `claim()` math is fixed and cannot be reweighted post-receipt.
- Multiplier capped at 1.5× per miner per epoch in V0.

**Why this works for anti-centralization**
- Most miners earn screener-pass credits at standard tier rate — no centralization there.
- The multiplier rewards the high-end optimizer who finds genuinely useful patches but does not redirect the epoch's pool to them; their reward is a percentage uplift on their *own* solves, not a winner-take-all bounty.
- Worked example: a miner with 200 SWCP solves + 20 Cortex screener passes in epoch `e`, with one merged patch, earns their normal `(200 + 20) × tierCredits` from `BotcoinMiningV3.claim()`, plus an additional `0.5 × claimBaseForMerger(e, miner)` from `CortexMergeBonus.claimMergeBonus([e])`. Strong but not pool-dominating, and structurally separable in audits.

**Difficulty control** — maintain pass-rate targets via:
- hidden shard difficulty
- score threshold
- patch budget
- family mix
- protected-regression strictness

**Filler / abuse rejection at screener**: no-op, random mutation, public-test overfit, protected-regression patches, patch-size abuse.

## 8. Process topology and latch/unlatch

Cortex runs as a **separate process** behind the same coordinator API origin and the same on-chain mining contract.

- Process: `packages/cortex-server` (own PID, SQLite at `data/cortex/queue.db`, worker pool for Core eval).
- nginx routes by **path prefix only**: `/v1/cortex/*` → cortex-server upstream. Everything else → existing coordinator. Path-based routing avoids the misroute risk of query-string lane selection.
- Cortex shares with the existing coordinator via a small internal HTTP RPC layer on the SWCP process (`packages/coordinator/src/cortex-handler.ts`):
  - `GET /internal/miner-tier?miner=0x...` — current `creditsPerSolve` from `BotcoinMiningV3.getTier()` / `_creditsForBalance()`.
  - `POST /internal/sign-cortex-receipt` — signature via the existing `ReceiptSigner` (single source of truth, no key duplication, single `signer.ts:8-29` schema).
  - `GET /internal/epoch` — current epoch + secret reveal status.
  - `GET /internal/rate-limit-budget?miner=0x...&lane=cortex` — shared submit-cap accounting.
  - `GET /internal/outstanding-challenge?miner=0x...` — cross-lane outstanding-challenge guard. Returns `{ outstanding: bool, lane: "swcp"|"cortex"|null, expiresAt }`.
- The SWCP process gains `cortex-store.ts` for cross-lane bookkeeping (outstanding-challenge state, merge-bonus epoch funding receipts, multiplier-claim ledger).
- Cortex never reads `data/epoch-secrets.json` directly — only the SWCP process writes that file. Cortex pulls epoch state via `/internal/epoch`. Eliminates the file-race risk that a true sidecar would create.
- Latch/unlatch: stop `cortex-server` (or remove the nginx upstream). SWCP unaffected. The existing `server.ts` does not branch on lane — the `/internal/*` additions are purely additive and tested with the cortex process disabled.

## 9. Phase-by-phase implementation plan

### Phase 0 — Research lock and non-goals
**Owner**: Research subagent. **Goal**: stop the idea from sprawling.

Completion checklist:
- [ ] One-page thesis: "Proof-of-Cortex over compact on-chain memory codec, credit-unified with SWCP."
- [ ] Rejected for V0: weights on-chain; LoRA mining; arbitrary memory text; miner-to-miner mandatory coordination; subjective AI judging; constantly mutable Core; separate Cortex reward currency; new EIP-712 domain.
- [ ] Anchored benchmark sources locked: LIMIT, MTEB Retrieval, LoCoMo, MemoryAgentBench, MemoryArena. Public licenses verified.
- [ ] Family weights locked: long-horizon 60%, near-collision 20%, temporal 20%.
- [ ] Pass-rate targets locked: random ~0%, weak 5–10%, strong 20–30%.
- [ ] Source brief covering LIMIT, late-interaction / WARP, ERM correctness-gated key updates, MemoryArena / MemoryAgentBench, Experience Compression Spectrum, Proof-of-Improvement logic.

Done when: all subagents agree V0 is a memory-codec improvement lane that pays through the existing receipt path, not a model-training lane.

### Phase 1 — Cortex state spec
**Owner**: Protocol subagent.

Deliverables: `cortex_state_v0.md`, `cortex_schema_v0.json`, `packing_spec_v0.md`, `merkleization_spec_v0.md`, `patch_format_v0.md`.

- [ ] 1024-word active CortexState defined; word-ranges assigned (per §3).
- [ ] Packed bit fields specified; reserved bits = zero.
- [ ] State root = Merkle root over 1024 leaves.
- [ ] Patch wire format: parent state root, target indices (varint-packed), new words, patch type, score delta. **Old words omitted from the wire** — reconstructed from parent state during eval, since a matching `parentStateRoot` already implies old-word correctness. Realistic budget: ≤ 200 bytes for a 4-word patch.
- [ ] Maximum patch budget set: V0 default 1–4 words/patch.
- [ ] Genesis state seeded from Phase 7 baseline E winner (revocation-aware), **not** all-zero.
- [ ] Two independent reference implementations (e.g. TS + Rust) compute identical roots from the same state and same patch set.
- [ ] Root recomputation test vectors created.

E2E tests (must pass in CI before phase complete):
- [ ] **Pack/unpack round-trip**: 10k randomized 1024-word states pack → unpack → byte-identical.
- [ ] **Reserved-bit enforcement**: any state with a non-zero reserved bit is rejected by both reference implementations.
- [ ] **Cross-implementation Merkle parity**: 1k fuzzed (state, patch-set) pairs produce byte-identical roots in TS and Rust references.
- [ ] **Patch wire format encode/decode**: 10k randomized patches (1–4 word, all patch types, target indices spanning all word ranges) round-trip via varint indices.
- [ ] **Old-words reconstruction parity**: a wire patch that omits old words and the same patch with old words attached produce identical evaluator behavior given matching `parentStateRoot`.
- [ ] **Wire-size budget gate**: 99th-percentile patch wire-size on a 10k-sample fuzz ≤ 200 bytes for the 4-word case; CI fails on regression.
- [ ] **Reject-vector coverage**: explicit fixtures for wrong parent root, wrong-type field, over-budget patch, reserved-bit set, no-op patch — each rejected with a stable error code.

Done when: two independent implementations match byte-for-byte and all E2E fixtures pass in CI.

### Phase 2 — CortexRegistry + CortexMergeBonus contracts
**Owner**: EVM subagent. **Goal**: anchor Cortex state and pay merge multipliers without touching `BotcoinMiningV3`.

Two contracts. `BotcoinMiningV3` is unmodified.

Header:
```solidity
struct CortexHeader {
    uint64  epoch;
    bytes32 stateRoot;
    bytes32 coreVersionHash;
    bytes32 benchmarkCommitment;
    bytes32 experienceCorpusRoot;
    bytes32 patchSetRoot;
    bytes32 scoreRoot;
}
```

Events (data-availability binding):
```solidity
event CortexShardCommitted(uint64 epoch, bytes32 hiddenSeedCommit);
event CortexShardRevealed (uint64 epoch, bytes32 hiddenSeed);

event CortexPatchAccepted(
    uint64 epoch,
    address miner,
    bytes32 parentStateRoot,
    bytes32 patchHash,
    bytes32 evalReportHash,
    bytes  compactPatchBytes  // full payload, not just the hash
);

event CortexEpochFinalized(
    uint64 epoch,
    bytes32 parentStateRoot,
    bytes32 patchSetRoot,
    bytes32 newStateRoot,
    bytes32 coreVersionHash,
    bytes32 experienceCorpusRoot
);

event CortexStateSnapshot(
    uint64 epoch,
    bytes32 stateRoot,
    bytes  fullStateBytes  // raw 1024 words, every SNAPSHOT_EPOCH_INTERVAL
);
```

Completion checklist:
**`CortexRegistry`** (state anchor, zero reward logic):
- [ ] Contract compiles, deployed at address separate from `BotcoinMining`.
- [ ] Stores headers per epoch.
- [ ] Emits accepted-patch records with **full compactPatchBytes**.
- [ ] Emits state snapshot every `SNAPSHOT_EPOCH_INTERVAL` (V0: 100 epochs).
- [ ] Zero reward logic. Credit issuance flows through the existing `BotcoinMiningV3.submitReceipt` with the receipt field mapping in §6.
- [ ] **Audit-and-multisig-override window** (renamed from "optimistic challenge"): `CortexEpochFinalized` is provisional for `CHALLENGE_WINDOW_SECONDS` (V0: 6 hours). The EVM cannot re-run Core, so this is **not** an on-chain fraud proof. The window is an audit delay during which any party can run `botcoin-cortex verify-epoch` locally and publicly demonstrate divergence; if divergence is shown, a 2-of-N operator multisig (key set published in Phase 9 docs) calls `revertEpoch(epoch)` and the coordinator re-finalizes. After the window, finalization is canonical and merge bonuses are funded into `CortexMergeBonus`. Document this trust assumption honestly in miner-facing docs. Bond-based or ZK fraud proofs deferred to V1.
- [ ] Emergency pause for Cortex lane only.
- [ ] Test proves SWCP mining unaffected when `CortexRegistry` is paused or absent.

**`CortexMergeBonus`** (multiplier payout, mirrors existing `BonusEpoch`):
- [ ] Funded by the coordinator at epoch finalization (after audit window). Funding tx posts a per-epoch root of `(miner, bonusBOTCOIN)` pairs.
- [ ] `claimMergeBonus(uint64[] epochIds)` claim entrypoint — same UX as the existing `BonusEpoch.claimBonus`.
- [ ] No multiplier funded until audit window closes for that epoch.
- [ ] Cap enforced on-chain: per-miner per-epoch payout ≤ `(MERGE_MULTIPLIER − 1) × claimBaseForMerger(epoch, miner)`.
- [ ] Emergency pause separate from `CortexRegistry`.
- [ ] Pool-mode wrapping calldata (`triggerMergeBonusClaim(uint64[])`) for pool contracts, mirroring existing bonus pool flow.

E2E tests (must pass in CI before phase complete):
- [ ] **Forge fork test against Base mainnet**: deploy `CortexRegistry` + `CortexMergeBonus`, run `submitHeader → emit CortexPatchAccepted (×N) → finalizeEpoch → snapshot at interval boundary → fund CortexMergeBonus → claimMergeBonus`. End-to-end on-chain flow.
- [ ] **Log-only reconstruction**: starting from a fresh node with only chain logs, replay 10 finalized epochs (including ≥1 crossing a snapshot boundary) and re-derive every `newStateRoot` byte-identically.
- [ ] **Audit-window enforcement**: claim attempt before `CHALLENGE_WINDOW_SECONDS` reverts; multisig `revertEpoch` during the window unwinds finalization and prevents bonus funding.
- [ ] **Multisig revert drill**: 2-of-N successful revert; 1-of-N rejected; revert after window close rejected.
- [ ] **On-chain bonus cap enforcement**: a funded payout exceeding `(MERGE_MULTIPLIER − 1) × claimBaseForMerger` reverts.
- [ ] **SWCP non-interference**: full SWCP `submitReceipt` + `claim` flow runs unchanged with `CortexRegistry` and `CortexMergeBonus` paused, unpaused, and absent (constructor address-zero).
- [ ] **Pause matrix**: pausing `CortexRegistry` blocks Cortex finalization but not SWCP claims; pausing `CortexMergeBonus` blocks merge claims but not screener receipts.
- [ ] **Pool-mode calldata**: `triggerMergeBonusClaim` end-to-end through a pool contract on a forked Base mainnet, parity with existing `BonusEpoch` pool flow.
- [ ] **Gas budget gate**: `submitPatchAccepted`, `finalizeEpoch`, `snapshot`, `claimMergeBonus` each below documented gas ceilings; CI fails on regression.
- [ ] **Snapshot reconstruction parity**: state reconstructed from `(snapshot at e_k) + accepted patches in (e_k, e_n]` matches state reconstructed from genesis through `e_n`.

Done when: Cortex can be deployed, paused, finalized, and ignored without touching existing Botcoin mining; merge bonuses pay out correctly post-window; SWCP mining is provably unaffected; all on-chain E2E fixtures pass on a Base mainnet fork.

### Phase 3 — Botcoin Core decoder package
**Owner**: Core subagent.

New workspace `packages/cortex`. CLI: `botcoin-cortex {decode, apply-patch, eval, reduce-epoch, verify-epoch, snapshot}`.

- [ ] Parses 1024-word CortexState into typed slots.
- [ ] Decodes retrieval keys, relation/routing weights, temporal/revocation map.
- [ ] Applies patches deterministically; rejects: wrong parent root, wrong old word, over budget, reserved-bit violation, malformed type, no-op.
- [ ] Eval performance: <10 ms p50, <50 ms p99 on commodity CPU. Enforced by perf test.
- [ ] Worker-pool execution; main HTTP thread never blocks on eval.
- [ ] Deterministic eval-report hash; same result on two machines.
- [ ] **Core version upgrade semantics**: Core upgrades publish a `state_translation_patch` mapping V_n → V_{n+1} or explicitly reset the organism. Either path is acceptable; ambiguity is not.
- [ ] No API model required for canonical verification.

E2E tests (must pass in CI before phase complete):
- [ ] **Decode → eval → apply → re-root round trip**: 1k randomized (state, patch) pairs full pipeline; output state root matches an independent reference impl.
- [ ] **Eval determinism across architectures**: same fixture produces identical eval-report hash on linux/x64, linux/arm64, macOS/arm64 (CI matrix).
- [ ] **Perf gate**: `<10 ms p50, <50 ms p99` enforced on a 10k-sample fuzz on the CI runner spec; CI fails on regression.
- [ ] **Worker-pool isolation**: synthetic flood of 10k concurrent eval requests does not block a `/healthz` request on the HTTP thread (latency p99 < 50 ms).
- [ ] **Rejection matrix**: explicit fixtures for wrong parent root, wrong old word implied by parent state, over-budget patch, reserved-bit set, malformed type, no-op patch — each rejected with stable error codes.
- [ ] **`verify-epoch` from chain alone**: pull events for a finalized epoch from a node, reproduce `newStateRoot` byte-identically without any coordinator data.
- [ ] **Core upgrade transition**: applying a published `state_translation_patch` from V_n → V_{n+1} produces a state both Core versions agree on; or explicit reset path emits the documented reset event.

Done when: `verify-epoch` reproduces `newStateRoot` from chain alone and all E2E fixtures pass in CI.

### Phase 4 — CortexBench V0
**Owner**: Benchmark subagent. **Goal**: the actual law of nature for the organism.

- [ ] Generators for each anchored family, replaying public benchmark records into Cortex event format.
- [ ] `experienceCorpusRoot` builder (Merkle root over the corpus event set this epoch evaluates against).
- [ ] Hidden shard derivation via `deriveWorldSeedU128(H_e, miner, solveIndex, parentStateRoot)` — reuses existing coordinator machinery.
- [ ] Per-epoch commit/reveal of `H_e` using the existing `epoch-secret` pattern.
- [ ] Score formula fixed (weights from Phase 0).
- [ ] Protected-regression set: ~50 anchored items per family, frozen at corpus snapshot. Evaluated **fully only at merge**; at screener, evaluated on a small random subset (cost optimization). Public-replay equivalence preserved because the merge-time evaluation is canonical.
- [ ] Score report: baseline, candidate, delta, family breakdown, protected-regression result, latency, state-size compliance.
- [ ] Benchmark runs on commodity CPU within budget.
- [ ] Pass/fail threshold tuned to: random ~0%, weak 5–10%, strong 20–30% on internal miner simulations.

E2E tests (must pass in CI before phase complete):
- [ ] **Anchored-source loader parity**: each family's loader produces a `experienceCorpusRoot` that re-derives byte-identically from the published source files; CI fetches sources via pinned hashes.
- [ ] **Commit/reveal cycle**: simulate a full epoch — `setEpochCommit` → mine challenges → `revealEpochSecret` → recompute every miner's `shardId` from the revealed seed and confirm it matches what was issued at challenge time.
- [ ] **Hidden-shard non-enumeration**: across 1k simulated epochs, no shard descriptor repeats with probability > 1/2^60.
- [ ] **Score reproducibility**: identical (corpus, state, seed) produces byte-identical score reports on three machines.
- [ ] **Protected-regression coverage**: a synthetic patch that drops any single protected anchor is rejected at merge time (full eval) even if it passes screener (subset eval).
- [ ] **Family weight enforcement**: changing one family's score in isolation moves the composite by exactly its weight (within float tolerance).
- [ ] **Pass-rate target gate**: synthetic miner mix (random, weak, strong) hits the {~0%, 5–10%, 20–30%} bands; CI fails outside ±3% of bounds.
- [ ] **Saturation detector**: synthetic flat-score epoch sequence triggers the saturation alarm at K=10.
- [ ] **Hard-veto coverage**: state-size violation and protected-regression each veto regardless of weighted score.

Done when: random no-op fails; hand-designed useful patches pass; adversarial overfit fails hidden + protected tests; pass-rate bands hit on the synthetic mix.

### Phase 5 — Patch mining API + process topology
**Owner**: Coordinator/API subagent.

- [ ] New `packages/cortex-server` process. Endpoints: `/v1/cortex/challenge`, `/v1/cortex/submit`, `/v1/cortex/state`, `/v1/cortex/epoch/:id`, `/v1/cortex/eval-report/:hash`, `/v1/cortex/merge-bonus/claim-calldata`. Path-prefixed routing only — no `?lane=cortex` query strings.
- [ ] Existing coordinator gets `packages/coordinator/src/cortex-handler.ts` exposing `/internal/miner-tier`, `/internal/sign-cortex-receipt`, `/internal/epoch`, `/internal/rate-limit-budget`, `/internal/outstanding-challenge`. Strictly additive — no changes to `/v1/challenge` or `/v1/submit` request paths.
- [ ] `cortex-store.ts` in the SWCP process tracks: outstanding-challenge state across lanes, per-epoch merge-bonus funding receipts, multiplier-claim ledger.
- [ ] Cortex receipts use the existing `BotcoinMining` EIP-712 domain with the field mapping in §6.
- [ ] Single shared rate-limit accounting across lanes (budget held in SWCP process; Cortex queries before signing).
- [ ] All Cortex submissions stored in dedicated dataset namespace `dataset/v2/cortex/epoch/{N}/...`. Separate SQLite queue (`cortex/queue.db`) and a parallel storage-worker process. SWCP HF export pipeline untouched.
- [ ] Lane disabled by stopping `cortex-server` or removing the nginx upstream; SWCP unaffected (proven by latch/unlatch test in Phase 8).

E2E tests (must pass in CI before phase complete):
- [ ] **Full miner loop e2e**: scripted miner (HTTP + Core SDK only) requests `/v1/cortex/challenge`, computes a patch, submits to `/v1/cortex/submit`, receives signed receipt, calls `BotcoinMiningV3.submitReceipt` on a Base mainnet fork, observes `nextIndex` / `lastReceiptHash` updated, calls `claim` and receives the expected tier credits.
- [ ] **Cross-lane outstanding-challenge guard**: a miner with an open SWCP challenge attempting `/v1/cortex/challenge` receives 409; same vice-versa; expiry releases the lock.
- [ ] **Shared rate-limit budget**: a miner exhausting their submit budget on SWCP cannot bypass it on Cortex (and vice-versa); reset window verified.
- [ ] **Receipt field mapping**: signed receipt for a Cortex submission verifies on the contract; `rulesVersion = 0xC0` is observable on-chain; an explorer-style decoder reads back `parentStateRoot`, `experienceCorpusRoot`, `shardCommitment`, `patchHash` from the documented field aliases.
- [ ] **Internal RPC integration**: `cortex-server` boots, calls each `/internal/*` endpoint against a live SWCP process, and successfully signs a receipt without ever holding the signing key locally.
- [ ] **Path routing isolation**: nginx fixture proves `/v1/challenge` routes to SWCP and `/v1/cortex/challenge` routes to cortex-server; deliberately malformed `?lane=cortex` query string on the SWCP path does not reach cortex-server.
- [ ] **Latch/unlatch parity**: stopping `cortex-server` mid-flight does not affect any open SWCP challenge or claim; restart resumes Cortex queue from SQLite without duplicate submissions.
- [ ] **Storage namespace isolation**: a Cortex submission never lands in the SWCP HF export pipeline; a SWCP submission never lands in `dataset/v2/cortex/*`.
- [ ] **SQLite crash-recovery**: simulated kill-9 mid-submission preserves queue integrity; replay reconciles to chain state.

Done when: a miner using only HTTP + an LLM API can earn a Cortex screener receipt that pays through the same claim path as a normal SWCP receipt and all process-topology E2E fixtures pass.

### Phase 6 — Credit + reducer mechanics
**Owner**: Economics + Protocol subagents.

- [ ] Reducer spec: deterministic greedy-by-marginal-gain, target-index conflict skip, semantic-conflict marginal-gain check, public input set posted on chain (so anyone re-runs reducer and matches).
- [ ] Separate event records: `ScreenerPassed` (signed receipt → credits via `BotcoinMiningV3.submitReceipt`) vs `PatchMerged` (multiplier-eligible via `CortexMergeBonus`). No double-credit.
- [ ] Multiplier capped at 1.5× per miner per epoch in V0; cap enforced both off-chain (coordinator funding) and on-chain (`CortexMergeBonus`).
- [ ] Multiplier paid via `CortexMergeBonus.claimMergeBonus` after the audit window closes; coordinator funds the contract per epoch.
- [ ] Per-miner submit caps shared across lanes via `/internal/rate-limit-budget`.
- [ ] Single outstanding challenge across lanes via `/internal/outstanding-challenge`.
- [ ] Filler rejection at screener: no-op, random mutation, public-test overfit, protected-regression breaches, size abuse.
- [ ] Simulation: weak / medium / strong miner mix. Verify screener distributes broadly and the multiplier does not allow one miner to capture the epoch pool.

E2E tests (must pass in CI before phase complete):
- [ ] **Reducer determinism**: 1k synthetic patch sets, each shuffled 100 ways, produce identical `patchSetRoot` and `newStateRoot` regardless of input order.
- [ ] **Target-overlap rejection**: two patches touching word index 117 — only the higher (scoreDelta, -patchSize, patchHash) one is accepted; the other is logged with a stable rejection code.
- [ ] **Semantic-conflict rejection**: a patch whose marginal gain on top of already-accepted patches drops below threshold is skipped even when target indices don't overlap.
- [ ] **Public-replay equivalence**: an external script that consumes only the on-chain reducer input set re-derives the same accepted patch set as the coordinator.
- [ ] **No double-credit**: `ScreenerPassed` and `PatchMerged` events for the same `(epoch, miner, patchHash)` produce exactly one tier-credit issuance plus at most one multiplier accrual.
- [ ] **Multiplier cap (off-chain & on-chain)**: a miner with two merged patches in epoch e accrues only `(MERGE_MULTIPLIER − 1) × claimBaseForMerger(e, miner)` total — single uplift cap honored both in the funding tx and in `CortexMergeBonus.claimMergeBonus`.
- [ ] **100-miner adversarial sim**: weak/medium/strong mix over 50 epochs; Gini coefficient of credit distribution stays below documented threshold; no single miner captures > 25% of any epoch's combined-lane credits.
- [ ] **Filler-rejection battery**: no-op, random mutation, public-test overfit, protected-regression breach, oversize patch — each rejected at screener with the documented error code; rejection rate matches expected distribution.
- [ ] **Cross-lane guard simulation**: a miner attempting concurrent SWCP and Cortex submissions never produces two valid receipts; the second always 409s.

Done when: simulation shows broad credit distribution while official state still improves epoch-over-epoch and all reducer/credit E2E fixtures pass.

### Phase 7 — Pre-release local iteration
**Owner**: Core + Benchmark + Research subagents.

Required experiments (run on CortexBench V0):
- Baseline A: empty Cortex
- Baseline B: simple dense-key Cortex
- Baseline C: binary-key Cortex
- Baseline D: multi-slot late-interaction-inspired Cortex
- Baseline E: revocation-aware Cortex

Completion checklist:
- [ ] Each baseline run; metrics: retrieval accuracy, stale rejection, compression survival, latency, patch sensitivity, overfit resistance.
- [ ] Select Core decoder V0 from baseline winner.
- [ ] Freeze `coreVersionHash`.
- [ ] Genesis state = winning baseline's encoded state, **not zero**.
- [ ] Publish golden test vectors and `botcoin-cortex verify-epoch` dry-run.
- [ ] Adversarial report listing known failure modes.

E2E tests (must pass in CI before phase complete):
- [ ] **Baseline reproducibility**: each baseline (A–E) runs end-to-end on CortexBench V0 on three machines; published metrics match within documented float tolerance.
- [ ] **Genesis state encoding round-trip**: winner-baseline encoded state pack → unpack → byte-identical; root matches the published `genesisStateRoot`.
- [ ] **Golden test vectors**: a published bundle of `(state, patch, expected eval-report hash, expected new state root)` triples replays byte-identically.
- [ ] **`verify-epoch` dry-run**: a synthetic 10-epoch chain log replays end-to-end against frozen Core V0 with zero divergence.
- [ ] **Adversarial fuzz**: ≥1M fuzz-generated patches against the winner baseline produce no panic, no nondeterminism, no protected-regression false-positive.
- [ ] **Patch-sensitivity report**: documented score deltas for canonical patch families (key-update, slot-replace, revoke) on each baseline; CI fails on regression.
- [ ] **Overfit-resistance gate**: synthetic miners targeting one family score < strong-miner band on the composite.

Done when: Core V0 beats empty/simple baselines, remains deterministic, cheap, and auditable, and the adversarial fuzz battery passes clean.

### Phase 8 — Testnet Cortex organism
**Owner**: Integration subagent.

- [ ] CortexRegistry deployed to testnet.
- [ ] `cortex-server` running.
- [ ] ≥100 epochs, ≥1,000 patch submissions processed.
- [ ] **Golden e2e fixture (CI-gated)**: genesis state → challenge → patch → Core eval → screener receipt → reducer → finalized root → clean-machine `verify-epoch` reproduces. Failing this fixture blocks any merge.
- [ ] Independent auditor reproduces ≥10 finalized epoch roots, **including ≥3 reproductions starting from a snapshot-anchored mid-history epoch** (e.g., reproduce epoch 75 starting from snapshot at epoch 50, not from genesis). Validates snapshot path.
- [ ] State improves across epochs under fixed Core; does not collapse into no-op or random mutation.
- [ ] Screener pass rate stays near target band; multiplier does not concentrate to one miner.
- [ ] **Saturation alarm**: alert when median score-delta < 1% for K=10 consecutive epochs. Triggers difficulty bump or family-weight adjustment.
- [ ] Metrics dashboard:
  - pass rate (overall, per-family, per-tier)
  - score-delta distribution
  - protected-regression rate
  - reducer rejects (target-overlap vs semantic-conflict)
  - eval latency p50 / p99
  - state root per epoch
  - corpus snapshot hash
  - merge-multiplier distribution across miners
- [ ] Latch/unlatch tested twice without affecting SWCP.

E2E tests (must pass in CI before phase complete):
- [ ] **Golden e2e fixture (CI gate)**: genesis → challenge → patch → Core eval → screener receipt → reducer → finalize → clean-machine `verify-epoch`. Failing this blocks all merges.
- [ ] **Sparse mid-history replay**: reproduce ≥3 finalized epoch roots starting from a snapshot at epoch `e_k`, not from genesis. Validates snapshot path under realistic gap sizes.
- [ ] **External auditor reproduction**: an auditor running only the published Core V0 binary + a Base RPC endpoint reproduces ≥10 finalized roots without coordinator data.
- [ ] **Saturation alarm fires**: synthetic flat-score sequence over 10 epochs triggers the alarm and surfaces in the metrics dashboard.
- [ ] **Multisig override drill on testnet**: a deliberately-divergent epoch is reverted by the operator multisig within the audit window; `CortexMergeBonus` is not funded for that epoch.
- [ ] **Pass-rate band hold**: across the testnet run, screener pass rate per tier stays within the documented band ±5%; alarm fires on any 10-epoch breach.
- [ ] **Multiplier-distribution gate**: no single miner receives > 25% of total merge bonus across the testnet run.
- [ ] **Latch/unlatch rehearsal**: stop and restart `cortex-server` ≥2 times mid-epoch; SWCP claim parity preserved; Cortex queue resumes without duplicate submissions.
- [ ] **Metrics dashboard correctness**: synthetic injected epoch produces the expected pass-rate, score-delta histogram, protected-regression rate, and reducer-rejection breakdown on the live dashboard.
- [ ] **Storage/HF export non-interference**: SWCP HF export tooling runs cleanly in parallel with cortex-server traffic; no SWCP record contains a Cortex artifact and vice-versa.

Done when: testnet Cortex improves over time, can be fully replayed from chain commitments — including a sparse replay from a mid-history snapshot — and all testnet E2E fixtures pass.

### Phase 9 — Mainnet sidecar launch
**Owner**: Release subagent.

- [ ] Mainnet `CortexRegistry` and `CortexMergeBonus` deployed.
- [ ] Cortex lane disabled by default until `cortex-server` is started.
- [ ] Dry-run epoch finalized; zero merge-bonus funding.
- [ ] Public docs: miner guide, verifier guide, state spec, benchmark spec, contract addresses, **receipt field mapping** (§6), **multisig key set + revert procedure** for the audit window.
- [ ] First reward epoch: `MERGE_MULTIPLIER = 1.5×`, capped on-chain per miner per epoch.
- [ ] Audit-and-multisig-override window enforced before `CortexMergeBonus` is funded for an epoch.
- [ ] Emergency disable tested for both contracts.
- [ ] Post-epoch audit report published.
- [ ] Tracked V1 paths (not blocking V0):
  - `BotcoinMining.submitCortexReceipt(...)` sister function with explicit Cortex field names — removes the receipt-field overloading.
  - Bond-based or ZK fraud proofs for the audit window — replaces the multisig override.

E2E tests (must pass before mainnet enable):
- [ ] **Mainnet dry-run epoch**: full challenge → submit → finalize → snapshot cycle on mainnet `CortexRegistry` with `MERGE_MULTIPLIER` set but `CortexMergeBonus` deliberately unfunded; observe events; lane disabled at end.
- [ ] **First-reward audit trail**: first paying epoch produces a public reproducibility report — chain logs alone reproduce `newStateRoot`, reducer output, and the `(miner, bonusBOTCOIN)` funding root byte-identically.
- [ ] **Audit-window enforcement on mainnet**: pre-window `claimMergeBonus` reverts; post-window claim succeeds for a real merging miner.
- [ ] **Multisig revert rehearsal**: dry-run divergent-epoch revert on mainnet against a synthetic divergence (announced in advance); 2-of-N revert succeeds; bonus funding blocked.
- [ ] **Emergency disable rehearsal**: pause `CortexRegistry` mid-epoch on mainnet; SWCP claim parity preserved end-to-end through a real claim transaction.
- [ ] **Receipt-mapping observability**: a third-party explorer (built only from the published mapping doc) decodes a Cortex receipt's fields correctly on mainnet.
- [ ] **Pool-mode mainnet test**: at least one pool-contract claim of merge bonus succeeds via `triggerMergeBonusClaim`.
- [ ] **Multisig key set published and verified**: each operator key on the published set successfully signs a no-op test multisig transaction before first reward epoch.

Done when: Cortex lane can be enabled, mined, finalized, audited, and disabled without changing the base Botcoin protocol or receipt path; all mainnet rehearsals are signed off by independent operators.

## 10. Subagent assignments

```
Research        source review, benchmark anchoring, failure modes
Protocol        state schema, patch rules, reducer spec, receipt field mapping
Core            decoder, evaluator, root computation, CLI, perf budget
Benchmark       CortexBench generator, hidden seeds, score weights
EVM             CortexRegistry + CortexMergeBonus, events (incl. compactPatchBytes), snapshots, audit-window multisig
Coordinator     cortex-server process, /internal/* RPC layer (incl. outstanding-challenge), dataset namespace, rate-limit unification, merge-bonus funding tx
Economics       credits, multiplier cap, reducer fairness, merge-bonus pool sizing, anti-centralization sim
Adversarial     overfit, no-op, spam, replay, protected-regression, multiplier-stacking attacks
Docs            miner guide, verifier guide, receipt mapping, V1 contract-upgrade path
```

## 11. The most important unresolved question

The benchmark is the whole game. A bad CortexBench creates a bad organism.

The first hard requirement is not "write contract code." It is:

> Prove that CortexBench rewards useful memory compression — not random mutation, not benchmark overfit, not giant-miner search advantage, not a single weak family that saturates after a few hundred epochs.

Anchoring to LIMIT / MTEB / LoCoMo / MemoryAgentBench / MemoryArena is the antibody. We are not inventing the test; we are configuring well-validated tests for an on-chain memory codec under a 1024-word budget.

## 12. Final system shape

- **SWCP mining**: unchanged. `BotcoinMiningV3` unmodified.
- **Cortex lane**: separate `cortex-server` process behind same coordinator API origin (`/v1/cortex/*` path-prefix routing). Screener credits issued via the existing `BotcoinMiningV3.submitReceipt` path.
- **On-chain anchors**: two new contracts.
  - `CortexRegistry` — state roots, full patch payloads, periodic snapshots, finalization events. Zero reward logic.
  - `CortexMergeBonus` — multiplier payout, mirrors existing `BonusEpoch` pattern. Funded per epoch by the coordinator after the audit window.
- **Core**: deterministic decoder/evaluator in `packages/cortex`; <10 ms p50 eval budget; worker-pool execution.
- **State**: 1024-word compact memory codec.
- **Benchmark**: CortexBench V0 anchored to LIMIT / MTEB / LoCoMo / MemoryAgentBench / MemoryArena. Long-horizon weighted 60%.
- **Credits**: tier-equivalent screener pay through the existing `BotcoinMiningV3.submitReceipt` path with a published receipt field mapping. Merge multiplier (1.5×, on-chain capped) paid via `CortexMergeBonus.claimMergeBonus` after the audit window closes — coordinator cannot retroactively reweight V3 credits, so a sister bonus contract is the only honest V0 path.
- **Cross-lane safety**: single outstanding challenge per miner across lanes; shared rate-limit budget.
- **Verification**: coordinator fast path + `botcoin-cortex verify-epoch` replay path + 6-hour audit window with multisig override before merge bonus funding (V0 trust assumption; V1 replaces with bond/ZK).

The clean thesis: Botcoin Cortex turns mining into public proof-of-memory-improvement, paid through the same economic spine the protocol already runs on. The organism is not a model and not a text database. It is a compact, on-chain-rooted memory codec that becomes better only when miners prove improvements under Botcoin Core — and the proof flows into the credit system that pays them today, with merge bonuses paid through a sister contract that mirrors the bonus-epoch flow they already know.

## 13. Repository, handoff, and process discipline

This work ships as its own standalone GitHub repository — **not** a branch of the existing coordinator repo. The cortex-server is a separate process with its own SQLite, worker pool, and lifecycle; the repo boundary mirrors the process boundary. After on-chain contracts are deployed, the coordinator-server dev clones this repo, follows `instructions.md`, runs the test suite, points it at the deployed contract addresses, and goes live.

### 13.1 Repository creation (Phase 0 task)

- [ ] **Create as PRIVATE GitHub repo via `gh` CLI**:
  ```
  gh repo create botcoinmoney/cortex --private --description "Botcoin Cortex — on-chain memory codec mining lane" --clone
  ```
- [ ] Default branch `main`. Branch protection: require PR, 1 approval, all CI green.
- [ ] Repo stays private through V0 mainnet launch. Public-readable docs ship as a separate published artifact (or unprivate post-launch by explicit decision, not default).
- [ ] License decision recorded in `LICENSE` before any third-party contributor PR.

### 13.2 Repository layout (plug-and-play target)

The repo is structured so that on launch day the coordinator-server dev runs a short, fully-documented sequence and is mining live. Required top-level layout:

```
cortex/
├── README.md                       # one-paragraph what + link to instructions.md
├── instructions.md                 # plug-and-play wiring + run guide (§13.4)
├── context.md                      # AI-handoff state file (§13.5) — STRICTLY MAINTAINED
├── LICENSE
├── .github/
│   └── workflows/                  # CI: lint, type, unit, E2E matrix per phase
├── packages/
│   ├── cortex/                     # Core decoder/evaluator/CLI (Phase 3 deliverable)
│   ├── cortex-server/              # standalone process (Phase 5)
│   └── cortex-handler/             # /internal/* RPC layer to drop into the SWCP coordinator
├── contracts/
│   ├── CortexRegistry.sol
│   ├── CortexMergeBonus.sol
│   ├── script/                     # forge deploy scripts
│   └── test/                       # forge fork tests
├── benchmark/
│   ├── cortex_bench_v0.md
│   ├── generators/                 # anchored-source loaders
│   └── fixtures/                   # frozen golden corpora + protected-regression set
├── specs/
│   ├── cortex_state_v0.md
│   ├── cortex_schema_v0.json
│   ├── packing_spec_v0.md
│   ├── merkleization_spec_v0.md
│   ├── patch_format_v0.md
│   ├── reducer_v0.md
│   └── receipt_field_mapping.md
├── ops/
│   ├── nginx.cortex.conf           # path-prefix upstream snippet
│   ├── multisig.md                 # operator key set + revert procedure
│   ├── runbook.md                  # incident, pause, unpause, audit-window-revert
│   └── env.example                 # sanitized .env template
└── test/
    └── e2e/                        # cross-package golden fixtures (Phase 8 gate)
```

Plug-and-play guarantee: `packages/cortex-handler` exports a single mountable Express/Fastify router the existing coordinator imports in **one line** plus signing-key wiring. No edits to existing SWCP routes. No edits to `BotcoinMiningV3`.

### 13.3 Commit cadence (strict)

- [ ] **Commit per completed checklist item** at minimum. Larger work splits into atomic commits with conventional-commit prefixes (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `spec:`, `bench:`, `ops:`).
- [ ] Push to remote at least once per working session — never let local commits sit overnight.
- [ ] PRs land squashed into `main`; PR title is the deliverable, not the file list.
- [ ] CI must be green before merge. No `--no-verify`. No `--force-push` to `main`.
- [ ] Tag at each phase boundary: `v0.phase-1`, `v0.phase-2`, … `v0.mainnet`. Phase tags are immutable handoff anchors.
- [ ] Co-author trailer required on AI-assisted commits.

### 13.4 `instructions.md` — plug-and-play wiring

`instructions.md` is the contract between this repo and the coordinator-server dev. It MUST be kept current and MUST be executable end-to-end on a fresh clone with only the contents of the file. Required sections in order:

1. **Prerequisites**: Node version, package manager, foundry version, supported OS, required RPC access.
2. **Clone and bootstrap**: exact commands; bootstrap script also runs golden fixtures to prove a clean clone passes.
3. **Environment variables** — every variable lives in `ops/env.example` with a one-line description. Required:
   - `BASE_RPC_URL` — chain RPC for the coordinator process.
   - `COORDINATOR_SIGNING_KEY` — existing SWCP signer; reused (never duplicated).
   - `BOTCOIN_MINING_V3_ADDRESS` — already-deployed contract; unchanged.
   - `CORTEX_REGISTRY_ADDRESS` — Phase 9 deploy output.
   - `CORTEX_MERGE_BONUS_ADDRESS` — Phase 9 deploy output.
   - `MULTISIG_OPERATOR_ADDRESSES` — comma-separated list of audit-window override signers.
   - `CHALLENGE_WINDOW_SECONDS` (default `21600`).
   - `SNAPSHOT_EPOCH_INTERVAL` (default `100`).
   - `MERGE_MULTIPLIER_BPS` (default `15000` for 1.5×).
   - `CORTEX_DB_PATH` (default `data/cortex/queue.db`).
   - `CORTEX_WORKER_POOL_SIZE`.
   - `INTERNAL_RPC_URL` — pointer at the SWCP process for `/internal/*`.
   - `INTERNAL_RPC_SHARED_SECRET` — auth between cortex-server and SWCP coordinator.
4. **nginx integration**: copy the snippet from `ops/nginx.cortex.conf`; `/v1/cortex/*` upstream definition; `nginx -t` and reload.
5. **Coordinator integration**: a one-line import of `packages/cortex-handler` into the existing coordinator entrypoint, exact line and exact file path. Plus `cortex-store.ts` migration application.
6. **Contract deploy**: forge script invocations for `CortexRegistry` and `CortexMergeBonus`, multisig configuration tx, post-deploy smoke check.
7. **Run the E2E suite**: `pnpm test:e2e` (or equivalent). Every Phase's E2E gate runs. Output is human-parseable pass/fail per phase.
8. **Start cortex-server**: systemd unit (or process manager) snippet; `/healthz` endpoint check; first scripted-miner roundtrip.
9. **Operations**: pause, unpause, audit-window revert procedure, key rotation, log locations, metric endpoints, dashboard URL.
10. **Rollback**: how to disable the lane cleanly, what state survives, what to do if a Cortex-only process dies.

The litmus test for `instructions.md`: a senior engineer who has never seen this repo runs every command in order on a fresh box and reaches a green `/healthz` plus a successful scripted-miner roundtrip without asking a single question.

### 13.5 `context.md` — strict AI-handoff rule

`context.md` is the single source of truth for "where the project is right now," updated by every agent before ending a session. It is the handoff baton between AI agents — and between AI and human — across context windows, sessions, and repo clones.

**Strict rules**:
- [ ] `context.md` lives at repo root. Never in a subdirectory. Never duplicated.
- [ ] Updated **before every git push** that closes a meaningful unit of work. Not after — before, so the push and the context update land in the same commit when possible.
- [ ] CI fails the PR if `context.md` is stale relative to `main` (heuristic: a checklist item was checked in this PR but `context.md` "Current state" or "Recent decisions" were not touched).
- [ ] Never deleted. Never reset. New entries append; outdated entries are crossed out with a date and the reason, not erased.
- [ ] Required sections, in this order:

```markdown
# Cortex — Current Context

## Current state
<1–2 paragraphs. What is built, what is partially built, what is not started. Phase number. Branch.>

## Next steps
- 3–5 concrete next actions, in priority order. Each ≤ 1 line. Each maps to a checklist item in ORGANISM_CORTEX_STATE_PLAN.md or a tracked issue.

## Open questions / blockers
- Anything that needs a human decision, an external resource, or a dependency that hasn't landed. Empty list is allowed and preferred.

## Recent decisions (last 10)
- YYYY-MM-DD — <one-line decision> — <one-line rationale>
- (older entries roll off after 10; never deleted, just moved to `context-archive.md`)

## How to resume
- The exact next command an agent should run on a fresh clone (e.g., `pnpm install && pnpm test:e2e -- --filter phase-3`).
- The exact branch and PR (if any) the agent should continue.
```

- [ ] **Agent handoff protocol**: when an AI agent picks up work, it reads `context.md` first, then reads `ORGANISM_CORTEX_STATE_PLAN.md` for the relevant phase, then reads only the files it needs. It does not skim the whole repo. The whole point of `context.md` is to make that unnecessary.
- [ ] **Authorship**: each `context.md` update commit is attributed to the agent or human who made it. Co-author trailer required on AI updates.
- [ ] **No drift**: if `context.md` and `ORGANISM_CORTEX_STATE_PLAN.md` disagree on Phase status, `ORGANISM_CORTEX_STATE_PLAN.md` is canonical. Reconcile in the next commit.

### 13.6 CI gates summary

CI must enforce, in order: lint → type → unit → contract (forge) → integration → phase-scoped E2E. The phase-scoped E2E suites from §§ Phase 1 – Phase 9 are tagged `e2e:phase-N` and `pnpm test:e2e -- --filter phase-N` runs them in isolation. The merged `e2e:all` suite is the gate for `main`.

A green `e2e:all` plus a current `context.md` is the precondition for every merge into `main`.
