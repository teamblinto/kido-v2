import { describe, expect, it } from 'vitest';

import {
  companionCommandSchema,
  companionRunEventBatchSchema,
  companionRunEventSchema,
  companionStatusReportSchema,
  LOCAL_AGENT_MAX_COMMAND_CHARS,
  LOCAL_AGENT_MAX_TOOL_INPUT_CHARS,
  LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS,
  LOCAL_AGENT_SANDBOX_TOOLS,
  sandboxToolOf,
  truncateToolOutput,
} from './companion';

const RUN = '4d7c5d8a-2f3b-4c1e-9a6f-0b1c2d3e4f5a';

const TOOLSET = [
  {
    description: 'Read a whole file.',
    inputSchema: {
      additionalProperties: false,
      properties: { path: { type: 'string' } },
      required: ['path'],
      type: 'object',
    },
    name: 'fs_read',
  },
];

const START = {
  conversationKey: 'p_1',
  model: null,
  prompt: 'fix the build',
  provider: 'claude',
  resume: null,
  runId: RUN,
  toolset: TOOLSET,
  turn: 1,
  type: 'run.start',
};

const without = (key: keyof typeof START) =>
  Object.fromEntries(Object.entries(START).filter(([name]) => name !== key));

describe('sandbox tool bridge', () => {
  it('requires a conversationKey and a toolset on every run.start, and nothing retired', () => {
    expect(companionCommandSchema.parse(START)).toEqual(START);
    expect(companionCommandSchema.safeParse(without('conversationKey')).success).toBe(false);
    expect(companionCommandSchema.safeParse(without('toolset')).success).toBe(false);
    // The retired local-device fields (spec 040) are refused, not ignored.
    for (const extra of [
      { permissionMode: 'default' },
      { toolMode: 'sandbox' },
      { workspaceId: null },
      { workspaceId: 'ws_1' },
    ]) {
      expect(
        companionCommandSchema.safeParse({ ...START, ...extra }).success,
        Object.keys(extra)[0],
      ).toBe(false);
    }
  });

  it('bounds the toolset and the conversation key', () => {
    const start = (extra: Record<string, unknown>) =>
      companionCommandSchema.safeParse({ ...START, ...extra }).success;
    expect(start({ toolset: [] })).toBe(false);
    expect(
      start({
        toolset: Array.from({ length: LOCAL_AGENT_SANDBOX_TOOLS.length + 1 }, () => TOOLSET[0]),
      }),
    ).toBe(false);
    expect(start({ toolset: [{ ...TOOLSET[0], name: 'WebFetch' }] })).toBe(false);
    expect(start({ toolset: [{ ...TOOLSET[0], inputSchema: { anyOf: [] } }] })).toBe(false);
    for (const key of ['', 'a/b', '../x', 'x'.repeat(129)]) {
      expect(start({ conversationKey: key }), key).toBe(false);
    }
    expect(start({ conversationKey: 'x'.repeat(128) })).toBe(true);
  });

  it('bounds a tool.call: a known tool, a plain call id, a JSON object input of capped size', () => {
    const call = (data: Record<string, unknown>) =>
      companionRunEventSchema.safeParse({
        data: { callId: 'c-1', input: { path: 'a.ts' }, name: 'fs_read', ...data },
        seq: 1,
        type: 'tool.call',
      }).success;
    expect(call({})).toBe(true);
    // The companion mints `call-<uuid>`.
    expect(call({ callId: `call-${RUN}` })).toBe(true);
    expect(call({ input: {}, name: 'preview_status' })).toBe(true);
    expect(call({ name: 'Bash' })).toBe(false);
    expect(call({ callId: 'a b' })).toBe(false);
    expect(call({ callId: 'x'.repeat(101) })).toBe(false);
    expect(call({ input: 'ls' })).toBe(false);
    expect(call({ input: ['ls'] })).toBe(false);
    expect(call({ input: { content: 'x'.repeat(LOCAL_AGENT_MAX_TOOL_INPUT_CHARS) } })).toBe(false);
  });

  it('bounds a tool.result and keeps the largest one under the command cap, escaped', () => {
    const result = (output: string) =>
      companionCommandSchema.safeParse({
        callId: 'c-1',
        ok: true,
        output,
        runId: RUN,
        turn: 1,
        type: 'tool.result',
      }).success;
    expect(result('done')).toBe(true);
    expect(result('x'.repeat(LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS))).toBe(true);
    expect(result('x'.repeat(LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS + 1))).toBe(false);
    const worst = JSON.stringify({
      callId: 'x'.repeat(100),
      isError: true,
      ok: false,
      output: '\u0001'.repeat(LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS),
      runId: RUN,
      turn: 1_000_000,
      type: 'tool.result',
    });
    expect(worst.length).toBeLessThanOrEqual(LOCAL_AGENT_MAX_COMMAND_CHARS);
  });

  it('truncates an output past the cap with a marker, whole otherwise', () => {
    expect(truncateToolOutput('short')).toBe('short');
    const long = 'a'.repeat(LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS + 10);
    const cut = truncateToolOutput(long);
    expect(cut.length).toBeLessThanOrEqual(LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS);
    expect(cut).toMatch(/\n\[output truncated: the first \d+ of 48010 characters are shown\]$/);
    // A surrogate pair at the cut is dropped whole, never halved.
    const emoji = truncateToolOutput('\u{1F600}'.repeat(LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS));
    expect(emoji.split('\n')[0]!.length % 2).toBe(0);
  });

  it('names a bridged tool by its tool server', () => {
    expect(sandboxToolOf('mcp__baios__fs_edit')).toBe('fs_edit');
    expect(sandboxToolOf('mcp__baios__WebFetch')).toBeUndefined();
    expect(sandboxToolOf('mcp__other__fs_edit')).toBeUndefined();
    expect(sandboxToolOf('Edit')).toBeUndefined();
  });
});

