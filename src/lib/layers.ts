/**
 * Layered storage overlay semantics (ARCHITECTURE.md §5a), aligned with
 * capsium-js `@capsium/core` layers.ts and the reference Ruby reactor:
 *
 * - The content/ tree is always the implicit bottom layer; configured
 *   `storage.layers` stack on top of it in declaration order (bottom →
 *   top).
 * - Each configured layer is a package-relative directory mirroring the
 *   content/ tree: layer `base` serves `base/index.html` as
 *   `content/index.html`.
 * - The merged view resolves TOP → bottom; first hit wins.
 * - Deletions are recorded as tombstones: a JSON file `.capsium-tombstones`
 *   in a layer listing content/-relative paths; a tombstoned path resolves
 *   404 even when a lower layer (or a dependency) has it.
 * - Paths outside content/ (e.g. dataset sources) address the package file
 *   directly first, then fall through to the layer directories (a
 *   viewer convenience — the reference semantics keep them at the root).
 * - `visibility: private` layers are not exposed to dependent packages
 *   (composite view, §4a).
 *
 * Resolution runs against a minimal LayerFileView so the same code serves
 * the load-time archive map and the serving-time stored file set (where
 * tombstones were parsed at load and persisted alongside the package).
 */
import type { StorageFile, StorageLayer } from './model';

/** Tombstone file name inside a layer (JSON array of content/-relative paths). */
export const TOMBSTONES_FILE = '.capsium-tombstones';

/** Name of the package content directory (the implicit bottom layer). */
const CONTENT_PREFIX = 'content/';

/** The implicit bottom layer every package has: the content/ tree itself. */
const IMPLICIT_LAYER: StorageLayer = { path: 'content' };

/** Minimal file view layered resolution needs. */
export interface LayerFileView {
  has(path: string): boolean;
  /** Parsed tombstoned content/-relative paths of the layer directory. */
  tombstones(layerPath: string): ReadonlySet<string>;
}

/** True when the package declares an overlay stack (§5a). */
export function hasLayers(storage: StorageFile | null | undefined): boolean {
  return (storage?.storage.layers?.length ?? 0) > 0;
}

/**
 * Effective layers bottom → top: the implicit content/ layer plus the
 * configured storage.layers in declaration order.
 */
export function storageLayers(
  storage: StorageFile | null | undefined,
): readonly StorageLayer[] {
  return [IMPLICIT_LAYER, ...(storage?.storage.layers ?? [])];
}

function layerVisibility(layer: StorageLayer): 'exported' | 'private' {
  return layer.visibility ?? 'exported';
}

/**
 * Layers visible from a viewpoint: the package itself sees all layers;
 * dependent packages (§4a composite view) see only `exported` layers.
 */
export function visibleLayers(
  storage: StorageFile | null | undefined,
  viewpoint: 'self' | 'dependent',
): readonly StorageLayer[] {
  const layers = storageLayers(storage);
  if (viewpoint === 'self') return layers;
  return layers.filter((layer) => layerVisibility(layer) === 'exported');
}

/** Join a layer directory with a package-relative path. */
export function layerFilePath(layer: StorageLayer, path: string): string {
  const relative = path.startsWith(CONTENT_PREFIX)
    ? path.slice(CONTENT_PREFIX.length)
    : path;
  return `${layer.path}/${relative}`;
}

export type LayeredResolution =
  | {
      readonly kind: 'found';
      readonly path: string;
      readonly layer: StorageLayer;
    }
  | { readonly kind: 'tombstoned' }
  | { readonly kind: 'not-found' };

/**
 * Resolve a package-relative path (e.g. `content/index.html`) against the
 * layers visible from `viewpoint`, TOP → bottom; first hit wins.
 *
 * Content paths: the content/ prefix is stripped and the remaining
 * content/-relative path is looked up in every layer; a path tombstoned at
 * or above the first serving layer resolves `tombstoned` (reactors answer
 * 404) even when a lower layer has it. The tombstone marker itself is never
 * served.
 *
 * Paths outside content/ (dataset sources, htpasswd files) address the
 * package file directly first, then fall through to the layer directories;
 * tombstones do not apply to them.
 */
