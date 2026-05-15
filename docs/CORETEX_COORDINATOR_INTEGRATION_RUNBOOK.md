# CoreTex Coordinator Integration Runbook

Purpose: minimal wiring instructions for the coordinator AI agent that will
mount CoreTex into the Botcoin coordinator host.

For the full launch-blocking orchestration, including calibration, real
reranker tests, Base fork rehearsal, mainnet canary, and independent replay,
use `docs/CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md` as the
controlling runbook. This file is the coordinator sub-agent slice.

The coordinator should stay thin. CoreTex verification lives in the published
bundle, corpus, replay client, and on-chain events. The host only serves files,
signs evaluated receipts, rotates epochs, and exposes a small HTTP shim.

## Integration Boundary

CoreTex exports the route shim and data-source contract:

- `packages/cortex/src/coordinator/endpoints.ts`
- `packages/cortex/src/coordinator/retrieval-data-source.ts`

The coordinator host mounts `handleCoreTexCoordinatorRoute(req, dataSource)`.
Everything host-specific sits behind `CoreTexCoordinatorDataSource`.

Required host-owned storage:

```
/var/lib/coretex/
  corpus-epoch-N.json
  corpus-epoch-N-plus-1.json
  deltas/corpus-delta-N-plus-1.json
  reports/*.json
  bundles/<bundleHash>.json
  patches/<patchHash>.json
  eval-reports/<evalReportHash>.json
  substrates/<stateRoot>.bin
```

Required host-owned config:

```
/etc/coretex/bundle-manifest.json
/etc/coretex/bundle-profile.json
CORETEX_BUNDLE_HASH
CORETEX_CORE_VERSION_HASH
CORETEX_CORPUS
CORETEX_BASE_RPC_URL
CORETEX_V4_ADDRESS=0x12ff0B47389AE6d6293d44991B0D6A27394494A4
CORETEX_STATE_ADDRESS=0x5d3B9D9b246cf8457F320Bb27f008186B69D555d
CORETEX_COORDINATOR_SIGNER
```

Current Base mainnet support contracts:

```
BotcoinMiningV3=0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea
BOTCOIN=0xA601877977340862Ca67f816eb079958E5bd0BA3
chainId=8453
```

## Startup Gate

On process boot:

1. Load `/etc/coretex/bundle-manifest.json`.
2. Load `CORETEX_CORPUS`.
3. Call `assertBundleBindingAtStartup`.
4. Refuse startup if:
   - bundle hash differs from `CORETEX_BUNDLE_HASH`;
   - `coreVersionHash` differs from the epoch's chain-published value;
   - corpus root differs from the bundle manifest;
   - model revisions or file hashes fail manifest verification.

This keeps coordinator trust narrow: anyone can reproduce the same checks by
running CoreTex locally.

## Route Mount

The host must mount these paths exactly:

```
GET  /coretex/challenge                                ← singular dynamic packet
POST /coretex/submit                                   ← single public write path
GET  /coretex/status                                   ← non-secret dynamic context
GET  /coretex/substrate/:stateRoot                     ← immutable
GET  /coretex/patch/:hash                              ← immutable
GET  /coretex/patch-received/:hash                     ← PatchReceivedNotice for replay watchers
GET  /coretex/eval-report/:hash                        ← verdict lookup
GET  /coretex/corpus-delta/:epoch                      ← immutable
GET  /coretex/bundle/by-core-version/:coreVersionHash  ← v2 bundles default-alias to bundleHash
GET  /coretex/bundle/:bundleHash                       ← immutable
GET  /coretex/health
```

Eleven endpoints; one POST. Every miner write goes through `POST /coretex/submit`; everything else is a fetch over content-addressed or dynamic state.

Minimal data-source construction:

