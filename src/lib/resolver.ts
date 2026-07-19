/**
 * Serve-time request resolution: `https://<capId>.cap<urlPath>` -> the
 * stored file that serves it.
 *
 * This replaces the data:-URI-era rule specs: instead of baking every
 * route's bytes into one DNR rule per route at install time, ONE per-package
 * DNR rule redirects every package URL to the router page, and the router
 * asks for a resolution at serve time. Resolution is therefore dynamic:
 * dependencies added mid-session (§4a) and basic-auth unlocks (§4b) take
 * effect without touching DNR rules.
 *
 * Route matching honors: exact paths and `remap` (§4a), dataset routes,
 * `capsium://` dependency references (longest guid prefix), layered storage
 * with tombstones (§5a, top -> bottom), private routes/resources/layers
 * hidden from dependents, and route inheritance attributes
 * (`responseRewrite.body` becomes a body override, `responseHeaders` /
 * `responseRewrite.headers` travel with the resolution). A package's own
 * routes win over inherited dependency routes.
 *
 * The module is pure: it never sees file bytes (those live in the file
 * store; the router reads them after resolving).
 */
import {
  isDependencyResourceRef,
  parseDependencyResourceRef,
  resolveDependencyResource,
  type DependencyServingView,
} from './composite';
import { hasLayers, resolveLayeredPath, storedFileView } from './layers';
import type { Route, RoutesFile, StaticRoute, StorageFile } from './model';

/** A package's serving view: metadata + file paths/types (never bytes). */
export interface PackageServingView {
  readonly capId: string;
  readonly routes: RoutesFile;
  readonly storage: StorageFile | null;
  readonly tombstones: Record<string, string[]>;
  /** raw path -> content type; the key set is the stored path list. */
  readonly fileTypes: Record<string, string>;
}

/** An installed dependency, resolvable from the dependent viewpoint (§4a). */
export interface InstalledDependencyView
  extends PackageServingView,
    DependencyServingView {}

/** The stored file serving one URL, plus serve-time-only overrides. */
export interface ResolvedFile {
  /** capId of the package OWNING the bytes (a dependency for §4a refs). */
  readonly capId: string;
  /** Raw stored path (layered packages: includes the layer directory). */
  readonly path: string;
  readonly contentType: string;
  /** §4a responseRewrite.body: serve this text instead of the stored bytes. */
  readonly bodyOverride?: string;
  /** §4a responseHeaders + responseRewrite.headers (applied where possible). */
  readonly responseHeaders?: Record<string, string>;
}

export type Resolution =
  | { readonly kind: 'found'; readonly file: ResolvedFile }
  | { readonly kind: 'not-found' };

const NOT_FOUND: Resolution = { kind: 'not-found' };

/** §4b: body rendered for every package URL until basic-auth credentials verify. */
export const UNAUTHORIZED_BODY = 'authentication required';

/** Stored-file lookup for a (possibly layered) package, self viewpoint. */
function servedFile(
  view: PackageServingView,
  resourcePath: string,
): ResolvedFile | null {
  if (!hasLayers(view.storage)) return fileOrNull(view, resourcePath);
  const resolution = resolveLayeredPath(
    storedFileView(Object.keys(view.fileTypes), view.tombstones),
    view.storage,
    resourcePath,
    'self',
  );
  if (resolution.kind !== 'found') return null;
  return fileOrNull(view, resolution.path);
}

function fileOrNull(
  view: PackageServingView,
  rawPath: string,
): ResolvedFile | null {
  const contentType = view.fileTypes[rawPath];
  if (contentType === undefined) return null;
  return { capId: view.capId, path: rawPath, contentType };
}

function found(file: ResolvedFile): Resolution {
  return { kind: 'found', file };
}

/** Apply §4a route-inheritance attributes to a resolved file. */
function applyInheritance(route: StaticRoute, file: ResolvedFile): ResolvedFile {
  const bodyOverride = route.responseRewrite?.body;
  // responseHeaders apply only when absent; responseRewrite.headers override.
  const responseHeaders = {
    ...route.responseHeaders,
    ...route.responseRewrite?.headers,
  };
  return {
    ...file,
    ...(bodyOverride === undefined ? {} : { bodyOverride }),
    ...(Object.keys(responseHeaders).length === 0 ? {} : { responseHeaders }),
  };
}

function datasetSource(
  storage: StorageFile | null,
  dataset: string,
): string | undefined {
  const dataSet = storage?.storage.dataSets[dataset];
  return dataSet?.source ?? dataSet?.databaseFile;
}

