import { createLocalJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

import { GRANT_COOKIE } from './proxy.ts';
import type { PreviewJwks } from './route-verify.ts';

/** The preview grant's claims (data-model § Preview grant, research R6). */
const grantSchema = z.object({
  aud: z.string().min(1),
  exp: z.number().int(),
  sub: z.string().min(1),
});

export type Grant = z.output<typeof grantSchema>;

/** The `__Host-preview_grant` value out of a `Cookie` header, or `undefined` when absent. */
export function grantCookie(cookie: string | undefined): string | undefined {
  return cookie
    ?.split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${GRANT_COOKIE}=`))
    ?.slice(GRANT_COOKIE.length + 1);
}

/**
 * Verifies a grant locally against the same JWKS as routes: signature, `exp`, and `aud` equal to
 * the requested host. Every refusal is `undefined`, never a throw, and never a broker call.
 */
export function createGrantVerifier(
  jwks: PreviewJwks,
): (jws: string, host: string) => Promise<Grant | undefined> {
  const keys = createLocalJWKSet(jwks);

  return async (jws, host) => {
    try {
      const { payload } = await jwtVerify(jws, keys, {
        algorithms: ['EdDSA'],
        audience: host,
        clockTolerance: 0,
        requiredClaims: ['exp'],
      });
      const parsed = grantSchema.safeParse(payload);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
}
