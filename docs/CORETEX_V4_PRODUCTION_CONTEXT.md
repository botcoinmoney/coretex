# CoreTex V4 Production Context

Last updated: 2026-05-09.

## 2026-05-10 Frontier-Retrieval Correction

The current V4 infrastructure is strong, but the default `coretex-v4-launch`
reward profile is not the final frontier memory-retrieval benchmark. It is
still dominated by structural substrate commitment signals. The required final
shape is documented separately in
`docs/CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md`.

Do not call CoreTex production-ready as a memory-retrieval benchmark until the
retrieval-native plan is implemented: hidden query packs, substrate top-k
retrieval, Qwen3-graded relevance, `nDCG@10` as primary metric, and replayable
metric reproduction.

## Current Head

- `e1dfa5d coretex: complete DACR corpus rotation and reranker gates`
- `d2830bd coretex: enforce production provenance gates`

## What Changed

- Bundle provenance now fails closed:
  - Qwen3-Reranker-0.6B is pinned to Hugging Face commit `e61197ed45024b0ed8a2d74b80b4d909f1255473`.
  - The default model manifest includes per-file SHA-256 and byte counts.
  - Placeholder or mutable revisions (`main`, `latest`, `HEAD`, `v0.1.0`, tags for Qwen3) are rejected.
  - Bundle hash now covers reranker eval, DACR bridge, admission, deltas, epoch rotation, difficulty, coordinator endpoint contract, and replay code.

- Replay/watch is canonical by default:
  - `coretex-replay watch` requires `--bundle-manifest` and `--expected-bundle-hash` or `--core-version-hash`.
  - `--allow-unverified-bundle` is the explicit local-dev escape hatch.

- Patch encoding and apply paths now validate patch type/range consistency:
  - `KEY_UPDATE` targets retrieval keys only.
  - `SLOT_REPLACE` targets memory index only.
  - Temporal, relation, codebook, and header updates target their declared ranges.
  - `MIXED` permits valid non-reserved ranges.

- DACR corpus bridge is production-expanded:
  - Cross-miner distractor mining fills sparse trap records.
  - `question_metadata[i].coretex_family` overrides heuristic routing.
  - Session trajectories emit long-horizon events with multi-step relations.
  - Bookend pairs emit current/stale temporal pairs.
  - Corpus deltas now carry `addedRecords`, so they are independently publishable/replayable.

- Epoch rotation is publishable:
  - `buildEpochRotationManifest` binds previous/next corpus root, delta hash, challenge-book hash, bundle hash, next `minImprovementPpm`, observed advances, and quality attempts.
  - `signEpochRotationManifest` / `verifyEpochRotationManifestSignature` support signed cron output.
  - `scripts/build-corpus-delta-from-dacr.mjs` is the coordinator cron entrypoint.

- Reranker evaluation is enforced:
  - `rerankerFromEnv` refuses deterministic mode when `CORTEX_REAL_EVAL=1` unless explicitly overridden for local development.
  - `createQwen3Reranker` uses the native Python Hugging Face `transformers`/`torch` runner for `Qwen/Qwen3-Reranker-0.6B`; Transformers.js is intentionally not used for Qwen3 because the pinned model revision does not publish ONNX weights.
  - `cortex-server` real eval path uses `evaluatePatchWithReranker`, the production corpus root, optional expected bundle hash, and a configurable reranker threshold.
  - Phase-11 gates every iteration on reranker score instead of merely logging it.

- Coordinator route contract is hardened:
  - `CoreTexCoordinatorDataSource` has `authorize` and `rateLimit` hooks.
  - The cloned live coordinator at `/root/botcoin-coordinator-live` has a reference `/coretex/*` mount in `packages/coordinator/src/coretex-live.ts` and `server.ts`.
  - The mount is additive and only parses POST bodies inside the `/coretex/` guard, so `/v1/submit` remains untouched.

