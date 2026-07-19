// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  applyResponseHeaders,
  BlobUrlRegistry,
  buildFetchShimScript,
  capOriginOf,
  collectAssetUrls,
  SandboxRenderer,
  substituteAssetUrls,
  type SandboxPorts,
} from '../src/lib/sandbox-page';
import { runRouter, type RouterPorts } from '../src/lib/router-page';
import type { SandboxServeMessage } from '../src/lib/messages';
import { FakeBlobUrls, FakeFileStore } from './helpers/fakes';

const CAP = '11111111-1111-4111-8111-111111111111';
const ORIGIN = capOriginOf(CAP);

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('collectAssetUrls', () => {
  it('collects absolute package URLs of subresources (srcset included)', () => {
    const doc = parse(`<html><head>
      <link rel="stylesheet" href="${ORIGIN}/style.css">
      <script src="${ORIGIN}/app.js"></script>
      </head><body>
      <img src="${ORIGIN}/a.png" srcset="${ORIGIN}/a.png 1x, ${ORIGIN}/a@2x.png 2x">
      <img src="https://cdn.example.com/x.png">
      <img src="data:image/png;base64,AA==">
      <a href="${ORIGIN}/other.html">not an asset</a>
      <iframe src="${ORIGIN}/frame.html">not an asset</iframe>
      </body></html>`);
    const urls = collectAssetUrls(doc, ORIGIN, `${ORIGIN}/`);
    expect(urls.sort()).toEqual([
      `${ORIGIN}/a.png`,
      `${ORIGIN}/a@2x.png`,
      `${ORIGIN}/app.js`,
      `${ORIGIN}/style.css`,
    ]);
  });

  it('resolves relative references against the base URL', () => {
    const doc = parse('<img src="a.png"><img src="../shared/b.png">');
    const urls = collectAssetUrls(doc, ORIGIN, `${ORIGIN}/documents/report/`);
    expect(urls.sort()).toEqual([
      `${ORIGIN}/documents/report/a.png`,
      `${ORIGIN}/documents/shared/b.png`,
    ]);
  });
});

describe('substituteAssetUrls', () => {
  it('swaps package URLs for blob: URLs, preserving srcset descriptors', () => {
    const doc = parse(
      `<img src="${ORIGIN}/a.png" srcset="${ORIGIN}/a.png 1x, ${ORIGIN}/a@2x.png 2x, https://cdn.example.com/x.png 3x">`,
    );
    const replacements = new Map([
      [`${ORIGIN}/a.png`, 'blob:fake/1'],
      [`${ORIGIN}/a@2x.png`, 'blob:fake/2'],
    ]);
    const count = substituteAssetUrls(doc, ORIGIN, `${ORIGIN}/`, replacements);
    expect(count).toBe(2);
    const img = doc.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('blob:fake/1');
    expect(img.getAttribute('srcset')).toBe(
      'blob:fake/1 1x, blob:fake/2 2x, https://cdn.example.com/x.png 3x',
    );
  });
});

describe('applyResponseHeaders', () => {
  it('injects a CSP meta tag; drops headers blob: documents cannot carry', () => {
    const doc = parse('<html><head></head><body></body></html>');
    applyResponseHeaders(doc, {
      'Content-Security-Policy': "default-src 'none'",
      'X-Custom': 'dropped',
    });
    const metas = doc.querySelectorAll('meta[http-equiv]');
    expect(metas).toHaveLength(1);
    expect(metas[0]?.getAttribute('content')).toBe("default-src 'none'");
  });
});

describe('buildFetchShimScript', () => {
  it('embeds the package origin and the bridge protocol', () => {
    const shim = buildFetchShimScript(ORIGIN);
    expect(shim).toContain(JSON.stringify(ORIGIN));
    expect(shim).toContain('capsium.bridge.fetch');
    expect(shim).toContain('capsium.bridge.navigate');
  });
});

describe('BlobUrlRegistry', () => {
  it('mints typed blob URLs and revokes them all', () => {
    const blobUrls = new FakeBlobUrls();
    const registry = new BlobUrlRegistry(blobUrls);
    const url = registry.create(new Uint8Array([1, 2]), 'image/png');
    const blob = blobUrls.live.get(url);
    expect(blob?.type).toBe('image/png');
    expect(registry.size).toBe(1);

    registry.revokeAll();
    expect(registry.size).toBe(0);
    expect(blobUrls.revoked).toEqual([url]);
    expect(blobUrls.live.size).toBe(0);
  });
});

/* ------------------------------------------------------------ */
/* SandboxRenderer                                               */
/* ------------------------------------------------------------ */

function makeRenderer(assets: Record<string, { contentType: string; body: Uint8Array | string }>) {
  const blobUrls = new FakeBlobUrls();
  const renderedDocuments: string[] = [];
  const renderedUrls: string[] = [];
  const requests: string[][] = [];
  const ports: SandboxPorts = {
    requestAssets: (_capId, urls) => {
      requests.push(urls);
      return Promise.resolve(
        urls.map((url) => {
          const asset = assets[url];
          return asset === undefined
            ? { url, found: false }
            : { url, found: true, contentType: asset.contentType, body: asset.body };
        }),
      );
    },
    blobUrls,
    renderDocument: (html) => renderedDocuments.push(html),
    renderBlobUrl: (url) => renderedUrls.push(url),
  };
  return { renderer: new SandboxRenderer(ports), blobUrls, renderedDocuments, renderedUrls, requests };
}

