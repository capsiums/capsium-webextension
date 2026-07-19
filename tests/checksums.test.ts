import { describe, expect, it } from 'vitest';
import { sha256Hex, verifyChecksums } from '../src/lib/checksums';
import { parseSecurity, ModelError } from '../src/lib/model';

describe('sha256Hex', () => {
  it('matches the well-known vector for "abc"', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('verifyChecksums', () => {
  const enc = new TextEncoder();

  it('passes when every file (except security.json) checks out', async () => {
    const files = new Map([
      ['a.txt', enc.encode('a')],
      ['security.json', enc.encode('{}')],
    ]);
    const checksums = { 'a.txt': await sha256Hex(enc.encode('a')) };
    await expect(verifyChecksums(files, checksums)).resolves.toEqual([]);
  });

  it('reports mismatches, missing checksums and unknown files', async () => {
    const files = new Map([
      ['ok.txt', enc.encode('ok')],
      ['bad.txt', enc.encode('tampered')],
      ['unchecked.txt', enc.encode('x')],
    ]);
    const checksums = {
      'ok.txt': await sha256Hex(enc.encode('ok')),
      'bad.txt': await sha256Hex(enc.encode('original')),
      'ghost.txt': await sha256Hex(enc.encode('ghost')),
    };
    const failures = await verifyChecksums(files, checksums);
    expect(failures).toEqual([
      { path: 'bad.txt', reason: 'mismatch' },
      { path: 'unchecked.txt', reason: 'missing-checksum' },
      { path: 'ghost.txt', reason: 'unknown-file' },
    ]);
  });
});

describe('parseSecurity', () => {
  it('parses the canonical form (§6)', () => {
    const parsed = parseSecurity({
      security: {
        integrityChecks: {
          checksumAlgorithm: 'SHA-256',
          checksums: { 'content/index.html': 'ab12cd' },
        },
      },
    });
    expect(parsed.security.integrityChecks.checksumAlgorithm).toBe('SHA-256');
  });

  it('rejects non-hex checksums', () => {
    expect(() =>
      parseSecurity({
        security: {
          integrityChecks: {
            checksumAlgorithm: 'SHA-256',
            checksums: { 'a.txt': 'not-hex!!' },
          },
        },
      }),
    ).toThrow(ModelError);
  });
});
