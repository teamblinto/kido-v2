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
  /** Spec 044: push after every turn. */
  autoSync: z.boolean(),
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
  /** Spec 044: where the project's work waits while the linked branch cannot take it. */
  sideBranch: z.string().min(1).nullable(),
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

/**
 * A subset of `git check-ref-format`: no leading dash or dot, no `..`, `@{`, trailing `.lock`
 * or slash. It reaches a git argument as `refs/heads/<name>`, so the alphabet is closed.
 */
export const branchNameSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u)
  .refine(
    (name) =>
      !name.includes('..') &&
      !name.includes('//') &&
      !name.endsWith('/') &&
      !name.endsWith('.') &&
      !name.endsWith('.lock'),
    { message: 'not a valid branch name' },
  );

/** Spec 044: `PATCH …/repo-link`. At least one field. */
export const patchRepoLinkRequestSchema = z
  .strictObject({ autoSync: z.boolean().optional(), branch: branchNameSchema.optional() })
  .refine((body) => body.autoSync !== undefined || body.branch !== undefined, {
    message: 'nothing to change',
  });

export type PatchRepoLinkRequest = z.output<typeof patchRepoLinkRequestSchema>;

export const repoBranchSchema = z.strictObject({
  default: z.boolean(),
  name: z.string().min(1),
  protected: z.boolean(),
});

export type RepoBranch = z.output<typeof repoBranchSchema>;

export const repoBranchListSchema = z.strictObject({ branches: z.array(repoBranchSchema) });

export type RepoBranchList = z.output<typeof repoBranchListSchema>;

/** `POST …/repo-link/branches`: from the linked branch's remote head, then linked. */
export const createBranchRequestSchema = z.strictObject({ name: branchNameSchema });

export type CreateBranchRequest = z.output<typeof createBranchRequestSchema>;

/** `POST …/repo-link/authorize`: the personal-account create, step one. */
export const authorizeRepoCreateRequestSchema = z.strictObject({
  name: repositoryNameSchema,
  private: z.boolean(),
});

export type AuthorizeRepoCreateRequest = z.output<typeof authorizeRepoCreateRequestSchema>;

export const authorizeRepoCreateResponseSchema = z.strictObject({ authorizeUrl: z.url() });

export type AuthorizeRepoCreateResponse = z.output<typeof authorizeRepoCreateResponseSchema>;

/** `POST …/repo-link/authorized`: GitHub's redirect, handed over once. */
export const completeRepoCreateRequestSchema = z.strictObject({
  code: z.string().min(1).max(512),
  state: z.string().min(1).max(512),
});

export type CompleteRepoCreateRequest = z.output<typeof completeRepoCreateRequestSchema>;