describe('companion commands', () => {
  it('accepts one well-formed command per type', () => {
    const commands = [
      {
        deviceId: RUN,
        heartbeatSeconds: 15,
        policy: { claude: { allowedAuthMethods: ['subscription', 'api_key'] } },
        type: 'hello',
      },
      { type: 'status.refresh' },
      { ...START, resume: { providerSessionId: 's-1' } },
      { message: 'go on', runId: RUN, type: 'run.input' },
      { runId: RUN, turn: 2, type: 'run.interrupt' },
      { type: 'device.revoked' },
      {
        callId: 'c1',
        isError: true,
        ok: false,
        output: 'kind: x',
        runId: RUN,
        turn: 1,
        type: 'tool.result',
      },
    ];

    for (const command of commands) {
      expect(companionCommandSchema.safeParse(command), command.type).toMatchObject({
        success: true,
      });
    }
    // Retired with local devices: approvals.
    expect(
      companionCommandSchema.safeParse({
        decision: 'deny',
        requestId: 'r1',
        runId: RUN,
        type: 'approval.respond',
      }).success,
    ).toBe(false);
  });

  it('accepts a hello that leaves a provider out (not allowed), and caps its heartbeat', () => {
    const hello = (extra: Record<string, unknown>) =>
      companionCommandSchema.safeParse({
        deviceId: RUN,
        heartbeatSeconds: 15,
        policy: { claude: { allowedAuthMethods: [] } },
        type: 'hello',
        ...extra,
      }).success;
    expect(hello({})).toBe(true);
    expect(hello({ heartbeatSeconds: 300 })).toBe(true);
    expect(hello({ heartbeatSeconds: 301 })).toBe(false);
    expect(hello({ policy: { codex: { allowedAuthMethods: ['api_key'] } } })).toBe(false);
  });

  it('keeps argv-bound run.start fields to plain tokens', () => {
    const start = (model: string | null, providerSessionId: string | null) =>
      companionCommandSchema.safeParse({
        ...START,
        model,
        resume: providerSessionId === null ? null : { providerSessionId },
      }).success;
    for (const model of ['sonnet', 'claude-opus-5-5[1m]', 'gpt-5.1-codex', 'openai/gpt-oss:20b']) {
      expect(start(model, null), model).toBe(true);
    }
    for (const id of ['11111111-2222-4333-8444-555555555555', 'thr_1.a:b']) {
      expect(start(null, id), id).toBe(true);
    }
    for (const bad of [
      '--dangerously-skip-permissions',
      '-p',
      'a b',
      'a"b',
      'a;b',
      '',
      'x'.repeat(201),
    ]) {
      expect(start(bad, null), `model ${bad}`).toBe(false);
      expect(start(null, bad), `session ${bad}`).toBe(false);
    }
    expect(
      companionRunEventSchema.safeParse({
        data: { providerSessionId: '--resume' },
        seq: 1,
        type: 'session',
      }).success,
    ).toBe(false);
  });

  it('refuses a run.start carrying a path or another provider', () => {
    expect(companionCommandSchema.safeParse({ ...START, cwd: '/home/ada' }).success).toBe(false);
    expect(companionCommandSchema.safeParse({ ...START, provider: 'codex' }).success).toBe(false);
  });
});

