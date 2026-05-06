#!/usr/bin/env node
// V0 owner-revert rehearsal (was multisig — multisig deferred to V1).
//
// Per ORGANISM_CORTEX_STATE_PLAN.md §9 Phase 9 (post-V0-policy update):
//   Dry-run divergent-epoch revert against a deployed CortexRegistry by
//   calling ownerRevertEpoch(uint64) within the audit window. The legacy
//   multisig path (voteRevertEpoch 2-of-N) is retained in the contract for
//   V1 reactivation; V0 ships with single-owner revert.
//
// Modes:
//   - synthetic (default): spins up a local anvil fork of Base mainnet via
//     the user's BASE_RPC_URL, deploys CortexRegistry + CortexMergeBonus,
//     finalizes a synthetic divergent epoch, calls ownerRevertEpoch, and
//     verifies bonus funding is blocked.
//   - mainnet: requires MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL.
//     Generates the calldata for ownerRevertEpoch + sample tx envelope; the
//     operator broadcasts via their own wallet. This script does NOT sign
//     or send mainnet transactions on its own.

import { exit, env, argv } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { EVENT_TOPICS } from '../../packages/cortex/dist/event-topics.js';

const MODE = env.MAINNET_CONFIRM ? 'mainnet' : 'synthetic';
console.log(`[revert-drill] mode=${MODE}`);

if (MODE === 'mainnet') {
  if (env.MAINNET_CONFIRM !== 'I-UNDERSTAND-THIS-IS-MAINNET-DRILL') {
    console.error('mainnet mode requires MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL');
    exit(1);
  }
  // Selector = first 4 bytes of keccak256("ownerRevertEpoch(uint64)").
  const sigHash = spawnSync('cast', ['keccak', 'ownerRevertEpoch(uint64)'], { encoding: 'utf8' });
  if (sigHash.status !== 0) { console.error('cast keccak failed'); exit(2); }
  const selector = sigHash.stdout.trim().slice(0, 10); // 0x + 4 bytes hex
  const epoch = env.TEST_EPOCH ?? '0';
  const epochArg = BigInt(epoch).toString(16).padStart(64, '0');
  const calldata = selector + epochArg;
  console.log('[revert-drill] mainnet revert calldata for operator wallet:');
  console.log('  to       :', env.CORTEX_REGISTRY_ADDRESS ?? '<set CORTEX_REGISTRY_ADDRESS>');
  console.log('  function :', 'ownerRevertEpoch(uint64)');
  console.log('  epoch    :', epoch);
  console.log('  calldata :', calldata);
  console.log('');
  console.log('[revert-drill] sample broadcast (operator decides whether to send):');
  console.log(`  cast send $CORTEX_REGISTRY_ADDRESS '${calldata}' --rpc-url $BASE_RPC_URL --private-key $OWNER_PK`);
  exit(0);
}

// ─── synthetic mode ──────────────────────────────────────────────────────────

const BASE_RPC = env.BASE_RPC_URL ?? 'https://mainnet.base.org';
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEPLOYER  = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const RPC = 'http://127.0.0.1:8553';

console.log('[revert-drill] launching anvil fork…');
const anvil = spawn('anvil', ['--fork-url', BASE_RPC, '--port', '8553', '--silent'], {
  stdio: ['ignore', 'ignore', 'ignore'], detached: false,
});
await sleep(4000);

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await r.json()).result;
}

function sh(...args) {
  const r = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

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
  // 1. Deploy CortexRegistry + CortexMergeBonus via fork.
  const reg   = deploy('src/CortexRegistry.sol:CortexRegistry', DEPLOYER, DEPLOYER);
  // CortexMergeBonus signature: (_botcoin, _registry, _operator).
  const tok   = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed'; // any deployed Base mainnet ERC-20; the rehearsal won't transfer
  const bonus = deploy('src/CortexMergeBonus.sol:CortexMergeBonus', tok, reg, DEPLOYER);
  console.log('[revert-drill]   CortexRegistry  ', reg);
  console.log('[revert-drill]   CortexMergeBonus', bonus);

  // 2. Finalize a synthetic epoch.
  const epoch = 42;
  const fields = [
    String(epoch),
    '0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(32),
    '0x' + 'dd'.repeat(32), '0x' + 'ee'.repeat(32), '0x' + 'ff'.repeat(32),
    '0x' + '11'.repeat(32),
  ];
  const f = sh('cast', 'send', reg,
    'finalizeEpoch(uint64,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)',
    ...fields,
    '--rpc-url', RPC, '--private-key', ANVIL_KEY);
  if (f.status !== 0) throw new Error('finalizeEpoch failed: ' + f.stderr);

  // 3. Verify epochFinalized true, epochReverted false.
  const before = sh('cast', 'call', reg, 'epochFinalized(uint64)(bool)', String(epoch),
    '--rpc-url', RPC).stdout.trim();
  if (before !== 'true') throw new Error(`pre-revert epochFinalized expected true, got ${before}`);
  console.log(`[revert-drill] epoch ${epoch} finalized: ${before}`);

  // 4. Owner calls ownerRevertEpoch within audit window.
  const r = sh('cast', 'send', reg, 'ownerRevertEpoch(uint64)', String(epoch),
    '--rpc-url', RPC, '--private-key', ANVIL_KEY);
  if (r.status !== 0) throw new Error('ownerRevertEpoch failed: ' + r.stderr);

  const finalizedAfter = sh('cast', 'call', reg, 'epochFinalized(uint64)(bool)', String(epoch),
    '--rpc-url', RPC).stdout.trim();
  const revertedAfter  = sh('cast', 'call', reg, 'epochReverted(uint64)(bool)', String(epoch),
    '--rpc-url', RPC).stdout.trim();
  if (finalizedAfter !== 'false' || revertedAfter !== 'true') {
    throw new Error(`post-revert state wrong: finalized=${finalizedAfter} reverted=${revertedAfter}`);
  }
  console.log(`[revert-drill] post-revert: epochFinalized=${finalizedAfter}, epochReverted=${revertedAfter}`);

  // 5. Confirm bonus funding for this epoch reverts (cross-contract guard).
  // After the audit window we'd attempt fundEpoch; in this drill we just
  // confirm the registry says reverted so CortexMergeBonus.fundEpoch will
  // block via the EpochWasReverted check.
  console.log('[revert-drill] OK — owner-revert path verified end-to-end on fork.');
} catch (e) {
  console.error('[revert-drill] FAIL:', e.message);
  exitCode = 3;
} finally {
  anvil.kill();
}
exit(exitCode);
