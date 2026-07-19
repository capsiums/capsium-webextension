import type { ContentValidity } from './package-loader';

/**
 * Extension message protocol: popup -> background (open a package),
 * background -> offscreen (HTML rewrite), background -> popup (result).
 */

export const OPEN_CAP_ACTION = 'openCapFile';
export const ADD_DEPENDENCY_ACTION = 'addDependencyCap';
export const AUTHENTICATE_ACTION = 'authenticatePackage';
export const REWRITE_REQUEST_TYPE = 'capsium.rewriteHtml';
export const REWRITE_RESPONSE_TYPE = 'capsium.rewriteHtml.result';
export const RESOLVE_REQUEST_TYPE = 'capsium.resolve';
export const RESOLVE_RESPONSE_TYPE = 'capsium.resolve.result';

/** popup -> background. Kept wire-compatible with the original extension. */
export interface OpenCapRequest {
  action: typeof OPEN_CAP_ACTION;
  /** data: URI of the .cap file (message passing is JSON-safe strings only). */
  dataURI: string;
  /** PKCS#8 PEM private key, required to open an encrypted package (§6b). */
  privateKey?: string;
}

export function isOpenCapRequest(message: unknown): message is OpenCapRequest {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return (
    record['action'] === OPEN_CAP_ACTION &&
    typeof record['dataURI'] === 'string'
  );
}

/** popup -> background: add a dependency .cap to an open package (§4a). */
export interface AddDependencyRequest {
  action: typeof ADD_DEPENDENCY_ACTION;
  /** capId of the composite package the dependency belongs to. */
  parentCapId: string;
  dataURI: string;
  privateKey?: string;
}

export function isAddDependencyRequest(
  message: unknown,
): message is AddDependencyRequest {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return (
    record['action'] === ADD_DEPENDENCY_ACTION &&
    typeof record['parentCapId'] === 'string' &&
    typeof record['dataURI'] === 'string'
  );
}

/** popup -> background: basic-auth credentials for a package (§4b). */
export interface AuthenticateRequest {
  action: typeof AUTHENTICATE_ACTION;
  capId: string;
  username: string;
  password: string;
}

export function isAuthenticateRequest(
  message: unknown,
): message is AuthenticateRequest {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return (
    record['action'] === AUTHENTICATE_ACTION &&
    typeof record['capId'] === 'string' &&
    typeof record['username'] === 'string' &&
    typeof record['password'] === 'string'
  );
}

/** background -> offscreen document. */
export interface RewriteHtmlRequest {
  type: typeof REWRITE_REQUEST_TYPE;
  /** Correlates a response with its request. */
  requestId: string;
  html: string;
  /** URL-space directory of the file being rewritten, e.g. "https://<capId>.cap/docs/". */
  baseUrl: string;
}

export function isRewriteHtmlRequest(
  message: unknown,
): message is RewriteHtmlRequest {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return (
    record['type'] === REWRITE_REQUEST_TYPE &&
    typeof record['requestId'] === 'string' &&
    typeof record['html'] === 'string' &&
    typeof record['baseUrl'] === 'string'
  );
}

/** offscreen document -> background. */
export interface RewriteHtmlResponse {
  type: typeof REWRITE_RESPONSE_TYPE;
  requestId: string;
  html: string;
}

export function isRewriteHtmlResponse(
  message: unknown,
): message is RewriteHtmlResponse {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return (
    record['type'] === REWRITE_RESPONSE_TYPE &&
    typeof record['requestId'] === 'string' &&
    typeof record['html'] === 'string'
  );
}

/* ------------------------------------------------------------------ */
/* Router page -> background: serve-time resolution                    */
/* ------------------------------------------------------------------ */

/**
 * Router page -> background: resolve package URL paths to stored files.
 * Batch-shaped (one message per rendered page, one entry per URL); a single
 * lookup is a one-element `paths` array.
 */
export interface ResolveRequest {
  type: typeof RESOLVE_REQUEST_TYPE;
  capId: string;
  /** URL paths under the package origin, e.g. "/assets/app.js". */
  paths: string[];
}

export function isResolveRequest(message: unknown): message is ResolveRequest {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return (
    record['type'] === RESOLVE_REQUEST_TYPE &&
    typeof record['capId'] === 'string' &&
    Array.isArray(record['paths']) &&
    (record['paths'] as unknown[]).every((path) => typeof path === 'string')
  );
}

/** One resolved URL path: the router reads the bytes from the file store. */
export interface ResolveFound {
  path: string;
  kind: 'found';
  /** Which file-store backend holds the bytes. */
  store: 'opfs' | 'cache';
  /** capId of the package OWNING the bytes (a dependency for §4a refs). */
  fileCapId: string;
  /** Raw stored path within that package. */
  filePath: string;
  contentType: string;
  /** §4a responseRewrite.body — serve this text instead of the stored bytes. */
  bodyOverride?: string;
  /** §4a responseHeaders + responseRewrite.headers. */
  responseHeaders?: Record<string, string>;
}

/** §4b: basicAuth is enabled and no credentials verified this session. */
export interface ResolveLocked {
  path: string;
  kind: 'locked';
}

export interface ResolveNotFound {
  path: string;
  kind: 'not-found';
}

export type ResolveResult = ResolveFound | ResolveLocked | ResolveNotFound;

/** background -> router page. */
export interface ResolveResponse {
  type: typeof RESOLVE_RESPONSE_TYPE;
  results: ResolveResult[];
}

export function isResolveResponse(
  message: unknown,
): message is ResolveResponse {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  return record['type'] === RESOLVE_RESPONSE_TYPE && Array.isArray(record['results']);
}

/** One route as shown in the popup. */
export interface RouteView {
  path: string;
  /** Resource path, "dataset:<id>", or "<METHOD> <handler>". */
  target: string;
}

/** One declared dependency with its in-session install status (§4a). */
export interface DependencyViewInfo {
  guid: string;
  /** Declared semver range (informational in the viewer). */
  range: string;
  status: 'installed' | 'missing';
  name?: string;
  version?: string;
}

/** Package summary + mini content-validity view (ARCHITECTURE.md §7) for the popup. */
export interface PackageViewInfo {
  capId: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  entryUrl: string;
  routes: RouteView[];
  validity: ContentValidity;
  checksums: 'verified' | 'absent';
  /** 'verified' when a declared digital signature checked out (§6a). */
  signature: 'verified' | 'absent';
  /** Declared dependencies with their in-session install status (§4a). */
  dependencies: DependencyViewInfo[];
  /** Basic-auth state (§4b); present only when the package enables it. */
  authentication?: {
    basicAuth: boolean;
    realm: string;
    authenticated: boolean;
  };
}

/** background -> popup. */
export type OpenCapResponse =
  | { ok: true; info: PackageViewInfo }
  | {
      ok: false;
      error: string;
      /** true when the package is encrypted and a private key is (still) needed. */
      needsPrivateKey?: boolean;
    };

export function isOpenCapResponse(
  message: unknown,
): message is OpenCapResponse {
  if (typeof message !== 'object' || message === null) return false;
  const record = message as Record<string, unknown>;
  if (record['ok'] === false) return typeof record['error'] === 'string';
  if (record['ok'] === true)
    return typeof record['info'] === 'object' && record['info'] !== null;
  return false;
}
