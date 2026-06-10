#!/usr/bin/env node
/**
 * Sanctioned packager for the keyless GPU scorer box.
 *
 * WHY: the GPU scorer is a keyless, replaceable acceleration worker. It must
 * NEVER receive coordinator/miner secrets. Provisioning the box by
 * `rsync <repo>` (denylist) is unsafe — it has leaked .env + ssh keys before.
 * This tool assembles an ALLOWLIST of exactly the files the scorer / parity
 * harness needs, then HARD-SCANS the assembled payload for any secret-shaped
 * file or content and ABORTS nonzero if it finds one. It is the only
 * sanctioned way to ship code to the scorer box. Do not rsync the repo.
 *
 *   node scripts/pack-scorer-payload.mjs --mode <scorer|parity-harness> --out <dir>
 *
 * After it prints OK, copy ONLY <dir> to the box (e.g. `rsync <dir>/ box:dest/`
 * or scp -r). The repo root, .env, and any key material are never in <dir>.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync, cpSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const mode = arg('mode', 'scorer');
const outDir = arg('out', '');
if (!outDir) { console.error('usage: pack-scorer-payload.mjs --mode <scorer|parity-harness> --out <dir>'); process.exit(2); }
if (!['scorer', 'parity-harness'].includes(mode)) { console.error(`unknown --mode ${mode}`); process.exit(2); }

// ── ALLOWLIST: exactly what each payload needs, nothing else ──────────────
const SCORER = [
  'packages/cortex/dist',
  'packages/cortex/scripts', // reranker_runner.py + parity bench/diff + materializer + lib
  'packages/cortex/package.json',
];
const PARITY_EXTRA = [
  'scripts/coretex-scorer-parity-harness.mjs',
  'scripts/coretex-scorer-parity-compare.mjs',
  'scripts/recalibrate-baseline.mjs',
  'scripts/lib',
  'scripts/_repo-root.mjs',
  'package.json',
  // launch artifact manifest + bundle/profile (SMALL pins only — NOT the
  // multi-GB corpus/embeddings, which the box re-derives or pulls from S3).
  'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json',
];
const allow = mode === 'scorer' ? SCORER : [...SCORER, ...PARITY_EXTRA];

// ── SECRET TRIPWIRES: filename + content patterns that must never ship ────
const SECRET_NAME = /(^|\/)(\.env(\..*)?|\.npmrc|id_(rsa|ed25519|ecdsa)(\.pub)?|\.ssh-vast[^/]*|.*\.pem|.*\.key|.*\.keystore|credentials|secrets?\.json)$/i;
const SECRET_CONTENT = [
  /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\b[A-Z0-9_]*PRIVATE_KEY\s*=/,
  /\bNOOKPLOT_AGENT_PRIVATE_KEY\b/,
  /\bCOORDINATOR_SIGNING_KEY\b/,
  /\baws_secret_access_key\b/i,
  /\bxoxb-|ghp_[A-Za-z0-9]{30,}/,
];
const SCAN_TEXT_EXT = /\.(mjs|cjs|js|ts|json|py|sh|md|txt|env|ya?ml|toml|ini)$/i;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// 1. Assemble the allowlist into a clean out dir.
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const included = [];
for (const rel of allow) {
  const src = resolve(repoRoot, rel);
  if (!existsSync(src)) { console.error(`MISSING allowlisted path: ${rel}`); process.exit(1); }
  const dest = join(outDir, rel);
  mkdirSync(resolve(dest, '..'), { recursive: true });
  cpSync(src, dest, { recursive: true });
  included.push(rel);
}

// 2. HARD-SCAN the assembled payload. Any hit ⇒ abort + wipe.
const hits = [];
for (const f of walk(outDir)) {
  const rel = relative(outDir, f);
  if (SECRET_NAME.test(rel)) { hits.push(`name:${rel}`); continue; }
  if (SCAN_TEXT_EXT.test(f) && statSync(f).size < 4 * 1024 * 1024) {
    const txt = readFileSync(f, 'utf8');
    for (const re of SECRET_CONTENT) if (re.test(txt)) { hits.push(`content:${rel} ~ ${re}`); break; }
  }
}
if (hits.length) {
  rmSync(outDir, { recursive: true, force: true });
  console.error(`SECRET TRIPWIRE — payload NOT created (wiped). Hits:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}

const fileCount = walk(outDir).length;
console.log(JSON.stringify({ mode, outDir, includedTopLevel: included, fileCount, secretScan: 'CLEAN' }, null, 2));
console.log(`OK — copy ONLY ${outDir} to the scorer box. Never rsync the repo root.`);