- Substrate slot rotation is deterministic:
  - `selectSubstrateSlot` maps near-collision events to retrieval keys and temporal/long-horizon events to memory index slots.
  - Retrieval-key slots wrap after 36 advances and memory-index slots wrap after 44 advances.
  - Callers can mark protected slots; the policy skips them and fails closed if a region has no writable slot.
  - Phase-11 now uses this policy instead of raw sequential slot math.

## Coordinator Env Contract

Live coordinator reference envs:

- `CORETEX_ENABLED=true`
- `CORETEX_MODULE_PATH=/root/cortex/packages/cortex/dist/index.js`
- `CORETEX_REQUIRE_AUTH=true`
- `CORETEX_OPERATOR_TOKEN=...`   # operator/replay-watcher token (replaces CORETEX_API_TOKEN for operator-only routes)
- `CORETEX_API_TOKEN=...`         # legacy fallback; used if CORETEX_OPERATOR_TOKEN is unset
- `CORETEX_RATE_LIMIT_PER_MINUTE_PER_MINER=30`   # per-authenticated-miner cap (default 30)
- `CORETEX_RATE_LIMIT_PER_MINUTE_GLOBAL=1500`     # global cap across all miners (default 1500)
- `CORETEX_ARTIFACT_DIR=/app/packages/data/coretex`
- `CORETEX_STATE_PACKED_PATH=/app/packages/data/coretex/current-state.bin`
- `CORETEX_EVALUATOR_URL=http://127.0.0.1:8787`
- `CORETEX_EVALUATOR_MAX_QUEUE=32`   # max evaluator sidecar queue depth before 503 (default 32)
- `CORETEX_BUNDLE_MANIFEST_PATH=/app/packages/data/coretex/client-bundle.json`
- `CORETEX_EXPECTED_BUNDLE_HASH=0x...`   # 32-byte hex; triggers on-chain bundle binding assertion at startup
- `CORETEX_STARTUP_RPC_URL=...`          # RPC for startup bundle assertion (defaults to BASE_RPC_URL)
- `CORTEX_STATE_ADDRESS=0x...`           # CortexState contract address (required for I5 assertion)

### Auth model change (I1)

Miners authenticate with their existing V3 HMAC JWT (`Bearer <token>` issued by `/v1/challenge`).
The JWT `sub` claim (miner Ethereum address) is extracted and used as the rate-limit key.

Operator-only routes (`/coretex/health`, `/coretex/client-bundle/:hash`) also accept
`CORETEX_OPERATOR_TOKEN` for replay watchers and monitoring scripts that do not hold a miner JWT.

Old `CORETEX_API_TOKEN` still works as a fallback operator token if `CORETEX_OPERATOR_TOKEN` is unset.

---

## Ops Runbook

### Rollback / Kill Switch

#### Disable /coretex/* without affecting V3 routes

```bash
export CORETEX_ENABLED=false
systemctl restart botcoin-coordinator

# Verify CoreTex is down:
curl -s http://localhost:3000/coretex/health | jq .
# Expected: HTTP 503  {"error":"coretex-disabled"}

# Verify V3 is still alive:
curl -s "http://localhost:3000/v1/challenge?miner=0xYOUR_MINER" | jq .epochId
# Expected: 200 OK with a valid epochId
```

Expected coordinator restart time: **< 30 s** (no chain sync needed; coordinator is stateless on startup).

Confirmation checks post-restart:
1. `GET /health` → `{"ok":true,"signer":"0x..."}` (200)
2. `GET /coretex/health` → `{"error":"coretex-disabled"}` (503)
3. `GET /v1/challenge?miner=0x...` → challenge JSON (200)

#### Pause V4 reward signing while keeping CortexState alive

```bash
# Option A: halt ALL state advances chain-wide by zeroing the reward lane
cast send --rpc-url $BASE_RPC_URL --private-key $OWNER_PK $CORTEX_STATE_ADDRESS \
  'setRewardLane(address)' 0x0000000000000000000000000000000000000000

# Verify:
cast call --rpc-url $BASE_RPC_URL $CORTEX_STATE_ADDRESS 'rewardLane()(address)'
# Expected: 0x0000000000000000000000000000000000000000

# Option B: switch V4 stake source to self-mode so existing V3 stake is no longer honoured
# (contract-specific; check CortexState ABI for setStakeSource)
```

