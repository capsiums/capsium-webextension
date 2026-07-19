import { z } from 'zod';
import { ModelError } from './index';
import { detectMimeType } from '../mime';

/**
 * manifest.json — ARCHITECTURE.md §3.
 *
 * Canonical form: object keyed by package-relative resource path.
 * Legacy gem form `{"content": [{file, mime}]}` is accepted on read; legacy
 * `file` paths are relative to `content/` and are normalized to
 * package-relative paths.
 */

export const resourceSchema = z.object({
  /** MIME type of the resource. */
  type: z.string().min(1),
  visibility: z.enum(['exported', 'private']).default('exported'),
  version: z.string().optional(),
});

export const manifestSchema = z.object({
  resources: z.record(z.string(), resourceSchema),
});

export type ManifestResource = z.infer<typeof resourceSchema>;
export type Manifest = z.infer<typeof manifestSchema>;

const legacyManifestEntrySchema = z.looseObject({
  file: z.string().min(1),
  mime: z.string().min(1),
});

const legacyManifestSchema = z.object({
  content: z.array(legacyManifestEntrySchema),
});

/** Legacy file paths are relative to content/ unless already package-relative. */
export function legacyFileToResourcePath(file: string): string {
  return file.startsWith('content/') ? file : `content/${file}`;
}

export function parseManifest(input: unknown): Manifest {
  const canonical = manifestSchema.safeParse(input);
  if (canonical.success) return canonical.data;

  const legacy = legacyManifestSchema.safeParse(input);
  if (legacy.success) {
    return {
      resources: Object.fromEntries(
        legacy.data.content.map((entry) => [
          legacyFileToResourcePath(entry.file),
          { type: entry.mime, visibility: 'exported' as const },
        ]),
      ),
    };
  }

  throw new ModelError(
    'manifest.json',
    canonical.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    ),
  );
}

/**
 * Auto-generate a manifest by scanning content/ recursively (§3).
 * `contentPaths` must be package-relative paths under content/.
 */
export function generateManifest(contentPaths: string[]): Manifest {
  const resources: Record<string, ManifestResource> = {};
  for (const path of [...contentPaths].sort()) {
    resources[path] = { type: detectMimeType(path), visibility: 'exported' };
  }
  return { resources };
}
