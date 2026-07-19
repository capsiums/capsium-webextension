import { describe, expect, it } from 'vitest';
import {
  isDependencyResourceRef,
  parseDependencyResourceRef,
  resolveDependencyResource,
  CAPSIUM_SCHEME,
} from '../src/lib/composite';
import {
  buildCompositeRuleSpecs,
  buildDependencyRuleSpecs,
  OWN_PRIORITY,
  DEPENDENCY_PRIORITY,
  type InstalledDependencyView,
} from '../src/lib/serving';
import { buildRules } from '../src/lib/dnr';
import { parseRoutes, parseStorage } from '../src/lib/model';
import { PackageLoader } from '../src/lib/package-loader';
import { CapsiumService } from '../src/lib/background-service';
import { PackageStore } from '../src/lib/store';
import { DnrRuleManager } from '../src/lib/dnr';
import { decodeBase64, encodeBase64 } from '../src/lib/base64';
import { generatedFixtureBytes } from './helpers/fixtures';
import {
  CANONICAL_CAP,
  COMPOSITE_PARENT_CAP,
  COMPOSITE_CORE_CAP,
  CORE_GUID,
  CORE_APP_JS,
  REWRITTEN_BODY,
} from './fixtures/global-setup';
import { FakeDnr, FakeRewriter, FakeStorage, FakeTabs } from './helpers/fakes';

const enc = new TextEncoder();
const dec = new TextDecoder();

function fileMap(
  entries: Record<string, string>,
): Map<string, { contentType: string; base64: string }> {
  return new Map(
    Object.entries(entries).map(([path, text]) => [
      path,
      { contentType: 'text/javascript', base64: encodeBase64(enc.encode(text)) },
    ]),
  );
}

function coreView(): InstalledDependencyView {
  return {
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
        { path: '/internal.js', resource: 'content/app.js', visibility: 'private' },
      ],
    }),
    storage: null,
    tombstones: {},
    files: fileMap({
      'content/app.js': CORE_APP_JS,
      'content/secret.js': 'secret',
      'content/page.html': '<p>core</p>',
    }),
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
    expect(
      resolveDependencyResource(coreView(), 'content/ghost.js').kind,
    ).toBe('not-found');
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
      files: fileMap({
        'base/content/app.js': 'base',
        'updates/content/app.js': 'updated',
      }),
      filePaths: ['base/content/app.js', 'updates/content/app.js'],
    };
    expect(resolveDependencyResource(layered, 'content/app.js')).toEqual({
      kind: 'found',
      path: 'base/content/app.js',
    });
  });
});

describe('composite rule specs (§4a)', () => {
  const parentRoutes = parseRoutes({
    routes: [
      { path: '/', resource: 'content/index.html' },
      { path: '/vendor/app.js', resource: `${CORE_GUID}/content/app.js` },
      { path: '/secret.js', resource: `${CORE_GUID}/content/secret.js` },
    ],
  });
  const parentView = {
    routes: parentRoutes,
    storage: null,
    tombstones: {},
    files: fileMap({ 'content/index.html': '<p>parent</p>' }),
  };

  it('resolves capsium:// refs only when the dependency is installed', () => {
    const withoutDep = buildCompositeRuleSpecs(parentView, []);
    expect(withoutDep.map((spec) => spec.path)).toEqual(['/']);

    const withDep = buildCompositeRuleSpecs(parentView, [coreView()]);
    const paths = withDep.map((spec) => spec.path);
    expect(paths).toContain('/vendor/app.js');
    // private resource of the dependency is never served
    expect(paths).not.toContain('/secret.js');
  });

  it('serves own routes above inherited dependency routes', () => {
    const specs = buildCompositeRuleSpecs(parentView, [coreView()]);
    const own = specs.find((spec) => spec.path === '/');
    const inherited = specs.find((spec) => spec.path === '/app.js');
    expect(own?.priority).toBe(OWN_PRIORITY);
    expect(inherited?.priority).toBe(DEPENDENCY_PRIORITY);
    // route-private dep route is not inherited
    expect(specs.some((spec) => spec.path === '/internal.js')).toBe(false);
  });

  it('honors remap and responseRewrite.body, and emits header companions', () => {
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
    const specs = buildCompositeRuleSpecs(
      { routes, storage: null, tombstones: {}, files: new Map() },
      [coreView()],
    );
    const spec = specs.find((entry) => entry.path === '/vendor/wrapped.js');
    expect(spec).toBeDefined();
    if (spec === undefined) throw new Error('unreachable');
    expect(dec.decode(decodeBase64(spec.dataUri.split(',')[1] ?? ''))).toBe(
      REWRITTEN_BODY,
    );
    expect(spec.requestHeaders).toEqual({ 'X-Q': '2' });
    expect(spec.responseHeaders).toEqual({ 'X-R': '1' });

    const rules = buildRules(
      '11111111-1111-4111-8111-111111111111',
      specs,
      0,
    );
    const headerRule = rules.find(
      (rule) =>
        rule.action.type === 'modifyHeaders' &&
        rule.condition.regexFilter.includes('wrapped'),
    );
    expect(headerRule).toBeDefined();
    if (headerRule?.action.type === 'modifyHeaders') {
      expect(headerRule.action.requestHeaders).toEqual([
        { header: 'X-Q', operation: 'set', value: '2' },
      ]);
      expect(headerRule.action.responseHeaders).toEqual([
        { header: 'X-R', operation: 'set', value: '1' },
      ]);
    }
  });

  it('buildDependencyRuleSpecs serves only exported routes/resources', () => {
    const specs = buildDependencyRuleSpecs(coreView());
    expect(specs.map((spec) => spec.path)).toEqual(['/app.js']);
  });
});

