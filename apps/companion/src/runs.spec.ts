import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import type { CompanionCommand, CompanionToolDefinition } from '@repo/contracts';

import { tempDir, waitFor } from '../test/helpers.ts';
import { type ProbedStatus, ProviderRegistry } from './providers/registry.ts';
import type { RunEventBody, RunHandle, StartRunOptions } from './providers/types.ts';
import {
  knownSessions,
  policyVerdict,
  recordSession,
  RunManager,
  sessionCost,
  sandboxCwd,
  sandboxRoot,
  SESSIONS_KEPT,
} from './runs.ts';
import type { Uplink } from './uplink.ts';
import { AsyncQueue } from './util.ts';

const RUN = '3e0b1a2c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const POLICY = { claude: { allowedAuthMethods: ['subscription' as const] } };
const TOOLSET: CompanionToolDefinition[] = [
  { description: 'Read', inputSchema: { type: 'object' }, name: 'fs_read' },
];

describe('policyVerdict', () => {
  it('allows only the auth methods the server listed, for the current sign-in', () => {
    expect(policyVerdict(POLICY, 'claude', 'subscription')).toEqual({
      allowed: true,
      reason: null,
    });
    expect(policyVerdict(POLICY, 'claude', 'api_key').allowed).toBe(false);
    expect(policyVerdict({ claude: { allowedAuthMethods: [] } }, 'claude', 'subscription')).toEqual(
      { allowed: false, reason: 'This BAIOS deployment does not allow Claude Code.' },
    );
    expect(policyVerdict({}, 'claude', 'subscription').allowed).toBe(false);
    expect(policyVerdict(null, 'claude', 'subscription').allowed).toBe(false);
  });
});

function handleOf(events: AsyncQueue<RunEventBody>, extra: Partial<RunHandle> = {}): RunHandle {
  return {
    dispose: () => Promise.resolve(),
    events,
    input: () => undefined,
    interrupt: () => undefined,
    resolveToolCall: () => undefined,
    ...extra,
  };
}

function completedHandle(...before: RunEventBody[]): RunHandle {
  const events = new AsyncQueue<RunEventBody>();
  for (const event of before) events.push(event);
  events.push({ data: { status: 'completed' }, type: 'terminal' });
  events.end();
  return handleOf(events);
}

function setup(probe: Partial<ProbedStatus['auth']> = {}, installed = true, maxConcurrentRuns = 2) {
  const pushed: RunEventBody[] = [];
  const turns: number[] = [];
  const uplink = {
    push: (_runId: string, turn: number, event: RunEventBody) => {
      turns.push(turn);
      pushed.push(event);
    },
  } as unknown as Uplink;
  const started: StartRunOptions[] = [];
  const status: ProbedStatus = {
    auth: { method: 'subscription', plan: null, status: 'authenticated', ...probe },
    checkedAt: new Date().toISOString(),
    installed,
    message: null,
    models: [],
    provider: 'claude',
    version: '1.0.0',
  };
  const providers = {
    adapters: {
      claude: {
        startRun: (options: StartRunOptions): RunHandle => {
          started.push(options);
          return completedHandle();
        },
      },
    },
    probe: () => Promise.resolve(status),
  } as unknown as ProviderRegistry;
  const sessions = join(tempDir(), 'sessions');
  let ended = 0;
  const manager = new RunManager({
    maxConcurrentRuns,
    onRunEnd: () => (ended += 1),
    policy: () => POLICY,
    providers,
    sessionsDir: sessions,
    uplink,
  });
  const start = (extra: Partial<Extract<CompanionCommand, { type: 'run.start' }>> = {}) =>
    manager.handle({
      conversationKey: 'conv-1',
      model: null,
      prompt: 'hi',
      provider: 'claude',
      resume: null,
      runId: RUN,
      toolset: TOOLSET,
      turn: 1,
      type: 'run.start',
      ...extra,
    });
  const terminal = async () => {
    await waitFor(() => pushed.some((event) => event.type === 'terminal'));
    return pushed.find((event) => event.type === 'terminal')?.data;
  };
  const runEnds = () => ended;
  return { manager, providers, pushed, runEnds, sessions, start, started, terminal, turns };
}

