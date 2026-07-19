import { z } from 'zod';
import { ModelError } from './index';

/**
 * authentication.json — ARCHITECTURE.md §4b (per 05x-authentication).
 *
 * Basic auth: the reactor challenges (401 + WWW-Authenticate) when enabled
 * and verifies credentials against the packaged htpasswd file.
 *
 * OAuth2 is MODELLED ONLY in the viewer: the extension is not a
 * confidential client (secrets would have to ship with the package, which
 * §4b forbids — they belong to deploy.json), so the authorization-code
 * flow is explicitly deferred. The config is parsed and carried, nothing
 * more.
 */

export const basicAuthSchema = z.looseObject({
  enabled: z.boolean(),
  /** package-relative htpasswd file, e.g. "auth/.htpasswd". */
  passwdFile: z.string().min(1),
  realm: z.string().min(1).optional(),
});

export const oauth2Schema = z.looseObject({
  enabled: z.boolean(),
  provider: z.string().min(1).optional(),
  clientId: z.string().min(1),
  authorizationUrl: z.url(),
  tokenUrl: z.url(),
  userinfoUrl: z.url().optional(),
  redirectPath: z.string().min(1),
  scopes: z.array(z.string().min(1)).optional(),
});

export const authenticationSchema = z.object({
  authentication: z.looseObject({
    basicAuth: basicAuthSchema.optional(),
    oauth2: oauth2Schema.optional(),
  }),
});

export type BasicAuthConfig = z.infer<typeof basicAuthSchema>;
export type OAuth2Config = z.infer<typeof oauth2Schema>;
export type AuthenticationFile = z.infer<typeof authenticationSchema>;

/** §4b default realm when none is declared. */
export const DEFAULT_BASIC_REALM = 'capsium';

export function parseAuthentication(input: unknown): AuthenticationFile {
  const result = authenticationSchema.safeParse(input);
  if (!result.success) {
    throw new ModelError(
      'authentication.json',
      result.error.issues.map(
        (issue) => `${issue.path.join('.')}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
