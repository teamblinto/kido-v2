import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import type { CompanionCommand, CompanionToolDefinition } from '@repo/contracts';

import { tempDir, waitFor } from '../test/helpers.ts';
import { addWorkspace, ConfigStore } from './config.ts';
import { type ProbedStatus, ProviderRegistry } from './providers/registry.ts';
import type { RunEventBody, RunHandle, StartRunOptions } from './providers/types.ts';
import {
  clampPermissionMode,
  knownSessions,
  policyVerdict,
  recordSession,
  RunManager,
  sandboxCwd,
  sandboxRoot,
  SESSIONS_KEPT,
  sessionsDir,
} from './runs.ts';
import type { Uplink } from './uplink.ts';
import { AsyncQueue } from './util.ts';

const RUN = '3e0b1a2c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const POLICY = {
  claude: { allowedAuthMethods: ['subscription' as const] },
  codex: { allowedAuthMethods: ['api_key' as const] },
};

describe('clampPermissionMode', () => {
  it('never exceeds the local ceiling', () => {
    expect(clampPermissionMode('acceptEdits', 'default')).toBe('default');
    expect(clampPermissionMode('acceptEdits', 'plan')).toBe('plan');
    expect(clampPermissionMode('plan', 'acceptEdits')).toBe('plan');
    expect(clampPermissionMode('default', 'default')).toBe('default');
  });
});

describe('policyVerdict', () => {
  it('allows only the auth methods the server listed, for the current sign-in', () => {
    expect(policyVerdict(POLICY, 'codex', 'api_key')).toEqual({ allowed: true, reason: null });
    expect(policyVerdict(POLICY, 'codex', 'subscription').allowed).toBe(false);
    expect(
      policyVerdict({ ...POLICY, codex: { allowedAuthMethods: [] } }, 'codex', 'api_key').allowed,
    ).toBe(false);
    expect(policyVerdict(null, 'claude', 'subscription').allowed).toBe(false);
  });
});

function setup(probe: Partial<ProbedStatus['auth']> = {}, installed = true) {
  const config = new ConfigStore(join(tempDir(), 'home')).load();
  const workspace = addWorkspace(config, tempDir());
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
  const startRun = (options: StartRunOptions): RunHandle => {
    started.push(options);
    const events = new AsyncQueue<RunEventBody>();
    events.push({ data: { status: 'completed' }, type: 'terminal' });
    events.end();
    return {
      dispose: () => Promise.resolve(),
      events,
      input: () => undefined,
      interrupt: () => undefined,
      respondApproval: () => undefined,
      resolveToolCall: () => undefined,
    };
  };
  const providers = {
    adapters: { claude: { startRun }, codex: { startRun } },
    probe: () => Promise.resolve(status),
  } as unknown as ProviderRegistry;
  const manager = new RunManager({ config, policy: () => POLICY, providers, uplink });
  const start = (extra: Partial<Extract<CompanionCommand, { type: 'run.start' }>> = {}) =>
    manager.handle({
      conversationKey: null,
      model: null,
      permissionMode: 'default',
      prompt: 'hi',
      provider: 'claude',
      resume: null,
      runId: RUN,
      toolMode: 'workspace',
      turn: 1,
      type: 'run.start',
      workspaceId: workspace.id,
      ...extra,
    });
  const terminal = async () => {
    await waitFor(() => pushed.some((event) => event.type === 'terminal'));
    return pushed.find((event) => event.type === 'terminal')?.data;
  };
  return { config, manager, providers, pushed, start, started, terminal, turns };
}