describe('RunManager', () => {
  it('rejects a provider signed out, not installed, or blocked by policy', async () => {
    const signedOut = setup({ method: null, status: 'unauthenticated' });
    signedOut.start();
    expect(await signedOut.terminal()).toMatchObject({ failure: { class: 'auth' } });

    const missing = setup({}, false);
    missing.start();
    expect(await missing.terminal()).toMatchObject({ failure: { class: 'provider' } });

    const blocked = setup({ method: 'api_key' });
    blocked.start();
    expect(await blocked.terminal()).toMatchObject({ failure: { class: 'policy' } });
    expect(blocked.started).toEqual([]);
  });

  it('ends an interrupt for a run it is not running, for that turn, so the server need not wait it out', () => {
    const { manager, pushed, turns } = setup();
    manager.handle({ runId: RUN, turn: 3, type: 'run.interrupt' });
    expect(pushed).toEqual([{ data: { status: 'interrupted' }, type: 'terminal' }]);
    expect(turns).toEqual([3]);
  });

  it('runs a follow-up turn of the same run, and ignores a repeated turn', async () => {
    const { pushed, start, started, turns } = setup();
    start();
    await waitFor(() => pushed.length === 1);
    start({ prompt: 'and now this', turn: 2 });
    await waitFor(() => pushed.length === 2);
    start({ turn: 2 });
    start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started.map((options) => options.prompt)).toEqual(['hi', 'and now this']);
    expect(turns).toEqual([1, 2]);
  });

  it('starts the next turn once the last one has finished shutting its CLI down', async () => {
    const { providers, pushed, start, started, turns } = setup();
    let release!: () => void;
    const disposed = new Promise<void>((resolve) => (release = resolve));
    providers.adapters.claude.startRun = (options: StartRunOptions): RunHandle => {
      started.push(options);
      const handle = completedHandle();
      return started.length === 1 ? { ...handle, dispose: () => disposed } : handle;
    };
    start();
    await waitFor(() => pushed.length === 1);
    // Turn 1 reported its end and is still disposing when turn 2 arrives.
    start({ prompt: 'next', turn: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toHaveLength(1);
    release();
    await waitFor(() => pushed.length === 2);
    expect(started.map((options) => options.prompt)).toEqual(['hi', 'next']);
    expect(turns).toEqual([1, 2]);
  });

  it('refuses a run.start beyond maxConcurrentRuns (M4)', async () => {
    const { providers, pushed, start, started } = setup({}, true, 1);
    const never = new AsyncQueue<RunEventBody>();
    providers.adapters.claude.startRun = (options: StartRunOptions): RunHandle => {
      started.push(options);
      return handleOf(never);
    };
    start();
    await waitFor(() => started.length === 1);
    start({ runId: '9f0b1a2c-5d6e-4f70-8a9b-0c1d2e3f4a5b' });
    await waitFor(() => pushed.some((event) => event.type === 'terminal'));
    const refused = pushed.find((event) => event.type === 'terminal')?.data;
    expect(refused).toMatchObject({ failure: { class: 'provider' }, status: 'failed' });
    expect(refused?.failure?.message).toContain('its limit');
    expect(started).toHaveLength(1);
    never.end();
  });
});

describe('ProviderRegistry.probe', () => {
  it('shares a probe already running, and keeps home paths out of probe errors (M4, L3)', async () => {
    const registry = new ProviderRegistry('self.js');
    let calls = 0;
    registry.adapters.claude.probe = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error(`spawn ${join(homedir(), '.local', 'bin', 'claude.exe')} EACCES`);
    };
    const [first, second] = await Promise.all([registry.probe('claude'), registry.probe('claude')]);
    expect(calls).toBe(1);
    expect(second).toBe(first);
    expect(first.message).toContain(`~${sep}.local`);
    expect(first.message).not.toContain(homedir());
  });
});

describe('ProviderRegistry.report', () => {
  const signedIn = {
    auth: { method: 'subscription' as const, plan: null, status: 'authenticated' as const },
    installed: true,
    message: null,
    models: [],
    version: '2.1.317',
  };
  const usage = {
    checkedAt: '2026-11-03T12:00:00.000Z',
    windows: [{ kind: 'session' as const, resetsAt: null, utilization: 59 }],
  };
  const models = [{ description: null, id: 'opus', label: 'Opus 5.5' }];

  it('adds the CLI’s own models and limits, its plan when auth status gave none, one probe at a time', async () => {
    const registry = new ProviderRegistry('self.js');
    let asked = 0;
    registry.adapters.claude.probe = () => Promise.resolve(signedIn);
    registry.adapters.claude.details = async () => {
      asked += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { models, plan: 'Max', usage };
    };
    const [first, second] = await Promise.all([
      registry.report('claude'),
      registry.report('claude'),
    ]);
    expect(asked).toBe(1);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ auth: { plan: 'Max' }, models, usage });
  });

  it('probes afresh for every report, even within the same millisecond', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_793_736_000_000);
    try {
      const registry = new ProviderRegistry('self.js');
      let probed = 0;
      registry.adapters.claude.probe = () => {
        probed += 1;
        return Promise.resolve(signedIn);
      };
      registry.adapters.claude.details = () => Promise.reject(new Error('boom'));

      await registry.report('claude');
      await registry.report('claude');

      expect(probed).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it('leaves models and limits out when the probe fails, and never asks a signed-out CLI', async () => {
    const registry = new ProviderRegistry('self.js');
    let asked = 0;
    registry.adapters.claude.probe = () => Promise.resolve(signedIn);
    registry.adapters.claude.details = () => {
      asked += 1;
      return Promise.reject(new Error('boom'));
    };
    const failed = await registry.report('claude');
    expect(failed).toMatchObject({ auth: { status: 'authenticated' }, models: [] });
    expect(failed).not.toHaveProperty('usage');

    registry.adapters.claude.probe = () =>
      Promise.resolve({
        ...signedIn,
        auth: { method: null, plan: null, status: 'unauthenticated' as const },
      });
    expect((await registry.report('claude')).models).toEqual([]);
    expect(asked).toBe(1);
  });
});

