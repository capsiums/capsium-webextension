import { describe, expect, it } from 'vitest';
import {
  isDependencyResourceRef,
  parseDependencyResourceRef,
  resolveDependencyResource,
  CAPSIUM_SCHEME,
} from '../src/lib/composite';
import {
  resolveUrlPath,
  type InstalledDependencyView,
} from '../src/lib/resolver';
import { parseRoutes, parseStorage } from '../src/lib/model';
import { PackageLoader } from '../src/lib/package-loader';
import { CapsiumService } from '../src/lib/background-service';
import { PackageStore } from '../src/lib/store';
import { DnrRuleManager } from '../src/lib/dnr';
import { encodeBase64 } from '../src/lib/base64';
import { generatedFixtureBytes } from './helpers/fixtures';
import {
  CANONICAL_CAP,
  COMPOSITE_PARENT_CAP,
  COMPOSITE_CORE_CAP,
  CORE_GUID,
  CORE_APP_JS,
  REWRITTEN_BODY,
} from './fixtures/global-setup';
import {
  FakeDnr,
  FakeFileStore,
  FakeRewriter,
  FakeStorage,
  FakeTabs,
} from './helpers/fakes';

const ROUTER = 'chrome-extension://ext-id/router.html';
const DEP_CAP = 'dep-cap-id';
const dec = new TextDecoder();

function coreView(): InstalledDependencyView {
  return {
    capId: DEP_CAP,
    guid: CORE_GUID,
    manifest: {
      resources: {
        'content/app.js': { type: 'text/javascript', visibility: 'exported' },
        'content/secret.js': { type: 'text/javascript', visibility: 'private' },
        'content/page.html': { type: 'text/html', visibility: 'exported' },
      },
    },
    routes: parseRoutes({
      routes: [
        { path: '/app.js', resource: 'content/app.js' },
        { path: '/secret.js', resource: 'content/secret.js' },
        {
          path: '/internal.js',
          resource: 'content/app.js',
          visibility: 'private',
        },
      ],
    }),
    storage: null,
    tombstones: {},
    fileTypes: {
      'content/app.js': 'text/javascript',
      'content/secret.js': 'text/javascript',
      'content/page.html': 'text/html',
    },
    filePaths: ['content/app.js', 'content/secret.js', 'content/page.html'],
  };
}

describe('routes model — inheritance attributes (§4a)', () => {
  it('parses remap/responseRewrite/responseHeaders/requestHeaders', () => {
    const routes = parseRoutes({
      routes: [
        {
          path: '/a.js',
          resource: 'content/a.js',
          remap: '/vendor/a.js',
          responseRewrite: { body: '// x', headers: { 'X-A': '1' } },
          responseHeaders: { 'X-B': '2' },
          requestHeaders: { 'X-C': '3' },
        },
      ],
    });
    expect(routes.routes[0]).toMatchObject({
      remap: '/vendor/a.js',
      responseRewrite: { body: '// x', headers: { 'X-A': '1' } },
      responseHeaders: { 'X-B': '2' },
      requestHeaders: { 'X-C': '3' },
    });
  });
});

describe('dependency resource references', () => {
  it('detects and parses capsium:// refs (longest guid prefix wins)', () => {
    expect(isDependencyResourceRef(`${CAPSIUM_SCHEME}x/y`)).toBe(true);
    expect(isDependencyResourceRef('content/x.js')).toBe(false);
    const ref = parseDependencyResourceRef(
      'capsium://example.com/core/content/app.js',
      ['capsium://example.com', 'capsium://example.com/core'],
    );
    expect(ref).toEqual({
      guid: 'capsium://example.com/core',
      path: 'content/app.js',
    });
  });

  it('returns null when no guid matches', () => {
    expect(
      parseDependencyResourceRef('capsium://other/x.js', [CORE_GUID]),
    ).toBeNull();
  });
});

