/**
 * Dependency-injection ports for browser APIs. Pure modules depend on these
 * minimal structural interfaces instead of the global chrome/browser objects,
 * which keeps them testable and free of any chrome.* coupling.
 */

export interface StorageData {
  [key: string]: unknown;
}

/** Minimal chrome.storage.local surface. */
export interface StoragePort {
  get(keys: string[]): Promise<StorageData>;
  set(items: StorageData): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/** One header operation of a modifyHeaders rule. */
export interface DnrHeaderOperation {
  header: string;
  operation: 'set' | 'append' | 'remove';
  value?: string;
}

interface DnrRuleBase {
  id: number;
  priority: number;
  condition: {
    regexFilter: string;
    resourceTypes: string[];
  };
}

/** A declarativeNetRequest session rule redirecting via regex substitution. */
export interface DnrRedirectRule extends DnrRuleBase {
  action: {
    type: 'redirect';
    redirect: { regexSubstitution: string };
  };
}

/** A session rule attaching request/response headers (route inheritance). */
export interface DnrModifyHeadersRule extends DnrRuleBase {
  action: {
    type: 'modifyHeaders';
    requestHeaders?: DnrHeaderOperation[];
    responseHeaders?: DnrHeaderOperation[];
  };
}

/** A declarativeNetRequest session rule. */
export type DnrRule = DnrRedirectRule | DnrModifyHeadersRule;

/** Minimal chrome.declarativeNetRequest surface (session rules). */
export interface DnrPort {
  updateSessionRules(options: {
    removeRuleIds?: number[];
    addRules?: DnrRule[];
  }): Promise<void>;
  getSessionRules(): Promise<Array<{ id: number }>>;
}

/** Minimal chrome.tabs surface. */
export interface TabsPort {
  create(options: { url: string }): Promise<void>;
}

/**
 * Binary-safe persistence for package file bytes (the serving store).
 *
 * Implementations: OPFS (primary — raw bytes, cheap for large trees) with a
 * Cache API fallback (request/response-shaped, available everywhere a
 * service worker runs). Content types are NOT stored here — they live in the
 * package index metadata (chrome.storage.local) and travel with resolutions.
 */
export interface FileStorePort {
  /** Which backend holds the bytes; resolutions carry it to the router. */
  readonly kind: 'opfs' | 'cache';
  put(capId: string, path: string, bytes: Uint8Array): Promise<void>;
  /** Bytes of one stored file, or null when absent. */
  get(capId: string, path: string): Promise<Uint8Array | null>;
  /** Drop a package's whole file tree (expiry / rollback). */
  removePackage(capId: string): Promise<void>;
}

/** Minimal chrome.offscreen surface (Chrome-only; absent in Firefox). */
export interface OffscreenPort {
  hasDocument(): Promise<boolean>;
  createDocument(url: string): Promise<void>;
}

/** Minimal runtime messaging surface (background -> offscreen request/response). */
export interface RuntimeMessagingPort {
  sendMessage(message: unknown): Promise<unknown>;
}

/** HTML rewriting strategy: direct DOMParser (Firefox) or offscreen (Chrome). */
export interface HtmlRewriter {
  rewrite(html: string, baseUrl: string): Promise<string>;
}
