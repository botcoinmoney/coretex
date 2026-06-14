#!/usr/bin/env node
/**
 * screener-real-qwen-miner-driver.mjs — zero-context Sonnet subagent miner orchestrator.
 *
 * Companion to scripts/screener-real-qwen-economics.mjs. Purpose: produce the EXACT
 * spawn contract for the Claude Sonnet subagent that drives the running real-Qwen
 * coordinator as a real miner would — and verify the coordinator is ready before
 * the subagent is launched.
 *
 * The subagent MUST see ONLY:
 *   1. docs/BOTCOIN_CORETEX_MINER_SKILL.md            (the canonical miner skill)
 *   2. COORDINATOR_URL                                (the live /coretex/* endpoint)
 *   3. NOOKPLOT_AGENT_PRIVATE_KEY + NOOKPLOT_AGENT_ADDRESS   (the mining wallet from
 *                                                      coretex_miner_testing/.env)
 *   4. NOOKPLOT_API_KEY + NOOKPLOT_GATEWAY_URL        (Bankr Path-A; optional)
 *   5. BASE_RPC_URL                                   (Path-B optional)
 *
 * The subagent MUST NOT see:
 *   - any other repo source (coretex internals, scoring code, profile JSON)
 *   - any calibration finding, working note, or generated run output
 *   - this script or screener-real-qwen-economics.mjs
 *   - the launch profile or bundle manifest (only what the /coretex/status response exposes)
 *
 * This script PRINTS the verbatim Agent-tool invocation envelope the orchestrator (Claude)
 * must use to launch the subagent. It does not itself call Agent — that is a privileged
 * action only the parent orchestrator has access to.
 *
 * Usage:
 *   node scripts/screener-real-qwen-miner-driver.mjs --coord-url http://127.0.0.1:7790 --rounds 5
 *
 * The driver:
 *   1. Polls /coretex/health until the coord is ready (or aborts after 60s).
 *   2. Reads the mining wallet from coretex_miner_testing/.env (refuses if absent).
 *   3. Prints the exact Agent-spawn envelope including subagent_type, prompt, and the
 *      allowed-context manifest (skill + envs + URL only).
 *   4. After the subagent runs, optionally tails submissions.jsonl and prints a class-
 *      outcome summary so the orchestrator can decide whether to spawn another round.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { argv, env, exit } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { repoRoot } from './_repo-root.mjs';

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const COORD = flag('coord-url', 'http://127.0.0.1:7790').replace(/\/$/, '');
const ROUNDS = Number(flag('rounds', '5'));
const RUN_ID = flag('run-id', env.ECONOMICS_RUN_ID || null);
const BUDGET_PER_ROUND = Number(flag('budget', '20'));      // subagent submit budget per round

// 1. Wait for coord.
process.stdout.write(`[miner-driver] Probing ${COORD}/coretex/health …\n`);
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${COORD}/coretex/health`);
    if (r.ok) { ready = true; break; }
  } catch {}
  await sleep(1000);
}
if (!ready) {
  process.stderr.write(`[miner-driver] ABORT: ${COORD} not reachable after 60s — start the real-Qwen coord first:\n` +
                       `    node scripts/screener-real-qwen-economics.mjs --cpu-smoke|--gpu …\n`);
  exit(2);
}
const health = await (await fetch(`${COORD}/coretex/health`)).json();
process.stdout.write(`[miner-driver] coord ready: ${JSON.stringify(health)}\n`);

// 2. Mining wallet.
const minerEnvPath = `${repoRoot}/coretex_miner_testing/.env`;
if (!existsSync(minerEnvPath)) {
  process.stderr.write(`[miner-driver] ABORT: ${minerEnvPath} missing — required for the subagent miner wallet.\n`);
  exit(2);
}
const minerEnvText = readFileSync(minerEnvPath, 'utf8');
const minerEnv = Object.fromEntries(minerEnvText.split('\n').map((l) => {
  const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  return m ? [m[1], m[2].replace(/^['"]|['"]$/g, '')] : [null, null];
}).filter(([k]) => k));

const requiredKeys = ['NOOKPLOT_AGENT_ADDRESS', 'NOOKPLOT_AGENT_PRIVATE_KEY'];
for (const k of requiredKeys) {
  if (!minerEnv[k]) { process.stderr.write(`[miner-driver] ABORT: ${k} missing from .env\n`); exit(2); }
}

// 3. Print the verbatim Agent spawn envelope.
const subagentPrompt = `You are a BOTCOIN CoreTex miner. You have ONE skill file and ONE coordinator API.
You have NO other context. You CANNOT read any other file in this repository — the coordinator
URL is the only data source you may treat as authoritative for state, threshold, caps, and
acceptance rules. Anything you find via filesystem read or grep is OUT OF SCOPE for this audit
and reading it invalidates the run.

# Your skill
Read \`docs/BOTCOIN_CORETEX_MINER_SKILL.md\` ONCE at the start. Treat it as your only spec.

# Your coordinator
COORDINATOR_URL = ${COORD}
Public surface: GET /coretex/health, GET /coretex/status?miner=0x..., GET /coretex/substrate/:stateRoot,
POST /coretex/submit, GET /coretex/receipt/:hash. Use Authorization when the coordinator requires it.

# Your wallet
MINER_ADDRESS = ${minerEnv.NOOKPLOT_AGENT_ADDRESS}
MINER_PK is in env var NOOKPLOT_AGENT_PRIVATE_KEY (do not log it).
Path A (Bankr): NOOKPLOT_API_KEY${minerEnv.NOOKPLOT_API_KEY ? ' set' : ' UNSET'}, NOOKPLOT_GATEWAY_URL${minerEnv.NOOKPLOT_GATEWAY_URL ? ' set' : ' UNSET'}.
Path B (self-managed): BASE_RPC_URL${env.BASE_RPC_URL ? ' set' : ' UNSET'}.

# Your budget
Submit at most ${BUDGET_PER_ROUND} patches in this round, OR until your perMinerScreenerRemaining
hits 0, OR until /coretex/status reports a new live root after one of YOUR state advances.
For each submission, log a single line: timestamp + patch summary (type, indices, wordCount) +
result envelope status/code/deltaPpm. Do NOT log the full patchBytesHex or any newWord content.

# Audit goals (the run is recording every submit — drive friction surface, not numerics)
- Try at least one of each: a normal screener attempt, a deliberate junk attempt, a duplicate
  retry of a previously-accepted patch, a stale-parent retry against a moved root, a near-cap
  burst, and (if your delta is high enough) one STATE_ADVANCE attempt.
- When the coordinator rejects a submission, paste the reason/code into your log so the
  post-run analyzer can attribute false-screener / true-advance-as-screener rates.
- DO NOT consult external sources. DO NOT guess hidden eval / qrels / answer IDs. DO NOT
  read other repo files. The point of this run is to audit what a real launch miner sees.

# How to stop
Stop after the budget or when /coretex/status shows your remaining cap = 0. Write a short
recap to stdout: number of attempts, accepted-screener count, accepted-advance count, the
3 most surprising friction moments, and any documentation gap you hit in the skill file.`;

process.stdout.write('\n──────────────────────────────────────────────────────────────────────\n');
process.stdout.write('AGENT SPAWN ENVELOPE — pass this verbatim to the Agent tool (Sonnet 4.6)\n');
process.stdout.write('──────────────────────────────────────────────────────────────────────\n\n');
process.stdout.write(JSON.stringify({
  subagent_type: 'general-purpose',
  description: `CoreTex zero-context miner round (budget=${BUDGET_PER_ROUND})`,
  model: 'sonnet',
  prompt: subagentPrompt,
}, null, 2));
process.stdout.write('\n──────────────────────────────────────────────────────────────────────\n');

// 4. Optional: poll the coord snapshot so the orchestrator can decide next rounds.
process.stdout.write(`\n[miner-driver] coord snapshot before subagent run:\n`);
try {
  const snap = await (await fetch(`${COORD}/admin/snapshot`)).json();
  process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
} catch (e) {
  process.stdout.write(`(admin/snapshot unreachable: ${e.message})\n`);
}

process.stdout.write(`\n[miner-driver] ready. After the subagent finishes, inspect:\n` +
                     `  release/calibration/runs/${RUN_ID ?? '<run-id>'}/submissions.jsonl\n` +
                     `  release/calibration/runs/${RUN_ID ?? '<run-id>'}/transitions.jsonl\n` +
                     `Then call /admin/next-epoch or /admin/rotate-churn on the coord and spawn another round.\n`);
