import {
  type CompanionCommand,
  type CompanionRunEvent,
  type CompanionStatusReport,
  LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS,
  type LocalAgentProviderStatus,
} from '@repo/contracts';
import type { LocalAgentRunRow } from '@repo/db';
import { describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { TenantContext } from '../../database/tenant-context';
import { RunExecutorRegistry } from '../agent/run-executor-registry';
import type { EmittedEvent, ExecutionContext, RunSnapshot } from '../agent/run-executor.port';
import { ALL_TOOLS, SandboxTools } from '../agent/sandbox-tools';
import type { CheckpointService } from '../checkpoints/checkpoint.service';
import { DEFAULT_SANDBOX_TIMINGS } from '../sandbox/sandbox.constants';
import type { SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import type { SandboxPort } from '../sandbox/sandbox.port';
import type { PermissionResolutionService } from '../rbac/permission-resolution.service';
import { scoped } from '../rbac/permissions';
import type { LocalAgentTimings } from './local-agent.constants';
import { conversationKeyOf, LocalAgentExecutor } from './local-agent.executor';
import type { LocalAgentRepository } from './local-agent.repository';
import type {
  ActiveTurn,
  LocalAgentStore,
  RunAbortReason,
  RunCursor,
  RunRead,
} from './local-agent.store';

const RUN = 'b0400000-0000-4000-8000-000000000001';
const DEVICE = 'b0400000-0000-4000-8000-0000000000d1';
const USER = 'b0400000-0000-4000-8000-0000000000a1';
const ORG = 'b0400000-0000-4000-8000-0000000000c1';

const TIMINGS: LocalAgentTimings = {
  cancelPollMs: 0,
  heartbeatMs: 15_000,
  interruptWaitMs: 10_000,
  maxRunMs: 600_000,
  offlineGraceMs: 10_000,
  presenceTtlSeconds: 45,
  readBlockMs: 1_000,
  runEventBudgetBytes: 1_000_000,
  runIdleMs: 120_000,
  startAckMs: 30_000,
};

/** What a subscription run's failure says once the home's Settings remedy replaces it. */
const UNREACHABLE = 'Your cloud workspace could not be reached — try again in a minute.';
const DISCONNECTED =
  'Your cloud workspace was disconnected — reconnect your Claude subscription in Settings.';
const EXPIRED = 'Your Claude sign-in has expired — reconnect your Claude subscription in Settings.';

const claude: LocalAgentProviderStatus = {
  auth: { method: 'subscription', plan: 'Max', status: 'authenticated' },
  checkedAt: '2026-11-02T00:00:00.000Z',
  installed: true,
  message: null,
  models: [],
  policy: { allowed: true, reason: null },
  provider: 'claude',
  version: '2.0.0',
};
const REPORT: CompanionStatusReport = { companionVersion: 'hosted', providers: [claude] };

interface Entry<T> {
  id: string;
  value: T;
}

const after = (id: string, cursor: string) =>
  Number(id.split('-')[0]) > Number(cursor.split('-')[0]);

/** The executor's Redis, in memory: an empty read "blocks" by moving the fake clock. */
class FakeChannel {
  online = true;
  report: CompanionStatusReport | undefined = REPORT;
  readonly published: CompanionCommand[] = [];
  readonly events: Entry<CompanionRunEvent>[] = [];
  readonly aborts: Entry<RunAbortReason>[] = [];
  readonly begun: { turn: number; startedAt: number }[] = [];
  active: ActiveTurn | undefined;
  readonly readTurns = new Set<number>();
  reads = 0;
  saved: RunCursor | undefined;
  private control = 0;
  /** Called before each read: the test's script of what the runner and the person do. */
  script: (read: number, channel: FakeChannel) => void = () => undefined;

  constructor(private readonly clock: FakeClock) {}

  push(...events: CompanionRunEvent[]): void {
    for (const event of events) this.events.push({ id: `${String(event.seq)}-0`, value: event });
  }

  abort(reason: RunAbortReason): void {
    this.aborts.push({ id: `${String((this.control += 1))}-0`, value: reason });
  }

  reader() {
    return {
      close: () => undefined,
      read: (
        _runId: string,
        turn: number,
        cursor: RunCursor,
        blockMs: number,
      ): Promise<RunRead> => {
        this.reads += 1;
        this.readTurns.add(turn);
        this.script(this.reads, this);
        const events = this.events
          .filter((entry) => after(entry.id, cursor.events))
          .map(({ id, value }) => ({ event: value, id }));
        const aborts = this.aborts
          .filter((entry) => after(entry.id, cursor.control))
          .map(({ id, value }) => ({ id, reason: value }));
        if (events.length + aborts.length === 0) this.clock.advance(blockMs);
        return Promise.resolve({ aborts, events });
      },
    };
  }

  isOnline = () => Promise.resolve(this.online);
  status = () => Promise.resolve(this.report);
  publish = (_device: string, command: CompanionCommand) => {
    this.published.push(command);
    return Promise.resolve();
  };
  beginTurn = (_run: string, turn: number, startedAt: number) => {
    this.begun.push({ startedAt, turn });
    this.active = { startedAt, turn };
    return Promise.resolve();
  };
  markTurn = vi.fn((_run: string, turn: number, startedAt: number) => {
    this.active = { startedAt, turn };
    return Promise.resolve();
  });
  activeTurn = () => Promise.resolve(this.active);
  endTurn = () => {
    this.active = undefined;
    return Promise.resolve();
  };
  cursor = () => Promise.resolve(this.saved ?? { control: '0-0', events: '0-0' });
  saveCursor = (_run: string, cursor: RunCursor) => {
    this.saved = cursor;
    return Promise.resolve();
  };
}

function target(overrides: Partial<LocalAgentRunRow> = {}): LocalAgentRunRow {
  return {
    createdAt: new Date(0),
    deviceId: DEVICE,
    orgId: ORG,
    permissionMode: 'default',
    provider: 'claude',
    providerSessionId: null,
    runId: RUN,
    toolMode: 'sandbox',
    updatedAt: new Date(0),
    workspaceId: null,
    ...overrides,
  };
}

function message(content: string, role: 'user' | 'assistant' = 'user') {
  return {
    at: new Date(0),
    content,
    createdAt: new Date(0),
    id: content,
    orgId: ORG,
    role,
    runId: RUN,
    toolCalls: [],
    updatedAt: new Date(0),
  };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    committed: { openStepId: null, pauses: 0, toolEnds: 0 },
    epoch: 1,
    id: RUN,
    lastSeq: 1,
    messages: [message('fix the tests')],
    model: 'claude',
    orgId: ORG,
    projectId: 'project',
    status: 'starting',
    userId: USER,
    ...overrides,
  };
}

interface Device {
  id: string;
  name: string;
  revokedAt: Date | null;
  userId: string;
}

function setup(
  options: {
    row?: LocalAgentRunRow | undefined;
    run?: Partial<RunSnapshot>;
    cancelAfter?: number;
    /** Overrides on the agent-home service (by default: enabled, a home, woken online). */
    homes?: Record<string, unknown>;
  } = {},
) {
  const clock = new FakeClock('2026-11-02T00:00:00Z');
  const channel = new FakeChannel(clock);
  const row = 'row' in options ? options.row : target();
  let device: Device | undefined = {
    id: DEVICE,
    name: 'Cloud agent home',
    revokedAt: null,
    userId: USER,
  };
  let granted = new Set<string>([scoped('project:agent.run', 'project')]);
  const repository = {
    deviceOn: vi.fn(() => Promise.resolve(device)),
    insertRun: vi.fn(() => Promise.resolve()),
    runOn: vi.fn(() => Promise.resolve(row)),
  };
  const permissions = { for: vi.fn(() => Promise.resolve(granted)) };
  const config = { get: (key: string) => key === 'LOCAL_AGENT_ENABLED' };
  const homes = {
    admissible: vi.fn(() => Promise.resolve({ deviceId: DEVICE, state: 'running' })),
    enabled: true,
    isHome: vi.fn(() => Promise.resolve(true)),
    touchDevice: vi.fn(() => Promise.resolve()),
    wake: vi.fn(() => Promise.resolve('online')),
    ...options.homes,
  };
  // The project's sandbox, in memory — what the bridge's tool calls and checkpoints reach.
  const files = new Map<string, string>([['README.md', 'hello']]);
  const port = {
    edit: vi.fn((_ref: unknown, edit: { path: string; content?: string }) => {
      const before = files.get(edit.path);
      files.set(edit.path, edit.content ?? '');
      return Promise.resolve({ diff: before === edit.content ? '' : `+${edit.content ?? ''}` });
    }),
    list: vi.fn(() => Promise.resolve([])),
    read: vi.fn((_ref: unknown, path: string) => Promise.resolve(files.get(path) ?? '')),
  };
  const lifecycle = { ensureReady: vi.fn(() => Promise.resolve({ ready: true })) };
  const checkpoints = {
    commitTurn: vi.fn((_ref: unknown, _ctx: unknown, origin: { turn: number }) =>
      Promise.resolve({ id: 'cp-1', label: `Turn ${String(origin.turn)}` }),
    ),
    ensureRepository: vi.fn(() => Promise.resolve()),
  };
  const sandbox = new SandboxTools({
    allowed: ALL_TOOLS,
    checkpoints: checkpoints as unknown as CheckpointService,
    clock,
    lifecycle: lifecycle as unknown as SandboxLifecycle,
    port: port as unknown as SandboxPort,
    sandboxTimings: DEFAULT_SANDBOX_TIMINGS,
    tenant: { tx: {} } as unknown as TenantContext,
  });
  const executor = new LocalAgentExecutor(
    new RunExecutorRegistry(),
    {
      ...channel,
      online: channel.isOnline,
      reader: () => channel.reader(),
    } as unknown as LocalAgentStore,
    repository as unknown as LocalAgentRepository,
    { tx: {} } as unknown as TenantContext,
    clock,
    TIMINGS,
    permissions as unknown as PermissionResolutionService,
    config as never,
    sandbox,
    homes as never,
  );
  const emitted: EmittedEvent[] = [];
  const persisted: string[] = [];
  const flush = vi.fn(() => Promise.resolve());
  const dispatch = vi.fn((fn: () => Promise<unknown>) => fn());
  let polls = 0;
  const context: ExecutionContext = {
    cancelled: () => {
      polls += 1;
      return Promise.resolve(options.cancelAfter !== undefined && polls > options.cancelAfter);
    },
    dispatch: dispatch as ExecutionContext['dispatch'],
    emit: (event) => {
      emitted.push(event);
      return Promise.resolve();
    },
    flush,
    persist: (persistedMessage) => {
      persisted.push(persistedMessage.content);
      return Promise.resolve();
    },
    run: snapshot(options.run),
    signal: new AbortController().signal,
  };

  return {
    channel,
    checkpoints,
    clock,
    context,
    dispatch,
    emitted,
    executor,
    files,
    flush,
    homes,
    lifecycle,
    persisted,
    port,
    repository,
    revoke: (changed: Device | undefined) => {
      device = changed;
    },
    setGranted: (next: Set<string>) => {
      granted = next;
    },
  };
}

const completed: CompanionRunEvent = { data: { status: 'completed' }, seq: 99, type: 'terminal' };

function reasonOf(outcome: unknown): string {
  return (outcome as { reason: string }).reason;
}

describe('LocalAgentExecutor', () => {
  it('starts the turn in the home, maps the stream, persists the reply and awaits the person', async () => {
    const { channel, context, emitted, executor, persisted } = setup();
    channel.script = (read, c) => {
      if (read !== 1) return;
      c.push(
        { data: { providerSessionId: 'sess-1' }, seq: 1, type: 'session' },
        { data: { text: 'Hel' }, seq: 2, type: 'text.delta' },
        { data: { text: 'hmm' }, seq: 3, type: 'reasoning.delta' },
        { data: { input: { cmd: 'ls' }, name: 'Bash', toolId: 't1' }, seq: 4, type: 'tool.start' },
        { data: { chunk: 'a.ts\n', toolId: 't1' }, seq: 5, type: 'tool.output' },
        { data: { ok: false, summary: 'exit 1', toolId: 't1' }, seq: 7, type: 'tool.end' },
        { data: { text: 'lo' }, seq: 8, type: 'text.delta' },
        { data: { inputTokens: 10, outputTokens: 5 }, seq: 9, type: 'usage' },
        completed,
      );
    };

    await expect(executor.execute(context)).resolves.toEqual({ kind: 'awaiting_input' });

    expect(channel.begun.map((each) => each.turn)).toEqual([1]);
    expect(channel.published[0]).toEqual({
      conversationKey: conversationKeyOf(ORG, 'project'),
      model: null,
      prompt: 'fix the tests',
      provider: 'claude',
      resume: null,
      runId: RUN,
      toolset: expect.any(Array) as unknown,
      turn: 1,
      type: 'run.start',
    });
    const step = `${RUN}/t1`;
    expect(emitted).toEqual([
      { data: { text: 'Hel' }, type: 'token' },
      { data: { text: 'hmm' }, type: 'thought' },
      { data: { input: { cmd: 'ls' }, stepId: step, tool: 'Bash' }, type: 'tool.start' },
      { data: { chunk: 'a.ts\n', stepId: step }, type: 'tool.delta' },
      {
        data: { ok: true, output: { ok: false, summary: 'exit 1' }, stepId: step },
        type: 'tool.end',
      },
      { data: { text: 'lo' }, type: 'token' },
      { data: { costMicros: 0, inputTokens: 10, outputTokens: 5 }, type: 'usage' },
      { data: { checkpointId: 'cp-1', label: 'Turn 1' }, type: 'checkpoint' },
    ]);
    expect(persisted).toEqual(['Hello']);
    expect(channel.saved).toEqual({ control: '0-0', events: '99-0' });
    // The turn is closed: the uplink refuses its late retries from now on.
    expect(channel.active).toBeUndefined();
  });

  it('numbers a follow-up turn, reads only its stream, and resumes the provider session', async () => {
    const { channel, context, executor } = setup({
      row: target({ providerSessionId: 'sess-1' }),
      run: {
        messages: [message('fix the tests'), message('Done.', 'assistant'), message('and lint')],
        model: 'opus',
      },
    });
    channel.script = (read, c) => read === 1 && c.push(completed);

    await executor.execute(context);

    expect(channel.begun.map((each) => each.turn)).toEqual([2]);
    expect([...channel.readTurns]).toEqual([2]);
    expect(channel.published[0]).toMatchObject({
      model: 'opus',
      prompt: 'and lint',
      resume: { providerSessionId: 'sess-1' },
      turn: 2,
    });
  });

  it('opens the turn and sends run.start under the fence, so a stale attempt sends nothing', async () => {
    const { channel, checkpoints, context, dispatch, executor } = setup();
    const fenced = new Error('fenced');
    let stale = false;
    // Fenced from the baseline on: the next fenced step is opening the turn.
    checkpoints.ensureRepository.mockImplementationOnce(() => {
      stale = true;
      return Promise.resolve();
    });
    dispatch.mockImplementation((fn) => (stale ? Promise.reject(fenced) : fn()));

    await expect(executor.execute(context)).rejects.toBe(fenced);
    expect(channel.begun).toEqual([]);
    expect(channel.published).toEqual([]);
  });

  it('picks a re-claimed attempt up at its cursor, keeping when its turn started', async () => {
    const { channel, clock, context, executor } = setup({ run: { status: 'running' } });
    const startedAt = clock.now().getTime() - 60_000;
    channel.active = { startedAt, turn: 1 };
    channel.saved = { control: '0-0', events: '5-0' };
    channel.push({ data: { text: 'old' }, seq: 5, type: 'text.delta' }, completed);

    await expect(executor.execute(context)).resolves.toEqual({ kind: 'awaiting_input' });
    expect(channel.begun).toEqual([]);
    expect(channel.published).toEqual([]);
    expect(channel.markTurn).toHaveBeenCalledWith(RUN, 1, startedAt);
  });

  it('counts the turn ceiling from when the turn started, not from the re-claim', async () => {
    const { channel, clock, context, executor } = setup({ run: { status: 'running' } });
    channel.active = { startedAt: clock.now().getTime() - TIMINGS.maxRunMs, turn: 1 };

    await expect(executor.execute(context)).resolves.toMatchObject({
      reason: expect.stringContaining('local-agent timeout') as string,
    });
  });

  it('on cancel interrupts the runner and stops once it reports interrupted', async () => {
    const { channel, context, executor } = setup({ cancelAfter: 1 });
    channel.script = (_read, c) => {
      if (
        c.published.some((command) => command.type === 'run.interrupt') &&
        c.events.length === 0
      ) {
        c.push({ data: { status: 'interrupted' }, seq: 1, type: 'terminal' });
      }
    };

    await expect(executor.execute(context)).resolves.toEqual({ kind: 'stopped' });
    expect(channel.published.map((command) => command.type)).toEqual([
      'run.start',
      'run.interrupt',
    ]);
  });

  it('on cancel stops after the interrupt wait when the runner never answers', async () => {
    const { channel, clock, context, executor } = setup({ cancelAfter: 1 });
    const start = clock.now().getTime();

    await expect(executor.execute(context)).resolves.toEqual({ kind: 'stopped' });
    expect(clock.now().getTime() - start).toBeGreaterThanOrEqual(TIMINGS.interruptWaitMs);
    expect(channel.published.at(-1)).toEqual({ runId: RUN, turn: 1, type: 'run.interrupt' });
  });

  it('fails transport when the runner never acknowledges run.start, though online', async () => {
    const { channel, clock, context, executor } = setup();
    const start = clock.now().getTime();

    const outcome = await executor.execute(context);

    expect(outcome).toMatchObject({
      failureClass: 'executor',
      kind: 'failed',
      localAgentFailure: { class: 'transport', origin: 'subscription', provider: 'claude' },
    });
    expect(reasonOf(outcome)).toBe(UNREACHABLE);
    expect(clock.now().getTime() - start).toBeGreaterThanOrEqual(TIMINGS.startAckMs);
    expect(clock.now().getTime() - start).toBeLessThan(TIMINGS.runIdleMs);
    expect(channel.published.at(-1)).toEqual({ runId: RUN, turn: 1, type: 'run.interrupt' });
  });

  it('fails a turn past the maximum duration, however busy and online the runner is', async () => {
    const { channel, clock, context, executor } = setup();
    const start = clock.now().getTime();
    let seq = 0;
    // A token every read: never idle, acknowledged at once, never finished.
    channel.script = (_read, c) => {
      seq += 1;
      c.push({ data: { text: '.' }, seq, type: 'text.delta' });
      clock.advance(TIMINGS.readBlockMs);
    };

    const outcome = await executor.execute(context);

    expect(outcome).toMatchObject({
      kind: 'failed',
      localAgentFailure: { class: 'provider', provider: 'claude' },
    });
    expect(reasonOf(outcome)).toContain('local-agent timeout');
    expect(clock.now().getTime() - start).toBeGreaterThanOrEqual(TIMINGS.maxRunMs);
    expect(channel.published.at(-1)).toMatchObject({ type: 'run.interrupt' });
  });

  it('fails transport when nothing arrives and the runner is gone for the idle timeout', async () => {
    const { channel, clock, context, executor } = setup();
    const start = clock.now().getTime();
    channel.script = (read, c) => {
      if (read === 1) c.push({ data: { text: 'hi' }, seq: 1, type: 'text.delta' });
      if (read === 2) c.online = false;
    };

    const outcome = await executor.execute(context);

    expect(outcome).toMatchObject({ failureClass: 'executor', kind: 'failed' });
    expect(reasonOf(outcome)).toBe(UNREACHABLE);
    expect(clock.now().getTime() - start).toBeGreaterThanOrEqual(TIMINGS.runIdleMs);
    expect(channel.published.at(-1)).toEqual({ runId: RUN, turn: 1, type: 'run.interrupt' });
  });

  it('keeps waiting past the idle timeout while the runner is online and acknowledged', async () => {
    const { channel, clock, context, executor } = setup();
    const start = clock.now().getTime();
    channel.script = (read, c) => {
      if (read === 1) c.push({ data: { text: 'hi' }, seq: 1, type: 'text.delta' });
      if (clock.now().getTime() - start > TIMINGS.runIdleMs * 2 && c.events.length === 1) {
        c.push(completed);
      }
    };

    await expect(executor.execute(context)).resolves.toEqual({ kind: 'awaiting_input' });
  });

  it.each([
    ['revoked', DISCONNECTED, 'policy'],
    ['over-budget', 'local-agent budget', 'provider'],
  ] as const)(
    'ends the run at once on a %s abort, interrupting the runner',
    async (reason, words, failureClass) => {
      const { channel, context, executor } = setup();
      channel.script = (read, c) => {
        if (read === 1) c.push({ data: { text: 'hi' }, seq: 1, type: 'text.delta' });
        if (read === 2) c.abort(reason);
      };

      const outcome = await executor.execute(context);

      expect(outcome).toMatchObject({
        kind: 'failed',
        localAgentFailure: { class: failureClass, provider: 'claude' },
      });
      expect(reasonOf(outcome)).toContain(words);
      expect(channel.published.at(-1)).toEqual({ runId: RUN, turn: 1, type: 'run.interrupt' });
    },
  );

  it('fails offline after the grace when the runner is not connected, sending nothing', async () => {
    const { channel, context, executor } = setup();
    channel.online = false;

    const outcome = await executor.execute(context);

    expect(outcome).toMatchObject({ failureClass: 'executor', kind: 'failed' });
    expect(reasonOf(outcome)).toBe(UNREACHABLE);
    expect(channel.published).toEqual([]);
  });

  describe('authorisation, re-checked on every attempt', () => {
    it('fails a run whose device is revoked, gone or now another person’s, sending nothing', async () => {
      for (const changed of [
        { id: DEVICE, name: 'Cloud agent home', revokedAt: new Date(0), userId: USER },
        { id: DEVICE, name: 'Cloud agent home', revokedAt: null, userId: 'someone-else' },
        undefined,
      ]) {
        const { channel, context, executor, homes, revoke } = setup();
        revoke(changed);

        const outcome = await executor.execute(context);

        expect(outcome).toMatchObject({
          kind: 'failed',
          localAgentFailure: { class: 'policy', origin: 'subscription', provider: 'claude' },
        });
        expect(reasonOf(outcome)).toBe(DISCONNECTED);
        expect(channel.published).toEqual([]);
        // Authority first: a revoked device never wakes (or pays for) a home.
        expect(homes.wake).not.toHaveBeenCalled();
      }
    });

    it('fails a run whose starter lost project:agent.run, in its own words, waking nothing', async () => {
      const { channel, context, executor, homes, setGranted } = setup();
      setGranted(new Set([scoped('project:read', 'project')]));

      const outcome = await executor.execute(context);

      expect(reasonOf(outcome)).toContain('local-agent access');
      expect(channel.published).toEqual([]);
      expect(homes.wake).not.toHaveBeenCalled();
    });

    it('notices a revocation at the idle check of a running turn', async () => {
      const { channel, context, executor, revoke } = setup();
      channel.script = (read, c) => {
        if (read === 1) c.push({ data: { text: 'hi' }, seq: 1, type: 'text.delta' });
        if (read === 2) {
          revoke({ id: DEVICE, name: 'Cloud agent home', revokedAt: new Date(0), userId: USER });
        }
      };

      const outcome = await executor.execute(context);

      expect(reasonOf(outcome)).toBe(DISCONNECTED);
      expect(channel.published.at(-1)).toMatchObject({ type: 'run.interrupt' });
    });
  });

  it('fails a turn whose CLI was signed out or removed since admission', async () => {
    const signedOut = setup();
    signedOut.channel.report = {
      ...REPORT,
      providers: [{ ...claude, auth: { ...claude.auth, status: 'unauthenticated' } }],
    };
    await expect(signedOut.executor.execute(signedOut.context)).resolves.toMatchObject({
      localAgentFailure: { class: 'auth', provider: 'claude' },
      reason: EXPIRED,
    });

    const removed = setup();
    removed.channel.report = { ...REPORT, providers: [] };
    await expect(removed.executor.execute(removed.context)).resolves.toMatchObject({
      localAgentFailure: { class: 'provider', provider: 'claude' },
    });
    expect(removed.channel.published).toEqual([]);
  });

  it('maps a signed-out CLI to a credential failure pointing to Settings', async () => {
    const { channel, context, executor } = setup();
    channel.script = (read, c) =>
      read === 1 &&
      c.push({
        data: { failure: { class: 'auth', message: 'not logged in' }, status: 'failed' },
        seq: 1,
        type: 'terminal',
      });

    const outcome = await executor.execute(context);

    expect(outcome).toMatchObject({
      failureClass: 'credential',
      kind: 'failed',
      localAgentFailure: { class: 'auth', origin: 'subscription', provider: 'claude' },
    });
    expect(reasonOf(outcome)).toBe(EXPIRED);
  });

  it('maps a usage limit to a credential failure carrying resetsAt', async () => {
    const { channel, context, executor } = setup();
    const resetsAt = '2026-11-02T05:00:00.000Z';
    channel.script = (read, c) =>
      read === 1 &&
      c.push({
        data: { failure: { class: 'usage_limit', message: 'limit', resetsAt }, status: 'failed' },
        seq: 1,
        type: 'terminal',
      });

    await expect(executor.execute(context)).resolves.toMatchObject({
      failureClass: 'credential',
      kind: 'failed',
      localAgentFailure: { class: 'usage_limit', provider: 'claude' },
      resetsAt: new Date(resetsAt),
    });
  });

  it('throws the consumer signal’s reason when the attempt is fenced', async () => {
    const { context, executor } = setup();
    const controller = new AbortController();
    const fenced = new Error('fenced');
    controller.abort(fenced);

    await expect(executor.execute({ ...context, signal: controller.signal })).rejects.toBe(fenced);
  });

  it('fails a run with no local target without touching the runner', async () => {
    const { channel, context, executor } = setup({ row: undefined });

    await expect(executor.execute(context)).resolves.toMatchObject({ kind: 'failed' });
    expect(channel.published).toEqual([]);
  });

  /** Spec 040's own-computer runs still in flight at the cut-over: failed, never run or woken. */
  describe('a retired local-agent run', () => {
    it.each([
      ['a workspace run', { row: target({ toolMode: 'workspace', workspaceId: 'ws1' }) }],
      ['a Codex run', { row: target({ provider: 'codex' }) }],
      [
        'a run on a device that is no agent home',
        { homes: { isHome: () => Promise.resolve(false) } },
      ],
    ] as const)('fails %s with a clear reason, touching nothing', async (_name, options) => {
      const { channel, context, executor, homes, lifecycle } = setup(options);

      const outcome = await executor.execute(context);

      expect(outcome).toMatchObject({ failureClass: 'executor', kind: 'failed' });
      expect(outcome).not.toHaveProperty('localAgentFailure');
      expect(reasonOf(outcome)).toMatch(/^local-agent retired: .*your own computer/);
      expect(channel.published).toEqual([]);
      expect(homes.wake).not.toHaveBeenCalled();
      expect(lifecycle.ensureReady).not.toHaveBeenCalled();
    });
  });

  describe('the sandbox tool bridge (spec 041)', () => {
    const call = (seq: number, name: string, input: Record<string, unknown>) =>
      ({ data: { callId: 'call-1', input, name }, seq, type: 'tool.call' }) as CompanionRunEvent;
    const results = (published: CompanionCommand[]) =>
      published.filter((command) => command.type === 'tool.result');

    it('readies the sandbox, offers the toolset, runs a tool.call as the cloud agent would, answers it and checkpoints the turn', async () => {
      const built = setup();
      const { channel, checkpoints, context, emitted, executor, files, lifecycle } = built;
      channel.script = (read, c) => {
        if (read !== 1) return;
        c.push(
          {
            data: { input: { path: 'a.ts' }, name: 'mcp__baios__fs_edit', toolId: 'cli-1' },
            seq: 1,
            type: 'tool.start',
          },
          call(2, 'fs_edit', { content: 'x', path: 'a.ts' }),
          { data: { chunk: 'done', toolId: 'cli-1' }, seq: 3, type: 'tool.output' },
          { data: { ok: true, summary: 'done', toolId: 'cli-1' }, seq: 4, type: 'tool.end' },
          { data: { text: 'Edited.' }, seq: 5, type: 'text.delta' },
          completed,
        );
      };

      await expect(executor.execute(context)).resolves.toEqual({ kind: 'awaiting_input' });

      expect(lifecycle.ensureReady).toHaveBeenCalledTimes(1);
      expect(checkpoints.ensureRepository).toHaveBeenCalledTimes(1);
      const start = channel.published[0] as Extract<CompanionCommand, { type: 'run.start' }>;
      expect(start.conversationKey).toBe(conversationKeyOf(ORG, 'project'));
      expect(start.toolset.map((tool) => tool.name)).toEqual([
        'fs_read',
        'fs_list',
        'fs_edit',
        'exec',
        'search',
        'find',
        'preview_status',
      ]);
      expect(start.toolset.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
      expect(files.get('a.ts')).toBe('x');
      expect(results(channel.published)).toEqual([
        { callId: 'call-1', ok: true, output: '+x', runId: RUN, turn: 1, type: 'tool.result' },
      ]);
      const step = `${RUN}/1`;
      // The CLI's own events for the bridged call are dropped: the server's are the record.
      expect(emitted).toEqual([
        {
          data: { input: { content: 'x', path: 'a.ts' }, stepId: step, tool: 'fs_edit' },
          type: 'tool.start',
        },
        { data: { ok: true, output: '+x', stepId: step }, type: 'tool.end' },
        { data: { diff: '+x', path: 'a.ts' }, type: 'file.patch' },
        { data: { text: 'Edited.' }, type: 'token' },
        { data: { checkpointId: 'cp-1', label: 'Turn 1' }, type: 'checkpoint' },
      ]);
      expect(checkpoints.commitTurn).toHaveBeenCalledWith(
        { orgId: ORG, projectId: 'project' },
        { leaseEpoch: 1, operationId: `${RUN}/checkpoint-1` },
        { runId: RUN, turn: 1 },
        {},
      );
    });

    it('refuses an input the tool schema rejects, without touching the sandbox', async () => {
      const { channel, context, emitted, executor, port } = setup();
      channel.script = (read, c) => {
        if (read === 1) c.push(call(1, 'fs_read', { nope: 1 }), completed);
      };

      await executor.execute(context);

      expect(port.read).not.toHaveBeenCalled();
      const [result] = results(channel.published);
      expect(result).toMatchObject({ isError: true, ok: false });
      expect((result as { output: string }).output).toMatch(/^kind: invalid-input\n/);
      expect(emitted).toContainEqual({
        data: { error: 'invalid-input', ok: false, stepId: `${RUN}/1` },
        type: 'tool.end',
      });
    });

    it('truncates an output past the cap with a marker', async () => {
      const { channel, context, executor, files } = setup();
      files.set('big.txt', 'y'.repeat(100_000));
      channel.script = (read, c) => {
        if (read === 1) c.push(call(1, 'fs_read', { path: 'big.txt' }), completed);
      };

      await executor.execute(context);

      const output = (results(channel.published)[0] as { output: string }).output;
      expect(output.length).toBeLessThanOrEqual(LOCAL_AGENT_MAX_TOOL_OUTPUT_CHARS);
      expect(output).toMatch(/\[output truncated: the first \d+ of 100000 characters are shown\]$/);
    });

    it('counts a long tool call as activity, so the idle check does not fail the run after it', async () => {
      const { channel, clock, context, executor, port } = setup();
      port.read.mockImplementationOnce(() => {
        clock.advance(TIMINGS.runIdleMs + 10_000);
        channel.online = false;
        return Promise.resolve('slow');
      });
      channel.script = (read, c) => {
        if (read === 1) c.push(call(1, 'fs_read', { path: 'README.md' }));
        if (read === 2) c.push(completed);
      };

      await expect(executor.execute(context)).resolves.toEqual({ kind: 'awaiting_input' });
      expect(results(channel.published)).toHaveLength(1);
    });

    it('ignores a tool call after the terminal event', async () => {
      const { channel, context, executor, port } = setup();
      channel.script = (read, c) => {
        if (read === 1) c.push(completed, call(100, 'fs_read', { path: 'README.md' }));
      };

      await executor.execute(context);

      expect(port.read).not.toHaveBeenCalled();
      expect(results(channel.published)).toEqual([]);
    });

    it('fails the run at the step bound and tells the runner to stop', async () => {
      const { channel, context, executor } = setup({
        run: { committed: { openStepId: null, pauses: 0, toolEnds: 50 } },
      });
      channel.script = (read, c) => {
        if (read === 1) c.push(call(1, 'fs_read', { path: 'README.md' }));
      };

      await expect(executor.execute(context)).resolves.toMatchObject({ reason: 'step-limit' });
      expect(channel.published.at(-1)).toMatchObject({ type: 'run.interrupt' });
    });
  });

  describe('subscription runs (spec 041)', () => {
    const run = { orgId: ORG, projectId: 'p', runId: RUN, userId: USER };

    it('records a connected home as a Claude run on its device', async () => {
      const { executor, repository } = setup();

      await executor.admitSubscription({} as never, run, { provider: 'claude' });

      expect(repository.insertRun).toHaveBeenCalledWith(
        {},
        { deviceId: DEVICE, orgId: ORG, provider: 'claude', runId: RUN },
      );
    });

    it('refuses a home that is missing or not signed in (409), and a deployment without homes (503)', async () => {
      const notConnected = setup({
        homes: { admissible: vi.fn(() => Promise.resolve(undefined)) },
      });
      await expect(
        notConnected.executor.admitSubscription({} as never, run, { provider: 'claude' }),
      ).rejects.toMatchObject({ type: 'subscription-not-connected' });
      expect(notConnected.repository.insertRun).not.toHaveBeenCalled();

      await expect(
        setup({ homes: { enabled: false } }).executor.admitSubscription({} as never, run, {
          provider: 'claude',
        }),
      ).rejects.toMatchObject({ type: 'subscription-unavailable' });
    });

    it('wakes the home first, and fails transport — in Settings words, origin subscription — when it cannot', async () => {
      const wake = vi.fn(() => Promise.resolve('failed'));
      const { context, executor, homes } = setup({ homes: { wake } });

      const outcome = await executor.execute(context);

      // Bounded by the run: its fence signal and its cancel check go with the wake.
      expect(wake).toHaveBeenCalledWith(DEVICE, {
        cancelled: expect.any(Function) as unknown,
        signal: context.signal,
      });
      expect(homes.touchDevice).toHaveBeenCalledWith(DEVICE);
      expect(outcome).toMatchObject({
        kind: 'failed',
        localAgentFailure: { class: 'transport', origin: 'subscription', provider: 'claude' },
      });
      expect(reasonOf(outcome)).toBe(UNREACHABLE);
    });

    it('stops at once when the run is cancelled while its home starts', async () => {
      const { context, executor } = setup({
        homes: { wake: vi.fn(() => Promise.resolve('cancelled')) },
      });

      await expect(executor.execute(context)).resolves.toEqual({ kind: 'stopped' });
    });
  });
});
