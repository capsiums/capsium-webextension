import { unzipPackage } from './zip';
import { parseJsonConfig } from './json';
import {
  parseMetadata,
  parseManifest,
  generateManifest,
  parseRoutes,
  generateRoutes,
  parseStorage,
  parseSecurity,
  type Metadata,
  type Manifest,
  type RoutesFile,
  type StorageFile,
  type SecurityFile,
} from './model';
import { isTextMime, detectMimeType } from './mime';
import { verifyChecksums } from './checksums';

export type PackageErrorCode =
  'unzip' | 'config' | 'integrity' | 'missing-resource';

export class PackageError extends Error {
  constructor(
    public readonly code: PackageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PackageError';
  }
}

/** One file extracted from the package, kept as raw bytes (binary-safe). */
export interface ExtractedFile {
  /** Package-relative POSIX path, e.g. "content/index.html". */
  path: string;
  bytes: Uint8Array;
  contentType: string;
  /** True when the content type denotes UTF-8-decodable text. */
  isText: boolean;
}

/** content-validity introspection shape (ARCHITECTURE.md §7). */
export interface ContentValidity {
  package: string;
  valid: boolean;
  lastChecked: string;
  reason?: string;
}

export interface LoadedPackage {
  metadata: Metadata;
  manifest: Manifest;
  routes: RoutesFile;
  storage: StorageFile | null;
  /** All servable files: manifest resources plus dataset sources, as raw bytes. */
  files: ExtractedFile[];
  checksums: 'verified' | 'absent';
  validity: ContentValidity;
}

/**
 * Loads a .cap ZIP into a validated, normalized in-memory package:
 *  - parses the four config files, accepting legacy gem formats;
 *  - auto-generates manifest.json / routes.json when absent (§3/§4);
 *  - verifies SHA-256 checksums when security.json is present and REJECTS
 *    the package on mismatch (§6);
 *  - extracts every servable file as raw bytes (binary-safe).
 */
export class PackageLoader {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async load(zipBytes: Uint8Array): Promise<LoadedPackage> {
    let entries: Map<string, Uint8Array>;
    try {
      entries = unzipPackage(zipBytes);
    } catch (error) {
      throw new PackageError(
        'unzip',
        error instanceof Error ? error.message : String(error),
      );
    }

    const metadataBytes = entries.get('metadata.json');
    if (!metadataBytes)
      throw new PackageError('config', 'metadata.json is required but missing');
    const metadata = parseMetadata(
      parseJsonConfig('metadata.json', metadataBytes),
    );

    const manifestBytes = entries.get('manifest.json');
    const manifest = manifestBytes
      ? parseManifest(parseJsonConfig('manifest.json', manifestBytes))
      : generateManifest(contentPathsOf(entries));

    const storageBytes = entries.get('storage.json');
    const storage = storageBytes
      ? parseStorage(parseJsonConfig('storage.json', storageBytes))
      : null;

    const routesBytes = entries.get('routes.json');
    const routes = routesBytes
      ? parseRoutes(parseJsonConfig('routes.json', routesBytes))
      : generateRoutes(manifest, storage);

    let checksums: LoadedPackage['checksums'] = 'absent';
    const securityBytes = entries.get('security.json');
    if (securityBytes) {
      const security = parseSecurity(
        parseJsonConfig('security.json', securityBytes),
      );
      await this.verifyIntegrity(entries, security);
      checksums = 'verified';
    }

    const files = this.extractFiles(entries, manifest, storage);

    return {
      metadata,
      manifest,
      routes,
      storage,
      files,
      checksums,
      validity: {
        package: `${metadata.name}@${metadata.version}`,
        valid: true,
        lastChecked: this.now().toISOString(),
      },
    };
  }

  private async verifyIntegrity(
    entries: Map<string, Uint8Array>,
    security: SecurityFile,
  ): Promise<void> {
    const { checksumAlgorithm, checksums } = security.security.integrityChecks;
    if (checksumAlgorithm !== 'SHA-256') {
      throw new PackageError(
        'integrity',
        `Unsupported checksum algorithm "${checksumAlgorithm}" (only SHA-256 is supported)`,
      );
    }
    const failures = await verifyChecksums(entries, checksums);
    if (failures.length > 0) {
      const details = failures
        .slice(0, 5)
        .map((failure) => `${failure.path} (${failure.reason})`)
        .join(', ');
      const suffix =
        failures.length > 5 ? `, … ${failures.length - 5} more` : '';
      throw new PackageError(
        'integrity',
        `Checksum verification failed: ${details}${suffix}`,
      );
    }
  }

  private extractFiles(
    entries: Map<string, Uint8Array>,
    manifest: Manifest,
    storage: StorageFile | null,
  ): ExtractedFile[] {
    const paths = new Set<string>(Object.keys(manifest.resources));
    if (storage) {
      for (const dataSet of Object.values(storage.storage.dataSets)) {
        if (dataSet.source !== undefined) paths.add(dataSet.source);
        if (dataSet.databaseFile !== undefined) paths.add(dataSet.databaseFile);
      }
    }

    return [...paths].sort().map((path) => {
      const bytes = entries.get(path);
      if (!bytes) {
        throw new PackageError(
          'missing-resource',
          `File "${path}" is referenced by the package but not present in the archive`,
        );
      }
      const contentType =
        manifest.resources[path]?.type ?? detectMimeType(path);
      return { path, bytes, contentType, isText: isTextMime(contentType) };
    });
  }
}

function contentPathsOf(entries: Map<string, Uint8Array>): string[] {
  return [...entries.keys()].filter(
    (path) => path.startsWith('content/') && !path.endsWith('/'),
  );
}
