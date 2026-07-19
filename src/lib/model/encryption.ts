import { z } from 'zod';
import { ModelError } from './index';

/**
 * signature.json — the cleartext encryption envelope of an encrypted
 * package (ARCHITECTURE.md §6b). NOT to be confused with signature.sig
 * (the raw digital-signature bytes, §6a).
 *
 * The encrypted .cap zip holds only:
 *   metadata.json   (cleartext, for identification)
 *   signature.json  (this envelope)
 *   package.enc     (AES-256-GCM ciphertext of the inner zip)
 */

export const encryptionEnvelopeSchema = z.object({
  encryption: z.looseObject({
    algorithm: z.literal('AES-256-GCM'),
    /** DEK wrapped for the recipient's RSA key (OAEP, SHA-256, MGF1-SHA256). */
    keyManagement: z.literal('RSA-OAEP-SHA256'),
    /** base64 RSA-OAEP-SHA256-wrapped 32-byte data-encryption key. */
    encryptedDek: z.string().min(1),
    /** base64 12-byte GCM IV. */
    iv: z.string().min(1),
    /** base64 16-byte GCM auth tag. */
    authTag: z.string().min(1),
  }),
});

export type EncryptionEnvelope = z.infer<typeof encryptionEnvelopeSchema>;

export function parseEncryptionEnvelope(input: unknown): EncryptionEnvelope {
  const result = encryptionEnvelopeSchema.safeParse(input);
  if (!result.success) {
    throw new ModelError(
      'signature.json',
      result.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
