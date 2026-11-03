import { describe, expect, it } from 'vitest';

import {
  LOCAL_AGENT_PERMISSION_MODES,
  LOCAL_AGENT_PROVIDERS,
  localAgentProviderStatusSchema,
  localAgentRunTargetSchema,
  localAgentWorkspaceSchema,
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

describe('local agent provider status', () => {
  it('names two providers and never bypassPermissions', () => {
    expect(LOCAL_AGENT_PROVIDERS).toEqual(['claude', 'codex']);
    expect(LOCAL_AGENT_PERMISSION_MODES).not.toContain('bypassPermissions');
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

  it('keeps a workspace to an opaque id and a label, never a path', () => {
    expect(localAgentWorkspaceSchema.parse({ id: 'ws_1', label: 'app' })).toEqual({
      id: 'ws_1',
      label: 'app',
    });
    expect(localAgentWorkspaceSchema.safeParse({ id: 'C:\\code', label: 'app' }).success).toBe(
      false,
    );
    expect(
      localAgentWorkspaceSchema.safeParse({ id: 'ws_1', label: 'app', path: '/home' }).success,
    ).toBe(false);
  });

  it('parses a run target with and without a permission mode', () => {
    const target = {
      deviceId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a',
      provider: 'codex',
      workspaceId: 'ws_1',
    };
    expect(localAgentRunTargetSchema.parse(target)).toEqual(target);
    expect(
      localAgentRunTargetSchema.parse({ ...target, permissionMode: 'plan' }).permissionMode,
    ).toBe('plan');
    expect(localAgentRunTargetSchema.safeParse({ ...target, deviceId: 'x' }).success).toBe(false);
  });

  it('reads a run target without a workspace as the sandbox tool mode', () => {
    const target = { deviceId: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a', provider: 'claude' };
    expect(localAgentRunTargetSchema.parse(target)).toEqual(target);
    expect(localAgentRunTargetSchema.safeParse({ ...target, workspaceId: '' }).success).toBe(false);
    expect(localAgentRunTargetSchema.safeParse({ ...target, workspaceId: null }).success).toBe(
      false,
    );
  });
});
