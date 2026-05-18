# CoreTex Documentation Map

Last updated: 2026-05-13.

This file is the source of truth for which docs are live. Anything under
`docs/archive/` or `ops/archive/` is historical and must not be used as launch
authority. Files in `docs/HANDOFFS/` are time-bound agent-to-agent handoffs;
read them only if you are the named recipient agent or auditing the work
they describe.

## Quick navigation

| If you want to… | Read |
|---|---|
| Understand the controlling launch plan | [`CORETEX_LAUNCH_PLAN_v2.md`](./CORETEX_LAUNCH_PLAN_v2.md) |
| Run the 11-step post-corpus orchestration | [`CORETEX_POST_CORPUS_PLAYBOOK.md`](./CORETEX_POST_CORPUS_PLAYBOOK.md) |
| Run the launch-blocking end-to-end orchestrator | [`CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md`](./CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md) |
| Verify cross-CPU determinism for auditors | [`CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md`](./CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md) |
| See what's already been calibrated and proven | [`CORETEX_CALIBRATION_2026-05-10.md`](./CORETEX_CALIBRATION_2026-05-10.md) + `/var/lib/coretex/reports/` |
| Wire CoreTex into the coordinator | [`CORETEX_COORDINATOR_INTEGRATION_RUNBOOK.md`](./CORETEX_COORDINATOR_INTEGRATION_RUNBOOK.md) |
| Mainnet launch gates | [`CORETEX_MAINNET_LAUNCH_CHECKLIST.md`](./CORETEX_MAINNET_LAUNCH_CHECKLIST.md) |
| Day-2 operations | [`CORETEX_PRODUCTION_RUNBOOK.md`](./CORETEX_PRODUCTION_RUNBOOK.md) |

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
- [`CORETEX_POST_CORPUS_PLAYBOOK.md`](./CORETEX_POST_CORPUS_PLAYBOOK.md) —
  11-step execution checklist for the work that runs after the launch
  corpus finishes generating; references prior-run evidence to avoid
  redoing already-validated steps.
- [`CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md`](./CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md) —
  launch-blocking end-to-end execution plan (8 phases).
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
- [`CORETEX_MINER_QUICKSTART.md`](./CORETEX_MINER_QUICKSTART.md) —
  miner-facing five-step onboarding.
- [`contract-addresses-mainnet.md`](./contract-addresses-mainnet.md) —
  Base mainnet addresses.

## Audit And Evidence

### Documented evidence
- [`CORETEX_CALIBRATION_2026-05-10.md`](./CORETEX_CALIBRATION_2026-05-10.md) —
  dated calibration record; full narrative of the 2026-05-10 orchestration pass.
- [`CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md`](./CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md) —
  standalone auditor-facing proof of cross-CPU determinism at the bi-encoder
  stage (Zen 4 AVX-512 ↔ Zen 3 AVX-2).
- [`CORETEX_FRONTIER_RETRIEVAL_EXECUTION_HANDOFF.md`](./CORETEX_FRONTIER_RETRIEVAL_EXECUTION_HANDOFF.md) —
  current handoff (pre-pivot; treat its labeler references as stale).
- [`CORETEX_MODEL_SELECTION_AUDIT.md`](./CORETEX_MODEL_SELECTION_AUDIT.md) —
  pinned model selection and rejected alternatives.
- [`CORETEX_SOURCE_DATA_AUDIT.md`](./CORETEX_SOURCE_DATA_AUDIT.md) —
  coordinator dataset audit and corpus-source decision.

### On-disk evidence (referenced by the docs above)
| Path | What it contains | Date |
|---|---|---|
| `/var/lib/coretex/reports/corpus-validation.json` | 1,752-event calibration corpus validation (errors=0) | 2026-05-10 |
| `/var/lib/coretex/reports/corpus-capacity.json` | 678,910-event launch corpus capacity projection | 2026-05-10 |
| `/var/lib/coretex/reports/determinism-host-host_{a,b,c}.json` | 200-pair determinism reports per logical host | 2026-05-10 |
| `/var/lib/coretex/reports/determinism-aggregate.json` | Cross-host aggregate: P50/P90/P99 = 0 ppm vs 250 ppm tolerance | 2026-05-10 |
| `/var/lib/coretex/reports/phase13-real.log` | Phase 13 e2e log (3/5 accepted + adversarial rejected → PASS) | 2026-05-10 |
| `/var/lib/coretex/reports/final-launch-summary.md` | Human-readable summary of the calibration pass | 2026-05-10 |
| `/var/lib/coretex/reports/orchestrate.log` | Chained orchestrate-cpu-calibration.sh log | 2026-05-10 |
| `/var/lib/coretex/reports/label-reranker-correlation-smoke.json` | 200-pair correlation smoke — **FAILED**, under investigation | 2026-05-10 |
| `/etc/coretex/bundle-manifest-v2.json` | Calibrated bundle manifest (post-pivot v2) | 2026-05-10 |
| `/etc/coretex/bundle-profile-v2.json` | Calibrated bundle profile (params + weights + floors) | 2026-05-10 |
| `/etc/coretex/template-bundle.json` | Bundle template (pre-calibration scaffold) | 2026-05-10 |

## Design Background

- [`CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md`](./CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md) —
  design background; subordinate to `CORETEX_LAUNCH_PLAN_v2.md` anywhere
  the two differ.
- [`CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md`](./CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md) —
  controlling design for per-patch on-chain randomness; also holds the
  post-corpus / pre-launch backlog under §"Auditor Follow-Ups" and
  §"Post-corpus, gameability + multi-host hardening".
- [`CORETEX_V4_INDEFINITE_SCALABILITY_HARDENING_PLAN.md`](./CORETEX_V4_INDEFINITE_SCALABILITY_HARDENING_PLAN.md) —
  additive hardening notes for indefinite-scaling design property.

## Superseded / historical

- [`CORETEX_SEALED_EPOCH_EVAL_HARDENING_PLAN.md`](./CORETEX_SEALED_EPOCH_EVAL_HARDENING_PLAN.md) —
  **SUPERSEDED** by `CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md` (per-patch
  on-chain randomness replaces sealed-epoch commit/reveal). Retained for
  design history only.

## Handoffs

- [`HANDOFFS/`](./HANDOFFS/) — agent-to-agent handoff documents, dated.
  Active handoffs at time of writing:
  - `HANDOFF_2026-05-13_PARALLEL_WORK.md` — work for the next agent to do
    in parallel with the in-flight launch corpus generation (tasks #6,
    #16, #17).

## Archived Historical Docs

Historical CoreTex pre-launch, merge-bonus, testnet, multisig-override, and
slot-fill/structural-commitment docs were moved to:

- [`archive/stale-coretex/`](./archive/stale-coretex/)
- [`../ops/archive/stale-coretex/`](../ops/archive/stale-coretex/)
- [`../ops/testnet/archive/stale-coretex/`](../ops/testnet/archive/stale-coretex/)

They are useful for provenance only. New runbooks must link to the current
authority files above.