describe('companion uplink', () => {
  it('accepts a status report', () => {
    expect(
      companionStatusReportSchema.safeParse({
        companionVersion: '0.1.0',
        providers: [],
      }).success,
    ).toBe(true);
    // Workspaces went with local devices; a report naming any is refused.
    expect(
      companionStatusReportSchema.safeParse({
        companionVersion: '0.1.0',
        providers: [],
        workspaces: [{ id: 'ws_1', label: 'app' }],
      }).success,
    ).toBe(false);
  });

  it('accepts one well-formed run event per type', () => {
    const events = [
      { data: { providerSessionId: 's-1' }, type: 'session' },
      { data: { text: 'hi' }, type: 'text.delta' },
      { data: { text: 'hmm' }, type: 'reasoning.delta' },
      { data: { input: { cmd: 'ls' }, name: 'Bash', toolId: 't1' }, type: 'tool.start' },
      { data: { chunk: 'a.txt', toolId: 't1' }, type: 'tool.output' },
      { data: { ok: true, summary: null, toolId: 't1' }, type: 'tool.end' },
      { data: { inputTokens: 1, outputTokens: 2 }, type: 'usage' },
      { data: { costMicros: 41_250, inputTokens: 1, outputTokens: 2 }, type: 'usage' },
      { data: { callId: 'c1', input: { command: 'ls' }, name: 'exec' }, type: 'tool.call' },
      { data: { status: 'completed' }, type: 'terminal' },
      {
        data: {
          failure: { class: 'usage_limit', message: 'limit', resetsAt: '2026-11-02T12:00:00Z' },
          status: 'failed',
        },
        type: 'terminal',
      },
    ];

    events.forEach((event, index) => {
      expect(
        companionRunEventSchema.safeParse({ ...event, seq: index + 1 }),
        event.type,
      ).toMatchObject({ success: true });
    });
  });

  it('refuses a negative or fractional run cost', () => {
    for (const costMicros of [-1, 1.5]) {
      expect(
        companionRunEventSchema.safeParse({
          data: { costMicros, inputTokens: 1, outputTokens: 2 },
          seq: 1,
          type: 'usage',
        }).success,
      ).toBe(false);
    }
  });

  it('refuses the retired file.change and approval.request events', () => {
    for (const event of [
      { data: { kind: 'modified', path: 'src/a.ts' }, type: 'file.change' },
      {
        data: { detail: 'rm x', kind: 'command', requestId: 'r1', title: 'Run a command' },
        type: 'approval.request',
      },
    ]) {
      expect(companionRunEventSchema.safeParse({ ...event, seq: 1 }).success, event.type).toBe(
        false,
      );
    }
  });

  it('ties a failure to status failed, both ways', () => {
    const terminal = (data: unknown): boolean =>
      companionRunEventSchema.safeParse({ data, seq: 1, type: 'terminal' }).success;
    expect(terminal({ status: 'failed' })).toBe(false);
    expect(terminal({ failure: { class: 'crash', message: 'x' }, status: 'completed' })).toBe(
      false,
    );
  });

  it('bounds a batch and refuses a seq below 1', () => {
    expect(companionRunEventBatchSchema.safeParse({ events: [], turn: 1 }).success).toBe(false);
    expect(
      companionRunEventBatchSchema.safeParse({
        events: [{ data: { text: 'x' }, seq: 0, type: 'text.delta' }],
        turn: 1,
      }).success,
    ).toBe(false);
  });

  it('ties every batch, run.start and run.interrupt to a turn of at least 1', () => {
    const events = [{ data: { text: 'x' }, seq: 1, type: 'text.delta' }];
    expect(companionRunEventBatchSchema.safeParse({ events, turn: 2 }).success).toBe(true);
    expect(companionRunEventBatchSchema.safeParse({ events }).success).toBe(false);
    expect(companionRunEventBatchSchema.safeParse({ events, turn: 0 }).success).toBe(false);
    expect(companionCommandSchema.safeParse({ runId: RUN, type: 'run.interrupt' }).success).toBe(
      false,
    );
    expect(companionCommandSchema.safeParse(without('turn')).success).toBe(false);
    expect(companionCommandSchema.safeParse({ ...START, turn: 0 }).success).toBe(false);
  });
});
