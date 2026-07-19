/**
 * SHA-256 integrity verification (ARCHITECTURE.md §6) via WebCrypto
 * (crypto.subtle — available in service workers and Node >= 20).
 */

import { SIGNATURE_FILE } from './signatures';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface ChecksumFailure {
  path: string;
  reason: 'missing-checksum' | 'mismatch' | 'unknown-file';
}

/**
 * Verify that every file (except security.json itself and signature.sig —
 * the signature can never be checksum-covered, §6a) has a checksum and
 * that all checksums match. Returns the list of failures; empty = valid.
 */
export async function verifyChecksums(
  files: Map<string, Uint8Array>,
  checksums: Record<string, string>,
): Promise<ChecksumFailure[]> {
  const failures: ChecksumFailure[] = [];

  for (const [path, bytes] of [...files.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (path === 'security.json' || path === SIGNATURE_FILE) continue;
    const expected = checksums[path];
    if (expected === undefined) {
      failures.push({ path, reason: 'missing-checksum' });
      continue;
    }
    const actual = await sha256Hex(bytes);
    if (actual !== expected.toLowerCase()) {
      failures.push({ path, reason: 'mismatch' });
    }
  }

  for (const path of Object.keys(checksums)) {
    if (!files.has(path)) failures.push({ path, reason: 'unknown-file' });
  }

  return failures;
}
