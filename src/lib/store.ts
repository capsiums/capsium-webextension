import type { StoragePort } from './ports';
import type { Manifest, Metadata, RoutesFile, StorageFile } from './model';
import type { ContentValidity } from './package-loader';

export const INDEX_KEY = 'capsium.index';

export interface IndexEntry {
  capId: string;
  name: string;
  version: string;
  timeAdded: number;
}

/** A package file persisted in chrome.storage.local (uniform base64 — binary-safe). */
export interface StoredFile {
  contentType: string;
  base64: string;
}

export interface StoredPackageInfo {
  metadata: Metadata;
  /** Persisted for dependent-view (§4a) visibility checks at rebuild time. */
  manifest?: Manifest;
  routes: RoutesFile;
  storage: StorageFile | null;
  /** Package-relative paths of the stored files. */
  files: string[];
  validity: ContentValidity;
  checksums: 'verified' | 'absent';
  signature?: 'verified' | 'absent';
  /** Parsed layer tombstones, layer directory -> deleted merged paths (§5a). */
  tombstones?: Record<string, string[]>;
  /** Composite (§4a): dependency guid -> installed dependency capId. */
  dependencies?: Record<string, string>;
  /** Set when this package is installed as a dependency of another. */
  dependencyOf?: { parent: string; guid: string };
}

export interface PreparedFile {
  path: string;
  contentType: string;
  base64: string;
}

/** Files are written in small batches so a failure mid-install is recoverable. */
const WRITE_BATCH_SIZE = 8;

/**
 * chrome.storage.local persistence for installed packages.
 *
 * Layout:
 *  - `capsium.index`                    -> IndexEntry[] (written LAST)
 *  - `capsium.pkg.<capId>.info`         -> StoredPackageInfo
 *  - `capsium.pkg.<capId>.file.<path>`  -> StoredFile
 *
 * install() is transactional: on any failure every key written so far is
 * removed again (rollback), so a partial install never leaks storage.
 */
export class PackageStore {
  constructor(
    private readonly storage: StoragePort,
    private readonly now: () => number = Date.now,
  ) {}

  static infoKey(capId: string): string {
    return `capsium.pkg.${capId}.info`;
  }

  static fileKey(capId: string, path: string): string {
    return `capsium.pkg.${capId}.file.${path}`;
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
    const written: string[] = [];
    try {
      for (let i = 0; i < files.length; i += WRITE_BATCH_SIZE) {
        const batch: Record<string, StoredFile> = {};
        for (const file of files.slice(i, i + WRITE_BATCH_SIZE)) {
          batch[PackageStore.fileKey(capId, file.path)] = {
            contentType: file.contentType,
            base64: file.base64,
          };
        }
        await this.storage.set(batch);
        written.push(...Object.keys(batch));
      }

      const infoKey = PackageStore.infoKey(capId);
      await this.storage.set({ [infoKey]: info });
      written.push(infoKey);

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
      await this.rollback(written);
      throw error;
    }
  }

  private async rollback(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.storage.remove(keys);
    } catch {
      // Best effort: orphaned keys without an index entry are never served.
    }
  }

  async removePackage(capId: string): Promise<void> {
    const info = await this.getInfo(capId);
    const keys = [
      PackageStore.infoKey(capId),
      ...(info?.files.map((path) => PackageStore.fileKey(capId, path)) ?? []),
    ];
    await this.storage.remove(keys);
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

  async getFile(capId: string, path: string): Promise<StoredFile | null> {
    const data = await this.storage.get([PackageStore.fileKey(capId, path)]);
    const raw = data[PackageStore.fileKey(capId, path)];
    if (typeof raw !== 'object' || raw === null) return null;
    return raw as StoredFile;
  }
}
