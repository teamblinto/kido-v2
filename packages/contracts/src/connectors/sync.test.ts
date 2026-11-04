import { describe, expect, it } from 'vitest';

import {
  SYNC_FAILURE_REASONS,
  SYNC_KINDS,
  SYNC_STATES,
  syncFailureReasonSchema,
  syncKindSchema,
  syncListQuerySchema,
  syncOperationPageSchema,
  syncOperationSchema,
} from './sync';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

const operation = {
  commits: 0,
  createdAt: '2026-09-20T10:00:00.000Z',
  finishedAt: null,
  fromSha: null,
  id: UUID,
  kind: 'push',
  projectId: UUID,
  reason: null,
  requestedBy: { id: UUID, name: 'Ada' },
  startedAt: null,
  state: 'queued',
  targetBranch: null,
  trigger: 'manual',
  toSha: null,
};

/** Spec 018's vocabulary, which spec 026 may only append to. */
const SPEC_018_KINDS = ['push', 'pull'] as const;

const SPEC_018_FAILURE_REASONS = [
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
] as const;

describe('sync enums', () => {
  it('match contracts § 3 exactly', () => {
    expect(SYNC_KINDS).toEqual([...SPEC_018_KINDS, 'import']);
    expect(SYNC_STATES).toEqual(['queued', 'running', 'succeeded', 'failed']);
    expect(SYNC_FAILURE_REASONS).toEqual([
      ...SPEC_018_FAILURE_REASONS,
      'empty-repo',
      'repo-too-large',
      'branch-not-found',
      'import-checkout-failed',
      'branch-protected',
      'push-rejected',
      'workflow-permission',
      'repo-gone',
      'account-mismatch',
    ]);
  });

  it('is a widening: every spec 018 value still parses, in its old position', () => {
    // 026 contracts § 3, SC-014. A client written against spec 018 must keep parsing every
    // operation it could parse before — so the old values are still present, still spelled the
    // same, and still first. Only the tail is new.
    expect(SYNC_KINDS.slice(0, SPEC_018_KINDS.length)).toEqual([...SPEC_018_KINDS]);
    expect(SYNC_FAILURE_REASONS.slice(0, SPEC_018_FAILURE_REASONS.length)).toEqual([
      ...SPEC_018_FAILURE_REASONS,
    ]);

    for (const kind of SPEC_018_KINDS) {
      expect(syncKindSchema.safeParse(kind).success).toBe(true);
      expect(syncOperationSchema.safeParse({ ...operation, kind }).success).toBe(true);
    }

    for (const reason of SPEC_018_FAILURE_REASONS) {
      expect(syncFailureReasonSchema.safeParse(reason).success).toBe(true);
      expect(syncOperationSchema.safeParse({ ...operation, reason, state: 'failed' }).success).toBe(
        true,
      );
    }
  });

  it('parses an import operation and its new failure reasons', () => {
    expect(syncOperationSchema.safeParse({ ...operation, kind: 'import' }).success).toBe(true);

    for (const reason of [
      'empty-repo',
      'repo-too-large',
      'branch-not-found',
      'import-checkout-failed',
    ]) {
      expect(
        syncOperationSchema.safeParse({ ...operation, kind: 'import', reason, state: 'failed' })
          .success,
      ).toBe(true);
    }
  });
});

describe('syncOperationSchema', () => {
  it('accepts a queued operation and a failed one with a reason', () => {
    expect(syncOperationSchema.safeParse(operation)).toEqual({ data: operation, success: true });
    expect(
      syncOperationSchema.safeParse({ ...operation, reason: 'diverged', state: 'failed' }).success,
    ).toBe(true);
  });

  it('refuses an undeclared field and an unknown reason', () => {
    expect(syncOperationSchema.safeParse({ ...operation, extra: 1 }).success).toBe(false);
    expect(syncOperationSchema.safeParse({ ...operation, reason: 'because' }).success).toBe(false);
  });
});

describe('syncOperationPageSchema / syncListQuerySchema', () => {
  it('accepts a page with an optional next cursor', () => {
    expect(syncOperationPageSchema.safeParse({ operations: [operation] }).success).toBe(true);
    expect(syncOperationPageSchema.safeParse({ nextCursor: 'abc', operations: [] }).success).toBe(
      true,
    );
    expect(syncOperationPageSchema.safeParse({ extra: 1, operations: [] }).success).toBe(false);
  });

  it('defaults the limit and refuses an undeclared query field', () => {
    const result = syncListQuerySchema.safeParse({});

    expect(result.success && result.data.limit).toBe(25);
    expect(syncListQuerySchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
