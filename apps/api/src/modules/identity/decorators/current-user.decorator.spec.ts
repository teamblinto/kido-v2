import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { AUTHENTICATED_USER, type AuthenticatedUser } from '../services/session.service';
import { currentUserFromContext } from './current-user.decorator';

const USER: AuthenticatedUser = {
  createdAt: '2026-08-16T10:00:00.000Z',
  lastSeenAt: '2026-08-16T10:00:00.000Z',
  pendingMfa: false,
  sessionId: 'a'.repeat(64),
  steppedUpAt: null,
  userId: '3f1d1f6e-2a1f-4d3c-9a4e-9c2e0d5b7a11',
};

function contextFor(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('currentUserFromContext', () => {
  it('returns the principal the guard attached', () => {
    expect(currentUserFromContext(contextFor({ [AUTHENTICATED_USER]: USER }))).toEqual(USER);
  });

  /**
   * Reached only on a route the guard let through without authenticating — a `@Public()` one. The
   * answer is `undefined` rather than a throw so that "who is this, if anyone" stays expressible;
   * a handler that requires a user gets one because the guard ran, not because the decorator did.
   */
  it('returns undefined on a request the guard never authenticated', () => {
    expect(currentUserFromContext(contextFor({}))).toBeUndefined();
  });
});
