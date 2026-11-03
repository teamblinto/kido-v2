import { describe, expect, it } from 'vitest';

import {
  DURABLE_RUN_EVENT_TYPES,
  RUN_FAILURE_CLASSES,
  RUN_STATUSES,
  createRunRequestSchema,
  runEventSchema,
  runStateReasonSchema,
  runEventsQuerySchema,
  runInputRequestSchema,
  runListQuerySchema,
  runListResponseSchema,
  runResponseSchema,
} from './run';

const RUN = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';
const AT = '2026-09-14T10:00:00.000Z';

describe('createRunRequestSchema / runInputRequestSchema', () => {
  it('trims, refuses empty and refuses over 32 000 characters', () => {
    expect(createRunRequestSchema.parse({ prompt: '  build it  ' })).toEqual({
      prompt: 'build it',
    });
    expect(createRunRequestSchema.safeParse({ prompt: '   ' }).success).toBe(false);
    expect(runInputRequestSchema.safeParse({ message: 'a'.repeat(32_000) }).success).toBe(true);
    expect(runInputRequestSchema.safeParse({ message: 'a'.repeat(32_001) }).success).toBe(false);
  });

  it('stays strict', () => {
    expect(createRunRequestSchema.safeParse({ extra: 'x', prompt: 'hi' }).success).toBe(false);
    expect(runInputRequestSchema.safeParse({ message: 'hi', prompt: 'hi' }).success).toBe(false);
  });

  it('accepts a model id on create and refuses an empty one', () => {
    expect(createRunRequestSchema.parse({ model: 'claude-sonnet-5', prompt: 'hi' })).toEqual({
      model: 'claude-sonnet-5',
      prompt: 'hi',
    });
    expect(createRunRequestSchema.safeParse({ model: '', prompt: 'hi' }).success).toBe(false);
  });
});

describe('runEventSchema', () => {
  const at = (type: string, data: unknown): unknown => ({ at: AT, data, run: RUN, seq: 1, type });

  it('accepts one well-formed event per type', () => {
    const cases: [string, unknown][] = [
      ['state', { from: null, to: 'queued' }],
      ['tool.start', { input: { a: 1 }, stepId: `${RUN}/1`, tool: 'fs.write' }],
      ['tool.end', { ok: false, error: 'boom', stepId: `${RUN}/1` }],
      ['file.patch', { diff: '--- a', path: 'src/x.ts' }],
      ['checkpoint', { checkpointId: 'c1' }],
      ['preview.ready', { url: 'https://p.example' }],
      ['usage', { costMicros: 3, duplicateOf: `${RUN}/1`, inputTokens: 1, outputTokens: 2 }],
      ['sandbox.preparing', { transition: 'creating' }],
      ['approval.request', { detail: 'npm test', kind: 'command', requestId: 'r1', title: 'Run' }],
      ['approval.resolved', { by: 'user', decision: 'allow', requestId: 'r1' }],
      ['token', { text: 'h' }],
      ['thought', { text: 'hmm' }],
      ['tool.delta', { chunk: '..', stepId: `${RUN}/1` }],
    ];

    for (const [type, data] of cases) {
      expect(runEventSchema.safeParse(at(type, data)), type).toMatchObject({ success: true });
    }
  });

  /** Spec 031 (FR-034): the new reasons parse, and a frame written before them still does. */
  it('accepts a state reason from the run line, and an old frame without one', () => {
    for (const reason of ['cancelled-waiting', 'access-lost']) {
      expect(
        runEventSchema.safeParse(at('state', { from: 'queued', reason, to: 'cancelled' })).success,
      ).toBe(true);
    }
    expect(runStateReasonSchema.options).toEqual(['cancelled-waiting', 'access-lost']);
    expect(runEventSchema.safeParse(at('state', { from: 'running', to: 'paused' })).success).toBe(
      true,
    );
  });

  it('refuses an unknown type, an undeclared data key and a seq below 1', () => {
    expect(runEventSchema.safeParse(at('bogus', {})).success).toBe(false);
    expect(
      runEventSchema.safeParse(at('state', { extra: 1, from: null, to: 'queued' })).success,
    ).toBe(false);
    expect(
      runEventSchema.safeParse({ ...(at('token', { text: 'x' }) as object), seq: 0 }).success,
    ).toBe(false);
  });

  it('021: a usage event carries cache counts and a summary source; an unknown source is refused', () => {
    const usage = {
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      costMicros: 3,
      inputTokens: 1,
      outputTokens: 2,
    };
    expect(runEventSchema.safeParse(at('usage', { ...usage, source: 'summary' }))).toMatchObject({
      success: true,
    });
    expect(runEventSchema.safeParse(at('usage', { ...usage, source: 'model' })).success).toBe(
      false,
    );
  });

  it('keeps sandbox.preparing durable and its transition to the four the lifecycle names', () => {
    expect(DURABLE_RUN_EVENT_TYPES).toContain('sandbox.preparing');
    expect(runEventSchema.safeParse(at('sandbox.preparing', { transition: 'idle' })).success).toBe(
      false,
    );
  });

  it('names the durable subset as a subset of the union', () => {
    const union = runEventSchema.options.map((option) => option.shape.type.value);

    for (const type of DURABLE_RUN_EVENT_TYPES) {
      expect(union).toContain(type);
    }

    expect(union).toHaveLength(DURABLE_RUN_EVENT_TYPES.length + 3);
  });
});