#### Pause epoch cron

```bash
systemctl stop botcoin-coordinator-epoch-cron

# Verify it is stopped:
systemctl status botcoin-coordinator-epoch-cron
# Expected: Active: inactive (dead)
```

#### Emergency full coordinator restart procedure

```bash
systemctl stop botcoin-coordinator botcoin-coordinator-epoch-cron
# Edit /etc/botcoin/coordinator.env as needed (e.g., CORETEX_ENABLED=false)
systemctl start botcoin-coordinator
# Wait for "Coordinator signer: 0x..." log line (target < 30 s)
journalctl -u botcoin-coordinator -n 20 --no-pager
systemctl start botcoin-coordinator-epoch-cron
```

---

### Artifact Retention Policy

| Artifact | Location | Who reads it | Retain | GC trigger |
|---|---|---|---|---|
| **Substrate snapshots** (1 per state advance) | S3 + coordinator CDN cache (`CORETEX_ARTIFACT_DIR/substrates/`) | Miners via `/coretex/substrate/:stateRoot`; replay scripts | Forever | Never GC — deterministic chain anchor |
| **Compact patch bytes** | Emitted on-chain as `CoretexPatchBytes` events | Chain indexers; replay | Forever (chain history) | Never — chain is immutable |
| **Eval reports** | Signed by coordinator at evaluate-time (`CORETEX_ARTIFACT_DIR/eval-reports/`) | Auditors; `/coretex/eval-report/:hash` | 90 days minimum; long-term archive manifest hashes only | S3 lifecycle: transition to Glacier after 90 d; keep manifest checksum list in bundle forever |
| **Challenge books** | Per-epoch published artifact (`CORETEX_ARTIFACT_DIR/challenge-books/`) | Miners; auditors; `/coretex/challenge-book/:epoch` | 365 days (full audit window) | S3 lifecycle: delete after 366 d |
| **Corpus deltas** | Per-epoch (`CORETEX_ARTIFACT_DIR/corpus-deltas/`) | Replay scripts; corpus pipeline; `/coretex/corpus-delta/:epoch` | Forever (deterministic chain) | Never GC |
| **Bundle manifests** | Per-version (`CORETEX_CLIENT_BUNDLE_DIR/client-bundles/`) | Miners via `/coretex/client-bundle/:coreVersionHash`; replay watchers | Forever; pinned by `coreVersionHash` | Never GC — hash is committed on-chain |

**S3 bucket layout** (reference):
```
s3://<bucket>/coretex/substrates/<stateRoot>.json
s3://<bucket>/coretex/patches/<patchHash>.json
s3://<bucket>/coretex/eval-reports/<reportHash>.json
s3://<bucket>/coretex/challenge-books/<epoch>.json
s3://<bucket>/coretex/corpus-deltas/<epoch>.json
s3://<bucket>/coretex/client-bundles/<coreVersionHash>.json
```

---

### Per-Evaluator GPU / Queue Saturation Guard

The `/coretex/evaluate` and `/coretex/screen` routes proxy to a sidecar evaluator process
(`CORETEX_EVALUATOR_URL`). The coordinator checks the sidecar's `/health` endpoint for
`queueDepth` before forwarding. If `queueDepth > CORETEX_EVALUATOR_MAX_QUEUE` (default 32),
the coordinator returns HTTP 503 immediately without hitting the evaluator GPU.

Sidecar `/health` response contract (operator must implement):
```json
{ "ok": true, "queueDepth": <number> }
```

Env vars:
- `CORETEX_EVALUATOR_URL` — base URL of the evaluator sidecar (e.g., `http://127.0.0.1:8787`)
- `CORETEX_EVALUATOR_MAX_QUEUE` — integer, default `32`; set lower to drop requests earlier under sustained load