describe('sandbox runs', () => {
  it('runs in a stable empty cwd per conversation, and routes tool.result by run and turn', async () => {
    const { manager, providers, pushed, start, started } = setup();
    const events = new AsyncQueue<RunEventBody>();
    const resolved: unknown[] = [];
    providers.adapters.claude.startRun = (options: StartRunOptions): RunHandle => {
      started.push(options);
      return handleOf(events, {
        resolveToolCall: (callId, result) => resolved.push({ callId, ...result }),
      });
    };
    start();
    await waitFor(() => started.length === 1);
    const cwd = started[0]?.cwd ?? '';
    expect(started[0]?.toolset).toEqual(TOOLSET);
    expect(cwd.startsWith(sandboxRoot())).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);

    const result = { callId: 'call-1', ok: true, output: 'done', type: 'tool.result' } as const;
    manager.handle({ ...result, runId: RUN, turn: 2 }); // another turn's call
    manager.handle({ ...result, runId: '9f0b1a2c-5d6e-4f70-8a9b-0c1d2e3f4a5b', turn: 1 });
    manager.handle({ ...result, ok: false, runId: RUN, turn: 1 });
    expect(resolved).toEqual([{ callId: 'call-1', isError: true, output: 'done' }]);

    events.push({ data: { status: 'completed' }, type: 'terminal' });
    events.end();
    await waitFor(() => pushed.some((event) => event.type === 'terminal'));
    // The same conversation gets the same cwd again.
    expect(await sandboxCwd('conv-1')).toBe(cwd);
  });

  it('resumes only a session this conversation’s CLI reported, and keeps the last 50 (M1)', async () => {
    const { providers, pushed, sessions, start, started } = setup();
    providers.adapters.claude.startRun = (options: StartRunOptions): RunHandle => {
      started.push(options);
      return completedHandle({ data: { providerSessionId: 'sess-a' }, type: 'session' });
    };
    const terminals = () => pushed.filter((event) => event.type === 'terminal');
    const resume = { providerSessionId: 'sess-a' };

    // A session id the runner never saw for this conversation is refused before any spawn.
    start({ resume });
    await waitFor(() => terminals().length === 1);
    expect(terminals()[0]?.data).toEqual({
      failure: { class: 'provider', message: 'Unknown conversation session' },
      status: 'failed',
    });
    expect(started).toEqual([]);

    start({ turn: 2 });
    await waitFor(() => terminals().length === 2);
    expect(knownSessions(sessions, 'conv-1')).toEqual(['sess-a']);
    start({ resume, turn: 3 });
    await waitFor(() => terminals().length === 3);
    expect(terminals()[2]?.data).toEqual({ status: 'completed' });
    expect(started.map((options) => options.resume)).toEqual([null, 'sess-a']);

    // Another conversation cannot pick it up.
    start({ conversationKey: 'conv-2', resume, turn: 4 });
    await waitFor(() => terminals().length === 4);
    expect(terminals()[3]?.data).toMatchObject({
      failure: { message: 'Unknown conversation session' },
    });
    expect(started).toHaveLength(2);

    for (let i = 0; i < SESSIONS_KEPT + 5; i++) recordSession(sessions, 'conv-3', `s-${i}`);
    const kept = knownSessions(sessions, 'conv-3');
    expect(kept).toHaveLength(SESSIONS_KEPT);
    expect(kept.at(-1)).toBe(`s-${SESSIONS_KEPT + 4}`);
    expect(kept).not.toContain('s-4');
  });

  it('hands a resumed run its session’s cost so far, records the new total, and refreshes the status after each CLI run', async () => {
    const { providers, runEnds, sessions, start, started } = setup();
    providers.adapters.claude.startRun = (options: StartRunOptions): RunHandle => {
      started.push(options);
      return {
        ...completedHandle({ data: { providerSessionId: 'sess-c' }, type: 'session' }),
        sessionCostMicros: (options.sessionCostMicros ?? 0) + 12_500,
      };
    };
    start();
    await waitFor(() => runEnds() === 1);
    expect(sessionCost(sessions, 'sess-c')).toBe(12_500);
    start({ resume: { providerSessionId: 'sess-c' }, turn: 2 });
    await waitFor(() => runEnds() === 2);
    expect(started.map((options) => options.sessionCostMicros)).toEqual([0, 12_500]);
    expect(sessionCost(sessions, 'sess-c')).toBe(25_000);
    expect(sessionCost(sessions, 'sess-unknown')).toBe(0);

    // A run refused before any CLI started moves no limit: no extra report.
    const signedOut = setup({ method: null, status: 'unauthenticated' });
    signedOut.start();
    await signedOut.terminal();
    expect(signedOut.runEnds()).toBe(0);
  });
});
