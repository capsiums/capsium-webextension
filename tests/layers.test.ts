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
import { CapsiumService, buildRuleSpecs } from '../src/lib/background-service';
import { PackageStore } from '../src/lib/store';
import { DnrRuleManager } from '../src/lib/dnr';
import { decodeBase64, encodeBase64 } from '../src/lib/base64';
import { generatedFixtureBytes } from './helpers/fixtures';
import {
  LAYERED_CAP,
  LAYERED_UPDATED_INDEX,
} from './fixtures/global-setup';
import { FakeDnr, FakeRewriter, FakeStorage, FakeTabs } from './helpers/fakes';

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

describe('buildRuleSpecs — layered serving', () => {
  const tombstones = { updates: ['content/gone.html'] };
  const files = new Map([
    [
      'base/content/index.html',
      { contentType: 'text/html', base64: encodeBase64(enc.encode('base')) },
    ],
    [
      'updates/content/index.html',
      {
        contentType: 'text/html',
        base64: encodeBase64(enc.encode('updated')),
      },
    ],
    [
      'base/content/gone.html',
      { contentType: 'text/html', base64: encodeBase64(enc.encode('gone')) },
    ],
    [
      'base/data/animals.json',
      {
        contentType: 'application/json',
        base64: encodeBase64(enc.encode('[]')),
      },
    ],
  ]);
  const storage: StorageFile = parseStorage({
    storage: {
      dataSets: { animals: { source: 'data/animals.json' } },
      layers: [
        { path: 'base', visibility: 'exported' },
        { path: 'updates', visibility: 'private' },
      ],
    },
  });

  it('serves the top-layer winner and resolves dataset sources through layers', () => {
    const specs = buildRuleSpecs(
      {
        routes: [
          { path: '/index.html', resource: 'content/index.html' },
          { path: '/api/v1/data/animals', dataset: 'animals' },
        ],
      },
      files,
      storage,
      tombstones,
    );
    expect(specs).toHaveLength(2);
    const served = dec.decode(
      decodeBase64(specs[0]!.dataUri.split(',')[1] ?? ''),
    );
    expect(served).toBe('updated');
    expect(specs[1]!.dataUri).toContain('data:application/json');
  });

  it('skips tombstoned resources (404-equivalent: no rule)', () => {
    const specs = buildRuleSpecs(
      { routes: [{ path: '/gone.html', resource: 'content/gone.html' }] },
      files,
      storage,
      tombstones,
    );
    expect(specs).toEqual([]);
  });
});

describe('CapsiumService — layered package end to end', () => {
  function makeService() {
    const storage = new FakeStorage();
    const dnr = new FakeDnr();
    const service = new CapsiumService({
      loader: new PackageLoader(),
      store: new PackageStore(storage),
      rules: new DnrRuleManager(dnr, storage),
      rewriter: new FakeRewriter(),
      tabs: new FakeTabs(),
    });
    return { service, storage, dnr };
  }

  const dataUri = `data:application/vnd.capsium.package;base64,${encodeBase64(
    generatedFixtureBytes(LAYERED_CAP),
  )}`;

  it('serves the overriding layer and rebuilds rules after a restart', async () => {
    const { service, dnr } = makeService();
    const response = await service.openFromDataUri(dataUri);
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const indexRule = [...dnr.rules.values()].find(
      (rule) =>
        rule.action.type === 'redirect' &&
        rule.condition.regexFilter.includes('index\\.html'),
    );
    expect(indexRule).toBeDefined();
    if (indexRule?.action.type !== 'redirect') throw new Error('unreachable');
    const served = dec.decode(
      decodeBase64(indexRule.action.redirect.url.split(',')[1] ?? ''),
    );
    expect(served).toContain(LAYERED_UPDATED_INDEX);

    // No rule for the tombstoned page (auto-generated routes exclude it).
    expect(
      [...dnr.rules.values()].some((rule) =>
        rule.condition.regexFilter.includes('gone'),
      ),
    ).toBe(false);

    // Session rules vanish on restart; rebuild must reuse stored tombstones.
    dnr.clear();
    await service.onStartup();
    const rebuilt = [...dnr.rules.values()].find(
      (rule) =>
        rule.action.type === 'redirect' &&
        rule.condition.regexFilter.includes('index\\.html'),
    );
    expect(rebuilt).toBeDefined();
    if (rebuilt?.action.type !== 'redirect') throw new Error('unreachable');
    expect(
      dec.decode(decodeBase64(rebuilt.action.redirect.url.split(',')[1] ?? '')),
    ).toContain(LAYERED_UPDATED_INDEX);
  });
});
