import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { FakeClock } from '../../../common/clock/fake-clock';
import { DomainError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';
import { StepUp } from '../decorators/step-up.decorator';
import { AUTHENTICATED_USER, type AuthenticatedUser } from '../services/session.service';
import { StepUpGuard } from './step-up.guard';

const NOW = '2026-08-16T10:00:00.000Z';
const WINDOW_SECONDS = 300;

const CALLER: AuthenticatedUser = {
  createdAt: '2026-08-16T09:00:00.000Z',
  lastSeenAt: NOW,
  pendingMfa: false,
  sessionId: 'a'.repeat(64),
  steppedUpAt: null,
  userId: '3f1d1f6e-2a1f-4d3c-9a4e-9c2e0d5b7a11',
};

class SensitiveController {
  @StepUp()
  remove(this: void): string {
    return 'removed';
  }

  read(this: void): string {
    return 'read';
  }
}

function guardWith(clock: FakeClock): StepUpGuard {
  const config = new ConfigService({
    MFA_STEP_UP_TTL_SECONDS: WINDOW_SECONDS,
  }) as unknown as ConfigService<Environment, true>;

  return new StepUpGuard(new Reflector(), clock, config);
}

function contextFor(user: AuthenticatedUser | undefined, handler: () => string): ExecutionContext {
  const request = user === undefined ? {} : { [AUTHENTICATED_USER]: user };

  return {
    getClass: () => SensitiveController,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const guarded = (user: AuthenticatedUser | undefined): ExecutionContext =>
  contextFor(user, SensitiveController.prototype.remove);

const unguarded = (user: AuthenticatedUser | undefined): ExecutionContext =>
  contextFor(user, SensitiveController.prototype.read);

/**
 * The error a refused activation threw, failing loudly when it was not refused.
 *
 * Synchronous, because the guard is: it reads route metadata and compares two instants, and there
 * is nothing to await. A guard that returned a promise for that would make every guarded route pay
 * a microtask to learn something already in memory.
 */
function refusalOf(activate: () => boolean): DomainError {
  try {
    activate();
  } catch (error: unknown) {
    return error as DomainError;
  }

  return expect.unreachable('expected the guard to refuse, but it let the request through');
}

describe('StepUpGuard', () => {
  it('lets an undecorated handler through, stamp or no stamp', () => {
    const guard = guardWith(new FakeClock(NOW));

    expect(guard.canActivate(unguarded(CALLER))).toBe(true);
  });

  it('refuses a decorated handler when the session has never stepped up', () => {
    const guard = guardWith(new FakeClock(NOW));

    const refusal = refusalOf(() => guard.canActivate(guarded(CALLER)));

    expect(refusal.type).toBe('step-up-required');
    expect(refusal.status).toBe(403);
  });

  /**
   * A `403`, never a `401`. The session is perfectly good and the client must not react by signing
   * the user out — the remedy is to present a code and retry the same request.
   */
  it('refuses with a slug the client can act on rather than an authentication failure', () => {
    const guard = guardWith(new FakeClock(NOW));

    const refusal = refusalOf(() => guard.canActivate(guarded(CALLER)));

    expect(refusal.status).not.toBe(401);
  });

  it('admits a session that stepped up a moment ago', () => {
    const clock = new FakeClock(NOW);
    const steppedUpAt = new Date(Date.parse(NOW) - 1_000).toISOString();

    expect(guardWith(clock).canActivate(guarded({ ...CALLER, steppedUpAt }))).toBe(true);
  });

  /**
   * The window, from both sides. Admitting inside it proves nothing on its own: a guard that
   * ignored the stamp's age entirely would pass that assertion and fail none of the others.
   */
  it('admits a step-up at the last second of the window', () => {
    const clock = new FakeClock(NOW);
    const steppedUpAt = new Date(Date.parse(NOW) - WINDOW_SECONDS * 1_000 + 1).toISOString();

    expect(guardWith(clock).canActivate(guarded({ ...CALLER, steppedUpAt }))).toBe(true);
  });

  it('refuses a step-up one second past the window', () => {
    const clock = new FakeClock(NOW);
    const steppedUpAt = new Date(Date.parse(NOW) - (WINDOW_SECONDS + 1) * 1_000).toISOString();

    const refusal = refusalOf(() =>
      guardWith(clock).canActivate(guarded({ ...CALLER, steppedUpAt })),
    );

    expect(refusal.type).toBe('step-up-required');
  });

  /** The clock is injected, so an expiring window is a test rather than a wait. */
  it('lets a fresh step-up go stale as the clock moves', () => {
    const clock = new FakeClock(NOW);
    const guard = guardWith(clock);
    const caller = { ...CALLER, steppedUpAt: NOW };

    expect(guard.canActivate(guarded(caller))).toBe(true);

    clock.advance((WINDOW_SECONDS + 1) * 1_000);

    expect(refusalOf(() => guard.canActivate(guarded(caller))).type).toBe('step-up-required');
  });

  /**
   * A stamp in the future is a corrupt field or a clock that went backwards, and it must not be
   * read as "stepped up very recently" — that reading turns one bad write into a permanent bypass.
   */
  it('refuses a stamp that claims to be from the future', () => {
    const clock = new FakeClock(NOW);
    const steppedUpAt = new Date(Date.parse(NOW) + 60_000).toISOString();

    const refusal = refusalOf(() =>
      guardWith(clock).canActivate(guarded({ ...CALLER, steppedUpAt })),
    );

    expect(refusal.type).toBe('step-up-required');
  });

  it('refuses a stamp that is not a readable instant', () => {
    const clock = new FakeClock(NOW);

    const refusal = refusalOf(() =>
      guardWith(clock).canActivate(guarded({ ...CALLER, steppedUpAt: 'yesterday' })),
    );

    expect(refusal.type).toBe('step-up-required');
  });

  /**
   * Reachable only if this guard is ever registered ahead of `SessionGuard`. It refuses rather than
   * waving the request through, because the failure mode of the other choice is that reordering two
   * lines in a providers array silently turns step-up off everywhere.
   */
  it('refuses when no principal was resolved at all', () => {
    const guard = guardWith(new FakeClock(NOW));

    expect(() => guard.canActivate(guarded(undefined))).toThrow(DomainError);
  });
});
