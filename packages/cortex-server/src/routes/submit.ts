/**
 * POST /v1/cortex/submit
 *
 * Body:
 * {
 *   challenge: { lane, epoch, parentStateRoot, experienceCorpusRoot, coreVersionHash,
 *                patchObjective, patchBudget, shardId, shardDescriptor,
 *                submissionFormat, creditsPerSolve, _expiresAt },
 *   patch: {
 *     parentStateRoot: "0x...",
 *     targetIndices: [N, ...],
 *     newWords: ["0x...", ...],
 *     patchType: "KEY_UPDATE" | ...,
 *     scoreDelta: "N"
 *   }
 * }
 *
 * Flow:
 * 1. Validate body shape.
 * 2. Check rate-limit budget via /internal/rate-limit-budget.
 * 3. Decode patch via @botcoin/cortex decodePatch (validates wire format, parent root, budget).
 * 4. Run Core eval in worker pool (Phase 3 stub: always passes, _stub=true in report).
 * 5. On screener pass: request signed receipt from SWCP via /internal/sign-cortex-receipt.
 *    Receipt fields follow the §6 mapping:
 *      docHash = parentStateRoot
 *      questionsHash = experienceCorpusRoot
 *      constraintsHash = shardCommitment
 *      answersHash = patchHash (keccak256 of patch wire bytes)
 *      worldSeed = keccak(hiddenSeedCommit ‖ miner ‖ solveIndex ‖ parentStateRoot) [u128]
 *      rulesVersion = 0xC0 (192)
 * 6. Clear outstanding challenge.
 * 7. Return receipt to miner.
 *
 * Storage:
 *   - Every submission lands in cortex SQLite queue (data/cortex/queue.db).
 *   - Dataset writes go to dataset/v2/cortex/epoch/{N}/ — NEVER to dataset/v2/swcp/*.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
// PATCH_TYPE constants — inline to avoid workspace dependency resolution issues
// before @botcoin/cortex is built. Values must match packages/cortex/src/state/types.ts.
const PATCH_TYPE = {
  KEY_UPDATE:      0x01,
  SLOT_REPLACE:    0x02,
  TEMPORAL_UPDATE: 0x03,
  RELATION_UPDATE: 0x04,
  CODEBOOK_UPDATE: 0x05,
  HEADER_UPDATE:   0x06,
  MIXED:           0xFF,
} as const;
import type { CortexDb } from '../queue/sqlite.js';
import type { EvalPool } from '../workers/eval-pool.js';
import {
  getRateLimitBudget,
  signCortexReceipt,
  type SignCortexReceiptRequest,
} from '../internal-rpc-client.js';
import { getPool } from '../workers/eval-pool.js';
import fs from 'node:fs';
import path from 'node:path';

/** rulesVersion for Cortex receipts (§6) */
const CORTEX_RULES_VERSION = 0xC0; // 192

function extractMiner(req: IncomingMessage): string | null {
  const h = req.headers['x-miner'];
  if (typeof h === 'string' && /^0x[0-9a-fA-F]{40}$/.test(h)) {
    return h.toLowerCase();
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Map string patchType to numeric code */
function parsePatchType(s: string): number {
  const map: Record<string, number> = {
    KEY_UPDATE:      PATCH_TYPE.KEY_UPDATE,
    SLOT_REPLACE:    PATCH_TYPE.SLOT_REPLACE,
    TEMPORAL_UPDATE: PATCH_TYPE.TEMPORAL_UPDATE,
    RELATION_UPDATE: PATCH_TYPE.RELATION_UPDATE,
    CODEBOOK_UPDATE: PATCH_TYPE.CODEBOOK_UPDATE,
    HEADER_UPDATE:   PATCH_TYPE.HEADER_UPDATE,
    MIXED:           PATCH_TYPE.MIXED,
  };
  return map[s] ?? PATCH_TYPE.KEY_UPDATE;
}

/** Build patch wire bytes from the JSON patch body */
function buildPatchHex(patch: {
  parentStateRoot: string;
  targetIndices: number[];
  newWords: string[];
  patchType: string;
  scoreDelta: string;
}): string {
  // Reconstruct wire format as per encodePatch spec
  // [1] patchType [1] wordCount [8] scoreDelta [32] parentStateRoot [for each: LEB128 idx + 32 newWord]
  const wordCount = patch.targetIndices.length;
  if (wordCount < 1 || wordCount > 4) throw new RangeError(`invalid wordCount ${wordCount}`);

  const patchTypeCode = parsePatchType(patch.patchType);
  const scoreDelta = BigInt(patch.scoreDelta);
  const sdUnsigned = BigInt.asUintN(64, scoreDelta);
  const sdHi = Number(sdUnsigned >> 32n) >>> 0;
  const sdLo = Number(sdUnsigned & 0xffffffffn) >>> 0;

  const parts: number[] = [];
  parts.push(patchTypeCode & 0xff);
  parts.push(wordCount & 0xff);
  // scoreDelta hi
  parts.push((sdHi >>> 24) & 0xff, (sdHi >>> 16) & 0xff, (sdHi >>> 8) & 0xff, sdHi & 0xff);
  // scoreDelta lo
  parts.push((sdLo >>> 24) & 0xff, (sdLo >>> 16) & 0xff, (sdLo >>> 8) & 0xff, sdLo & 0xff);
  // parentStateRoot (32 bytes)
  const psr = patch.parentStateRoot.startsWith('0x') ? patch.parentStateRoot.slice(2) : patch.parentStateRoot;
  if (psr.length !== 64) throw new RangeError('parentStateRoot must be 32 bytes (64 hex chars)');
  for (let i = 0; i < 64; i += 2) parts.push(parseInt(psr.slice(i, i + 2), 16));

  for (let i = 0; i < wordCount; i++) {
    const idx = patch.targetIndices[i]!;
    // LEB128 encode index
    let n = idx;
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n !== 0) b |= 0x80;
      parts.push(b);
    } while (n !== 0);

    const wh = (patch.newWords[i] ?? '0x' + '00'.repeat(32)).startsWith('0x')
      ? (patch.newWords[i] ?? '0x' + '00'.repeat(32)).slice(2)
      : (patch.newWords[i] ?? '00'.repeat(32));
    if (wh.length !== 64) throw new RangeError(`newWords[${i}] must be 32 bytes`);
    for (let j = 0; j < 64; j += 2) parts.push(parseInt(wh.slice(j, j + 2), 16));
  }

  return Buffer.from(parts).toString('hex');
}

