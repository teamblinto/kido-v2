import { PASSWORD_CHANGED, PASSWORD_RESET, PASSWORD_RESET_REQUESTED } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PasswordChangeService } from '../services/password-change.service';
import type { PasswordResetService } from '../services/password-reset.service';
import type { AuthenticatedUser } from '../services/session.service';
import { PasswordController } from './password.controller';

const TOKEN = 'F3s7NRy8Sk8ZBxSEqQqK0F4Zj-Zw6vMzBu1t2cN9xkQ';
const CURRENT = 'thermos-quibble-tundra-vellum';
const CHOSEN = 'kestrel-oxbow-parapet-sundial';

const CALLER: AuthenticatedUser = {
  createdAt: '2026-08-16T09:00:00.000Z',
  lastSeenAt: '2026-08-16T10:00:00.000Z',
  pendingMfa: false,
  sessionId: 'b'.repeat(64),
  steppedUpAt: null,
  userId: '3f1b1f8e-6b1a-4c1e-9d2a-2a5b8f0c1d3e',
};

function build(change: Partial<PasswordChangeService>, reset: Partial<PasswordResetService> = {}) {
  return new PasswordController(change as PasswordChangeService, reset as PasswordResetService);
}

describe('PasswordController', () => {
  describe('changing a password', () => {
    it('answers the one constant body', async () => {
      const body = await build({ change: vi.fn().mockResolvedValue(2) }).changePassword(
        { currentPassword: CURRENT, newPassword: CHOSEN },
        CALLER,
      );

      expect(body).toEqual({ status: PASSWORD_CHANGED });
    });

    /**
     * The session that survives is named by the hash the guard resolved, never by a cookie the
     * handler re-read. `AuthenticatedUser.sessionId` *is* that hash — the raw token deliberately
     * never reaches a service.
     */
    it('hands the service the caller and the session the request arrived on', async () => {
      const change = vi.fn().mockResolvedValue(0);

      await build({ change }).changePassword(
        { currentPassword: CURRENT, newPassword: CHOSEN },
        CALLER,
      );

      expect(change).toHaveBeenCalledWith({
        currentPassword: CURRENT,
        newPassword: CHOSEN,
        sessionId: CALLER.sessionId,
        userId: CALLER.userId,
      });
    });

    /** How many devices were signed out is not the caller's to read; it goes to the log, not the body. */
    it('never reports how many sessions it ended', async () => {
      const body = await build({ change: vi.fn().mockResolvedValue(7) }).changePassword(
        { currentPassword: CURRENT, newPassword: CHOSEN },
        CALLER,
      );

      expect(JSON.stringify(body)).not.toContain('7');
    });

    it('never echoes either password', async () => {
      const body = await build({ change: vi.fn().mockResolvedValue(0) }).changePassword(
        { currentPassword: CURRENT, newPassword: CHOSEN },
        CALLER,
      );

      expect(JSON.stringify(body)).not.toContain(CURRENT);
      expect(JSON.stringify(body)).not.toContain(CHOSEN);
    });
  });

  describe('requesting a reset', () => {
    it('answers the one constant body', async () => {
      const body = await build({}, { request: vi.fn().mockResolvedValue(undefined) }) //
        .requestReset({ email: 'ada@example.com' }, { ip: '203.0.113.7' });

      expect(body).toEqual({ status: PASSWORD_RESET_REQUESTED });
    });

    /**
     * Through the same normalisation `LoginService` and the resend endpoint use, so the per-IP
     * bucket here is keyed exactly as theirs are — same fallback for a request that arrived without
     * an address, rather than three endpoints disagreeing about who a caller is.
     */
    it('hands the service the client address the request came from', async () => {
      const request = vi.fn().mockResolvedValue(undefined);

      await build({}, { request }).requestReset(
        { email: 'ada@example.com' },
        { headers: { 'user-agent': 'curl/8.4.0' }, ip: '203.0.113.7' },
      );

      expect(request).toHaveBeenCalledWith({ email: 'ada@example.com', ip: '203.0.113.7' });
    });

    it('answers the same body for an address the service found nothing for', async () => {
      const known = await build({}, { request: vi.fn().mockResolvedValue(undefined) }) //
        .requestReset({ email: 'ada@example.com' }, { ip: '203.0.113.7' });
      const unknown = await build({}, { request: vi.fn().mockResolvedValue(undefined) }) //
        .requestReset({ email: 'nobody@example.com' }, { ip: '203.0.113.7' });

      expect(unknown).toEqual(known);
    });

    it('never carries the address back', async () => {
      const body = await build({}, { request: vi.fn().mockResolvedValue(undefined) }) //
        .requestReset({ email: 'ada@example.com' }, { ip: '203.0.113.7' });

      expect(JSON.stringify(body)).not.toContain('ada@example.com');
    });
  });

  describe('completing a reset', () => {
    it('answers the one constant body', async () => {
      const body = await build({}, { complete: vi.fn().mockResolvedValue(3) }).confirmReset({
        password: CHOSEN,
        token: TOKEN,
      });

      expect(body).toEqual({ status: PASSWORD_RESET });
    });

    it('hands the service the token and the chosen password', async () => {
      const complete = vi.fn().mockResolvedValue(0);

      await build({}, { complete }).confirmReset({ password: CHOSEN, token: TOKEN });

      expect(complete).toHaveBeenCalledWith({ password: CHOSEN, token: TOKEN });
    });

    /**
     * The token is the credential in this request. Echoing it would put it in every client log,
     * error report and browser history entry the response reaches — and it is dead by then anyway,
     * which makes the echo pure liability.
     */
    it('never echoes the token or the password', async () => {
      const body = await build({}, { complete: vi.fn().mockResolvedValue(1) }).confirmReset({
        password: CHOSEN,
        token: TOKEN,
      });

      expect(JSON.stringify(body)).not.toContain(TOKEN);
      expect(JSON.stringify(body)).not.toContain(CHOSEN);
    });

    /** No cookie is written: consuming the token revokes every session, and cannot then mint one. */
    it('establishes no session for whoever held the link', async () => {
      const body = await build({}, { complete: vi.fn().mockResolvedValue(1) }).confirmReset({
        password: CHOSEN,
        token: TOKEN,
      });

      expect(Object.keys(body)).toEqual(['status']);
    });
  });
});
