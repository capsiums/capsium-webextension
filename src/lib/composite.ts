/**
 * Composite packages (ARCHITECTURE.md §4a), viewer-scoped. Ported from
 * capsium-js `@capsium/core` composite.ts, adapted to the extension's
 * stored-package shape.
 *
 * The viewer has no package store directory: the popup lists a composite
 * package's declared dependencies and the user supplies the dependency
 * .cap files in the same session. A dependency's content becomes a lower
 * read-only layer under the dependent's URL space; only `exported`
 * resources/routes are visible and its private layers do not apply (§5a).
 *
 * Dependency resource references address an installed dependency's content
 * as `<dependency-guid>/<package-relative path>` — with dependency guid
 * `capsium://example.com/core`, the reference
 * `capsium://example.com/core/content/app.js` addresses `content/app.js`
 * of that dependency. Guids of any URI scheme work the same way (the
 * reference reactor's `https://…` guids included); the longest matching
 * guid prefix wins.
 */
import { resolveLayeredPath, storedFileView } from './layers';
import type { Manifest, StorageFile } from './model';

export const CAPSIUM_SCHEME = 'capsium://';

/** A dependency could not be resolved/installed for a composite package. */
export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyError';
  }
}

function stripScheme(uri: string): string {
  const index = uri.indexOf('://');
  return index === -1 ? uri : uri.slice(index + 3);
}

export interface DependencyResourceRef {
  readonly guid: string;
  /** Package-relative path inside the dependency (e.g. `content/app.js`). */
  readonly path: string;
}

/** True when `resource` is a dependency reference (`capsium://...`). */
export function isDependencyResourceRef(resource: string): boolean {
  return resource.startsWith(CAPSIUM_SCHEME);
}

/**
 * Parse a dependency resource reference against the known dependency guids
 * (longest matching prefix wins). Two forms are recognized:
 *
 *  - the full-guid form `<guid>/<path>` with any URI-scheme guid, e.g.
 *    `https://conformance.capsiums.dev/core/content/app.js` (the reference
 *    reactor's form);
 *  - the capsium:// form `capsium://<guid-without-scheme>/<path>`, e.g.
 *    `capsium://example.com/core/content/app.js`.
 *
 * Returns null when no dependency guid prefixes the reference.
 */
export function parseDependencyResourceRef(
  resource: string,
  dependencyGuids: Iterable<string>,
): DependencyResourceRef | null {
  let best: DependencyResourceRef | null = null;
  let bestLength = -1;
  for (const guid of dependencyGuids) {
    for (const key of guidPrefixes(resource, guid)) {
      if (
        resource.startsWith(`${key}/`) &&
        resource.length > key.length + 1 &&
        key.length > bestLength
      ) {
        best = { guid, path: resource.slice(key.length + 1) };
        bestLength = key.length;
      }
    }
  }
  return best;
}

/**
 * The prefixes under which `resource` may address `guid`: the full guid
 * itself, plus the scheme-stripped capsium:// form for capsium://
 * references.
 */
function guidPrefixes(resource: string, guid: string): string[] {
  const prefixes = [guid];
  if (resource.startsWith(CAPSIUM_SCHEME)) {
    prefixes.push(`${CAPSIUM_SCHEME}${stripScheme(guid)}`);
  }
  return prefixes;
}

/** The stored pieces of an installed dependency needed for serving. */
export interface DependencyServingView {
  readonly guid: string;
  readonly manifest: Manifest;
  readonly storage: StorageFile | null;
  readonly filePaths: Iterable<string>;
  readonly tombstones: Record<string, string[]>;
}

export type DependencyResourceResolution =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'private'; readonly path: string }
  | { readonly kind: 'not-found'; readonly path: string };

/**
 * Resolve a package-relative path against an installed dependency from the
 * dependent viewpoint: the dependency's layers apply with private layers
 * excluded (§5a), and only `exported` manifest resources are visible —
 * referencing a `private` resource of a dependency is an error (§4a).
 */
export function resolveDependencyResource(
  dependency: DependencyServingView,
  path: string,
): DependencyResourceResolution {
  const layered = resolveLayeredPath(
    storedFileView(dependency.filePaths, dependency.tombstones),
    dependency.storage,
    path,
    'dependent',
  );
  if (layered.kind !== 'found') return { kind: 'not-found', path };
  const resource = dependency.manifest.resources[path];
  if (resource !== undefined && resource.visibility === 'private') {
    return { kind: 'private', path };
  }
  return { kind: 'found', path: layered.path };
}
