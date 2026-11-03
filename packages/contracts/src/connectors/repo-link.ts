import { z } from 'zod';

import { actorSchema } from './connection';

/**
 * Project links (spec 018, contracts § 2): one project, one repository, one branch named at link
 * time. `position` is derived at read from the last sync's rows (contracts § 5) — a hint; the
 * consumer's `is-ancestor` check is the truth.
 */

export const REPO_LINK_STATES = ['linked', 'disconnected'] as const;

export const repoLinkStateSchema = z.enum(REPO_LINK_STATES);

export type RepoLinkState = z.output<typeof repoLinkStateSchema>;

export const LINK_POSITIONS = ['level', 'ahead', 'behind', 'diverged', 'unknown'] as const;

export const linkPositionSchema = z.enum(LINK_POSITIONS);

export type LinkPosition = z.output<typeof linkPositionSchema>;

export const repoLinkSchema = z.strictObject({
  branch: z.string().min(1),
  connectionId: z.uuid().nullable(),
  id: z.uuid(),
  lastPushedCheckpointId: z.uuid().nullable(),
  linkedAt: z.iso.datetime(),
  linkedBy: actorSchema,
  position: linkPositionSchema,
  remoteHeadSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/u)
    .nullable(),
  repository: z.strictObject({
    fullName: z.string().min(1),
    id: z.int().positive(),
    name: z.string().min(1),
    owner: z.string().min(1),
  }),
  state: repoLinkStateSchema,
});

export type RepoLink = z.output<typeof repoLinkSchema>;

/** GitHub's own repository-name alphabet, capped at 100. */
export const repositoryNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/u);

/**
 * `PUT /orgs/:orgId/projects/:projectId/repo-link`: create a repository (organisation
 * installations only, R4) or choose an existing one. Exactly one arm.
 */
export const putRepoLinkRequestSchema = z.union([
  z.strictObject({
    create: z.strictObject({ name: repositoryNameSchema, private: z.boolean() }),
  }),
  z.strictObject({
    existing: z.strictObject({
      branch: z.string().min(1).optional(),
      repoId: z.int().positive(),
    }),
  }),
]);

export type PutRepoLinkRequest = z.output<typeof putRepoLinkRequestSchema>;
