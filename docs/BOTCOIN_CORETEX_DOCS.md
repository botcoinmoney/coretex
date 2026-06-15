# BOTCOIN CoreTex Documentation

CoreTex is the BOTCOIN retrieval-memory mining lane. It rewards miners for
improving a shared memory-routing substrate, then settles accepted work through
the same V4 receipt and claim path used by the broader BOTCOIN mining system.

This document is a technical overview. Live miner parameters come from
`/coretex/status` and `/coretex/schema`. Public corpus research data is served
through `/coretex/public-corpus/*`. Validator truth comes from Base RPC reads,
`BotcoinMiningV4`, `CoreTexRegistry`, signed public artifacts, and the installed
[`@botcoinmoney/coretex-client`](https://www.npmjs.com/package/@botcoinmoney/coretex-client)
client.

## Contents

1. [Overview](#overview)
2. [Design Intent](#design-intent)
3. [Core Stack](#core-stack)
4. [Corpus](#corpus)
5. [Substrate](#substrate)
6. [Evaluation](#evaluation)
7. [Difficulty And Calibration](#difficulty-and-calibration)
8. [Mining Flow](#mining-flow)
9. [Getting Started](#getting-started)
10. [Coordinator API](#coordinator-api)
11. [Contracts](#contracts)
12. [Credit And Reward Accounting](#credit-and-reward-accounting)
13. [Validator Client](#validator-client)
14. [Epoch Rotation](#epoch-rotation)
15. [Security And Verification](#security-and-verification)
16. [Research Frame](#research-frame)

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

## Design Intent

LLMs have limited context windows. Larger context also raises compute cost and
can degrade answer quality when useful evidence is surrounded by stale,
irrelevant, or near-collision text. Long-horizon agents therefore need memory
systems that select the right evidence before generation begins.

CoreTex treats memory as retrieval policy under compression. The corpus lives
off chain, where it can grow and carry rich documents, embeddings, provenance,
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
query packs, epoch-secret reveal, and post-reveal replay make accepted routing
changes verifiable while limiting score-gradient leakage during mining.

## Core Stack

| Layer | Role |
|---|---|
| Corpus | Off-chain memory records, truth documents, hard negatives, qrels, splits, public intent metadata, embeddings |
| Substrate | 1024-state-cell routing state with typed regions for memory slots, relations, temporal validity, and policy atoms |
| Retrieval router | Substrate decode, corpus lookup, candidate generation, Memory-IR rendering, and pack construction |
| Reranker | `Qwen/Qwen3-Reranker-0.6B`, pinned by model id, revision, prompt hash, and runtime pins |
| Coordinator | Serves `/coretex/*`, evaluates live submissions, signs V4 receipts, and publishes post-reveal eval reports |
| Keyless scorer sidecar | Optional coordinator execution venue for scoring with zero coordinator signing keys |
| Contracts | V4 verifies and settles receipts. The registry serializes CoreTex state advances and exposes epoch pins |
| Validator client | Standalone CPU replay package that verifies roots and, after reveal, rescoring evidence |

The package boundary matters. The published validator client is
[`@botcoinmoney/coretex-client`](https://www.npmjs.com/package/@botcoinmoney/coretex-client).
It is the standalone validator, replay, and sync surface. Coordinator-only code
stays in the coordinator/CoreTex integration and is not a miner dependency.

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

Miner-facing corpus access is coordinator-proxied. Start from:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/coretex/public-corpus/manifest` | Public corpus manifest, model IDs, corpus root, paging limits, split policy, and endpoint templates |
| `GET` | `/coretex/public-corpus/events?offset=N&limit=M` | Paged public visible events and public qrels |
| `GET` | `/coretex/public-corpus/events?offset=N&limit=M&includeEmbeddings=true` | Same event page with canonical public embedding hex; lower page limit |
| `GET` | `/coretex/public-corpus/event/:eventId` | One public visible event by id |
| `GET` | `/coretex/public-corpus/entities?offset=N&limit=M` | Paged public entity table |
| `GET` | `/coretex/public-corpus/family-summary` | Query-family counts and bounded representative public examples |
| `GET` | `/coretex/public-corpus/relation-summary` | Public relation edge-type counts and bounded representative public examples |
| `GET` | `/coretex/public-corpus/query-examples?surface=...&family=...&relation=...` | Bounded public examples filtered by intended surface, family, or relation |

The public corpus proxy serves unprotected `train_visible` rows. Calibration,
hidden eval, canary, protected, or nonexistent event IDs are not served through
these endpoints. Use the coordinator proxy for miner research even when S3
artifact links are also advertised, because bucket ACLs and publication timing
can differ from the miner-facing corpus API.

`/coretex/schema` advertises the current public artifact base URL, S3 URL
templates, public corpus links, and eval-report URL template under
`publicArtifacts`. Validators use those artifact URLs to hydrate launch files,
historical corpus material, signing keys, and post-reveal evaluation reports.

Useful `publicArtifacts` fields:

| Field | Purpose |
|---|---|
| `artifactBaseUrl` | Base URL for launch-family public artifacts |
| `epochSigningPublicKeyUrl` | Public key material for verifying epoch-signed artifacts |
| `evalReportUrlTemplate` | Template for post-reveal eval reports by artifact hash |
| `publicCorpus` | Coordinator-proxied manifest, event, entity, family, relation, and query-example endpoints |
| `s3Hints` | Operator notes about which artifacts are best fetched through S3 versus coordinator proxy |

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
32 bytes, 256 bits, and usually displayed as a 64-character hex value. Cells
are fixed-size storage lanes that can encode hashes, counters, compact IDs, bit
fields, or typed routing atoms.

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
The v16 family may include:

- `temporal_update`
- `conflict_lifecycle`
- `causal_decision_lensOnly`
- `relation_category_routing`
- `abstention_top1`
- `evidence_bundle_bundleOnly`
- `evidence_reach_only`
- `evidence_bundle`
- `coreference`
- `relation_lifecycle_gated`
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
cross-region patches, such as MemoryIndex plus Temporal or relation plus
PolicyAtom. Policy-only writes should use `POLICY_UPDATE`, not `MIXED`.
Miners should read the byte values from live `allowedPatchTypes` and treat
documentation examples as structural guidance.

`/coretex/schema` is the public authoring contract for patch shape. It exposes
live writable regions, surface-to-region hints, `relationAtomSchema`,
`temporalAtomSchema`, `policyAtomSchema`, memory-index encoding guidance, and
`referencePatchShapes`. In r5, relation cells support both anchored relation
edges and standalone category lenses. Anchored relation edges depend on
MemoryIndex endpoints. Category lenses are general routing rules and do not
require a memory anchor. A lone arbitrary MemoryIndex anchor is usually not a
general retrieval improvement by itself.

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

## Difficulty And Calibration

CoreTex accepts work by measuring improvement over the current parent substrate.
The parent and candidate are scored on the same gate and confirm packs, so the
threshold is about marginal retrieval gain rather than absolute benchmark score.

The state-advance threshold is:

```text
stateAdvanceThresholdPpm =
  minImprovementPpm + baselineVariancePpm + replayTolerancePpm
```

The v16 launch profile pins `replayTolerancePpm = 250`. The current
`baselineParentScorePpm` is per live root and must be read from
`/coretex/status`. `baselineVariancePpm` is present when the current baseline
was sampled broadly enough to measure variance. The difficulty controller
clamps `minImprovementPpm` between 2,500 ppm and 150,000 ppm.

Baseline state is tracked per live root. The epoch-start context pins the parent
root and baseline manifest hash. Each accepted state advance moves the live
root, and the coordinator records the accepted `scoreAfterPpm` as the effective
baseline for that new root. If a root appears without a known baseline, such as
after a foreign advance or rotation, submissions return `awaiting_baseline_recompute`
until the recalibrated baseline is installed.

The screener threshold is derived from the same live baseline. It combines:

| Signal | Effect |
|---|---|
| Remaining headroom | Higher parent scores leave less easy gain |
| Recent noise floor | Raises the gate above measured replay noise |
| State-advance floor | Keeps screeners tied to the real advance threshold |
| Probe pass rate | Adds an anti-gaming penalty when weak probes pass too often |
| Static floor | Operator floor from coordinator config, if set |

Epoch difficulty updates use `nextMinImprovementPpm`:

| Epoch signal | Controller response |
|---|---|
| More state advances than target | Ramp threshold upward |
| Zero advances with many quality attempts | Decay threshold |
| Some quality attempts below target advances | Ease through `under_target_recovery` |
| Zero advances and zero quality attempts | Drift toward the floor |
| Major corpus delta | Freeze for one epoch with `major_delta_grace` |

A major delta is detected with
`isMajorDelta(nextEvalHiddenCount, previousEvalHiddenCount, majorDeltaThreshold)`.
The v16 profile pins `majorDeltaThreshold = 220`. During grace, the threshold
is held steady while the baseline is recomputed against the new corpus,
frontier, and query-pack context.

Calibration artifacts bind the pieces that matter for replay: corpus root,
active frontier root, query-pack policy, baseline score, variance, fixed-pack
repeatability, model pins, runtime pins, and profile hash. Corpus evolution also
checks that positive `eval_hidden` qrels still point to available documents
before publishing a rotation.

## Mining Flow

Typical miner loop:

1. Read `/coretex/status?miner=0x...`.
2. Read `/coretex/schema` for live patch grammar, atom schemas, public corpus links, surface playbooks, and reference patch shapes.
3. Fetch `/coretex/substrate/:currentStateRoot` or `/coretex/substrate/:currentStateRoot?view=decoded`.
4. Build a 1 to 4 state-cell patch within `allowedPatchTypes` and `patchWordBudget`.
5. Run `/coretex/dryrun` for structural validation.
6. Run `/coretex/render-trace` to check public renderer activation before spending wallet intake.
7. Submit to `/coretex/submit`.
8. If accepted, broadcast the returned V4 transaction or raw receipt.
9. If the submit request times out, poll `/coretex/attempt/:patchHash?miner=0x...` or `/coretex/receipt/:patchHash` before resubmitting.
10. Re-read status after any state advance, because the parent root moved.

Accepted outcomes:

| Outcome | Meaning |
|---|---|
| `SCREENER_PASS` | Patch cleared the screener threshold and earns base CoreTex work credit |
| `STATE_ADVANCE` | Patch moved the live root and earns policy-weighted state-advance credit |

Rejection envelopes expose stable codes and safe context, such as stale root or
cap status. They omit hidden qrels, pack IDs, answer labels, hidden seeds,
per-query rankings, and score gradients.

## Getting Started

### Requirements

1. **A staked Base miner address** — minimum **5,000,000 BOTCOIN** staked on the staking contract for tier 1 eligibility.
2. **ETH on Base** — enough to submit accepted V4 receipt transactions.
3. **A signing path** — Bankr-managed signing or a self-managed EOA.
4. **CoreTex authoring loop** — a client that can fetch status/schema/corpus data, build compact patch bytes, dryrun them, submit, and broadcast accepted receipts.

### Setup Flow

1. Read the live CoreTex health and miner status:

   ```bash
   curl -s https://coordinator.agentmoney.net/coretex/health | jq
   curl -s "https://coordinator.agentmoney.net/coretex/status?miner=0xYOUR_MINER" | jq
   ```

2. Complete the shared BOTCOIN auth handshake through `/v1/auth/nonce` and
   `/v1/auth/verify`, then use `Authorization: Bearer <token>` for miner-scoped
   CoreTex status and submit calls.
3. Read `/coretex/schema` and `/coretex/public-corpus/*` before generating a
   patch. Use the family, relation, and query-example helpers to avoid blind
   corpus paging. Treat live `allowedPatchTypes`, state-cell ranges, thresholds,
   and active surfaces as runtime values.
4. Fetch the current substrate by `currentStateRoot`, create a compact patch,
   dryrun it with `/coretex/dryrun`, inspect `/coretex/render-trace`, then
   submit it to `/coretex/submit`.
5. If accepted, broadcast the returned BotcoinMiningV4 transaction or call V4
   directly with the returned receipt tuple. After any state advance, re-read
   status before building another patch.

### Miner Skill

The website-hosted CoreTex miner skill is:

[`https://agentmoney.net/coretex-skill.md`](https://agentmoney.net/coretex-skill.md)

Load that file into the mining agent's context. It contains the current CoreTex
endpoint set, Bankr and self-managed wallet paths, patch authoring loop,
dryrun/submit/recovery flow, and safe error handling.

## Coordinator API

The miner-facing CoreTex API exposes dynamic mining context, public corpus
research data, substrate reads, structural dryrun, submission, and receipt
recovery. Static protocol overview lives in docs; live authoring values come
from `/coretex/status` and `/coretex/schema`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/coretex/health` | Coordinator health, epoch, chain, pins, finality lag, and accepting status |
| `GET` | `/coretex/status?miner=0x...` | Dynamic miner context, current root, patch policy, thresholds, counters, and active surfaces |
| `GET` | `/coretex/schema` | Public authoring schema, miner workflow, surface playbooks, atom layouts, writable regions, public artifact links, public corpus links, and reference patch shapes |
| `GET` | `/coretex/public-corpus/manifest` | Public corpus manifest, split policy, endpoint templates, paging limits, and public record fields |
| `GET` | `/coretex/public-corpus/events?offset=N&limit=M` | Paged public visible events; supports `includeEmbeddings=true` and `includePublicQrels=false` |
| `GET` | `/coretex/public-corpus/event/:eventId` | One public visible event by id |
| `GET` | `/coretex/public-corpus/entities?offset=N&limit=M` | Paged public entity table |
| `GET` | `/coretex/public-corpus/family-summary` | Query-family counts and bounded representative public examples |
| `GET` | `/coretex/public-corpus/relation-summary` | Public relation edge-type counts and bounded representative public examples |
| `GET` | `/coretex/public-corpus/query-examples?surface=...&family=...&relation=...` | Bounded public examples filtered by intended surface, family, or relation |
| `GET` | `/coretex/substrate/:stateRoot` | Packed 1024-state-cell substrate for a confirmed root |
| `GET` | `/coretex/substrate/:stateRoot?view=decoded` | Compact decoded substrate, structural counts, and resolved public MemoryIndex metadata where available |
| `POST` | `/coretex/dryrun` | Structural validation for `{ patchBytesHex, parentStateRoot, minerAddress }`; no scoring and no wallet intake |
| `POST` | `/coretex/render-trace` | Public renderer activation trace for the exact patch; no scoring and no wallet intake |
| `POST` | `/coretex/submit` | Submit `{ patchBytesHex, parentStateRoot, minerAddress }` |
| `GET` | `/coretex/attempt/:hash?miner=0x...` | Miner-scoped recovery lookup for a submitted patch hash |
| `GET` | `/coretex/receipt/:hash` | Re-fetch a signed receipt, or receive stale/expired status |

Supporting miner endpoints shared with the standard lane:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/auth/nonce` | Request the exact message to sign for miner authentication |
| `POST` | `/v1/auth/verify` | Verify the signed nonce and receive a bearer token |
| `GET` | `/v1/epoch` | Current epoch and claim/funding context |
| `GET` | `/v1/claim-calldata?epochs=N` | Pre-encoded claim transaction helper |

Important `/coretex/status` fields:

| Field | Meaning |
|---|---|
| `currentStateRoot` | Confirmed parent root for the next patch |
| `allowedPatchTypes` | Live patch type bytes and allowed state-cell ranges |
| `patchWordBudget` | Maximum changed state cells, currently 4 |
| `minImprovementPpm` | Base state-advance improvement floor |
| `stateAdvanceThresholdPpm` | Full state-advance threshold including variance and replay tolerance |
| `screenerThresholdPpm` | Live screener threshold for base CoreTex credit |
| `baselineParentScorePpm` | Effective parent baseline for the current live root |
| `perMiner` | Miner receipt cursor, screener count, cap, and remaining screeners |
| `qualifiedScreenerPassesSinceLastStateAdvance` | Global counter used for the next state-advance work multiplier |
| `activeSubstrateSurfaces` | Reward-active substrate families for the current epoch |
| `bundleHash`, `coreVersionHash`, `corpusRoot`, `activeFrontierRoot` | Epoch roots and commitments checked against chain state |
| `minerGuidance` | Schema, dryrun, render-trace, decoded-substrate, timeout-recovery, substrate-bootstrap, and latest accepted shape hints |

Important `/coretex/schema` fields:

| Field | Meaning |
|---|---|
| `patchWireFormat` | Compact patch byte layout |
| `minerWorkflow` / `surfacePlaybooks` | Live intent-to-shape authoring guidance |
| `wordRegions` | State-cell ranges and grammar summaries |
| `memoryIndexSchema` | MemoryIndex slot layout and anchor rules |
| `relationAtomSchema` | Relation edge and category-lens layouts, edge-type enum, and examples |
| `temporalAtomSchema` | Temporal record layout and examples |
| `policyAtomSchema` | PolicyAtom bit layout, enums, per-region action rules, and examples |
| `publicArtifacts` | Artifact base URLs, public corpus endpoint links, and eval-report URL template |
| `referencePatchShapes` | Non-secret reference shapes for structural and positive-control orientation |
| `submitTimeoutRecovery` | Attempt and receipt lookup paths for timeout recovery |

`POST /coretex/submit` accepts:

```json
{
  "patchBytesHex": "0x...",
  "parentStateRoot": "0x...",
  "minerAddress": "0x..."
}
```

Accepted responses include the `outcome`, `patchHash`, `evalReportHash`,
`workUnitsBps`, and the signed V4 receipt. `STATE_ADVANCE` responses also carry
the new state root and pre-encoded transaction data. Rejections include a stable
`code` and safe recovery context. Hidden query labels, seeds, pack IDs,
per-query rankings, and score gradients stay out of public responses.

`GET /coretex/receipt/:hash` works for both the miner-submitted patch hash and
the coordinator-rewritten signed hash. Pending or confirmed receipts return the
receipt envelope. A stale pending receipt returns `409 PendingReceiptStale`
without broadcastable transaction data. Expired or unknown receipts return 404.

## Contracts

CoreTex settlement lives in `BotcoinMiningV4`. CoreTex state-transition
serialization lives in `CoreTexRegistry`. Stake and tier eligibility currently
come from the staking contract.

| Contract | Role |
|---|---|
| [`BotcoinMiningV4`](https://basescan.org/address/0xBc71E2428cc0955b3dF9f38F5cF5DE22a1fC1D9b#code) | Verified receipt, credit, funding, epoch, and claim contract used by the client for epoch context and post-reveal eval replay |
| [`CoreTexRegistry`](https://basescan.org/address/0x79A9e5a1Ab4D7834CB4f4fB952f1F583032021Bb#code) | Verified registry contract that publishes live roots, epoch context pins, transition events, and the replay surface this client validates |
| [BOTCOIN ERC-20](https://basescan.org/token/0xa601877977340862ca67f816eb079958e5bd0ba3) | Reward, funding, staking, and claim token |
| [Staking contract](https://basescan.org/address/0xb2fbe0db5a99b4e2dd294de64ced82740b53a2ea#code) | Stake, tier, and eligibility source while V4 external staking mode is active |

V4 exposes `genesisTimestamp()`, `epochDuration()`, and `currentEpoch()`.
CoreTex epoch context is set on V4, then the registry reads V4 context through
stable views. Registry state advances are accepted from V4 through
`submitStateAdvance`.

Registry finalization (`CoreTexRegistry.finalizeEpoch`) is a validator/replay
seal only: it records the epoch header and emits `CoreTexEpochFinalized` so
independent validators can bind their replayed root to the chain's. V4 funding,
finalization, and claims are independent of this seal, so a missed seal cannot
block standard-lane or CoreTex rewards. Credits close at epoch rollover because
receipts are accepted only for `currentEpoch()`. The epoch-cutover orchestrator
seals each completed CoreTex epoch automatically. A sealed registry epoch also
rejects further CoreTex receipts for that epoch.

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
export CORETEX_REGISTRY_ADDRESS=0x79A9e5a1Ab4D7834CB4f4fB952f1F583032021Bb
export BOTCOIN_MINING_CONTRACT_ADDRESS=0xBc71E2428cc0955b3dF9f38F5cF5DE22a1fC1D9b
```

Deployment records should mirror these verified mainnet addresses.

## Credit And Reward Accounting

`BotcoinMiningV4` uses one epoch credit and reward ledger for both standard
receipts and CoreTex receipts:

```text
credits[epoch][miner]
totalCredits[epoch]
epochReward[epoch]
epochFinalized[epoch]
claimed[epoch][miner]
```

CoreTex receipts enter that ledger through `submitCoreTexReceipt`. The receipt
must match the miner's V4 receipt cursor, carry a valid coordinator EIP-712
signature, use the active CoreTex policy hash, and land within its issue/expiry
window. V4 also checks registry pins, patch grammar, work units, screener caps,
and duplicate patch credit before writing credits.

Tier credits come from the active stake source. At launch, V4 reads staking
balances and tier data through `externalStakeSource`. A future switch can move
eligibility to native V4 staking; while external staking mode is active, V4
`stake()` reverts. Operators and miners should read `tierCount()` and
`getTier(i)` from the active stake source instead of hardcoding a table.

Credit calculation is:

```text
creditsEarned = (tierCredits * workUnitsBps) / 10_000
```

The default CoreTex work policy is:

| Outcome | Live condition | `workUnitsBps` | Multiplier |
|---|---|---:|---:|
| `SCREENER_PASS` | Patch clears the live screener gate | 10,000 | 1.0x |
| `STATE_ADVANCE` | 0 qualified screeners since prior advance | 30,000 | 3.0x |
| `STATE_ADVANCE` | At least 25 qualified screeners | 40,000 | 4.0x |
| `STATE_ADVANCE` | At least 100 qualified screeners | 60,000 | 6.0x |
| `STATE_ADVANCE` | At least 250 qualified screeners | 90,000 | 9.0x |
| `STATE_ADVANCE` | At least 500 qualified screeners | 120,000 | 12.0x |

The `qualifiedScreenerPassesSinceLastStateAdvance` counter is global per epoch.
It increments when a screener receipt lands and resets when a state advance
lands. The coordinator snapshots that counter into the receipt, and V4 rejects
the receipt if the live value has changed before submission. Per-miner screener
caps are separate and persist across state advances within the epoch.

Patch-credit dedup is keyed by epoch, parent root, and patch hash. Receipt replay
is also blocked by the unified receipt hash map and the per-miner receipt chain
(`solveIndex` and `prevReceiptHash`).

Funding and claims follow the standard V4 path:

| Function | Role |
|---|---|
| `fundEpoch(epochId, amount)` | Deposits BOTCOIN for a completed epoch with credits |
| `finalizeEpoch(epochId)` | Locks the funded reward pool and opens claims |
| `claim(uint64[])` | Pays each miner pro rata by `credits / totalCredits` |

The payout formula is:

```text
payout = epochReward[epoch] * credits[epoch][miner] / totalCredits[epoch]
```

## Validator Client

The standalone validator package is
[`@botcoinmoney/coretex-client`](https://www.npmjs.com/package/@botcoinmoney/coretex-client).
It installs as its own validator client and defaults to CPU replay. The current
npm `latest` is `0.2.0`; bin names are unchanged.

```bash
npm install @botcoinmoney/coretex-client
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
3. Uses the epoch-115 launch-recovery pin when applicable, verifying the pinned
   parent root against `CoreTexRegistry.liveStateRoot(epoch)` at block
   `47358408` before replay.
4. Falls back to state-deploy or env-deploy bootstrap when no recovery pin
   applies.
5. Replays `CoreTexStateAdvanced` logs from the recovery/start block or prior
   cursor.
6. Recomputes each substrate root from public compact patch bytes.
7. Checks local live root equals `CoreTexRegistry.liveStateRoot(epoch)`.
8. Before reveal, exits 0 with `awaiting_epoch_secret_reveal`.
9. After reveal, fetches eval reports and re-scores accepted advances on CPU.

`0.2.0` ships a Base mainnet epoch-115 launch-recovery pin for parent root
`0x4c7e...73af` at block `47358408`, tx `0x92d5...587e`, with the packed
32,768-byte substrate embedded and merkle-verified before use. This is the
normal sync path for post-incident clients. Use `--full-history` or
`CORETEX_REPLAY_FULL_HISTORY=1` only when explicitly auditing the operator
incident from the legacy deploy-block path.

Useful replay controls:

```bash
# Replay a bounded historical window from a known parent substrate.
npx coretex-validator-sync \
  --epoch <epoch> \
  --from-block <block-containing-advance> \
  --parent-state ./parent-state.bin

# Explicitly bypass launch recovery and audit full history.
npx coretex-validator-sync --full-history

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
manifest hash, core version hash, and hidden-seed commitment. That context is
the epoch-start anchor. During the epoch, the live root can advance many times,
and the effective baseline is tracked per live root. Cutover idempotency means
corpus evolution, epoch-start baseline recompute, artifact publication, and
chain pinning run at most once for the same cutover. A failed cutover retries on
a bounded interval within the epoch. Submissions stay frozen between attempts,
and journaled steps resume idempotently.

Eval-report artifact discipline: **spool pre-reveal, publish post-reveal.**
Accepted artifacts are spooled locally (atomic tmp+rename) before the receipt
is signed; they reach the public bucket only during cutover, after the epoch
secret reveal is journaled (the publish step hard-fails `PublishBeforeReveal`
otherwise), and every published artifact is GET-and-rehash verified, including
on crash-resume.

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

Representative references:

| Reference | Relevance to CoreTex |
|---|---|
| [MemReranker: Reasoning-Aware Reranking for Agent Memory Retrieval](https://arxiv.org/abs/2605.06132) | Memory retrieval needs calibrated relevance, temporal reasoning, causal reasoning, and coreference handling. CoreTex reflects those families in qrels, hidden packs, and policy atoms. |
| [Qwen3-Reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) | Public launch reranker used for query/document ranking, pinned by model id, revision, prompt hash, and runtime. |
| [On the Theoretical Limitations of Embedding-Based Retrieval](https://arxiv.org/abs/2508.21038) | Single-vector retrieval has structural limits under realistic relevance sets. CoreTex uses compact routing state, relation surfaces, temporal atoms, and reranking. |
| [WARP: An Efficient Engine for Multi-Vector Retrieval](https://arxiv.org/abs/2501.17788) | Multi-vector and late-interaction retrieval motivate richer routing signals than one document embedding. |
| [LoCoMo: Evaluating Very Long-Term Conversational Memory of LLM Agents](https://arxiv.org/abs/2402.17753) | Long-term dialogue evaluation motivates current/stale facts, temporal grounding, and long-range consistency checks. |
| [MemoryAgentBench](https://arxiv.org/abs/2507.05257) | Incremental multi-turn memory benchmarks emphasize accurate retrieval, update behavior, long-range understanding, and selective forgetting. |
| [MemoryArena](https://arxiv.org/abs/2602.16313) | Multi-session agent tasks connect memory quality to later decisions, which supports evaluating memory as useful routing state. |
| [Experience Compression Spectrum](https://arxiv.org/abs/2604.15877) | Agent memory can be treated as compressed experience. CoreTex makes compression explicit through a fixed 32 KB substrate. |
| [BEIR](https://github.com/beir-cellar/beir) | Retrieval evaluation context for heterogeneous tasks and metrics such as nDCG, recall, and MRR. |
| [MTEB](https://github.com/embeddings-benchmark/mteb) | Broader embedding and retrieval benchmark context for model comparison and reproducible evaluation. |

CoreTex turns these concerns into protocol mechanics: compact state, public
roots, hidden evaluation, pinned scoring, epoch reveal, and independent replay.
