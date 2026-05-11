# CoreTex Sealed Epoch Evaluation Hardening Plan

Last updated: 2026-05-11.

Audience: calibration / coordinator implementation agent.

> **⚠ SUPERSEDED.** Production picks **per-patch on-chain randomness** instead
> of commit/reveal sealed evaluation. See
> `docs/CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md` for the live design.
>
> This document is retained for design history. The S0–S6 phases below describe
> a defense against the same threat (adaptive hidden-pack probing) using a
> different mechanism — commit/reveal + per-epoch sealed packs. The replacement
> design binds each patch's eval seed to a future Base blockhash the coordinator
> cannot observe at patch-receive time, keeping `/coretex/evaluate` live while
> achieving the same anti-pre-testing property with ~5× less code.
>
> The screener-admission helper from §Phase S5 survives the rip and moves to
> `eval/live-eval-admission.ts` for the live-eval flow. Everything else is
> removed.

## Original Intent (historical)

This plan was the required pre-launch hardening before the per-patch on-chain
randomness design was finalized. It removes the live hidden-eval oracle while
preserving the retrieval-native benchmark, open-source verifier, 24-hour BOTCOIN
epoch cadence, fixed 1024-word substrate, pinned CPU models, and public replay.

## Executive Decision

The auditor's core finding is correct:

- A public scorer is fine.
- A public document pool is fine.
- A public active hidden-eval oracle is not fine.

`POST /coretex/evaluate` must not be a live, miner-accessible endpoint that
returns full retrieval scores against the active hidden pack before a patch is
irrevocably committed. If wired that way, it becomes an adaptive leaderboard
over the holdout set and weakens the benchmark signal.

The fix is sealed epoch evaluation:

> A patch can be scored against the active hidden pack only after the patch is
> committed and the commit window is closed.

Miners may know the code, bundle, model pins, visible corpus, public document
pool, metric, and patch format. They must not know or query the active hidden
pack/qrels before their patch is locked.

## Current Code Facts

These are based on the current repository, not only the docs:

- `packages/cortex/src/eval/retrieval-benchmark.ts` is the right reward-law
  direction: substrate-reachable candidates are reranked with the pinned
  reranker and scored with retrieval-dominant `nDCG@10`.
- `packages/cortex/src/eval/hidden-query-pack.ts` derives deterministic packs
  from `(epochId, evalSeed, corpus, profile)` and supports multi-strata
  matching through `strataOf(event)`.
- `packages/cortex/src/coordinator/retrieval-data-source.ts` masks
  `eval_hidden` and `canary` corpus records/embeddings from read endpoints,
  but still accepts a host-provided `evaluate` callback for
  `POST /coretex/evaluate`.
- `packages/cortex-server/src/routes/submit.ts` is an older interactive
  screener flow: it evaluates a patch and returns `evalReport` before signing
  a screener receipt. This route is not the sealed launch flow.
- `packages/cortex/src/reducer/reducer.ts` already supports deterministic
  epoch-parent batch reduction: all candidate patches target the same epoch
  parent, are sorted by score delta, and are greedily applied with marginal
  re-evaluation.
- `contracts/src/CortexRegistry.sol` exposes `commitShard` / `revealShard`,
  `submitPatchAccepted`, `submitStateAdvance`, and `finalizeEpoch`. It can
  anchor replay artifacts, but it does not currently expose a miner-facing
  patch-commit primitive.
- BOTCOIN's existing `BonusEpoch` randomness uses a committed epoch secret plus
  a predetermined future Base block hash. That is a useful pattern, but
  CoreTex eval randomness must additionally bind to the sealed CoreTex
  candidate set.

## Threat Model

CoreTex must prevent these launch-killing failures:

1. **Adaptive hidden-set probing**: a miner repeatedly calls full evaluation,
   observes deltas or per-query failures, and adapts patches to the active
   hidden pack.
2. **Privileged coordinator mining**: an actor with pre-reveal access to hidden
   eval material mines or leaks patches.
3. **Known-pack overfitting**: active hidden queries/qrels/embeddings are known
   before the patch is locked.
