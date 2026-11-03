import { SESSION_REVOKED } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { NotFoundError } from '../../../common/errors/domain-error';
import type {
  AuthenticatedUser,
  SessionService,
  SessionSummary,
} from '../services/session.service';
import { SessionController } from './session.controller';

const CALLER: AuthenticatedUser = {
  createdAt: '2026-08-16T09:00:00.000Z',
  lastSeenAt: '2026-08-17T10:00:00.000Z',
  pendingMfa: false,
  sessionId: 'b'.repeat(64),
  steppedUpAt: null,
  userId: '3f1b1f8e-6b1a-4c1e-9d2a-2a5b8f0c1d3e',
};

const SUMMARY: SessionSummary = {
  createdAt: '2026-08-16T09:00:00.000Z',
  fingerprint: 'a2f1c4d7e8b90312a2f1c4d7e8b90312',
  id: '9c2e0d5b-7a11-4e3f-8a1d-1f6e2a1f4d3c',
  ip: '203.0.113.7',
  lastSeenAt: '2026-08-17T10:00:00.000Z',
  userAgent: 'Mozilla/5.0 (Macintosh)',
};

function build(sessions: Partial<SessionService>): SessionController {
  return new SessionController(sessions as SessionService);
}

describe('SessionController', () => {
  describe('GET /auth/sessions', () => {
    it('answers with the caller’s sessions under one member', async () => {
      const controller = build({ list: () => Promise.resolve([SUMMARY]) });

      await expect(controller.list(CALLER)).resolves.toEqual({ sessions: [SUMMARY] });
    });

    /**
     * The authorisation, and the whole of it. The account is taken from the resolved session and
     * from nothing the caller sent, so there is no parameter through which one user could ask for
     * another's list — `mfa.controller.ts` makes the same argument about enrolment.
     */
    it('asks only for the account the session resolved to', async () => {
      const asked: string[] = [];
      const controller = build({
        list: (userId: string) => {
          asked.push(userId);

          return Promise.resolve([]);
        },
      });

      await controller.list(CALLER);

      expect(asked).toEqual([CALLER.userId]);
    });

    it('answers a caller with nothing listed with an empty list, not a 404', async () => {
      const controller = build({ list: () => Promise.resolve([]) });

      await expect(controller.list(CALLER)).resolves.toEqual({ sessions: [] });
    });

    /** Whatever the service knows, the response carries only what the contract publishes. */
    it('carries no session hash, even though the caller’s own is in hand', async () => {
      const controller = build({ list: () => Promise.resolve([SUMMARY]) });

      expect(JSON.stringify(await controller.list(CALLER))).not.toContain(CALLER.sessionId);
    });
  });

  describe('DELETE /auth/sessions/:id', () => {
    it('says the session is gone when it revoked one', async () => {
      const controller = build({ revokeById: () => Promise.resolve(true) });

      await expect(controller.revoke(CALLER, SUMMARY.id)).resolves.toEqual({
        status: SESSION_REVOKED,
      });
    });

    it('revokes within the caller’s own account, naming the id it was given', async () => {
      const asked: [string, string][] = [];
      const controller = build({
        revokeById: (userId: string, id: string) => {
          asked.push([userId, id]);

          return Promise.resolve(true);
        },
      });

      await controller.revoke(CALLER, SUMMARY.id);

      expect(asked).toEqual([[CALLER.userId, SUMMARY.id]]);
    });

    /**
     * The heart of the task. A session that is not the caller's is a `404` and never a `403`,
     * because a `403` is a statement that the id exists — which turns this endpoint into a
     * cross-user existence oracle that anybody with an account can query.
     */
    it('answers 404, never 403, for a session that is not the caller’s', async () => {
      const controller = build({ revokeById: () => Promise.resolve(false) });

      await expect(controller.revoke(CALLER, SUMMARY.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(controller.revoke(CALLER, SUMMARY.id)).rejects.toMatchObject({
        status: 404,
        type: 'not-found',
      });
    });

    /**
     * And the same 404 for an id nobody was ever issued. The two cases have to be one answer: if
     * "another user's session" and "no such session" differed in status, detail or shape, the
     * difference would be the oracle, whatever the status codes happened to be.
     */
    it('answers an unknown id exactly as it answers another user’s', async () => {
      const controller = build({ revokeById: () => Promise.resolve(false) });
      const foreign = await controller.revoke(CALLER, SUMMARY.id).catch((error: unknown) => error);
      const unknown = await controller
        .revoke(CALLER, '00000000-0000-4000-8000-000000000000')
        .catch((error: unknown) => error);

      expect((foreign as NotFoundError).detail).toBe((unknown as NotFoundError).detail);
      expect((foreign as NotFoundError).type).toBe((unknown as NotFoundError).type);
    });

    it('does not echo the id it refused', async () => {
      const controller = build({ revokeById: () => Promise.resolve(false) });
      const error = (await controller
        .revoke(CALLER, SUMMARY.id)
        .catch((thrown: unknown) => thrown)) as NotFoundError;

      expect(error.detail).not.toContain(SUMMARY.id);
    });

    /** A malformed id is not a validation failure to report on; it is simply not one of yours. */
    it('answers a malformed id with the same 404 rather than a 422', async () => {
      const controller = build({ revokeById: () => Promise.resolve(false) });

      await expect(controller.revoke(CALLER, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
