/**
 * POST /v1/cortex/submit — LEGACY interactive screener.
 *
 * STATUS: deprecated for sealed launch (Phase S0 of
 * docs/CORETEX_SEALED_EPOCH_EVAL_HARDENING_PLAN.md).
 *
 * This route signs a screener receipt synchronously off a single
 * patch submission — the pre-sealed-eval flow. In sealed launch the
 * miner-facing path is commit → reveal → admission-screen and
 * screener credit is awarded only after post-commit admission. The
 * cortex package exposes the canonical commit/reveal primitives via
 * `@botcoin/cortex` (sealed-eval module) and the four new
 * /coretex/commit, /coretex/reveal, /coretex/commit/:hash,
 * /coretex/epoch/:epochId/status route handlers.
 *
 * Production hosts must set CORETEX_LEGACY_SUBMIT_ENABLED=1 to keep
 * this route mounted. Default (env unset, or any value other than
 * `1`) refuses the route at request time with 410 Gone so a stale
 * deployment cannot accidentally accept screener submissions over the
 * active sealed-eval hidden pack. Local dev / staging that wants the
 * old interactive flow can opt in explicitly.
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
 * 5. On qualified screener pass: request a signed V4 work receipt from SWCP
 *    via /internal/sign-coretex-work-receipt. Production default:
 *      lane = 2 (CoreTex)
 *      outcome = 1 (screener pass)
 *      workUnitsBps = 10000 (1x current tier credits)
 *      workPolicyHash = coreTexWorkPolicyHash(DEFAULT_CORETEX_WORK_POLICY)
 * 6. Clear outstanding challenge.
 * 7. Return receipt to miner.
 *
 * Storage:
 *   - Every submission lands in cortex SQLite queue (data/cortex/queue.db).
 *   - Dataset writes go to dataset/v2/cortex/epoch/{N}/ — NEVER to dataset/v2/swcp/*.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PATCH_TYPE,
  keccak256,
  bytesToHex,
  hexToBytes,
  deriveWorldSeedU128,
  DEFAULT_CORETEX_WORK_POLICY,
  LANE_CORETEX,
  OUTCOME_CORETEX_SCREENER_PASS,
  computeCoreTexWorkUnitsBps,
  coreTexWorkPolicyHash,
  evaluateCoreTexWorkQualification,
} from '@botcoin/cortex';
import type { CortexDb } from '../queue/sqlite.js';
import {
  getRateLimitBudget,
  signCortexReceipt,
  signCoreTexWorkReceipt,
  getEpochState,
  getMinerReceiptChain,
  clearOutstandingChallenge,
  type SignCortexReceiptRequest,
  type SignCoreTexWorkReceiptRequest,
} from '../internal-rpc-client.js';
import { getPool } from '../workers/eval-pool.js';
import fs from 'node:fs';
import path from 'node:path';

/** rulesVersion for Cortex receipts (§6) */
const CORTEX_RULES_VERSION = 0xC0; // 192
const CORTEX_RECEIPT_MODE = process.env['CORTEX_RECEIPT_MODE'] ?? 'v4';
const DEFAULT_WORK_POLICY_HASH = coreTexWorkPolicyHash(DEFAULT_CORETEX_WORK_POLICY);

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

function isHexBytes(value: string, bytes: number): boolean {
  return new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value);
}

function normalizeHex(value: string): string {
  return value.startsWith('0x') ? value.toLowerCase() : `0x${value.toLowerCase()}`;
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
  if (patch.newWords.length !== wordCount) {
    throw new RangeError(`targetIndices/newWords length mismatch: ${wordCount} vs ${patch.newWords.length}`);
  }

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
  if (!isHexBytes(normalizeHex(patch.parentStateRoot), 32)) {
    throw new RangeError('parentStateRoot must be 32 bytes (0x + 64 hex chars)');
  }
  const psr = normalizeHex(patch.parentStateRoot).slice(2);
  for (let i = 0; i < 64; i += 2) parts.push(parseInt(psr.slice(i, i + 2), 16));

  for (let i = 0; i < wordCount; i++) {
    const idx = patch.targetIndices[i]!;
    if (!Number.isSafeInteger(idx) || idx < 0) {
      throw new RangeError(`targetIndices[${i}] must be a non-negative safe integer`);
    }
    // LEB128 encode index
    let n = idx;
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n !== 0) b |= 0x80;
      parts.push(b);
    } while (n !== 0);

    const word = normalizeHex(patch.newWords[i]!);
    if (!isHexBytes(word, 32)) throw new RangeError(`newWords[${i}] must be 32 bytes`);
    const wh = word.slice(2);
    for (let j = 0; j < 64; j += 2) parts.push(parseInt(wh.slice(j, j + 2), 16));
  }

  return Buffer.from(parts).toString('hex');
}

