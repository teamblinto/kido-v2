import { describe, expect, it } from 'vitest';

import { createRunRequestSchema } from '../agent/run';
import {
  companionAuthCommandSchema,
  companionAuthEventSchema,
  subscriptionCodeRequestSchema,
  subscriptionListSchema,
  subscriptionStatusSchema,
} from './subscription';

const AT = '2026-11-03T10:00:00.000Z';
const ID = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
const URL_OK = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x';

describe('subscription status', () => {
  const status = {
    message: null,
    plan: 'Max',
    provider: 'claude',
    signIn: { expiresAt: AT, url: URL_OK },
    models: null,
    state: 'awaiting-sign-in',
    updatedAt: AT,
    usage: null,
  } as const;

  it('carries the models and limits the CLI reported, and refuses a window it does not know', () => {
    const reported = {
      ...status,
      models: [
        {
          description: 'Opus 5.5 · Best for everyday, complex tasks',
          id: 'default',
          label: 'Default',
        },
        { description: null, id: 'claude-fable-5-1', label: 'Fable 5.1' },
      ],
      usage: {
        checkedAt: AT,
        windows: [
          { kind: 'session', resetsAt: '2026-11-03T17:50:00.540171+00:00', utilization: 59 },
          { kind: 'weekly', resetsAt: null, utilization: 31 },
        ],
      },
    };
    expect(subscriptionStatusSchema.safeParse(reported).success).toBe(true);
    const window = { kind: 'monthly', resetsAt: null, utilization: 1 };
    expect(
      subscriptionStatusSchema.safeParse({
        ...reported,
        usage: { checkedAt: AT, windows: [window] },
      }).success,
    ).toBe(false);
    expect(
      subscriptionStatusSchema.safeParse({
        ...reported,
        models: [{ description: null, id: 'opus --dangerously-skip', label: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('parses the design shape and the list', () => {
    expect(subscriptionStatusSchema.parse(status)).toEqual(status);
    expect(subscriptionListSchema.parse({ claude: status })).toEqual({ claude: status });
    expect(subscriptionStatusSchema.safeParse({ ...status, provider: 'codex' }).success).toBe(
      false,
    );
    expect(subscriptionStatusSchema.safeParse({ ...status, email: 'a@b.c' }).success).toBe(false);
  });

  it('only offers https sign-in URLs on Anthropic hosts', () => {
    for (const url of [
      URL_OK,
      'https://claude.ai/oauth/authorize?x=1',
      'https://platform.claude.com/oauth/authorize',
    ]) {
      expect(
        subscriptionStatusSchema.safeParse({ ...status, signIn: { expiresAt: AT, url } }).success,
      ).toBe(true);
    }
    for (const url of [
      'http://claude.com/cai/oauth',
      'https://claude.com.evil.example/x',
      'https://evil.example/?claude.com',
      'https://user:pw@claude.com/x',
      'https://claude.com:8443/x',
      'javascript:alert(1)',
      'not a url at all',
      '',
    ]) {
      expect(
        companionAuthEventSchema.safeParse({ provider: 'claude', type: 'auth.login.url', url })
          .success,
      ).toBe(false);
    }
  });
});

describe('sign-in wire', () => {
  it('carries the four ephemeral commands', () => {
    for (const command of [
      { provider: 'claude', type: 'auth.login.start' },
      { code: 'abc#def', provider: 'claude', type: 'auth.login.code' },
      { provider: 'claude', type: 'auth.login.cancel' },
      { provider: 'claude', type: 'auth.logout' },
    ]) {
      expect(companionAuthCommandSchema.parse(command)).toEqual(command);
    }
    expect(
      companionAuthCommandSchema.safeParse({
        code: 'x'.repeat(513),
        provider: 'claude',
        type: 'auth.login.code',
      }).success,
    ).toBe(false);
    expect(companionAuthCommandSchema.safeParse({ type: 'run.start' }).success).toBe(false);
  });

  it('reports a result with a bounded message', () => {
    const result = { message: null, ok: true, provider: 'claude', type: 'auth.login.result' };
    expect(companionAuthEventSchema.parse(result)).toEqual(result);
    expect(
      companionAuthEventSchema.safeParse({ ...result, message: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('bounds the pasted code', () => {
    expect(subscriptionCodeRequestSchema.parse({ code: ' abc ' })).toEqual({ code: 'abc' });
    expect(subscriptionCodeRequestSchema.safeParse({ code: '' }).success).toBe(false);
    expect(subscriptionCodeRequestSchema.parse({ code: 'aB3_x-y.z#Q9' })).toEqual({
      code: 'aB3_x-y.z#Q9',
    });
  });

  it('refuses control characters and whitespace inside the code, on both wires', () => {
    for (const code of [
      'abc\u001b[2J',
      'abc\ndef',
      'ab cd',
      'abc\u0000',
      'abc;rm',
      'x'.repeat(513),
    ]) {
      expect(subscriptionCodeRequestSchema.safeParse({ code }).success).toBe(false);
      expect(
        companionAuthCommandSchema.safeParse({ code, provider: 'claude', type: 'auth.login.code' })
          .success,
      ).toBe(false);
    }
    // The issue never echoes the value it refused.
    const refused = subscriptionCodeRequestSchema.safeParse({ code: 'secret\u001bcode' });
    expect(JSON.stringify(refused.error?.issues)).not.toContain('secret');
  });
});

describe('subscription run target', () => {
  it('is exclusive with credential and localAgent, and takes a plain model', () => {
    const body = { prompt: 'hi', subscription: { provider: 'claude' } };
    expect(createRunRequestSchema.parse(body)).toEqual(body);
    expect(createRunRequestSchema.safeParse({ ...body, credential: 'organisation' }).success).toBe(
      false,
    );
    expect(
      createRunRequestSchema.safeParse({
        ...body,
        localAgent: { deviceId: ID, provider: 'claude' },
      }).success,
    ).toBe(false);
    expect(createRunRequestSchema.safeParse({ ...body, model: 'sonnet' }).success).toBe(true);
    expect(createRunRequestSchema.safeParse({ ...body, model: '--danger' }).success).toBe(false);
    expect(
      createRunRequestSchema.safeParse({ prompt: 'hi', subscription: { provider: 'codex' } })
        .success,
    ).toBe(false);
  });
});
