import type { ConfigService } from '@nestjs/config';
import {
  EMAIL_VERIFIED,
  MFA_REQUIRED,
  SIGNUP_ACCEPTED,
  VERIFICATION_RESEND_ACCEPTED,
} from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import { deviceFingerprintOf } from '../device-fingerprint';
import type {
  EmailVerificationService,
  ResendAttempt,
} from '../services/email-verification.service';
import type { AccountService } from '../services/account.service';
import type { LoginAttempt, LoginService, MfaRequired, SignedIn } from '../services/login.service';
import type { AuthenticatedUser, SessionToken } from '../services/session.service';
import type { SignupService } from '../services/signup.service';
import { AuthController } from './auth.controller';

const COOKIE_NAME = '__Host-forge_session';
const TOKEN = 'RUv0m4Bx0d1Wl6vN3cQeSg9pYkT2sZaHc1oJqXrLtUw' as SessionToken;

const PENDING_TOKEN = 'Zt7pQ2mK9sVx4LbN1cRfHg6yWjE3uAoDi5nMqXrTvUw' as SessionToken;

const SIGNED_IN: SignedIn = {
  kind: 'signed-in',
  session: { token: TOKEN, ttlSeconds: 900 },
  user: {
    email: 'ada@example.com',
    emailVerified: true,
    id: '3f1b1f8e-6b1a-4c1e-9d2a-2a5b8f0c1d3e',
    mfaEnabled: false,
  },
};

/** The other arm (T21, criterion 4): the password was right, and the account owes a second factor. */
const MFA_CHALLENGE: MfaRequired = {
  kind: 'mfa-required',
  session: { token: PENDING_TOKEN, ttlSeconds: 300 },
};

const config = {
  get: () => COOKIE_NAME,
} as unknown as ConfigService<Environment, true>;

function build(
  login: Partial<LoginService>,
  signup: Partial<SignupService> = {},
  verification: Partial<EmailVerificationService> = {},
  account: Partial<AccountService> = {},
) {
  return new AuthController(
    login as LoginService,
    signup as SignupService,
    verification as EmailVerificationService,
    account as AccountService,
    config,
  );
}

/** The principal `SessionGuard` resolves. It carries the session, and deliberately not an address. */
const CALLER: AuthenticatedUser = {
  createdAt: '2026-08-17T09:00:00.000Z',
  lastSeenAt: '2026-08-17T09:30:00.000Z',
  pendingMfa: false,
  sessionId: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  steppedUpAt: null,
  userId: SIGNED_IN.user.id,
};

function response() {
  return { clearCookie: vi.fn(), cookie: vi.fn() };
}

