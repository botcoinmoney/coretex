# CoreTex Miner Quickstart

This is the current miner-facing flow for the retrieval-native CoreTex lane.
It replaces the archived CoreTex pre-launch miner guide.

Miners do not need private coordinator state or local model inference. The
minimum miner uses Base reads, the published CoreTex bundle, the per-miner
challenge packet, and a single `POST /coretex/submit` write.

## Public Inputs

- Base mainnet `CortexState.getEpoch(epoch)`
- `GET /coretex/status` — non-secret dynamic context (lane, epochId, stateRoot,
  corpusRoot, coreVersionHash, bundleHash, minImprovementPpm, evalSeedCommit,
  substrate.uri, bundle.uri, plus an auto-injected `statusVersion` poll token)
- `GET /coretex/challenge` — singular dynamic packet for this miner (lane,
  challengeId, expiresAt, epochId, parentStateRoot, coreVersionHash, bundleHash,
  substrate descriptor)
- `GET /coretex/bundle/<bundleHash>` — pinned bundle manifest
- `GET /coretex/bundle/by-core-version/<coreVersionHash>` — alias resolver
- `GET /coretex/substrate/<stateRoot>` — immutable substrate snapshot
- `GET /coretex/corpus-delta/<epoch>` — signed corpus delta with embedding
  payloads needed for replay

Hidden and canary corpus content is never returned by these endpoints. Miners
build patches against the published substrate + bundle artifacts and rely on
the coordinator's dual-pack evaluator (bound to a future Base blockhash the
coordinator cannot observe at receive time) to score honestly.

## Submit Flow

1. Read the current epoch from `BotcoinMiningV4.currentEpoch()` and
   `CortexState.getEpoch(epoch)`. Cross-check `GET /coretex/status` returns the
   same `epochId`, `bundleHash`, and `corpusRoot`.
2. Fetch the bundle whose hash matches the epoch `coreVersionHash`.
3. Fetch the current substrate via `GET /coretex/substrate/<stateRoot>` (the
   `stateRoot` comes from `status` or the `challenge` packet).
4. Fetch the per-miner challenge packet via `GET /coretex/challenge`.
5. Build a compact 1-4 word patch against the parent state root in the packet.
6. `POST /coretex/submit` with the patch. The coordinator runs the dual-pack
   evaluator and returns either:
   - `{ status: 'accepted', patchHash, evalReportHash?, receipt? }` — the
     `receipt` is the EIP-712 signature the miner submits to
     `BotcoinMiningV4.submitWorkReceipt(...)`, or
   - `{ status: 'rejected', code: 'rejected', patchHash? }` — opaque by design,
     no internal reason is leaked.
7. (Optional) Poll `GET /coretex/eval-report/:hash` post-acceptance for the
   detailed report retained for audit.

## Verification Flow

Auditors and miners reproduce the accepted transition from:

- on-chain `CoretexPatchBytes` / `WorkCreditAccepted` /
  `CortexStateAdvanced` events
- the published bundle and corpus/delta chain
- the revealed epoch eval seed
- the `PatchReceivedNotice` fetched via `GET /coretex/patch-received/<hash>`
  (cross-checks the coordinator did not delay-process to wait for a favorable
  blockhash)
- the current 1024-word substrate root

The coordinator cache is a convenience. Replay correctness must not depend on
private coordinator state.
