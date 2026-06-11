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
| `CoreTexRegistry` | Canonical CoreTex live root, transition count, context views, state-advance events, finalization and audit window |
| `BotcoinMiningV3` | Initial stake, tier, and epoch source for V4 |

V4 exposes `genesisTimestamp()`, `epochDuration()`, and `currentEpoch()`.
`currentEpoch()` follows the V3 epoch clock. CoreTex epoch context is set on V4,
then the registry reads V4 context through stable views. Registry state advances
are accepted from V4 through `submitStateAdvance`.

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
pinned epoch context and avoid double-stepping corpus, baseline, or chain state.
A failed cutover retries on a bounded interval within the epoch (submissions
stay frozen between attempts; journaled steps resume idempotently).

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

---

# End-To-End Production Audit Findings — 2026-06-11

Read-only audit of `/root/cortex` (HEAD `57fa96e`) and
`/root/botcoin-coordinator-coretex-integration` (HEAD `22dc362`, merge-base
`e426c8c` vs untouched `/root/botcoin-coordinator`). Scope: the full
CORETEX_END_TO_END_PRODUCTION_AUDIT_HANDOFF lanes plus a deep code-quality /
restructuring audit. No source changes were made. All required gate commands
were run fresh; every finding below carries file:line evidence and was either
read directly or independently spot-verified.

## 0. Gate results (all fresh, 2026-06-11)

| Gate | Result |
|---|---|
| `git status --short` (cortex) | clean except untracked `docs/BOTCOIN_CORETEX_DOCS.md` |
| `npm run build` (@botcoin/cortex) | PASS |
| `npm run test:unit` | PASS — 952/953 (1 intentional skip), 206 suites |
| `forge build` / `forge test` | PASS — 75/75 incl. 4 invariant suites (0 reverts) |
| `scripts/miner-api-contract-gate.mjs` | ALL PASS (5 routes, 25 status fields, no leakage) |
| `scripts/bundle-attestation-smoke.mjs` | ALL PASS (bundleHash `0x78336d1d…`) |
| `scripts/memory-ir-launch-gate.mjs` | ALL PASS (9/9) |
| `npm run coretex:epoch-evolve:e2e` | PASS (`ok: true`, pins coherent) |
| integration repo build + tests | PASS — 106/106; git state fully clean |

## 1. Launch-blocking / High findings

**F1. Published + pinned bundle attests PRE-hardening source; manifest flags
say publishing is done.** `verifyBundleManifest` against
`release/calibration/2026-06-04-memory-atom-v16/bundle-manifest-…-300k-enabled.json`
returns **13/41 pinned-file sha256 mismatches** (incl. `state/patch.ts`,
`eval/retrieval-benchmark.ts`, `eval/reranker.ts`,
`coordinator/per-patch-evaluator.ts`, `corpus/delta.ts`); every 2026-06-09/10
hardening commit is absent from the published bytes and the on-chain
`coreVersionHash` pin (`0x78336d1d…`). Fail-closed (preflight will refuse), but
`coretex-launch-v16-artifacts.json` still carries `s3RepublishRequired: false`
+ a green `s3ConsistencyCheck` — an operator reading the machine-readable
manifest concludes publishing is final. **Blocks launch.** Fix: rebundle →
recompute baseline on the final scorer path → re-sign/republish → repin; make
the artifacts-manifest staleness flags derive from a live source-tree check,
not a hand-set boolean.

