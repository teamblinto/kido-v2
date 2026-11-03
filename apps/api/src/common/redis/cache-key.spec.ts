import { describe, expect, it } from 'vitest';

import { assertOrgCacheKey, OrgCacheKey } from './cache-key';

const ORG = '3f1c9a52-4d0e-4a7b-9c3b-0a1d2e3f4a5b';
const OTHER_ORG = '9b8a7c65-4d3e-4f2a-8b1c-0d9e8f7a6b5c';
const USER = 'c0ffee00-1111-4222-8333-444455556666';

describe('OrgCacheKey', () => {
  it('renders as the org-prefixed key §09 and §11 require', () => {
    const key = OrgCacheKey.build(ORG, 'perm', USER);

    expect(key.toString()).toBe(`o:${ORG}:perm:${USER}`);
  });

  /**
   * The prefix is not a string the key merely starts with: it is the whole Redis key, and everything
   * after it is a hash field. That is what makes the flush in `OrgCache.flushOrg` one command over
   * one key rather than a `SCAN MATCH o:{org}:*` over the keyspace.
   */
  it('puts the org prefix in the Redis key and the rest in the hash field', () => {
    const key = OrgCacheKey.build(ORG, 'perm', USER);

    expect(key.tenant).toBe(`o:${ORG}`);
    expect(key.field).toBe(`perm:${USER}`);
    expect(`${key.tenant}:${key.field}`).toBe(key.toString());
  });

  it('gives every key for one org the same Redis key, so a tenant flush is scan-free', () => {
    const permissions = OrgCacheKey.build(ORG, 'perm', USER);
    const settings = OrgCacheKey.build(ORG, 'settings');

    expect(settings.tenant).toBe(permissions.tenant);
    expect(OrgCacheKey.tenantKey(ORG)).toBe(permissions.tenant);
  });

  it('never lets two orgs share a Redis key', () => {
    expect(OrgCacheKey.build(OTHER_ORG, 'perm', USER).tenant).not.toBe(
      OrgCacheKey.build(ORG, 'perm', USER).tenant,
    );
  });

  /**
   * An org id is a uuid everywhere in the schema. Accepting anything else is how `o::perm:x` — one
   * key shared by every caller who passed an empty string — gets written.
   */
  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['not a uuid', 'acme-corp'],
    ['a glob', '*'],
    ['containing the delimiter', `${ORG}:evil`],
  ])('refuses an org id that is %s', (_label, orgId) => {
    expect(() => OrgCacheKey.build(orgId, 'perm', USER)).toThrow(/org id/i);
    expect(() => OrgCacheKey.tenantKey(orgId)).toThrow(/org id/i);
  });

  /**
   * Without this, `build(org, 'perm', 'a:b')` and `build(org, 'perm:a', 'b')` are the same key and
   * one cache entry answers for two questions.
   */
  it.each([
    ['empty', ''],
    ['blank', ' '],
    ['containing the delimiter', 'perm:extra'],
    ['a glob', 'perm*'],
    ['a newline', 'perm\n'],
  ])('refuses a segment that is %s', (_label, segment) => {
    expect(() => OrgCacheKey.build(ORG, segment)).toThrow(/segment/i);
  });

  it('refuses a key with no segment at all, which would collide with the tenant key', () => {
    // @ts-expect-error -- at least one segment is required by the signature, not just at runtime.
    expect(() => OrgCacheKey.build(ORG)).toThrow(/segment/i);
  });

  describe('cannot be bypassed', () => {
    /**
     * The @ts-expect-error directives are the assertion. If any of these lines ever compiles, `tsc`
     * fails with "unused '@ts-expect-error' directive" and `pnpm check` goes red — which is the
     * point: the guarantee is a type, not a convention reviewers have to remember.
     */
    it('does not accept a raw string where a key is required, at compile time', () => {
      // @ts-expect-error -- a raw string is not an OrgCacheKey.
      const forged: OrgCacheKey = `o:${ORG}:perm:${USER}`;

      expect(forged).toBeDefined();
    });

    it('does not accept a structurally similar object, at compile time', () => {
      // @ts-expect-error -- the shape is right and it is still not an OrgCacheKey.
      const forged: OrgCacheKey = { field: `perm:${USER}`, tenant: `o:${ORG}` };

      expect(forged).toBeDefined();
    });

    it('cannot be constructed except through the builder, at compile time', () => {
      // @ts-expect-error -- the constructor is private; `build` is the only way in.
      expect(new OrgCacheKey(`o:${ORG}`, `perm:${USER}`)).toBeDefined();
    });

    /**
     * The compile-time guarantee is absent for a plain-JS caller and for anyone who reaches for a
     * cast, so the same rule is enforced at runtime by everything that consumes a key.
     */
    it('throws when a raw string reaches the runtime check', () => {
      expect(() => assertOrgCacheKey(`o:${ORG}:perm:${USER}`)).toThrow(/OrgCacheKey/);
    });

    it('throws when a structurally similar object reaches the runtime check', () => {
      expect(() => assertOrgCacheKey({ field: `perm:${USER}`, tenant: `o:${ORG}` })).toThrow(
        /OrgCacheKey/,
      );
    });

    it('accepts a key the builder produced', () => {
      expect(() => assertOrgCacheKey(OrgCacheKey.build(ORG, 'perm', USER))).not.toThrow();
    });
  });
});
