import { describe, expect, it } from 'vitest';

import {
  LOCAL_AGENT_PROVIDERS,
  localAgentDeviceTokenSchema,
  localAgentProviderStatusSchema,
} from './provider';

const AT = '2026-11-02T10:00:00.000Z';

const claudeStatus = {
  auth: { method: 'subscription', plan: 'Max', status: 'authenticated' },
  checkedAt: AT,
  installed: true,
  message: null,
  models: [{ id: 'sonnet', label: 'Sonnet' }],
  policy: { allowed: true, reason: null },
  provider: 'claude',
  version: '2.1.0',
};

describe('runner provider status', () => {
  it('names Claude only', () => {
    expect(LOCAL_AGENT_PROVIDERS).toEqual(['claude']);
    expect(
      localAgentProviderStatusSchema.safeParse({ ...claudeStatus, provider: 'codex' }).success,
    ).toBe(false);
  });

  it('parses a status and refuses an undeclared field such as an email', () => {
    expect(localAgentProviderStatusSchema.parse(claudeStatus)).toEqual(claudeStatus);
    expect(
      localAgentProviderStatusSchema.safeParse({ ...claudeStatus, email: 'a@b.c' }).success,
    ).toBe(false);
    expect(
      localAgentProviderStatusSchema.safeParse({
        ...claudeStatus,
        auth: { ...claudeStatus.auth, account: 'x' },
      }).success,
    ).toBe(false);
  });

  it('carries the models and limits the CLI reported, and still parses an older report without them', () => {
    const reported = {
      ...claudeStatus,
      models: [
        {
          description: 'Opus 5.5 · Best for everyday, complex tasks',
          id: 'default',
          label: 'Default',
        },
        { description: null, id: 'sonnet', label: 'Sonnet 5.5' },
      ],
      usage: {
        checkedAt: AT,
        windows: [{ kind: 'session', resetsAt: '2026-11-03T17:50:00.540+00:00', utilization: 59 }],
      },
    };
    expect(localAgentProviderStatusSchema.parse(reported)).toEqual(reported);
    // An older runner: no description, no usage.
    expect(localAgentProviderStatusSchema.safeParse(claudeStatus).success).toBe(true);
    expect(
      localAgentProviderStatusSchema.safeParse({
        ...reported,
        usage: {
          ...reported.usage,
          windows: [{ kind: 'monthly', resetsAt: null, utilization: 1 }],
        },
      }).success,
    ).toBe(false);
  });

  it('takes a bld_ device token and nothing else', () => {
    expect(localAgentDeviceTokenSchema.safeParse(`bld_${'a'.repeat(43)}`).success).toBe(true);
    expect(localAgentDeviceTokenSchema.safeParse(`xyz_${'a'.repeat(43)}`).success).toBe(false);
    expect(localAgentDeviceTokenSchema.safeParse('bld_short').success).toBe(false);
  });
});
