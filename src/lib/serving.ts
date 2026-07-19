/**
 * Serving-spec construction: package routes (+ inherited dependency
 * routes, §4a) -> DNR rule specs.
 *
 * A composite package's routes may reference dependency resources
 * (`capsium://<guid>/<path>`) and each installed dependency contributes
 * its `exported` routes as a lower read-only layer under the dependent's
 * URL space (dependent routes win via a higher DNR priority). Route
 * inheritance attributes are honored: `remap` (matched path),
 * `responseRewrite.body` (baked into the served data: URI),
 * `responseRewrite.headers` / `responseHeaders` / `requestHeaders`
 * (companion modifyHeaders rules — see README for the data:-URI caveat).
 */
import { encodeBase64 } from './base64';
import {
  isDependencyResourceRef,
  parseDependencyResourceRef,
  resolveDependencyResource,
  type DependencyServingView,
} from './composite';
import { hasLayers, resolveLayeredPath, storedFileView } from './layers';
import type { RuleSpec } from './dnr';
import type { RoutesFile, StaticRoute, StorageFile } from './model';

/** Stored (base64) servable files keyed by package-relative path. */
export type ServingFiles = Map<string, { contentType: string; base64: string }>;

/** Everything needed to build one package's serving specs. */
export interface PackageServingView {
  readonly routes: RoutesFile;
  readonly storage: StorageFile | null;
  readonly tombstones: Record<string, string[]>;
  readonly files: ServingFiles;
}

/** An installed dependency, servable from the dependent viewpoint. */
export interface InstalledDependencyView
  extends PackageServingView,
    DependencyServingView {}

/**
 * Resolve a merged-view resource path to the stored file serving it.
 * Without layers: direct lookup. With layers (§5a): top → bottom;
 * tombstoned/absent yields null (no rule — the URL 404s).
 */
function servedFile(
  files: ServingFiles,
  storage: StorageFile | null,
  tombstones: Record<string, string[]>,
  resourcePath: string,
): { contentType: string; base64: string } | null {
  if (!hasLayers(storage)) return files.get(resourcePath) ?? null;
  const resolution = resolveLayeredPath(
    storedFileView(files.keys(), tombstones),
    storage,
    resourcePath,
    'self',
  );
  if (resolution.kind !== 'found') return null;
  return files.get(resolution.path) ?? null;
}

/** Apply route-inheritance attributes to produce the final spec (§4a). */
function inheritedSpec(
  route: StaticRoute,
  file: { contentType: string; base64: string },
  priority?: number,
): RuleSpec {
  const rewrittenBody = route.responseRewrite?.body;
  // responseHeaders apply only when absent; responseRewrite.headers override.
  const responseHeaders = {
    ...route.responseHeaders,
    ...route.responseRewrite?.headers,
  };
  return {
    path: route.remap ?? route.path,
    dataUri:
      rewrittenBody === undefined
        ? `data:${file.contentType};base64,${file.base64}`
        : `data:${file.contentType};base64,${encodeBase64(new TextEncoder().encode(rewrittenBody))}`,
    ...(priority === undefined ? {} : { priority }),
    ...(route.requestHeaders === undefined
      ? {}
      : { requestHeaders: route.requestHeaders }),
    ...(Object.keys(responseHeaders).length === 0
      ? {}
      : { responseHeaders }),
  };
}

/**
 * Specs for a package's own routes. `capsium://` references resolve
 * against the installed dependencies (uninstalled/private/missing → the
 * route is not served). Without layers a missing resource throws (a
 * packaging error); with layers it is skipped (404).
 */
export function buildOwnRuleSpecs(
  pkg: PackageServingView,
  dependencies: InstalledDependencyView[] = [],
  priority?: number,
): RuleSpec[] {
  const layered = hasLayers(pkg.storage);
  const specs: RuleSpec[] = [];
  for (const route of pkg.routes.routes) {
    if ('resource' in route) {
      let file: { contentType: string; base64: string } | null;
      if (isDependencyResourceRef(route.resource)) {
        const ref = parseDependencyResourceRef(
          route.resource,
          dependencies.map((dep) => dep.guid),
        );
        const dep = dependencies.find((entry) => entry.guid === ref?.guid);
        if (ref === null || dep === undefined) continue; // not installed
        const resolution = resolveDependencyResource(dep, ref.path);
        if (resolution.kind !== 'found') continue; // private / missing → 404
        file = dep.files.get(resolution.path) ?? null;
      } else {
        file = servedFile(pkg.files, pkg.storage, pkg.tombstones, route.resource);
        if (file === null && !layered) {
          throw new Error(
            `Route ${route.path} references missing resource ${route.resource}`,
          );
        }
      }
      if (file === null) continue;
      specs.push(inheritedSpec(route, file, priority));
    } else if ('dataset' in route) {
      const dataSet = pkg.storage?.storage.dataSets[route.dataset];
      const source = dataSet?.source ?? dataSet?.databaseFile;
      if (source === undefined) {
        throw new Error(
          `Route ${route.path} references unknown dataset "${route.dataset}"`,
        );
      }
      const file = servedFile(pkg.files, pkg.storage, pkg.tombstones, source);
      if (file === null) {
        if (layered) continue;
        throw new Error(
          `Dataset "${route.dataset}" source file ${source} not found`,
        );
      }
      specs.push({
        path: route.path,
        dataUri: `data:${file.contentType};base64,${file.base64}`,
        ...(priority === undefined ? {} : { priority }),
      });
    }
    // handler routes: accepted but not served (execution deferred, 501).
  }
  return specs;
}

