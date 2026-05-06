/**
 * GET /v1/cortex/merge-bonus/claim-calldata?epochs=812,813,...
 *
 * Returns pre-encoded calldata for CortexMergeBonus.claimMergeBonus(uint64[]).
 * Mirrors the existing BonusEpoch UX so miners can claim with the same pattern
 * they use for SWCP bonus epochs.
 *
 * ABI: claimMergeBonus(uint64[] epochIds)
 *   selector: keccak256("claimMergeBonus(uint64[])") → first 4 bytes
 *   encoding: standard ABI (offset, length, values...)
 *
 * For pool contracts: also accepts ?pool=0x... for triggerMergeBonusClaim(uint64[])
 *   selector: keccak256("triggerMergeBonusClaim(uint64[])") → first 4 bytes
 *
 * V0 production uses state-advance credits through the normal receipt path.
 * This endpoint remains for legacy funded bonus epochs and deployment
 * compatibility only.
 *
 * The miner identity comes from x-miner header (same as all other endpoints).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { keccak256 } from '@botcoin/cortex';

/** 4-byte keccak256 selector from function signature */
function selector(sig: string): Buffer {
  return Buffer.from(keccak256(new TextEncoder().encode(sig)).slice(0, 4));
}

/**
 * ABI-encode (uint64[] epochs) — standard ABI encoding:
 * [4 bytes selector][32 bytes offset = 0x20][32 bytes length][N * 32 bytes values]
 */
function encodeClaimCalldata(fnSelector: Buffer, epochIds: bigint[]): string {
  const offset = Buffer.alloc(32);
  offset.writeBigUInt64BE(0x20n, 24);

  const lengthWord = Buffer.alloc(32);
  lengthWord.writeBigUInt64BE(BigInt(epochIds.length), 24);

  const valueWords = epochIds.map((e) => {
    const w = Buffer.alloc(32);
    w.writeBigUInt64BE(e, 24);
    return w;
  });

  return '0x' + Buffer.concat([fnSelector, offset, lengthWord, ...valueWords]).toString('hex');
}

export function handleMergeBonus() {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const epochsParam = url.searchParams.get('epochs') ?? '';
      const poolAddress = url.searchParams.get('pool') ?? null;

      const miner = req.headers['x-miner'];
      if (!miner || typeof miner !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(miner)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing-or-invalid-x-miner header' }));
        return;
      }

      if (!epochsParam) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'epochs query param required (comma-separated epoch ids)' }));
        return;
      }

      let epochIds: bigint[];
      try {
        epochIds = epochsParam.split(',').map((s) => {
          const n = BigInt(s.trim());
          if (n < 0n) throw new RangeError('epoch id must be non-negative');
          return n;
        });
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid epochs', detail: String(err) }));
        return;
      }

      if (epochIds.length === 0 || epochIds.length > 100) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'epochs must have 1–100 entries' }));
        return;
      }

      const fnSig = poolAddress
        ? 'triggerMergeBonusClaim(uint64[])'
        : 'claimMergeBonus(uint64[])';

      const fnSelector = selector(fnSig);
      const calldata = encodeClaimCalldata(fnSelector, epochIds);

      const body: Record<string, unknown> = {
        miner,
        epochs: epochIds.map(String),
        calldata,
        target: process.env['CORTEX_MERGE_BONUS_ADDRESS'] ?? null,
        fnSignature: fnSig,
        _note: 'legacy no-uplift bonus rail; V0 production credits settle through state advances',
      };
      if (poolAddress) {
        body['pool'] = poolAddress;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    })();
  };
}
