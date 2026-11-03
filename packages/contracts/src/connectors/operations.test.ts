import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_OP_KINDS,
  CONNECTOR_OP_REASONS,
  CONNECTOR_OP_STATES,
  operationPageSchema,
  operationQuerySchema,
  operationSchema,
} from './operations';

const UUID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

export const operation = {
  bindingId: UUID,
  createdAt: '2026-09-23T10:00:00.000Z',
  deploymentId: null,
  finishedAt: null,
  id: UUID,
  kind: 'neon_branch_create',
  projectId: UUID,
  providerState: null,
  reason: null,
  requestedBy: UUID,
  startedAt: null,
  state: 'queued',
};

describe('operation enums', () => {
  it('match data-model § 1 exactly', () => {
    expect(CONNECTOR_OP_KINDS).toEqual([
      'netlify_publish',
      'neon_branch_create',
      'neon_branch_reset',
      'resource_release',
      'supabase_key_fetch',
      'resend_key_mint',
      'dns_write',
      'connection_remove',
    ]);
    expect(CONNECTOR_OP_STATES).toEqual(['queued', 'running', 'succeeded', 'failed']);
    expect(CONNECTOR_OP_REASONS).toHaveLength(14);
    expect(CONNECTOR_OP_REASONS).toContain('site-gone');
  });
});

describe('operationSchema', () => {
  it('accepts a queued operation and a failed one with its reason', () => {
    expect(operationSchema.parse(operation)).toEqual(operation);
    expect(
      operationSchema.parse({ ...operation, reason: 'quota-exceeded', state: 'failed' }).reason,
    ).toBe('quota-exceeded');
  });

  it('refuses an unknown reason and a stray field', () => {
    expect(operationSchema.safeParse({ ...operation, reason: 'oops' }).success).toBe(false);
    expect(operationSchema.safeParse({ ...operation, token: 'x' }).success).toBe(false);
  });

  it('pages strictly and filters by kind', () => {
    expect(operationPageSchema.parse({ items: [operation] }).items).toHaveLength(1);
    expect(operationQuerySchema.parse({ kind: 'netlify_publish', limit: '10' })).toEqual({
      kind: 'netlify_publish',
      limit: 10,
    });
    expect(operationQuerySchema.safeParse({ kind: 'deploy' }).success).toBe(false);
  });
});
