# CoreTex Documentation Map

Last updated: 2026-06-14.

Public documentation is limited to canonical protocol, runtime, miner,
validator, and deployment surfaces. Working notes, launch scratch output, and
generated run logs stay out of source control.

## Read First

- [`../README.md`](../README.md) — repo overview and canonical code path map.
- [`BOTCOIN_CORETEX_DOCS.md`](./BOTCOIN_CORETEX_DOCS.md) — CoreTex system overview.
- [`BOTCOIN_CORETEX_MINER_SKILL.md`](./BOTCOIN_CORETEX_MINER_SKILL.md) — miner-facing CoreTex lane contract.
- [`CORETEX_VALIDATOR_STANDALONE_RUNBOOK.md`](./CORETEX_VALIDATOR_STANDALONE_RUNBOOK.md) — standalone validator setup/sync/replay.
- [`CORETEX_COORD_WIRING_RUNBOOK.md`](./CORETEX_COORD_WIRING_RUNBOOK.md) — production coordinator wiring and launch gates.

## Specs

- [`../specs/coretex_state.md`](../specs/coretex_state.md) — canonical 1024-state-cell substrate layout.
- [`../specs/patch_format.md`](../specs/patch_format.md) — compact patch wire format.
- [`../specs/merkleization_spec.md`](../specs/merkleization_spec.md) — state/root hashing.
- [`../specs/substrate_retrieval_semantics.md`](../specs/substrate_retrieval_semantics.md) — retrieval semantics.
- [`../specs/retrieval_benchmark.md`](../specs/retrieval_benchmark.md) — scoring benchmark contract.
- [`../specs/hidden_query_pack.md`](../specs/hidden_query_pack.md) — hidden-query pack structure.
- [`../specs/determinism.md`](../specs/determinism.md) — determinism requirements.

## Runtime Docs

- [`miner-api-contract.md`](./miner-api-contract.md) — public miner API contract.
- [`CORETEX_SCORER_PARITY_RELEASE_GATE.md`](./CORETEX_SCORER_PARITY_RELEASE_GATE.md) — scorer parity release gate.
- [`CORETEX_EPOCH_EVOLVE_IAM_RUNBOOK.md`](./CORETEX_EPOCH_EVOLVE_IAM_RUNBOOK.md) — IAM shape for epoch artifact publication.
- [`contract-addresses-mainnet.md`](./contract-addresses-mainnet.md) — current deployed contract addresses.

## Public Launch Artifacts

The public source tree keeps only the minimal launch manifests and replay
fixtures needed by validators/tests:

- `release/calibration/fixtures/state-root-vectors.json`
- `release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json`
- `release/calibration/2026-06-04-memory-atom-v16/bundle-manifest-v2-dgen1-policy-r5-atom-v16-300k-enabled.json`
- `release/calibration/2026-06-04-memory-atom-v16/evaluator-profile-v2-dgen1-policy-r5-atom-v16-300k-enabled.json`
