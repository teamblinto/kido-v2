import { describe, expect, it } from 'vitest';

import {
  INVITATION_ACCEPTED,
  INVITATION_SENT,
  acceptInvitationRequestSchema,
  acceptInvitationResponseSchema,
  inviteMemberRequestSchema,
  invitationAcceptedResponseSchema,
} from './invite';

/** 32 bytes of `randomBytes` in base64url — what `TokenService.issue` actually mints. */
const TOKEN = 'F3s7NRy8Sk8ZBxSEqQqK0F4Zj-Zw6vMzBu1t2cN9xkQ';

describe('inviteMemberRequestSchema', () => {
  it('accepts an address and one of the organisation roles', () => {
    expect(inviteMemberRequestSchema.parse({ email: 'ada@example.com', role: 'member' })).toEqual({
      email: 'ada@example.com',
      role: 'member',
    });
  });

  /**
   * The same normalisation signup applies, and for the same reason: `invitations.email` is `citext`
   * and the partial unique index that makes a second invite resolve to the first is defined over it,
   * so two spellings of one mailbox have to become one value *before* the row is written.
   */
  it('normalises the address, so two spellings of one mailbox are one invitation', () => {
    expect(inviteMemberRequestSchema.parse({ email: '  Ada@Example.COM ', role: 'admin' })).toEqual(
      { email: 'ada@example.com', role: 'admin' },
    );
  });

  it('refuses a role outside the organisation vocabulary', () => {
    expect(
      inviteMemberRequestSchema.safeParse({ email: 'ada@example.com', role: 'root' }).success,
    ).toBe(false);
  });

  /**
   * `strictObject`, so an invitation cannot smuggle a field the service does not read. A client
   * sending `{ email, role, userId }` is refused rather than quietly invited by address — an
   * endpoint that accepts and ignores an identifier is one whose callers come to believe it is used.
   */
  it('refuses a field the invitation does not have', () => {
    expect(
      inviteMemberRequestSchema.safeParse({
        email: 'ada@example.com',
        role: 'member',
        userId: '00000000-0000-4000-8000-000000000000',
      }).success,
    ).toBe(false);
  });
});

describe('invitationAcceptedResponseSchema', () => {
  const response = {
    expiresAt: '2026-08-24T09:00:00.000Z',
    id: '3f1a0a4e-2a9c-4c7f-9f1e-0b6d5c4a3b21',
    status: INVITATION_SENT,
  };

  it('carries the invitation and when it dies, and nothing about the invited account', () => {
    expect(invitationAcceptedResponseSchema.parse(response)).toEqual(response);
  });

  /**
   * The enumeration-safety property, expressed as a type. Criterion 10 requires that inviting an
   * address an org admin chose does not reveal whether that address has a Forge account, and the
   * shape is where a later task's well-meant `{ existingUser: true }` has to fail — here, as a test,
   * rather than in production as an oracle any admin can query one address at a time.
   */
  it('refuses a member that would say anything about the invited address', () => {
    expect(
      invitationAcceptedResponseSchema.safeParse({ ...response, existingUser: true }).success,
    ).toBe(false);
  });

  it('refuses a status other than the one constant', () => {
    expect(
      invitationAcceptedResponseSchema.safeParse({ ...response, status: 'created' }).success,
    ).toBe(false);
  });
});

describe('acceptInvitationRequestSchema', () => {
  it('accepts the token the invitation link carries', () => {
    expect(acceptInvitationRequestSchema.parse({ token: TOKEN })).toEqual({ token: TOKEN });
  });

  /**
   * No floor and no character class, matching `verificationTokenSchema`: a link a mail client
   * wrapped must reach the service and come back as `token-invalid`, not as a `422` about a string
   * length. One broken link, one response.
   */
  it('accepts a short token, leaving "is this a real token" to the service', () => {
    expect(acceptInvitationRequestSchema.safeParse({ token: 'F3s7NRy8' }).success).toBe(true);
  });

  it('refuses an empty token rather than sending a lookup for nothing', () => {
    expect(acceptInvitationRequestSchema.safeParse({ token: '' }).success).toBe(false);
  });
});

describe('acceptInvitationResponseSchema', () => {
  const response = {
    orgId: '9c2f7b31-5d84-4a10-bb6e-1f0d2c3e4a55',
    role: 'member',
    status: INVITATION_ACCEPTED,
  };

  it('says which organisation was joined and in what role', () => {
    expect(acceptInvitationResponseSchema.parse(response)).toEqual(response);
  });

  /**
   * Never the token. It was the credential in the request, and echoing a credential puts it in every
   * client log and browser history entry the response reaches — the argument `verify.ts` makes.
   */
  it('refuses to carry the token back', () => {
    expect(acceptInvitationResponseSchema.safeParse({ ...response, token: TOKEN }).success).toBe(
      false,
    );
  });
});
