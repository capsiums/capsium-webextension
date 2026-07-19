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

/** A declarativeNetRequest session rule (redirect to a data: URI). */
export interface DnrRule {
  id: number;
  priority: number;
  action: {
    type: 'redirect';
    redirect: { url: string };
  };
  condition: {
    regexFilter: string;
    resourceTypes: string[];
  };
}

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
