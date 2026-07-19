import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  buildSignedPayload,
  pemToDer,
  verifyPackageSignature,
  SIGNATURE_FILE,
} from '../src/lib/signatures';
import { PackageLoader, PackageError } from '../src/lib/package-loader';
import { parseSecurity } from '../src/lib/model';
import { generatedFixtureBytes } from './helpers/fixtures';
import { SIGNED_CAP, BADSIG_CAP } from './fixtures/global-setup';

const enc = new TextEncoder();

function rsaKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

function makeSecurity(
  checksums: Record<string, string>,
  withSignatures = true,
) {
  return parseSecurity({
    security: {
      integrityChecks: { checksumAlgorithm: 'SHA-256', checksums },
      ...(withSignatures
        ? {
            digitalSignatures: {
              publicKey: 'keys/public.pem',
              signatureFile: SIGNATURE_FILE,
            },
          }
        : {}),
    },
  });
}

describe('buildSignedPayload (§6a)', () => {
  it('concatenates the bytes of checksummed files in sorted key order', () => {
    const files = new Map([
      ['b.txt', enc.encode('BBB')],
      ['a.txt', enc.encode('A')],
      ['uncovered.txt', enc.encode('IGNORED')],
    ]);
    const payload = buildSignedPayload(files, {
      'b.txt': 'x',
      'a.txt': 'y',
    });
    expect(new TextDecoder().decode(payload)).toBe('ABBB');
  });

  it('rejects when a checksummed file is missing', () => {
    expect(() => buildSignedPayload(new Map(), { 'ghost.txt': 'x' })).toThrow(
      /covered by checksums but missing/,
    );
  });
});

describe('pemToDer', () => {
  it('strips the PEM armor', () => {
    const der = pemToDer(
      '-----BEGIN PUBLIC KEY-----\nQUJD\n-----END PUBLIC KEY-----\n',
      'PUBLIC KEY',
    );
    expect(new TextDecoder().decode(der)).toBe('ABC');
  });

  it('rejects a mismatched label', () => {
    expect(() => pemToDer('no armor here', 'PUBLIC KEY')).toThrow(
      /not a PUBLIC KEY PEM block/,
    );
  });
});

describe('verifyPackageSignature', () => {
  it('verifies a node:crypto RSA-SHA256 signature via WebCrypto (interop)', async () => {
    const { publicKeyPem, privateKeyPem } = rsaKeyPair();
    const files = new Map([
      ['content/index.html', enc.encode('<h1>hi</h1>')],
      ['metadata.json', enc.encode('{}')],
    ]);
    const checksums = {
      'content/index.html': 'aa',
      'metadata.json': 'bb',
    };
    const payload = buildSignedPayload(files, checksums);
    // Signed with node:crypto — the exact construction capsium-js's
    // NodeSignatureProvider uses, so fixtures are exchangeable.
    const signature = sign('sha256', payload, privateKeyPem);
    const entries = new Map(files);
    entries.set('keys/public.pem', enc.encode(publicKeyPem));
    entries.set(SIGNATURE_FILE, signature);

    await expect(
      verifyPackageSignature(entries, makeSecurity(checksums)),
    ).resolves.toBeUndefined();
  });

  it('REJECTS when the signature does not match (wrong key)', async () => {
    const { publicKeyPem } = rsaKeyPair();
    const other = rsaKeyPair();
    const files = new Map([['a.txt', enc.encode('A')]]);
    const checksums = { 'a.txt': 'aa' };
    const signature = sign(
      'sha256',
      buildSignedPayload(files, checksums),
      other.privateKeyPem,
    );
    const entries = new Map(files);
    entries.set('keys/public.pem', enc.encode(publicKeyPem));
    entries.set(SIGNATURE_FILE, signature);

    await expect(
      verifyPackageSignature(entries, makeSecurity(checksums)),
    ).rejects.toMatchObject({
      name: 'PackageError',
      code: 'signature',
    });
    await expect(
      verifyPackageSignature(entries, makeSecurity(checksums)),
    ).rejects.toThrow(/signature mismatch/i);
  });

  it('REJECTS when the signature file or public key is missing', async () => {
    const { publicKeyPem } = rsaKeyPair();
    const checksums = { 'a.txt': 'aa' };
    const entries = new Map([['a.txt', enc.encode('A')]]);
    await expect(
      verifyPackageSignature(entries, makeSecurity(checksums)),
    ).rejects.toMatchObject({ code: 'signature' });

    entries.set('keys/public.pem', enc.encode(publicKeyPem));
    await expect(
      verifyPackageSignature(entries, makeSecurity(checksums)),
    ).rejects.toThrow(/signature\.sig.*missing/i);
  });

  it('REJECTS X.509 certificates with a clear error (WebCrypto cannot import them)', async () => {
    const checksums = { 'a.txt': 'aa' };
    const entries = new Map([
      ['a.txt', enc.encode('A')],
      ['keys/public.pem', enc.encode('-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----')],
      [SIGNATURE_FILE, new Uint8Array([1, 2, 3])],
    ]);
    await expect(
      verifyPackageSignature(entries, makeSecurity(checksums)),
    ).rejects.toThrow(/X\.509/);
  });

  it('is a no-op when digitalSignatures is absent', async () => {
    await expect(
      verifyPackageSignature(new Map(), makeSecurity({}, false)),
    ).resolves.toBeUndefined();
  });
});

describe('PackageLoader — signed fixtures', () => {
  const loader = new PackageLoader();

  it('loads a correctly signed package: checksums AND signature verified', async () => {
    const pkg = await loader.load(generatedFixtureBytes(SIGNED_CAP));
    expect(pkg.metadata.name).toBe('canonical-demo');
    expect(pkg.checksums).toBe('verified');
    expect(pkg.signature).toBe('verified');
    expect(pkg.validity.valid).toBe(true);
  });

  it('REJECTS a package whose signature does not match, BEFORE install', async () => {
    await expect(
      loader.load(generatedFixtureBytes(BADSIG_CAP)),
    ).rejects.toMatchObject({
      name: 'PackageError',
      code: 'signature',
    });
    await expect(
      loader.load(generatedFixtureBytes(BADSIG_CAP)),
    ).rejects.toThrow(PackageError);
  });
});
