import { describe, expect, it } from 'vitest';
import {
  resolveUrlPath,
  validateRoutes,
  UNAUTHORIZED_BODY,
  type InstalledDependencyView,
  type PackageServingView,
} from '../src/lib/resolver';
import { parseRoutes, parseStorage } from '../src/lib/model';

const CAP = '11111111-1111-4111-8111-111111111111';
const DEP_CAP = '22222222-2222-4222-8222-222222222222';
const DEP_GUID = 'capsium://example.com/core';

function view(partial: Partial<PackageServingView> = {}): PackageServingView {
  return {
    capId: CAP,
    routes: { routes: [] },
    storage: null,
    tombstones: {},
    fileTypes: {},
    ...partial,
  };
}

function depView(partial: Partial<InstalledDependencyView> = {}): InstalledDependencyView {
  return {
    ...view({ capId: DEP_CAP }),
    guid: DEP_GUID,
    manifest: { resources: {} },
    filePaths: [],
    ...partial,
  };
}

describe('resolveUrlPath — own routes', () => {
  const pkg = view({
    routes: parseRoutes({
      routes: [
        { path: '/', resource: 'content/index.html' },
        { path: '/api/v1/data/animals', dataset: 'animals' },
        { path: '/compute', method: 'POST', handler: 'h.js' },
        { path: '/old.js', resource: 'content/app.js', remap: '/vendor/app.js' },
      ],
    }),
    storage: parseStorage({
      storage: { dataSets: { animals: { source: 'data/animals.json' } } },
    }),
    fileTypes: {
      'content/index.html': 'text/html',
      'data/animals.json': 'application/json',
      'content/app.js': 'text/javascript',
    },
  });

  it('resolves static and dataset routes, byte-free', () => {
    expect(resolveUrlPath(pkg, [], '/')).toEqual({
      kind: 'found',
      file: { capId: CAP, path: 'content/index.html', contentType: 'text/html' },
    });
    expect(resolveUrlPath(pkg, [], '/api/v1/data/animals')).toEqual({
      kind: 'found',
      file: {
        capId: CAP,
        path: 'data/animals.json',
        contentType: 'application/json',
      },
    });
  });

  it('honors remap (the matched path is the remapped one)', () => {
    expect(resolveUrlPath(pkg, [], '/vendor/app.js')).toEqual({
      kind: 'found',
      file: {
        capId: CAP,
        path: 'content/app.js',
        contentType: 'text/javascript',
      },
    });
    expect(resolveUrlPath(pkg, [], '/old.js').kind).toBe('not-found');
  });

  it('resolves unknown paths and handler routes as not-found', () => {
    expect(resolveUrlPath(pkg, [], '/nope').kind).toBe('not-found');
    expect(resolveUrlPath(pkg, [], '/compute').kind).toBe('not-found');
  });
});

describe('resolveUrlPath — inheritance attributes (§4a)', () => {
  it('carries responseRewrite.body as a body override and merges headers', () => {
    const pkg = view({
      routes: parseRoutes({
        routes: [
          {
            path: '/wrapped.js',
            resource: 'content/app.js',
            responseRewrite: { body: '// wrapped', headers: { 'X-R': '1', 'X-B': 'r' } },
            responseHeaders: { 'X-B': '2' },
          },
        ],
      }),
      fileTypes: { 'content/app.js': 'text/javascript' },
    });
    expect(resolveUrlPath(pkg, [], '/wrapped.js')).toEqual({
      kind: 'found',
      file: {
        capId: CAP,
        path: 'content/app.js',
        contentType: 'text/javascript',
        bodyOverride: '// wrapped',
        // responseRewrite.headers override same-named responseHeaders.
        responseHeaders: { 'X-R': '1', 'X-B': 'r' },
      },
    });
  });
});

describe('resolveUrlPath — layered storage (§5a)', () => {
  const layered = view({
    routes: parseRoutes({
      routes: [
        { path: '/', resource: 'content/index.html' },
        { path: '/gone', resource: 'content/gone.html' },
      ],
    }),
    storage: parseStorage({
      storage: {
        dataSets: {},
        layers: [{ path: 'base' }, { path: 'updates' }],
      },
    }),
    tombstones: { updates: ['content/gone.html'] },
    fileTypes: {
      'base/content/index.html': 'text/html',
      'updates/content/index.html': 'text/html',
      'base/content/gone.html': 'text/html',
    },
  });

  it('resolves the merged view top -> bottom', () => {
    expect(resolveUrlPath(layered, [], '/')).toEqual({
      kind: 'found',
      file: {
        capId: CAP,
        path: 'updates/content/index.html',
        contentType: 'text/html',
      },
    });
  });

  it('tombstoned paths resolve not-found even when a lower layer has them', () => {
    expect(resolveUrlPath(layered, [], '/gone').kind).toBe('not-found');
  });
});

