import type { LocalAgentProviderStatus } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import { companionPolicy, providerPolicy, runnable, withPolicy } from './policy';

function status(
  provider: 'claude' | 'codex',
  method: LocalAgentProviderStatus['auth']['method'],
  overrides: Partial<LocalAgentProviderStatus> = {},
): LocalAgentProviderStatus {
  return {
    auth: { method, plan: null, status: 'authenticated' },
    checkedAt: '2026-11-02T00:00:00.000Z',
    installed: true,
    message: null,
    models: [],
    // What the companion claims; the server never trusts it.
    policy: { allowed: true, reason: null },
    provider,
    version: '1.0.0',
    ...overrides,
  };
}

describe('companionPolicy', () => {
  it('lets Claude Code run on any of its own sign-ins', () => {
    expect(companionPolicy(false).claude?.allowedAuthMethods).toEqual([
      'subscription',
      'api_key',
      'cloud_provider',
    ]);
  });

  it('denies Codex on a ChatGPT plan by default and allows it only when configured', () => {
    expect(companionPolicy(false).codex?.allowedAuthMethods).toEqual(['api_key', 'cloud_provider']);
    expect(companionPolicy(true).codex?.allowedAuthMethods).toContain('subscription');
  });
});

describe('providerPolicy', () => {
  const deny = companionPolicy(false);

  it.each([
    ['claude', 'subscription', true],
    ['claude', 'api_key', true],
    ['codex', 'api_key', true],
    ['codex', 'cloud_provider', true],
    ['codex', 'subscription', false],
  ] as const)('%s on %s is allowed: %s', (provider, method, allowed) => {
    expect(providerPolicy(status(provider, method), deny).allowed).toBe(allowed);
  });

  it('says why Codex on a ChatGPT plan is blocked', () => {
    expect(providerPolicy(status('codex', 'subscription'), deny).reason).toMatch(/ChatGPT plan/);
  });

  it('blocks a sign-in it cannot identify', () => {
    expect(providerPolicy(status('claude', null), deny).allowed).toBe(false);
    expect(providerPolicy(status('claude', 'unknown'), deny).allowed).toBe(false);
  });

  it('allows Codex on a ChatGPT plan where the operator allowed it', () => {
    expect(providerPolicy(status('codex', 'subscription'), companionPolicy(true))).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('withPolicy and runnable', () => {
  const deny = companionPolicy(false);

  it('recomputes every reported policy rather than trusting the report', () => {
    const report = withPolicy(
      { companionVersion: '0.1.0', providers: [status('codex', 'subscription')], workspaces: [] },
      deny,
    );

    expect(report.providers[0]!.policy.allowed).toBe(false);
  });

  it('needs the CLI installed, signed in and allowed', () => {
    expect(runnable(status('claude', 'subscription'), deny)).toBe(true);
    expect(runnable(status('claude', 'subscription', { installed: false }), deny)).toBe(false);
    expect(
      runnable(
        status('claude', 'subscription', {
          auth: { method: 'subscription', plan: null, status: 'unauthenticated' },
        }),
        deny,
      ),
    ).toBe(false);
    expect(runnable(status('codex', 'subscription'), deny)).toBe(false);
  });
});
