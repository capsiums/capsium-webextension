/**
 * Domain model for Capsium packages.
 *
 * These zod schemas are the single source of truth for the canonical Capsium
 * schemas defined in ARCHITECTURE.md §2-6 (derived from the CC 62001 draft).
 * Legacy gem-era formats are accepted on read and normalized to the canonical
 * forms (see the ARCHITECTURE.md legacy-read rules).
 *
 * NOTE: capsium-js is building `@capsium/core` in parallel. Once published,
 * this model layer should converge on that shared package.
 */

export { parseMetadata, metadataSchema } from './metadata';
export type { Metadata } from './metadata';
export {
  parseManifest,
  generateManifest,
  manifestSchema,
  resourceSchema,
} from './manifest';
export type { Manifest, ManifestResource } from './manifest';
export {
  parseRoutes,
  generateRoutes,
  routesFileSchema,
  routeSchema,
} from './routes';
export type {
  RoutesFile,
  Route,
  StaticRoute,
  DatasetRoute,
  HandlerRoute,
} from './routes';
export { parseStorage, storageSchema } from './storage';
export type { StorageFile, DataSet } from './storage';
export { parseSecurity, securitySchema } from './security';
export type { SecurityFile } from './security';

/** Error thrown when a package config file fails schema validation. */
export class ModelError extends Error {
  constructor(
    /** Which config file failed, e.g. "metadata.json". */
    public readonly file: string,
    /** Human-readable list of validation issues. */
    public readonly issues: string[],
  ) {
    super(`Invalid ${file}: ${issues.join('; ')}`);
    this.name = 'ModelError';
  }
}
