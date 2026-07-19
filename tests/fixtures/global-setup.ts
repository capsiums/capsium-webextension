/**
 * Vitest global setup: builds the canonical-format .cap fixtures (absent
 * from the repo, which only ships legacy gem-format fixtures).
 *
 *  - canonical-demo-1.0.0.cap: canonical metadata, NO manifest.json /
 *    routes.json (exercises auto-generation), canonical storage.json with
 *    one dataset, a 1x1 PNG and a nested ZIP (binary-safety checks), and a
 *    security.json with SHA-256 checksums for every file.
 *  - canonical-demo-1.0.0-tampered.cap: same package but content/index.html
 *    was modified after checksums were computed (must be rejected).
 *  - signed-demo-1.0.0.cap: like canonical-demo but additionally signed per
 *    §6a (signature.pub.pem + signature.sig, RSA-SHA256 over the sorted
 *    checksum-key byte concatenation — same construction as capsium-js's
 *    NodeSignatureProvider, so fixtures are exchangeable).
 *  - signed-demo-1.0.0-badsig.cap: valid checksums but the signature was
 *    made with a DIFFERENT private key (must be rejected, code "signature").
 *  - encrypted-demo-1.0.0.cap: §6b encrypted layout — metadata.json
 *    (cleartext) + signature.json (envelope) + package.enc (AES-256-GCM
 *    ciphertext of the inner canonical zip; DEK wrapped RSA-OAEP-SHA256).
 *  - layered-demo-1.0.0.cap: §5a overlay storage — base (exported) +
 *    updates (private, writable) layers; updates overrides index.html and
 *    tombstones content/gone.html; manifest/routes auto-generated from the
 *    merged view.
 *  - composite-parent-1.0.0.cap / composite-core-1.0.0.cap: §4a composite
 *    pair — the parent declares `capsium://example.com/core` and references
 *    its resources (exported app.js, private secret.js, responseRewrite
 *    route); the core package gates secret.js (manifest-private) and
 *    internal.js (route-private).
 * The signing/encryption private keys are written next to the fixtures
 * (*.private.pem) for cross-implementation checks.
 */
import { zipSync } from 'fflate';
import {
  constants,
  createCipheriv,
  createHash,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
  sign,
} from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CANONICAL_CAP = 'canonical-demo-1.0.0.cap';
export const TAMPERED_CAP = 'canonical-demo-1.0.0-tampered.cap';
export const SIGNED_CAP = 'signed-demo-1.0.0.cap';
export const BADSIG_CAP = 'signed-demo-1.0.0-badsig.cap';
export const SIGNED_PRIVATE_KEY_FILE = 'signed-demo-1.0.0.private.pem';
export const ENCRYPTED_CAP = 'encrypted-demo-1.0.0.cap';
export const ENCRYPTED_PRIVATE_KEY_FILE = 'encrypted-demo-1.0.0.private.pem';
export const LAYERED_CAP = 'layered-demo-1.0.0.cap';

/** Markers distinguishing the base vs overriding layer of LAYERED_CAP. */
export const LAYERED_BASE_INDEX = 'BASE layer index';
export const LAYERED_UPDATED_INDEX = 'UPDATES layer index (overrides)';

export const COMPOSITE_PARENT_CAP = 'composite-parent-1.0.0.cap';
export const COMPOSITE_CORE_CAP = 'composite-core-1.0.0.cap';
export const CORE_GUID = 'capsium://example.com/core';
export const CORE_APP_JS = 'export const core = 42;';
export const REWRITTEN_BODY = '// wrapped by parent';

/** 1x1 PNG; tests assert byte-identical round-trip of these exact bytes. */
export const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const NESTED_ZIP_TEXT = 'hello from the nested zip';

const INDEX_HTML =
  '<!doctype html><html><head><link rel="stylesheet" href="styles.css" /></head>' +
  '<body><img src="assets/pixel.png" /><a href="page/about.html">About</a></body></html>';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function baseFiles(): Record<string, Uint8Array> {
  const enc = new TextEncoder();
  const nestedZip = zipSync({ 'hello.txt': enc.encode(NESTED_ZIP_TEXT) });
  return {
    'metadata.json': enc.encode(
      JSON.stringify({
        name: 'canonical-demo',
        version: '1.0.0',
        description: 'Canonical demo package',
        guid: 'https://github.com/capsiums/canonical-demo',
        uuid: '123e4567-e89b-12d3-a456-426614174000',
        author: 'Ribose',
        license: 'MIT',
        dependencies: { 'capsium://example.com/other-pkg': '>=1.0.0' },
        readOnly: true,
      }),
    ),
    // manifest.json and routes.json intentionally absent (auto-generated).
    'storage.json': enc.encode(
      JSON.stringify({
        storage: {
          dataSets: {
            animals: { source: 'data/animals.json', schemaType: 'json-schema' },
          },
        },
      }),
    ),
    'content/index.html': enc.encode(INDEX_HTML),
    'content/styles.css': enc.encode('body { color: #0f6b83; }'),
    'content/page/about.html': enc.encode(
      '<!doctype html><html><body><a href="../index.html">Home</a></body></html>',
    ),
    'content/assets/pixel.png': Buffer.from(PIXEL_PNG_BASE64, 'base64'),
    'content/assets/blob.zip': nestedZip,
    'data/animals.json': enc.encode(JSON.stringify([{ name: 'capybara' }])),
  };
}

