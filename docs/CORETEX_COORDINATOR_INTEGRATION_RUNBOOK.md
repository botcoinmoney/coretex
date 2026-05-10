# CoreTex Coordinator Integration Runbook

Purpose: minimal wiring instructions for the coordinator AI agent that will
mount CoreTex into the Botcoin coordinator host.

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
CORETEX_V4_ADDRESS
CORETEX_STATE_ADDRESS
CORETEX_COORDINATOR_SIGNER
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
POST /coretex/screen
POST /coretex/evaluate
GET  /coretex/substrate/current
GET  /coretex/substrate/:stateRoot
GET  /coretex/patch/:hash
GET  /coretex/eval-report/:hash
GET  /coretex/challenge-book/:epoch
GET  /coretex/corpus-delta/:epoch
GET  /coretex/client-bundle/:coreVersionHash
GET  /coretex/bundle/:bundleHash
GET  /coretex/corpus/:recordId
GET  /coretex/corpus/:recordId/embedding
GET  /coretex/coverage-hints
GET  /coretex/health
```

Minimal data-source construction:

```ts
import {
  handleCoreTexCoordinatorRoute,
  createRetrievalDataSource,
  loadProductionCorpus,
  assertBundleBindingAtStartup,
} from '@botcoin/cortex';

const corpus = loadProductionCorpus(process.env.CORETEX_CORPUS!);
const bundleManifest = JSON.parse(fs.readFileSync('/etc/coretex/bundle-manifest.json', 'utf8'));

assertBundleBindingAtStartup({
  manifest: bundleManifest,
  expectedBundleHash: process.env.CORETEX_BUNDLE_HASH!,
  expectedCoreVersionHash: process.env.CORETEX_CORE_VERSION_HASH!,
  repoRoot: '/opt/cortex',
});

const coretexDataSource = createRetrievalDataSource({
  corpus,
  bundleManifest,
  bundleHash: bundleManifest.bundleHash,
  authorize: coordinatorJwtOrHmacAuth,
  rateLimit: perMinerAndPerIpLimiter,
  screen: coretexScreenHandler,
  evaluate: coretexEvaluateHandler,
  getCurrentSubstrate: readCurrentSubstrate,
  getSubstrate: readSubstrateByRoot,
  getPatch: readPatchByHash,
  getEvalReport: readEvalReportByHash,
  getChallengeBook: readChallengeBookByEpoch,
  getCorpusDelta: readCorpusDeltaByEpoch,
  getClientBundle: readClientBundleByCoreVersionHash,
  getCoverageHintsForCurrent: computeVisibleCoverageHints,
  health: coretexHealth,
});

server.all('/coretex/*', async (req, res, next) => {
  const response = await handleCoreTexCoordinatorRoute(toCoreTexReq(req), coretexDataSource);
  if (!response.handled) return next();
  res.status(response.status).json(response.body);
});
```

## Evaluate Handler

`POST /coretex/evaluate` is the only expensive write-path. It should:

1. Read the current chain substrate root.
2. Decode the proposed compact patch.
3. Run `evaluateRetrievalBenchmarkPatch` with the bundle-pinned scorer.
4. Reject if score delta is below calibrated `minImprovementPpm`.
5. Persist:
   - compact patch bytes by `patchHash`;
   - eval report by `evalReportHash`;
   - parent/new state roots;
   - bundle hash and corpus root used.
6. Sign the EIP-712 receipt only after the local report passes.

The coordinator must not sign a score it cannot replay locally.

## Public Verification Surface

The coordinator publishes only what others need to reproduce:

- bundle manifest by hash;
- corpus and signed corpus deltas;
- patch bytes;
- eval reports;
- challenge books / hidden query reveal data after reveal;
- substrate snapshots by state root.

`eval_hidden` and `canary` corpus records stay masked through
`createRetrievalDataSource`. `train_visible` records and coverage hints are
public miner conveniences, not trust roots.

## Epoch Rotation

At each epoch boundary:

1. Run the difficulty calculator from the prior epoch's observed advances and
   quality attempts.
2. Generate the next corpus delta from the challenge library:

```bash
CORETEX_CORPUS_PRODUCTION=1 CORETEX_BIENCODER=pinned CORETEX_LABELER=pinned \
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
- Hidden/canary corpus records are masked before reveal.
- `screen` and `evaluate` are rate-limited and authenticated.
- `evaluate` signs only reports generated by the local bundle-pinned scorer.
- Corpus deltas are signed, retained forever, and replay-apply cleanly.
- Replay watcher runs with `--bundle-manifest` and expected hashes.
- A miner can verify the whole flow by cloning CoreTex, fetching the bundle,
  fetching corpus/deltas, and replaying chain events without coordinator
  private state.
