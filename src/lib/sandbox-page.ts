/**
 * Sandbox page core (/sandbox.html, declared as an MV3 sandbox page on
 * Chrome; iframed with the `sandbox` attribute on Firefox, which does not
 * implement the manifest key — the attribute provides the same opaque
 * origin there).
 *
 * MV3 forbids 'unsafe-inline' (and any extra script sources) in the
 * extension_pages CSP, so packaged scripts can never run inside an
 * extension-page document. Sandbox pages may customize their CSP — they
 * run in an opaque origin without extension APIs — so packaged content is
 * rendered here: HTML is parsed, every subresource reference to the
 * package origin is replaced by a blob: URL minted from stored bytes (the
 * "fetch proxy": bytes arrive structured-cloned from the router, never
 * base64), and the result replaces the sandbox page's own document
 * (document.write) — same origin as the minted blob: URLs, which is what
 * lets them load. Non-HTML resources are navigated to a blob: URL with the
 * correct Content-Type carried by the Blob type.
 *
 * Blob URL lifecycle: every URL minted for a document is revoked when the
 * next document is served or when the page unloads (BlobUrlRegistry); the
 * router swaps in a fresh sandbox page per navigation, which releases the
 * rest.
 *
 * A tiny shim script is injected ahead of packaged scripts: it bridges
 * fetch() calls to the package origin through the router (packaged XHR to
 * package URLs is NOT bridged — see README) and relays in-package link
 * clicks (a blob:-origin frame cannot follow a DNR redirect itself).
 *
 * Pure apart from the global DOMParser (available in sandbox pages and
 * happy-dom); the entrypoint wires the ports.
 */
import type { SandboxServeMessage, ResolvedAssetBody } from './messages';
import type { BlobUrlPort } from './ports';

/** The synthetic origin of a package. */
export function capOriginOf(capId: string): string {
  return `https://${capId}.cap`;
}

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Subresource references rewritten to blob: URLs (NOT <a>/iframe — those navigate). */
const ASSET_TARGETS: ReadonlyArray<readonly [selector: string, attribute: string]> = [
  ['link[href]', 'href'],
  ['script[src]', 'src'],
  ['img[src]', 'src'],
  ['img[srcset]', 'srcset'],
  ['source[src]', 'src'],
  ['source[srcset]', 'srcset'],
  ['audio[src]', 'src'],
  ['video[src]', 'src'],
  ['track[src]', 'src'],
  ['input[type="image"][src]', 'src'],
];

/**
 * Resolve one reference to an absolute package URL, or null when it must be
 * left alone (external, data:/blob:, fragment-only, empty).
 */
function resolveAssetRef(
  ref: string,
  capOrigin: string,
  baseUrl: string,
): string | null {
  const trimmed = ref.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  let absolute = trimmed;
  if (!ABSOLUTE_URL.test(trimmed) && !trimmed.startsWith('//')) {
    try {
      absolute = new URL(trimmed, baseUrl).href;
    } catch {
      return null;
    }
  }
  return absolute.startsWith(`${capOrigin}/`) ? absolute : null;
}

/** srcset value -> list of [url, descriptor] candidates (best effort). */
function parseSrcset(value: string): Array<[url: string, descriptor: string]> {
  return value
    .split(',')
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate !== '')
    .map((candidate) => {
      const firstSpace = candidate.search(/\s/);
      return firstSpace === -1
        ? [candidate, '']
        : [candidate.slice(0, firstSpace), candidate.slice(firstSpace).trim()];
    });
}

/** Absolute package URLs of every subresource referenced by the document. */
export function collectAssetUrls(
  doc: Document,
  capOrigin: string,
  baseUrl: string,
): string[] {
  const urls = new Set<string>();
  for (const [selector, attribute] of ASSET_TARGETS) {
    for (const element of doc.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      if (attribute === 'srcset') {
        for (const [url] of parseSrcset(value)) {
          const resolved = resolveAssetRef(url, capOrigin, baseUrl);
          if (resolved !== null) urls.add(resolved);
        }
      } else {
        const resolved = resolveAssetRef(value, capOrigin, baseUrl);
        if (resolved !== null) urls.add(resolved);
      }
    }
  }
  return [...urls];
}