export function resolveLayeredPath(
  view: LayerFileView,
  storage: StorageFile | null | undefined,
  path: string,
  viewpoint: 'self' | 'dependent' = 'self',
): LayeredResolution {
  if (!path.startsWith(CONTENT_PREFIX)) {
    if (view.has(path)) return { kind: 'found', path, layer: IMPLICIT_LAYER };
    const layers = [...visibleLayers(storage, viewpoint)].reverse();
    for (const layer of layers) {
      const candidate = `${layer.path}/${path}`;
      if (view.has(candidate)) {
        return { kind: 'found', path: candidate, layer };
      }
    }
    return { kind: 'not-found' };
  }

  const relative = path.slice(CONTENT_PREFIX.length);
  if (relative === TOMBSTONES_FILE) return { kind: 'not-found' };

  const layers = [...visibleLayers(storage, viewpoint)].reverse(); // top → bottom
  let tombstoned = false;
  for (const layer of layers) {
    tombstoned ||= view.tombstones(layer.path).has(relative);
    const candidate = layerFilePath(layer, path);
    if (view.has(candidate)) {
      return tombstoned
        ? { kind: 'tombstoned' }
        : { kind: 'found', path: candidate, layer };
    }
  }
  return tombstoned ? { kind: 'tombstoned' } : { kind: 'not-found' };
}

const decoder = new TextDecoder();

/** Parse one layer's tombstone file content (empty on absent/malformed). */
function parseTombstones(bytes: Uint8Array | undefined): ReadonlySet<string> {
  if (bytes === undefined) return new Set();
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((entry): entry is string => typeof entry === 'string'),
    );
  } catch {
    return new Set();
  }
}

/** Load-time view over the unzipped archive (tombstones parsed on demand). */
export function entriesFileView(
  entries: ReadonlyMap<string, Uint8Array>,
): LayerFileView {
  const memo = new Map<string, ReadonlySet<string>>();
  return {
    has: (path) => entries.has(path),
    tombstones: (layerPath) => {
      let parsed = memo.get(layerPath);
      if (parsed === undefined) {
        parsed = parseTombstones(
          entries.get(layerFilePath({ path: layerPath }, TOMBSTONES_FILE)),
        );
        memo.set(layerPath, parsed);
      }
      return parsed;
    },
  };
}

/**
 * Serving-time view over the stored file paths, with the tombstones parsed
 * at load time and persisted in the package info.
 */
export function storedFileView(
  paths: Iterable<string>,
  tombstones: Record<string, string[]>,
): LayerFileView {
  const set = new Set(paths);
  return {
    has: (path) => set.has(path),
    tombstones: (layerPath) => new Set(tombstones[layerPath] ?? []),
  };
}

/**
 * Tombstones of every configured layer, parsed for persistence
 * (layer directory -> deleted merged-view paths).
 */
export function collectTombstones(
  entries: ReadonlyMap<string, Uint8Array>,
  storage: StorageFile | null | undefined,
): Record<string, string[]> {
  const view = entriesFileView(entries);
  const out: Record<string, string[]> = {};
  for (const layer of storageLayers(storage)) {
    const deleted = [...view.tombstones(layer.path)];
    if (deleted.length > 0) out[layer.path] = deleted;
  }
  return out;
}

/**
 * Merged-view content paths (for manifest auto-generation when layers are
 * configured): the content/ tree plus every `content/…` file of every
 * visible layer, minus tombstoned paths.
 */
export function mergedContentPaths(
  entries: ReadonlyMap<string, Uint8Array>,
  storage: StorageFile | null | undefined,
): string[] {
  const view = entriesFileView(entries);
  const merged = new Set<string>();
  const tombstoned = new Set<string>();
  for (const layer of visibleLayers(storage, 'self')) {
    for (const deleted of view.tombstones(layer.path)) tombstoned.add(deleted);
    const dirPrefix = `${layer.path}/`;
    for (const path of entries.keys()) {
      if (!path.startsWith(dirPrefix) || path.endsWith('/')) continue;
      const relative = path.slice(dirPrefix.length);
      if (relative === TOMBSTONES_FILE) continue;
      merged.add(`${CONTENT_PREFIX}${relative}`);
    }
  }
  for (const deleted of tombstoned) {
    merged.delete(`${CONTENT_PREFIX}${deleted}`);
  }
  return [...merged].sort();
}

/**
 * Map a stored (raw) package path back to its merged-view path: the
 * content/ tree maps onto itself, a layer file `base/x` maps to
 * `content/x`. Returns the path unchanged when no layers are configured,
 * null when the path is not part of the merged view.
 */
export function mergedPathFor(
  storage: StorageFile | null | undefined,
  rawPath: string,
): string | null {
  if (!hasLayers(storage)) return rawPath;
  for (const layer of storageLayers(storage)) {
    const prefix = `${layer.path}/`;
    if (rawPath.startsWith(prefix)) {
      return `${CONTENT_PREFIX}${rawPath.slice(prefix.length)}`;
    }
  }
  return null;
}
