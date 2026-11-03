import { previewVisibilitySchema } from '@repo/contracts';
import { createLocalJWKSet, type JWK, jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * The signed route record (data-model § Signed route record, research R3): an EdDSA compact JWS
 * minted by the API's route signer, verified here against public keys only.
 */
export const routeRecordSchema = z.looseObject({
  exp: z.number().int(),
  // A preview record carries no `kind`; a site record (`kind: 'site'`) must never verify here
  // (contracts/site-serving.md § 3), so neither can be replayed as the other.
  kind: z.undefined().optional(),
  iat: z.number().int(),
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

export type RouteRecord = z.output<typeof routeRecordSchema>;

/** Mirrors the API's `PreviewJwks` (`apps/api/src/config/environment.ts`); public halves only. */
export interface PreviewJwks {
  keys: (JWK & { kid: string })[];
}

/**
 * The signed site record (contracts/site-serving.md § 3), minted by the API's `signSite()` with
 * the same key and `kid` as preview routes. Declared loose here and strict in the API, like the
 * route record. The label grammar is the site host's (§ 1).
 */
export const siteRecordSchema = z.looseObject({
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

/**
 * The signed domain record (contracts/domain-serving.md § 2), minted by the API's `signDomain()`
 * with the same key and `kid`. `hostname` binds it to the host it was asked for: the verifier
 * refuses it for any other. Loose here and strict in the API, like the others.
 */
export const domainRecordSchema = z.looseObject({
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

/**
 * Builds a verify function for one record schema. It resolves to the record, or to `undefined`
 * for any refusal: wrong key, unknown `kid`, expired, tampered, or a payload of another shape.
 * Nothing is thrown, because every refusal is the same `404` to the caller (contract § 3) and the
 * reason is never surfaced past the gateway.
 */
function createVerifier<S extends z.ZodType>(
  jwks: PreviewJwks,
  schema: S,
): (jws: string) => Promise<z.output<S> | undefined> {
  const keys = createLocalJWKSet(jwks);

  return async (jws) => {
    try {
      const { payload } = await jwtVerify(jws, keys, { algorithms: ['EdDSA'], clockTolerance: 0 });
      const parsed = schema.safeParse(payload);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The verify half of the route signer, for preview route records. */
export function createRouteVerifier(
  jwks: PreviewJwks,
): (jws: string) => Promise<RouteRecord | undefined> {
  return createVerifier(jwks, routeRecordSchema);
}

/** The verify half of `signSite()`, for site records. */
export function createSiteVerifier(
  jwks: PreviewJwks,
): (jws: string) => Promise<SiteRecord | undefined> {
  return createVerifier(jwks, siteRecordSchema);
}

/**
 * The verify half of `signDomain()`. It also refuses a record whose `hostname` is not exactly the
 * request's normalised hostname, so one domain's record can never serve another.
 */
export function createDomainVerifier(
  jwks: PreviewJwks,
): (jws: string, hostname: string) => Promise<DomainRecord | undefined> {
  const verify = createVerifier(jwks, domainRecordSchema);
  return async (jws, hostname) => {
    const record = await verify(jws);
    return record?.hostname === hostname ? record : undefined;
  };
}
