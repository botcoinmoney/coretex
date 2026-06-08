#!/usr/bin/env node
/**
 * CoreTexRegistry.startEpoch operational drill.
 *
 * Reads coordinator epoch status / epoch-evolve output, simulates startEpoch
 * by default, and broadcasts only with --broadcast. Secrets are read from env
 * or an explicit private-key path and are never printed.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { argv, env, exit } from 'node:process';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

import { repoRoot } from './_repo-root.mjs';

const ABI_START = 'startEpoch(uint64,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)';
const args = argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

function fail(msg) {
  console.error(`HARD FAIL: ${msg}`);
  exit(1);
}
function downloadHttp(url, redirects = 0) {
  return new Promise((resolveDone, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        if (!res.headers.location || redirects >= 5) return reject(new Error(`redirect failed for ${url}`));
        return resolveDone(downloadHttp(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; });
      res.on('end', () => resolveDone(out));
    });
    req.on('error', reject);
  });
}
async function readJsonUri(uri) {
  if (!uri) fail('--status or --params is required');
  if (uri.startsWith('file://')) return JSON.parse(readFileSync(fileURLToPath(uri), 'utf8'));
  if (uri.startsWith('http://') || uri.startsWith('https://')) return JSON.parse(await downloadHttp(uri));
  return JSON.parse(readFileSync(uri.startsWith('/') ? uri : `${repoRoot}/${uri}`, 'utf8'));
}
function isBytes32(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
}
function isAddress(v) {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}
function paramsFromStatus(status) {
  const p = status.startEpochParams ?? status;
  const out = {
    epoch: Number(p.epoch ?? status.epoch ?? status.currentEpoch),
    parentStateRoot: p.parentStateRoot,
    coreVersionHash: p.coreVersionHash ?? status.bundleHash,
    corpusRoot: p.corpusRoot ?? status.corpusRoot,
    activeFrontierRoot: p.activeFrontierRoot ?? status.activeFrontierRoot,
    baselineManifestHash: p.baselineManifestHash ?? status.baselineManifestHash ?? status.rotationManifestHash,
    hiddenSeedCommit: p.hiddenSeedCommit ?? status.hiddenSeedCommit,
  };
  if (!Number.isSafeInteger(out.epoch) || out.epoch < 0) fail('invalid startEpoch epoch');
  for (const k of ['parentStateRoot', 'coreVersionHash', 'corpusRoot', 'activeFrontierRoot', 'baselineManifestHash', 'hiddenSeedCommit']) {
    if (!isBytes32(out[k])) fail(`invalid startEpoch ${k}`);
  }
  return out;
}
function runCast(label, castArgs, stdio = 'pipe') {
  const r = spawnSync('cast', castArgs, { cwd: repoRoot, env, encoding: 'utf8', stdio });
  if (r.status !== 0) fail(`${label} failed: ${r.stderr || r.stdout}`);
  return r.stdout?.trim() ?? '';
}
function privateKey() {
  const envName = flag('private-key-env', 'CORETEX_COORDINATOR_PRIVATE_KEY');
  const path = flag('private-key', null);
  if (path) return readFileSync(path.startsWith('/') ? path : `${repoRoot}/${path}`, 'utf8').trim();
  if (env[envName]) return env[envName];
  fail(`missing private key; set ${envName}, pass --private-key, or omit --broadcast for simulation`);
}
function verifyPins({ rpcUrl, registry, p }) {
  const getters = [
    ['epochParentStateRoot(uint64)(bytes32)', p.parentStateRoot],
    ['liveStateRoot(uint64)(bytes32)', p.parentStateRoot],
    ['epochCoreVersionHash(uint64)(bytes32)', p.coreVersionHash],
    ['epochCorpusRoot(uint64)(bytes32)', p.corpusRoot],
    ['epochActiveFrontierRoot(uint64)(bytes32)', p.activeFrontierRoot],
    ['epochBaselineManifestHash(uint64)(bytes32)', p.baselineManifestHash],
    ['epochHiddenSeedCommit(uint64)(bytes32)', p.hiddenSeedCommit],
  ];
  for (const [sig, expected] of getters) {
    const got = runCast(`verify ${sig}`, ['call', '--rpc-url', rpcUrl, registry, sig, String(p.epoch)]);
    if (got.toLowerCase() !== expected.toLowerCase()) fail(`${sig} ${got} != ${expected}`);
  }
}

async function main() {
  const statusUri = flag('status', flag('params', null));
  const rpcUrl = flag('rpc-url', env.BASE_RPC_URL ?? null);
  const registry = flag('registry', env.CORETEX_REGISTRY_ADDRESS ?? null);
  if (!rpcUrl) fail('--rpc-url or BASE_RPC_URL is required');
  if (!isAddress(registry)) fail('--registry or CORETEX_REGISTRY_ADDRESS is required');
  const p = paramsFromStatus(await readJsonUri(statusUri));
  const common = [registry, ABI_START, String(p.epoch), p.parentStateRoot, p.coreVersionHash, p.corpusRoot, p.activeFrontierRoot, p.baselineManifestHash, p.hiddenSeedCommit];
  if (!has('broadcast')) {
    const from = flag('from', env.CORETEX_COORDINATOR_ADDRESS ?? null);
    if (!isAddress(from)) fail('--from or CORETEX_COORDINATOR_ADDRESS is required for dry-run simulation');
    runCast('startEpoch dry-run', ['call', '--rpc-url', rpcUrl, '--from', from, ...common]);
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', registry, startEpochParams: p }, null, 2));
    return;
  }
  if (flag('confirm', '') !== 'START-EPOCH') fail('--broadcast requires --confirm START-EPOCH');
  const pk = privateKey();
  const out = runCast('startEpoch broadcast', ['send', '--rpc-url', rpcUrl, '--private-key', pk, '--json', ...common]);
  let tx = null;
  try { tx = JSON.parse(out); } catch {}
  verifyPins({ rpcUrl, registry, p });
  console.log(JSON.stringify({
    ok: true,
    mode: 'broadcast',
    registry,
    transactionHash: tx?.transactionHash ?? tx?.hash ?? null,
    startEpochParams: p,
  }, null, 2));
}

main().catch((e) => fail(e?.stack ?? e?.message ?? String(e)));
