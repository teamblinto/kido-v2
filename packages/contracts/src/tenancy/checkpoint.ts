import { z } from 'zod';

import { cursorPageQuerySchema, cursorSchema } from '../common/cursor';

/**
 * Checkpoints and revert (spec 016, contracts § 1): the append-only history of a project's
 * repository state — a baseline on creation, one row per turn that changes the tree, and a
 * `revert` row when a member restores an earlier one. `files` is the stored change summary
 * (research R7), never the diff itself — the diff is a separate, computed endpoint.
 *
 * `pull` is spec 018's, `edit` is spec 024's: a member's hand edit in the web editor, recorded as
 * a checkpoint so it lists, diffs and reverts exactly as a turn does.
 */

export const checkpointKindSchema = z.enum(['baseline', 'turn', 'revert', 'pull', 'edit']);

export type CheckpointKind = z.output<typeof checkpointKindSchema>;

const checkpointFileStatusSchema = z.enum(['A', 'M', 'D', 'R']);

export const checkpointFileSchema = z.strictObject({
  bytes: z.number().int().nonnegative(),
  path: z.string().min(1).max(1024),
  status: checkpointFileStatusSchema,
});

export type CheckpointFile = z.output<typeof checkpointFileSchema>;

export const checkpointSchema = z.strictObject({
  actorId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  files: z.array(checkpointFileSchema),
  gitSha: z.string().regex(/^[0-9a-f]{40}$/u),
  id: z.uuid(),
  kind: checkpointKindSchema,
  label: z.string().min(1).max(200),
  mirroredAt: z.iso.datetime().nullable(),
  parentId: z.uuid().nullable(),
  revertsId: z.uuid().nullable(),
  runId: z.uuid().nullable(),
  turn: z.number().int().positive().nullable(),
});

export type Checkpoint = z.output<typeof checkpointSchema>;

/** The list endpoint's query: the shared cursor page, nothing else (contracts § 2). */
export const checkpointListQuerySchema = cursorPageQuerySchema;

export type CheckpointListQuery = z.output<typeof checkpointListQuerySchema>;

export const checkpointListResponseSchema = z.strictObject({
  items: z.array(checkpointSchema),
  nextCursor: cursorSchema.nullable(),
});

export type CheckpointListResponse = z.output<typeof checkpointListResponseSchema>;

const checkpointDiffFilePath = z.string().min(1).max(1024);

export const checkpointDiffFileSchema = z.discriminatedUnion('binary', [
  z.strictObject({
    binary: z.literal(false),
    path: checkpointDiffFilePath,
    patch: z.string(),
    status: checkpointFileStatusSchema,
    truncated: z.boolean(),
  }),
  z.strictObject({
    binary: z.literal(true),
    bytes: z.number().int().nonnegative(),
    path: checkpointDiffFilePath,
    status: checkpointFileStatusSchema,
  }),
]);

export type CheckpointDiffFile = z.output<typeof checkpointDiffFileSchema>;

export const checkpointDiffResponseSchema = z.strictObject({
  checkpointId: z.uuid(),
  files: z.array(checkpointDiffFileSchema),
  parentId: z.uuid().nullable(),
});

export type CheckpointDiffResponse = z.output<typeof checkpointDiffResponseSchema>;
