import { z } from 'zod';

/**
 * The project's site (spec 027, contracts/deployments.md): one pointer at the current deployment,
 * plus an offline switch. A never-deployed project answers
 * `{ url: null, currentDeploymentId: null, offline: false, deployable }`.
 */

export const siteSchema = z.strictObject({
  /** Null until the first go-live. */
  url: z.url().nullable(),
  currentDeploymentId: z.uuid().nullable(),
  offline: z.boolean(),
  /** The template declares a static build. */
  deployable: z.boolean(),
});

export type Site = z.output<typeof siteSchema>;

/** `GET …/site` and `PUT …/site` both answer `{ site }`. */
export const siteResponseSchema = z.strictObject({
  site: siteSchema,
});

export type SiteResponse = z.output<typeof siteResponseSchema>;

/**
 * `PUT …/site`. `release` makes a succeeded deployment current (rollback / roll-forward) and runs
 * no build; `offline` takes the site down. Each branch is strict, so `release` without a
 * `deploymentId` and `offline` with one are both refused.
 */
export const updateSiteRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('release'), deploymentId: z.uuid() }),
  z.strictObject({ action: z.literal('offline') }),
]);

export type UpdateSiteRequest = z.output<typeof updateSiteRequestSchema>;
