import { ConfigService } from '@nestjs/config';
import { MFA_DISABLED, MFA_STEPPED_UP } from '@repo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../../config/environment';
import { REQUIRES_STEP_UP } from '../decorators/step-up.decorator';
import type { MfaService } from '../services/mfa.service';
import type { AuthenticatedUser } from '../services/session.service';
import { MfaController } from './mfa.controller';

const OTPAUTH_URI =
  'otpauth://totp/Forge:ada@example.test?issuer=Forge&secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30';

const RECOVERY_CODES = Array.from({ length: 10 }, (_, index) => `ABCDE-FGH${index}J`);

const CALLER: AuthenticatedUser = {
  createdAt: '2026-08-16T09:00:00.000Z',
  lastSeenAt: '2026-08-16T10:00:00.000Z',
  pendingMfa: false,
  sessionId: 'b'.repeat(64),
  steppedUpAt: null,
  userId: '3f1b1f8e-6b1a-4c1e-9d2a-2a5b8f0c1d3e',
};

const SESSION_COOKIE = '__Host-forge_session';
const PENDING_TOKEN = 'RUv0m4Bx0d1Wl6vN3cQeSg9pYkT2sZaHc1oJqXrLtUw';
const ROTATED_TOKEN = 'Zt7pQ2mK9sVx4LbN1cRfHg6yWjE3uAoDi5nMqXrTvUw';

const ACCOUNT = {
  email: 'ada@example.test',
  emailVerified: true,
  id: CALLER.userId,
  mfaEnabled: true,
};

/** Just enough of the platform response to see what the handler wrote, and what it did not. */
function recordingResponse() {
  const written: { attributes: unknown; name: string; value: string }[] = [];

  return {
    cookie(name: string, value: string, attributes: unknown) {
      written.push({ attributes, name, value });
    },
    written,
  };
}

function build(mfa: Partial<MfaService>): MfaController {
  return new MfaController(mfa as MfaService, configWith(SESSION_COOKIE));
}

/** The controller reads one key, so a one-key configuration is the whole of what it needs. */
function configWith(name: string): ConfigService<Environment, true> {
  return new ConfigService({ SESSION_COOKIE_NAME: name }) as unknown as ConfigService<
    Environment,
    true
  >;
}

