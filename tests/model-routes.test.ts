import { describe, expect, it } from 'vitest';
import {
  generateRoutes,
  parseManifest,
  parseRoutes,
  ModelError,
  type Route,
} from '../src/lib/model';

describe('parseRoutes', () => {
  it('parses the canonical array form with an index (§4)', () => {
    const routes = parseRoutes({
      index: 'content/index.html',
      routes: [
        { path: '/', resource: 'content/index.html' },
        { path: '/api/v1/data/animals', dataset: 'animals' },
        {
          path: '/compute',
          method: 'POST',
          handler: 'handlers/compute.js',
          extra: 1,
        },
      ],
    });
    expect(routes.index).toBe('content/index.html');
    expect(routes.routes).toHaveLength(3);
    const [root, dataset, handler] = routes.routes;
    expect(root && 'resource' in root ? root.resource : null).toBe(
      'content/index.html',
    );
    expect(dataset && 'dataset' in dataset ? dataset.dataset : null).toBe(
      'animals',
    );
    expect(handler && 'handler' in handler ? handler.method : null).toBe(
      'POST',
    );
  });

  it('normalizes the legacy gem form {path, target:{file}}', () => {
    const routes = parseRoutes({
      routes: [
        { path: '/', target: { file: 'index.html' } },
        { path: '/example.css', target: { file: 'example.css' } },
      ],
    });
    expect(routes.routes).toEqual([
      { path: '/', resource: 'content/index.html' },
      { path: '/example.css', resource: 'content/example.css' },
    ]);
  });

  it('accepts the object-keyed-by-path form', () => {
    const routes = parseRoutes({
      routes: {
        '/': { resource: 'content/index.html' },
        '/api/v1/data/animals': { dataset: 'animals' },
      },
    });
    expect(routes.routes).toHaveLength(2);
    expect(routes.routes[0]).toEqual({
      path: '/',
      resource: 'content/index.html',
    });
  });

  it('rejects dataset routes outside /api/v1/data/', () => {
    expect(() =>
      parseRoutes({ routes: [{ path: '/data/x', dataset: 'x' }] }),
    ).toThrow(ModelError);
  });
});

describe('generateRoutes (§4 rules)', () => {
  it('golden: bare legacy package manifest regenerates its shipped routes', () => {
    // The legacy bare_package fixture ships exactly these routes.
    const manifest = parseManifest({
      content: [
        { file: 'example.css', mime: 'text/css' },
        { file: 'example.js', mime: 'application/javascript' },
        { file: 'index.html', mime: 'text/html' },
      ],
    });
    const generated = generateRoutes(manifest, null);
    expect(generated.index).toBe('content/index.html');
    // Same set of routes the legacy package ships (order is unspecified).
    const byPath = (a: { path: string }, b: { path: string }): number =>
      a.path.localeCompare(b.path);
    expect([...generated.routes].sort(byPath)).toEqual(
      [
        { path: '/', resource: 'content/index.html' },
        { path: '/index', resource: 'content/index.html' },
        { path: '/index.html', resource: 'content/index.html' },
        { path: '/example.css', resource: 'content/example.css' },
        { path: '/example.js', resource: 'content/example.js' },
      ].sort(byPath),
    );
  });

  it('gives nested HTML dual routes and non-HTML single routes', () => {
    const manifest = parseManifest({
      resources: {
        'content/page/about.html': {
          type: 'text/html',
          visibility: 'exported',
        },
        'content/assets/pixel.png': {
          type: 'image/png',
          visibility: 'exported',
        },
      },
    });
    const paths = generateRoutes(manifest, null).routes.map(
      (route: Route) => route.path,
    );
    expect(paths.sort()).toEqual([
      '/assets/pixel.png',
      '/page/about',
      '/page/about.html',
    ]);
  });

  it('adds dataset routes under /api/v1/data/', () => {
    const manifest = parseManifest({
      resources: {
        'content/index.html': { type: 'text/html', visibility: 'exported' },
      },
    });
    const generated = generateRoutes(manifest, {
      storage: { dataSets: { animals: { source: 'data/animals.json' } } },
    });
    expect(generated.routes).toContainEqual({
      path: '/api/v1/data/animals',
      dataset: 'animals',
    });
  });
});
