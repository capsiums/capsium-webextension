import { describe, expect, it } from 'vitest';
import {
  collectTombstones,
  entriesFileView,
  mergedContentPaths,
  resolveLayeredPath,
  storedFileView,
  TOMBSTONES_FILE,
} from '../src/lib/layers';
import { parseStorage, type StorageFile } from '../src/lib/model';
import { PackageLoader } from '../src/lib/package-loader';
import { CapsiumService } from '../src/lib/background-service';
import { resolveUrlPath } from '../src/lib/resolver';
import { PackageStore } from '../src/lib/store';
import { DnrRuleManager } from '../src/lib/dnr';
import { encodeBase64 } from '../src/lib/base64';
import { generatedFixtureBytes } from './helpers/fixtures';
import {
  LAYERED_CAP,
  LAYERED_UPDATED_INDEX,
} from './fixtures/global-setup';
import {
  FakeDnr,
  FakeFileStore,
  FakeRewriter,
  FakeStorage,
  FakeTabs,
} from './helpers/fakes';

const ROUTER = 'chrome-extension://ext-id/router.html';
const enc = new TextEncoder();
const dec = new TextDecoder();

const LAYERED_STORAGE: StorageFile = parseStorage({
  storage: {
    dataSets: {},
    layers: [
      { path: 'base', writable: false, visibility: 'exported' },
      { path: 'updates', writable: true, visibility: 'private' },
    ],
  },
});

function demoEntries(): Map<string, Uint8Array> {
  return new Map([
    ['base/content/index.html', enc.encode('base')],
    ['base/content/gone.html', enc.encode('gone')],
    ['updates/content/index.html', enc.encode('updated')],
    ['updates/.capsium-tombstones', enc.encode('["content/gone.html"]')],
  ]);
}

describe('storage model — layers (§5a)', () => {
  it('parses the layers array bottom → top', () => {
    expect(LAYERED_STORAGE.storage.layers).toHaveLength(2);
    expect(LAYERED_STORAGE.storage.layers?.[0]?.path).toBe('base');
    expect(LAYERED_STORAGE.storage.layers?.[1]?.visibility).toBe('private');
  });
});

describe('resolveLayeredPath', () => {
  const view = entriesFileView(demoEntries());

  it('resolves top → bottom, first hit wins', () => {
    const res = resolveLayeredPath(
      view,
      LAYERED_STORAGE,
      'content/index.html',
    );
    expect(res).toMatchObject({
      kind: 'found',
      path: 'updates/content/index.html',
    });
  });

  it('falls through to the lower layer', () => {
    const res = resolveLayeredPath(view, LAYERED_STORAGE, 'content/gone.html');
    // tombstoned in updates → NOT found in base
    expect(res.kind).toBe('tombstoned');
  });

  it('reports not-found for unknown paths', () => {
    expect(
      resolveLayeredPath(view, LAYERED_STORAGE, 'content/ghost.html').kind,
    ).toBe('not-found');
  });

  it('hides private layers from the dependent viewpoint', () => {
    const res = resolveLayeredPath(
      view,
      LAYERED_STORAGE,
      'content/index.html',
      'dependent',
    );
    // updates is private → only base is visible
    expect(res).toMatchObject({
      kind: 'found',
      path: 'base/content/index.html',
    });
    // tombstones of the hidden layer do not apply either
    expect(
      resolveLayeredPath(view, LAYERED_STORAGE, 'content/gone.html', 'dependent')
        .kind,
    ).toBe('found');
  });

  it('treats an unconfigured package as a single implicit root layer', () => {
    const files = new Map([['content/x.html', enc.encode('x')]]);
    const res = resolveLayeredPath(entriesFileView(files), null, 'content/x.html');
    expect(res).toMatchObject({ kind: 'found', path: 'content/x.html' });
  });

  it('tolerates malformed tombstone files', () => {
    const files = new Map([
      ['updates/.capsium-tombstones', enc.encode('not json')],
      ['updates/content/a.html', enc.encode('a')],
    ]);
    const res = resolveLayeredPath(
      entriesFileView(files),
      LAYERED_STORAGE,
      'content/a.html',
    );
    expect(res.kind).toBe('found');
  });
});

describe('collectTombstones + storedFileView', () => {
  it('parses per-layer tombstones for persistence and reuses them', () => {
    const entries = demoEntries();
    const tombstones = collectTombstones(entries, LAYERED_STORAGE);
    expect(tombstones).toEqual({ updates: ['content/gone.html'] });

    const view = storedFileView(entries.keys(), tombstones);
    expect(
      resolveLayeredPath(view, LAYERED_STORAGE, 'content/gone.html').kind,
    ).toBe('tombstoned');
  });
});

describe('mergedContentPaths', () => {
  it('unions layer content minus tombstoned paths', () => {
    expect(mergedContentPaths(demoEntries(), LAYERED_STORAGE)).toEqual([
      'content/index.html',
    ]);
  });
});

