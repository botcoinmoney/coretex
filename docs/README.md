# CoreTex Documentation Map

Last updated: 2026-05-10.

This file is the source of truth for which docs are live. Anything under
`docs/archive/` or `ops/archive/` is historical and must not be used as launch
authority.

## Calibration Host

The standalone CPU calibration host runbook is:

- [`CORETEX_CALIBRATION_AGENT_RUNBOOK.md`](./CORETEX_CALIBRATION_AGENT_RUNBOOK.md)

The private clone-and-test harness for calibration agents is:

- `git@github.com:botcoinmoney/coretex-calibration-orchestrator.git`

That private repo vendors the current `BotcoinMiningV4`, `CortexState`,
Foundry tests, Base fork rehearsal, public contract addresses, and copies of
the launch runbooks. Its bootstrap pins this CoreTex repo at the committed
CoreTex hash recorded in its `.env.example`.

## Current Authority

- [`CORETEX_LAUNCH_PLAN_v2.md`](./CORETEX_LAUNCH_PLAN_v2.md) — controlling
  launch plan after the synthesizer-labeled corpus pivot.
- [`CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md`](./CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md) —
  launch-blocking end-to-end execution plan.
- [`CORETEX_CALIBRATION_AGENT_RUNBOOK.md`](./CORETEX_CALIBRATION_AGENT_RUNBOOK.md) —
  CPU calibration host instructions.
- [`CORETEX_COORDINATOR_QUICKSTART.md`](./CORETEX_COORDINATOR_QUICKSTART.md) —
  five-step coordinator mount.
- [`CORETEX_COORDINATOR_INTEGRATION_RUNBOOK.md`](./CORETEX_COORDINATOR_INTEGRATION_RUNBOOK.md) —
  complete coordinator integration contract.
- [`CORETEX_MAINNET_LAUNCH_CHECKLIST.md`](./CORETEX_MAINNET_LAUNCH_CHECKLIST.md) —
  launch gates.
- [`CORETEX_PRODUCTION_RUNBOOK.md`](./CORETEX_PRODUCTION_RUNBOOK.md) —
  operations reference.
- [`contract-addresses-mainnet.md`](./contract-addresses-mainnet.md) —
  Base mainnet addresses.

## Audit And Evidence

- [`CORETEX_CALIBRATION_2026-05-10.md`](./CORETEX_CALIBRATION_2026-05-10.md) —
  dated calibration record.
- [`CORETEX_FRONTIER_RETRIEVAL_EXECUTION_HANDOFF.md`](./CORETEX_FRONTIER_RETRIEVAL_EXECUTION_HANDOFF.md) —
  current handoff.
- [`CORETEX_MODEL_SELECTION_AUDIT.md`](./CORETEX_MODEL_SELECTION_AUDIT.md) —
  pinned model selection and rejected alternatives.
- [`CORETEX_SOURCE_DATA_AUDIT.md`](./CORETEX_SOURCE_DATA_AUDIT.md) —
  coordinator dataset audit and corpus-source decision.

## Design Background

- [`CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md`](./CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md)
  is retained as design background. It is subordinate to
  `CORETEX_LAUNCH_PLAN_v2.md` anywhere the two differ.

## Archived Historical Docs

Historical CortexBench V0, merge-bonus, testnet, multisig-override, and
slot-fill/structural-commitment docs were moved to:

- [`archive/legacy-cortex-v0/`](./archive/legacy-cortex-v0/)
- [`../ops/archive/legacy-cortex-v0/`](../ops/archive/legacy-cortex-v0/)
- [`../ops/testnet/archive/legacy-cortex-v0/`](../ops/testnet/archive/legacy-cortex-v0/)

They are useful for provenance only. New runbooks must link to the current
authority files above.
