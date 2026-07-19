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
  parseAuthentication,
  type Metadata,
  type Manifest,
  type RoutesFile,
  type StorageFile,
  type SecurityFile,
  type AuthenticationFile,
} from './model';
import { isTextMime, detectMimeType } from './mime';
import { verifyChecksums } from './checksums';
import { verifyPackageSignature } from './signatures';
import { isEncryptedPackage, decryptPackage } from './encryption';
import {
  collectTombstones,
  entriesFileView,
  hasLayers,
  mergedContentPaths,
  mergedPathFor,
  resolveLayeredPath,
  TOMBSTONES_FILE,
} from './layers';
import { PackageError } from './errors';

export type { PackageErrorCode } from './errors';
export { PackageError } from './errors';

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
  /** 'verified' when a declared digital signature checked out (§6a). */
  signature: 'verified' | 'absent';
  /** Parsed layer tombstones (§5a), persisted for serving-time resolution. */
  tombstones: Record<string, string[]>;
  /** authentication.json when present (§4b); OAuth2 is config-only. */
  authentication: AuthenticationFile | null;
  validity: ContentValidity;
}

/**
 * Loads a .cap ZIP into a validated, normalized in-memory package:
 *  - parses the four config files, accepting legacy gem formats;
 *  - auto-generates manifest.json / routes.json when absent (§3/§4);
 *  - verifies SHA-256 checksums when security.json is present and REJECTS
 *    the package on mismatch (§6);
 *  - verifies the RSA-SHA256 digital signature when `digitalSignatures`
 *    is declared, rejecting on mismatch BEFORE install (§6a);
 *  - extracts every servable file as raw bytes (binary-safe).
 */