/** Resolve one of the package's own routes (self viewpoint, §4a refs allowed). */
function resolveOwnRoute(
  route: Route,
  view: PackageServingView,
  dependencies: InstalledDependencyView[],
): Resolution {
  if ('resource' in route) {
    let file: ResolvedFile | null;
    if (isDependencyResourceRef(route.resource)) {
      const ref = parseDependencyResourceRef(
        route.resource,
        dependencies.map((dep) => dep.guid),
      );
      const dep = dependencies.find((entry) => entry.guid === ref?.guid);
      if (ref === null || dep === undefined) return NOT_FOUND;
      const resolution = resolveDependencyResource(dep, ref.path);
      if (resolution.kind !== 'found') return NOT_FOUND;
      file = fileOrNull(dep, resolution.path);
    } else {
      file = servedFile(view, route.resource);
    }
    return file === null ? NOT_FOUND : found(applyInheritance(route, file));
  }
  if ('dataset' in route) {
    const source = datasetSource(view.storage, route.dataset);
    if (source === undefined) return NOT_FOUND;
    const file = servedFile(view, source);
    return file === null ? NOT_FOUND : found(file);
  }
  // handler routes: accepted but not served (execution deferred, 501).
  return NOT_FOUND;
}

/**
 * Resolve one inherited dependency route (dependent viewpoint): only
 * `exported` routes and resources (§4a), private layers excluded (§5a).
 * Transitive `capsium://` references are not supported in the viewer.
 */
function resolveDependencyRoute(
  route: Route,
  dep: InstalledDependencyView,
): Resolution {
  if ('resource' in route) {
    if (isDependencyResourceRef(route.resource)) return NOT_FOUND;
    const resolution = resolveDependencyResource(dep, route.resource);
    if (resolution.kind !== 'found') return NOT_FOUND;
    const file = fileOrNull(dep, resolution.path);
    return file === null ? NOT_FOUND : found(applyInheritance(route, file));
  }
  if ('dataset' in route) {
    const source = datasetSource(dep.storage, route.dataset);
    if (source === undefined) return NOT_FOUND;
    const resolution = resolveDependencyResource(dep, source);
    if (resolution.kind !== 'found') return NOT_FOUND;
    const file = fileOrNull(dep, resolution.path);
    return file === null ? NOT_FOUND : found(file);
  }
  return NOT_FOUND;
}

/** The URL path a route answers on (§4a `remap` wins over `path`). */
function matchedPath(route: Route): string {
  return 'dataset' in route ? route.path : (route.remap ?? route.path);
}

/** Route-level visibility (only static routes carry it). */
function isRoutePrivate(route: Route): boolean {
  return 'visibility' in route && route.visibility === 'private';
}

/**
 * Resolve a package URL path (e.g. `/assets/app.js`) to the stored file
 * serving it. The package's own routes are tried first (they win over
 * inherited dependency routes). Tombstoned/absent paths resolve not-found —
 * the router renders a 404 (the data:-URI core showed the browser's generic
 * unreachable-host page instead).
 */
export function resolveUrlPath(
  view: PackageServingView,
  dependencies: InstalledDependencyView[],
  urlPath: string,
): Resolution {
  for (const route of view.routes.routes) {
    if (matchedPath(route) === urlPath) {
      return resolveOwnRoute(route, view, dependencies);
    }
  }
  for (const dep of dependencies) {
    for (const route of dep.routes.routes) {
      if (isRoutePrivate(route)) continue;
      if (matchedPath(route) !== urlPath) continue;
      const resolution = resolveDependencyRoute(route, dep);
      if (resolution.kind === 'found') return resolution;
    }
  }
  return NOT_FOUND;
}

/**
 * Install-time route validation (packaging errors, caught before anything is
 * served — the data:-URI core threw the same errors while building rules):
 * own routes must reference existing resources/datasets, except with layered
 * storage where an unresolved resource simply 404s at serve time.
 * `capsium://` references are validated at serve time (dependencies may be
 * installed later in the session).
 */
export function validateRoutes(view: PackageServingView): void {
  const layered = hasLayers(view.storage);
  for (const route of view.routes.routes) {
    if ('resource' in route) {
      if (isDependencyResourceRef(route.resource)) continue;
      if (servedFile(view, route.resource) === null && !layered) {
        throw new Error(
          `Route ${route.path} references missing resource ${route.resource}`,
        );
      }
    } else if ('dataset' in route) {
      const source = datasetSource(view.storage, route.dataset);
      if (source === undefined) {
        throw new Error(
          `Route ${route.path} references unknown dataset "${route.dataset}"`,
        );
      }
      if (servedFile(view, source) === null && !layered) {
        throw new Error(
          `Dataset "${route.dataset}" source file ${source} not found`,
        );
      }
    }
  }
}