describe('AuthController', () => {
  describe('signing in', () => {
    it('writes the token to the cookie and returns only the account', async () => {
      const authenticate = vi.fn().mockResolvedValue(SIGNED_IN);
      const target = response();

      const body = await build({ authenticate }).signIn(
        { email: 'ada@example.com', password: 'correct horse battery staple' },
        { headers: { 'user-agent': 'curl/8.4.0' }, ip: '203.0.113.7' },
        target,
      );

      expect(body).toEqual({ user: SIGNED_IN.user });
      expect(JSON.stringify(body)).not.toContain(TOKEN);
      expect(target.cookie).toHaveBeenCalledWith(COOKIE_NAME, TOKEN, expect.anything());
    });

    /** §11 records the device at exactly this moment; the request is the only place it exists. */
    it('hands the service the device the request describes', async () => {
      const authenticate = vi.fn().mockResolvedValue(SIGNED_IN);

      await build({ authenticate }).signIn(
        { email: 'ada@example.com', password: 'correct horse battery staple' },
        { headers: { 'user-agent': 'curl/8.4.0' }, ip: '203.0.113.7' },
        response(),
      );

      expect((authenticate.mock.calls[0]![0] as LoginAttempt).device).toEqual(
        deviceFingerprintOf({ ip: '203.0.113.7', userAgent: 'curl/8.4.0' }),
      );
    });

    /** Session fixation: the service can only kill what the controller tells it about. */
    it('passes on the session the request arrived holding', async () => {
      const authenticate = vi.fn().mockResolvedValue(SIGNED_IN);

      await build({ authenticate }).signIn(
        { email: 'ada@example.com', password: 'correct horse battery staple' },
        { cookies: { [COOKIE_NAME]: 'a-planted-session' }, headers: {}, ip: '203.0.113.7' },
        response(),
      );

      expect((authenticate.mock.calls[0]![0] as LoginAttempt).currentToken).toBe(
        'a-planted-session',
      );
    });

    /**
     * Criterion 4's arm. The cookie is still written — the challenge is bound to it — but the body
     * says only the word: naming the account here would confirm the address and the password to
     * somebody who has one of them and is guessing at the other.
     */
    it('answers mfa_required, naming no account, when a second factor is owed', async () => {
      const authenticate = vi.fn().mockResolvedValue(MFA_CHALLENGE);
      const target = response();

      const body = await build({ authenticate }).signIn(
        { email: 'ada@example.com', password: 'correct horse battery staple' },
        { headers: {}, ip: '203.0.113.7' },
        target,
      );

      expect(body).toEqual({ status: MFA_REQUIRED });
      expect(JSON.stringify(body)).not.toContain(SIGNED_IN.user.email);
      expect(JSON.stringify(body)).not.toContain(SIGNED_IN.user.id);
      expect(target.cookie).toHaveBeenCalledWith(COOKIE_NAME, PENDING_TOKEN, expect.anything());
    });

    /** And the pending token is a cookie value, never a body member, exactly as a real one is. */
    it('keeps the pending token out of the body too', async () => {
      const authenticate = vi.fn().mockResolvedValue(MFA_CHALLENGE);

      const body = await build({ authenticate }).signIn(
        { email: 'ada@example.com', password: 'correct horse battery staple' },
        { headers: {}, ip: '203.0.113.7' },
        response(),
      );

      expect(JSON.stringify(body)).not.toContain(PENDING_TOKEN);
    });

    it('writes no cookie when the service refuses', async () => {
      const authenticate = vi.fn().mockRejectedValue(new Error('refused'));
      const target = response();

      await expect(
        build({ authenticate }).signIn(
          { email: 'ada@example.com', password: 'wrong' },
          { headers: {}, ip: '203.0.113.7' },
          target,
        ),
      ).rejects.toThrow();

      expect(target.cookie).not.toHaveBeenCalled();
    });
  });

  describe('signing out', () => {
    it('revokes the session the cookie names and clears it', async () => {
      const signOut = vi.fn().mockResolvedValue(true);
      const target = response();

      await build({ signOut }).signOut({ cookies: { [COOKIE_NAME]: TOKEN }, headers: {} }, target);

      expect(signOut).toHaveBeenCalledWith(TOKEN);
      expect(target.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.anything());
    });

    /**
     * A caller whose cookie expired in an open tab still gets it cleared. Skipping the clear when
     * there is nothing to revoke leaves them holding a value the response said was gone.
     */
    it('clears the cookie even when there was no session to revoke', async () => {
      const signOut = vi.fn();
      const target = response();

      await build({ signOut }).signOut({ headers: {} }, target);

      expect(signOut).not.toHaveBeenCalled();
      expect(target.clearCookie).toHaveBeenCalledWith(COOKIE_NAME, expect.anything());
    });
  });

  describe('signing up', () => {
    it('passes the credentials through and answers the one constant body', async () => {
      const registerFn = vi.fn().mockResolvedValue(undefined);

      const body = await build({}, { register: registerFn }).signUp({
        email: 'ada@example.com',
        password: 'thermos-quibble-tundra-vellum',
      });

      expect(registerFn).toHaveBeenCalledWith({
        email: 'ada@example.com',
        password: 'thermos-quibble-tundra-vellum',
      });
      expect(body).toEqual({ status: SIGNUP_ACCEPTED });
    });

    /**
     * The controller half of enumeration-safety. The service answers `void` for both branches, so
     * the only way a difference could reach the wire is if this method invented one — a `created`
     * flag, an echo of the address. It cannot: it ignores the service's return entirely and builds
     * the same object every time.
     *
     * There is no cookie assertion here because there is nothing to assert against: `signUp` takes
     * no `@Res`, so unlike `signIn` it has no response object to write one to even by accident.
     */
    it('answers identically whatever address it is handed', async () => {
      const controller = build({}, { register: vi.fn().mockResolvedValue(undefined) });
      const password = 'thermos-quibble-tundra-vellum';

      const taken = await controller.signUp({ email: 'ada@example.com', password });
      const fresh = await controller.signUp({ email: 'nobody@example.com', password });

      expect(taken).toEqual(fresh);
      expect(taken).toEqual({ status: SIGNUP_ACCEPTED });
    });
  });

  describe('resolving the current caller', () => {
    it('describes the principal the guard resolved, and answers the sign-in shape', async () => {
      const describeAccount = vi.fn().mockResolvedValue(SIGNED_IN.user);

      const body = await build({}, {}, {}, { describe: describeAccount }).me(CALLER);

      expect(describeAccount).toHaveBeenCalledWith(CALLER.userId);
      expect(body).toEqual({ user: SIGNED_IN.user });
    });

    /**
     * The identifier a client could point somewhere else is the one this route must not take. The
     * only input is the principal, so there is no argument a caller controls — asserted as the
     * *whole* call rather than "was called with the right id", because a second argument added
     * later is exactly how a `userId` from a query string would reach the service.
     */
    it('takes nothing from the request but the principal', async () => {
      const describeAccount = vi.fn().mockResolvedValue(SIGNED_IN.user);

      await build({}, {}, {}, { describe: describeAccount }).me(CALLER);

      expect(describeAccount.mock.calls).toEqual([[CALLER.userId]]);
    });

    /** Criterion 3: nothing about the session itself, and above all not the token, comes back. */
    it('says nothing about the session the question arrived on', async () => {
      const body = await build(
        {},
        {},
        {},
        { describe: vi.fn().mockResolvedValue(SIGNED_IN.user) },
      ).me(CALLER);

      expect(Object.keys(body)).toEqual(['user']);
      expect(JSON.stringify(body)).not.toContain(CALLER.sessionId);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    });
  });

  describe('confirming an address', () => {
    it('hands the service the token and answers the one constant body', async () => {
      const confirm = vi.fn().mockResolvedValue(undefined);

      const body = await build({}, {}, { confirm }).verifyEmail({ token: 'a-mailed-token' });

      expect(confirm).toHaveBeenCalledWith('a-mailed-token');
      expect(body).toEqual({ status: EMAIL_VERIFIED });
    });
  });

  describe('resending a verification link', () => {
    /**
     * The plumbing the e2e cannot see. `verify-email.e2e-spec.ts` proves the per-IP bucket fills,
     * but not *which* address filled it — and a controller that handed the service `undefined`, or
     * the proxy's address, would pass every one of those tests while counting the whole fleet as
     * one caller. That is T15's `trust proxy` failure mode, arriving through this method instead.
     */
    it('hands the service the client address the request came from', async () => {
      const resend = vi.fn().mockResolvedValue(undefined);

      await build({}, {}, { resend }).resendVerification(
        { email: 'ada@example.com' },
        { headers: { 'user-agent': 'curl/8.4.0' }, ip: '203.0.113.7' },
      );

      expect((resend.mock.calls[0]![0] as ResendAttempt).ip).toBe('203.0.113.7');
    });

    it('answers the one constant body, whatever address it is handed', async () => {
      const controller = build({}, {}, { resend: vi.fn().mockResolvedValue(undefined) });
      const request = { headers: {}, ip: '203.0.113.7' };

      const known = await controller.resendVerification({ email: 'ada@example.com' }, request);
      const unknown = await controller.resendVerification({ email: 'nobody@example.com' }, request);

      expect(known).toEqual(unknown);
      expect(known).toEqual({ status: VERIFICATION_RESEND_ACCEPTED });
    });
  });
});
