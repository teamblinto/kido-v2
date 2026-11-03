import { z } from 'zod';

/**
 * `GET /api/v1/version` (spec 025 § contracts 4, research R7): which build is running, answered
 * from values baked into the image at build.
 *
 * It is a separate shape from `ApiHealthResponse` on purpose. Health is the container's readiness
 * gate — compose and the edge start things on top of it, and anything in its body is something the
 * API genuinely cannot serve traffic without. A build digest is not that, so it gets its own route
 * and its own contract, and no existing one is touched.
 *
 * `strictObject`, like every response in this package: an undeclared key is a drift between the
 * shape a deploy reads and the shape this file declares, and it is refused rather than passed on.
 */
export const versionResponseSchema = z.strictObject({
  /** When the image was built, ISO 8601. `local` answers the process's boot time. */
  builtAt: z.iso.datetime(),
  /** The commit the image was built from. `local` answers `dev`. */
  commit: z.string().min(1),
  /** The image digest the deploy asked for, `sha256:…`. `local` answers `dev`. */
  digest: z.string().min(1),
});

export type VersionResponse = z.output<typeof versionResponseSchema>;

/** What `local` answers for the two baked values, so the route works everywhere (FR-033). */
export const VERSION_LOCAL_PLACEHOLDER = 'dev';