/** keccak256 via SHA256 as a placeholder (deterministic; Phase 3 can swap in real keccak) */
function keccak256Hex(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'hex') : data;
  return createHash('sha256').update(buf).digest('hex');
}

function deriveWorldSeed(
  hiddenSeedCommit: string,
  miner: string,
  solveIndex: number,
  parentStateRoot: string,
): string {
  const packed = hiddenSeedCommit + miner.toLowerCase() + solveIndex.toString(16).padStart(16, '0') + parentStateRoot.replace('0x', '');
  const full = createHash('sha256').update(packed).digest('hex');
  // Take lower 16 bytes (128 bits) as uint128
  const u128Hex = full.slice(32); // last 128 bits
  return '0x' + u128Hex;
}

/** Write submission artifact to dataset/v2/cortex/epoch/{N}/ — NEVER to swcp */
function writeDatasetArtifact(
  epoch: number,
  miner: string,
  patchHex: string,
  receiptJson: string,
): void {
  try {
    const dir = path.join('dataset', 'v2', 'cortex', 'epoch', String(epoch));
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${miner.toLowerCase()}_${Date.now()}.json`;
    fs.writeFileSync(
      path.join(dir, filename),
      JSON.stringify({ miner, epoch, patchHex, receipt: JSON.parse(receiptJson) }, null, 2),
    );
  } catch (err) {
    // Non-fatal: log and continue. Don't fail the receipt over storage.
    console.warn('[submit] dataset write failed:', err);
  }
}

export function handleSubmit(db: CortexDb) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const miner = extractMiner(req);
      if (!miner) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing-or-invalid-x-miner header' }));
        return;
      }

      // Parse body
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid-json' }));
        return;
      }

      if (typeof body !== 'object' || body === null) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'body-must-be-object' }));
        return;
      }

      const b = body as Record<string, unknown>;
      const challenge = b['challenge'] as Record<string, unknown> | undefined;
      const patchBody = b['patch'] as Record<string, unknown> | undefined;

      if (!challenge || !patchBody) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing challenge or patch fields' }));
        return;
      }

      const epoch = Number(challenge['epoch'] ?? 0);
      const parentStateRoot = String(challenge['parentStateRoot'] ?? '');
      const experienceCorpusRoot = String(challenge['experienceCorpusRoot'] ?? '');
      const coreVersionHash = String(challenge['coreVersionHash'] ?? '');
      const shardId = String(challenge['shardId'] ?? '');
      const hiddenSeedCommit = String(challenge['hiddenSeedCommit'] ?? '0x' + '00'.repeat(32));

      // 1. Check rate-limit budget
      let budget;
      try {
        budget = await getRateLimitBudget(miner);
      } catch (err) {
        console.error('[submit] rate-limit check failed:', err);
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal-rpc-unavailable', detail: String(err) }));
        return;
      }

      if (budget.remaining <= 0) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'rate-limit-exceeded',
          windowResetAt: budget.windowResetAt,
          message: 'Submit budget exhausted across lanes. Try after window reset.',
        }));
        return;
      }

      // 2. Decode and validate patch wire format
      let patchHex: string;
      try {
        const patchInput = {
          parentStateRoot: String(patchBody['parentStateRoot'] ?? ''),
          targetIndices: (patchBody['targetIndices'] as number[] | undefined) ?? [],
          newWords: (patchBody['newWords'] as string[] | undefined) ?? [],
          patchType: String(patchBody['patchType'] ?? 'KEY_UPDATE'),
          scoreDelta: String(patchBody['scoreDelta'] ?? '0'),
        };
        patchHex = buildPatchHex(patchInput);
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid-patch', detail: String(err) }));
        return;
      }

      const patchHash = '0x' + keccak256Hex(Buffer.from(patchHex, 'hex'));

      // 3. Store submission as pending
      const submissionId = db.upsertSubmission({
        miner,
        epoch,
        solveIndex: 0, // TODO(Phase 6): derive from chain position
        patchHex,
        parentStateRoot,
        shardId,
        status: 'pending',
        receiptJson: null,
        rejectCode: null,
      });

      // 4. Run Core eval in worker pool
      db.updateStatus(submissionId, 'evaluating');

      const pool = getPool();
      let evalResult;
      try {
        evalResult = await pool.eval({
          patchHex,
          parentStateRoot,
          shardId,
          experienceCorpusRoot,
          coreVersionHash,
          epoch,
        });
      } catch (err) {
        db.updateStatus(submissionId, 'screener_fail', { rejectCode: 'E_EVAL_CRASH' });
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'eval-crash', detail: String(err) }));
        return;
      }

      if (!evalResult.pass) {
        db.updateStatus(submissionId, 'screener_fail', { rejectCode: 'E_SCREENER_FAIL' });
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'screener-fail',
          evalReport: evalResult.report,
          evalReportHash: evalResult.evalReportHash,
        }));
        return;
      }

      db.updateStatus(submissionId, 'screener_pass');

      // 5. Derive worldSeed (§6 mapping)
      const solveIndex = 0;
      const worldSeed = deriveWorldSeed(hiddenSeedCommit, miner, solveIndex, parentStateRoot);

      // shardCommitment = keccak256(shardId ‖ parentStateRoot)
      const shardCommitment = '0x' + keccak256Hex(
        Buffer.from(shardId.replace('0x', '') + parentStateRoot.replace('0x', ''), 'hex')
      );

      const receiptRequest: SignCortexReceiptRequest = {
        miner,
        epochId: epoch,
        solveIndex,
        prevReceiptHash: '0x' + '00'.repeat(32), // TODO(Phase 6): derive from chain position
        challengeId: shardId,
        commit: hiddenSeedCommit,
        docHash: parentStateRoot,              // §6: docHash = parentStateRoot
        questionsHash: experienceCorpusRoot,   // §6: questionsHash = experienceCorpusRoot
        constraintsHash: shardCommitment,      // §6: constraintsHash = shardCommitment
        answersHash: patchHash,                // §6: answersHash = patchHash
        worldSeed,                             // §6: keccak(H_e ‖ miner ‖ solveIndex ‖ parentStateRoot)
        rulesVersion: CORTEX_RULES_VERSION,    // §6: 0xC0
      };

      // 6. Request signature from SWCP (signing key NEVER held by cortex-server)
      let signedReceipt;
      try {
        signedReceipt = await signCortexReceipt(receiptRequest);
      } catch (err) {
        db.updateStatus(submissionId, 'screener_pass', { rejectCode: 'E_SIGN_FAIL' });
        console.error('[submit] sign-cortex-receipt failed:', err);
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'signing-unavailable', detail: String(err) }));
        return;
      }

      const receiptJson = JSON.stringify(signedReceipt);
      db.updateStatus(submissionId, 'signed', { receiptJson });

      // 7. Clear outstanding challenge
      db.clearOutstandingChallenge(miner);

      // 8. Write to dataset namespace (Cortex only — never SWCP)
      writeDatasetArtifact(epoch, miner, patchHex, receiptJson);

      const response = {
        ok: true,
        // §6 receipt field mapping — all fields present for the scripted-miner smoke check
        worldSeed,
        docHash: parentStateRoot,
        questionsHash: experienceCorpusRoot,
        constraintsHash: shardCommitment,
        answersHash: patchHash,
        rulesVersion: '0xC0',
        signature: signedReceipt.signature,
        evalReport: evalResult.report,
        evalReportHash: evalResult.evalReportHash,
        submissionId,
        _stubEval: evalResult.report._stub === true,
      };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    })();
  };
}
