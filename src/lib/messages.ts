import type { ContentValidity } from './package-loader';

/**
 * Extension message protocol: popup -> background (open a package),
 * background -> offscreen (HTML rewrite), background -> popup (result).
 */

export const OPEN_CAP_ACTION = 'openCapFile';
export const ADD_DEPENDENCY_ACTION = 'addDependencyCap';
export const REWRITE_REQUEST_TYPE = 'capsium.rewriteHtml';
export const REWRITE_RESPONSE_TYPE = 'capsium.rewriteHtml.result';

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