**F2. Post-cutover coordinator restart boot-fails the ENTIRE coordinator
(standard lane included).** Sidecar boot errors are rethrown
(`server.ts:1113-1117`); epoch identity + all six pins come only from static
env (`CORETEX_EPOCH_ID`, `CORETEX_PARENT_STATE_ROOT`, …,
`coretex-sidecar.ts:595-622`) while rotation updates them only in-process
(`reloadEpochContext`, `coretex-sidecar.ts:922-992`). After the first
successful cutover, any restart boots against the stale env epoch,
`core.boot()` hard-fails (`coretex-coordinator-core.ts:497-500`), and the whole
process dies until ~8 env vars are hand-edited. Defeats the stated "standard
lane stays up" isolation goal. **Blocks EC2 port as-is.** Fix: on boot, when
the cutover store holds a newer checkpoint than env, derive epoch/pins from
chain + the journaled corpus/secret (all already durable in
`coretex_cutover_corpus` / `getRegistryEpochPins` / `loadOrCreateEpochSecret`);
or at minimum degrade to the existing `failClosed` latch instead of rethrowing.

**F3. The documented one-command standalone validator path cannot run.** With
exactly the four documented env vars, `coretex-validator-sync` dies: the epoch
signing public key has no default source (`validator-sync-cli.ts:1428-1431`
resolves only `--public-key` or coordinator-status
`epochSigningPublicKeyUrl`; setup records no key URL; no
`<artifactBase>/…/epoch-signing-key.pem` convention exists). Fail-closed, not a
security hole, but the runbook §2, setup summary, and USAGE all promise a path
that hard-fails. **Blocks "validator ready to ship standalone."** Fix: publish
the key at a canonical artifact-base path and default from `artifactBase`
(TOFU pinning already covers substitution), or persist the key URL at setup.

**F4. Keyless scorer-server: `/score-job` has no authentication, and the box
holds the epoch secret.** `scorer-server-cli.ts:647-674` serves with no
token/mTLS; protection is only the default `127.0.0.1` bind (:632,
operator-overridable via `CORETEX_SCORER_HOST`). Anyone who can reach the port
gets exact per-pair scores/`pairTraceHash` for arbitrary patches — a grinding
oracle bypassing coordinator dedup/admission (the scorer-side dedup store is
in-memory, :542). Additionally the "keyless" box requires
`CORETEX_EPOCH_SECRET` (:494) although `runPerPatchEvaluation` only consumes
the two derived eval seeds — a compromised GPU host leaks the pre-reveal
grinding secret even without a signing key. Fix: shared-secret/mTLS on the
route (or an asserted localhost-only bind), ship derived seeds instead of the
raw secret, and remove the `{}` seed-context fallback
(:252-279) that lets a job draw its own blockhash with only process-local dedup.

**F5. Fresh mainnet deployment recorded nowhere; RPC-secret rotation step
documented nowhere.** `docs/contract-addresses-mainnet.md:17-24` still lists
the older drill V4/registry; the live e2e contracts (V4 `0x4d2771…f635a`,
registry `0xDFBb6a…8c3f`, epoch 109) and the open "rotate credentialed RPC
secret" step exist only in session memory. The doc violates its own rule
("regenerate from the final deployment artifact", lines 10-13). **Operator
blocking-item hygiene**: regenerate the address doc from the deployment
artifact; add RPC rotation + epoch-109 secret reveal to the runbook.

## 2. Medium findings

**F6. `cli.ts reduce-epoch` silently applies at most one patch.**
`cli.ts:223-230` filters to the epoch parent then calls
`applyPatch(currentState, patch)` per item; `applyPatch` re-validates
`patch.parentStateRoot` against the *already-advanced* state
(`state/patch.ts:229-231`), so all subsequent patches fail E01 and are
`continue`d. It is a third, divergent copy of the reducer (wrong tiebreak
source: caller-supplied `r.patchHash` instead of `computePatchHash`; no
`policyAtomsMode`). Any auditor using it reproduces a wrong newStateRoot for
multi-patch epochs. Fix: delete the inline loop; call `reduce()`.

