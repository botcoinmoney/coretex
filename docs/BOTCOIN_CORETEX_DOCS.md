# BOTCOIN CoreTex Documentation

CoreTex is the BOTCOIN retrieval-memory mining lane. It rewards miners for
improving a shared memory-routing substrate, then settles accepted work through
the same V4 receipt and claim path used by the broader BOTCOIN mining system.

This document is a technical overview. Live miner parameters come from
`/coretex/status`. Validator truth comes from Base RPC reads, `BotcoinMiningV4`,
`CoreTexRegistry`, signed public artifacts, and the installed `@botcoin/cortex`
client.

## Contents

1. [Overview](#overview)
2. [Architecture and Design Choice](#architecture-and-design-choice)
3. [Core Stack](#core-stack)
4. [Corpus](#corpus)
5. [Substrate](#substrate)
6. [Evaluation](#evaluation)
7. [Mining Flow](#mining-flow)
8. [Contracts](#contracts)
9. [Validator Client](#validator-client)
10. [Epoch Rotation](#epoch-rotation)
11. [Security And Verification](#security-and-verification)
12. [Research Frame](#research-frame)

## Overview

CoreTex evaluates compact changes to a fixed-size retrieval substrate. The
corpus contains the memory content. The substrate contains 1024 state cells, for
a total of 32,768 bytes, and encodes routing structure over that corpus.
Accepted substrate roots, compact patch bytes, corpus roots, bundle hashes, and
epoch commitments are pinned on Base through `BotcoinMiningV4` and
`CoreTexRegistry`.

The live question for each submission is:

> Did this patch improve retrieval from the current parent substrate under the
> active corpus, bundle, hidden evaluation packs, and threshold policy?

The answer is produced by the pinned CoreTex evaluator. The evaluator decodes
the substrate, generates retrieval candidates, renders the memory representation
used for scoring, reranks query/document pairs with `Qwen/Qwen3-Reranker-0.6B`,
and compares the patch against the current parent baseline.

## Why The Design Looks This Way

LLMs have limited context windows. Larger context also raises compute cost and
can degrade answer quality when useful evidence is surrounded by stale,
irrelevant, or near-collision text. Long-horizon agents therefore need memory
systems that select the right evidence before generation begins.

CoreTex puts economic pressure on retrieval structure. The corpus lives off
chain, where it can grow and carry rich documents, embeddings, provenance,
qrels, and splits. The substrate is compact, typed, and rooted on chain, so
miners compete over which routing facts deserve scarce state space.

A direct one-entry-per-memory index scales poorly for this task. Agent memory
needs temporal validity, conflict resolution, causal links, entity identity,
scope, evidence density, abstention, and relation routing. Encoding every such
relation as a literal mirror of the corpus recreates the memory set itself.
CoreTex asks miners to compress useful retrieval behavior into a small shared
map.

The hidden evaluation design follows from the same constraint. Public corpus
shape and public substrate rules give miners a fair search surface. Hidden
query packs, epoch-secret reveal, and post-reveal replay keep scoring from
becoming a visible gradient.

## Core Stack

| Layer | Role |
|---|---|
| Corpus | Off-chain memory records, truth documents, hard negatives, qrels, splits, public intent metadata, embeddings |
| Substrate | 1024-state-cell routing state with typed regions for memory slots, relations, temporal validity, and policy atoms |
| Retrieval router | Substrate decode, corpus lookup, candidate generation, Memory-IR rendering, and pack construction |
| Reranker | `Qwen/Qwen3-Reranker-0.6B`, pinned by model id, revision, prompt hash, and runtime pins |
| Coordinator | Serves `/coretex/*`, evaluates live submissions, signs V4 receipts, and publishes post-reveal eval reports |
| Keyless scorer sidecar | Optional coordinator execution venue for scoring. It has no coordinator signing key |
| Contracts | V4 verifies and settles receipts. The registry serializes CoreTex state advances and exposes epoch pins |
| Validator client | Standalone CPU replay package that verifies roots and, after reveal, rescoring evidence |

The package boundary matters. The default `@botcoin/cortex` entry point is the
validator surface. Coordinator code is exposed through `@botcoin/cortex/coordinator`.
Full internal exports live under `@botcoin/cortex/full`.

## Corpus

The current launch-family corpus is the v16 `dgen1-r5-synth-300k` corpus. It is
generated from structured BOTCOIN challenge worlds, entities, relations,
temporal updates, traps, and hard negatives. The generation path creates
retrieval-evaluation records from structured challenge ingredients.

Each record carries:

| Field | Purpose |
|---|---|
| Query text | The retrieval task |
| Truth documents | Answer-bearing memory documents |
| Hard negatives | Plausible documents that should rank below truth |
| Graded qrels | Relevance labels for `nDCG@10`, MRR, recall, and audit metrics |
| Split | `train_visible`, `calibration`, `eval_hidden`, or `canary` |
| Public intent metadata | Temporal, relation, evidence, conflict, scope, entity, and abstention hints available to all miners |
| Embeddings | Bundle-layout-compatible BGE-M3 query and document vectors |
| Provenance | Source domain, seed, generator path, and deterministic roots |

The production qrel path uses synthesizer-category labels. The generator knows
why a negative exists, such as stale fact, entity swap, relation neighbor,
attribute swap, lexical distractor, or unrelated filler. The bundle maps those
categories into graded relevance. Larger audit rerankers remain useful for
calibration checks. Production corpus growth avoids a heavier relabeling pass
over every pair.

Corpus growth is published through signed deltas. Validators retain the launch
base corpus and can reconstruct historical corpus roots by walking the signed
delta chain forward. A manual `--corpus-for-root 0x...=path` shortcut exists
for operators, while the normal validator path auto-resolves and verifies
historical roots before post-reveal rescoring.

Corpus evolution is part of the memory model. New information enters, older
information becomes stale, conflicts appear, retired hidden tasks leave the
scoring pool, and new hidden tasks are added. Each evolve event is calibrated
against its own corpus root, query pack, baseline, and pinned scorer context.

The calibration path also checks whether useful substrate changes generalize
across corpus generations. A representative test starts with substrate design A
on corpus/query pack A, evolves into corpus/query pack B, accepts a miner patch
that beats the newly calibrated baseline, then backtests the resulting substrate
design B against the pre-evolve corpus/query pack A. When design B preserves
pre-evolve performance while improving the evolved context, the result shows a
retrieval-routing improvement rather than corpus-specific indexing churn.

## Substrate

`CortexState` is always 1024 state cells. A state cell is one EVM `uint256`:
32 bytes, 256 bits, and usually displayed as a 64-character hex value. Cells are
not English words. They are fixed-size storage lanes that can encode hashes,
counters, compact IDs, bit fields, or typed routing atoms.

Ethereum and Solidity call a 32-byte `uint256` a word. For readability, these
docs call the same unit a state cell. API and wire-format names such as
`wordCount` and `wordIndexRange` are protocol field names; read them as
state-cell count and state-cell index.

The current r5 interpretation is:

| Range | Cells | Current meaning |
|---|---:|---|
| `0..31` | 32 | Header, protocol metadata, counters, and binding fields |
| `32..383` | 352 | MemoryIndex slots and anchors |
| `384..511` | 128 | Evidence policy atoms |
| `512..639` | 128 | Conflict lifecycle atoms |
| `640..671` | 32 | Abstention atoms |
| `672..799` | 128 | Relation and category-routing entries |
| `800..895` | 96 | Temporal validity and supersession records |
| `896..991` | 96 | r5 reserved policy capacity, zero unless activated by a later bundle |
| `992..1023` | 32 | Reserved, zero |

The older `RetrievalKeys` and `Codebook` names still appear in code constants
because the state codec is versioned. Under the current r5 bundle, cells
`384..671` are typed policy atoms, and cells `896..991` are reserved policy
capacity.

Launch-active surfaces are dynamic and must be read from `/coretex/status`.
The v16 family includes:

- `temporal_update`
- `conflict_lifecycle`
- `relation_causal`
- `relation_category_routing`
- `abstention_top1`
- `evidence_bundle`
- `coreference`
- `relation_lifecycle`
- `noise_suppression`
- `validity_atom`
- `scope_atom`
- `entity_resolution_atom`

Reward-active status requires both conditions: the surface appears in
`activeSubstrateSurfaces`, and the live `allowedPatchTypes` exposes the patch
type and state-cell range.

Patch bytes are compact:

```text
patchType  : 1 byte
wordCount  : 1 byte, 1..4 state cells
scoreDelta : 8 bytes, big-endian, informational for miner submissions
parent     : 32 bytes, parentStateRoot
body       : wordCount x (LEB128 state-cell index + 32-byte newWord)
```

Current r5 policy suppresses raw `KEY_UPDATE` and `CODEBOOK_UPDATE` for launch
mining. `POLICY_UPDATE` handles pure policy atom writes. `MIXED` handles true
cross-region patches, such as MemoryIndex plus Temporal or anchor plus
PolicyAtom. Miners should read the byte values from live `allowedPatchTypes`
and treat documentation examples as structural guidance.

## Evaluation

A live submission is scored against hidden packs derived after receipt. The seed
binds:

```text
epochSecret + future Base blockhash + epochId + patchHash
+ parentRoot + minerAddress + corpusRoot + bundleHash
```

The coordinator records the received block, waits for the target future
blockhash, pins the seed before scoring, and uses two packs:

| Pack | Purpose |
|---|---|
| Gate | First hidden evaluation sample |
| Confirm | Independent sample used to reduce pack-luck acceptance |

For each query, the evaluator:

1. Decodes active substrate slots.
2. Builds retrieval candidates from public corpus indexes and substrate routes.
3. Renders Memory-IR where the active profile enables it.
4. Reranks query/document pairs with the pinned Qwen reranker.
5. Scores ranked documents against graded qrels.
6. Compares the patched substrate to the parent substrate on the same pack.

`nDCG@10` is the primary retrieval metric. Secondary signals include temporal
current/stale behavior, relation recall, abstention, structural validity, and
policy-atom effects. Live packs are sampled hidden tasks. Broader full-pack and
pair-trace runs are calibration, parity, and release-gate evidence.

GPU scoring can be used by the coordinator as an execution venue through the
keyless scorer sidecar. The sidecar receives packed parent substrate bytes and
re-merkleizes them against `parentStateRoot` before scoring. The coordinator
verifies scorer pins, health fields, seed echo, artifact bytes, and context
hashes before signing. Validators replay on the pinned CPU path.

## Mining Flow

The miner-facing v0 API has five public endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/coretex/health` | Coordinator health, epoch, chain, pins, finality, and accepting status |
| `GET` | `/coretex/status?miner=0x...` | Dynamic miner context, current root, allowed patch types, thresholds, counters, and active surfaces |
| `GET` | `/coretex/substrate/:stateRoot` | Packed 1024-state-cell substrate for a confirmed root |
| `POST` | `/coretex/submit` | Submit `{ patchBytesHex, parentStateRoot, minerAddress }` |
| `GET` | `/coretex/receipt/:hash` | Re-fetch a signed receipt or learn that a pending receipt is stale |

Typical miner loop:

1. Read `/coretex/status?miner=0x...`.
2. Fetch `/coretex/substrate/:currentStateRoot`.
3. Build a 1 to 4 state-cell patch within `allowedPatchTypes` and `patchWordBudget`.
4. Submit to `/coretex/submit`.
5. If accepted, broadcast the returned V4 transaction or raw receipt.
6. Re-read status after any state advance, because the parent root moved.

Accepted outcomes:

| Outcome | Meaning |
|---|---|
| `SCREENER_PASS` | Patch cleared the screener threshold and earns base CoreTex work credit |
| `STATE_ADVANCE` | Patch moved the live root and earns policy-weighted state-advance credit |

Rejection envelopes expose stable codes and safe context, such as stale root or
cap status. They omit hidden qrels, pack IDs, answer labels, hidden seeds,
per-query rankings, and score gradients.

## Contracts

CoreTex settlement lives in `BotcoinMiningV4`. CoreTex state-transition
serialization lives in `CoreTexRegistry`.

| Contract | Role |
|---|---|
| `BotcoinMiningV4` | Unified reward ledger, standard receipts, CoreTex receipts, funding, finalization, claims, epoch secret reveal |
| `CoreTexRegistry` | Canonical CoreTex live root, transition count, context views, state-advance events, and registry finalization |
| `BotcoinMiningV3` | Initial stake, tier, and epoch source for V4 |

V4 exposes `genesisTimestamp()`, `epochDuration()`, and `currentEpoch()`.
`currentEpoch()` follows the V3 epoch clock. CoreTex epoch context is set on V4,
then the registry reads V4 context through stable views. Registry state advances
are accepted from V4 through `submitStateAdvance`.

Registry finalization (`CoreTexRegistry.finalizeEpoch`) is a validator/replay
seal only: it records the epoch header and emits `CoreTexEpochFinalized` so
independent validators can bind their replayed root to the chain's. It is NOT a
payout gate — V4 `fundEpoch`/`finalizeEpoch`/`claim` never read it, so a missed
seal can never block standard-lane or CoreTex rewards. Credits are closed by
the epoch rollover itself (receipts are only accepted for `currentEpoch()`),
which is what makes the payout path safe without the seal. The epoch-cutover
orchestrator seals each completed CoreTex epoch automatically (step 5). The one
V4 read of registry finalization that remains is receipt validation: a sealed
registry epoch rejects further CoreTex receipts.

Important V4 functions:

```text
submitCoreTexReceipt(CoreTexReceipt)
setCoreTexEpochContext(uint64, CoreTexEpochContext)
setEpochCommit(uint64, bytes32)
revealEpochSecret(uint64, bytes32)
fundEpoch(uint64, uint256)
finalizeEpoch(uint64)
claim(uint64[])
```

Runtime code should read addresses from env, config, or deployment artifacts:

```bash
export BASE_RPC_URL=https://mainnet.base.org
export CORETEX_REGISTRY_ADDRESS=0x...
export BOTCOIN_MINING_CONTRACT_ADDRESS=0x...
```

`docs/contract-addresses-mainnet.md` records current drill addresses and readback
commands. Final launch docs should be regenerated from the final deployment
artifact after rebundle, repin, and deploy.

## Validator Client

The standalone validator package is `@botcoin/cortex`. It installs as its own
validator client and defaults to CPU replay.

```bash
npm install @botcoin/cortex
```

Required environment:

```bash
export BASE_RPC_URL=https://mainnet.base.org
export CORETEX_REGISTRY_ADDRESS=0x...
export BOTCOIN_MINING_CONTRACT_ADDRESS=0x...
export CORETEX_ARTIFACT_BASE_URL=https://.../coretex/launch/v16
export CORETEX_REGISTRY_DEPLOY_BLOCK=<deploy-block>
```

Setup hydrates and verifies the public artifact set:

```bash
npx coretex-validator-setup --registry-deploy-block "$CORETEX_REGISTRY_DEPLOY_BLOCK"
```

Setup fetches `coretex-launch-v16-artifacts.json`, verifies payload SHA-256 and
byte sizes, materializes the production corpus, records the launch base corpus,
and bootstraps a pinned CPU scorer venv unless the operator opts out.

Sync replays chain state and verifies scoring evidence:

```bash
npx coretex-validator-sync
```

The default sync path:

1. Reads V4 `currentEpoch()` and registry pins at one confirmed block tag.
2. Verifies bundle version, corpus root, frontier root, baseline hash, and
   hidden seed commitment.
3. Replays `CoreTexStateAdvanced` logs from the deploy block or the prior cursor.
4. Recomputes each substrate root from public compact patch bytes.
5. Checks local live root equals `CoreTexRegistry.liveStateRoot(epoch)`.
6. Before reveal, exits 0 with `awaiting_epoch_secret_reveal`.
7. After reveal, fetches eval reports and re-scores accepted advances on CPU.

Useful replay controls:

```bash
# Replay a bounded historical window from a known parent substrate.
npx coretex-validator-sync \
  --epoch <epoch> \
  --from-block <block-containing-advance> \
  --parent-state ./parent-state.bin

# Provide a known corpus file for a historical corpus root, as a manual shortcut.
npx coretex-validator-sync \
  --corpus-for-root 0x<corpusRoot>=./corpus-for-that-root.json

# Verify one post-reveal eval report by hash.
npx coretex-validator-sync verify-patch \
  --hash 0x<evalReportHash> \
  --epoch-secret 0x<revealedSecret> \
  --parent-state ./parent-state.bin
```

`--skip-score-replay` exits with code 3. It is useful for root and artifact
checks, while a score attestation requires the pinned reranker path.

## Epoch Rotation

Epoch rotation is driven by V4 epoch time and chain state. The operator cutover
sequence freezes CoreTex submissions, reveals the previous epoch secret,
publishes post-reveal eval artifacts, verifies replay, evolves the corpus and
frontier, recomputes baseline for the current live root, signs and publishes
rotation artifacts, pins V4 context and epoch commit, reads pins back from
chain, hot-reloads the coordinator, then unfreezes submissions.

The rotation path is journaled and idempotent. A restart should converge on one
pinned epoch-start context: parent root, corpus root, frontier root, baseline
manifest hash, core version hash, and hidden-seed commitment. This does not mean
there is one immutable baseline or state root for the whole epoch. The live root
can advance many times during the epoch, and the effective baseline is tracked
per live root. Cutover idempotency means corpus evolution, epoch-start baseline
recompute, artifact publication, and chain pinning are not accidentally run
twice for the same cutover. A failed cutover retries on a bounded interval within
the epoch (submissions stay frozen between attempts; journaled steps resume
idempotently).

Eval-report artifact discipline: **spool pre-reveal, publish post-reveal.**
Accepted artifacts are spooled locally (atomic tmp+rename) before the receipt
is signed; they reach the public bucket only during cutover, after the epoch
secret reveal is journaled (the publish step hard-fails `PublishBeforeReveal`
otherwise), and every published artifact is GET-and-rehash verified —
including on crash-resume.

Difficulty follows observed retrieval progress:

| Signal | Effect |
|---|---|
| Parent baseline score | Acceptance compares candidate and parent on the same pack |
| Variance and replay tolerance | Prevents threshold decisions inside runtime noise |
| Qualified screener count | Raises state-advance work units when many viable attempts arrive before an advance |
| Corpus and frontier rotation | Triggers baseline recompute for the current live root under the new context |
| Unsafe metrics | Abort publish and pin |

## Security And Verification

CoreTex fails closed on root, context, and scoring mismatches. Rejection causes
include stale parent root, invalid compact patch, reserved write, no-op patch,
bundle mismatch, corpus mismatch, scorer runtime mismatch, score below
threshold, duplicate completed eval, and cross-miner in-flight duplicate.

Authority comes from:

- On-chain V4 and registry pins.
- Public compact patch bytes.
- Signed artifact bytes and content hashes.
- Corpus roots and signed corpus deltas.
- Bundle and profile hashes.
- Revealed epoch secrets.
- Base RPC reads for future blockhashes.
- Deterministic CPU replay within `replayTolerancePpm`.

The coordinator improves latency and miner UX. Independent validators use public
artifacts and chain data to reconstruct the same history. A keyless scorer can
accelerate coordinator evaluation, while the coordinator retains signing
authority and validators retain replay authority.

## Research Frame

CoreTex reflects several recurring findings from retrieval and agent-memory
research:

| Theme | Design response |
|---|---|
| Dense embeddings miss memory-specific relevance | Qwen reranking and graded qrels check answer-bearing evidence beyond surface similarity |
| Long-horizon memory changes over time | Temporal validity, supersession, and stale-memory rejection are first-class substrate surfaces |
| Multi-hop agent memory needs structure | Relation and category-routing regions make useful paths explicit |
| Retrieval quality depends on hard negatives | Corpus generation includes plausible wrong documents and near-collision cases |
| Memory systems need compression | The 32 KB substrate forces miners to encode useful routing behavior under a fixed state budget |
| Public benchmarks invite overfitting | Hidden packs, canary records, seed reveal, and post-reveal replay separate search from verification |

Representative references include MemReranker, Qwen3-Reranker, LoCoMo,
MemoryAgentBench, MemoryArena, BEIR, MTEB, and recent work on limitations of
single-vector retrieval. CoreTex turns those concerns into protocol mechanics:
compact state, public roots, hidden eval, pinned scoring, and independent replay.