4. **Latency race**: first-come live-root updates reward API speed more than
   retrieval improvement.
5. **Screener farming**: cheap syntactic validity earns unbounded 1x credits.

The plan below closes those without hiding the scorer or adding a corpus
hardness knob.

## Non-Negotiable Invariants

- Active hidden eval artifacts are unknown until after patch commitments close.
- Hidden packs are sampled after commitment, used once, revealed for replay,
  and retired forever.
- `/coretex/evaluate` is not a public live hidden-set oracle.
- Evaluation reports with per-query details are published only after the pack
  is retired.
- The canonical state advances only for confirmed retrieval improvement.
- Miners receive real-time status as far as it is safe:
  `committed`, `revealed`, `screened`, `finalist`, `accepted`, `rejected`.
  Hidden per-query diagnostics wait until settlement/reveal.
- Coordinator/operator/calibration wallets are disqualified from CoreTex mining
  unless a later governance process establishes an auditable separation model.
- Rate limits remain abuse-prevention only: flat per-miner/API ceilings plus
  global backpressure. No credit-weighted rate limiting.

## Randomness

The existing BOTCOIN bonus randomness is the correct local pattern:

```text
bonusRandomness = H(epochSecret, predeterminedFutureBlockHash)
```

For CoreTex sealed evaluation, reuse that pattern but bind it to the sealed
candidate set:

```text
coretexEvalSeed = H(
  "botcoin-coretex-sealed-eval-v1",
  epochId,
  epochParentRoot,
  corpusRoot,
  bundleHash,
  commitmentRoot,
  epochSecret,
  futureBlockHash,
  optionalDrandRoundHash
)
```

Rules:

- `epochSecret` must be committed before the epoch starts.
- `futureBlockHash` must be for a block chosen before commitments are known
  and produced after the commit window closes.
- `commitmentRoot` must be anchored before `epochSecret` is revealed.
- `optionalDrandRoundHash` is recommended for extra coordinator/sequencer
  independence, but launch can use the existing bonus-epoch blockhash pattern
  if the target block is after commit close.
- Never use a coordinator-only seed as the sole eval seed.

This makes the hidden pack unpredictable to miners and coordinator-affiliated
actors until the candidate set is locked.

## Sealed Epoch Lifecycle

### 1. Epoch Open

Publish:

- epoch id
- epoch parent substrate root
- current corpus root
- bundle hash / `coreVersionHash`
- visible split and visible coverage hints
- patch format and substrate layout
- commit-window close time
- future randomness target, if available

Do not publish:

- active hidden query pack
- active hidden qrels
- active hidden embeddings
- per-query hidden eval diagnostics

### 2. Commit Window

Miners submit commitments:

```text
patchCommit = H(
  "botcoin-coretex-patch-commit-v1",
  epochId,
  epochParentRoot,
  minerAddress,
  bundleHash,
  patchBytes,
  salt
)
```

Launch implementation options:

1. Preferred: add a miner-facing on-chain commitment event/contract surface.
2. Acceptable launch bridge: coordinator stores commitments, publishes a
   signed commitment ledger, and anchors `commitmentRoot` on chain before
   eval seed reveal.

The accepted commitment response may include:

```json
{
  "status": "committed",
  "commitmentHash": "0x...",
  "epochId": 123,
  "parentStateRoot": "0x..."
}
```

It must not include hidden score, qrel hits, retrieved docs, or per-query
feedback.

### 3. Commit Close And Seed Derivation

At commit close:

1. Sort commitments deterministically.
2. Deduplicate exact commitment hashes.
3. Compute `commitmentRoot`.
4. Anchor `commitmentRoot`.
5. Capture the configured future randomness.
6. Reveal the committed epoch secret.
7. Derive `coretexEvalSeed`.
8. Derive `gatePack` and `confirmPack`:

```text
gateSeed    = H(coretexEvalSeed, "gate")
confirmSeed = H(coretexEvalSeed, "confirm")
```

The hidden pack now exists, but the miner's patch was already locked.

### 4. Reveal Window

