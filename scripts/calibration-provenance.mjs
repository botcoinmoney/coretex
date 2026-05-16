/**
 * Shared provenance stamper for calibration reports.
 *
 * Every calibration artifact must include a "provenance" block so a future
 * reader can reproduce (or refute) it: git SHA at time of run, hash of the
 * dist/ tree that ran, bundle hash + corpus root being evaluated, model
 * revision. If any of these drift between runs, the report is suspect.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

function safeExec(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

function hashDir(dir) {
  if (!existsSync(dir)) return null;
  const h = createHash('sha256');
  const walk = (d) => {
    const entries = readdirSync(d).sort();
    for (const name of entries) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) { h.update(`D:${name}\n`); walk(p); }
      else if (s.isFile()) {
        h.update(`F:${name}:${s.size}\n`);
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return '0x' + h.digest('hex');
}

export function buildProvenance(opts = {}) {
  const repoRoot = opts.repoRoot ?? '/root/cortex';
  const distRoot = opts.distRoot ?? '/root/cortex/packages/cortex/dist';
  return {
    capturedAt: new Date().toISOString(),
    gitSha: safeExec(`git -C ${repoRoot} rev-parse HEAD`),
    gitBranch: safeExec(`git -C ${repoRoot} rev-parse --abbrev-ref HEAD`),
    gitClean: safeExec(`git -C ${repoRoot} status --porcelain`) === '',
    distHash: hashDir(distRoot),
    nodeVersion: process.version,
    host: safeExec('hostname'),
  };
}
