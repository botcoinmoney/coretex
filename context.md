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

Latest local checks for this slice:

```text
npm run build --workspace @botcoin/cortex
npm run test:unit --workspace @botcoin/cortex
```

Both passed after the replay/bundle slice; unit suite was 181 passing tests at that checkpoint.
