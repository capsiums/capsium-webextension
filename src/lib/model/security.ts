import { z } from 'zod';
import { ModelError } from './index';

/**
 * security.json — ARCHITECTURE.md §6 (generated at pack time).
 *
 * Checksums cover EVERY file in the package except security.json itself.
 * Loaders MUST verify SHA-256 checksums when security.json is present and
 * REJECT the package on mismatch. Digital signatures are a later phase;
 * they are parsed but not verified.
 */

export const securitySchema = z.object({
  security: z.looseObject({
    integrityChecks: z.looseObject({
      checksumAlgorithm: z.string().min(1),
      /** package-relative path -> lowercase hex digest */
      checksums: z.record(z.string(), z.string().regex(/^[0-9a-f]+$/i)),
    }),
    digitalSignatures: z
      .looseObject({
        publicKey: z.string().optional(),
        signatureFile: z.string().optional(),
      })
      .optional(),
  }),
});

export type SecurityFile = z.infer<typeof securitySchema>;

export function parseSecurity(input: unknown): SecurityFile {
  const result = securitySchema.safeParse(input);
  if (!result.success) {
    throw new ModelError(
      'security.json',
      result.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
