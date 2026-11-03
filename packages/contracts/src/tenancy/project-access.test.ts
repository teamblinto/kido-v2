import { describe, expect, it } from 'vitest';

import {
  acceptProjectInvitationRequestSchema,
  acceptProjectInvitationResponseSchema,
  inviteToProjectRequestSchema,
  inviteToProjectResponseSchema,
  projectAccessConflictReasonSchema,
  projectAccessResponseSchema,
} from './project-access';

const ID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
const EXPIRES = '2026-09-30T10:00:00.000Z';

describe('projectAccessResponseSchema', () => {
  const body = {
    grants: [{ email: 'a@example.com', role: 'owner', userId: ID }],
    invitations: [{ email: 'b@example.com', expiresAt: EXPIRES, id: ID, role: 'viewer' }],
  };

  it('accepts grants and open invitations', () => {
    expect(projectAccessResponseSchema.parse(body)).toEqual(body);
  });

  it('refuses an org member listing or an undeclared key', () => {
    expect(projectAccessResponseSchema.safeParse({ ...body, members: [] }).success).toBe(false);
    expect(
      projectAccessResponseSchema.safeParse({
        ...body,
        grants: [{ ...body.grants[0], name: 'A' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a role outside the project roles', () => {
    expect(
      projectAccessResponseSchema.safeParse({
        ...body,
        grants: [{ ...body.grants[0], role: 'admin' }],
      }).success,
    ).toBe(false);
  });
});

describe('inviteToProjectRequestSchema', () => {
  it('accepts an address and a role', () => {
    expect(inviteToProjectRequestSchema.parse({ email: 'b@example.com', role: 'editor' })).toEqual({
      email: 'b@example.com',
      role: 'editor',
    });
  });

  it('refuses a non-address, an over-long address and an extra key', () => {
    expect(inviteToProjectRequestSchema.safeParse({ email: 'nope', role: 'editor' }).success).toBe(
      false,
    );
    expect(
      inviteToProjectRequestSchema.safeParse({ email: `${'a'.repeat(250)}@x.io`, role: 'editor' })
        .success,
    ).toBe(false);
    expect(
      inviteToProjectRequestSchema.safeParse({ email: 'b@example.com', orgId: ID, role: 'editor' })
        .success,
    ).toBe(false);
  });
});

describe('inviteToProjectResponseSchema', () => {
  it('always answers invitation-sent', () => {
    const body = { expiresAt: EXPIRES, id: ID, status: 'invitation-sent' };

    expect(inviteToProjectResponseSchema.parse(body)).toEqual(body);
    expect(inviteToProjectResponseSchema.safeParse({ ...body, status: 'added' }).success).toBe(
      false,
    );
  });
});

describe('acceptProjectInvitation', () => {
  it('bounds the token to 32–128 characters', () => {
    expect(acceptProjectInvitationRequestSchema.safeParse({ token: 'a'.repeat(32) }).success).toBe(
      true,
    );
    expect(acceptProjectInvitationRequestSchema.safeParse({ token: 'a'.repeat(31) }).success).toBe(
      false,
    );
    expect(acceptProjectInvitationRequestSchema.safeParse({ token: 'a'.repeat(129) }).success).toBe(
      false,
    );
  });

  it('answers the project id only', () => {
    expect(acceptProjectInvitationResponseSchema.parse({ projectId: ID })).toEqual({
      projectId: ID,
    });
    expect(
      acceptProjectInvitationResponseSchema.safeParse({ orgId: ID, projectId: ID }).success,
    ).toBe(false);
  });
});

describe('projectAccessConflictReasonSchema', () => {
  it('is last-owner only', () => {
    expect(projectAccessConflictReasonSchema.options).toEqual(['last-owner']);
  });
});
