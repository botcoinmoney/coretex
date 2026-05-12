# CoreTex Coordinator Quickstart

Five-step wiring for an existing Botcoin coordinator host. The coordinator
already runs V3 24-hour epochs and pro-rata reward distribution; this
guide is purely additive — no V3 path is touched.

For full design context see
`docs/CORETEX_COORDINATOR_INTEGRATION_RUNBOOK.md`. This file is the
copy-paste shortcut.

> Pre-launch hardening note: `POST /coretex/evaluate` is live, but every
> patch's eval seed binds to a future Base blockhash (per-patch on-chain
> randomness — see `docs/CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md`) so
> coordinator pre-testing is structurally impossible. The earlier sealed-
> eval commit/reveal design (`CORETEX_SEALED_EPOCH_EVAL_HARDENING_PLAN.md`)
> is superseded.

## 1. Install the bundle artifacts

On the coordinator host:

```bash
mkdir -p /etc/coretex /var/lib/coretex/{bundles,patches,eval-reports,substrates,reports,deltas}

# Copy the canonical artifacts off the calibration host (or pull from
# a trusted release URL — both content-addressed, no trust required).
scp <calibration-host>:/etc/coretex/bundle-manifest.json   /etc/coretex/
scp <calibration-host>:/etc/coretex/bundle-profile.json    /etc/coretex/
scp <calibration-host>:/var/lib/coretex/corpus-epoch-0.json /var/lib/coretex/
```

Coordinator never edits these. They're verified at startup.

## 2. Add the env block to coordinator service

Append to `/etc/botcoin-coordinator/.env` (or whatever the host uses):

```bash
# CoreTex
CORETEX_ENABLED=true
CORETEX_BUNDLE_HASH=<bundleHash from bundle-manifest.json>
CORETEX_CORE_VERSION_HASH=<bundleHash, same value>
CORETEX_CORPUS=/var/lib/coretex/corpus-epoch-0.json
CORTEX_STATE_ADDRESS=0x5d3B9D9b246cf8457F320Bb27f008186B69D555d
BOTCOIN_MINING_V4_ADDRESS=0x12ff0B47389AE6d6293d44991B0D6A27394494A4
CORETEX_BASE_RPC_URL=$BASE_RPC_URL
CORETEX_OPERATOR_TOKEN=<freshly generated random 32 bytes>
CORETEX_RATE_LIMIT_PER_MINUTE_PER_MINER=30
CORETEX_RATE_LIMIT_PER_MINUTE_GLOBAL=1500

# Pinned CPU runtime (must satisfy bundle's runtimePin)
CORETEX_BIENCODER_PYTHON=/opt/cortex-venv/bin/python
CORETEX_RERANKER_PYTHON=/opt/cortex-venv/bin/python
CORTEX_LOCAL_MODEL_CACHE=/var/lib/coretex/model-cache
HF_HUB_CACHE=/var/lib/coretex/model-cache
HF_HUB_OFFLINE=1

# Production-mode flags refuse stub models
CORETEX_BIENCODER=pinned
CORETEX_BIENCODER_MODE=streaming
CORETEX_RERANKER=qwen3
CORETEX_RERANKER_MODE=streaming
CORETEX_RERANKER_PRODUCTION=1
CORTEX_REAL_EVAL=1
```

Set up the venv with the same pinned versions the bundle expects:

```bash
python3 -m venv /opt/cortex-venv
/opt/cortex-venv/bin/pip install \
  --index-url https://download.pytorch.org/whl/cpu torch==2.6.0
/opt/cortex-venv/bin/pip install \
  transformers==4.55.0 sentence-transformers==3.4.1 \
  huggingface_hub==0.36.2 tokenizers==0.21.4 numpy==1.26.4 safetensors
```

Pull the pinned model weights once:

```bash
node /opt/cortex/scripts/download-pinned-models.py /var/lib/coretex/model-cache BAAI/bge-m3
node /opt/cortex/scripts/download-pinned-models.py /var/lib/coretex/model-cache Qwen/Qwen3-Reranker-0.6B
node /opt/cortex/scripts/download-pinned-models.py /var/lib/coretex/model-cache IAAR-Shanghai/MemReranker-4B
```

Each script verifies per-file SHA-256 against the bundle source-of-truth
before declaring success.

## 3. Mount the route shim (≈30 LOC)

Anywhere in the coordinator's HTTP layer, before the catch-all 404:

```ts
import {
  handleCoreTexCoordinatorRoute,
  createRetrievalDataSource,
  loadProductionCorpus,
  assertBundleBindingAtStartup,
  verifyBundleManifest,
} from '@botcoin/cortex';
import * as fs from 'node:fs';

// One-time at boot: refuse to start on any binding mismatch.
const manifest = JSON.parse(fs.readFileSync('/etc/coretex/bundle-manifest.json', 'utf8'));
const errs = verifyBundleManifest(manifest, '/opt/cortex');
if (errs.length) throw new Error(`bundle manifest invalid: ${errs.join(', ')}`);

assertBundleBindingAtStartup({
  manifest,
  onChainCoreVersionHash: process.env.CORETEX_CORE_VERSION_HASH!,
  installedRuntimeVersions: readInstalledRuntimeVersions(),
});

const corpus = loadProductionCorpus(process.env.CORETEX_CORPUS!);

const coretexDataSource = createRetrievalDataSource({
  corpus,
  bundleManifest: manifest,
  bundleHash: manifest.bundleHash,
  authorize: (ctx) => requireBearer(ctx, process.env.CORETEX_OPERATOR_TOKEN!),
  rateLimit: perMinerAndPerIpLimiter,
  screen: hostScreenHandler,       // structural-only validation
  evaluate: hostEvaluateHandler,   // settlement/admin only; never a public live hidden oracle
  health: () => ({ ok: true, bundleHash: manifest.bundleHash }),
  // optional: add getCurrentSubstrate / getCorpusDelta / etc as you go
});

server.all('/coretex/*', async (req, res, next) => {
  const r = await handleCoreTexCoordinatorRoute(toCoreTexReq(req), coretexDataSource);
  if (!r.handled) return next();
  res.status(r.status).json(r.body);
});
```

The `/coretex/*` routes (screen, evaluate, substrate, patch, eval-report,
challenge-book, corpus-delta, client-bundle, bundle, corpus record,
embedding, health, evaluate-async, result-by-hash) are all dispatched by
`handleCoreTexCoordinatorRoute` — you don't write per-route handlers.

`hostEvaluateHandler` is settlement/admin-only in the sealed launch flow. It
must run after commit close, seed derivation, and patch reveal — never as an
interactive hidden-pack scorer during the live mining window. The public miner
path is `commit -> reveal -> status`; detailed eval reports are published only
after settlement. The rest of the data-source callbacks are reads against
`/var/lib/coretex/{patches,eval-reports,substrates}` — direct file-by-hash
reads, no new logic.

### 3a. Per-patch eval-seed primitives

The eval-seed for each patch is bound to a future Base blockhash the
coordinator cannot observe at receive time. See
`docs/CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md` for the full design.

| File | Exports |
| ---- | ------- |
| `src/eval/seed-derivation.ts` | `deriveGateEvalSeed`, `deriveConfirmEvalSeed`, `computePatchHash`, `computeDedupKey`, `EVAL_SEED_GATE_DOMAIN_PREFIX`, `EVAL_SEED_CONFIRM_DOMAIN_PREFIX` |
| `src/coordinator/base-blockhash.ts` | `createBaseRpcClient`, `BaseRpcClient` (`getLatestBlockNumber`, `getBlockHash`, `waitForBlock`) |
| `src/eval/live-eval-admission.ts` | `liveEvalAdmissionDecision` (anti-spam: structural / dedup-key collapse / per-miner cap) |
| `src/coordinator/per-patch-evaluator.ts` | `runPerPatchEvaluation` (compose: hash → admit → blockhash bind → derive gate+confirm seeds → dual-pack score → receipt) |
| `src/replay/per-patch.ts` | `verifyPerPatchReceipt` (re-derive seeds + re-score against per-patch packs; tolerates `replayTolerancePpm`) |

The earlier sealed-eval (`commit → reveal → status` flow with per-epoch
sealed packs) was superseded by this design. Old sealed-eval modules
are removed; the screener-admission helper survives the rip and moves
here.

After every patch eval, the coordinator caches the signed receipt by
`dedupKey = keccak256(parentRoot, normalizedPatchBytes)`. Duplicate
submissions return the cached verdict — anti-probing without
commit/reveal overhead.

## 4. Daily epoch ritual (existing 24-hour V3 cycle, +3 lines for CoreTex)

The coordinator already finalizes V3 epochs every 24h with reward
distribution. CoreTex adds three on-chain calls per cycle, parallel to
the existing V3 finalize:

```ts
// At cycle START (right after V3 finalize), tied to the current 24h boundary:
const evalSeed = randomBytes(32);                             // owner-only secret
const evalSeedCommit = keccak256(evalSeed);
fs.writeFileSync(`/etc/coretex/eval-seeds/${nextEpoch}.bin`, evalSeed); // multisig escrow
await cortexState.initializeEpoch(
  nextEpoch,
  192,                              // rulesVersion
  DEFAULT_CORETEX_WORK_POLICY_HASH, // 0xd5bc0e0c…
  manifest.corpus.root,             // current pinned corpus
  manifest.bundleHash,              // current pinned bundle = coreVersionHash
  liveStateRoot,                    // last sealed CortexState root
  1024,                             // wordCount
  parentCorpusRoot,                 // previous-epoch corpus root, or zero on launch
  manifest.evaluator.profile.patchAcceptanceFloors.minImprovementPpm,
  evalSeedCommit,
);
await cortexState.freezeEpoch(nextEpoch);

// At cycle END (24h later), tied to the V3 reward finalization:
await cortexState.revealEvalSeed(currentEpoch, evalSeed);
```