describe('RunManager', () => {
  it('rejects a workspace id it does not know', async () => {
    const { start, started, terminal } = setup();
    start({ workspaceId: 'ws_unknown' });
    expect(await terminal()).toMatchObject({ failure: { class: 'workspace' }, status: 'failed' });
    expect(started).toEqual([]);
  });

  it('rejects a provider turned off locally, signed out, not installed, or blocked by policy', async () => {
    const off = setup();
    off.config.providers.claude.enabled = false;
    off.start();
    expect(await off.terminal()).toMatchObject({ failure: { class: 'policy' } });

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

  it('clamps the mode to the local ceiling, passes the workspace path only to the CLI, and runs a (run, turn) once', async () => {
    const { config, start, started, terminal } = setup();
    start({ permissionMode: 'acceptEdits', resume: { providerSessionId: 'sess-1' } });
    expect(await terminal()).toEqual({ status: 'completed' });
    expect(started).toEqual([
      expect.objectContaining({
        cwd: config.workspaces[0]?.path,
        permissionMode: 'default',
        resume: 'sess-1',
      }),
    ]);
    start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toHaveLength(1);
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
    const startRun = (options: StartRunOptions): RunHandle => {
      started.push(options);
      const events = new AsyncQueue<RunEventBody>();
      events.push({ data: { status: 'completed' }, type: 'terminal' });
      events.end();
      return {
        dispose: () => (started.length === 1 ? disposed : Promise.resolve()),
        events,
        input: () => undefined,
        interrupt: () => undefined,
        respondApproval: () => undefined,
        resolveToolCall: () => undefined,
      };
    };
    providers.adapters.claude.startRun = startRun;
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
});

describe('limits', () => {
  it('treats a provider the policy leaves out as not allowed', () => {
    expect(policyVerdict({ claude: POLICY.claude }, 'codex', 'api_key')).toMatchObject({
      allowed: false,
    });
  });

  it('refuses a run.start beyond maxConcurrentRuns (M4)', async () => {
    const { config, providers, pushed, start, started } = setup();
    config.maxConcurrentRuns = 1;
    const never = new AsyncQueue<RunEventBody>();
    const startRun = (options: StartRunOptions): RunHandle => {
      started.push(options);
      return {
        dispose: () => Promise.resolve(),
        events: never,
        input: () => undefined,
        interrupt: () => undefined,
        respondApproval: () => undefined,
        resolveToolCall: () => undefined,
      };
    };
    providers.adapters.claude.startRun = startRun;
    start();
    await waitFor(() => started.length === 1);
    start({ runId: '9f0b1a2c-5d6e-4f70-8a9b-0c1d2e3f4a5b' });
    await waitFor(() => pushed.some((event) => event.type === 'terminal'));
    const refused = pushed.find((event) => event.type === 'terminal')?.data;
    expect(refused).toMatchObject({ failure: { class: 'provider' }, status: 'failed' });
    expect(refused?.failure?.message).toContain('maxConcurrentRuns');
    expect(started).toHaveLength(1);
    never.end();
  });
});

describe('ProviderRegistry.probe', () => {
  it('shares a probe already running, and keeps home paths out of probe errors (M4, L3)', async () => {
    const config = new ConfigStore(join(tempDir(), 'home')).load();
    const registry = new ProviderRegistry(config, 'self.js');
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

describe('sandbox tool mode', () => {
  const saved = process.env.BAIOS_COMPANION_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.BAIOS_COMPANION_HOME;
    else process.env.BAIOS_COMPANION_HOME = saved;
  });

  it('runs without a workspace in a stable empty cwd, and routes tool.result by run and turn', async () => {
    const home = tempDir();
    process.env.BAIOS_COMPANION_HOME = home;
    const { config, manager, providers, pushed, start, started } = setup();
    config.sandboxRuns = true;
    const events = new AsyncQueue<RunEventBody>();
    const resolved: unknown[] = [];
    providers.adapters.claude.startRun = (options: StartRunOptions): RunHandle => {
      started.push(options);
      return {
        dispose: () => Promise.resolve(),
        events,
        input: () => undefined,
        interrupt: () => undefined,
        respondApproval: () => undefined,
        resolveToolCall: (callId, result) => resolved.push({ callId, ...result }),
      };
    };
    const toolset: CompanionToolDefinition[] = [
      { description: 'Read', inputSchema: { type: 'object' }, name: 'fs_read' },
    ];
    start({ conversationKey: 'conv-1', toolMode: 'sandbox', toolset, workspaceId: null });
    await waitFor(() => started.length === 1);
    const cwd = started[0]?.cwd ?? '';
    expect(started[0]?.toolset).toEqual(toolset);
    // Outside the companion home, which holds credentials.json (M2).
    expect(cwd.startsWith(sandboxRoot())).toBe(true);
    expect(cwd.startsWith(home)).toBe(false);
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

  it('refuses sandbox runs on a person’s computer until sandboxRuns is turned on (M2)', async () => {
    process.env.BAIOS_COMPANION_HOME = tempDir();
    const { start, started, terminal } = setup();
    start({ conversationKey: 'conv-1', toolMode: 'sandbox', toolset: [], workspaceId: null });
    const refused = await terminal();
    expect(refused).toMatchObject({ failure: { class: 'workspace' }, status: 'failed' });
    expect(refused?.failure?.message).toContain('config set sandboxRuns true');
    expect(started).toEqual([]);
  });

  it('resumes only a session this conversation’s CLI reported, and keeps the last 50 (M1)', async () => {
    const home = tempDir();
    process.env.BAIOS_COMPANION_HOME = home;
    const { config, providers, pushed, start, started } = setup();
    config.sandboxRuns = true;
    providers.adapters.claude.startRun = (options: StartRunOptions): RunHandle => {
      started.push(options);
      const events = new AsyncQueue<RunEventBody>();
      events.push({ data: { providerSessionId: 'sess-a' }, type: 'session' });
      events.push({ data: { status: 'completed' }, type: 'terminal' });
      events.end();
      return {
        dispose: () => Promise.resolve(),
        events,
        input: () => undefined,
        interrupt: () => undefined,
        respondApproval: () => undefined,
        resolveToolCall: () => undefined,
      };
    };
    const sandbox = { toolMode: 'sandbox' as const, toolset: [], workspaceId: null };
    const terminals = () => pushed.filter((event) => event.type === 'terminal');
    const resume = { providerSessionId: 'sess-a' };

    // A session id the companion never saw for this conversation is refused before any spawn.
    start({ ...sandbox, conversationKey: 'conv-1', resume });
    await waitFor(() => terminals().length === 1);
    expect(terminals()[0]?.data).toEqual({
      failure: { class: 'provider', message: 'Unknown conversation session' },
      status: 'failed',
    });
    expect(started).toEqual([]);

    start({ ...sandbox, conversationKey: 'conv-1', turn: 2 });
    await waitFor(() => terminals().length === 2);
    expect(sessionsDir().startsWith(home)).toBe(true);
    expect(knownSessions(sessionsDir(), 'conv-1')).toEqual(['sess-a']);
    start({ ...sandbox, conversationKey: 'conv-1', resume, turn: 3 });
    await waitFor(() => terminals().length === 3);
    expect(terminals()[2]?.data).toEqual({ status: 'completed' });
    expect(started.map((options) => options.resume)).toEqual([null, 'sess-a']);

    // Another conversation cannot pick it up.
    start({ ...sandbox, conversationKey: 'conv-2', resume, turn: 4 });
    await waitFor(() => terminals().length === 4);
    expect(terminals()[3]?.data).toMatchObject({
      failure: { message: 'Unknown conversation session' },
    });
    expect(started).toHaveLength(2);

    const dir = sessionsDir();
    for (let i = 0; i < SESSIONS_KEPT + 5; i++) recordSession(dir, 'conv-3', `s-${i}`);
    const kept = knownSessions(dir, 'conv-3');
    expect(kept).toHaveLength(SESSIONS_KEPT);
    expect(kept.at(-1)).toBe(`s-${SESSIONS_KEPT + 4}`);
    expect(kept).not.toContain('s-4');
  });
});