/** Replace collected references with their blob: URLs. Returns the count. */
export function substituteAssetUrls(
  doc: Document,
  capOrigin: string,
  baseUrl: string,
  replacements: ReadonlyMap<string, string>,
): number {
  let count = 0;
  for (const [selector, attribute] of ASSET_TARGETS) {
    for (const element of doc.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      if (attribute === 'srcset') {
        let changed = false;
        const rebuilt = parseSrcset(value)
          .map(([url, descriptor]) => {
            const resolved = resolveAssetRef(url, capOrigin, baseUrl);
            const blobUrl = resolved === null ? null : replacements.get(resolved);
            if (blobUrl === null || blobUrl === undefined) {
              return descriptor === '' ? url : `${url} ${descriptor}`;
            }
            changed = true;
            return descriptor === '' ? blobUrl : `${blobUrl} ${descriptor}`;
          })
          .join(', ');
        if (changed) {
          element.setAttribute(attribute, rebuilt);
          count += 1;
        }
      } else {
        const resolved = resolveAssetRef(value, capOrigin, baseUrl);
        const blobUrl = resolved === null ? null : replacements.get(resolved);
        if (blobUrl !== null && blobUrl !== undefined) {
          element.setAttribute(attribute, blobUrl);
          count += 1;
        }
      }
    }
  }
  return count;
}

/**
 * §4a response headers, applied where a blob: document allows: only
 * Content-Security-Policy has a <meta> equivalent. Everything else is
 * documented as dropped (the data:-URI core dropped ALL response headers).
 */
export function applyResponseHeaders(
  doc: Document,
  responseHeaders: Record<string, string> | undefined,
): void {
  if (responseHeaders === undefined) return;
  for (const [name, value] of Object.entries(responseHeaders)) {
    if (name.toLowerCase() !== 'content-security-policy') continue;
    const meta = doc.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', value);
    doc.head?.prepend(meta);
  }
}

/**
 * The shim injected ahead of packaged scripts in served HTML:
 *  - fetch() to the package origin is bridged through the router (which
 *    resolves + reads the file store) and answered with a real Response;
 *  - in-package link clicks and window.open() are relayed to the router
 *    (a blob:-origin frame cannot follow the DNR redirect itself).
 */
export function buildFetchShimScript(capOrigin: string): string {
  return `(function () {
'use strict';
var ORIGIN = ${JSON.stringify(capOrigin)};
var seq = 0;
var pending = {};
window.addEventListener('message', function (event) {
  if (event.source !== window.parent) return;
  var data = event.data;
  if (!data || data.type !== 'capsium.bridge.fetch.result') return;
  var resolve = pending[data.requestId];
  if (!resolve) return;
  delete pending[data.requestId];
  resolve(data);
});
function bridge(url) {
  return new Promise(function (resolve) {
    var requestId = 'capsium-fetch-' + (++seq);
    pending[requestId] = resolve;
    window.parent.postMessage(
      { type: 'capsium.bridge.fetch', requestId: requestId, url: url },
      '*'
    );
  });
}
var originalFetch = window.fetch ? window.fetch.bind(window) : null;
window.fetch = function (input, init) {
  var url = typeof input === 'string' ? input : (input && input.url) || '';
  if (url.indexOf(ORIGIN) === 0) {
    return bridge(url).then(function (data) {
      if (!data.found) throw new TypeError('Failed to fetch: ' + url);
      return new Response(data.body, {
        status: 200,
        headers: { 'Content-Type': data.contentType || 'application/octet-stream' }
      });
    });
  }
  if (!originalFetch) return Promise.reject(new TypeError('fetch unavailable'));
  return originalFetch(input, init);
};
var originalOpen = window.open ? window.open.bind(window) : null;
window.open = function (url, target, features) {
  if (typeof url === 'string' && url.indexOf(ORIGIN) === 0) {
    window.parent.postMessage(
      { type: 'capsium.bridge.navigate', url: url, blank: true },
      '*'
    );
    return null;
  }
  return originalOpen ? originalOpen(url, target, features) : null;
};
document.addEventListener('click', function (event) {
  var node = event.target;
  while (node && node.tagName !== 'A') node = node.parentNode;
  if (!node || !node.href) return;
  var url = String(node.href);
  if (url.indexOf(ORIGIN) !== 0) return;
  event.preventDefault();
  window.parent.postMessage(
    { type: 'capsium.bridge.navigate', url: url, blank: node.target === '_blank' },
    '*'
  );
}, true);
})();`;
}