function serveMessage(overrides: Partial<SandboxServeMessage>): SandboxServeMessage {
  return {
    type: 'capsium.sandbox.serve',
    capId: CAP,
    path: '/',
    contentType: 'text/html',
    body: '<p>hi</p>',
    baseUrl: `${ORIGIN}/`,
    ...overrides,
  };
}

describe('SandboxRenderer', () => {
  it('proxies HTML subresources to blob: URLs and renders the document', async () => {
    const css = 'body { color: red; }';
    const { renderer, blobUrls, renderedDocuments, requests } = makeRenderer({
      [`${ORIGIN}/style.css`]: {
        contentType: 'text/css',
        body: new TextEncoder().encode(css),
      },
    });
    await renderer.serve(
      serveMessage({
        body: `<html><head><link rel="stylesheet" href="${ORIGIN}/style.css"></head><body><h1>Hi</h1></body></html>`,
      }),
    );

    // One render, one asset request batch.
    expect(renderedDocuments).toHaveLength(1);
    expect(requests).toEqual([[`${ORIGIN}/style.css`]]);

    const html = renderedDocuments[0]!;
    // The stylesheet reference was swapped for a typed blob: URL…
    const linkMatch = /href="(blob:[^"]+)"/.exec(html);
    expect(linkMatch).not.toBeNull();
    const linkBlob = blobUrls.live.get(linkMatch![1]!);
    expect(linkBlob?.type).toBe('text/css');
    expect(await linkBlob!.text()).toBe(css);
    // …and the fetch/navigation shim was injected as the FIRST head script.
    const firstScript = /<head><script>([\s\S]*?)<\/script>/.exec(html);
    expect(firstScript?.[1]).toContain('capsium.bridge.fetch');
  });

  it('serves non-HTML bytes byte-identically with the exact MIME type', async () => {
    const { renderer, blobUrls, renderedUrls, requests } = makeRenderer({});
    const bytes = new Uint8Array(256).map((_, index) => 255 - index);
    await renderer.serve(
      serveMessage({
        path: '/manual.pdf',
        contentType: 'application/pdf',
        body: bytes,
      }),
    );

    expect(requests).toEqual([]); // no asset pass for non-HTML
    expect(renderedUrls).toHaveLength(1);
    const blob = blobUrls.live.get(renderedUrls[0]!);
    expect(blob?.type).toBe('application/pdf');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
  });

  it('revokes the previous document’s blob URLs on the next serve', async () => {
    const { renderer, blobUrls } = makeRenderer({
      [`${ORIGIN}/a.png`]: {
        contentType: 'image/png',
        body: new Uint8Array([1]),
      },
    });
    await renderer.serve(serveMessage({ body: `<img src="${ORIGIN}/a.png">` }));
    expect(blobUrls.live.size).toBe(1);
    const first = [...blobUrls.live.keys()][0]!;

    await renderer.serve(serveMessage({ body: '<p>two</p>' }));
    expect(blobUrls.live.has(first)).toBe(false);
    expect(blobUrls.revoked).toContain(first);
    expect(blobUrls.live.size).toBe(0);
  });

  it('leaves unresolved asset URLs untouched (the router 404 covers them)', async () => {
    const { renderer, renderedDocuments } = makeRenderer({});
    await renderer.serve(
      serveMessage({
        body: `<img src="${ORIGIN}/ghost.png">`,
      }),
    );
    expect(renderedDocuments[0]).toContain(`${ORIGIN}/ghost.png`);
  });
});

describe('router path end to end (file store -> router -> sandbox -> blob)', () => {
  it('serves a binary file byte-identically with its stored MIME type', async () => {
    // Every byte value, reversed — a binary-safety canary through the
    // whole pipeline (resolution, store read, serve message, blob mint).
    const bytes = new Uint8Array(256).map((_, index) => 255 - index);
    const fileStore = new FakeFileStore();
    await fileStore.put(CAP, 'content/blob.bin', bytes);

    const blobUrls = new FakeBlobUrls();
    const renderedUrls: string[] = [];
    const renderer = new SandboxRenderer({
      requestAssets: () => Promise.resolve([]),
      blobUrls,
      renderDocument: () => undefined,
      renderBlobUrl: (url) => renderedUrls.push(url),
    });

    const ports: RouterPorts = {
      resolve: () =>
        Promise.resolve([
          {
            path: '/blob.bin',
            kind: 'found',
            store: 'opfs',
            fileCapId: CAP,
            filePath: 'content/blob.bin',
            contentType: 'application/octet-stream',
          },
        ]),
      fileStoreFor: () => Promise.resolve(fileStore),
      openTab: () => Promise.resolve(),
      serve: (message) => void renderer.serve(message),
      answerAssets: () => undefined,
      answerFetch: () => undefined,
      renderLocked: () => undefined,
      renderNotFound: () => undefined,
      renderError: () => undefined,
      navigate: () => undefined,
    };
    await runRouter(ports, `#/serve/${CAP}/blob.bin`);
    // runRouter's serve is fire-and-forget; let the renderer settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renderedUrls).toHaveLength(1);
    const blob = blobUrls.live.get(renderedUrls[0]!);
    expect(blob?.type).toBe('application/octet-stream');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
  });
});
