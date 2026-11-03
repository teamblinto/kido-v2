import { createPrivateKey } from 'node:crypto';

import { createLocalJWKSet, errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import type { PreviewJwks } from '../../config/environment';
import { RouteVerifyError } from './route-signer';

/** The one audience a callback token carries (data-model § Sandbox callback token). */
export const SANDBOX_CALLBACK_AUDIENCE = 'forge-sandbox-callback';

/** Twelve hours: a sandbox lives across hibernation; the guard's per-call row re-check is what makes this safe (R11). */
export const SANDBOX_CALLBACK_TTL_SECONDS = 12 * 60 * 60;

export const sandboxCallbackClaimsSchema = z.object({
  aud: z.literal(SANDBOX_CALLBACK_AUDIENCE),
  leaseEpoch: z.number().int(),
  org: z.uuid(),
  project: z.uuid(),
  sandbox: z.string().min(1),
});
export type SandboxCallbackClaims = z.output<typeof sandboxCallbackClaimsSchema>;

/**
 * The verify half over the public JWKS, the shape of `verifyRoute`: any `kid` the JWKS carries
 * verifies, so a rotation overlaps. Rejects with `RouteVerifyError` — the same codes, so a caller
 * logs one vocabulary.
 */
export async function verifySandboxCallbackToken(
  jws: string,
  jwks: PreviewJwks,
): Promise<SandboxCallbackClaims> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(jws, createLocalJWKSet(jwks), {
      algorithms: ['EdDSA'],
      audience: SANDBOX_CALLBACK_AUDIENCE,
      requiredClaims: ['exp'],
    }));
  } catch (error) {
    throw new RouteVerifyError(
      error instanceof errors.JOSEError ? error.code : 'ERR_JWS_INVALID',
      error,
    );
  }
  const parsed = sandboxCallbackClaimsSchema.safeParse(payload);
  if (!parsed.success) throw new RouteVerifyError('ERR_ROUTE_SHAPE', parsed.error);
  return parsed.data;
}

/** Mints under the same key and `kid` as a route, so one JWKS verifies every token kind (R6). */
export function createSandboxCallbackSigner(options: {
  signingKey: string;
  signingKeyId: string;
}): (claims: Omit<SandboxCallbackClaims, 'aud'>) => Promise<string> {
  const key = createPrivateKey({
    format: 'der',
    key: Buffer.from(options.signingKey, 'base64'),
    type: 'pkcs8',
  });
  return (claims) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: options.signingKeyId })
      .setAudience(SANDBOX_CALLBACK_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${SANDBOX_CALLBACK_TTL_SECONDS}s`)
      .sign(key);
}