function checksumsOf(
  files: Record<string, Uint8Array>,
): Record<string, string> {
  const checksums: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(files))
    checksums[path] = sha256Hex(bytes);
  return checksums;
}

function securityJsonBytes(
  checksums: Record<string, string>,
  digitalSignatures?: { publicKey: string; signatureFile: string },
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      security: {
        integrityChecks: { checksumAlgorithm: 'SHA-256', checksums },
        ...(digitalSignatures === undefined ? {} : { digitalSignatures }),
      },
    }),
  );
}

/** §6a signed payload: bytes of every checksummed file, keys sorted. */
function signedPayload(
  files: Record<string, Uint8Array>,
  checksums: Record<string, string>,
): Buffer {
  const paths = Object.keys(checksums).sort();
  return Buffer.concat(paths.map((path) => Buffer.from(files[path]!)));
}

function rsaKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

export default function setup(): void {
  const outDir = fileURLToPath(new URL('./generated', import.meta.url));
  mkdirSync(outDir, { recursive: true });

  const files = baseFiles();
  const securityJson = securityJsonBytes(checksumsOf(files));

  writeFileSync(
    fileURLToPath(new URL(`./generated/${CANONICAL_CAP}`, import.meta.url)),
    zipSync({ ...files, 'security.json': securityJson }),
  );

  // Tampered: index.html modified after checksums were computed.
  writeFileSync(
    fileURLToPath(new URL(`./generated/${TAMPERED_CAP}`, import.meta.url)),
    zipSync({
      ...files,
      'content/index.html': new TextEncoder().encode(
        '<!doctype html><html><body>TAMPERED</body></html>',
      ),
      'security.json': securityJson,
    }),
  );

  // Signed (§6a): the public key is added BEFORE the checksums are computed
  // so it is checksum-covered; security.json and signature.sig never are.
  const keyPair = rsaKeyPair();
  const signedFiles: Record<string, Uint8Array> = {
    ...baseFiles(),
    'signature.pub.pem': new TextEncoder().encode(keyPair.publicKeyPem),
  };
  const signedChecksums = checksumsOf(signedFiles);
  const signedSecurity = securityJsonBytes(signedChecksums, {
    publicKey: 'signature.pub.pem',
    signatureFile: 'signature.sig',
  });
  const payload = signedPayload(signedFiles, signedChecksums);
  const signature = sign('sha256', payload, keyPair.privateKeyPem);

  writeFileSync(
    fileURLToPath(new URL(`./generated/${SIGNED_CAP}`, import.meta.url)),
    zipSync({
      ...signedFiles,
      'security.json': signedSecurity,
      'signature.sig': signature,
    }),
  );
  writeFileSync(
    fileURLToPath(
      new URL(`./generated/${SIGNED_PRIVATE_KEY_FILE}`, import.meta.url),
    ),
    keyPair.privateKeyPem,
  );

  // Bad signature: signed with an unrelated key — checksums still valid.
  const otherKey = rsaKeyPair();
  const badSignature = sign('sha256', payload, otherKey.privateKeyPem);
  writeFileSync(
    fileURLToPath(new URL(`./generated/${BADSIG_CAP}`, import.meta.url)),
    zipSync({
      ...signedFiles,
      'security.json': signedSecurity,
      'signature.sig': badSignature,
    }),
  );

  // Encrypted (§6b): outer zip holds cleartext metadata.json, the
  // signature.json envelope and package.enc (AES-256-GCM of the inner zip).
  // DEK wrap: RSA-OAEP with SHA-256 / MGF1-SHA256 (openssl pkeyutl parity).
  const encKeyPair = rsaKeyPair();
  const innerZip = zipSync({ ...files, 'security.json': securityJson });
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const gcm = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([gcm.update(innerZip), gcm.final()]);
  const envelope = {
    encryption: {
      algorithm: 'AES-256-GCM',
      keyManagement: 'RSA-OAEP-SHA256',
      encryptedDek: publicEncrypt(
        {
          key: encKeyPair.publicKeyPem,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        dek,
      ).toString('base64'),
      iv: iv.toString('base64'),
      authTag: gcm.getAuthTag().toString('base64'),
    },
  };
  writeFileSync(
    fileURLToPath(new URL(`./generated/${ENCRYPTED_CAP}`, import.meta.url)),
    zipSync({
      'metadata.json': files['metadata.json']!,
      'signature.json': new TextEncoder().encode(JSON.stringify(envelope)),
      'package.enc': ciphertext,
    }),
  );
  writeFileSync(
    fileURLToPath(
      new URL(`./generated/${ENCRYPTED_PRIVATE_KEY_FILE}`, import.meta.url),
    ),
    encKeyPair.privateKeyPem,
  );

  // Layered (§5a): base (exported) + updates (private, writable) overlay;
  // updates overrides index.html and tombstones content/gone.html.
  const enc2 = new TextEncoder();
  const layeredFiles: Record<string, Uint8Array> = {
    'metadata.json': enc2.encode(
      JSON.stringify({
        name: 'layered-demo',
        version: '1.0.0',
        description: 'Layered storage demo package',
        guid: 'https://github.com/capsiums/layered-demo',
      }),
    ),
    'storage.json': enc2.encode(
      JSON.stringify({
        storage: {
          dataSets: {
            animals: { source: 'data/animals.json', schemaType: 'json-schema' },
          },
          layers: [
            { path: 'base', writable: false, visibility: 'exported' },
            { path: 'updates', writable: true, visibility: 'private' },
          ],
        },
      }),
    ),
    'base/content/index.html': enc2.encode(
      `<!doctype html><html><body>${LAYERED_BASE_INDEX}</body></html>`,
    ),
    'base/content/gone.html': enc2.encode(
      '<!doctype html><html><body>deleted in updates</body></html>',
    ),
    'base/content/styles.css': enc2.encode('body { color: #12404f; }'),
    'base/data/animals.json': enc2.encode(
      JSON.stringify([{ name: 'capybara' }]),
    ),
    'updates/content/index.html': enc2.encode(
      `<!doctype html><html><body>${LAYERED_UPDATED_INDEX}</body></html>`,
    ),
    'updates/.capsium-tombstones': enc2.encode(
      JSON.stringify(['content/gone.html']),
    ),
  };
  writeFileSync(
    fileURLToPath(new URL(`./generated/${LAYERED_CAP}`, import.meta.url)),
    zipSync({
      ...layeredFiles,
      'security.json': securityJsonBytes(checksumsOf(layeredFiles)),
    }),
  );

  // Composite (§4a): the parent declares a dependency on CORE_GUID and its
  // routes reference capsium:// resources (one exported, one private) plus
  // a responseRewrite route; the core package exports app.js/page.html but
  // keeps secret.js private (manifest) and internal.js private (route).
  const enc3 = new TextEncoder();
  const parentFiles: Record<string, Uint8Array> = {
    'metadata.json': enc3.encode(
      JSON.stringify({
        name: 'composite-parent',
        version: '1.0.0',
        description: 'Composite parent demo package',
        guid: 'https://github.com/capsiums/composite-parent',
        dependencies: { [CORE_GUID]: '>=1.0.0' },
      }),
    ),
    'routes.json': enc3.encode(
      JSON.stringify({
        routes: [
          { path: '/', resource: 'content/index.html' },
          { path: '/index.html', resource: 'content/index.html' },
          {
            path: '/vendor/core/app.js',
            resource: `${CORE_GUID}/content/app.js`,
          },
          {
            path: '/secret.js',
            resource: `${CORE_GUID}/content/secret.js`,
          },
          {
            path: '/wrapped.js',
            resource: `${CORE_GUID}/content/app.js`,
            responseRewrite: {
              body: REWRITTEN_BODY,
              headers: { 'X-Rewritten': 'yes' },
            },
            requestHeaders: { 'X-Requested-With': 'capsium-viewer' },
          },
        ],
      }),
    ),
    'content/index.html': enc3.encode(
      '<!doctype html><html><body>composite parent' +
        '<script src="/vendor/core/app.js"></script></body></html>',
    ),
  };
  writeFileSync(
    fileURLToPath(
      new URL(`./generated/${COMPOSITE_PARENT_CAP}`, import.meta.url),
    ),
    zipSync({
      ...parentFiles,
      'security.json': securityJsonBytes(checksumsOf(parentFiles)),
    }),
  );

  const coreFiles: Record<string, Uint8Array> = {
    'metadata.json': enc3.encode(
      JSON.stringify({
        name: 'composite-core',
        version: '1.0.0',
        description: 'Composite dependency demo package',
        guid: CORE_GUID,
      }),
    ),
    'manifest.json': enc3.encode(
      JSON.stringify({
        resources: {
          'content/app.js': {
            type: 'text/javascript',
            visibility: 'exported',
          },
          'content/secret.js': {
            type: 'text/javascript',
            visibility: 'private',
          },
          'content/page.html': { type: 'text/html' },
        },
      }),
    ),
    'routes.json': enc3.encode(
      JSON.stringify({
        routes: [
          { path: '/app.js', resource: 'content/app.js' },
          { path: '/secret.js', resource: 'content/secret.js' },
          { path: '/page.html', resource: 'content/page.html' },
          {
            path: '/internal.js',
            resource: 'content/app.js',
            visibility: 'private',
          },
        ],
      }),
    ),
    'content/app.js': enc3.encode(CORE_APP_JS),
    'content/secret.js': enc3.encode('export const secret = "nope";'),
    'content/page.html': enc3.encode(
      '<!doctype html><html><body>core page</body></html>',
    ),
  };
  writeFileSync(
    fileURLToPath(
      new URL(`./generated/${COMPOSITE_CORE_CAP}`, import.meta.url),
    ),
    zipSync({
      ...coreFiles,
      'security.json': securityJsonBytes(checksumsOf(coreFiles)),
    }),
  );
}