describe('runResponseSchema', () => {
  it('accepts every status and stays strict about the lease', () => {
    const base = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cancelRequestedAt: null,
      contextSkips: [{ kind: 'summary', reason: 'budget', turn: 2 }],
      createdAt: AT,
      endedAt: null,
      failureClass: null,
      id: RUN,
      inputTokens: 0,
      lastSeq: 1,
      model: 'fake',
      outputTokens: 0,
      projectId: RUN,
      promptExcerpt: 'build it',
      startedAt: null,
      status: 'queued',
      userId: RUN,
    };

    for (const status of RUN_STATUSES) {
      expect(runResponseSchema.safeParse({ ...base, status }).success).toBe(true);
    }

    expect(runResponseSchema.safeParse({ ...base, leaseEpoch: 1 }).success).toBe(false);
    expect(
      runResponseSchema.safeParse({
        ...base,
        contextSkips: [{ kind: 'map', reason: 'x', turn: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe('RUN_FAILURE_CLASSES', () => {
  it('names credential beside the 008 classes (020)', () => {
    expect(RUN_FAILURE_CLASSES).toEqual([
      'executor',
      'tool_error',
      'stalled',
      'cancelled_by_system',
      'internal',
      'credential',
    ]);
  });
});

describe('query schemas', () => {
  it('coerce, default and cap', () => {
    expect(runEventsQuerySchema.parse({})).toEqual({ after: 0, limit: 200 });
    expect(runEventsQuerySchema.parse({ after: '7', limit: '500' })).toEqual({
      after: 7,
      limit: 500,
    });
    expect(runEventsQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
    expect(runListQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
    expect(runListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('022: takes the shared cursor page — limit alone still parses, cursor is optional', () => {
    expect(runListQuerySchema.parse({ limit: 1 })).toEqual({ limit: 1 });
    expect(runListQuerySchema.parse({ cursor: 'abc', limit: 50 })).toEqual({
      cursor: 'abc',
      limit: 50,
    });
  });
});

describe('runListResponseSchema (022)', () => {
  const run = {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cancelRequestedAt: null,
    contextSkips: [],
    createdAt: AT,
    endedAt: null,
    failureClass: null,
    id: RUN,
    inputTokens: 0,
    lastSeq: 1,
    model: 'fake',
    outputTokens: 0,
    projectId: RUN,
    promptExcerpt: 'build it',
    startedAt: null,
    status: 'queued',
    userId: RUN,
  };

  it('accepts nextCursor: null — the last page says so rather than omitting the field', () => {
    expect(runListResponseSchema.safeParse({ nextCursor: null, runs: [run] }).success).toBe(true);
    expect(runListResponseSchema.safeParse({ nextCursor: 'abc', runs: [] }).success).toBe(true);
    expect(runListResponseSchema.safeParse({ runs: [run] }).success).toBe(false);
  });

  it('refuses a run whose excerpt is over 120 characters', () => {
    expect(
      runListResponseSchema.safeParse({
        nextCursor: null,
        runs: [{ ...run, promptExcerpt: 'a'.repeat(121) }],
      }).success,
    ).toBe(false);
  });
});

describe('spec 032 run fields', () => {
  it('accepts credential: organisation and refuses any other credential', () => {
    expect(
      createRunRequestSchema.parse({ credential: 'organisation', prompt: 'hi' }).credential,
    ).toBe('organisation');
    expect(createRunRequestSchema.safeParse({ credential: 'personal', prompt: 'hi' }).success).toBe(
      false,
    );
  });

  it('carries resetsAt on a state event and refuses a non-ISO one', () => {
    const event = {
      at: '2026-09-24T10:00:00.000Z',
      data: {
        from: 'running',
        reason: 'subscription-limited',
        resetsAt: '2026-09-24T12:00:00.000Z',
        to: 'failed',
      },
      run: '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a',
      seq: 3,
      type: 'state',
    };
    expect(runEventSchema.safeParse(event).success).toBe(true);
    expect(
      runEventSchema.safeParse({ ...event, data: { ...event.data, resetsAt: 'later' } }).success,
    ).toBe(false);
  });
});

describe('BYOS run fields (spec 041) and retired local-agent history (spec 040)', () => {
  it('refuses the retired localAgent target, and subscription beside credential', () => {
    const target = { deviceId: RUN, provider: 'claude' };
    expect(createRunRequestSchema.safeParse({ localAgent: target, prompt: 'hi' }).success).toBe(
      false,
    );
    expect(
      createRunRequestSchema.safeParse({
        credential: 'organisation',
        prompt: 'hi',
        subscription: { provider: 'claude' },
      }).success,
    ).toBe(false);
  });

  it('keeps a subscription run’s model to an argv-safe token, and leaves other models alone', () => {
    const parse = (body: Record<string, unknown>) =>
      createRunRequestSchema.safeParse({ prompt: 'hi', ...body });
    const subscription = { provider: 'claude' };
    expect(parse({ model: 'claude-opus-5-5[1m]', subscription }).success).toBe(true);
    expect(parse({ model: '--dangerously-skip-permissions', subscription }).success).toBe(false);
    expect(parse({ model: 'a b', subscription })).toMatchObject({
      error: { issues: [expect.objectContaining({ path: ['model'] })] },
    });
    // Not argv-bound without a subscription target: the catalogue decides.
    expect(parse({ model: 'a b' }).success).toBe(true);
  });

  it('carries a structured CLI failure on a state event, and still parses a stored codex one', () => {
    const state = (data: unknown) =>
      runEventSchema.safeParse({ at: AT, data, run: RUN, seq: 3, type: 'state' }).success;
    const failure = { class: 'auth', origin: 'subscription', provider: 'claude' };
    expect(state({ from: 'running', localAgentFailure: failure, reason: 'x', to: 'failed' })).toBe(
      true,
    );
    expect(
      state({
        from: 'running',
        localAgentFailure: { class: 'workspace', origin: 'device', provider: 'codex' },
        to: 'failed',
      }),
    ).toBe(true);
    expect(
      state({ from: 'running', localAgentFailure: { ...failure, class: 'offline' }, to: 'failed' }),
    ).toBe(false);
    expect(state({ from: 'running', localAgentFailure: { class: 'auth' }, to: 'failed' })).toBe(
      false,
    );
  });

  it('still parses stored approval.request and approval.resolved events', () => {
    const at = (type: string, data: unknown): unknown => ({ at: AT, data, run: RUN, seq: 2, type });
    expect(DURABLE_RUN_EVENT_TYPES).toEqual(
      expect.arrayContaining(['approval.request', 'approval.resolved']),
    );
    expect(
      runEventSchema.safeParse(
        at('approval.request', {
          detail: 'rm -rf dist',
          kind: 'command',
          requestId: 'r1',
          title: 'Run',
        }),
      ).success,
    ).toBe(true);
    expect(
      runEventSchema.safeParse(
        at('approval.resolved', { by: 'timeout', decision: 'deny', requestId: 'r1' }),
      ).success,
    ).toBe(true);
    expect(
      runEventSchema.safeParse(
        at('approval.resolved', { by: 'admin', decision: 'deny', requestId: 'r1' }),
      ).success,
    ).toBe(false);
  });
});
