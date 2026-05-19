import { createHash } from 'node:crypto';

export function deriveBaselineSampleSeed(baseSeedHex, sampleIndex, mode = 'fixed') {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(baseSeedHex))) {
    throw new Error(`baseline seed must be 0x + 32 bytes hex (got ${JSON.stringify(baseSeedHex)})`);
  }
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0) {
    throw new Error(`sampleIndex must be a non-negative integer (got ${sampleIndex})`);
  }
  if (mode === 'fixed') return baseSeedHex;
  if (mode === 'rotating') {
    return '0x' + createHash('sha256').update(`${baseSeedHex}:baseline-sample:${sampleIndex}`).digest('hex');
  }
  throw new Error(`sample seed mode must be 'fixed' or 'rotating' (got ${JSON.stringify(mode)})`);
}

export function summarizeBaselineComposites(composites) {
  if (!Array.isArray(composites) || composites.length === 0) {
    throw new Error('composites must contain at least one sample');
  }
  const mean = composites.reduce((s, x) => s + x, 0) / composites.length;
  const variance = composites.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, composites.length - 1);
  const stddev = Math.sqrt(variance);
  return {
    mean,
    stddev,
    baselineParentScorePpm: Math.round(mean * 1_000_000),
    stddevPpm: Math.round(stddev * 1_000_000),
  };
}