/** Canonical Keccak-256 — replaces the SHA-256 placeholder. */
function keccak256Hex(data: Uint8Array | string): string {
  const buf = typeof data === 'string'
    ? hexToBytes(data.startsWith('0x') ? data : '0x' + data)
    : data;
  return bytesToHex(keccak256(buf)).slice(2); // 0x stripped for caller-side concat
}

/**
 * Canonical worldSeed (Steps 4 + 6): same Keccak-256 ABI-packed formula as
 * deriveShardIdU128 in @botcoin/cortex. Uses the active epoch SECRET (NOT the
 * public hiddenSeedCommit) — the SWCP coordinator hands it to cortex-server
 * over the trusted internal RPC. Returns 0x + 32 hex chars (16 bytes / uint128).
 */
function deriveWorldSeed(
  epochSecretHex: string,
  miner: string,
  solveIndex: number,
  parentStateRoot: string,
  epochId: number,
): string {
  const epochSecret = hexToBytes(
    epochSecretHex.startsWith('0x') ? epochSecretHex : '0x' + epochSecretHex,
  );
  const psr = hexToBytes(
    parentStateRoot.startsWith('0x') ? parentStateRoot : '0x' + parentStateRoot,
  );
  const u128 = deriveWorldSeedU128({
    epochSecret,
    miner,
    epochId: BigInt(epochId),
    solveIndex: BigInt(solveIndex),
    parentStateRoot: psr,
  });
  return '0x' + u128.toString(16).padStart(32, '0');
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

function localModelDeltaPpm(report: { localModel?: unknown }): number {
  const local = report.localModel;
  if (typeof local === 'object' && local !== null && 'scoreDelta' in local) {
    const value = Number((local as { scoreDelta?: unknown }).scoreDelta);
    if (Number.isSafeInteger(value)) return value;
  }
  return 0;
}

function nonNegativeSafeIntFromEnv(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

const RECENT_SCREENER_NOISE_FLOOR_PPM = nonNegativeSafeIntFromEnv('CORTEX_SCREENER_NOISE_FLOOR_PPM');

/**
 * Sealed-launch refusal flag. The legacy route is OFF by default; hosts
 * that intentionally want the pre-sealed-eval interactive screener
 * (local dev, staging clusters without an active hidden pack) opt in
 * by setting CORETEX_LEGACY_SUBMIT_ENABLED=1. The flag is read at
 * request time, not module load time, so toggling the env on a live
 * service has the expected effect without a restart.
 */
function legacySubmitEnabled(): boolean {
  return process.env.CORETEX_LEGACY_SUBMIT_ENABLED === '1';
}

export function handleSubmit(db: CortexDb) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      if (!legacySubmitEnabled()) {
        res.writeHead(410, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'coretex-legacy-submit-disabled',
          hint: 'use POST /coretex/commit + POST /coretex/reveal (sealed-eval); ' +
                'set CORETEX_LEGACY_SUBMIT_ENABLED=1 to re-enable the legacy interactive screener',
        }));
        return;
      }
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
      const parentStateRoot = normalizeHex(String(challenge['parentStateRoot'] ?? ''));
      const experienceCorpusRoot = normalizeHex(String(challenge['experienceCorpusRoot'] ?? ''));
      const coreVersionHash = normalizeHex(String(challenge['coreVersionHash'] ?? ''));
      const shardId = normalizeHex(String(challenge['shardId'] ?? ''));
      const solveIndex = Number(challenge['solveIndex'] ?? -1);
      const prevReceiptHash = normalizeHex(String(challenge['prevReceiptHash'] ?? ''));

      if (!Number.isSafeInteger(epoch) || epoch <= 0 || !Number.isSafeInteger(solveIndex) || solveIndex < 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid-challenge', detail: 'epoch must be positive and solveIndex must be a non-negative safe integer' }));
        return;
      }
      if (!isHexBytes(parentStateRoot, 32) || !isHexBytes(experienceCorpusRoot, 32) ||
          !isHexBytes(coreVersionHash, 32) || !isHexBytes(shardId, 16) || !isHexBytes(prevReceiptHash, 32)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid-challenge', detail: 'challenge roots/prevReceiptHash must be 32-byte hex and shardId must be 16-byte hex' }));
        return;
      }

      // Fetch epoch state from the SWCP coordinator at SUBMIT time.
      // The miner's posted challenge carries only public fields; the
      // canonical worldSeed must be derived from the active epoch SECRET
      // held by the coordinator, NOT the client-supplied hiddenSeedCommit.
      let epochStateAtSubmit;
      try {
        epochStateAtSubmit = await getEpochState();
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal-rpc-unavailable', detail: String(err) }));
        return;
      }
      if (!epochStateAtSubmit.epochSecret) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'epoch-secret-unavailable',
          message: 'SWCP /internal/epoch did not return epochSecret. Update SWCP coordinator.',
        }));
        return;
      }
      const hiddenSeedCommit = epochStateAtSubmit.hiddenSeedCommit;
      const epochSecret = epochStateAtSubmit.epochSecret;

      const outstanding = db.getOutstandingChallenge(miner);
      if (!outstanding) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'no-outstanding-cortex-challenge',
          message: 'Request /v1/cortex/challenge before submitting a Cortex patch.',
        }));
        return;
      }
      if (outstanding.epoch !== epoch ||
          normalizeHex(outstanding.shardId) !== shardId ||
          outstanding.solveIndex !== solveIndex ||
          normalizeHex(outstanding.prevReceiptHash) !== prevReceiptHash) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'challenge-mismatch',
          expected: {
            epoch: outstanding.epoch,
            shardId: normalizeHex(outstanding.shardId),
            solveIndex: outstanding.solveIndex,
            prevReceiptHash: normalizeHex(outstanding.prevReceiptHash),
          },
          got: { epoch, shardId, solveIndex, prevReceiptHash },
        }));
        return;
      }

      let receiptChainAtSubmit;
      try {
        receiptChainAtSubmit = await getMinerReceiptChain(miner);
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'receipt-chain-unavailable', detail: String(err) }));
        return;
      }
      if (receiptChainAtSubmit.solveIndex !== solveIndex ||
          normalizeHex(receiptChainAtSubmit.prevReceiptHash) !== prevReceiptHash) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'stale-receipt-chain',
          expected: {
            solveIndex: receiptChainAtSubmit.solveIndex,
            prevReceiptHash: normalizeHex(receiptChainAtSubmit.prevReceiptHash),
          },
          got: { solveIndex, prevReceiptHash },
        }));
        return;
      }

      if (epochStateAtSubmit.epochId !== epoch ||
          normalizeHex(epochStateAtSubmit.parentStateRoot) !== parentStateRoot ||
          normalizeHex(epochStateAtSubmit.experienceCorpusRoot) !== experienceCorpusRoot ||
          normalizeHex(epochStateAtSubmit.coreVersionHash) !== coreVersionHash) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'stale-or-forged-challenge',
          message: 'Challenge fields no longer match the active epoch state.',
        }));
        return;
      }

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
          parentStateRoot: normalizeHex(String(patchBody['parentStateRoot'] ?? '')),
          targetIndices: (patchBody['targetIndices'] as number[] | undefined) ?? [],
          newWords: (patchBody['newWords'] as string[] | undefined) ?? [],
          patchType: String(patchBody['patchType'] ?? 'KEY_UPDATE'),
          scoreDelta: String(patchBody['scoreDelta'] ?? '0'),
        };
        if (patchInput.parentStateRoot !== parentStateRoot) {
          throw new RangeError('patch.parentStateRoot must match challenge.parentStateRoot');
        }
        patchHex = buildPatchHex(patchInput);
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid-patch', detail: String(err) }));
        return;
      }

      const patchHash = '0x' + keccak256Hex(patchHex);

      // 3. Store submission as pending
      const submissionId = db.upsertSubmission({
        miner,
        epoch,
        solveIndex,
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

      // Production gate (Step 5): a stub-tagged report can never produce a
      // signed receipt unless the operator explicitly opted in via
      // CORTEX_ALLOW_STUB_EVAL=1. Defence-in-depth — pool construction also
      // refuses without the flag, so this is belt-and-suspenders.
      if (evalResult.report._stub && process.env['CORTEX_ALLOW_STUB_EVAL'] !== '1') {
        db.updateStatus(submissionId, 'screener_fail', { rejectCode: 'E_STUB_EVAL' });
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'stub-eval-disabled',
          message: 'cortex-server eval is the stub evaluator; production must wire a real eval. Set CORTEX_ALLOW_STUB_EVAL=1 for development only.',
        }));
        return;
      }

      db.updateStatus(submissionId, 'screener_pass');

      // 5. Derive worldSeed via canonical Keccak-256 path (Steps 4 + 6).
      const worldSeed = deriveWorldSeed(epochSecret, miner, solveIndex, parentStateRoot, epoch);

      // shardCommitment = keccak256(shardId ‖ parentStateRoot) using canonical Keccak.
      const shardCommitment = '0x' + keccak256Hex(
        shardId.replace(/^0x/, '') + parentStateRoot.replace(/^0x/, ''),
      );

      const workQualification = evaluateCoreTexWorkQualification({
        outcome: OUTCOME_CORETEX_SCREENER_PASS,
        deterministicDeltaPpm: evalResult.report.scoreDelta,
        baselineScorePpm: evalResult.report.baselineScore,
        recentNoiseFloorPpm: RECENT_SCREENER_NOISE_FLOOR_PPM,
        localModelDeltaPpm: localModelDeltaPpm(evalResult.report),
        parentMatchesLiveRoot: true,
      });
      if (!workQualification.qualified) {
        db.updateStatus(submissionId, 'screener_fail', { rejectCode: workQualification.reason });
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'work-qualification-fail',
          reason: workQualification.reason,
          requiredDeterministicDeltaPpm: workQualification.requiredDeterministicDeltaPpm.toString(),
          evalReport: evalResult.report,
          evalReportHash: evalResult.evalReportHash,
        }));
        return;
      }
      const screenerWorkUnitsBps = computeCoreTexWorkUnitsBps({
        outcome: OUTCOME_CORETEX_SCREENER_PASS,
      });

      const legacyReceiptRequest: SignCortexReceiptRequest = {
        miner,
        epochId: epoch,
        solveIndex,
        prevReceiptHash,
        challengeId: shardId,
        commit: hiddenSeedCommit,
        docHash: parentStateRoot,              // §6: docHash = parentStateRoot
        questionsHash: experienceCorpusRoot,   // §6: questionsHash = experienceCorpusRoot
        constraintsHash: shardCommitment,      // §6: constraintsHash = shardCommitment
        answersHash: patchHash,                // §6: answersHash = patchHash
        worldSeed,                             // §6: keccak(H_e ‖ miner ‖ solveIndex ‖ parentStateRoot)
        rulesVersion: CORTEX_RULES_VERSION,    // §6: 0xC0
      };

      const workReceiptRequest: SignCoreTexWorkReceiptRequest = {
        miner,
        epochId: epoch,
        solveIndex,
        prevReceiptHash,
        lane: LANE_CORETEX,
        outcome: OUTCOME_CORETEX_SCREENER_PASS,
        challengeId: shardId,
        parentStateRoot,
        artifactHash: evalResult.evalReportHash,
        worldSeed,
        rulesVersion: CORTEX_RULES_VERSION,
        workPolicyHash: DEFAULT_WORK_POLICY_HASH,
        workUnitsBps: screenerWorkUnitsBps.toString(),
      };

      // 6. Request signature from SWCP (signing key NEVER held by cortex-server)
      let signedReceipt;
      try {
        signedReceipt = CORTEX_RECEIPT_MODE === 'v3'
          ? await signCortexReceipt(legacyReceiptRequest)
          : await signCoreTexWorkReceipt(workReceiptRequest);
      } catch (err) {
        db.updateStatus(submissionId, 'screener_pass', { rejectCode: 'E_SIGN_FAIL' });
        console.error('[submit] sign CoreTex receipt failed:', err);
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'signing-unavailable', detail: String(err) }));
        return;
      }

      const receiptJson = JSON.stringify(signedReceipt);
      db.updateStatus(submissionId, 'signed', { receiptJson });

      // 7. Clear outstanding challenge in both local Cortex queue and SWCP-side
      // cross-lane store. Remote clear failure is non-fatal after signing, but
      // it is surfaced so operators can repair stale outstanding records.
      db.clearOutstandingChallenge(miner);
      try {
        await clearOutstandingChallenge(miner);
      } catch (err) {
        console.error('[submit] internal-rpc outstanding-challenge/clear failed:', err);
      }

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
        receiptMode: CORTEX_RECEIPT_MODE,
        workPolicyHash: DEFAULT_WORK_POLICY_HASH,
        workUnitsBps: screenerWorkUnitsBps.toString(),
        requiredDeterministicDeltaPpm: workQualification.requiredDeterministicDeltaPpm.toString(),
        workOutcome: OUTCOME_CORETEX_SCREENER_PASS,
        signature: signedReceipt.signature,
        receipt: signedReceipt.receipt,
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
