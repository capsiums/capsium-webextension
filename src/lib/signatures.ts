/**
 * Digital signature verification (ARCHITECTURE.md §6a) via WebCrypto.
 *
 * Signed payload construction (identical in every Capsium implementation):
 * take the keys of `security.integrityChecks.checksums` in sorted (code
 * unit) order and concatenate the bytes of each referenced file in that
 * order. The signature over that byte stream is RSA-SHA256
 * (RSASSA-PKCS1-v1_5), openssl-interoperable
 * (`openssl dgst -sha256 -sign/-verify`).
 *
 * The public key travels inside the package as an SPKI ("PUBLIC KEY") PEM.
 * X.509 certificates cannot be imported by WebCrypto and are rejected with
 * a clear error. `signature.sig` itself is never checksum-covered (the
 * payload is built from the checksum map, so covering it would be
 * circular) — checksum verification skips it alongside security.json.
 */
import { decodeBase64 } from './base64';
import { PackageError } from './errors';
import type { SecurityFile } from './model';

/** Package-relative path of the raw RSA-SHA256 signature (§6a default). */
export const SIGNATURE_FILE = 'signature.sig';

const ALGORITHM = 'RSASSA-PKCS1-v1_5' as const;

/** Concatenate the bytes of every checksummed file, keys sorted (§6a). */
export function buildSignedPayload(
  files: ReadonlyMap<string, Uint8Array>,
  checksums: Record<string, string>,
): Uint8Array {
  const paths = Object.keys(checksums).sort();
  let total = 0;
  const chunks: Uint8Array[] = [];
  for (const path of paths) {
    const bytes = files.get(path);
    if (bytes === undefined) {
      throw new PackageError(
        'signature',
        `File "${path}" is covered by checksums but missing from the archive`,
      );
    }
    chunks.push(bytes);
    total += bytes.byteLength;
  }
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

/** Strip PEM armor and decode the DER body. */
export function pemToDer(pem: string, label: string): Uint8Array {
  const pattern = new RegExp(
    `-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+?)-----END ${label}-----`,
  );
  const match = pattern.exec(pem);
  if (match === null) {
    throw new PackageError(
      'signature',
      `Public key is not a ${label} PEM block`,
    );
  }
  return decodeBase64(match[1] as string);
}

/** WebCrypto wants a plain ArrayBuffer-backed view for key/signature data. */
function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function importPublicKey(publicKeyPem: string): Promise<CryptoKey> {
  if (publicKeyPem.includes('BEGIN CERTIFICATE')) {
    throw new PackageError(
      'signature',
      'X.509 certificates are not supported by WebCrypto; ship an SPKI "PUBLIC KEY" PEM instead',
    );
  }
  try {
    return await crypto.subtle.importKey(
      'spki',
      toBufferSource(pemToDer(publicKeyPem, 'PUBLIC KEY')),
      { name: ALGORITHM, hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch (error) {
    if (error instanceof PackageError) throw error;
    throw new PackageError(
      'signature',
      `Could not import the packaged public key: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Verify the packaged signature when security.json declares
 * `digitalSignatures`; REJECT the package (PackageError) on any mismatch,
 * exactly like checksum verification. Runs BEFORE install.
 */
export async function verifyPackageSignature(
  entries: ReadonlyMap<string, Uint8Array>,
  security: SecurityFile,
): Promise<void> {
  const declared = security.security.digitalSignatures;
  if (declared === undefined) return;

  const signature = entries.get(declared.signatureFile);
  if (signature === undefined) {
    throw new PackageError(
      'signature',
      `Signature file "${declared.signatureFile}" is declared but missing from the archive`,
    );
  }
  const pemBytes = entries.get(declared.publicKey);
  if (pemBytes === undefined) {
    throw new PackageError(
      'signature',
      `Public key "${declared.publicKey}" is declared but missing from the archive`,
    );
  }

  const payload = buildSignedPayload(
    entries,
    security.security.integrityChecks.checksums,
  );
  const key = await importPublicKey(new TextDecoder().decode(pemBytes));
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      ALGORITHM,
      key,
      toBufferSource(signature),
      toBufferSource(payload),
    );
  } catch (error) {
    throw new PackageError(
      'signature',
      `Signature verification failed to run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!valid) {
    throw new PackageError(
      'signature',
      `Digital signature mismatch: "${declared.signatureFile}" does not match the package contents`,
    );
  }
}
