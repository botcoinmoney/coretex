/**
 * Shared S3 GET-and-rehash verification helper.
 *
 * Head-object existence is NOT verification: after an `aws s3 cp` upload, the
 * production publish path fetches every uploaded artifact back over its PUBLIC
 * https URL — exactly the bytes a validator would later read — and rehashes
 * them (sha256) against the local file. Any mismatch is a hard failure before
 * any chain call. Both the coordinator epoch runner (the orchestrated, only
 * production publish path) and the direct dev/manual evolve script use this
 * single helper so they verify byte-identically.
 *
 * The helper throws on any failure; callers map the thrown error to their own
 * fail()/exit semantics.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

export function parseS3Uri(uri) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  return m ? { bucket: m[1], key: m[2] } : null;
}

/**
 * Resolve an s3://bucket/key URI to a public https URL.
 *
 * If `manifest.s3` pins a `publicBaseUrl` for the bucket+prefix, that exact
 * base is used (the validator-facing CDN/base); otherwise the virtual-hosted
 * regional S3 endpoint is derived. `region` falls back to AWS_REGION /
 * AWS_DEFAULT_REGION / us-east-2.
 */
export function s3UriToHttps(uri, { manifest = null, region, env = process.env } = {}) {
  const parsed = parseS3Uri(uri);
  if (!parsed) return uri;
  const s3 = manifest?.s3 ?? {};
  if (s3.bucket === parsed.bucket && s3.prefix && parsed.key.startsWith(`${s3.prefix}/`) && s3.publicBaseUrl) {
    return `${s3.publicBaseUrl.replace(/\/+$/, '')}/${parsed.key.slice(s3.prefix.length + 1)}`;
  }
  const reg = region ?? s3.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-2';
  return `https://${parsed.bucket}.s3.${reg}.amazonaws.com/${parsed.key}`;
}

export function downloadBytes(url, redirects = 0) {
  return new Promise((resolveDone, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume();
        if (!res.headers.location || redirects >= 5) return reject(new Error(`redirect failed for ${url}`));
        return resolveDone(downloadBytes(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolveDone(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

/**
 * Fetch the uploaded artifact back over its public url and rehash the bytes
 * against the local file. Throws on download failure or sha256 mismatch.
 */
export async function verifyS3GetRehash(localPath, s3Uri, opts = {}) {
  const url = s3UriToHttps(s3Uri, opts);
  let remote;
  try {
    remote = await downloadBytes(url);
  } catch (e) {
    throw new Error(`S3 GET-rehash verification failed for ${url}: ${e?.message ?? e}`);
  }
  const remoteSha = createHash('sha256').update(remote).digest('hex');
  const localSha = createHash('sha256').update(readFileSync(localPath)).digest('hex');
  if (remoteSha !== localSha) {
    throw new Error(`S3 GET-rehash mismatch for ${s3Uri}: remote sha256 ${remoteSha} != local ${localSha}`);
  }
}
