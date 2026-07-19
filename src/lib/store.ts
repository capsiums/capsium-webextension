import type { FileStorePort, StoragePort } from './ports';
import type {
  AuthenticationFile,
  Manifest,
  Metadata,
  RoutesFile,
  StorageFile,
} from './model';
import type { ContentValidity } from './package-loader';

export const INDEX_KEY = 'capsium.index';

export interface IndexEntry {
  capId: string;
  name: string;
  version: string;
  timeAdded: number;
}

export interface StoredPackageInfo {
  metadata: Metadata;
  /** Persisted for dependent-view (§4a) visibility checks at resolve time. */
  manifest?: Manifest;
  routes: RoutesFile;
  storage: StorageFile | null;
  /**
   * Stored file path -> content type. The key set is the package's stored
   * path list (layered packages store raw paths, `<layer>/content/x.html`).
   * Content types live here (not in the file store) so the resolver can
   * answer without touching bytes.
   */
  fileTypes: Record<string, string>;
  validity: ContentValidity;
  checksums: 'verified' | 'absent';
  signature?: 'verified' | 'absent';
  /** Parsed layer tombstones, layer directory -> deleted merged paths (§5a). */
  tombstones?: Record<string, string[]>;
  /** Composite (§4a): dependency guid -> installed dependency capId. */
  dependencies?: Record<string, string>;
  /** Set when this package is installed as a dependency of another. */
  dependencyOf?: { parent: string; guid: string };
  /** authentication.json when present (§4b); OAuth2 is config-only. */
  authentication?: AuthenticationFile | null;
}

export interface PreparedFile {
  path: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Files are written in small batches so a failure mid-install is recoverable. */
const WRITE_BATCH_SIZE = 8;

/**
 * Persistence for installed packages, split by size:
 *
 *  - file BYTES go to the binary file store (OPFS / Cache API — see
 *    lib/file-store.ts), one tree per package;
 *  - chrome.storage.local keeps ONLY the index and per-package metadata
 *    (no more base64 payloads, no more `unlimitedStorage`):
 *
 * Layout:
 *  - `capsium.index`                -> IndexEntry[] (written LAST)
 *  - `capsium.pkg.<capId>.info`     -> StoredPackageInfo
 *
 * install() is transactional: on any failure the file-store tree and the
 * info key are removed again (rollback), so a partial install never leaks.
 */
export class PackageStore {
  constructor(
    private readonly storage: StoragePort,
    private readonly files: FileStorePort,
    private readonly now: () => number = Date.now,
  ) {}

  static infoKey(capId: string): string {
    return `capsium.pkg.${capId}.info`;
  }

  /** The file-store backend holding this store's bytes. */
  get fileStore(): FileStorePort {
    return this.files;
  }

  async listIndex(): Promise<IndexEntry[]> {
    const data = await this.storage.get([INDEX_KEY]);
    const raw = data[INDEX_KEY];
    return Array.isArray(raw) ? (raw as IndexEntry[]) : [];
  }

  async install(
    capId: string,
    info: StoredPackageInfo,
    files: PreparedFile[],
  ): Promise<void> {
    try {
      for (let i = 0; i < files.length; i += WRITE_BATCH_SIZE) {
        await Promise.all(
          files
            .slice(i, i + WRITE_BATCH_SIZE)
            .map((file) => this.files.put(capId, file.path, file.bytes)),
        );
      }

      await this.storage.set({ [PackageStore.infoKey(capId)]: info });

      // The index is written last: a crashed install leaves no index entry,
      // so the package never becomes visible half-written.
      const index = await this.listIndex();
      const entry: IndexEntry = {
        capId,
        name: info.metadata.name,
        version: info.metadata.version,
        timeAdded: this.now(),
      };
      await this.storage.set({
        [INDEX_KEY]: [...index.filter((item) => item.capId !== capId), entry],
      });
    } catch (error) {
      await this.rollback(capId);
      throw error;
    }
  }

  private async rollback(capId: string): Promise<void> {
    try {
      await this.files.removePackage(capId);
    } catch {
      // Best effort: orphaned bytes without an index entry are never served.
    }
    try {
      await this.storage.remove([PackageStore.infoKey(capId)]);
    } catch {
      // Best effort, same reasoning.
    }
  }

  async removePackage(capId: string): Promise<void> {
    await this.files.removePackage(capId);
    await this.storage.remove([PackageStore.infoKey(capId)]);
    const index = await this.listIndex();
    await this.storage.set({
      [INDEX_KEY]: index.filter((item) => item.capId !== capId),
    });
  }

  async getInfo(capId: string): Promise<StoredPackageInfo | null> {
    const data = await this.storage.get([PackageStore.infoKey(capId)]);
    const raw = data[PackageStore.infoKey(capId)];
    if (typeof raw !== 'object' || raw === null) return null;
    return raw as StoredPackageInfo;
  }

  /** Overwrite the stored package info (e.g. after a dependency was added). */
  async updateInfo(capId: string, info: StoredPackageInfo): Promise<void> {
    await this.storage.set({ [PackageStore.infoKey(capId)]: info });
  }
}
