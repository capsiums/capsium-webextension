import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { PackageLoader, PackageError } from '../src/lib/package-loader';
import { fixtureBytes, generatedFixtureBytes } from './helpers/fixtures';
import {
  CANONICAL_CAP,
  TAMPERED_CAP,
  PIXEL_PNG_BASE64,
} from './fixtures/global-setup';
import { decodeBase64 } from '../src/lib/base64';
import { sha256Hex } from '../src/lib/checksums';

const loader = new PackageLoader();

describe('PackageLoader — legacy fixtures (tests/*.cap)', () => {
  it('loads bare_package, normalizing legacy manifest/routes/storage', async () => {
    const pkg = await loader.load(fixtureBytes('bare_package-0.1.0.cap'));
    expect(pkg.metadata.name).toBe('bare_package');
    expect(pkg.metadata.dependencies).toEqual({});
    expect(Object.keys(pkg.manifest.resources).sort()).toEqual([
      'content/example.css',
      'content/example.js',
      'content/index.html',
    ]);
    expect(pkg.routes.routes).toContainEqual({
      path: '/',
      resource: 'content/index.html',
    });
    expect(pkg.storage?.storage.dataSets).toEqual({});
    expect(pkg.checksums).toBe('absent');
    expect(pkg.validity.valid).toBe(true);
    expect(pkg.files).toHaveLength(3);
  });

  it('extracts binary files byte-identically (mn-samples PDF)', async () => {
    const zipBytes = fixtureBytes('mn-samples-iso-0.1.0.cap');
    const pkg = await loader.load(zipBytes);
    const pdf = pkg.files.find((file) => file.path.endsWith('.pdf'));
    expect(pdf).toBeDefined();
    expect(pdf?.contentType).toBe('application/pdf');
    expect(pdf?.isText).toBe(false);

    // Reference: raw bytes straight out of the ZIP.
    const reference = unzipSync(zipBytes);
    const referenceBytes = reference[pdf?.path ?? ''];
    expect(referenceBytes).toBeDefined();
    expect(pdf?.bytes).toEqual(referenceBytes);
    expect(await sha256Hex(pdf?.bytes ?? new Uint8Array())).toBe(
      await sha256Hex(referenceBytes ?? new Uint8Array()),
    );
  });
});

describe('PackageLoader — canonical fixture with security.json', () => {
  it('auto-generates manifest and routes, verifies checksums', async () => {
    const pkg = await loader.load(generatedFixtureBytes(CANONICAL_CAP));
    expect(pkg.metadata.name).toBe('canonical-demo');
    expect(pkg.checksums).toBe('verified');

    // Auto-generated manifest covers content/ recursively with detected MIME types.
    expect(pkg.manifest.resources['content/assets/pixel.png']?.type).toBe(
      'image/png',
    );
    expect(pkg.manifest.resources['content/styles.css']?.type).toBe('text/css');

    // Auto-generated routes: index, HTML dual routes, dataset route.
    const paths = pkg.routes.routes.map((route) => route.path);
    expect(paths).toContain('/');
    expect(paths).toContain('/index');
    expect(paths).toContain('/index.html');
    expect(paths).toContain('/page/about');
    expect(paths).toContain('/page/about.html');
    expect(paths).toContain('/assets/pixel.png');
    expect(paths).toContain('/api/v1/data/animals');
    expect(pkg.routes.index).toBe('content/index.html');
  });

  it('keeps the PNG and the nested ZIP byte-identical', async () => {
    const pkg = await loader.load(generatedFixtureBytes(CANONICAL_CAP));
    const png = pkg.files.find(
      (file) => file.path === 'content/assets/pixel.png',
    );
    expect(png?.bytes).toEqual(decodeBase64(PIXEL_PNG_BASE64));

    const blob = pkg.files.find(
      (file) => file.path === 'content/assets/blob.zip',
    );
    expect(blob?.isText).toBe(false);
    const nested = unzipSync(blob?.bytes ?? new Uint8Array());
    expect(new TextDecoder().decode(nested['hello.txt'])).toBe(
      'hello from the nested zip',
    );
  });

  it('includes dataset source files as servable JSON', async () => {
    const pkg = await loader.load(generatedFixtureBytes(CANONICAL_CAP));
    const animals = pkg.files.find((file) => file.path === 'data/animals.json');
    expect(animals?.contentType).toBe('application/json');
    expect(animals?.isText).toBe(true);
  });

  it('REJECTS a tampered package (checksum mismatch)', async () => {
    await expect(
      loader.load(generatedFixtureBytes(TAMPERED_CAP)),
    ).rejects.toThrowError(
      /Checksum verification failed: content\/index\.html \(mismatch\)/,
    );
    await expect(
      loader.load(generatedFixtureBytes(TAMPERED_CAP)),
    ).rejects.toMatchObject({
      name: 'PackageError',
      code: 'integrity',
    });
  });
});

describe('PackageLoader — invalid packages', () => {
  it('rejects a package without metadata.json', async () => {
    const { zipSync } = await import('fflate');
    const bytes = zipSync({
      'content/index.html': new TextEncoder().encode('<p>x</p>'),
    });
    await expect(loader.load(bytes)).rejects.toMatchObject({
      name: 'PackageError',
      code: 'config',
    });
  });

  it('rejects a non-zip payload', async () => {
    await expect(
      loader.load(new TextEncoder().encode('not a zip')),
    ).rejects.toThrowError(PackageError);
  });

  it('rejects when a manifest resource is missing from the archive', async () => {
    const { zipSync } = await import('fflate');
    const enc = new TextEncoder();
    const bytes = zipSync({
      'metadata.json': enc.encode(
        JSON.stringify({ name: 'x', version: '1.0.0' }),
      ),
      'manifest.json': enc.encode(
        JSON.stringify({
          content: [{ file: 'ghost.html', mime: 'text/html' }],
        }),
      ),
      'content/index.html': enc.encode('<p>x</p>'),
    });
    await expect(loader.load(bytes)).rejects.toMatchObject({
      name: 'PackageError',
      code: 'missing-resource',
    });
  });
});
