# CoreTex Context

The previous CoreTex context file is superseded.

Current production planning authority:

```text
/root/botcoin/CORETEX_V4_PRODUCTION_PLAN.md
```

Current substrate authority remains in this repo's specs and reference implementations:

- `docs/state-spec.md`
- `specs/cortex_state_v0.md`
- `specs/cortex_schema_v0.json`
- `specs/packing_spec_v0.md`
- `specs/merkleization_spec_v0.md`
- `specs/patch_format_v0.md`
- `packages/cortex/src/state/`
- `packages/cortex-py/cortex_py/`

Old audit-window, multisig, merge-bonus, sidecar, and handoff text is historical only. Do not use it to override the v4 production plan.

Current execution posture:

- run the 0.6B memory evaluator locally for development/testing
- use `/root/botcoin-coordinator-live` as the local coordinator clone
- wire coordinator integration additively
- prove production readiness through local Anvil, Base fork, local coordinator, local model, client-bundle replay, and negative-control tests
- commit and push coherent checkpoints to `https://github.com/botcoinmoney/cortex.git`
- treat every commit as future-public: no secrets, no private data, no unlicensed datasets
- prefer CoreTex in product/docs language; retain lowercase `cortex` only for actual paths/packages/identifiers

## Recent Implementation Notes

2026-05-08:

- Added the CoreTex client-bundle manifest module in `packages/cortex/src/bundle/`.
- Added `botcoin-cortex bundle-manifest build|verify` with corpus, snapshot, evaluator, substrate, and pinned model hash validation.
- Added `coretex-replay` with `tx`, `current`, and polling `watch` modes over V4 `CoretexPatchBytes` and `CortexStateAdvanced` logs.
- Replay now checks compact patch bytes against `patchHash`, parent state root, applied new root, 32 KB packed-state snapshots, and ordered multi-transition batches.
- Added unit coverage for bundle manifests, replay tamper failures, and multi-transition replay.
- Fixed the package unit-test script glob so `npm run test:unit --workspace @botcoin/cortex` executes the full unit suite.
- Added `ProductionCorpusLoader` in `packages/cortex/src/eval/corpus.ts` for deterministic raw-state scoring against the pinned Season 1 corpus shape.
- `botcoin-cortex eval` can now use `--corpus-file` and `--eval-items-per-family`; the legacy stub loader remains available for compatibility.
- Season 1 corpus loading verifies the embedded SHA-256 and `experience_corpus_root`, then scores shard-selected near-collision, temporal, long-horizon, and routing signals.
- Added `packages/cortex/src/coordinator/endpoints.ts`, a small raw-HTTP-friendly contract for additive `/coretex/*` coordinator routes.
- The coordinator endpoint contract covers screen/evaluate, substrate, patch, eval-report, challenge-book, corpus-delta, client-bundle, and health routes while explicitly ignoring `/v1/challenge`.

Latest local checks for this slice:

```text
npm run build --workspace @botcoin/cortex
npm run test:unit --workspace @botcoin/cortex
```

Both passed after the replay/bundle slice; unit suite was 181 passing tests at that checkpoint.
They also passed after the production corpus loader slice; unit suite was 184 passing tests at that checkpoint.
They also passed after the coordinator endpoint contract slice; unit suite was 188 passing tests at that checkpoint.
