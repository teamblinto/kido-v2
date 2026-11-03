import { localAgentProviderStatusSchema } from '@repo/contracts';

import { costMicrosOf, costRise } from './index.ts';
import { claudeModels, claudeUsage, planLabel } from './subscription.ts';

const AT = '2026-11-03T12:00:00.000Z';

describe('claudeModels', () => {
  it('maps initialize’s models to id, label and description, dropping any that could not reach argv', () => {
    const models = claudeModels({
      account: { email: 'someone@example.com' },
      models: [
        {
          description: 'Opus 5.5 · Best for everyday, complex tasks',
          displayName: 'Default (recommended)',
          resolvedModel: 'claude-opus-5-5',
          value: 'default',
        },
        { displayName: 'Fable 5.1', value: 'claude-fable-5-1' },
        { displayName: '  ', value: 'haiku' },
        { displayName: 'Again', value: 'default' },
        { displayName: 'Flag', value: '--dangerously-skip-permissions' },
        { displayName: 'Spaced', value: 'two words' },
        'opus',
        { displayName: 'No id' },
      ],
    });
    expect(models).toEqual([
      {
        description: 'Opus 5.5 · Best for everyday, complex tasks',
        id: 'default',
        label: 'Default (recommended)',
      },
      { description: null, id: 'claude-fable-5-1', label: 'Fable 5.1' },
      { description: null, id: 'haiku', label: 'haiku' },
    ]);
    expect(JSON.stringify(models)).not.toContain('someone@example.com');
  });

  it('is empty for an answer without models', () => {
    expect(claudeModels(undefined)).toEqual([]);
    expect(claudeModels({ models: 'opus' })).toEqual([]);
  });
});

describe('claudeUsage', () => {
  it('maps the four windows it knows, skips null and unknown keys, and clamps to 0–100', () => {
    const usage = claudeUsage(
      {
        rate_limits: {
          five_hour: { resets_at: '2026-11-03T17:50:00.540171+00:00', utilization: 59 },
          seven_day: { resets_at: '2026-11-08T08:00:00.081509+00:00', utilization: 131 },
          seven_day_opus: { resets_at: null, utilization: -4 },
          seven_day_sonnet: null,
          iguana_necktie: { resets_at: '2026-11-05T07:59:00+00:00', utilization: 100 },
          seven_day_oauth_apps: null,
        },
        rate_limits_available: true,
        subscription_type: 'max',
      },
      AT,
    );
    expect(usage).toEqual({
      checkedAt: AT,
      windows: [
        { kind: 'session', resetsAt: '2026-11-03T17:50:00.540Z', utilization: 59 },
        { kind: 'weekly', resetsAt: '2026-11-08T08:00:00.081Z', utilization: 100 },
        { kind: 'weekly-opus', resetsAt: null, utilization: 0 },
      ],
    });
  });

  it('skips a window with no usable figure, and is null when the CLI cannot state limits', () => {
    expect(
      claudeUsage(
        {
          rate_limits: {
            five_hour: { resets_at: 'soon', utilization: 12 },
            seven_day: { utilization: 'lots' },
            seven_day_opus: { utilization: Number.NaN },
          },
        },
        AT,
      ),
    ).toEqual({ checkedAt: AT, windows: [{ kind: 'session', resetsAt: null, utilization: 12 }] });
    expect(claudeUsage({ rate_limits: {}, rate_limits_available: false }, AT)).toBeNull();
    expect(claudeUsage({ subscription_type: null }, AT)).toBeNull();
    expect(claudeUsage(undefined, AT)).toBeNull();
  });

  it('produces what the status report contract takes', () => {
    const usage = claudeUsage(
      { rate_limits: { five_hour: { resets_at: '2026-11-03T17:50:00+00:00', utilization: 5 } } },
      AT,
    );
    const models = claudeModels({ models: [{ displayName: 'Opus 5.5', value: 'opus' }] });
    const status = {
      auth: { method: 'subscription', plan: planLabel('max'), status: 'authenticated' },
      checkedAt: AT,
      installed: true,
      message: null,
      models,
      policy: { allowed: true, reason: null },
      provider: 'claude',
      usage,
      version: '2.1.317',
    };
    expect(localAgentProviderStatusSchema.safeParse(status).success).toBe(true);
    expect(status.auth.plan).toBe('Max');
    expect(planLabel(undefined)).toBeNull();
  });
});

describe('run cost', () => {
  it('takes total_cost_usd in micro-dollars, and nothing that is not a usable number', () => {
    expect(costMicrosOf(0.0412345)).toBe(41_235);
    for (const bad of [undefined, null, '0.1', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(costMicrosOf(bad)).toBeUndefined();
    }
  });

  it('is the rise of the running session total, all of it when the CLI started counting afresh', () => {
    expect(costRise(512_500, 500_000)).toBe(12_500);
    expect(costRise(12_500, 0)).toBe(12_500);
    expect(costRise(7_000, 500_000)).toBe(7_000);
    expect(costRise(0, 500_000)).toBe(0);
  });
});