describe('resolveUrlPath — composite (§4a)', () => {
  const dep = depView({
    manifest: {
      resources: {
        'content/app.js': { type: 'text/javascript', visibility: 'exported' },
        'content/secret.js': { type: 'text/javascript', visibility: 'private' },
      },
    },
    routes: parseRoutes({
      routes: [
        { path: '/app.js', resource: 'content/app.js' },
        { path: '/secret.js', resource: 'content/secret.js' },
        { path: '/internal.js', resource: 'content/app.js', visibility: 'private' },
      ],
    }),
    fileTypes: {
      'content/app.js': 'text/javascript',
      'content/secret.js': 'text/javascript',
    },
    filePaths: ['content/app.js', 'content/secret.js'],
  });

  const parent = view({
    routes: parseRoutes({
      routes: [
        { path: '/', resource: 'content/index.html' },
        { path: '/vendor/app.js', resource: `${DEP_GUID}/content/app.js` },
        { path: '/secret.js', resource: `${DEP_GUID}/content/secret.js` },
        { path: '/missing-dep.js', resource: 'capsium://example.com/other/x.js' },
      ],
    }),
    fileTypes: { 'content/index.html': 'text/html' },
  });

  it('resolves capsium:// refs into the dependency’s store', () => {
    expect(resolveUrlPath(parent, [dep], '/vendor/app.js')).toEqual({
      kind: 'found',
      file: {
        capId: DEP_CAP,
        path: 'content/app.js',
        contentType: 'text/javascript',
      },
    });
  });

  it('never serves private resources or uninstalled dependencies', () => {
    expect(resolveUrlPath(parent, [dep], '/secret.js').kind).toBe('not-found');
    expect(resolveUrlPath(parent, [], '/vendor/app.js').kind).toBe('not-found');
    expect(resolveUrlPath(parent, [dep], '/missing-dep.js').kind).toBe(
      'not-found',
    );
  });

  it('serves exported dependency routes, but the parent’s own routes win', () => {
    expect(resolveUrlPath(parent, [dep], '/app.js')).toEqual({
      kind: 'found',
      file: {
        capId: DEP_CAP,
        path: 'content/app.js',
        contentType: 'text/javascript',
      },
    });
    // route-private dep route is not inherited
    expect(resolveUrlPath(parent, [dep], '/internal.js').kind).toBe(
      'not-found',
    );

    const parentWithClash = view({
      routes: parseRoutes({
        routes: [{ path: '/app.js', resource: 'content/own.js' }],
      }),
      fileTypes: { 'content/own.js': 'text/javascript' },
    });
    expect(resolveUrlPath(parentWithClash, [dep], '/app.js')).toEqual({
      kind: 'found',
      file: { capId: CAP, path: 'content/own.js', contentType: 'text/javascript' },
    });
  });
});

describe('validateRoutes', () => {
  it('throws on a route referencing a missing resource', () => {
    expect(() =>
      validateRoutes(
        view({
          routes: parseRoutes({
            routes: [{ path: '/', resource: 'content/ghost.html' }],
          }),
        }),
      ),
    ).toThrow(/missing resource/);
  });

  it('throws on a route referencing an unknown dataset', () => {
    expect(() =>
      validateRoutes(
        view({
          routes: parseRoutes({
            routes: [{ path: '/api/v1/data/nope', dataset: 'nope' }],
          }),
        }),
      ),
    ).toThrow(/unknown dataset/);
  });

  it('accepts unresolved resources with layered storage (they 404)', () => {
    expect(() =>
      validateRoutes(
        view({
          routes: parseRoutes({
            routes: [{ path: '/', resource: 'content/ghost.html' }],
          }),
          storage: parseStorage({
            storage: { dataSets: {}, layers: [{ path: 'base' }] },
          }),
        }),
      ),
    ).not.toThrow();
  });

  it('skips capsium:// refs (validated at serve time)', () => {
    expect(() =>
      validateRoutes(
        view({
          routes: parseRoutes({
            routes: [
              { path: '/x.js', resource: 'capsium://example.com/core/x.js' },
            ],
          }),
        }),
      ),
    ).not.toThrow();
  });
});

describe('§4b constants', () => {
  it('keeps the 401 body text stable', () => {
    expect(UNAUTHORIZED_BODY).toBe('authentication required');
  });
});