/**
 * Specs inherited from one installed dependency: only `exported` routes,
 * only `exported` resources (§4a), private layers excluded (§5a), at the
 * given (lower) priority. Transitive `capsium://` references are not
 * supported in the viewer and are skipped.
 */
export function buildDependencyRuleSpecs(
  dep: InstalledDependencyView,
  priority?: number,
): RuleSpec[] {
  const specs: RuleSpec[] = [];
  for (const route of dep.routes.routes) {
    if ('resource' in route) {
      if (route.visibility === 'private') continue;
      if (isDependencyResourceRef(route.resource)) continue;
      const resolution = resolveDependencyResource(dep, route.resource);
      if (resolution.kind !== 'found') continue;
      const file = dep.files.get(resolution.path);
      if (file === undefined) continue;
      specs.push(inheritedSpec(route, file, priority));
    } else if ('dataset' in route) {
      const dataSet = dep.storage?.storage.dataSets[route.dataset];
      const source = dataSet?.source ?? dataSet?.databaseFile;
      if (source === undefined) continue;
      const resolution = resolveDependencyResource(dep, source);
      if (resolution.kind !== 'found') continue;
      const file = dep.files.get(resolution.path);
      if (file === undefined) continue;
      specs.push({
        path: route.path,
        dataUri: `data:${file.contentType};base64,${file.base64}`,
        ...(priority === undefined ? {} : { priority }),
      });
    }
  }
  return specs;
}

/** DNR priorities: the dependent's own routes beat inherited routes. */
export const OWN_PRIORITY = 2;
export const DEPENDENCY_PRIORITY = 1;

/** §4b: body shown for every package URL until basic-auth credentials verify. */
export const UNAUTHORIZED_BODY = 'authentication required';

const unauthorizedDataUri = `data:text/plain;base64,${encodeBase64(new TextEncoder().encode(UNAUTHORIZED_BODY))}`;

/**
 * Locked variants of a package's specs (§4b basicAuth, no verified session
 * yet): same paths/priorities, but every route serves the 401 body and no
 * headers are attached.
 */
export function lockRuleSpecs(specs: RuleSpec[]): RuleSpec[] {
  return specs.map((spec) => ({
    path: spec.path,
    dataUri: unauthorizedDataUri,
    ...(spec.priority === undefined ? {} : { priority: spec.priority }),
  }));
}

/**
 * The package-wide Authorization header rule (§4b): after credentials
 * verify, the serving layer attaches `Authorization: Basic …` to every
 * request under the package's origin.
 */
export function authorizationHeaderSpec(credentials: {
  username: string;
  password: string;
}): RuleSpec {
  const token = encodeBase64(
    new TextEncoder().encode(`${credentials.username}:${credentials.password}`),
  );
  return {
    path: '/',
    dataUri: '',
    prefixMatch: true,
    headersOnly: true,
    requestHeaders: { Authorization: `Basic ${token}` },
  };
}

/**
 * Specs for a (possibly composite) package: its own routes at a higher
 * priority plus every installed dependency's exported routes as a lower
 * layer. Without dependencies the output is identical to the plain
 * single-package specs.
 */
export function buildCompositeRuleSpecs(
  pkg: PackageServingView,
  dependencies: InstalledDependencyView[],
): RuleSpec[] {
  if (dependencies.length === 0) return buildOwnRuleSpecs(pkg);
  return [
    ...buildOwnRuleSpecs(pkg, dependencies, OWN_PRIORITY),
    ...dependencies.flatMap((dep) =>
      buildDependencyRuleSpecs(dep, DEPENDENCY_PRIORITY),
    ),
  ];
}
