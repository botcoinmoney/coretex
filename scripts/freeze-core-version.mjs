#!/usr/bin/env node
// Freeze coreVersionHash + genesisStateRoot for the pre-launch readiness.
//
// Inputs:
//   --baseline <id>   — winning baseline id (default: A, per Phase 7 iteration)
//   --out <path>      — output JSON path (default: ops/coretex-frozen.json)
//
// Outputs:
//   {
//     winner: "A",
//     coreVersionHash: "0x…",   // keccak256 of the pinned Core CoreTex dist tarball-equivalent
//     genesisStateRoot: "0x…",  // merkleizeState(baseline.genesisState())
//     packedGenesisStateLen: 32768,
//     dist: "packages/cortex/dist",
//     versionConstant: "@botcoin/cortex@…",
//     frozenAt: "<iso>",
//   }

import { argv } from 'node:process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

function arg(name, dflt) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
}

const baselineId = (arg('--baseline', 'A')).toUpperCase();
const outPath = arg('--out', 'ops/coretex-frozen.json');

const baselineDir = {
  A: 'baseline_a_empty',
  B: 'baseline_b_dense_key',
  C: 'baseline_c_binary_key',
  D: 'baseline_d_late_interaction',
  E: 'baseline_e_revocation_aware',
}[baselineId];
if (!baselineDir) { console.error(`unknown baseline ${baselineId}`); process.exit(1); }

const baseline = await import(`${REPO}/experiments/baselines/${baselineDir}/index.mjs`);
const stateMod = await import(`${REPO}/packages/cortex/dist/state/index.js`);
const { merkleizeState, pack, bytesToHex, keccak256 } = stateMod;

const state = baseline.genesisState();
const packed = pack(state);
const genesisStateRoot = bytesToHex(merkleizeState(state));

// coreVersionHash: keccak256 over the canonical concatenation of all .js files
// under packages/cortex/dist (sorted by relative path). This is reproducible
// from the same source build and serves as the CoreTex pinned "Core" identity.
function listFiles(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const p = resolve(root, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p));
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(p);
  }
  return out;
}
const distRoot = resolve(REPO, 'packages/cortex/dist');
const distFiles = listFiles(distRoot)
  .map((p) => relative(distRoot, p))
  .sort();
let acc = new Uint8Array(0);
for (const rel of distFiles) {
  const bytes = new Uint8Array(readFileSync(resolve(distRoot, rel)));
  const path = new TextEncoder().encode(rel + '\0');
  const next = new Uint8Array(acc.length + path.length + bytes.length);
  next.set(acc, 0);
  next.set(path, acc.length);
  next.set(bytes, acc.length + path.length);
  acc = next;
}
const coreVersionHash = bytesToHex(keccak256(acc));

const cortexPkg = JSON.parse(readFileSync(resolve(REPO, 'packages/cortex/package.json'), 'utf8'));

const out = {
  winner: baselineId,
  baselineName: baseline.BASELINE_NAME,
  coreVersionHash,
  genesisStateRoot,
  packedGenesisStateLen: packed.length,
  dist: 'packages/cortex/dist',
  versionConstant: `${cortexPkg.name}@${cortexPkg.version}`,
  scoring: 'coretex-retrieval-current',
  frozenAt: new Date().toISOString(),
  distFileCount: distFiles.length,
};

writeFileSync(resolve(REPO, outPath), JSON.stringify(out, null, 2) + '\n');
console.log(`[freeze] winner=${baselineId} (${baseline.BASELINE_NAME})`);
console.log(`[freeze] coreVersionHash:   ${coreVersionHash}`);
console.log(`[freeze] genesisStateRoot:  ${genesisStateRoot}`);
console.log(`[freeze] wrote ${outPath}`);