**F7. Header cells (0–31) are miner-writable with no semantic invariant.**
HEADER_UPDATE (0x06) is not r5-suppressed (`state/patch.ts:506-522`) and MIXED
reaches 0–31; reserved masks zero only *reserved* bits
(`state/validate.ts:63-105`) — MAGIC/SCHEMA/EPOCH/SCORE_ACCUMULATOR/PATCH_COUNT
are freely settable and nothing re-checks `MAGIC == 0xC07E` post-apply. A miner
can piggyback header corruption onto a genuinely-improving MIXED patch (the
composite gate never reads header cells). Same allowance on-chain
(`BotcoinMiningV4.sol:1276`). Fix: freeze MAGIC/SCHEMA/WORD_COUNT via
expected-value masks, or drop 0–31 from minable ranges in both TS and V4.

**F8. Failed cutover freezes CoreTex for up to a full epoch.** On `runCutover`
failure the next attempt is the *next* epoch's timer
(`coretex-epoch-cutover.ts:317-329`); submissions stay frozen from step 2 with
no intra-epoch retry. A transient RPC/S3 blip ⇒ lane closed ~24h. Fix: bounded
resume loop while `getInProgressEpoch() !== null`.

**F9. Cutover resume skips GET-and-rehash for artifacts published before a
crash.** The step-10 comment claims previously-published artifacts are
re-verified on resume (`coretex-epoch-cutover.ts:569-572`) but
`listQueuedEvalArtifacts` filters `status != 'published'`
(`coretex-cutover-store.ts:291`) — a crash between step 5 and step 10 leaves an
artifact whose public bytes are never rehash-verified while the chain already
commits to them. Fix: journal step-5 `UploadRecord[]` and re-verify from the
journal.

**F10. `fundEpoch` ignores registry-reverted epochs.** After
`ownerRevertEpoch`, credits from the reverted epoch remain fundable/claimable —
`fundEpoch` (`BotcoinMiningV4.sol:742-752`) checks no registry state.
Mitigation today is purely operational. Fix: one conditional revert when
CoreTex context exists and `coreTexRegistry.epochReverted(epochId)`.

**F11. Accepted-eval artifacts published pre-reveal are a per-accept oracle.**
The artifact embeds `gateSeed`/`confirmSeed` + exact gate/confirm scores
(`replay/eval-report-artifact.ts:38-58`) and is published at accept time
(`production-evaluator.ts:609`). With the public corpus this reproduces the
full hidden pack for that accepted eval. Seeds are patch-bound (no reuse), but
accepted-patch family-level telemetry leaks. Decide: accept + document, or
publish commitment now / body post-reveal.

**F12. Validator: dead security parameter + silent state-file
reinitialization.** (a) `expectedHiddenSeedCommit` is accepted by
`replayCoreTexFromLogs` but never read; `HIDDEN_SEED_COMMIT_MISMATCH` is
unreachable (`replay/coretex-registry.ts:193,162`) — verified out-of-band by
`readChainContext`, but the API silently no-ops a security-looking option.
(b) A corrupt trusted-state file parses to `null`/`{}` and is silently
overwritten, dropping the eval backlog + replay cursor
(`validator-sync-cli.ts:490-497,352-355`) — and setup writes that same file
non-atomically (`validator-setup-cli.ts:179-181`), including the gap-3c
`baseCorpusPath/baseCorpusRoot` anchor. Fix: enforce-or-delete the option;
hard-fail on corrupt state; tmp+rename in setup.

**F13. Miner-facing error-code contract drift.** Doc tells miners to branch on
`code`, but: `W05_RELEVANT_NEAR_COLLISION` / `W06_STATE_NOT_ADVANCED` are
documented (`MINER_SKILL.md:166-173`) yet never emitted by the submit path
(only defined in `rewards/work-units.ts:293,298`); doc says `W02_STALE_PARENT`
while code emits `W02_STALE_PARENT_AT_SIGNING`
(`coretex-coordinator-core.ts:1148`). Also the doc's claim that E04
reserved-bit masks are enforced "on-chain in `_wordMatchesPatchType` + r5
policy-region validators" (`MINER_SKILL.md:158`) is false — on-chain checks are
index-range only; value grammar is TS/coordinator-side. Fix doc + align W02
code string (or emit both).

