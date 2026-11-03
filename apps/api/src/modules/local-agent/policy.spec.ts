import type { LocalAgentProviderStatus } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { COMPANION_POLICY, providerPolicy, withPolicy } from './policy';

function status(
  method: LocalAgentProviderStatus['auth']['method'],
  overrides: Partial<LocalAgentProviderStatus> = {},
): LocalAgentProviderStatus {
  return {
    auth: { method, plan: null, status: 'authenticated' },
    checkedAt: '2026-11-02T00:00:00.000Z',
    installed: true,
    message: null,
    models: [],
    // What the runner claims; the server never trusts it.
    policy: { allowed: true, reason: null },
    provider: 'claude',
    version: '1.0.0',
    ...overrides,
  };
}

describe('COMPANION_POLICY', () => {
  it('lets Claude Code run on any of its own sign-ins, and names no other CLI', () => {
    expect(COMPANION_POLICY).toEqual({
      claude: { allowedAuthMethods: ['subscription', 'api_key', 'cloud_provider'] },
    });
  });
});

describe('providerPolicy', () => {
  it.each(['subscription', 'api_key', 'cloud_provider'] as const)(
    'allows Claude on %s',
    (method) => {
      expect(providerPolicy(status(method), COMPANION_POLICY)).toEqual({
        allowed: true,
        reason: null,
      });
    },
  );

  it('blocks a sign-in it cannot identify', () => {
    expect(providerPolicy(status(null), COMPANION_POLICY).allowed).toBe(false);
    expect(providerPolicy(status('unknown'), COMPANION_POLICY).allowed).toBe(false);
  });

  it('blocks a provider the policy does not name', () => {
    expect(providerPolicy(status('subscription'), {}).allowed).toBe(false);
  });
});

describe('withPolicy', () => {
  it('recomputes every reported policy rather than trusting the report', () => {
    const report = withPolicy(
      {
        companionVersion: '0.1.0',
        providers: [status('unknown', { policy: { allowed: true, reason: null } })],
      },
      COMPANION_POLICY,
    );

    expect(report.providers[0]!.policy.allowed).toBe(false);
  });
});
