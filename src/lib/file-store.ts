/**
 * Binary-safe file stores for package bytes — the storage half of the
 * serving core (replacing base64 strings in chrome.storage.local).
 *
 * Two backends behind the FileStorePort:
 *
 *  - OpfsFileStore (PRIMARY): the Origin Private File System, reached via
 *    `navigator.storage.getDirectory()`. The async FileSystemFileHandle API
 *    is used throughout (sync access handles exist only in dedicated
 *    workers, never in a service worker). OPFS stores raw bytes without any
 *    request/response or serialization overhead and removes a whole package
 *    with one recursive removeEntry, which is why it wins over the Cache
 *    API for large package trees.
 *
 *  - CacheFileStore (FALLBACK): the Cache API (`caches.open('capsium')`),
 *    which is service-worker-native and request-shaped. Bytes sit in
 *    Response bodies keyed by synthetic, never-fetched URLs.
 *
 * selectFileStore() probes OPFS (API present AND a probe write/removal
 * succeeds — quota pressure included) and falls back to the Cache API. The
 * chosen backend's `kind` travels with every resolution so the router page
 * reads from the same store the background worker wrote to.
 *
 * Content types are deliberately NOT persisted here (the Cache API could
 * hold them in Response headers; OPFS cannot): they live in the package
 * index metadata and are returned by the resolver.
 */

import type { FileStorePort } from './ports';

/** Cache name and synthetic key origin for the Cache API backend. */
export const CACHE_NAME = 'capsium';
export const CACHE_KEY_ORIGIN = 'https://capsium.cache';

/** Root directory name inside OPFS. */
export const OPFS_ROOT_DIR = 'capsium';

/**
 * Validate a package-relative POSIX path and return its segments. Package
 * paths come out of a ZIP archive, so guard the file-system backends against
 * traversal and malformed entries.
 */
export function pathSegments(path: string): string[] {
  if (path === '' || path.startsWith('/') || path.endsWith('/')) {
    throw new Error(`Invalid package path "${path}"`);
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`Invalid package path "${path}"`);
    }
  }
  return segments;
}

/* ------------------------------------------------------------------ */
/* OPFS backend                                                        */
/* ------------------------------------------------------------------ */

/** Minimal structural OPFS surface (the DOM handle types satisfy these). */
export interface OpfsWritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsFileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface OpfsFileHandleLike {
  createWritable(): Promise<OpfsWritableLike>;
  getFile(): Promise<OpfsFileLike>;
}

export interface OpfsDirectoryLike {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsFileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export class OpfsFileStore implements FileStorePort {
  readonly kind = 'opfs' as const;

  private constructor(private readonly root: OpfsDirectoryLike) {}

  /** Open (creating) the `capsium/` directory under the OPFS origin root. */
  static async create(
    getDirectory: () => Promise<OpfsDirectoryLike>,
  ): Promise<OpfsFileStore> {
    const originRoot = await getDirectory();
    const root = await originRoot.getDirectoryHandle(OPFS_ROOT_DIR, {
      create: true,
    });
    return new OpfsFileStore(root);
  }

  async put(capId: string, path: string, bytes: Uint8Array): Promise<void> {
    const segments = pathSegments(path);
    let dir = await this.root.getDirectoryHandle(capId, { create: true });
    for (const segment of segments.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    const handle = await dir.getFileHandle(segments.at(-1) as string, {
      create: true,
    });
    const writable = await handle.createWritable();
    try {
      await writable.write(bytes);
    } finally {
      await writable.close();
    }
  }

  async get(capId: string, path: string): Promise<Uint8Array | null> {
    const segments = pathSegments(path);
    try {
      let dir = await this.root.getDirectoryHandle(capId);
      for (const segment of segments.slice(0, -1)) {
        dir = await dir.getDirectoryHandle(segment);
      }
      const handle = await dir.getFileHandle(segments.at(-1) as string);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      // Absent directory/file (NotFoundError) — treated as "not stored".
      return null;
    }
  }

  async removePackage(capId: string): Promise<void> {
    try {
      await this.root.removeEntry(capId, { recursive: true });
    } catch {
      // Already gone — removal is idempotent (rollback paths rely on that).
    }
  }
}

/* ------------------------------------------------------------------ */
/* Cache API backend                                                   */
/* ------------------------------------------------------------------ */

/** Minimal structural Cache surface (the DOM Cache type satisfies it). */
export interface CacheLike {
  put(request: string, response: Response): Promise<void>;
  match(request: string): Promise<Response | undefined>;
  delete(request: string): Promise<boolean>;
  keys(): Promise<Array<{ url: string }>>;
}

/** Synthetic, never-fetched URL keying one stored file. */
export function cacheKey(capId: string, path: string): string {
  const encoded = pathSegments(path).map(encodeURIComponent).join('/');
  return `${CACHE_KEY_ORIGIN}/${encodeURIComponent(capId)}/${encoded}`;
}

export class CacheFileStore implements FileStorePort {
  readonly kind = 'cache' as const;

  constructor(private readonly cache: CacheLike) {}

  async put(capId: string, path: string, bytes: Uint8Array): Promise<void> {
    const response = new Response(bytes.slice().buffer as ArrayBuffer, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    await this.cache.put(cacheKey(capId, path), response);
  }

  async get(capId: string, path: string): Promise<Uint8Array | null> {
    const response = await this.cache.match(cacheKey(capId, path));
    if (response === undefined) return null;
    return new Uint8Array(await response.arrayBuffer());
  }

  async removePackage(capId: string): Promise<void> {
    const prefix = `${CACHE_KEY_ORIGIN}/${encodeURIComponent(capId)}/`;
    const keys = await this.cache.keys();
    await Promise.all(
      keys
        .filter((request) => request.url.startsWith(prefix))
        .map((request) => this.cache.delete(request.url)),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Backend selection                                                   */
/* ------------------------------------------------------------------ */

/** Browser capabilities the selection probes (injectable for tests). */
export interface FileStoreEnvironment {
  /** navigator.storage.getDirectory, when the OPFS API exists. */
  getOpfsRoot?: () => Promise<OpfsDirectoryLike>;
  /** caches.open, when the Cache API exists. */
  openCache?: (name: string) => Promise<CacheLike>;
}

const PROBE_CAP_ID = 'capsium-probe';

/**
 * Pick the serving store: OPFS when the API exists AND a probe write +
 * removal succeeds (covers missing APIs, private-mode denials and quota
 * pressure), otherwise the Cache API. Throws when neither is usable.
 */
export async function selectFileStore(
  env: FileStoreEnvironment,
): Promise<FileStorePort> {
  if (env.getOpfsRoot !== undefined) {
    try {
      const store = await OpfsFileStore.create(env.getOpfsRoot);
      await store.put(PROBE_CAP_ID, 'probe.bin', new Uint8Array([0]));
      await store.removePackage(PROBE_CAP_ID);
      return store;
    } catch {
      // Fall through to the Cache API fallback.
    }
  }
  if (env.openCache !== undefined) {
    return new CacheFileStore(await env.openCache(CACHE_NAME));
  }
  throw new Error(
    'Neither OPFS nor the Cache API is available; package bytes cannot be stored',
  );
}