```ts
import {
  createRetrievalDataSource,
  createCoreTexCoordinatorRouteHandler,
} from '@botcoin/cortex';

const ds = createRetrievalDataSource({
  bundleManifest, bundleHash,
  getChallenge: () => coordinator.currentChallenge(),
  submit:       (body) => coordinator.acceptPatch(body),  // dual-pack evaluator here
  getStatus:    () => coordinator.publicStatus(),
  // optional artifact readers (default bundle path is built-in):
  getSubstrate, getPatch, getPatchReceivedNotice, getEvalReport,
  getCorpusDelta, getBundleByCoreVersionHash,
  authorize, rateLimit,
});

const handle = createCoreTexCoordinatorRouteHandler(ds);

app.use(async (req, res, next) => {
  const r = await handle({ method: req.method, path: req.path, body: req.body, headers: req.headers });
  if (!r.handled) return next();
  res.status(r.status).json(r.body);
});
```

The host is expected to perform startup verification (manifest hash check, `assertBundleBindingAtStartup`, on-chain `coreVersionHash` cross-check) before constructing the data source. Refer to §Startup Gate above.

## Submit contract

`POST /coretex/submit` is the only expensive write-path. The host's `submit` callback runs the dual-pack per-patch evaluator (see `CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md`) and returns one of two envelope shapes:

```
accepted: { status: 'accepted', patchHash, evalReportHash?, receipt? }
rejected: { status: 'rejected', code:   'rejected', patchHash? }
```

Rejection is **opaque** by design — the wire code is always `'rejected'`. Internal reasons (admission collapse, dedup hit, score below floor, family veto, structural failure) never leak to the miner, which prevents reward-hacking by reading rejection signal. Audit detail lives in the persisted eval report, readable by replay watchers via `GET /coretex/eval-report/:hash`.

The `receipt` field on an accepted envelope is allow-listed at the wire boundary to exactly:

```
{ keyId, algorithm: 'RSA-SHA256' | 'ECDSA-SHA256', signature, signedFields, sig }
```

Any extra fields the host signer happens to emit are stripped by the route handler before they reach the miner. This keeps the receipt schema versioned through the bundle, not through host implementation details.

The submit callback must:

1. Hash + normalize the patch (`computePatchHash`, `computeDedupKey`).
2. Run admission (`liveEvalAdmissionDecision`): structural validity, dedup-key collapse, per-miner cap.
3. Bind the patch to a future Base blockhash and derive gate + confirm seeds (`runPerPatchEvaluation`).
4. Score on both packs with the bundle-pinned BGE-M3 + Qwen3 stack.
5. Accept only if both pack scores clear `minImprovementPpm + replayTolerancePpm + baselineVariancePpm`.
6. Persist compact patch bytes by `patchHash`, the signed eval report by `evalReportHash`, and the `PatchReceivedNotice` for replay watchers.
7. Sign the EIP-712 receipt only after both pack scores pass.

The coordinator must not sign a score it cannot replay locally.

## Status contract

`GET /coretex/status` returns non-secret dynamic context. The 14 required fields are:

```
lane, epochId, stateRoot, wordCount, transitionCount,
rulesVersion, workPolicyHash, corpusRoot, coreVersionHash, bundleHash,
minImprovementPpm, evalSeedCommit,
substrate.uri, bundle.uri
```

The route handler additionally auto-injects `statusVersion` — a sha256 over the response body — so miners can use it as an idempotent poll token. Status is the canonical place miners check whether they are looking at a current epoch; it is read-mostly and safe to cache for the poll interval.

`evalSeedCommit` is the on-chain seed commitment, not the preimage — the preimage stays in multisig escrow until reveal.

## PatchReceivedNotice fetch

`GET /coretex/patch-received/:hash` lets replay watchers verify that a coordinator did not delay-process a patch to wait for a favorable future blockhash. The strict response shape is:

```
{ patchHash, receivedAtBlock, receivedAtTimestamp, coordinatorAddress, signer? }
```

The coordinator publishes the notice within the same Base block as `receivedAtBlock` (today via an append-only off-chain log; post-launch may upgrade to an on-chain `PatchReceived` event — see `CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md §Receipt Honesty`). Replay watchers cross-check every receipt's `receivedAtBlock` against the notice; mismatch invalidates the receipt.