describe('resolveDependencyResource', () => {
  it('serves exported resources, blocks private ones', () => {
    expect(resolveDependencyResource(coreView(), 'content/app.js')).toEqual({
      kind: 'found',
      path: 'content/app.js',
    });
    expect(resolveDependencyResource(coreView(), 'content/secret.js')).toEqual({
      kind: 'private',
      path: 'content/secret.js',
    });
    expect(resolveDependencyResource(coreView(), 'content/ghost.js').kind).toBe(
      'not-found',
    );
  });

  it('hides private layers from dependents (§5a)', () => {
    const layered: InstalledDependencyView = {
      ...coreView(),
      storage: parseStorage({
        storage: {
          dataSets: {},
          layers: [
            { path: 'base', visibility: 'exported' },
            { path: 'updates', visibility: 'private' },
          ],
        },
      }),
      fileTypes: {
        'base/content/app.js': 'text/javascript',
        'updates/content/app.js': 'text/javascript',
      },
      filePaths: ['base/content/app.js', 'updates/content/app.js'],
    };
    expect(resolveDependencyResource(layered, 'content/app.js')).toEqual({
      kind: 'found',
      path: 'base/content/app.js',
    });
  });
});

describe('composite resolution (§4a)', () => {
  const parentView = {
    capId: 'parent-cap-id',
    routes: parseRoutes({
      routes: [
        { path: '/', resource: 'content/index.html' },
        { path: '/vendor/app.js', resource: `${CORE_GUID}/content/app.js` },
        { path: '/secret.js', resource: `${CORE_GUID}/content/secret.js` },
      ],
    }),
    storage: null,
    tombstones: {},
    fileTypes: { 'content/index.html': 'text/html' },
  };

  it('resolves capsium:// refs only when the dependency is installed', () => {
    expect(resolveUrlPath(parentView, [], '/vendor/app.js').kind).toBe(
      'not-found',
    );
    const resolution = resolveUrlPath(
      parentView,
      [coreView()],
      '/vendor/app.js',
    );
    expect(resolution).toEqual({
      kind: 'found',
      file: {
        capId: DEP_CAP,
        path: 'content/app.js',
        contentType: 'text/javascript',
      },
    });
    // private resource of the dependency is never served
    expect(resolveUrlPath(parentView, [coreView()], '/secret.js').kind).toBe(
      'not-found',
    );
  });

  it('serves own routes above inherited dependency routes', () => {
    // Own routes win; exported dep routes serve as the lower layer;
    // route-private dep routes are not inherited.
    expect(resolveUrlPath(parentView, [coreView()], '/')).toEqual({
      kind: 'found',
      file: {
        capId: 'parent-cap-id',
        path: 'content/index.html',
        contentType: 'text/html',
      },
    });
    expect(resolveUrlPath(parentView, [coreView()], '/app.js').kind).toBe(
      'found',
    );
    expect(resolveUrlPath(parentView, [coreView()], '/internal.js').kind).toBe(
      'not-found',
    );
  });

  it('honors remap and responseRewrite.body at serve time', () => {
    const routes = parseRoutes({
      routes: [
        {
          path: '/wrapped.js',
          resource: `${CORE_GUID}/content/app.js`,
          remap: '/vendor/wrapped.js',
          responseRewrite: { body: REWRITTEN_BODY, headers: { 'X-R': '1' } },
          requestHeaders: { 'X-Q': '2' },
        },
      ],
    });
    const view = {
      capId: 'parent-cap-id',
      routes,
      storage: null,
      tombstones: {},
      fileTypes: {},
    };
    expect(resolveUrlPath(view, [coreView()], '/wrapped.js').kind).toBe(
      'not-found', // remapped: the original path no longer answers
    );
    const resolution = resolveUrlPath(view, [coreView()], '/vendor/wrapped.js');
    expect(resolution).toEqual({
      kind: 'found',
      file: {
        capId: DEP_CAP,
        path: 'content/app.js',
        contentType: 'text/javascript',
        bodyOverride: REWRITTEN_BODY,
        responseHeaders: { 'X-R': '1' },
      },
    });
  });
});

