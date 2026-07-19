import { z } from 'zod';
import { ModelError } from './index';

/**
 * metadata.json — ARCHITECTURE.md §2 (hand-authored).
 *
 * Canonical `dependencies` is an object mapping package guid -> semver range.
 * The legacy gem form `[{name, version}]` is accepted on read and normalized
 * to the object form.
 */

const legacyDependencySchema = z.looseObject({
  name: z.string().min(1),
  version: z.string().optional(),
});

export const dependenciesSchema = z
  .union([
    z.record(z.string(), z.string()),
    z
      .array(legacyDependencySchema)
      .transform((list) =>
        Object.fromEntries(list.map((dep) => [dep.name, dep.version ?? '*'])),
      ),
  ])
  .default({});

export const metadataSchema = z.object({
  /** kebab-case in canonical packages; accepted leniently on read (legacy fixtures use snake_case). */
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  /** Canonical: URI identifying the package. Optional on read (legacy packages lack it). */
  guid: z.string().optional(),
  uuid: z.string().optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  repository: z
    .looseObject({ type: z.string().optional(), url: z.string().optional() })
    .optional(),
  dependencies: dependenciesSchema,
  readOnly: z.boolean().optional(),
});

export type Metadata = z.infer<typeof metadataSchema>;

export function parseMetadata(input: unknown): Metadata {
  const result = metadataSchema.safeParse(input);
  if (!result.success) {
    throw new ModelError(
      'metadata.json',
      result.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
