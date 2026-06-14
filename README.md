# Botcoin CoreTex

CoreTex is Botcoin's retrieval-memory mining lane. Miners submit compact
patches to a 1024-cell substrate. The coordinator evaluates each patch against
a pinned corpus, evaluator profile, and reranker stack, then issues a signed
receipt when the patch clears either the screener gate or the state-advance
gate. Validators independently verify public artifacts, replay on-chain state
advances, and check registry-pinned roots.

CoreTex is a protocol for proposing, scoring, crediting, publishing, and
replaying changes to a deterministic memory retrieval substrate.

The standalone validator client lives at
[botcoinmoney/coretex-client](https://github.com/botcoinmoney/coretex-client).
Use that repo as the default entry point for running the client.

## Quick Start

```bash
npm install
npm run build
npm run test:unit
forge test --root contracts -vv
```

Validator bootstrap:

```bash
npm run setup:validator
npm run setup:validator:verify
npm run validator:verify-launch
npm run validator:replay
```

The main public docs are:

- `docs/BOTCOIN_CORETEX_DOCS.md` — system overview.
- `docs/BOTCOIN_CORETEX_MINER_SKILL.md` — miner-facing API and patch flow.
- `docs/CORETEX_VALIDATOR_STANDALONE_RUNBOOK.md` — validator setup/sync/replay.
- `docs/CORETEX_COORD_WIRING_RUNBOOK.md` — production coordinator wiring and launch gates.
- `docs/miner-api-contract.md` — public `/coretex/*` API contract.
- `specs/` — protocol specifications.

## How To Navigate This Repo

| Path | Purpose |
|---|---|
| `packages/coretex/src/state/` | 1024-cell state type, packing, merkle roots, compact patch decode/apply, reserved-bit validation |
| `packages/coretex/src/substrate/` | Retrieval substrate decoder: MemoryIndex, Temporal, Relations, r5 PolicyAtoms |
| `packages/coretex/src/eval/` | Corpus model, query-pack derivation, retrieval benchmark, reranker adapters, seed derivation |
| `packages/coretex/src/rewards/` | Baseline, difficulty, screener threshold, work-unit policy |
| `packages/coretex/src/replay/` | Public replay and V4 receipt/artifact verification |
| `packages/coretex/src/coordinator/` | Coordinator-only primitives: endpoint contract, per-patch evaluator, remote-scorer verification |
| `packages/coretex/src/corpus/` | Epoch corpus delta and rotation manifest primitives |
| `packages/coretex-py/` | Python reference implementation for state/patch/merkle parity |
| `packages/coretex-handler/` | Small SQLite handler/store package used by integration harnesses |
| `contracts/src/` | `CoreTexRegistry`, `BotcoinMiningV4`, and supporting contracts |
| `scripts/` | Build, calibration, scorer, validator, epoch, and launch-gate harnesses |
| `release/bundle/` | Candidate evaluator profiles and bundle manifests |
| `release/calibration/` | Minimal launch manifests and replay fixtures kept in source control |
| `docs/` | User, operator, and validator documentation |
| `specs/` | Canonical protocol grammar and determinism specs |

## Stack Overview

The production path has five layers:

```text
public corpus + Memory IR
  -> 1024-cell CoreTex substrate
  -> candidate retrieval and substrate-driven routing
  -> Qwen3 reranker scoring over hidden query packs
  -> coordinator-signed V4 receipt
  -> on-chain credit + registry event
  -> validator replay
```

The runtime roles are deliberately separated:

| Role | Responsibilities | Must not do |
|---|---|---|
| Miner | Read `/coretex/status`, build compact patches, submit patches, broadcast signed receipts | See hidden qrels, receive per-patch scores, alter receipt fields |
| Coordinator | Enforce auth/rate limits, score patches, sign receipts, publish epoch artifacts, pin epoch context | Accept proxy/fake scoring, expose hidden eval material, sign unverifiable receipts |
| Remote scorer | Run keyless Qwen scoring jobs and return canonical proof fields | Hold coordinator signing keys or epoch secrets |
| Contracts | Verify coordinator EIP-712 receipts, serialize state advances, credit work, expose replay events | Recompute hidden evals or trust miner-supplied work units |
| Validator | Fetch public artifacts, verify signatures/hashes, replay registry events and eval reports | Sign receipts, mine patches, write S3 artifacts |

## Protocol Flow

1. The coordinator publishes status for the current epoch: state root, corpus
   root, active frontier, bundle hash, baseline manifest hash, patch surfaces,
   thresholds, and miner receipt cursor.
2. A miner fetches the confirmed substrate root and submits a compact patch:
   `{ patchBytesHex, parentStateRoot, minerAddress }`.
3. The coordinator checks structure first: parent root, word budget, legal
   ranges, reserved bits, no-op, duplicate/in-flight submissions.
4. The coordinator scores the patch on domain-separated gate and confirm packs.
5. A low-but-real improvement can earn a `SCREENER_PASS`; a larger improvement
   can earn a `STATE_ADVANCE`.
6. The coordinator signs an EIP-712 `CoreTexReceipt` with exact work units,
   pins, score fields, receipt cursor, expiry, and patch bytes.
7. The miner broadcasts the receipt to `BotcoinMiningV4`.
8. `BotcoinMiningV4` validates the signature, receipt cursor, pins, score
   delta, patch hash, work units, screener cap, and state transition.
9. `CoreTexRegistry` records accepted state advances as replayable events.
10. Validators fetch public artifacts and replay roots against the registry pins.

## Substrate Design

The substrate is exactly 1024 EVM `uint256` state cells, serialized as 32,768
bytes. State-cell indices are 0-1023 inclusive. All roots are deterministic
Merkle roots over the packed state.

| Range | Cells | Count | Purpose |
|---|---:|---:|---|
| Header | 0-31 | 32 | protocol metadata, prior root, corpus root, score counters |
| MemoryIndex | 32-383 | 352 | stride-1 memory-object slots |
| RetrievalKeys / r5 PolicyAtoms | 384-671 | 288 | r4 lens compatibility; r5 evidence/conflict/abstention atoms |
| Relations | 672-799 | 128 | typed relation edges and category-lens entries |
| Temporal | 800-895 | 96 | current/stale validity and revocation map |
| Codebook / r5 reserved policy capacity | 896-991 | 96 | r4 compatibility; r5 reserved capacity |
| Reserved | 992-1023 | 32 | future compatibility; not miner-writable |

Current launch posture uses the r5 policy-atom interpretation. The active
interpretation is gated by the bundle profile; r4 dense-lens semantics and r5
PolicyAtom semantics are never silently mixed.

Patch wire format is defined in `specs/patch_format.md` and implemented in
`packages/coretex/src/state/patch.ts`.

Patch constraints:

- `wordCount` is 1-4.
- Parent root is included in the JSON body and embedded in the wire bytes.
- Old words are reconstructed from the parent state; they are not on the wire.
- Reserved bits must stay zero after applying the patch.
- Reserved range 992-1023 is not a miner reward surface.
- `scoreDelta` in miner-submitted wire bytes is informational; for state
  advances the coordinator rewrites it before signing so the contract can
  enforce `scoreAfterPpm - scoreBeforePpm`.

## Corpus And Evaluation

The corpus is a deterministic production corpus assembled from Memory IR style
events. Public fields drive retrieval, rendering, candidate routing, and
query-local policy atoms. Hidden query packs and qrels are derived from pinned
epoch inputs and are not exposed through miner endpoints.

Main corpus/eval files:

- `packages/coretex/src/eval/retrieval-corpus.ts`
- `packages/coretex/src/eval/public-corpus-index.ts`
- `packages/coretex/src/eval/memory-ir-render.ts`
- `packages/coretex/src/eval/hidden-query-pack.ts`
- `packages/coretex/src/eval/retrieval-benchmark.ts`
- `scripts/lib/build-v2-production-corpus.mjs`
- `scripts/materialize-production-corpus.mjs`

The scorer path is retrieval-dominant. It builds a first-stage candidate pool,
applies substrate-driven routing/bias, renders evidence bundles, and scores
with the pinned Qwen reranker. Composite score components include nDCG@10,
temporal current/stale accuracy, relation recall, abstention behavior, and
structural validity. The active weights and thresholds are pinned in the
evaluator profile and bundle manifest.

## Acceptance And Rewards

Screener and state-advance policy lives in:

- `packages/coretex/src/rewards/work-units.ts`
- `packages/coretex/src/rewards/difficulty.ts`
- `packages/coretex/src/rewards/baseline.ts`
- `contracts/src/BotcoinMiningV4.sol`

Core rules:

- Screener passes pay the base CoreTex work tier but do not move the state root.
- State advances must clear the real advance threshold on both gate and confirm packs.
- Screener threshold is dynamic: it tracks headroom, measured noise, and the
  state-advance threshold floor.
- Per-miner screener passes are capped per epoch on-chain.
- State-advance work multipliers increase with global screener passes since the
  last advance, then reset when an advance lands.
- Receipts expire and are chained through `nextIndex` / `lastReceiptHash`.

## Contracts

Main contracts:

- `contracts/src/CoreTexRegistry.sol` — live root, epoch context pins, transition events, registry seal.
- `contracts/src/BotcoinMiningV4.sol` — standard lane + CoreTex receipts, credits, funding, claims.

Run:

```bash
forge build --root contracts --sizes
forge test --root contracts -vv
```

The contract tests include screener cap enforcement, exact work-unit checks,
receipt mutation rejection, registry/root atomicity, policy scheduling,
standard/CoreTex credit sharing, and invariants over credit totals and roots.

## Validator Surface

The validator package verifies the public side of the protocol:

- launch manifest hashes and signatures;
- bundle/profile/corpus pins;
- epoch corpus deltas and rotation manifests;
- epoch signing public key continuity;
- on-chain registry/mining context;
- state-advance event replay;
- eval report artifact binding.

Package exports:

```ts
import { ... } from "@botcoin/coretex";
import { ... } from "@botcoin/coretex/validator";
```

CLI binaries:

- `coretex-validator-setup`
- `coretex-validator-sync`
- `coretex-replay`
- `botcoin-coretex`

## Coordinator Surface

Coordinator-only exports live under:

```ts
import {
  CoreTexCoordinatorCore,
  createCoreTexCoordinatorRouteHandler,
  createRetrievalDataSource,
} from "@botcoin/coretex/coordinator";
```

The coordinator API has exactly five CoreTex v0 routes:

- `GET /coretex/health`
- `GET /coretex/status?miner=0x...`
- `GET /coretex/substrate/:stateRoot`
- `POST /coretex/submit`
- `GET /coretex/receipt/:hash`

Do not add alternate public CoreTex route surfaces. The miner contract is in
`docs/BOTCOIN_CORETEX_MINER_SKILL.md` and `docs/miner-api-contract.md`.

## Calibration And Harness Lineage

The final design is the product of bottom-up harnesses rather than static
schema guesses. The important public harness classes are:

| Harness / script | What it influenced |
|---|---|
| `scripts/measure-temporal-yield-incontext.mjs` and `scripts/measure-temporal-honest-lift-yield.mjs` | Temporal stayed as a launch surface because it produced consistent hidden-query lift. |
| `packages/coretex/test/unit/temporal-capacity-crosslayer.test.mjs` | Locked the stride-1 MemoryIndex + 96 temporal-record capacity across decoder/validator layers. |
| `scripts/probe-r5-a100-oracle.mjs`, `scripts/probe-r5-cpu-benchmark.mjs`, `scripts/probe-policyatom-separability.mjs` | Drove the r5 PolicyAtom direction: bounded, public-feature, query-local atoms instead of static dense lens policy. |
| `scripts/probe-r5-relation-typed.mjs` and `scripts/relation-trace-harness.mjs` | Kept relation routing bounded and scorer-mediated. |
| `scripts/probe-r5-abstention-margin.mjs` | Informed abstention atom gating and margin behavior. |
| `scripts/screener-threshold-calibration.mjs`, `scripts/screener-credit-e2e.mjs`, `scripts/smoke-screener-threshold-mechanics.mjs` | Tuned screener threshold mechanics and verified state-advance-relative flooring. |
| `scripts/baseline-recalibration-e2e.mjs` and `scripts/recalibrate-baseline.mjs` | Validated baseline recompute and variance binding after corpus/frontier rotation. |
| `scripts/churn-launch-e2e.mjs`, `scripts/frontier-determinism-smoke.mjs`, `scripts/smoke-live-evolve-mechanics.mjs` | Shaped epoch churn, frontier rotation, and fail-closed evolve behavior. |
| `scripts/corpus-determinism-gate.mjs` and `scripts/memory-ir-launch-gate.mjs` | Locked corpus determinism and render safety. |
| `scripts/bundle-attestation-smoke.mjs` | Ensures behavior knobs are attested by bundle hash. |
| `scripts/miner-api-contract-gate.mjs` | Verifies the public miner API shape and no hidden-eval leakage. |
| `scripts/onchain-state-advance-dryrun.mjs` | Checks receipt/event/on-chain replay shape before broadcast. |
| `scripts/coretex-scorer-parity-harness.mjs` and `scripts/coretex-scorer-parity-compare.mjs` | Verify scorer parity across serving hardware and validator replay. |

Generated run outputs, model caches, materialized corpora, and score caches are
not tracked in source. Public source keeps deterministic code, specs, manifests,
fixtures, and reproducible harnesses.

## Launch Artifacts

Minimal public launch artifacts currently kept in source:

- `release/calibration/fixtures/state-root-vectors.json`
- `release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json`
- `release/calibration/2026-06-04-memory-atom-v16/bundle-manifest-v2-dgen1-policy-r5-atom-v16-300k-enabled.json`
- `release/calibration/2026-06-04-memory-atom-v16/evaluator-profile-v2-dgen1-policy-r5-atom-v16-300k-enabled.json`

Larger payloads are distributed through the launch artifact channel and verified
by SHA-256, size, Merkle root, bundle hash, and profile hash during setup.

## Common Commands

```bash
npm run build
npm run typecheck --if-present
npm run test:unit
npm run coretex:parity-gate

npm run setup:validator
npm run setup:validator:verify
npm run validator:verify-launch
npm run validator:sync
npm run validator:replay

npm run coretex:epoch-evolve:e2e
node scripts/bundle-attestation-smoke.mjs
node scripts/miner-api-contract-gate.mjs
node scripts/onchain-state-advance-dryrun.mjs --emit

forge build --root contracts --sizes
forge test --root contracts -vv
```

Python parity:

```bash
python3 -m pytest packages/coretex-py/coretex_py/tests/ -v
```

## Repository Hygiene

CI includes repository scanning with gitleaks and TruffleHog. The package
tarball for `@botcoin/coretex` is limited to `dist`, package metadata, README,
and the package-local scripts required by the validator/scorer tooling.