describe('PackageLoader — layered fixture', () => {
  const loader = new PackageLoader();

  it('builds the manifest from the merged view and keeps raw layer files', async () => {
    const pkg = await loader.load(generatedFixtureBytes(LAYERED_CAP));
    expect(pkg.metadata.name).toBe('layered-demo');
    expect(pkg.checksums).toBe('verified');

    // Merged view: gone.html is tombstoned away, no manifest entry.
    expect(Object.keys(pkg.manifest.resources).sort()).toEqual([
      'content/index.html',
      'content/styles.css',
    ]);

    // Raw layer files are stored (serving resolves the winner later).
    const paths = pkg.files.map((file) => file.path);
    expect(paths).toContain('base/content/index.html');
    expect(paths).toContain('updates/content/index.html');
    expect(paths).toContain('base/data/animals.json');
    expect(paths.some((path) => path.includes(TOMBSTONES_FILE))).toBe(false);

    expect(pkg.tombstones).toEqual({ updates: ['content/gone.html'] });

    // Routes generated off the merged manifest: no /gone routes.
    const routePaths = pkg.routes.routes.map((route) => route.path);
    expect(routePaths).toContain('/');
    expect(routePaths).toContain('/index.html');
    expect(routePaths).toContain('/styles.css');
    expect(routePaths).toContain('/api/v1/data/animals');
    expect(routePaths.some((path) => path.includes('gone'))).toBe(false);
  });
});

describe('resolveUrlPath — layered serving', () => {
  const tombstones = { updates: ['content/gone.html'] };
  const view = {
    capId: 'cap-id',
    storage: parseStorage({
      storage: {
        dataSets: { animals: { source: 'data/animals.json' } },
        layers: [
          { path: 'base', visibility: 'exported' },
          { path: 'updates', visibility: 'private' },
        ],
      },
    }),
    tombstones,
    fileTypes: {
      'base/content/index.html': 'text/html',
      'updates/content/index.html': 'text/html',
      'base/content/gone.html': 'text/html',
      'base/data/animals.json': 'application/json',
    },
  };

  it('serves the top-layer winner and resolves dataset sources through layers', () => {
    const resolution = resolveUrlPath(
      {
        ...view,
        routes: {
          routes: [
            { path: '/index.html', resource: 'content/index.html' },
            { path: '/api/v1/data/animals', dataset: 'animals' },
          ],
        },
      },
      [],
      '/index.html',
    );
    expect(resolution).toEqual({
      kind: 'found',
      file: {
        capId: 'cap-id',
        path: 'updates/content/index.html',
        contentType: 'text/html',
      },
    });

    const dataset = resolveUrlPath(
      {
        ...view,
        routes: {
          routes: [{ path: '/api/v1/data/animals', dataset: 'animals' }],
        },
      },
      [],
      '/api/v1/data/animals',
    );
    expect(dataset).toEqual({
      kind: 'found',
      file: {
        capId: 'cap-id',
        path: 'base/data/animals.json',
        contentType: 'application/json',
      },
    });
  });

  it('resolves tombstoned resources as not-found (the router 404s)', () => {
    const resolution = resolveUrlPath(
      {
        ...view,
        routes: {
          routes: [{ path: '/gone.html', resource: 'content/gone.html' }],
        },
      },
      [],
      '/gone.html',
    );
    expect(resolution.kind).toBe('not-found');
  });
});

describe('CapsiumService — layered package end to end', () => {
  function makeService() {
    const storage = new FakeStorage();
    const fileStore = new FakeFileStore();
    const dnr = new FakeDnr();
    const service = new CapsiumService({
      loader: new PackageLoader(),
      store: new PackageStore(storage, fileStore),
      rules: new DnrRuleManager(dnr, storage),
      rewriter: new FakeRewriter(),
      tabs: new FakeTabs(),
      fileStore,
      routerBaseUrl: ROUTER,
    });
    return { service, storage, fileStore, dnr };
  }

  const dataUri = `data:application/vnd.capsium.package;base64,${encodeBase64(
    generatedFixtureBytes(LAYERED_CAP),
  )}`;

  it('serves the overriding layer and resolves identically after a restart', async () => {
    const { service, fileStore, dnr } = makeService();
    const response = await service.openFromDataUri(dataUri);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const capId = response.info.capId;

    // One redirect rule; resolution picks the top-layer winner.
    expect(dnr.rules.size).toBe(1);
    const resolved = await service.resolve(capId, ['/index.html', '/gone']);
    const index = resolved[0];
    expect(index?.kind).toBe('found');
    if (index?.kind === 'found') {
      expect(index.filePath).toBe('updates/content/index.html');
      expect(
        dec.decode((await fileStore.get(index.fileCapId, index.filePath))!),
      ).toContain(LAYERED_UPDATED_INDEX);
    }
    // Auto-generated routes exclude the tombstoned page → router 404.
    expect(resolved[1]?.kind).toBe('not-found');

    // Session rules vanish on restart; resolution reuses stored tombstones.
    dnr.clear();
    await service.onStartup();
    expect(dnr.rules.size).toBe(1);
    const rebuilt = await service.resolve(capId, ['/index.html']);
    const rebuiltIndex = rebuilt[0];
    expect(rebuiltIndex?.kind).toBe('found');
    if (rebuiltIndex?.kind === 'found') {
      expect(rebuiltIndex.filePath).toBe('updates/content/index.html');
      expect(
        dec.decode(
          (await fileStore.get(
            rebuiltIndex.fileCapId,
            rebuiltIndex.filePath,
          ))!,
        ),
      ).toContain(LAYERED_UPDATED_INDEX);
    }
  });
});
