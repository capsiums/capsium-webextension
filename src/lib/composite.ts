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
 * Dependency resource references look like
 * `capsium://<guid-without-scheme>/<package-relative path>` — with
 * dependency guid `capsium://example.com/core`, the reference
 * `capsium://example.com/core/content/app.js` addresses `content/app.js`
 * of that dependency. The longest guid prefix wins.
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
 * Parse a `capsium://` resource reference against the known dependency
 * guids (longest guid prefix wins). Returns null when no guid matches.
 */
export function parseDependencyResourceRef(
  resource: string,
  dependencyGuids: Iterable<string>,
): DependencyResourceRef | null {
  if (!isDependencyResourceRef(resource)) return null;
  const rest = resource.slice(CAPSIUM_SCHEME.length);
  let best: DependencyResourceRef | null = null;
  for (const guid of dependencyGuids) {
    const key = stripScheme(guid);
    if (rest.startsWith(`${key}/`) && rest.length > key.length + 1) {
      if (best === null || key.length > stripScheme(best.guid).length) {
        best = { guid, path: rest.slice(key.length + 1) };
      }
    }
  }
  return best;
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
