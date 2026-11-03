import { describe, expect, it } from 'vitest';

import {
  orgListResponseSchema,
  orgMembershipSchema,
  orgSummarySchema,
  personalAccountsPolicySchema,
} from './org';

const SUMMARY = {
  createdAt: '2026-08-16T10:00:00.000Z',
  id: '9d8c1f6e-2a1f-4d3c-9a4e-9c2e0d5b7a11',
  name: 'Acme',
  plan: 'free',
  slug: 'acme',
};

const MEMBERSHIP = { ...SUMMARY, access: 'member', role: 'owner' };

/**
 * The two schemas `GET /api/v1/orgs` added. The rest of the slice predates this file and is covered
 * where it is used; what is asserted here is the part that is new and the part that is easy to get
 * wrong — that extending a strict object leaves it strict.
 */
describe('orgMembershipSchema', () => {
  it('is the org summary plus the caller’s own role', () => {
    expect(orgMembershipSchema.parse(MEMBERSHIP)).toEqual(MEMBERSHIP);
  });

  /**
   * `orgSummarySchema` is strict so that `creditBalance` and `settings` cannot arrive in the answer
   * everyone with `org:read` gets. Extending a schema is exactly where that property gets lost
   * without anybody noticing, so it is asserted rather than assumed.
   */
  it.each(['creditBalance', 'settings', 'memberCount'])('stays strict about %s', (member) => {
    expect(orgMembershipSchema.safeParse({ ...MEMBERSHIP, [member]: 1 }).success).toBe(false);
  });

  it('refuses a role outside §11’s four', () => {
    expect(orgMembershipSchema.safeParse({ ...MEMBERSHIP, role: 'superuser' }).success).toBe(false);
  });

  /** And the role is required: an entry with no role would be a listing a client cannot act on. */
  it('refuses an entry with no role', () => {
    expect(orgMembershipSchema.safeParse(SUMMARY).success).toBe(false);
  });

  /** Spec 031 (contracts/sharing.md § 6): a guest holds project grants and no org role. */
  it('carries access, and a null role exactly for a guest', () => {
    expect(orgMembershipSchema.safeParse({ ...SUMMARY, access: 'guest', role: null }).success).toBe(
      true,
    );
    expect(
      orgMembershipSchema.safeParse({ ...SUMMARY, access: 'guest', role: 'member' }).success,
    ).toBe(false);
    expect(
      orgMembershipSchema.safeParse({ ...SUMMARY, access: 'member', role: null }).success,
    ).toBe(false);
    expect(orgMembershipSchema.safeParse({ ...SUMMARY, role: 'owner' }).success).toBe(false);
  });

  it('leaves the summary itself alone', () => {
    expect(orgSummarySchema.safeParse(MEMBERSHIP).success).toBe(false);
    expect(orgSummarySchema.parse(SUMMARY)).toEqual(SUMMARY);
  });
});

describe('orgListResponseSchema', () => {
  it('accepts an account in several organisations', () => {
    const body = { orgs: [MEMBERSHIP, { ...MEMBERSHIP, role: 'member', slug: 'other' }] };

    expect(orgListResponseSchema.parse(body)).toEqual(body);
  });

  /** An account in none is an empty list, not an absent member and not a 404. */
  it('accepts an account in none', () => {
    expect(orgListResponseSchema.parse({ orgs: [] })).toEqual({ orgs: [] });
  });

  it('refuses a total, or anything else that would invite a count', () => {
    expect(orgListResponseSchema.safeParse({ orgs: [], total: 0 }).success).toBe(false);
  });
});

describe('personalAccountsPolicySchema', () => {
  it('accepts { allowed } and refuses anything else', () => {
    expect(personalAccountsPolicySchema.parse({ allowed: false })).toEqual({ allowed: false });
    expect(personalAccountsPolicySchema.safeParse({}).success).toBe(false);
    expect(personalAccountsPolicySchema.safeParse({ allowed: 'yes' }).success).toBe(false);
    expect(personalAccountsPolicySchema.safeParse({ allowed: true, extra: 1 }).success).toBe(false);
  });
});