**F14. `canonicalJson` exists in ~7 divergent copies feeding signed/hashed
artifacts** (`corpus/delta.ts:285`, `eval/retrieval-corpus.ts:407`,
`corpus/epoch-rotation.ts:198` (throws on undefined),
`bundle/index.ts:1211` (undefined→null), `rewards/work-units.ts:418`,
`eval/index.ts`, `replay/eval-report-artifact.ts:213`). Concrete consequence:
`bundleHash` is sensitive to explicit-`undefined` keys that JSON round-trips
drop — `{...profile, knob: undefined}` hashes `"knob":null`, then re-verify
after a disk round-trip reports a spurious mismatch (fail-closed footgun).
NaN/Infinity silently hash as `null`. This is the single highest-leverage
consolidation in the repo (see Q1).

**F15. First-read docs are generations stale.**
`release/calibration/CURRENT.md` (the designated single first-read doc) has
zero references to the v16 atom lane or any 2026-06 hardening;
`REPO_LAUNCH_SURFACE.md:88` claims bundleHash `0x474cd885…` (two lanes old);
`scripts/miner-api-contract-gate.mjs:22-24` usage comment names a dead profile
lane while the code defaults to v16. Fix: one stale-doc sweep before launch.

## 3. Low findings (verified, condensed)

- Contracts: dead/unreachable code — `PATCH_HASH_DOMAIN` constant unused *and*
  semantically wrong (`keccak(string)` vs the actual `keccak(string‖bytes)`
  scheme) (`V4:149`); `CoreTexImprovementTooSmall` unreachable (on-chain floor
  is effectively 1 ppm; the real `minImprovementPpm` is coordinator-only —
  doc:172 misattributes) (`V4:1007,1017-1021`); double `receiptUsed` check
  (`V4:684` + `:938`); `policy.screenerWorkBps == 0` and the int64-cap clause
  unreachable (`V4:658,1048`); `NotEligible` selector dead.
