import { describe, expect, it } from 'vitest';
import {
  handleSandboxMessage,
  parseCapUrl,
  parseServeHash,
  routerUrlFor,
  runRouter,
  serveBaseUrl,
  serveHashFor,
  UNAUTHORIZED_BODY,
  type RouterPorts,
} from '../src/lib/router-page';
import {
  SANDBOX_SERVE_TYPE,
  type ResolveResult,
  type SandboxServeMessage,
} from '../src/lib/messages';
import { FakeFileStore } from './helpers/fakes';

const CAP = '11111111-1111-4111-8111-111111111111';
const ROUTER = 'chrome-extension://ext-id/router.html';

describe('parseServeHash / serveHashFor', () => {
  it('parses the router hash into capId + decoded path', () => {
    expect(parseServeHash(`#/serve/${CAP}/assets/app.js`)).toEqual({
      capId: CAP,
      path: '/assets/app.js',
    });
    expect(parseServeHash(`#/serve/${CAP}/`)).toEqual({ capId: CAP, path: '/' });
    expect(parseServeHash(`#/serve/${CAP}`)).toEqual({ capId: CAP, path: '/' });
    expect(parseServeHash(`#/serve/${CAP}/a%20b.png`)).toEqual({
      capId: CAP,
      path: '/a b.png',
    });
  });

  it('rejects foreign hashes', () => {
    expect(parseServeHash('')).toBeNull();
    expect(parseServeHash('#/other')).toBeNull();
    expect(parseServeHash('#/serve/')).toBeNull();
  });

  it('round-trips with serveHashFor', () => {
    const hash = serveHashFor(CAP, '/assets/a b.png');
    expect(hash).toBe(`#/serve/${CAP}/assets/a%20b.png`);
    expect(parseServeHash(hash)).toEqual({ capId: CAP, path: '/assets/a b.png' });
  });
});

describe('parseCapUrl', () => {
  it('parses absolute package URLs (query and fragment dropped)', () => {
    expect(parseCapUrl(`https://${CAP}.cap/documents/report/?x=1`)).toEqual({
      capId: CAP,
      path: '/documents/report/',
    });
    expect(parseCapUrl(`https://${CAP}.cap`)).toEqual({ capId: CAP, path: '/' });
  });

  it('rejects foreign URLs', () => {
    expect(parseCapUrl('https://example.com/')).toBeNull();
    expect(parseCapUrl('blob:https://x/y')).toBeNull();
  });
});

describe('serveBaseUrl', () => {
  it('is the URL-space directory of the served path', () => {
    expect(serveBaseUrl(CAP, '/documents/report/index.html')).toBe(
      `https://${CAP}.cap/documents/report/`,
    );
    expect(serveBaseUrl(CAP, '/index.html')).toBe(`https://${CAP}.cap/`);
  });
});

/* ------------------------------------------------------------ */
/* runRouter orchestration                                       */
/* ------------------------------------------------------------ */

interface Harness {
  ports: RouterPorts;
  fileStore: FakeFileStore;
  served: SandboxServeMessage[];
  locked: number;
  notFound: string[];
  errors: string[];
  navigations: string[];
  tabs: string[];
  assetAnswers: unknown[];
  fetchAnswers: unknown[];
  resolutions: ResolveResult[];
}

function harness(resolutions: ResolveResult[]): Harness {
  const fileStore = new FakeFileStore();
  const state: Harness = {
    fileStore,
    served: [],
    locked: 0,
    notFound: [],
    errors: [],
    navigations: [],
    tabs: [],
    assetAnswers: [],
    fetchAnswers: [],
    resolutions,
    ports: null as unknown as RouterPorts,
  };
  state.ports = {
    resolve: () => Promise.resolve(state.resolutions),
    fileStoreFor: () => Promise.resolve(fileStore),
    openTab: (url) => {
      state.tabs.push(url);
      return Promise.resolve();
    },
    serve: (message) => state.served.push(message),
    answerAssets: (message) => state.assetAnswers.push(message),
    answerFetch: (message) => state.fetchAnswers.push(message),
    renderLocked: () => {
      state.locked += 1;
    },
    renderNotFound: (capId, path) => state.notFound.push(`${capId}${path}`),
    renderError: (message) => state.errors.push(message),
    navigate: (hash) => state.navigations.push(hash),
  };
  return state;
}

const foundResult = (overrides: Partial<ResolveResult> = {}): ResolveResult => ({
  path: '/',
  kind: 'found',
  store: 'opfs',
  fileCapId: CAP,
  filePath: 'content/index.html',
  contentType: 'text/html',
  ...overrides,
});