describe('CapsiumService — composite end to end', () => {
  function makeService(now: () => number = Date.now) {
    const storage = new FakeStorage();
    const fileStore = new FakeFileStore();
    const dnr = new FakeDnr();
    const tabs = new FakeTabs();
    const service = new CapsiumService({
      loader: new PackageLoader(),
      store: new PackageStore(storage, fileStore, now),
      rules: new DnrRuleManager(dnr, storage),
      rewriter: new FakeRewriter(),
      tabs,
      fileStore,
      routerBaseUrl: ROUTER,
      now,
    });
    return { service, storage, fileStore, dnr, tabs };
  }

  const dataUriOf = (name: string): string =>
    `data:application/vnd.capsium.package;base64,${encodeBase64(
      generatedFixtureBytes(name),
    )}`;

  it('lists declared dependencies, installs them in-session, serves exported only', async () => {
    const { service, fileStore, dnr } = makeService();
    const opened = await service.openFromDataUri(
      dataUriOf(COMPOSITE_PARENT_CAP),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const parentCapId = opened.info.capId;
    expect(opened.info.dependencies).toEqual([
      { guid: CORE_GUID, range: '>=1.0.0', status: 'missing' },
    ]);
    // Still just ONE redirect rule — no per-route rules at all.
    expect(dnr.rules.size).toBe(1);

    // Only the parent's own routes resolve so far (refs unresolved).
    let results = await service.resolve(parentCapId, [
      '/',
      '/index.html',
      '/vendor/core/app.js',
    ]);
    expect(results.map((result) => result.kind)).toEqual([
      'found',
      'found',
      'not-found',
    ]);

    // A package whose guid is not declared is refused.
    const wrong = await service.addDependencyFromDataUri(
      parentCapId,
      dataUriOf(CANONICAL_CAP),
    );
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error).toMatch(/not a declared dependency/);

    // Install the real dependency.
    const added = await service.addDependencyFromDataUri(
      parentCapId,
      dataUriOf(COMPOSITE_CORE_CAP),
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.info.dependencies).toEqual([
      {
        guid: CORE_GUID,
        range: '>=1.0.0',
        status: 'installed',
        name: 'composite-core',
        version: '1.0.0',
      },
    ]);
    // No rule churn on dependency install: resolution is dynamic.
    expect(dnr.rules.size).toBe(1);

    // Parent ref routes now resolve; private ones stay unserved.
    results = await service.resolve(parentCapId, [
      '/vendor/core/app.js',
      '/secret.js',
      '/wrapped.js',
      '/page.html',
      '/internal.js',
    ]);
    const byPath = new Map(results.map((result) => [result.path, result]));

    const appJs = byPath.get('/vendor/core/app.js');
    expect(appJs?.kind).toBe('found');
    if (appJs?.kind === 'found') {
      expect(appJs.fileCapId).not.toBe(parentCapId); // owned by the dependency
      expect(
        dec.decode((await fileStore.get(appJs.fileCapId, appJs.filePath))!),
      ).toBe(CORE_APP_JS);
    }

    expect(byPath.get('/secret.js')?.kind).toBe('not-found');

    // responseRewrite.body rides along as a body override.
    const wrapped = byPath.get('/wrapped.js');
    expect(wrapped?.kind).toBe('found');
    if (wrapped?.kind === 'found') {
      expect(wrapped.bodyOverride).toBe(REWRITTEN_BODY);
    }

    // Exported dep routes are inherited; route-private ones are not.
    expect(byPath.get('/page.html')?.kind).toBe('found');
    expect(byPath.get('/internal.js')?.kind).toBe('not-found');

    // Rules rebuilt after a browser restart keep resolving the composite.
    dnr.clear();
    await service.onStartup();
    expect(dnr.rules.size).toBe(1);
    results = await service.resolve(parentCapId, [
      '/vendor/core/app.js',
      '/page.html',
    ]);
    expect(results.map((result) => result.kind)).toEqual(['found', 'found']);
  });

  it('sweeps a dependency together with its expired parent', async () => {
    let now = 1_000_000;
    const { service, storage, fileStore, dnr } = makeService(() => now);
    const opened = await service.openFromDataUri(
      dataUriOf(COMPOSITE_PARENT_CAP),
    );
    if (!opened.ok) throw new Error('open failed');
    const added = await service.addDependencyFromDataUri(
      opened.info.capId,
      dataUriOf(COMPOSITE_CORE_CAP),
    );
    if (!added.ok) throw new Error('dep add failed');

    now += 31 * 60 * 1000;
    const swept = await service.sweepExpired();
    expect(swept).toEqual([opened.info.capId]);
    expect(dnr.rules.size).toBe(0);
    // The dependency's bytes went with its parent.
    expect(fileStore.packages.size).toBe(0);
    expect(storage.keys().filter((key) => key.includes('.pkg.'))).toEqual([]);
    expect(await new PackageStore(storage, fileStore).listIndex()).toEqual([]);
  });
});
