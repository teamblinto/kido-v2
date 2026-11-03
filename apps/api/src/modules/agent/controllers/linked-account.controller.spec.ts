import { describe, expect, it, vi } from 'vitest';

import { DomainError } from '../../../common/errors/domain-error';
import { REQUIRES_STEP_UP } from '../../identity/decorators/step-up.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { REQUIRED_PERMISSION } from '../../rbac/decorators/require-permission.decorator';
import type { ByosProviders } from '../byos/byos-providers';
import type { LinkedAccountService } from '../byos/linked-account.service';
import { LinkedAccountController } from './linked-account.controller';

const USER = '66666666-6666-4666-8666-666666666666';
const CALLER = { sessionId: 'session-hash', userId: USER } as AuthenticatedUser;
const STATE = 'a'.repeat(43);
const ACCOUNT = {
  accountLabel: 'ada@example.com',
  health: 'healthy' as const,
  lastCheckedAt: '2026-09-24T10:00:00.000Z',
  limitedUntil: null,
  linkedAt: '2026-09-24T10:00:00.000Z',
  provider: 'openai' as const,
};

function build(offered: string[], links: Partial<LinkedAccountService>) {
  const providers = {
    offered: (provider: string) => Promise.resolve(offered.includes(provider)),
  } as unknown as ByosProviders;
  return new LinkedAccountController(providers, links as LinkedAccountService);
}

const HANDLERS = ['list', 'begin', 'complete', 'verify', 'unlink'] as const;

function metadata(key: symbol | string, handler: (typeof HANDLERS)[number]): unknown {
  const target = Object.getOwnPropertyDescriptor(LinkedAccountController.prototype, handler)!
    .value as object;
  return Reflect.getMetadata(key, target) ?? Reflect.getMetadata(key, LinkedAccountController);
}

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe('LinkedAccountController', () => {
  it('carries no permission decorator: the session is the only gate (FR-008)', () => {
    for (const handler of HANDLERS) {
      expect(metadata(REQUIRED_PERMISSION, handler)).toBeUndefined();
    }
  });

  it('marks begin, and only begin, @StepUp()', () => {
    expect(metadata(REQUIRES_STEP_UP, 'begin')).toBe(true);
    for (const handler of ['list', 'complete', 'verify', 'unlink'] as const) {
      expect(metadata(REQUIRES_STEP_UP, handler)).toBeUndefined();
    }
  });

  it('GET lists for the caller only', async () => {
    const list = vi.fn().mockResolvedValue({ accounts: [ACCOUNT], offered: ['openai'] });
    expect(await build(['openai'], { list }).list(CALLER)).toEqual({
      accounts: [ACCOUNT],
      offered: ['openai'],
    });
    expect(list).toHaveBeenCalledWith(USER);
  });

  it.each(['anthropic', 'gemini'])(
    'answers 404 not-found for %s, which is not offered, on every :provider route',
    async (provider) => {
      const links = { begin: vi.fn(), complete: vi.fn(), unlink: vi.fn(), verify: vi.fn() };
      const controller = build(['openai'], links);
      const response = { status: vi.fn() };

      for (const call of [
        controller.begin(CALLER, provider),
        controller.complete(CALLER, provider, { code: 'c', state: STATE }, response),
        controller.verify(CALLER, provider),
        controller.unlink(CALLER, provider),
      ]) {
        expect((await refusal(call)).type).toBe('not-found');
      }
      expect(links.begin).not.toHaveBeenCalled();
      expect(links.complete).not.toHaveBeenCalled();
      expect(links.unlink).not.toHaveBeenCalled();
      expect(links.verify).not.toHaveBeenCalled();
    },
  );

  it('begin passes the session principal’s user and session, never the body', async () => {
    const begin = vi.fn().mockResolvedValue({ kind: 'redirect', url: 'https://x.test/' });
    await build(['openai'], { begin }).begin(CALLER, 'openai');
    expect(begin).toHaveBeenCalledWith(USER, 'session-hash', 'openai');
  });

  it('complete answers the account at 200, and 202 while a device flow is pending', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(ACCOUNT)
      .mockResolvedValueOnce({ pending: true, retryAfterSeconds: 5 });
    const controller = build(['openai'], { complete });
    const response = { status: vi.fn() };

    expect(await controller.complete(CALLER, 'openai', { code: 'c', state: STATE }, response)).toBe(
      ACCOUNT,
    );
    expect(response.status).not.toHaveBeenCalled();
    expect(await controller.complete(CALLER, 'openai', { state: STATE }, response)).toEqual({
      pending: true,
      retryAfterSeconds: 5,
    });
    expect(response.status).toHaveBeenCalledWith(202);
    expect(complete).toHaveBeenCalledWith(USER, 'session-hash', 'openai', { state: STATE });
  });

  it('unlink removes the caller’s own', async () => {
    const unlink = vi.fn().mockResolvedValue(undefined);
    await build(['openai'], { unlink }).unlink(CALLER, 'openai');
    expect(unlink).toHaveBeenCalledWith(USER, 'openai');
  });

  it('verify (T043) answers the caller’s own account after the check', async () => {
    const verify = vi.fn().mockResolvedValue({ ...ACCOUNT, health: 'needs_reauth' });
    expect(await build(['openai'], { verify }).verify(CALLER, 'openai')).toEqual({
      ...ACCOUNT,
      health: 'needs_reauth',
    });
    expect(verify).toHaveBeenCalledWith(USER, 'openai');
  });
});