describe('runRouter', () => {
  it('serves stored bytes to the sandbox with the resolved MIME type', async () => {
    const h = harness([foundResult()]);
    await h.fileStore.put(CAP, 'content/index.html', new Uint8Array([1, 2, 3]));
    await runRouter(h.ports, `#/serve/${CAP}/`);

    expect(h.served).toHaveLength(1);
    const message = h.served[0]!;
    expect(message.type).toBe(SANDBOX_SERVE_TYPE);
    expect(message.capId).toBe(CAP);
    expect(message.contentType).toBe('text/html');
    expect(message.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(message.baseUrl).toBe(`https://${CAP}.cap/`);
    expect(h.locked).toBe(0);
    expect(h.notFound).toEqual([]);
  });

  it('prefers the §4a bodyOverride over stored bytes', async () => {
    const h = harness([foundResult({ bodyOverride: '// wrapped' })]);
    await runRouter(h.ports, `#/serve/${CAP}/`);
    expect(h.served[0]?.body).toBe('// wrapped');
  });

  it('renders the 401 body for locked packages (§4b)', async () => {
    const h = harness([{ path: '/', kind: 'locked' }]);
    await runRouter(h.ports, `#/serve/${CAP}/`);
    expect(h.locked).toBe(1);
    expect(h.served).toHaveLength(0);
    expect(UNAUTHORIZED_BODY).toBe('authentication required');
  });

  it('renders 404 for unknown paths, missing bytes and bad hashes', async () => {
    const h = harness([{ path: '/nope', kind: 'not-found' }]);
    await runRouter(h.ports, `#/serve/${CAP}/nope`);
    expect(h.notFound).toEqual([`${CAP}/nope`]);

    const h2 = harness([foundResult()]); // store is empty: bytes vanished
    await runRouter(h2.ports, `#/serve/${CAP}/`);
    expect(h2.notFound).toEqual([`${CAP}/`]);

    const h3 = harness([]);
    await runRouter(h3.ports, '#/junk');
    expect(h3.errors).toHaveLength(1);
  });
});

describe('handleSandboxMessage', () => {
  it('answers asset batches with bytes from the file store', async () => {
    const css = foundResult({
      path: '/example.css',
      filePath: 'content/example.css',
      contentType: 'text/css',
    });
    const h = harness([css, { path: '/ghost.png', kind: 'not-found' }]);
    await h.fileStore.put(CAP, 'content/example.css', new Uint8Array([9, 9]));

    const consumed = await handleSandboxMessage(h.ports, ROUTER, {
      type: 'capsium.sandbox.assets',
      requestId: 'a1',
      capId: CAP,
      urls: [`https://${CAP}.cap/example.css`, `https://${CAP}.cap/ghost.png`],
    });
    expect(consumed).toBe(true);
    expect(h.assetAnswers).toEqual([
      {
        type: 'capsium.sandbox.assets.result',
        requestId: 'a1',
        assets: [
          {
            url: `https://${CAP}.cap/example.css`,
            found: true,
            contentType: 'text/css',
            body: new Uint8Array([9, 9]),
          },
          { url: `https://${CAP}.cap/ghost.png`, found: false },
        ],
      },
    ]);
  });

  it('answers fetch-bridge requests (packaged XHR/fetch to the .cap origin)', async () => {
    const h = harness([foundResult({ contentType: 'application/json' })]);
    await h.fileStore.put(CAP, 'content/index.html', new Uint8Array([123]));

    const consumed = await handleSandboxMessage(h.ports, ROUTER, {
      type: 'capsium.bridge.fetch',
      requestId: 'f1',
      url: `https://${CAP}.cap/`,
    });
    expect(consumed).toBe(true);
    expect(h.fetchAnswers).toEqual([
      {
        type: 'capsium.bridge.fetch.result',
        requestId: 'f1',
        found: true,
        contentType: 'application/json',
        body: new Uint8Array([123]),
      },
    ]);

    // Unparseable URLs and uninstalled packages answer found:false.
    await handleSandboxMessage(h.ports, ROUTER, {
      type: 'capsium.bridge.fetch',
      requestId: 'f2',
      url: 'https://example.com/x',
    });
    expect(h.fetchAnswers[1]).toMatchObject({ requestId: 'f2', found: false });
  });

  it('routes in-package navigations: hash re-serve or a real tab', async () => {
    const h = harness([]);
    await handleSandboxMessage(h.ports, ROUTER, {
      type: 'capsium.bridge.navigate',
      url: `https://${CAP}.cap/other.html`,
      blank: false,
    });
    expect(h.navigations).toEqual([`#/serve/${CAP}/other.html`]);

    await handleSandboxMessage(h.ports, ROUTER, {
      type: 'capsium.bridge.navigate',
      url: `https://${CAP}.cap/other.html`,
      blank: true,
    });
    expect(h.tabs).toEqual([
      routerUrlFor(ROUTER, { capId: CAP, path: '/other.html' }),
    ]);
  });

  it('ignores foreign messages', async () => {
    const h = harness([]);
    expect(await handleSandboxMessage(h.ports, ROUTER, { type: 'junk' })).toBe(
      false,
    );
  });
});
