import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { generateKeyPairSync } from 'node:crypto';
import {
  isEncryptedPackage,
  decryptPackage,
  ENCRYPTED_PACKAGE_FILE,
  ENCRYPTION_ENVELOPE_FILE,
} from '../src/lib/encryption';
import { parseEncryptionEnvelope } from '../src/lib/model';
import { PackageLoader } from '../src/lib/package-loader';
import { CapsiumService } from '../src/lib/background-service';
import { PackageStore } from '../src/lib/store';
import { DnrRuleManager } from '../src/lib/dnr';
import { encodeBase64 } from '../src/lib/base64';
import { generatedFixtureBytes } from './helpers/fixtures';
import {
  ENCRYPTED_CAP,
  ENCRYPTED_PRIVATE_KEY_FILE,
} from './fixtures/global-setup';
import { FakeDnr, FakeFileStore, FakeRewriter, FakeStorage, FakeTabs } from './helpers/fakes';

const ROUTER = 'chrome-extension://ext-id/router.html';
const dec = new TextDecoder();

function fixtureKey(): string {
  return dec.decode(generatedFixtureBytes(ENCRYPTED_PRIVATE_KEY_FILE));
}

function wrongKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

function encryptedEntries(): Map<string, Uint8Array> {
  const raw = unzipSync(generatedFixtureBytes(ENCRYPTED_CAP));
  return new Map(Object.entries(raw));
}

describe('isEncryptedPackage (§6b)', () => {
  it('detects the encrypted layout', () => {
    expect(
      isEncryptedPackage(
        new Map([
          [ENCRYPTED_PACKAGE_FILE, new Uint8Array()],
          [ENCRYPTION_ENVELOPE_FILE, new Uint8Array()],
        ]),
      ),
    ).toBe(true);
    expect(
      isEncryptedPackage(new Map([['metadata.json', new Uint8Array()]])),
    ).toBe(false);
  });
});

describe('encryption envelope model', () => {
  it('rejects unknown algorithms', () => {
    expect(() =>
      parseEncryptionEnvelope({
        encryption: {
          algorithm: 'AES-128-CBC',
          keyManagement: 'RSA-OAEP-SHA256',
          encryptedDek: 'x',
          iv: 'y',
          authTag: 'z',
        },
      }),
    ).toThrow(/Invalid signature\.json/);
  });
});

describe('decryptPackage', () => {
  it('unwraps the DEK (RSA-OAEP SHA-256) and decrypts the inner zip', async () => {
    const innerZip = await decryptPackage(encryptedEntries(), fixtureKey());
    const inner = unzipSync(innerZip);
    expect(inner['metadata.json']).toBeDefined();
    expect(dec.decode(inner['metadata.json'])).toContain('canonical-demo');
    expect(inner['security.json']).toBeDefined();
    expect(inner['content/index.html']).toBeDefined();
  });

  it('rejects with a clear error for the wrong private key', async () => {
    await expect(
      decryptPackage(encryptedEntries(), wrongKey()),
    ).rejects.toMatchObject({ name: 'PackageError', code: 'encryption' });
    await expect(
      decryptPackage(encryptedEntries(), wrongKey()),
    ).rejects.toThrow(/does not match|corrupted/);
  });

  it('rejects a non-PKCS#8 key with guidance', async () => {
    await expect(
      decryptPackage(encryptedEntries(), '-----BEGIN RSA PRIVATE KEY-----'),
    ).rejects.toThrow(/PKCS#8/);
  });
});

describe('PackageLoader — encrypted fixture', () => {
  const loader = new PackageLoader();

  it('requires the private key', async () => {
    await expect(
      loader.load(generatedFixtureBytes(ENCRYPTED_CAP)),
    ).rejects.toMatchObject({ name: 'PackageError', code: 'encryption' });
    await expect(
      loader.load(generatedFixtureBytes(ENCRYPTED_CAP)),
    ).rejects.toThrow(/private key/i);
  });

  it('loads the decrypted inner package like a normal .cap', async () => {
    const pkg = await loader.load(generatedFixtureBytes(ENCRYPTED_CAP), {
      privateKey: fixtureKey(),
    });
    expect(pkg.metadata.name).toBe('canonical-demo');
    expect(pkg.checksums).toBe('verified');
    expect(pkg.files.map((file) => file.path)).toContain('content/index.html');
  });

  it('rejects the wrong key', async () => {
    await expect(
      loader.load(generatedFixtureBytes(ENCRYPTED_CAP), {
        privateKey: wrongKey(),
      }),
    ).rejects.toMatchObject({ code: 'encryption' });
  });
});

describe('CapsiumService — encrypted package flow', () => {
  function makeService() {
    const storage = new FakeStorage();
    const fileStore = new FakeFileStore();
    const service = new CapsiumService({
      loader: new PackageLoader(),
      store: new PackageStore(storage, fileStore),
      rules: new DnrRuleManager(new FakeDnr(), storage),
      rewriter: new FakeRewriter(),
      tabs: new FakeTabs(),
      fileStore,
      routerBaseUrl: ROUTER,
    });
    return service;
  }

  const dataUri = `data:application/vnd.capsium.package;base64,${encodeBase64(
    generatedFixtureBytes(ENCRYPTED_CAP),
  )}`;

  it('asks for the private key, then opens with it', async () => {
    const service = makeService();
    const first = await service.openFromDataUri(dataUri);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.needsPrivateKey).toBe(true);
    expect(first.error).toMatch(/private key/i);

    const second = await service.openFromDataUri(dataUri, fixtureKey());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.info.name).toBe('canonical-demo');
  });

  it('keeps asking when the key is wrong', async () => {
    const service = makeService();
    const response = await service.openFromDataUri(dataUri, wrongKey());
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.needsPrivateKey).toBe(true);
    expect(response.error).toMatch(/does not match|corrupted/);
  });
});
