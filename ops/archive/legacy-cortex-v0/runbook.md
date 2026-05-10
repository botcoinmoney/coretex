# Cortex — Operations Runbook

## Health & metrics

- `/healthz` on cortex-server (`:8081`) — process liveness.
- `/v1/cortex/_healthz` via nginx — public liveness through the same origin.
- Metrics dashboard: see `OBSERVABILITY_DASHBOARD_URL` env var (Phase 8 deliverable).

## Routine: daily epoch finalize

1. Reducer runs greedy-by-marginal-gain on the screener-pass set (§7 Layer B).
2. `CortexEpochFinalized` is provisional for `CHALLENGE_WINDOW_SECONDS` (default 6h).
3. If no public divergence report within the window, the epoch state root becomes canonical.
4. V0 state-advance credits are already settled through the normal Botcoin receipt path; no legacy merge-bonus funding is expected.

## Pause `(P2)`

```bash
# Pause Cortex lane (state finalization halts; SWCP unaffected).
cast send $CORTEX_REGISTRY_ADDRESS "pause()" \
  --rpc-url $BASE_RPC_URL --private-key $OWNER_KEY

# Pause legacy merge-bonus claims separately, if any prior legacy epochs were funded.
cast send $CORTEX_MERGE_BONUS_ADDRESS "pause()" \
  --rpc-url $BASE_RPC_URL --private-key $OWNER_KEY
```

The pause matrix is independent: pausing `CortexRegistry` blocks live state advances and finalization but not legacy bonus claims for already-funded prior epochs. Pausing `CortexMergeBonus` blocks legacy claims but not normal state-advance receipts.

## Revert (audit-window override)

See [`multisig.md`](./multisig.md). 2-of-N. Within the audit window only.

## Latch / unlatch (lane disable)

```bash
sudo systemctl stop cortex-server                  # stop the process
sudo sed -i '/include snippets\/cortex.conf;/d' \
  /etc/nginx/sites-enabled/coordinator.conf       # remove the upstream include
sudo nginx -t && sudo systemctl reload nginx
```

SWCP claim path remains live throughout. Cortex queue persists in SQLite. Re-enable by reversing.

## Saturation alarm `(P8)`

Alert fires when median `score-delta < 1%` for `K=10` consecutive epochs. Response:

1. Confirm the alarm is real (dashboard `pass-rate per family`, `score-delta histogram`).
2. Difficulty bump: tighten `score threshold`, raise `protected-regression strictness`, or shrink `patch budget`. Decision recorded in `context.md`.
3. Family weight adjustment is a Phase-bumping change — do not edit weights live; cut a new `cortex_bench_v0.md` revision and re-anchor.

## Key rotation

- `COORDINATOR_SIGNING_KEY` rotation: SWCP coordinator deliberate procedure (out of scope here).
- Multisig operator: replace one address at a time via `CortexRegistry.setOperator(idx, newAddr)` from the existing 2-of-N. Public announcement required.

## Logs

| Source             | Location (default)                      |
|--------------------|------------------------------------------|
| cortex-server      | `journalctl -u cortex-server -f`         |
| nginx access       | `/var/log/nginx/coordinator.access.log`  |
| nginx error        | `/var/log/nginx/coordinator.error.log`   |
| forge broadcasts   | `contracts/broadcast/`                   |
| eval reports       | `data/cortex/eval-reports/`              |
| epoch snapshots    | `data/cortex/snapshots/`                 |

## Incident decision flow

```
Divergence in finalized state?
  └── Within audit window?
       ├── Yes  → multisig revertEpoch (see multisig.md)
       └── No   → cannot revert; document + V1 fraud-proof path.

Bug or DoS in cortex-server only?
  └── pause CortexRegistry (no further finalization)
      → fix, redeploy, unpause.

Bug spans into SWCP integration?
  └── stop cortex-server (latch) → SWCP unaffected
      → fix in /internal/* shim → restart cortex-server.
```
