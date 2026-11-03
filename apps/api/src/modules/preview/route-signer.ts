import { createPrivateKey } from 'node:crypto';

import { previewVisibilitySchema } from '@repo/contracts';
import { createLocalJWKSet, errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import type { PreviewJwks } from '../../config/environment';
import { GRANT_TTL_SECONDS } from './preview.constants';

/** How long a minted route verifies (data-model § Signed route record: `exp = iat + 30 s`). */
export const ROUTE_TTL_SECONDS = 30;

/** A grant's own claims; `sub` is the user, `aud` the one preview host it opens (contract § 4). */
export interface PreviewGrant {
  readonly aud: string;
  readonly sub: string;
}

/** The route record a broker answer carries (data-model § Signed route record). */
export const previewRouteSchema = z.strictObject({
  label: z.string().regex(/^[0-9a-f]{20,64}$/),
  org: z.uuid(),
  ports: z.array(z.number().int().min(1).max(65_535)).min(1),
  project: z.uuid(),
  sandbox: z.string().min(1),
  state: z.enum(['active', 'idle']),
  upstream: z.url(),
  upstreamToken: z.string().min(1),
  visibility: previewVisibilitySchema,
});
export type PreviewRoute = z.output<typeof previewRouteSchema>;

const signedRouteSchema = previewRouteSchema.extend({
  exp: z.number().int(),
  iat: z.number().int(),
});
export type SignedPreviewRoute = z.output<typeof signedRouteSchema>;

/**
 * The signed site record a `GET /broker/sites/:label` answer carries (spec 027, contract
 * site-serving.md § 3). Strict here, loose in the gateway (`route-verify.ts`), like the route
 * record. `kind` is what keeps the two record types apart: a preview record carries none, and each
 * verifier refuses the other's. `label` follows the site host grammar (§ 1).
 */
export const siteRecordSchema = z.strictObject({
  artifact: z.string().regex(/^[0-9a-f]{64}$/),
  deployment: z.uuid(),
  exp: z.number().int(),
  iat: z.number().int(),
  kind: z.literal('site'),
  label: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
  org: z.uuid(),
  project: z.uuid(),
});
export type SiteRecord = z.output<typeof siteRecordSchema>;
/** What `signSite` is handed; it stamps `iat` and `exp` itself. */
export type UnsignedSiteRecord = Omit<SiteRecord, 'exp' | 'iat'>;

/**
 * The signed domain record a `GET /broker/domains/:hostname` answer carries (spec 028, contract
 * domain-serving.md § 2). `kind: 'domain'` keeps it apart from a preview record (no `kind`) and a
 * site record (`kind: 'site'`). `hostname` is the normalised hostname the broker was asked for; the
 * gateway refuses a record whose hostname is not exactly the request's.
 */
export const domainRecordSchema = z.strictObject({
  artifact: z.string().regex(/^[0-9a-f]{64}$/),
  deployment: z.uuid(),
  exp: z.number().int(),
  hostname: z.string().max(253),
  iat: z.number().int(),
  kind: z.literal('domain'),
  org: z.uuid(),
  project: z.uuid(),
});
export type DomainRecord = z.output<typeof domainRecordSchema>;
/** What `signDomain` is handed; it stamps `iat` and `exp` itself. */
export type UnsignedDomainRecord = Omit<DomainRecord, 'exp' | 'iat'>;

/**
 * Why a route did not verify. `code` is `jose`'s own (`ERR_JWT_EXPIRED`, `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`,
 * `ERR_JWKS_NO_MATCHING_KEY`, …) or `ERR_ROUTE_SHAPE` when the signature held but the payload is not a route;
 * the gateway logs the code and answers 404 either way (contract § 4).
 */
export class RouteVerifyError extends Error {
  constructor(
    readonly code: string,
    cause: unknown,
  ) {
    super(`preview route did not verify: ${code}`, { cause });
    this.name = 'RouteVerifyError';
  }
}

/**
 * The verify half on its own: a plain function over a public JWKS so the gateway can hold exactly this and
 * nothing that mints (research R3). Any `kid` the JWKS carries verifies, which is what makes an overlapping
 * rotation work (FR-042).
 */
export async function verifyRoute(jws: string, jwks: PreviewJwks): Promise<SignedPreviewRoute> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(jws, createLocalJWKSet(jwks), { algorithms: ['EdDSA'] }));
  } catch (error) {
    throw new RouteVerifyError(
      error instanceof errors.JOSEError ? error.code : 'ERR_JWS_INVALID',
      error,
    );
  }
  const parsed = signedRouteSchema.safeParse(payload);
  if (!parsed.success) {
    throw new RouteVerifyError('ERR_ROUTE_SHAPE', parsed.error);
  }
  return parsed.data;
}

/**
 * The grant check the gateway makes (`grant-check.ts`), here so the broker can gate a wake the same
 * way: signature against the same JWKS, `exp`, `aud` equal to the host. Every refusal is
 * `undefined`, never a throw.
 */
export async function verifyGrant(
  jws: string,
  host: string,
  jwks: PreviewJwks,
): Promise<PreviewGrant | undefined> {
  try {
    const { payload } = await jwtVerify(jws, createLocalJWKSet(jwks), {
      algorithms: ['EdDSA'],
      audience: host,
      clockTolerance: 0,
      requiredClaims: ['exp', 'sub'],
    });
    return typeof payload.sub === 'string' && payload.sub !== ''
      ? { aud: host, sub: payload.sub }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface RouteSigner {
  sign(route: PreviewRoute): Promise<string>;
  /** The grant JWS under the same key and `kid` as a route, so one JWKS verifies both (R6). */
  signGrant(grant: PreviewGrant): Promise<string>;
  /** A site record under the same key, `kid` and 30 s expiry as a route, so one JWKS verifies both. */
  signSite(site: UnsignedSiteRecord): Promise<string>;
  /** A domain record under the same key, `kid` and 30 s expiry as a site record. */
  signDomain(domain: UnsignedDomainRecord): Promise<string>;
  verify(jws: string): Promise<SignedPreviewRoute>;
  verifyGrant(jws: string, host: string): Promise<PreviewGrant | undefined>;
}

/** The API-side signer over `PREVIEW_SIGNING_KEY` / `_ID` / `PREVIEW_PUBLIC_JWKS` as `environment.ts` exposes them. */
export function createRouteSigner(options: {
  jwks: PreviewJwks;
  signingKey: string;
  signingKeyId: string;
}): RouteSigner {
  const key = createPrivateKey({
    format: 'der',
    key: Buffer.from(options.signingKey, 'base64'),
    type: 'pkcs8',
  });
  const signed = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: options.signingKeyId })
      .setIssuedAt()
      .setExpirationTime(`${ROUTE_TTL_SECONDS}s`)
      .sign(key);
  return {
    sign: (route) => signed({ ...route }),
    signGrant: ({ aud, sub }) =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA', kid: options.signingKeyId })
        .setSubject(sub)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(`${GRANT_TTL_SECONDS}s`)
        .sign(key),
    // Named fields only, so nothing a caller spreads in rides along into the signed claims.
    signSite: ({ artifact, deployment, kind, label, org, project }) =>
      signed({ artifact, deployment, kind, label, org, project }),
    signDomain: ({ artifact, deployment, hostname, kind, org, project }) =>
      signed({ artifact, deployment, hostname, kind, org, project }),
    verify: (jws) => verifyRoute(jws, options.jwks),
    verifyGrant: (jws, host) => verifyGrant(jws, host, options.jwks),
  };
}