export class PackageLoader {
  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * @param options.privateKey PKCS#8 PEM used to unwrap+decrypt an
   *   encrypted package (§6b); required iff the archive has the encrypted
   *   layout.
   */
  async load(
    zipBytes: Uint8Array,
    options: { privateKey?: string } = {},
  ): Promise<LoadedPackage> {
    let entries: Map<string, Uint8Array>;
    try {
      entries = unzipPackage(zipBytes);
    } catch (error) {
      throw new PackageError(
        'unzip',
        error instanceof Error ? error.message : String(error),
      );
    }

    // §6b: encrypted layout — unwrap the DEK and decrypt the inner zip,
    // then proceed exactly like a normal package.
    if (isEncryptedPackage(entries)) {
      if (options.privateKey === undefined) {
        throw new PackageError(
          'encryption',
          'This package is encrypted (§6b): paste the recipient private key (PEM) to open it',
        );
      }
      const innerZip = await decryptPackage(entries, options.privateKey);
      try {
        entries = unzipPackage(innerZip);
      } catch {
        throw new PackageError(
          'encryption',
          'Decrypted payload is not a valid .cap (ZIP) archive',
        );
      }
    }

    const metadataBytes = entries.get('metadata.json');
    if (!metadataBytes)
      throw new PackageError('config', 'metadata.json is required but missing');
    const metadata = parseMetadata(
      parseJsonConfig('metadata.json', metadataBytes),
    );

    const storageBytes = entries.get('storage.json');
    const storage = storageBytes
      ? parseStorage(parseJsonConfig('storage.json', storageBytes))
      : null;

    const manifestBytes = entries.get('manifest.json');
    const manifest = manifestBytes
      ? parseManifest(parseJsonConfig('manifest.json', manifestBytes))
      : generateManifest(
          hasLayers(storage)
            ? mergedContentPaths(entries, storage)
            : contentPathsOf(entries),
        );

    const routesBytes = entries.get('routes.json');
    const routes = routesBytes
      ? parseRoutes(parseJsonConfig('routes.json', routesBytes))
      : generateRoutes(manifest, storage);

    let checksums: LoadedPackage['checksums'] = 'absent';
    let signature: LoadedPackage['signature'] = 'absent';
    const securityBytes = entries.get('security.json');
    if (securityBytes) {
      const security = parseSecurity(
        parseJsonConfig('security.json', securityBytes),
      );
      await this.verifyIntegrity(entries, security);
      checksums = 'verified';
      if (security.security.digitalSignatures !== undefined) {
        await verifyPackageSignature(entries, security);
        signature = 'verified';
      }
    }

    const authentication = this.parseAuthenticationConfig(entries);
    const files = this.extractFiles(entries, manifest, storage, authentication);
    const tombstones = hasLayers(storage)
      ? collectTombstones(entries, storage)
      : {};

    return {
      metadata,
      manifest,
      routes,
      storage,
      files,
      checksums,
      signature,
      tombstones,
      authentication,
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

  /** Parse authentication.json when present (§4b; OAuth2 config-only). */
  private parseAuthenticationConfig(
    entries: Map<string, Uint8Array>,
  ): AuthenticationFile | null {
    const bytes = entries.get('authentication.json');
    if (bytes === undefined) return null;
    return parseAuthentication(parseJsonConfig('authentication.json', bytes));
  }

  private extractFiles(
    entries: Map<string, Uint8Array>,
    manifest: Manifest,
    storage: StorageFile | null,
    authentication: AuthenticationFile | null,
  ): ExtractedFile[] {
    if (hasLayers(storage)) {
      return this.extractLayeredFiles(
        entries,
        manifest,
        storage,
        authentication,
      );
    }

    const paths = new Set<string>(Object.keys(manifest.resources));
    if (storage) {
      for (const dataSet of Object.values(storage.storage.dataSets)) {
        if (dataSet.source !== undefined) paths.add(dataSet.source);
        if (dataSet.databaseFile !== undefined) paths.add(dataSet.databaseFile);
      }
    }
    const passwdFile = requiredPasswdFile(authentication);
    if (passwdFile !== null) paths.add(passwdFile);

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

  /**
   * §5a extraction: keep every non-config file under its RAW path (content/
   * tree, `<layer>/x`, plus root-level files such as dataset sources) so
   * serving can resolve the merged view top → bottom (and dependent
   * packages see only exported layers). Referenced resources must resolve
   * `found` or `tombstoned`; a plain `not-found` is a packaging error.
   */
  private extractLayeredFiles(
    entries: Map<string, Uint8Array>,
    manifest: Manifest,
    storage: StorageFile | null,
    authentication: AuthenticationFile | null,
  ): ExtractedFile[] {
    const view = entriesFileView(entries);
    const referenced = new Set<string>(Object.keys(manifest.resources));
    if (storage) {
      for (const dataSet of Object.values(storage.storage.dataSets)) {
        if (dataSet.source !== undefined) referenced.add(dataSet.source);
        if (dataSet.databaseFile !== undefined)
          referenced.add(dataSet.databaseFile);
      }
    }
    for (const path of referenced) {
      if (
        resolveLayeredPath(view, storage, path, 'self').kind === 'not-found'
      ) {
        throw new PackageError(
          'missing-resource',
          `File "${path}" is referenced by the package but not present in any layer`,
        );
      }
    }

    const passwdFile = requiredPasswdFile(authentication);
    const files: ExtractedFile[] = [];
    for (const [path, bytes] of [...entries.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (CONFIG_FILES.has(path)) continue;
      if (path === TOMBSTONES_FILE || path.endsWith(`/${TOMBSTONES_FILE}`))
        continue;
      const merged = mergedPathFor(storage, path);
      const contentType =
        manifest.resources[merged ?? path]?.type ?? detectMimeType(path);
      files.push({ path, bytes, contentType, isText: isTextMime(contentType) });
    }
    if (
      passwdFile !== null &&
      !files.some((file) => file.path === passwdFile)
    ) {
      throw new PackageError(
        'missing-resource',
        `basicAuth passwdFile "${passwdFile}" is not present in the archive`,
      );
    }
    return files;
  }
}

function contentPathsOf(entries: Map<string, Uint8Array>): string[] {
  return [...entries.keys()].filter(
    (path) => path.startsWith('content/') && !path.endsWith('/'),
  );
}

/** The htpasswd file an enabled basicAuth config requires (§4b), if any. */
function requiredPasswdFile(
  authentication: AuthenticationFile | null,
): string | null {
  const basic = authentication?.authentication.basicAuth;
  return basic?.enabled === true ? basic.passwdFile : null;
}

/** Package config/envelope files never stored as servable content. */
const CONFIG_FILES = new Set([
  'metadata.json',
  'manifest.json',
  'routes.json',
  'storage.json',
  'security.json',
  'authentication.json',
  'signature.json',
  'signature.sig',
]);