## Public Verification Surface

The coordinator publishes only what others need to reproduce:

- bundle manifest by hash (`/coretex/bundle/:bundleHash`);
- bundle alias by core-version hash (`/coretex/bundle/by-core-version/:coreVersionHash`);
- signed corpus deltas (`/coretex/corpus-delta/:epoch`);
- patch bytes (`/coretex/patch/:hash`);
- patch-received notices (`/coretex/patch-received/:hash`);
- eval reports (`/coretex/eval-report/:hash`);
- substrate snapshots by state root (`/coretex/substrate/:stateRoot`);
- non-secret dynamic status (`/coretex/status`) and the singular per-miner challenge packet (`/coretex/challenge`).

`eval_hidden` and `canary` corpus records are not served as standalone records by any endpoint; they reach replay watchers only through the bundle / corpus-delta artifacts plus the post-epoch eval-seed reveal. The challenge packet redacts hidden-pack content; the substrate endpoints expose only the public 1024-word state body.

## Epoch Rotation

At each epoch boundary:

1. Run the difficulty calculator from the prior epoch's observed advances and
   quality attempts.
2. Generate the next corpus delta from the challenge library:

```bash
CORETEX_CORPUS_PRODUCTION=1 CORETEX_BIENCODER=pinned \
node scripts/generate-coretex-retrieval-corpus.mjs \
  --source challenge-library \
  --challenge-lib-root /opt/botcoin-coordinator-live/packages/challenges \
  --bundle-manifest /etc/coretex/bundle-manifest.json \
  --previous-corpus /var/lib/coretex/corpus-epoch-N.json \
  --seed-offset $NEXT_SEED_OFFSET \
  --seeds-per-domain 16 \
  --modifier-counts 0,1,2,3 \
  --constraint-difficulties easy,medium,hard \
  --trap-count 2 \
  --corpus-epoch $CORPUS_EPOCH \
  --epoch $NEXT_CHAIN_EPOCH \
  --out /var/lib/coretex/corpus-epoch-N-plus-1.json \
  --delta-out /var/lib/coretex/deltas/corpus-delta-N-plus-1.json
```

3. Validate the new corpus.
4. Build the epoch-rotation manifest binding:
   - previous corpus root;
   - next corpus root;
   - corpus delta hash;
   - bundle hash;
   - next `minImprovementPpm`;
   - eval seed commitment.
5. Publish the manifest and delta.
6. Initialize/freeze the next on-chain epoch with the matching
   `coreVersionHash`, `bundleHash`, and corpus root.

## Replay Watcher

Every production coordinator must run a watcher:

```bash
CORETEX_BUNDLE_MANIFEST=/etc/coretex/bundle-manifest.json \
coretex-replay watch \
  --rpc-url $CORETEX_BASE_RPC_URL \
  --contract $CORETEX_V4_ADDRESS \
  --bundle-manifest /etc/coretex/bundle-manifest.json \
  --expected-bundle-hash $CORETEX_BUNDLE_HASH \
  --expected-core-version-hash $CORETEX_CORE_VERSION_HASH
```

Any replay disagreement pages ops and pauses signing.

## Coordinator Pass Criteria

- Startup binding fails closed on mismatched bundle/corpus/core version.
- Hidden/canary corpus content is never exposed at a public endpoint before reveal.
- `POST /coretex/submit` is rate-limited and authenticated.
- `submit` signs only receipts whose dual-pack scores were generated by the local bundle-pinned scorer.
- Rejection envelopes are opaque (`code: 'rejected'`); receipt envelopes carry only the allow-listed signature fields.
- `PatchReceivedNotice` is published for every accepted patch within the same Base block as `receivedAtBlock`.
- Corpus deltas are signed, retained forever, and replay-apply cleanly.
- Replay watcher runs with `--bundle-manifest` and expected hashes.
- A miner can verify the whole flow by cloning CoreTex, fetching the bundle,
  fetching corpus/deltas, and replaying chain events without coordinator
  private state.