If the sidecar `/health` is unreachable, the coordinator forwards the request anyway (fail-open for health check; the sidecar's own queue logic still applies).

---

### Rate Limit Notes (I2)

Rate limits are **in-memory per process**. In a multi-process or multi-instance deployment
behind an ALB, each coordinator process has its own buckets; the effective cap is
`CORETEX_RATE_LIMIT_PER_MINUTE_PER_MINER × process_count` per miner.

**For production (multi-process / ALB)**: migrate `MinerRateLimiter` to a Redis
INCR + EXPIRE implementation. The interface is a simple `take(key) → { allowed, reason }`.
Relevant follow-up: `coretex-live.ts` — replace `MinerRateLimiter` class with a Redis adapter.

---

### Startup Bundle Binding Assertion (I5)

When `CORETEX_EXPECTED_BUNDLE_HASH` is set, the coordinator calls the on-chain
`CortexState.getEpoch(currentEpoch).coreVersionHash` at startup via `eth_call` and refuses
to start if the hash does not match.

Required env vars (all must be set for the assertion to run):
- `CORETEX_EXPECTED_BUNDLE_HASH` — 32-byte hex hash
- `CORTEX_STATE_ADDRESS` — deployed CortexState contract address
- `CORETEX_STARTUP_RPC_URL` (or `BASE_RPC_URL` as fallback) — JSON-RPC endpoint

If either `CORTEX_STATE_ADDRESS` or the RPC URL is missing, the assertion is skipped with a
warning (not a hard failure), so the coordinator can still start in environments without chain
access (e.g., CI/local dev).

## Verification Record

Focused tests passed during implementation:

- `npm run build --workspace @botcoin/cortex`
- `npm run build --workspaces --if-present`
- `node --test packages/cortex/test/unit/bundle.test.mjs packages/cortex/test/unit/patch.test.mjs packages/cortex/test/unit/replay-cli.test.mjs packages/cortex/test/unit/coordinator-endpoints.test.mjs`
- `node --test packages/cortex/test/unit/dacr-bridge.test.mjs packages/cortex/test/unit/corpus-pipeline.test.mjs packages/cortex/test/unit/epoch-rotation.test.mjs packages/cortex/test/unit/bundle.test.mjs`
- `node --test packages/cortex/test/unit/reranker.test.mjs`
- `/root/botcoin-coordinator-live`: `tsc` direct check of `packages/coordinator/src/coretex-live.ts`

Final validation sweep completed on 2026-05-09:

- `npm run build --workspace @botcoin/cortex` passed.
- `npm run build --workspaces --if-present` passed.
- `npm run test:unit --workspace @botcoin/cortex` passed: 275 tests / 58 suites.
- `node test/e2e/phase-10/run.mjs` passed the deploy -> screen -> state advance -> log replay loop against Anvil.
- `node test/e2e/phase-11/run.mjs` passed the 5-iteration live miner loop with reranker gating, deterministic slot rotation, and replay reproduction.
- DACR production-content build for `quantum_physics,companies` emitted 5,850 candidate events, admitted 5,815 records, rejected 35 for `hardness_signal_too_low`, and rejected 0 for `insufficient_distractors`.
- Sparse DACR production-content build for `computational_biology,scrna_imputation` emitted 10,447 candidate events, admitted 10,293 records, rejected 154 for `hardness_signal_too_low`, and rejected 0 for `insufficient_distractors`.
- `scripts/build-corpus-delta-from-dacr.mjs` produced a self-contained epoch-rotation delta with 435 additions and `nextMinImprovementPpm = 2625`.
- Actual pinned Qwen3-Reranker-0.6B smoke passed via `CORETEX_RERANKER=qwen3`: model `Qwen/Qwen3-Reranker-0.6B@e61197ed45024b0ed8a2d74b80b4d909f1255473`, relevant score `0.006852287274893826`, unrelated score `0.0002810586032528734`.
- `/root/botcoin-coordinator-live` CoreTex mount typecheck passed in isolation; a filtered coordinator package build reported no CoreTex errors.

Phase-10/11 Anvil scripts now use default automine. The previous one-second interval mining mode could stall Forge receipt polling in this local harness even though the contract path was correct.
