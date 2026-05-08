# Botcoin CoreTex

This repository is the canonical implementation/spec home for the CoreTex 1024-word binary substrate and the off-chain Botcoin CoreTex client bundle.

Current private remote:

```text
https://github.com/botcoinmoney/cortex.git
```

The repo should be renamed to `CoreTex` or `coretex` before public release. Until then, use **CoreTex** in product/docs language and keep lowercase `cortex` only for real paths, package names, commands, endpoints, and compatibility identifiers.

Production v4 planning authority lives in:

```text
/root/botcoin/CORETEX_V4_PRODUCTION_PLAN.md
```

Use this repo for:

- `/root/cortex/docs/state-spec.md`
- `/root/cortex/specs/cortex_state_v0.md`
- `/root/cortex/specs/cortex_schema_v0.json`
- `/root/cortex/specs/packing_spec_v0.md`
- `/root/cortex/specs/merkleization_spec_v0.md`
- `/root/cortex/specs/patch_format_v0.md`
- `/root/cortex/packages/cortex/src/state/`
- `/root/cortex/packages/cortex-py/cortex_py/`
- benchmark fixtures and harnesses referenced by the v4 production plan

Do not use old CoreTex planning/runbook docs as production authority where they conflict with the v4 production plan. In particular, stale audit-window, multisig-override, merge-bonus, and separate handoff language has been superseded.

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

See [`instructions.md`](./instructions.md) for the concrete local wiring checklist.

## Git and Secret Discipline

Commit and push frequently to the private CoreTex remote after coherent green slices. Do not leave important work only in a local dirty tree.

Treat this repo as future-public:

- never commit `.env`, private keys, wallet material, API tokens, authenticated RPC URLs, cookies, production logs, database dumps, private user data, or coordinator signing secrets
- commit model/corpus files only when redistribution, license, and size policy are acceptable
- otherwise commit manifests, hashes, and deterministic fetch/install instructions
- inspect `git diff --cached` before every commit and run a secret scan when available
- if a secret is staged or committed, stop and rotate it before pushing