describe('CapsiumService — composite end to end', () => {
  function makeService(now: () => number = Date.now) {
    const storage = new FakeStorage();
    const dnr = new FakeDnr();
    const tabs = new FakeTabs();
    const service = new CapsiumService({
      loader: new PackageLoader(),
      store: new PackageStore(storage, now),
      rules: new DnrRuleManager(dnr, storage),
      rewriter: new FakeRewriter(),
      tabs,
      now,
    });
    return { service, storage, dnr, tabs };
  }

  const dataUriOf = (name: string): string =>
    `data:application/vnd.capsium.package;base64,${encodeBase64(
      generatedFixtureBytes(name),
    )}`;

  function redirectBodies(dnr: FakeDnr): Map<string, string> {
    const out = new Map<string, string>();
    const marker = '\\.cap';
    for (const rule of dnr.rules.values()) {
      if (rule.action.type !== 'redirect') continue;
      const filter = rule.condition.regexFilter;
      const start = filter.indexOf(marker) + marker.length;
      const end = filter.indexOf('(\\?.*)?$');
      const path = filter.slice(start, end).replace(/\\(.)/g, '$1');
      out.set(
        path,
        dec.decode(decodeBase64(rule.action.redirect.url.split(',')[1] ?? '')),
      );
    }
    return out;
  }

  it('lists declared dependencies, installs them in-session, serves exported only', async () => {
    const { service, dnr } = makeService();
    const opened = await service.openFromDataUri(
      dataUriOf(COMPOSITE_PARENT_CAP),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.info.dependencies).toEqual([
      { guid: CORE_GUID, range: '>=1.0.0', status: 'missing' },
    ]);
    // Only the parent's own routes are served so far (refs unresolved).
    let bodies = redirectBodies(dnr);
    expect([...bodies.keys()].sort()).toEqual(['/', '/index.html']);

    // A package whose guid is not declared is refused.
    const wrong = await service.addDependencyFromDataUri(
      opened.info.capId,
      dataUriOf(CANONICAL_CAP),
    );
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error).toMatch(/not a declared dependency/);

    // Install the real dependency.
    const added = await service.addDependencyFromDataUri(
      opened.info.capId,
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

    bodies = redirectBodies(dnr);
    // Parent ref routes now resolve; private ones stay unserved.
    expect(bodies.get('/vendor/core/app.js')).toBe(CORE_APP_JS);
    expect(bodies.has('/secret.js')).toBe(false);
    // responseRewrite.body is baked into the served body.
    expect(bodies.get('/wrapped.js')).toBe(REWRITTEN_BODY);
    // Exported dep routes are inherited; route-private ones are not.
    expect(bodies.get('/page.html')).toContain('core page');
    expect(bodies.has('/internal.js')).toBe(false);
    // Companion modifyHeaders rules exist for the rewritten route.
    expect(
      [...dnr.rules.values()].some((rule) => rule.action.type === 'modifyHeaders'),
    ).toBe(true);

    // Rules rebuilt after a browser restart keep serving the composite.
    dnr.clear();
    await service.onStartup();
    bodies = redirectBodies(dnr);
    expect(bodies.get('/vendor/core/app.js')).toBe(CORE_APP_JS);
    expect(bodies.get('/page.html')).toContain('core page');
  });

  it('sweeps a dependency together with its expired parent', async () => {
    let now = 1_000_000;
    const { service, storage, dnr } = makeService(() => now);
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
    // The dependency's storage went with its parent.
    expect(
      storage.keys().filter((key) => key.includes('.pkg.')),
    ).toEqual([]);
    expect(await new PackageStore(storage).listIndex()).toEqual([]);
  });
});
