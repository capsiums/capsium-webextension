import { z } from 'zod';
import { ModelError } from './index';
import type { Manifest } from './manifest';
import type { StorageFile } from './storage';

/**
 * routes.json — ARCHITECTURE.md §4.
 *
 * Canonical form: top-level optional `index` + `routes` ARRAY of route
 * objects. Also accepted on read:
 *  - the standard's object-keyed-by-path form;
 *  - the legacy gem form where a route is `{path, target: {file}}` with
 *    `file` relative to content/.
 *
 * Route kinds are MECE, discriminated by key: static (`resource`), dataset
 * (`dataset`), dynamic handler (`method` + `handler`, accepted and ignored —
 * reactors respond 501; execution is out of scope).
 */

export const staticRouteSchema = z.object({
  path: z.string().startsWith('/'),
  resource: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  headersFile: z.string().optional(),
  visibility: z.enum(['exported', 'private']).optional(),
});

export const datasetRouteSchema = z.object({
  path: z.string().startsWith('/api/v1/data/'),
  dataset: z.string().min(1),
  accessControl: z.unknown().optional(),
});

export const handlerRouteSchema = z.object({
  path: z.string().startsWith('/'),
  method: z.string().min(1),
  handler: z.string().min(1),
});

export const routeSchema = z.union([
  staticRouteSchema,
  datasetRouteSchema,
  handlerRouteSchema,
]);

export const routesFileSchema = z.object({
  /** Package-relative path of the entry resource, e.g. "content/index.html". */
  index: z.string().optional(),
  routes: z.array(routeSchema),
});

export type StaticRoute = z.infer<typeof staticRouteSchema>;
export type DatasetRoute = z.infer<typeof datasetRouteSchema>;
export type HandlerRoute = z.infer<typeof handlerRouteSchema>;
export type Route = z.infer<typeof routeSchema>;
export type RoutesFile = z.infer<typeof routesFileSchema>;

const legacyTargetSchema = z.looseObject({
  file: z.string().min(1),
});

const legacyRouteSchema = z.looseObject({
  path: z.string().startsWith('/'),
  target: legacyTargetSchema,
});

/** Legacy gem routes: {path, target: {file}} with file relative to content/. */
function normalizeLegacyRoute(
  route: z.infer<typeof legacyRouteSchema>,
): StaticRoute {
  const file = route.target.file;
  return {
    path: route.path,
    resource: file.startsWith('content/') ? file : `content/${file}`,
  };
}

/**
 * Normalize accepted read forms into the canonical {index?, routes: [...]}
 * shape before schema validation.
 */
function preprocessRoutesInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const record = input as Record<string, unknown>;
  const rawRoutes = record['routes'];

  let list: unknown[] | null = null;
  if (Array.isArray(rawRoutes)) {
    list = rawRoutes;
  } else if (typeof rawRoutes === 'object' && rawRoutes !== null) {
    // Object keyed by path form: inject the key as each route's path.
    list = Object.entries(rawRoutes).map(([path, route]) =>
      typeof route === 'object' && route !== null
        ? { path, ...(route as Record<string, unknown>) }
        : route,
    );
  }
  if (list === null) return input;

  const normalized = list.map((route) => {
    const legacy = legacyRouteSchema.safeParse(route);
    return legacy.success ? normalizeLegacyRoute(legacy.data) : route;
  });

  return { ...record, routes: normalized };
}

export function parseRoutes(input: unknown): RoutesFile {
  const result = routesFileSchema.safeParse(preprocessRoutesInput(input));
  if (!result.success) {
    throw new ModelError(
      'routes.json',
      result.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}

const HTML_EXTENSIONS = /\.(html?|htm)$/i;

function isHtmlResource(path: string, type: string): boolean {
  return type === 'text/html' || HTML_EXTENSIONS.test(path);
}

/**
 * Auto-generate routes (§4):
 *  - `index` -> content/index.html when present in the manifest;
 *  - every manifest resource gets a route with its path relative to content/;
 *  - HTML files get TWO routes (path without extension AND full filename);
 *  - the index HTML additionally gets `/`;
 *  - every dataset gets /api/v1/data/<id>.
 */
export function generateRoutes(
  manifest: Manifest,
  storage?: StorageFile | null,
): RoutesFile {
  const index =
    'content/index.html' in manifest.resources
      ? 'content/index.html'
      : undefined;
  const routes: Route[] = [];
  const seen = new Set<string>();

  const push = (route: Route): void => {
    if (seen.has(route.path)) return;
    seen.add(route.path);
    routes.push(route);
  };

  for (const path of Object.keys(manifest.resources).sort()) {
    if (!path.startsWith('content/')) continue;
    const resource = manifest.resources[path];
    if (!resource) continue;
    const urlPath = `/${path.slice('content/'.length)}`;

    if (isHtmlResource(path, resource.type)) {
      if (path === index) push({ path: '/', resource: path });
      push({ path: urlPath.replace(HTML_EXTENSIONS, ''), resource: path });
      push({ path: urlPath, resource: path });
    } else {
      push({ path: urlPath, resource: path });
    }
  }

  if (storage) {
    for (const id of Object.keys(storage.storage.dataSets).sort()) {
      push({ path: `/api/v1/data/${id}`, dataset: id });
    }
  }

  return index !== undefined ? { index, routes } : { routes };
}
