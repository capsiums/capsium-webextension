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
 */
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CANONICAL_CAP = 'canonical-demo-1.0.0.cap';
export const TAMPERED_CAP = 'canonical-demo-1.0.0-tampered.cap';

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

export default function setup(): void {
  const outDir = fileURLToPath(new URL('./generated', import.meta.url));
  mkdirSync(outDir, { recursive: true });

  const enc = new TextEncoder();
  const nestedZip = zipSync({ 'hello.txt': enc.encode(NESTED_ZIP_TEXT) });

  const files: Record<string, Uint8Array> = {
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

  const checksums: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(files))
    checksums[path] = sha256Hex(bytes);
  const securityJson = new TextEncoder().encode(
    JSON.stringify({
      security: {
        integrityChecks: { checksumAlgorithm: 'SHA-256', checksums },
      },
    }),
  );

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
}
