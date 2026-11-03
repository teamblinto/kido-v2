import { describe, expect, it } from 'vitest';

import { safeNext } from './route-guards';

/** Spec 031 (R7): the return address carried through sign-up and verification. */
describe('safeNext', () => {
  it('accepts /project-invitations/accept/x?org=y', () => {
    expect(safeNext('/project-invitations/accept/x?org=y')).toBe(
      '/project-invitations/accept/x?org=y',
    );
  });

  it('refuses https://evil.example, //evil.example and javascript:', () => {
    for (const next of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
      expect(safeNext(next), next).toBeUndefined();
    }
  });

  it('refuses a missing or non-string value', () => {
    expect(safeNext(null)).toBeUndefined();
    expect(safeNext(undefined)).toBeUndefined();
    expect(safeNext(42)).toBeUndefined();
  });
});
