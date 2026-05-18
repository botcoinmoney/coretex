# Botcoin CoreTex

This repository is the canonical implementation/spec home for the CoreTex 1024-word binary substrate and the off-chain Botcoin CoreTex client bundle.

Current private remote:

```text
https://github.com/botcoinmoney/cortex.git
```

The repo should be renamed to `CoreTex` or `coretex` before public release. Until then, use **CoreTex** in product/docs language and keep lowercase `cortex` only for real paths, package names, commands, endpoints, and compatibility identifiers.

Current launch authority lives in this repo:

- [docs/README.md](./docs/README.md) — canonical documentation map.
- [docs/CORETEX_LAUNCH_PLAN_v2.md](./docs/CORETEX_LAUNCH_PLAN_v2.md) — current
  production launch plan after the synthesizer-labeled corpus pivot.
- [docs/CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md](./docs/CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md) — launch-blocking end-to-end
  orchestration.
- [docs/CORETEX_CALIBRATION_AGENT_RUNBOOK.md](./docs/CORETEX_CALIBRATION_AGENT_RUNBOOK.md) — standalone CPU calibration host runbook.

Use this repo for:

- `/root/cortex/specs/cortex_state.md`
- `/root/cortex/specs/cortex_schema.json`
- `/root/cortex/specs/packing_spec.md`
- `/root/cortex/specs/merkleization_spec.md`
- `/root/cortex/specs/patch_format.md`
- `/root/cortex/specs/substrate_retrieval_semantics.md`
- `/root/cortex/specs/retrieval_benchmark.md`
- `/root/cortex/specs/corpus_retrieval.md`
- `/root/cortex/specs/hidden_query_pack.md`
- `/root/cortex/specs/determinism.md`
- `/root/cortex/packages/cortex/src/state/`
- `/root/cortex/packages/cortex-py/cortex_py/`
- the bundle, corpus, evaluator, replay, and coordinator route-shim packages
  referenced by the current launch plan

Do not use archived CoreTex pre-launch planning/runbook docs as production
authority. They live under `docs/archive/stale-coretex/` and
`ops/archive/stale-coretex/` only for historical audit traceability.

The production architecture is intentionally small:

1. on-chain temporal-map substrate root and transition log
2. off-chain Botcoin CoreTex client bundle with substrate decoder, corpus data, evaluator, manifests, and 0.6B reranker
3. on-chain staking/credit/reward contract lane

No separate data-availability artifact system is part of the canonical v4 extension plan.

## Local Production Development

This workspace is not the production coordinator server. For implementation and testing:

```text
/root/botcoin                    contracts and v4 production plan
/root/cortex                     substrate, client bundle, evaluator, corpus, replay
/root/botcoin-coordinator-live   cloned live coordinator for additive wiring patches
```

Run the 0.6B reranker locally for now. Production will run the same pinned model through the coordinator host or an internal evaluator process.

## Coordinator Wiring

The production coordinator integration must be additive:

- preserve existing V3 challenge/submit routes
- add CoreTex screen/evaluate/substrate/client-bundle routes
- keep signing authority in the coordinator
- keep the evaluator without signing keys
- make coordinator cache a convenience, not a replay dependency

See [docs/CORETEX_COORDINATOR_QUICKSTART.md](./docs/CORETEX_COORDINATOR_QUICKSTART.md)
for copy-paste coordinator wiring and
[docs/CORETEX_COORDINATOR_INTEGRATION_RUNBOOK.md](./docs/CORETEX_COORDINATOR_INTEGRATION_RUNBOOK.md)
for the full integration contract.

## Git and Secret Discipline

Commit and push frequently to the private CoreTex remote after coherent green slices. Do not leave important work only in a local dirty tree.

Treat this repo as future-public:

- never commit `.env`, private keys, wallet material, API tokens, authenticated RPC URLs, cookies, production logs, database dumps, private user data, or coordinator signing secrets
- commit model/corpus files only when redistribution, license, and size policy are acceptable
- otherwise commit manifests, hashes, and deterministic fetch/install instructions
- inspect `git diff --cached` before every commit and run a secret scan when available
- if a secret is staged or committed, stop and rotate it before pushing