Miners reveal:

```json
{
  "commitmentHash": "0x...",
  "patchBytes": "0x...",
  "salt": "0x..."
}
```

Coordinator/verifier checks:

- commitment recomputes exactly
- miner address matches
- epoch and parent root match
- patch decodes
- patch budget is 1-4 words
- reserved words/bits are untouched
- patch is not a no-op against epoch parent
- duplicate key is unique enough to be eligible for screener credit

Safe real-time response:

```json
{
  "status": "revealed",
  "admission": "pending"
}
```

Invalid reveals are rejected immediately with stable coarse error codes.

### 5. Admission Screen

`/coretex/screen` remains a live endpoint, but in production it is structural
and visible-only. It must not run active hidden evaluation.

Screener credit is awarded only after post-commit admission, not for cheap
pre-commit syntax checks. The outcome can remain `OUTCOME_CORETEX_SCREENER_PASS`
for V4 compatibility, but the semantics change:

```text
screener-pass = unique revealed candidate that passed post-commit admission
```

Minimum admission checks:

- valid commitment/reveal
- valid patch encoding and target region
- no-op/duplicate collapse
- structural validity
- visible-split non-regression
- optional cheap retrieval proxy on a post-commit admission pack

Do not pay for:

- merely valid encoding
- unrevealed commitments
- duplicate patches
- visible-only overfit with hidden protected regression

Miners can know screener status in real time once this admission pass runs.
They should not receive hidden per-query details until the pack is retired.

### 6. Gate Evaluation

Every admitted reveal can be scored on `gatePack` with the production scorer:

```text
deltaGatePpm =
  score(candidateSubstrate, gatePack)
  - score(parentSubstrate, gatePack)
```

Only candidates clearing:

```text
deltaGatePpm >= minImprovementPpm + replayTolerancePpm + baselineVariancePpm
```

become finalists.

Live response can be coarse:

```json
{ "status": "finalist" }
```

or:

```json
{ "status": "not_finalist" }
```

No per-query hidden breakdown before settlement.

### 7. Confirmation Evaluation

Finalists are scored on `confirmPack`. A state advance requires:

```text
deltaGatePpm    >= threshold
deltaConfirmPpm >= threshold
protected floors pass
family catastrophic floors pass
structural floor passes
```

The confirmation pack is not overengineering. It is bounded because only
finalists pay the expensive second pass, and it reduces pack-luck advances.
Calibration may set `confirmPackSize < gatePackSize` if CPU budget demands it,
but confirmation must not be removed unless the calibration report proves the
single-pack false-positive rate is acceptable.

### 8. Batch State Selection

Use epoch-parent batch settlement, not first-come hidden evaluation.

Input:

- epoch parent state
- all finalists
- `gatePack`
- `confirmPack`
- current bundle profile

Selection:

```text
root = epochParentRoot
winners = []

for candidate in sort(finalists by confirmedDelta desc, patchSize asc, patchHash asc):
  if miner already won this epoch: continue
  if candidate conflicts with selected patches: continue

  recompute marginal gain on current root using confirmPack
  if marginal gain >= threshold:
    root = apply(candidate.patch, root)
    winners.push(candidate)

  if winners.length == maxAdvancesPerEpoch: break
```

The pure reducer in `packages/cortex/src/reducer/reducer.ts` is already close
to this shape. The implementation work is to replace the stub marginal
evaluator with the retrieval scorer over the confirmed pack and to ensure
events emitted for sequential winners are replayable from the previous winner's
root.

If using the current `CortexRegistry.submitStateAdvance` contract, submit
accepted winners sequentially after settlement so each event parent is the
current live root. For patches originally committed against the epoch parent,
the settlement layer must either:

- re-encode selected patch bytes with the actual sequential parent root before
  on-chain submission, or
- add/upgrade contract/replay logic to distinguish commitment parent from
  application parent.

Do not emit state-advance events that cannot be replayed by
`replayV4TransitionsFromLogs`.

### 9. Reveal Reports And Retire Pack

After settlement:

- publish eval reports
- publish gate/confirm query packs and qrels
- publish score root and commitment ledger
- reveal enough artifacts for independent replay
- mark those exact hidden pack records as spent for future hidden use

Detailed per-query reports are allowed only now.

## Endpoint Changes

### Public During Commit Window

Keep:

- `GET /coretex/substrate/current`
- `GET /coretex/substrate/:stateRoot`
- `GET /coretex/bundle/:bundleHash`
- `GET /coretex/client-bundle/:coreVersionHash`
- `GET /coretex/corpus/:recordId` with hidden/canary masking
- `GET /coretex/corpus/:recordId/embedding` with hidden/canary masking
- `GET /coretex/coverage-hints` for visible split only
- `GET /coretex/health`
- `POST /coretex/screen` as structural/visible-only, no hidden score

Add:

- `POST /coretex/commit`
- `POST /coretex/reveal`
- `GET /coretex/commit/:commitmentHash`
- `GET /coretex/epoch/:epochId/status`

Restrict:

- `POST /coretex/evaluate` becomes settlement/admin-only or visible-split-only
  in production. It must not return full active hidden evaluation to miners.

### Public After Settlement

Expose:

- `GET /coretex/eval-report/:hash`
- `GET /coretex/patch/:hash`
- `GET /coretex/corpus-delta/:epoch`
- retired hidden pack/qrels needed for replay
- score root / commitment root / patch set root metadata

## Screener Credit Policy

Keep only the salient screener changes:

1. No credit for pre-commit structural validity.
2. Screener-pass credit is post-commit admission credit.
3. At most `M` screener-credit-eligible candidates per miner per epoch.
4. Duplicate key collapse:

```text
duplicateKey = H(
  epochParentRoot,
  sortedTouchedWordIndices,
  normalizedPatchBytes,
  resultingStateRoot
)
```

5. Existing stake/account requirements and flat rate limits are the launch
   Sybil boundary. Do not add credit-weighted rate limits.

A small bond or scarce ticket may be added later if spam testing shows flat
limits plus stake are insufficient. Do not add a new token-economic system
before measuring actual pressure.

## Coordinator Eligibility Rule

Production rule:

> No actor with pre-reveal access to active hidden eval material may submit
> CoreTex mining work.

Disqualified at launch:

- coordinator owner/signing wallets
- calibration-host wallets
- wallets controlled by operator staff
- wallets funded or automated by privileged infra

This rule is simpler and more auditable than trying to prove privileged actors
did not inspect hidden material before committing.

## Corpus Lifecycle

This hardening does not replace the corpus plan. It depends on it:

- append-only signed corpus deltas
- deterministic split assignment
- hidden packs never reused after reveal
- `eval_hidden` and `canary` masked before reveal
- depth/strata quotas pinned in the bundle profile
- baseline re-evaluation and one-epoch major-delta grace retained

The operator must not manually tune "hardness." Corpus growth and fixed
substrate capacity are the difficulty source. `minImprovementPpm` continues
to adapt from observed advance rate and quality attempts, with major-delta
grace only to avoid threshold movement on stale baseline signal.

## Calibration Dev Implementation Phases

### Phase S0: Kill The Live Hidden Oracle

- Production route guard refuses public `/coretex/evaluate` against active
  hidden packs.
- `/coretex/evaluate` either returns `403 hidden-eval-sealed` to miners or runs
  visible-split evaluation only.
- Existing `packages/cortex-server/src/routes/submit.ts` is marked legacy for
  sealed launch and cannot sign active hidden screener receipts.

Gate:

- Unit test proves miner-authenticated `/coretex/evaluate` cannot access active
  hidden eval.
- Unit test proves admin settlement path still can run the scorer after commit
  close.

### Phase S1: Commit Ledger

- Add commitment schema, canonical hash, duplicate-key helper, and Merkle root.
- Add `/coretex/commit`, `/coretex/reveal`, and status endpoints.
- Persist commitment ledger by epoch.
- Anchor `commitmentRoot` before seed reveal.

Gate:

- Fuzz test commitment/reveal mismatch, duplicate, wrong miner, wrong epoch,
  wrong parent, malformed patch.
- Replay test recomputes `commitmentRoot` byte-identically.

### Phase S2: Randomness Binding

- Implement `coretexEvalSeed` derivation with epoch secret + future block hash
  + `commitmentRoot` + corpus/bundle/parent binding.
- Reuse BOTCOIN bonus-epoch blockhash machinery where possible.
- Add optional drand mix-in if calibration host has reliable access.

Gate:

- Test seed changes when any binding field changes.
- Test seed cannot be known before commitment close in the orchestrated flow.
- Test missing blockhash/reveal fails closed or enters documented no-score
  recovery mode.

### Phase S3: Sealed Gate/Confirm Evaluation

- Derive `gatePack` and `confirmPack` from `coretexEvalSeed`.
- Evaluate all admitted reveals on gate.
- Evaluate finalists on confirm.
- Suppress per-query report publication until settlement.

Gate:

- Phase-13 style real BGE-M3 + Qwen3 test passes with sealed packs.
- Adaptive probing simulation gets no useful hidden feedback before commit.
- Confirmation pack reduces one-pack false positives in calibration report.

### Phase S4: Batch Settlement

- Wire deterministic finalist sort and marginal re-evaluation.
- Use reducer-style epoch-parent selection.
- Emit replayable state advances sequentially, with correct parent roots.
- Publish commitment root, patch set root, score root, and eval reports.

Gate:

- Anvil e2e: commit -> seed -> reveal -> gate -> confirm -> state advance ->
  independent replay from chain logs.
- Multi-winner test: two non-conflicting patches both advance.
- Conflict test: overlapping patches select the higher confirmed marginal gain.
- Stale/latency test: earlier API response time does not affect winner order.

### Phase S5: Screener Credit Hardening

- Redefine screener credit as post-commit admission credit.
- Cap screener-credit-eligible candidates per miner per epoch.
- Collapse duplicates.
- Keep real-time status and receipt visibility after admission.

Gate:

- Structural-only spam earns zero credits.
- Duplicate patches earn at most one candidate admission credit.
- Miners can see committed/revealed/screened/finalist/accepted status without
  seeing hidden per-query diagnostics before settlement.

### Phase S6: Corpus Retirement And Replay

- Mark gate/confirm packs spent after reveal.
- Publish retired hidden artifacts for replay.
- Ensure future hidden pack derivation excludes spent pack IDs.

Gate:

- Replay from bundle + corpus + seed + chain logs reproduces accepted state
  roots.
- Reusing a retired hidden pack in a later epoch fails validation.
- Independent verifier can reproduce `nDCG@10`, protected floors, and state
  root within `replayTolerancePpm`.

## Acceptance Criteria

The hardening is complete only when all are true:

- No public route gives miners active hidden-pack scores before commitment.
- Eval seed is derived after commit close and binds to `commitmentRoot`.
- Hidden artifacts are revealed only after settlement and retired forever.
- Coordinator-affiliated wallets are excluded from mining.
- State advances are selected by confirmed retrieval improvement, not latency.
- Screener credits cannot be farmed from structural validity alone.
- Miners receive safe real-time status and credit/advance visibility.
- Full real-model anvil e2e passes with BGE-M3 + Qwen3-Reranker-0.6B.
- Independent replay reproduces patch bytes, state roots, score reports, and
  bundle/corpus bindings.

## What To Reject From The Auditor Draft

Reject or defer these:

- Hiding the scorer or model details. The scorer must stay open and pinned.
- Paying cheap structural screener passes.
- Credit-weighted rate limits or "rich get richer" evaluation lanes.
- Large new bond/ticket economics before measuring spam under existing stake
  and flat limits.
- Detailed live per-query feedback.
- Manual operator hardness knobs.

Keep these:

- Commit before hidden eval.
- Seed hidden packs after commitments are locked.
- Use once, reveal, retire.
- Confirmation pack for finalists.
- Batch settlement from an epoch parent.
- Duplicate collapse.
- Coordinator-affiliated miner exclusion.
