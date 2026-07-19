/**
 * htpasswd verification (§4b basicAuth) — pure-TS, isomorphic. Ported from
 * capsium-js swsws (auth/htpasswd.ts).
 *
 * SUPPORTED HASH TYPES: bcrypt (`$2a$`/`$2b$`/`$2y$`, via bcryptjs) and
 * Apache apr1-MD5 (`$apr1$`, via the bundled RFC 1321 MD5). Plaintext,
 * crypt(3) DES and SHA-crypt entries are NOT supported and reported as
 * `unsupported-hash`.
 */
import bcrypt from 'bcryptjs';
import { md5 } from './md5';

const APR1_MAGIC = '$apr1$';
const TO64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function to64(value: number, length: number): string {
  let out = '';
  let v = value >>> 0;
  for (let i = 0; i < length; i += 1) {
    out += TO64[v & 0x3f];
    v >>>= 6;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Apache apr1-MD5 hash of `password` with the given (max 8-char) salt. */
export function apr1(password: string, salt: string): string {
  const encoder = new TextEncoder();
  const pw = encoder.encode(password);
  const saltClean = salt.startsWith(APR1_MAGIC) ? salt.slice(APR1_MAGIC.length) : salt;
  const saltFinal = saltClean.split('$')[0]?.slice(0, 8) ?? '';
  const saltBytes = encoder.encode(saltFinal);

  let digest = md5(concat(pw, saltBytes, pw));
  let ctx = concat(pw, encoder.encode(APR1_MAGIC), saltBytes);
  for (let length = pw.byteLength; length > 0; length -= 16) {
    ctx = concat(ctx, digest.subarray(0, Math.min(length, 16)));
  }
  for (let i = pw.byteLength; i > 0; i >>= 1) {
    ctx = concat(ctx, (i & 1) === 1 ? new Uint8Array([0]) : pw.subarray(0, 1));
  }
  digest = md5(ctx);

  for (let i = 0; i < 1000; i += 1) {
    let round: Uint8Array = (i & 1) === 1 ? pw : digest;
    if (i % 3 !== 0) {
      round = concat(round, saltBytes);
    }
    if (i % 7 !== 0) {
      round = concat(round, pw);
    }
    round = concat(round, (i & 1) === 1 ? digest : pw);
    digest = md5(round);
  }

  const encoded =
    to64(((digest[0] ?? 0) << 16) | ((digest[6] ?? 0) << 8) | (digest[12] ?? 0), 4) +
    to64(((digest[1] ?? 0) << 16) | ((digest[7] ?? 0) << 8) | (digest[13] ?? 0), 4) +
    to64(((digest[2] ?? 0) << 16) | ((digest[8] ?? 0) << 8) | (digest[14] ?? 0), 4) +
    to64(((digest[3] ?? 0) << 16) | ((digest[9] ?? 0) << 8) | (digest[15] ?? 0), 4) +
    to64(((digest[4] ?? 0) << 16) | ((digest[10] ?? 0) << 8) | (digest[5] ?? 0), 4) +
    to64(digest[11] ?? 0, 2);
  return `${APR1_MAGIC}${saltFinal}$${encoded}`;
}

export type HtpasswdVerification =
  | { readonly kind: 'ok' }
  | { readonly kind: 'bad-credentials' }
  | { readonly kind: 'unknown-user' }
  | { readonly kind: 'unsupported-hash'; readonly hashType: string };

/** Detected hash type label of an htpasswd entry. */
export function htpasswdHashType(hash: string): string {
  if (hash.startsWith(APR1_MAGIC)) {
    return 'apr1';
  }
  if (/^\$2[abxy]\$/.test(hash)) {
    return 'bcrypt';
  }
  if (hash.startsWith('$5$') || hash.startsWith('$6$')) {
    return 'sha-crypt';
  }
  return 'unknown';
}

/**
 * Verify `user`/`password` against htpasswd file content
 * (`user:hash` lines; blank lines and `#` comments ignored).
 */
export async function verifyHtpasswd(
  htpasswd: string,
  user: string,
  password: string,
): Promise<HtpasswdVerification> {
  for (const line of htpasswd.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon === -1 || trimmed.slice(0, colon) !== user) {
      continue;
    }
    const hash = trimmed.slice(colon + 1);
    const hashType = htpasswdHashType(hash);
    switch (hashType) {
      case 'apr1': {
        const salt = hash.slice(APR1_MAGIC.length, APR1_MAGIC.length + 8);
        return apr1(password, salt) === hash
          ? { kind: 'ok' }
          : { kind: 'bad-credentials' };
      }
      case 'bcrypt': {
        return (await bcrypt.compare(password, hash))
          ? { kind: 'ok' }
          : { kind: 'bad-credentials' };
      }
      default:
        return { kind: 'unsupported-hash', hashType };
    }
  }
  return { kind: 'unknown-user' };
}
