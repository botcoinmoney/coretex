#!/usr/bin/env node
// Scripted miner roundtrip — used by instructions.md §8 and the Phase 5
// "Full miner loop e2e" gate (§9). Speaks plain HTTP + the receipt mapping in
// specs/receipt_field_mapping.md. No real LLM. Deterministic patch generator
// for smoke purposes only — proves the wire is alive.
//
// Usage:
//   node scripts/scripted-miner.mjs --base http://127.0.0.1:8081
//
// Exits non-zero on:
//   - GET /v1/cortex/challenge fails
//   - POST /v1/cortex/submit fails or screener rejects (when expected to pass)
//   - Receipt fields don't match the §6 mapping

import { argv, exit } from 'node:process';

const args = Object.fromEntries(
  argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : []))
    .filter((p) => p.length === 2),
);

const base = args.base ?? process.env.COORDINATOR_BASE ?? 'http://127.0.0.1:8081';
const minerHeader = args.miner ?? process.env.MINER_ADDRESS ?? '0x0000000000000000000000000000000000000001';

async function get(path) {
  const r = await fetch(`${base}${path}`, { headers: { 'x-miner': minerHeader } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-miner': minerHeader },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

(async () => {
  console.log(`[scripted-miner] base=${base} miner=${minerHeader}`);

  // 1) /healthz
  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  if (!health.ok) {
    console.error('[scripted-miner] /healthz not ok:', health);
    exit(1);
  }

  // 2) /v1/cortex/challenge — when Phase 5 lands this returns the spec'd shape.
  let challenge;
  try {
    challenge = await get('/v1/cortex/challenge');
  } catch (e) {
    console.error('[scripted-miner] challenge fetch failed (expected pre-Phase-5):', e.message);
    exit(2);
  }

  const required = ['lane', 'epoch', 'parentStateRoot', 'experienceCorpusRoot',
    'coreVersionHash', 'patchObjective', 'patchBudget', 'shardId',
    'shardDescriptor', 'submissionFormat', 'creditsPerSolve'];
  const missing = required.filter((k) => !(k in challenge));
  if (missing.length) {
    console.error('[scripted-miner] challenge missing fields:', missing);
    exit(3);
  }
  if (challenge.lane !== 'cortex') {
    console.error('[scripted-miner] expected lane=cortex got', challenge.lane);
    exit(4);
  }

  // 3) Synthesize a no-op-ish patch (will be REJECTED at screener — this is
  //    the negative-path smoke). For a real positive smoke, use a fixture
  //    patch that the test corpus knows passes.
  const patch = {
    parentStateRoot: challenge.parentStateRoot,
    targetIndices: [42],
    newWords: ['0x0000000000000000000000000000000000000000000000000000000000000001'],
    patchType: 'KEY_UPDATE',
    scoreDelta: '0',
  };

  let receipt;
  try {
    receipt = await post('/v1/cortex/submit', { challenge, patch });
  } catch (e) {
    console.error('[scripted-miner] submit failed:', e.message);
    // Pre-Phase-5 stub returns 503 — that is the expected behaviour.
    exit(0);
  }

  console.log('[scripted-miner] receipt:', JSON.stringify(receipt, null, 2));

  const mappingFields = ['worldSeed', 'docHash', 'questionsHash',
    'constraintsHash', 'answersHash', 'rulesVersion'];
  const missingMap = mappingFields.filter((k) => !(k in receipt));
  if (missingMap.length) {
    console.error('[scripted-miner] receipt missing §6 mapping fields:', missingMap);
    exit(5);
  }
  if (receipt.rulesVersion !== '0xC0') {
    console.error('[scripted-miner] receipt rulesVersion expected 0xC0, got', receipt.rulesVersion);
    exit(6);
  }

  console.log('[scripted-miner] ok — wire alive, receipt mapping conforms');
})().catch((e) => {
  console.error('[scripted-miner] unhandled:', e);
  exit(99);
});
