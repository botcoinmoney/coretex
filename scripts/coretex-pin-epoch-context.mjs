#!/usr/bin/env node
/**
 * V4-owned CoreTex epoch context pin helper.
 *
 * Reads coordinator epoch status / epoch-evolve output, simulates by default,
 * and broadcasts only with --broadcast. Secrets are read from env or an
 * explicit private-key path and are never printed.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { argv, env, exit } from 'node:process';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

import { repoRoot } from './_repo-root.mjs';

const ABI_SET_CONTEXT = 'setCoreTexEpochContext(uint64,(bytes32,bytes32,bytes32,bytes32,bytes32))';
const ABI_SET_COMMIT = 'setEpochCommit(uint64,bytes32)';
const ZERO32 = '0x' + '00'.repeat(32);
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
function contextFromStatus(status) {
  const p = status.coreTexEpochContext ?? status.epochContext ?? status.v4Context ?? status;
  const out = {
    epoch: Number(p.epoch ?? status.epoch ?? status.currentEpoch ?? status.epochId),
    parentStateRoot: p.parentStateRoot ?? status.parentStateRoot,
    coreVersionHash: p.coreVersionHash ?? status.coreVersionHash ?? status.bundleHash,
    corpusRoot: p.corpusRoot ?? status.corpusRoot,
    activeFrontierRoot: p.activeFrontierRoot ?? status.activeFrontierRoot,
    baselineManifestHash: p.baselineManifestHash ?? status.baselineManifestHash ?? status.rotationManifestHash,
    hiddenSeedCommit: p.hiddenSeedCommit ?? status.hiddenSeedCommit ?? status.epochCommit,
  };
  if (!Number.isSafeInteger(out.epoch) || out.epoch < 0) fail('invalid CoreTex epoch context epoch');
  for (const k of ['parentStateRoot', 'coreVersionHash', 'corpusRoot', 'activeFrontierRoot', 'baselineManifestHash', 'hiddenSeedCommit']) {
    if (!isBytes32(out[k])) fail(`invalid CoreTex epoch context ${k}`);
  }
  return out;
}
function tuple(p) {
  return `(${p.parentStateRoot},${p.corpusRoot},${p.activeFrontierRoot},${p.baselineManifestHash},${p.coreVersionHash})`;
}
function runCast(label, castArgs) {
  const r = spawnSync('cast', castArgs, { cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) fail(`${label} failed: ${r.stderr || r.stdout}`);
  return r.stdout?.trim() ?? '';
}
function call(rpcUrl, to, sig, ...params) {
  return runCast(`call ${sig}`, ['call', '--rpc-url', rpcUrl, to, sig, ...params.map(String)]).replace(/\s*\[[^\]]*\]\s*$/, '').trim();
}
function send(rpcUrl, pk, to, sig, params) {
  const out = runCast(`send ${sig}`, ['send', '--rpc-url', rpcUrl, '--private-key', pk, '--json', to, sig, ...params.map(String)]);
  try { return JSON.parse(out); } catch { return { raw: out }; }
}
function privateKey() {
  const envName = flag('private-key-env', env.CORETEX_COORDINATOR_PRIVATE_KEY ? 'CORETEX_COORDINATOR_PRIVATE_KEY' : 'COORDINATOR_SIGNING_KEY');
  const path = flag('private-key', null);
  if (path) return readFileSync(path.startsWith('/') ? path : `${repoRoot}/${path}`, 'utf8').trim();
  if (env[envName]) return env[envName];
  fail(`missing private key; set ${envName}, pass --private-key, or omit --broadcast for simulation`);
}
function verifyPins({ rpcUrl, registry, mining, p }) {
  const expectedRegistry = runCast('checksum registry', ['to-check-sum-address', registry]).toLowerCase();
  const expectedMining = runCast('checksum mining', ['to-check-sum-address', mining]).toLowerCase();
  const v4Registry = call(rpcUrl, mining, 'coreTexRegistry()(address)').toLowerCase();
  const registryV4 = call(rpcUrl, registry, 'botcoinMiningV4()(address)').toLowerCase();
  if (v4Registry !== expectedRegistry) fail(`V4 coreTexRegistry ${v4Registry} != ${expectedRegistry}`);
  if (registryV4 !== expectedMining) fail(`registry botcoinMiningV4 ${registryV4} != ${expectedMining}`);

  const getters = [
    ['epochParentStateRoot(uint64)(bytes32)', p.parentStateRoot],
    ['coreTexParentStateRoot(uint64)(bytes32)', p.parentStateRoot],
    ['liveStateRoot(uint64)(bytes32)', p.parentStateRoot],
    ['epochCoreVersionHash(uint64)(bytes32)', p.coreVersionHash],
    ['coreTexCoreVersionHash(uint64)(bytes32)', p.coreVersionHash],
    ['epochCorpusRoot(uint64)(bytes32)', p.corpusRoot],
    ['coreTexCorpusRoot(uint64)(bytes32)', p.corpusRoot],
    ['epochActiveFrontierRoot(uint64)(bytes32)', p.activeFrontierRoot],
    ['coreTexActiveFrontierRoot(uint64)(bytes32)', p.activeFrontierRoot],
    ['epochBaselineManifestHash(uint64)(bytes32)', p.baselineManifestHash],
    ['coreTexBaselineManifestHash(uint64)(bytes32)', p.baselineManifestHash],
    ['epochHiddenSeedCommit(uint64)(bytes32)', p.hiddenSeedCommit],
    ['epochCommit(uint64)(bytes32)', p.hiddenSeedCommit],
  ];
  for (const [sig, expected] of getters) {
    const to = sig.startsWith('coreTex') || sig.startsWith('epochCommit') ? mining : registry;
    const got = call(rpcUrl, to, sig, p.epoch);
    if (got.toLowerCase() !== expected.toLowerCase()) fail(`${sig} ${got} != ${expected}`);
  }
}

async function main() {
  const statusUri = flag('status', flag('params', null));
  const rpcUrl = flag('rpc-url', env.BASE_RPC_URL ?? null);
  const registry = flag('registry', env.CORETEX_REGISTRY_ADDRESS ?? null);
  const mining = flag('mining-contract', env.BOTCOIN_MINING_CONTRACT_ADDRESS ?? env.BOTCOIN_MINING_V4 ?? null);
  if (!rpcUrl) fail('--rpc-url or BASE_RPC_URL is required');
  if (!isAddress(registry)) fail('--registry or CORETEX_REGISTRY_ADDRESS is required');
  if (!isAddress(mining)) fail('--mining-contract or BOTCOIN_MINING_CONTRACT_ADDRESS is required');
  const p = contextFromStatus(await readJsonUri(statusUri));
  const contextTuple = tuple(p);

  if (!has('broadcast')) {
    const from = flag('from', env.CORETEX_COORDINATOR_ADDRESS ?? env.OWNER_ADDRESS ?? null);
    if (!isAddress(from)) fail('--from, CORETEX_COORDINATOR_ADDRESS, or OWNER_ADDRESS is required for dry-run simulation');
    runCast('setCoreTexEpochContext dry-run', ['call', '--rpc-url', rpcUrl, '--from', from, mining, ABI_SET_CONTEXT, String(p.epoch), contextTuple]);
    const currentCommit = call(rpcUrl, mining, 'epochCommit(uint64)(bytes32)', p.epoch);
    if (currentCommit.toLowerCase() === ZERO32) {
      runCast('setEpochCommit dry-run', ['call', '--rpc-url', rpcUrl, '--from', from, mining, ABI_SET_COMMIT, String(p.epoch), p.hiddenSeedCommit]);
    } else if (currentCommit.toLowerCase() !== p.hiddenSeedCommit.toLowerCase()) {
      fail(`V4 epochCommit already set to ${currentCommit}, expected ${p.hiddenSeedCommit}`);
    }
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', registry, miningContract: mining, coreTexEpochContext: p }, null, 2));
    return;
  }

  if (flag('confirm', '') !== 'PIN-CORETEX-CONTEXT') fail('--broadcast requires --confirm PIN-CORETEX-CONTEXT');
  const pk = privateKey();
  const txs = [];
  txs.push(send(rpcUrl, pk, mining, ABI_SET_CONTEXT, [p.epoch, contextTuple]));
  const currentCommit = call(rpcUrl, mining, 'epochCommit(uint64)(bytes32)', p.epoch);
  if (currentCommit.toLowerCase() === ZERO32) {
    txs.push(send(rpcUrl, pk, mining, ABI_SET_COMMIT, [p.epoch, p.hiddenSeedCommit]));
  } else if (currentCommit.toLowerCase() !== p.hiddenSeedCommit.toLowerCase()) {
    fail(`V4 epochCommit already set to ${currentCommit}, expected ${p.hiddenSeedCommit}`);
  }
  verifyPins({ rpcUrl, registry, mining, p });
  console.log(JSON.stringify({
    ok: true,
    mode: 'broadcast',
    registry,
    miningContract: mining,
    transactionHashes: txs.map((tx) => tx.transactionHash ?? tx.hash ?? null).filter(Boolean),
    coreTexEpochContext: p,
  }, null, 2));
}

main().catch((e) => fail(e?.stack ?? e?.message ?? String(e)));
