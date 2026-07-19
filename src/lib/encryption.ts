/**
 * Encrypted packages (ARCHITECTURE.md §6b) via WebCrypto.
 *
 * Layout: an encrypted .cap zip holds metadata.json (cleartext),
 * signature.json (cleartext envelope) and package.enc (AES-256-GCM
 * ciphertext of the whole inner zip). The 32-byte DEK is wrapped for the
 * recipient's RSA key with OAEP (SHA-256, MGF1-SHA256). Given the private
 * key (PKCS#8 PEM), the DEK is unwrapped and the inner zip decrypted
 * transparently — afterwards the package loads like any other .cap.
 *
 * WebCrypto note: node:crypto keeps the GCM auth tag separate (as the
 * envelope does); WebCrypto wants it appended to the ciphertext.
 */
import { decodeBase64 } from './base64';
import { PackageError } from './errors';
import { parseJsonConfig } from './json';
import { parseEncryptionEnvelope } from './model';

export const ENCRYPTED_PACKAGE_FILE = 'package.enc';
export const ENCRYPTION_ENVELOPE_FILE = 'signature.json';
export const GCM_IV_BYTES = 12;
export const GCM_AUTH_TAG_BYTES = 16;
export const DEK_BYTES = 32;

/** True when the archive has the encrypted layout (§6b). */
export function isEncryptedPackage(
  files: ReadonlyMap<string, Uint8Array>,
): boolean {
  return (
    files.has(ENCRYPTED_PACKAGE_FILE) && files.has(ENCRYPTION_ENVELOPE_FILE)
  );
}

/** WebCrypto wants plain ArrayBuffer-backed views. */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function pemToPkcs8Der(privateKeyPem: string): Uint8Array {
  const match = /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+?)-----END PRIVATE KEY-----/.exec(
    privateKeyPem,
  );
  if (match === null) {
    throw new PackageError(
      'encryption',
      'The private key must be an unencrypted PKCS#8 "PRIVATE KEY" PEM (e.g. `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`)',
    );
  }
  return decodeBase64(match[1] as string);
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      toBufferSource(pemToPkcs8Der(privateKeyPem)),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['decrypt'],
    );
  } catch (error) {
    if (error instanceof PackageError) throw error;
    throw new PackageError(
      'encryption',
      `Could not import the private key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Unwrap the DEK (RSA-OAEP SHA-256) and AES-256-GCM-decrypt package.enc,
 * returning the inner zip bytes. Any failure (wrong key, corrupted
 * envelope/ciphertext) rejects with a clear PackageError.
 */
export async function decryptPackage(
  entries: ReadonlyMap<string, Uint8Array>,
  privateKeyPem: string,
): Promise<Uint8Array> {
  const envelopeBytes = entries.get(ENCRYPTION_ENVELOPE_FILE);
  const ciphertext = entries.get(ENCRYPTED_PACKAGE_FILE);
  if (envelopeBytes === undefined || ciphertext === undefined) {
    throw new PackageError(
      'encryption',
      'Encrypted package is incomplete: signature.json and package.enc are both required',
    );
  }
  const { encryption } = parseEncryptionEnvelope(
    parseJsonConfig(ENCRYPTION_ENVELOPE_FILE, envelopeBytes),
  );

  const encryptedDek = decodeBase64(encryption.encryptedDek);
  const iv = decodeBase64(encryption.iv);
  const authTag = decodeBase64(encryption.authTag);
  if (iv.byteLength !== GCM_IV_BYTES) {
    throw new PackageError(
      'encryption',
      `Envelope iv must be ${GCM_IV_BYTES} bytes, got ${iv.byteLength}`,
    );
  }
  if (authTag.byteLength !== GCM_AUTH_TAG_BYTES) {
    throw new PackageError(
      'encryption',
      `Envelope authTag must be ${GCM_AUTH_TAG_BYTES} bytes, got ${authTag.byteLength}`,
    );
  }

  const key = await importPrivateKey(privateKeyPem);
  try {
    // Unwrap the DEK.
    const dek = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      key,
      toBufferSource(encryptedDek),
    );
    const aesKey = await crypto.subtle.importKey(
      'raw',
      dek,
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    // WebCrypto expects the auth tag appended to the ciphertext.
    const combined = new Uint8Array(
      ciphertext.byteLength + authTag.byteLength,
    );
    combined.set(ciphertext, 0);
    combined.set(authTag, ciphertext.byteLength);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(iv), tagLength: 128 },
      aesKey,
      toBufferSource(combined),
    );
    return new Uint8Array(plain);
  } catch (error) {
    if (error instanceof PackageError) throw error;
    throw new PackageError(
      'encryption',
      'Could not decrypt the package — the private key does not match or the envelope is corrupted',
    );
  }
}
