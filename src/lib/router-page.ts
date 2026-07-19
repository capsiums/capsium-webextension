/**
 * Router page core (extension page at /router.html).
 *
 * Every request under a package's synthetic origin is redirected here by the
 * package's single DNR rule: `chrome-extension://<id>/router.html#/serve/<capId>/<path>`.
 * The router resolves the path with the background worker, reads the bytes
 * from the file store named in the resolution (OPFS or Cache API) and hands
 * them — structured-cloned, never base64 — to the embedded sandbox page,
 * which renders them. Locked (§4b) and unknown paths are rendered by the
 * router itself.
 *
 * The router also answers the sandbox's messages: batched asset resolution
 * during HTML proxying, fetch/XHR bridge requests from packaged JS, and
 * in-package navigations (a blob:-origin document cannot follow a DNR
 * redirect into an extension page, so link clicks are relayed and the
 * router re-renders itself via location.hash).
 *
 * This module is DOM-free for testability; the entrypoint wires the ports.
 */
import {
  isBridgeFetchMessage,
  isBridgeNavigateMessage,
  isSandboxAssetsMessage,
  SANDBOX_SERVE_TYPE,
  type BridgeFetchResultMessage,
  type ResolveResult,
  type SandboxAssetsResultMessage,
  type SandboxServeMessage,
} from './messages';
import { UNAUTHORIZED_BODY } from './resolver';
import type { FileStorePort } from './ports';

export { UNAUTHORIZED_BODY };

/** One resolved serve target: package + URL path. */
export interface ServeTarget {
  capId: string;
  path: string;
}

/**
 * Parse the router hash `#/serve/<capId>/<path>` (the DNR rule substitutes
 * the requested URL path after the capId). Returns null for foreign hashes.
 * A query string on the original .cap URL is appended after the fragment by
 * the DNR substitution — it is stripped from the captured path.
 */
export function parseServeHash(hash: string): ServeTarget | null {
  const rest = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!rest.startsWith('/serve/')) return null;
  const remainder = rest.slice('/serve/'.length);
  const slash = remainder.indexOf('/');
  if (slash === -1) {
    // Bare capId without a path serves the package root.
    return remainder === '' ? null : { capId: remainder, path: '/' };
  }
  const capId = remainder.slice(0, slash);
  if (capId === '') return null;
  const rawPath = remainder.slice(slash);
  const queryAt = rawPath.indexOf('?');
  const path = queryAt === -1 ? rawPath : rawPath.slice(0, queryAt);
  return { capId, path: safeDecode(path) };
}

/** Build the router hash for a serve target (inverse of parseServeHash). */
export function serveHashFor(capId: string, path: string): string {
  return `#/serve/${capId}${encodeURI(path)}`;
}