describe('MfaController', () => {
  describe('beginning an enrolment', () => {
    it('answers with the provisioning URI', async () => {
      const beginEnrolment = vi.fn().mockResolvedValue({ otpauthUri: OTPAUTH_URI });

      await expect(build({ beginEnrolment }).beginEnrolment(CALLER)).resolves.toEqual({
        otpauthUri: OTPAUTH_URI,
      });
    });

    /**
     * The account comes from the guard, never from the body. A handler that took a user id would
     * let any signed-in caller start an enrolment on somebody else's account — and the QR code they
     * would be handed is a working second factor for it.
     */
    it('enrols the caller the guard resolved and nobody else', async () => {
      const beginEnrolment = vi.fn().mockResolvedValue({ otpauthUri: OTPAUTH_URI });

      await build({ beginEnrolment }).beginEnrolment(CALLER);

      expect(beginEnrolment).toHaveBeenCalledWith(CALLER.userId);
    });
  });

  describe('confirming an enrolment', () => {
    it('answers with the ten codes, once', async () => {
      const confirmEnrolment = vi.fn().mockResolvedValue({ recoveryCodes: RECOVERY_CODES });

      await expect(
        build({ confirmEnrolment }).confirmEnrolment({ code: '012345' }, CALLER),
      ).resolves.toEqual({ recoveryCodes: RECOVERY_CODES });
    });

    it('confirms against the caller the guard resolved', async () => {
      const confirmEnrolment = vi.fn().mockResolvedValue({ recoveryCodes: RECOVERY_CODES });

      await build({ confirmEnrolment }).confirmEnrolment({ code: '012345' }, CALLER);

      expect(confirmEnrolment).toHaveBeenCalledWith(CALLER.userId, '012345');
    });

    /** The code the caller typed is a credential; echoing one puts it in every client log. */
    it('never echoes the code it was given', async () => {
      const confirmEnrolment = vi.fn().mockResolvedValue({ recoveryCodes: RECOVERY_CODES });

      const body = await build({ confirmEnrolment }).confirmEnrolment({ code: '012345' }, CALLER);

      expect(JSON.stringify(body)).not.toContain('012345');
    });
  });

  describe('answering the login challenge', () => {
    const completed = {
      session: { token: ROTATED_TOKEN, ttlSeconds: 1_209_600 },
      user: ACCOUNT,
    };

    /**
     * The challenge is bound to the cookie the login leg set, and the handler reads it itself —
     * `SessionGuard` refuses a pending session, so this route is `@Public()` and this is the only
     * place that cookie is resolved.
     */
    it('answers the challenge with the cookie the request arrived on', async () => {
      const completeChallenge = vi.fn().mockResolvedValue(completed);

      await build({ completeChallenge }).completeChallenge(
        { code: '012345' },
        { cookies: { [SESSION_COOKIE]: PENDING_TOKEN } },
        recordingResponse(),
      );

      expect(completeChallenge).toHaveBeenCalledWith(PENDING_TOKEN, '012345');
    });

    /** The rotated identifier has to reach the browser, or the client is left holding a dead one. */
    it('writes the rotated session to the cookie', async () => {
      const response = recordingResponse();

      await build({ completeChallenge: vi.fn().mockResolvedValue(completed) }).completeChallenge(
        { code: '012345' },
        { cookies: { [SESSION_COOKIE]: PENDING_TOKEN } },
        response,
      );

      expect(response.written).toEqual([
        { attributes: expect.anything() as unknown, name: SESSION_COOKIE, value: ROTATED_TOKEN },
      ]);
    });

    /** Criterion 3 again: the token is in the cookie and in nothing a client could read or log. */
    it('answers with the account and no token', async () => {
      const body = await build({
        completeChallenge: vi.fn().mockResolvedValue(completed),
      }).completeChallenge(
        { code: '012345' },
        { cookies: { [SESSION_COOKIE]: PENDING_TOKEN } },
        recordingResponse(),
      );

      expect(body).toEqual({ user: ACCOUNT });
      expect(JSON.stringify(body)).not.toContain(ROTATED_TOKEN);
    });

    /** No cookie is not a different answer from a wrong code; the service decides both. */
    it('still calls the service when no cookie arrived', async () => {
      const completeChallenge = vi.fn().mockResolvedValue(completed);

      await build({ completeChallenge }).completeChallenge(
        { code: '012345' },
        { cookies: {} },
        recordingResponse(),
      );

      expect(completeChallenge).toHaveBeenCalledWith('', '012345');
    });
  });

  describe('stepping up', () => {
    it('stamps the caller’s own session', async () => {
      const stepUp = vi.fn().mockResolvedValue(undefined);

      await build({ stepUp }).stepUp({ code: '012345' }, CALLER);

      expect(stepUp).toHaveBeenCalledWith(CALLER.sessionId, CALLER.userId, '012345');
    });

    it('answers the one constant body', async () => {
      const body = await build({ stepUp: vi.fn().mockResolvedValue(undefined) }).stepUp(
        { code: '012345' },
        CALLER,
      );

      expect(body).toEqual({ status: MFA_STEPPED_UP });
    });
  });

  describe('turning MFA off', () => {
    it('disables it for the caller the guard resolved', async () => {
      const disable = vi.fn().mockResolvedValue(undefined);

      await build({ disable }).disable(CALLER);

      expect(disable).toHaveBeenCalledWith(CALLER.userId);
    });

    it('answers the one constant body', async () => {
      const body = await build({ disable: vi.fn().mockResolvedValue(undefined) }).disable(CALLER);

      expect(body).toEqual({ status: MFA_DISABLED });
    });

    /**
     * Criterion 12, asserted where forgetting it would be silent. The guard is registered
     * application-wide, so the only thing standing between "remove my MFA" and a borrowed laptop is
     * this decorator — and a missing decorator breaks no test that does not look for it.
     */
    it('is decorated so StepUpGuard demands a recent second factor', () => {
      // Read off the property descriptor rather than through `MfaController.prototype.disable`:
      // the handler is a normal method, and naming it that way is the unbound-method access the
      // lint rule refuses. The descriptor's value is the same function Nest hands the guard.
      const handler = Object.getOwnPropertyDescriptor(MfaController.prototype, 'disable')?.value as
        object | undefined;

      expect(handler).toBeDefined();
      expect(Reflect.getMetadata(REQUIRES_STEP_UP, handler!) as unknown).toBe(true);
    });
  });
});