- Contracts ops: `setEpochCommit` before `setCoreTexEpochContext` bricks the
  CoreTex lane for that epoch (`V4:839` + `:930/:987`) — orchestrator orders
  correctly, but no on-chain order guard; `finalizeStakeModeSwitch` is
  permissionless and rewrites `effectiveStakeMode` for *past* epochIds;
  `tierCreditsOfAt` reads current stake regardless of epochId (name implies
  history it doesn't perform) (`V4:456-459,528-535`); `issuedAt >
  block.timestamp` reverts on 1s coordinator skew (`V4:958`); tier-credit table
  in the skill doc (5 tiers) is V3 runtime config, unverifiable in-repo.
- Substrate/state: batch `reduce()` accepts `marginalGain == threshold` while
  live path requires strict `>` (`reducer/reducer.ts:234` vs
  `live-epoch.ts:110`) — align to live/chain strictness; hand-built `Patch`
  with `indices.length < wordCount` silently part-applies
  (`patch.ts:265-270`) — add a length assert; float math in
  `difficulty.ts:187` and persisted frontier `ewmaAccepts` is a cross-language
  replay hazard (document or fix before any non-JS validator);
  `admitCorpusBatch` caps are batch-local, contradicting their doc
  (`corpus/admission.ts:18-21,71,113`); r5 `verify-epoch` correctness hinges on
  a manually-passed `--policy-atoms-mode` flag (`cli.ts:284-286`) — derive from
  the bundle; CLI emits `0x0x…` roots (`cli.ts:150-153`).
- Validator: exit 0 with an undrained score backlog (only `--skip-score-replay`
  gets exit 3) — add a distinct exit code; no timeout/size-cap on any HTTP
  fetch (hangs an unattended loop); npm `version 0.1.0` vs
  `CORTEX_CLIENT_VERSION '0.7.0'`; old-registry `event-topics.ts`
  exported undeprecated beside canonical `CORETEX_EVENT_TOPICS`.
- Integration: dedup-terminal write + receipt persistence are separate
  transactions (crash window strands an accepted patch as
  `duplicate_submission`; second window redispatches a GPU eval) —
  single-transaction both; rate-limit maps never evict keys; single-process
  assumption undocumented (no sidecar holder lock); `faucet.ts` stub returns
  503 even when env-configured — if production has a real faucet, the port
  silently disables it (operator must check); `FRONTEND_STAKE_CONTRACT_ADDRESS`
  newly boot-required (deployments without it fail to boot).
- Publishing/ops: 520-line canonical `evolve-corpus.mjs` lives in
  `scripts/lib/` (repo-rule violation), is spawned by the production epoch
  runner, and escapes bundle attestation — undocumented asymmetry; dead
  `systemd` doc pointer (`CORETEX_LAUNCH_PLAN_v2.md` doesn't exist);
  `ops/testnet/` empty; root `id_ed25519` confirmed untracked + passphrase-locked.

## 4. Handoff-lane verdicts

| Lane | Verdict |
|---|---|
| 1. GPU scorer / calibration preservation | **PASS in design** — streaming default forced, stub/deterministic unreachable in production, parent re-merkleized, 8-check verify-before-sign in the adapter, no calibration-affecting commits found. Caveats: F4 (auth/secret), and the canonical result-verifier lives only in the integration repo (export `verifyScorerJobResult` from cortex). |
| 2. Validator standalone | **NOT ready as documented** — F3 blocks the bare path; otherwise PASS (npm pack verified 276 files incl. python + corpus scripts; entrypoint clean of coordinator code; pagination/finality, TOFU, atomic staging, post-reveal CPU rescore all verified). |
| 3. Miner public surface | **PASS** except F13 doc drift. Gate script ALL PASS; sanitizer is allow-list; no gradient/qrel/seed leakage found. |
| 4. Coordinator EC2 patch | **Sidecar-shaped, standard lane byte-identical** outside `server.ts` additive mounting + 2 deliberate env hardenings + 2 compile-fix stubs. **F2 must be fixed (or runbooked) before port.** |
| 5. Epoch cutover | **PASS** — chain-clock driven, 15 journaled steps, idempotent, crash-resume tested; gaps F8 (retry) and F9 (resume rehash). Baseline recompute provably targets the live root. |
| 6. Contracts / chain clock | **PASS** — clock/V3 stake/registry-caller/self-staking-switch all verified with tests; F10 + low items optional hardening. TS↔Solidity wire grammar verified field-by-field (all asymmetries are TS-stricter). |
| 7. Publishing / launch coherence | **FAIL until rebundle** — F1/F5; signing flow itself is coherent (RSA-signed rotation/deltas, TOFU key pin, chain backstop via baselineManifestHash). |

**Remaining operator-only steps** (consolidated): rebundle/repin/republish
post-hardening (F1) → recompute blank-substrate baseline on the final scorer
path → publish real epoch signing keypair (F3 ties in) → regenerate
`contract-addresses-mainnet.md` from the final deploy artifact (F5) → reveal
epoch-109 secret at close → rotate the credentialed RPC secret → EC2 cutover
checklist (instance-profile creds, metrics file, `CORETEX_ENABLED=true` last).

## 5. Code-quality / restructuring program ("code judo", ranked by leverage)

**Q1. One `src/canonical/` module: `canonicalJson` + hex/bytes + int codecs.**
Replaces ~7 `canonicalJson` copies (F14) and ~11 `hexToBytes`/`bytesToHex`
copies plus duplicated LEB128/BE-int writers (`patch.ts:27-68` vs
`shards.ts:59-65` vs `seed-derivation.ts:84-92` vs `codec.ts:69-86`). Unified
semantics: codepoint key sort, **skip undefined keys**, throw on NaN/±Inf,
hex-encode Uint8Array, Map→sorted object. Gate with golden tests hashing one
real delta/rotation/bundle/work-policy against current digests. Deletes the
single largest consensus-drift class in the stack.

**Q2. One region/patch-type descriptor table.** The substrate geometry is
encoded ≥6× in TS (`state/types.ts:78`, `patch.ts:422`, `validate.ts:17-61`,
`retrieval-decoder.ts:313-327,705-709`, `slot-policy.ts:33-41`) and a 7th time
in Solidity `_wordMatchesPatchType`. Derive all TS structures from one frozen
`REGION_TABLE`, and add a golden test that emits/compares the Solidity body so
TS↔chain drift becomes a failing test instead of an audit item.

**Q3. Decompose the five god-files** (pure moves, test-pinned):
`eval/retrieval-benchmark.ts` (3,134 — split the ~1,400-line
`scoreSubstrateAgainstQuery` into staged pipeline functions; collapse ~50
optional flags into capability objects so "default-off" is encoded by absence);
`validator-sync-cli.ts` (2,253 — extract
`validator/{trusted-state,eval-backlog,corpus-autoresolve,chain-context}.ts`,
CLI keeps flags + wiring; also removes module-level `args` globals);
`coretex-sidecar.ts` (1,869 — persistence/chain-client/signer/guards/env into
five files); `bundle/index.ts` (1,843 — models/profile/manifest split +
declarative rule-table replacing the 315-line `validateProfile` if-chain);
`coretex-coordinator-core.ts` (1,719 — extract pure submit-validators +
`ChainReplayTracker`).

**Q4. Stop hand-mirroring cortex contracts in the integration repo.** Import
`ScorerJobRequest/Result/Health` + `unpack` from `@botcoin/cortex/coordinator`
(currently re-declared, `coretex-remote-scorer.ts:95-197`,
`coretex-sidecar.ts:1744-1753`); export a canonical `verifyScorerJobResult`
and the EIP-712 field list/tuple encoder from cortex so the signature-grade
schema exists once. Replace `as never` / hand-asserted status shapes with the
real exported types.

**Q5. One accept-loop core for reducer/live/CLI.** `reducer/reducer.ts`,
`reducer/live-epoch.ts`, and the broken `cli.ts` copy share ~80% (E→R/L code
maps duplicated verbatim). One parameterized core fixes F6, makes the
F-threshold strictness (`<` vs `<=`) one explicit parameter, and deletes the
third copy.

**Q6. Single-pass registry replay with parent capture.** Sync re-decodes and
re-applies the whole window after `replayCoreTexFromLogs` already did
(`validator-sync-cli.ts:1610-1622`); an `onAdvanceApplied` callback halves
replay CPU and deletes the duplicate walk + its internal-consistency throw.

**Q7. Shared infra helpers.** One NDJSON-subprocess client (~150 duplicated
lines between `bi-encoder.ts:191-302` and `reranker.ts:372-513`, whose
`close()` already diverges); one `assertCpuOnly(allowCuda?)` (scorer-server
currently *deletes env vars* to bypass the GPU guard,
`scorer-server-cli.ts:511-512` — make it a parameter); one fetch util with
timeout/size-cap (3 divergent HTTP implementations; also fixes the validator
hang); one env-schema table for the ~40 CoreTex vars with alias handling;
`Promise.all` the independent RPC reads in `readChainContext` (11 serial
calls), `reloadEpochContext`, and cutover `start()`.

**Q8. Contracts cleanup (V5-or-now).** Delete dead constant/guards/selectors
(above); reuse `_coreTexEpochLocked` in `setCoreTexRegistry` (V4:856); split
`submitCoreTexReceipt` into `_creditScreener`/`_creditStateAdvance`; sort the
policy list at insert so `activeCoreTexRulesVersion` stops being an O(64)
storage walk per receipt; split the overloaded `InvalidCoreTexRoot` (15 call
sites) into actionable selectors; extract `EpochRewardLedger`/`NativeStaking`
bases for V5 instead of the current wholesale V3 copy-paste.

**Q9. Delete/quarantine dead rails.** `workers/` pool scores via the STUB
evaluator and has zero importers — delete or wire to production (a second
"evaluate a patch" entrypoint in the shipped package is a footgun);
`reducer/multiplier-cap.ts` + `funding-tx.ts` (CortexMergeBonus,
mathematically-zero uplift, removed from canonical registry) moved out of the
default path; old-registry `event-topics.ts` + `replay/v4.ts` decoders +
`verify-epoch/` marked
deprecated or dropped from the default entrypoint; `writeTofuKeyPin`,
`expectedHiddenSeedCommit`, `noProgressFlag` dead exports removed.

## 6. Remediation status (2026-06-11, same day)

Implemented and test-green after operator review of the findings (cortex
commits `9d1678e..955b723`, integration `24cc618..80dcfe4`):

- **F2** sidecar boot failure now fail-closes the CoreTex lane (503
  `coretex_boot_failed`) instead of killing the coordinator.
- **F3** validator defaults the epoch signing public key to
  `<artifact-base>/epoch-rotations/epoch-signing-public.pem`.
- **F4** scorer-server: bearer auth (required off-loopback), secretless host
  (the coordinator derives + ships the eval seeds; `CORETEX_EPOCH_SECRET` on
  the scorer box is now a boot error), self-drawn-blockhash fallback
  removed.
- **F6** `reduce-epoch` CLI delegates to the canonical reducer.
- **F7** header cells frozen under r5 (E02 on any 0–31 write; HEADER_UPDATE
  r5-suppressed; MIXED advertises from the MemoryIndex start).
- **F8/F9/qualified-F11** cutover intra-epoch retry; resume re-verifies
  previously published artifacts; `PublishBeforeReveal` hard guard.
- **F10** V4 refuses to fund/finalize a registry-reverted CoreTex epoch.
- **F12(b)** corrupt validator state now hard-fails; setup writes atomic.
- **F13** miner skill doc aligned to emitted codes (`W02_…_AT_SIGNING`,
  W05/W06 marked reserved, on-chain-E04 claim corrected).
- **F14/Q1** one `canonicalJson` (`src/canonical/json.ts`) with golden tests;
  **Q2** patch-type descriptor table + TS↔Solidity parity test; **Q4**
  canonical scorer wire types + verify-before-sign exported from
  `@botcoin/cortex` and imported by the integration; **Q5** shared
  reducer/live accept kernel.

Still open: **F1** rebundle/repin/republish (operator one-shot — now also
picks up this hardening), **F5** address-doc regeneration + RPC-secret
rotation + epoch-109 reveal (checklisted in the wiring runbook), F12(a)'s
dead `expectedHiddenSeedCommit` parameter, F15 stale first-read docs, the
god-file decompositions (deliberately deferred), and the remaining low
findings.

## 7. Bottom line (original audit)

The protocol core is in genuinely strong shape: every fail-closed claim
checked out under line-level reading, the anti-grinding design (atomic
seed-pin + admission charge, dual-pack, future-blockhash binding, allow-list
sanitizers) is implemented as documented, TS↔Solidity wire grammar matches
field-for-field, and all 1,133 tests/gates pass fresh. What stands between
this tree and launch is not protocol logic: it is **F1 (stale published
bundle), F2 (restart fragility of the integration), F3 (validator key
bootstrap), F4 (scorer-server exposure), F5 (address/secret bookkeeping)** —
all small, well-localized fixes — plus the F6–F15 mediums, most of which are
one-file changes. The dominant structural debt is duplication of
consensus-critical primitives (Q1/Q2/Q4); paying those three down converts the
stack's main remaining risk class (silent drift between copies) into
compile-time/test-time failures.