/** Parse an absolute package URL (`https://<capId>.cap<path>`). */
export function parseCapUrl(url: string): ServeTarget | null {
  const match = /^https:\/\/([^/?#]+)\.cap(\/[^?#]*)?/.exec(url);
  if (match === null) return null;
  return { capId: match[1] as string, path: safeDecode(match[2] ?? '/') };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** URL-space directory (trailing slash) of a served URL path. */
export function serveBaseUrl(capId: string, path: string): string {
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  return `https://${capId}.cap${dir}`;
}

/** The router's ports, wired by the entrypoint. */
export interface RouterPorts {
  /** Background worker resolution (RESOLVE_REQUEST round trip). */
  resolve(capId: string, paths: string[]): Promise<ResolveResult[]>;
  /** File-store backend named in resolutions (lazy: created on first use). */
  fileStoreFor(kind: 'opfs' | 'cache'): Promise<FileStorePort>;
  /** Open a real browser tab (target=_blank navigations) via the worker. */
  openTab(url: string): Promise<void>;
  /** Hand a resolved resource to the sandbox page for rendering. */
  serve(message: SandboxServeMessage): void;
  /** Answer a sandbox asset batch. */
  answerAssets(message: SandboxAssetsResultMessage): void;
  /** Answer a fetch/XHR bridge request. */
  answerFetch(message: BridgeFetchResultMessage): void;
  /** §4b: package locked — render the 401 body. */
  renderLocked(): void;
  /** Unknown path — render the 404 page. */
  renderNotFound(capId: string, path: string): void;
  renderError(message: string): void;
  /** Re-serve another path of the same package (hashchange re-runs). */
  navigate(hash: string): void;
}

/** Absolute router-page URL for a serve target (new-tab navigations). */
export function routerUrlFor(
  routerBaseUrl: string,
  target: ServeTarget,
): string {
  return `${routerBaseUrl}${serveHashFor(target.capId, target.path)}`;
}

/** Read the body a resolution points at (§4a body overrides win). */
async function loadBody(
  ports: RouterPorts,
  result: Extract<ResolveResult, { kind: 'found' }>,
): Promise<Uint8Array | string | null> {
  if (result.bodyOverride !== undefined) return result.bodyOverride;
  const store = await ports.fileStoreFor(result.store);
  return store.get(result.fileCapId, result.filePath);
}

/**
 * Serve the target named by the current hash: resolve -> gate (§4b) ->
 * read bytes -> hand to the sandbox. Everything else renders an error.
 */
export async function runRouter(
  ports: RouterPorts,
  hash: string,
): Promise<void> {
  const target = parseServeHash(hash);
  if (target === null) {
    ports.renderError('No package URL to serve (bad router hash).');
    return;
  }
  const [result] = await ports.resolve(target.capId, [target.path]);
  if (result === undefined || result.kind === 'not-found') {
    ports.renderNotFound(target.capId, target.path);
    return;
  }
  if (result.kind === 'locked') {
    ports.renderLocked();
    return;
  }
  const body = await loadBody(ports, result);
  if (body === null) {
    // Resolved but the bytes are gone (partial sweep) — treat as 404.
    ports.renderNotFound(target.capId, target.path);
    return;
  }
  ports.serve({
    type: SANDBOX_SERVE_TYPE,
    capId: target.capId,
    path: target.path,
    contentType: result.contentType,
    body,
    ...(result.responseHeaders === undefined
      ? {}
      : { responseHeaders: result.responseHeaders }),
    baseUrl: serveBaseUrl(target.capId, target.path),
  });
}

/**
 * Handle one message from the sandbox page: asset batches (HTML proxying),
 * fetch/XHR bridge requests from packaged JS, and in-package navigations.
 * Returns true when the message was consumed.
 */
export async function handleSandboxMessage(
  ports: RouterPorts,
  routerBaseUrl: string,
  message: unknown,
): Promise<boolean> {
  if (isSandboxAssetsMessage(message)) {
    const urls = message.urls;
    const paths = urls.map((url) => parseCapUrl(url)?.path ?? url);
    const results = await ports.resolve(message.capId, paths);
    const assets = await Promise.all(
      results.map(async (result, index) => {
        const url = urls[index] as string;
        if (result.kind !== 'found') return { url, found: false as const };
        const body = await loadBody(ports, result);
        if (body === null) return { url, found: false as const };
        return {
          url,
          found: true as const,
          contentType: result.contentType,
          body,
        };
      }),
    );
    ports.answerAssets({
      type: 'capsium.sandbox.assets.result',
      requestId: message.requestId,
      assets,
    });
    return true;
  }

  if (isBridgeFetchMessage(message)) {
    const target = parseCapUrl(message.url);
    if (target === null) {
      ports.answerFetch({
        type: 'capsium.bridge.fetch.result',
        requestId: message.requestId,
        found: false,
      });
      return true;
    }
    const [result] = await ports.resolve(target.capId, [target.path]);
    if (result === undefined || result.kind !== 'found') {
      ports.answerFetch({
        type: 'capsium.bridge.fetch.result',
        requestId: message.requestId,
        found: false,
      });
      return true;
    }
    const body = await loadBody(ports, result);
    ports.answerFetch({
      type: 'capsium.bridge.fetch.result',
      requestId: message.requestId,
      found: body !== null,
      contentType: result.contentType,
      ...(body === null ? {} : { body }),
    });
    return true;
  }

  if (isBridgeNavigateMessage(message)) {
    const target = parseCapUrl(message.url);
    if (target === null) return true;
    if (message.blank) {
      await ports.openTab(routerUrlFor(routerBaseUrl, target));
    } else {
      ports.navigate(serveHashFor(target.capId, target.path));
    }
    return true;
  }

  return false;
}