/** Blob URL lifecycle for one rendered document. */
export class BlobUrlRegistry {
  private readonly urls = new Set<string>();

  constructor(private readonly blobUrls: BlobUrlPort) {}

  /** Mint a blob: URL for body (bytes or text) with the exact MIME type. */
  create(body: Uint8Array | string, contentType: string): string {
    const blob =
      typeof body === 'string'
        ? new Blob([body], { type: contentType })
        : new Blob([body.slice()], { type: contentType });
    const url = this.blobUrls.create(blob);
    this.urls.add(url);
    return url;
  }

  /** Revoke every URL minted so far (document unload / next render). */
  revokeAll(): void {
    for (const url of this.urls) this.blobUrls.revoke(url);
    this.urls.clear();
  }

  get size(): number {
    return this.urls.size;
  }
}

/** The sandbox page's ports, wired by the entrypoint. */
export interface SandboxPorts {
  /** Batch-resolve asset URLs through the router (bytes included). */
  requestAssets(capId: string, urls: string[]): Promise<ResolvedAssetBody[]>;
  blobUrls: BlobUrlPort;
  /**
   * Render the proxied HTML document (the entrypoint document.writes it
   * into the sandbox page itself — see the module doc).
   */
  renderDocument(html: string): void;
  /** Render non-HTML bytes (the entrypoint navigates to the blob: URL). */
  renderBlobUrl(url: string): void;
}

function isHtml(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('text/html');
}

/**
 * Renders served resources. HTML goes through the fetch-proxy DOM pass
 * (subresources -> blob: URLs, shim injected, §4a headers applied where
 * possible) and is written into the sandbox page itself; every other
 * content type is blob-wrapped with its exact MIME type and navigated to.
 *
 * Why document.write instead of an inner blob: iframe: the sandbox page
 * has an opaque origin, and sandboxing propagates to nested frames with a
 * FRESH opaque origin each time — a nested blob: document could not load
 * the blob: asset URLs minted by its parent (blob: URLs are origin-bound).
 * Rendering into the sandbox page itself keeps the packaged document and
 * its blob: assets in the same origin. Blob URLs are minted per render and
 * revoked on the next; the router swaps in a fresh sandbox page per
 * navigation, which releases everything.
 */
export class SandboxRenderer {
  private readonly registry: BlobUrlRegistry;

  constructor(private readonly ports: SandboxPorts) {
    this.registry = new BlobUrlRegistry(ports.blobUrls);
  }

  async serve(message: SandboxServeMessage): Promise<void> {
    // The previous document's blob URLs die with it.
    this.registry.revokeAll();

    if (!isHtml(message.contentType)) {
      const body =
        typeof message.body === 'string'
          ? new TextEncoder().encode(message.body)
          : message.body;
      this.ports.renderBlobUrl(
        this.registry.create(body, message.contentType),
      );
      return;
    }

    const html =
      typeof message.body === 'string'
        ? message.body
        : new TextDecoder().decode(message.body);
    const capOrigin = capOriginOf(message.capId);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // The shim must run before any packaged script.
    const shim = doc.createElement('script');
    shim.textContent = buildFetchShimScript(capOrigin);
    doc.head?.prepend(shim);
    applyResponseHeaders(doc, message.responseHeaders);

    const urls = collectAssetUrls(doc, capOrigin, message.baseUrl);
    if (urls.length > 0) {
      const assets = await this.ports.requestAssets(message.capId, urls);
      const replacements = new Map<string, string>();
      for (const asset of assets) {
        if (!asset.found || asset.body === undefined) continue;
        replacements.set(
          asset.url,
          this.registry.create(
            asset.body,
            asset.contentType ?? 'application/octet-stream',
          ),
        );
      }
      substituteAssetUrls(doc, capOrigin, message.baseUrl, replacements);
    }

    this.ports.renderDocument(
      `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`,
    );
  }

  /** Revoke all live blob URLs (page unload). */
  dispose(): void {
    this.registry.revokeAll();
  }
}
