import { z } from 'zod';
import { ModelError } from './index';

/**
 * security.json — ARCHITECTURE.md §6 (generated at pack time).
 *
 * Checksums cover EVERY file in the package except security.json itself
 * (and signature.sig, which cannot be checksum-covered — the signed payload
 * is built from the checksum map). Loaders MUST verify SHA-256 checksums
 * when security.json is present and REJECT the package on mismatch; when
 * `digitalSignatures` is declared, the RSA-SHA256 signature is verified
 * with the same reject gate (§6a).
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
        /** package-relative path of an SPKI "PUBLIC KEY" PEM */
        publicKey: z.string().min(1),
        /** package-relative path of the raw signature bytes */
        signatureFile: z.string().min(1),
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
