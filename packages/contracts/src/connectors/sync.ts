import { z } from 'zod';

import { cursorPageQuerySchema, cursorSchema } from '../common/cursor';
import { actorSchema } from './connection';

/**
 * Sync operations (spec 018, contracts § 3): one row per push, pull or import (spec 026, contracts
 * § 3), the record FR-023/FR-029 promise. Failures found by the consumer land on the row as a `reason`; refusals before enqueue
 * carry the same vocabulary as a problem-document extension (contracts § 4, research R12).
 */

export const SYNC_KINDS = ['push', 'pull', 'import'] as const;

export const syncKindSchema = z.enum(SYNC_KINDS);

export type SyncKind = z.output<typeof syncKindSchema>;

export const SYNC_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;

export const syncStateSchema = z.enum(SYNC_STATES);

export type SyncState = z.output<typeof syncStateSchema>;

/** Contracts § 3, exact list — the `reason` on a failed row and on a refused request. */
export const SYNC_FAILURE_REASONS = [
  'remote-ahead',
  'diverged',
  'nothing-to-push',
  'run-active',
  'operation-in-flight',
  'needs-reauth',
  'provider-unavailable',
  'not-linked',
  'create-unsupported',
  'name-taken',
  'timed-out',
  'git-failed',
  'bundle-too-large',
  // Spec 026, contracts § 3: the four ways an import refuses or fails, appended rather than
  // woven in — a client written against spec 018 keeps parsing every row it could parse before.
  'empty-repo',
  'repo-too-large',
  'branch-not-found',
  'import-checkout-failed',
] as const;

export const syncFailureReasonSchema = z.enum(SYNC_FAILURE_REASONS);

export type SyncFailureReason = z.output<typeof syncFailureReasonSchema>;

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

export const syncOperationSchema = z.strictObject({
  commits: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  fromSha: shaSchema.nullable(),
  id: z.uuid(),
  kind: syncKindSchema,
  /**
   * The project the operation belongs to. Spec 026 contracts § 2 needs it on the import's `202`,
   * which is the one response whose project the client does not already know — it was created by
   * the same request. Added here rather than only on the import, because the row has always
   * carried it and one shape for a `SyncOperation` is worth more than a narrower one.
   */
  projectId: z.uuid(),
  reason: syncFailureReasonSchema.nullable(),
  requestedBy: actorSchema,
  startedAt: z.iso.datetime().nullable(),
  state: syncStateSchema,
  toSha: shaSchema.nullable(),
});

export type SyncOperation = z.output<typeof syncOperationSchema>;

/** `GET /orgs/:orgId/projects/:projectId/sync` — newest first. */
export const syncOperationPageSchema = z.strictObject({
  nextCursor: cursorSchema.optional(),
  operations: z.array(syncOperationSchema),
});

export type SyncOperationPage = z.output<typeof syncOperationPageSchema>;

export const syncListQuerySchema = cursorPageQuerySchema;

export type SyncListQuery = z.output<typeof syncListQuerySchema>;