**No new epoch system.** Same 24h cycle as V3. The CortexState contract just
records what the coordinator already knows. `bundleHash` and `corpusRoot`
stay the same across many cycles — they only change when you publish a
new corpus delta or a new bundle, both of which are operator events. On
those days, swap the `manifest.corpus.root` and `manifest.bundleHash`
values; otherwise pass identical values every cycle.

V3 reward distribution is unchanged. V4 `coretexCredits` accumulate
in-band as miners submit `submitWorkReceipt`, and V4's reward lane
divides epoch-end CoreTex rewards pro-rata over those credits — same
shape as V3.

### 4a. Major-delta grace (Phase H3 hardening, ~5 lines)

When the coordinator publishes a new corpus delta whose new
`eval_hidden` count exceeds `manifest.evaluator.profile.majorDeltaThreshold`
(pinned by the calibrator, ~5% of the launch eval_hidden population),
the next epoch enters one-cycle "grace": the difficulty calculator
freezes `minImprovementPpm` at the prior value and suppresses decay,
while the calibration host re-runs `evaluateBaseline` and publishes a
fresh `BaselineScores` in the signed epoch rotation manifest. After
one cycle the threshold resumes normal adjustment against the new
baseline.

```ts
import { isMajorDelta, nextMinImprovementPpm } from '@botcoin/cortex';

const isMajor = isMajorDelta(
  newDelta.evalHiddenCount,
  prevEpochMetadata.evalHiddenCount,
  manifest.evaluator.profile.majorDeltaThreshold,
);
if (isMajor) {
  // Hand off to the calibration host (separate job): re-run
  //   node scripts/pin-baseline-into-bundle.mjs
  //     --bundle-manifest /etc/coretex/bundle-manifest.json
  //     --corpus /var/lib/coretex/corpus-epoch-N+1.json
  //     --eval-seed-hex <new evalSeed for epoch N+1>
  //     --epoch-id <N+1>
  //     --out /etc/coretex/bundle-manifest.epoch-N+1.json
  // Then publish the new BaselineScores in the epoch rotation manifest.
}

const next = nextMinImprovementPpm({
  current: currentMinImprovementPpm,
  observedAdvances: prevEpochMetadata.acceptedAdvances,
  targetAdvances: targetAdvancesPerEpoch,
  qualityAttempts: prevEpochMetadata.qualityAttempts,
  majorDeltaActive: isMajor,
});
```

This is the only thing that changes about the daily ritual when a
delta is "major." On normal days, `isMajor=false` and the difficulty
logic runs exactly as before — backward compatible.

Rate limits stay flat per-miner ceilings + global backpressure (503
on queue saturation). Never credit-aware. The credit/BPS tier system
already provides economic differentiation; rate limits exist only to
prevent abuse.

## 5. Smoke test (3 commands, no chain side effects)

After mount, before announcing the coordinator endpoint to miners:

```bash
# (a) startup gate fired correctly
curl -fsS -H "authorization: Bearer $CORETEX_OPERATOR_TOKEN" \
  http://127.0.0.1:8080/coretex/health
# → { "ok": true, "bundleHash": "0x7260c12036…" }

# (b) public corpus record + masking gate
curl -fsS -H "authorization: Bearer $CORETEX_OPERATOR_TOKEN" \
  http://127.0.0.1:8080/coretex/corpus/<a train_visible record id>
# → 200 with serialized record

curl -fsS -H "authorization: Bearer $CORETEX_OPERATOR_TOKEN" \
  http://127.0.0.1:8080/coretex/corpus/<an eval_hidden record id>
# → 200 with { "error": "coretex-corpus-hidden", "split": "eval_hidden" }

# (c) bundle manifest by hash
curl -fsS http://127.0.0.1:8080/coretex/bundle/$CORETEX_BUNDLE_HASH \
  | jq .bundleHash
# → exactly $CORETEX_BUNDLE_HASH
```

If all three return as expected, the wiring is complete. The first
miner submitting `/coretex/screen` + `/coretex/evaluate` exercises
the live evaluator — no further coordinator work needed.

## 6. Rollback (one env flag)

```bash
# Disable /coretex/* without touching V3
sed -i 's/CORETEX_ENABLED=true/CORETEX_ENABLED=false/' /etc/botcoin-coordinator/.env
systemctl restart botcoin-coordinator
# Verify
curl -i http://127.0.0.1:8080/coretex/health   # → 503
curl -i http://127.0.0.1:8080/v1/challenge      # → 200 (V3 still serving)
```

V3 mining keeps running uninterrupted.
