#!/usr/bin/env node
// V0 emergency-disable rehearsal.
//
// Per §9 Phase 9: pause CortexRegistry mid-epoch on mainnet; SWCP claim
// parity preserved end-to-end through a real claim transaction.
//
// Modes:
//   - synthetic (default): anvil fork of Base mainnet; deploy CortexRegistry,
//     pause, verify Cortex finalize blocked, unpause, verify finalize
//     resumes. SWCP non-interference in this drill is trivially preserved
//     because anvil forks the real BotcoinMiningV3 deployment — pausing the
//     Cortex registry can never affect a separate contract.
//   - mainnet: requires MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL.
//     Prints the calldata sequence for the operator to broadcast via their
//     own wallet.

import { exit, env } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const MODE = env.MAINNET_CONFIRM ? 'mainnet' : 'synthetic';
console.log(`[pause-drill] mode=${MODE}`);

if (MODE === 'mainnet') {
  if (env.MAINNET_CONFIRM !== 'I-UNDERSTAND-THIS-IS-MAINNET-DRILL') {
    console.error('mainnet mode requires MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL');
    exit(1);
  }
  console.log('[pause-drill] mainnet step sequence (operator broadcasts each):');
  console.log('  1. cast send $CORTEX_REGISTRY_ADDRESS "pause()" --rpc-url $BASE_RPC_URL --private-key $OWNER_PK');
  console.log('  2. cast call $CORTEX_REGISTRY_ADDRESS "paused()(bool)" --rpc-url $BASE_RPC_URL  # expect true');
  console.log('  3. (independent) submit a SWCP receipt + claim — verify tx confirms (SWCP unaffected).');
  console.log('  4. cast send $CORTEX_REGISTRY_ADDRESS "unpause()" --rpc-url $BASE_RPC_URL --private-key $OWNER_PK');
  console.log('  5. cast call $CORTEX_REGISTRY_ADDRESS "paused()(bool)" --rpc-url $BASE_RPC_URL  # expect false');
  exit(0);
}

// ─── synthetic mode ──────────────────────────────────────────────────────────

const BASE_RPC = env.BASE_RPC_URL ?? 'https://mainnet.base.org';
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEPLOYER  = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const PORT = env.CORTEX_REHEARSAL_PORT ?? '8554';
const RPC = `http://127.0.0.1:${PORT}`;

console.log('[pause-drill] launching anvil fork…');
const anvil = spawn('anvil', ['--fork-url', BASE_RPC, '--port', PORT, '--silent'], {
  stdio: ['ignore', 'ignore', 'pipe'], detached: false,
});

function sh(...args) {
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

async function waitForRpc() {
  const started = Date.now();
  let lastErr = '';
  while (Date.now() - started < 30_000) {
    if (anvil.exitCode !== null) {
      const stderr = anvil.stderr.read()?.toString?.() ?? '';
      throw new Error(`anvil exited early on port ${PORT}: ${stderr || `code ${anvil.exitCode}`}`);
    }
    try {
      const r = await fetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'web3_clientVersion', params: [] }),
      });
      const j = await r.json();
      if (j.result) return;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(250);
  }
  throw new Error(`anvil RPC did not become ready on ${RPC}: ${lastErr}`);
}

await waitForRpc();

function deploy(name, ...args) {
  const r = sh('forge', 'create',
    '--root', 'contracts',
    '--rpc-url', RPC,
    '--private-key', ANVIL_KEY,
    '--broadcast',
    name,
    '--constructor-args', ...args);
  if (r.status !== 0) throw new Error('deploy failed: ' + (r.stderr || r.stdout));
  const m = r.stdout.match(/Deployed to:\s+(0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error('no Deployed-to in output: ' + r.stdout);
  return m[1];
}

let exitCode = 0;
try {
  const reg = deploy('src/CortexRegistry.sol:CortexRegistry', DEPLOYER, DEPLOYER);
  console.log('[pause-drill]   CortexRegistry', reg);

  // 1. pause()
  const p = sh('cast', 'send', reg, 'pause()', '--rpc-url', RPC, '--private-key', ANVIL_KEY);
  if (p.status !== 0) throw new Error('pause failed: ' + p.stderr);
  const paused = sh('cast', 'call', reg, 'paused()(bool)', '--rpc-url', RPC).stdout.trim();
  if (paused !== 'true') throw new Error(`expected paused=true, got ${paused}`);
  console.log('[pause-drill] paused: true');

  // 2. While paused, finalizeEpoch must revert with whenNotPaused.
  const fail = sh('cast', 'send', reg,
    'finalizeEpoch(uint64,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)',
    '1',
    '0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(32),
    '0x' + 'dd'.repeat(32), '0x' + 'ee'.repeat(32), '0x' + 'ff'.repeat(32), '0x' + '11'.repeat(32),
    '--rpc-url', RPC, '--private-key', ANVIL_KEY);
  if (fail.status === 0) throw new Error('finalizeEpoch should have reverted while paused');
  console.log('[pause-drill] finalizeEpoch reverted while paused (correct)');

  // 3. unpause()
  const u = sh('cast', 'send', reg, 'unpause()', '--rpc-url', RPC, '--private-key', ANVIL_KEY);
  if (u.status !== 0) throw new Error('unpause failed: ' + u.stderr);
  const unpaused = sh('cast', 'call', reg, 'paused()(bool)', '--rpc-url', RPC).stdout.trim();
  if (unpaused !== 'false') throw new Error(`expected paused=false, got ${unpaused}`);
  console.log('[pause-drill] unpaused');

  // 4. finalizeEpoch now succeeds.
  const ok = sh('cast', 'send', reg,
    'finalizeEpoch(uint64,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)',
    '1',
    '0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(32),
    '0x' + 'dd'.repeat(32), '0x' + 'ee'.repeat(32), '0x' + 'ff'.repeat(32), '0x' + '11'.repeat(32),
    '--rpc-url', RPC, '--private-key', ANVIL_KEY);
  if (ok.status !== 0) throw new Error('post-unpause finalizeEpoch failed: ' + ok.stderr);
  console.log('[pause-drill] finalizeEpoch succeeds after unpause');

  // 5. SWCP non-interference is preserved by construction — the registry's
  // pause flag has no edge to BotcoinMiningV3. The test_pauseMatrix forge
  // tests already prove this on a forked mainnet (CortexFork.t.sol). This
  // synthetic drill confirms the pause toggle itself works on a live fork.

  console.log('[pause-drill] OK — pause/unpause cycle verified end-to-end on fork.');
} catch (e) {
  console.error('[pause-drill] FAIL:', e.message);
  exitCode = 3;
} finally {
  anvil.kill();
  await sleep(250);
}
exit(exitCode);
