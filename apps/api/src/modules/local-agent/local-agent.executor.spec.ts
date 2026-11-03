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
  ApprovalDecision,
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
  approvalTimeoutMs: 5_000,
  cancelPollMs: 0,
  heartbeatMs: 15_000,
  interruptWaitMs: 10_000,
  maxRunMs: 600_000,
  offlineGraceMs: 10_000,
  pairingIntervalSeconds: 5,
  pairingTtlSeconds: 600,
  presenceTtlSeconds: 45,
  readBlockMs: 1_000,
  runEventBudgetBytes: 1_000_000,
  runIdleMs: 120_000,
  startAckMs: 30_000,
};

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
const REPORT: CompanionStatusReport = {
  companionVersion: '0.1.0',
  providers: [claude],
  workspaces: [{ id: 'ws1', label: 'app' }],
};

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
  readonly decisions: Entry<ApprovalDecision>[] = [];
  readonly aborts: Entry<RunAbortReason>[] = [];
  readonly approvalsHeld = new Map<string, number>();
  readonly begun: { turn: number; startedAt: number }[] = [];
  active: ActiveTurn | undefined;
  readonly readTurns = new Set<number>();
  reads = 0;
  saved: RunCursor | undefined;
  private control = 0;
  /** Called before each read: the test's script of what the companion and the person do. */
  script: (read: number, channel: FakeChannel) => void = () => undefined;

  constructor(private readonly clock: FakeClock) {}

  push(...events: CompanionRunEvent[]): void {
    for (const event of events) this.events.push({ id: `${String(event.seq)}-0`, value: event });
  }

  decide(decision: ApprovalDecision): void {
    this.decisions.push({ id: `${String((this.control += 1))}-0`, value: decision });
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
        const decisions = this.decisions
          .filter((entry) => after(entry.id, cursor.control))
          .map(({ id, value }) => ({ decision: value, id }));
        const aborts = this.aborts
          .filter((entry) => after(entry.id, cursor.control))
          .map(({ id, value }) => ({ id, reason: value }));
        if (events.length + decisions.length + aborts.length === 0) this.clock.advance(blockMs);
        return Promise.resolve({ aborts, decisions, events });
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
  addApproval = (_run: string, id: string, deadline: number) => {
    this.approvalsHeld.set(id, deadline);
    return Promise.resolve();
  };
  approvals = () => Promise.resolve(new Map(this.approvalsHeld));
  hasApproval = (_run: string, id: string) => Promise.resolve(this.approvalsHeld.has(id));
  resolveApproval = (_run: string, id: string) => Promise.resolve(this.approvalsHeld.delete(id));
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
    toolMode: 'workspace',
    updatedAt: new Date(0),
    workspaceId: 'ws1',
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
    /** 041: the agent-home service, for subscription admission and the wake path. */
    homes?: unknown;
  } = {},
) {
  const clock = new FakeClock('2026-11-02T00:00:00Z');
  const channel = new FakeChannel(clock);
  const row = 'row' in options ? options.row : target();
  let device: Device | undefined = { id: DEVICE, name: 'Laptop', revokedAt: null, userId: USER };
  let granted = new Set<string>([scoped('project:agent.run', 'project')]);
  const repository = {
    deviceOn: vi.fn(() => Promise.resolve(device)),
    insertRun: vi.fn(() => Promise.resolve()),
    runOn: vi.fn(() => Promise.resolve(row)),
  };
  const permissions = { for: vi.fn(() => Promise.resolve(granted)) };
  const config = { get: (key: string) => (key === 'LOCAL_AGENT_ENABLED' ? true : 'deny') };
  // 041: the project's sandbox, in memory — what the bridge's tool calls and checkpoints reach.
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
    options.homes as never,
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
  it('starts the turn on the device, maps the stream, persists the reply and awaits the person', async () => {
    const { channel, context, emitted, executor, persisted } = setup();
    channel.script = (read, c) => {
      if (read !== 1) return;
      c.push(
        { data: { providerSessionId: 'sess-1' }, seq: 1, type: 'session' },
        { data: { text: 'Hel' }, seq: 2, type: 'text.delta' },
        { data: { text: 'hmm' }, seq: 3, type: 'reasoning.delta' },
        { data: { input: { cmd: 'ls' }, name: 'Bash', toolId: 't1' }, seq: 4, type: 'tool.start' },
        { data: { chunk: 'a.ts\n', toolId: 't1' }, seq: 5, type: 'tool.output' },
        { data: { kind: 'modified', path: 'src/a.ts' }, seq: 6, type: 'file.change' },
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
      permissionMode: 'default',
      prompt: 'fix the tests',
      provider: 'claude',
      resume: null,
      runId: RUN,
      toolMode: 'workspace',
      turn: 1,
      type: 'run.start',
      workspaceId: 'ws1',
    });
    const step = `${RUN}/t1`;
    expect(emitted).toEqual([
      { data: { text: 'Hel' }, type: 'token' },
      { data: { text: 'hmm' }, type: 'thought' },
      { data: { input: { cmd: 'ls' }, stepId: step, tool: 'Bash' }, type: 'tool.start' },
      { data: { chunk: 'a.ts\n', stepId: step }, type: 'tool.delta' },
      { data: { chunk: 'modified src/a.ts\n', stepId: step }, type: 'tool.delta' },
      {
        data: { ok: true, output: { ok: false, summary: 'exit 1' }, stepId: step },
        type: 'tool.end',
      },
      { data: { text: 'lo' }, type: 'token' },
      { data: { costMicros: 0, inputTokens: 10, outputTokens: 5 }, type: 'usage' },
    ]);
    expect(persisted).toEqual(['Hello']);
    expect(channel.saved).toEqual({ control: '0-0', events: '99-0' });
    // The turn is closed: the uplink refuses its late retries from now on.
    expect(channel.active).toBeUndefined();
  });

  it('numbers a follow-up turn, reads only its stream, and asks for the run’s stored mode', async () => {
    const { channel, context, executor } = setup({
      row: target({ permissionMode: 'acceptEdits', providerSessionId: 'sess-1' }),
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
      permissionMode: 'acceptEdits',
      prompt: 'and lint',
      resume: { providerSessionId: 'sess-1' },
      turn: 2,
    });
  });

  it('opens the turn and sends run.start under the fence, so a stale attempt sends nothing', async () => {
    const { channel, context, dispatch, executor } = setup();
    const fenced = new Error('fenced');
    // The target read, the authorisation's device read, then the fenced open of the turn.
    dispatch
      .mockImplementationOnce((fn) => fn())
      .mockImplementationOnce((fn) => fn())
      .mockRejectedValueOnce(fenced);

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

  it('round-trips an approval: one durable request, one resolution by the person, the device answered', async () => {
    const { channel, context, emitted, executor, flush } = setup();
    const request = {
      detail: 'rm -rf dist',
      kind: 'command' as const,
      requestId: 'r1',
      title: 'Run a command',
    };
    channel.script = (read, c) => {
      if (read === 1) c.push({ data: request, seq: 1, type: 'approval.request' });
      // Repeated by the companion after a reconnect: still one durable request.
      if (read === 2) c.push({ data: request, seq: 2, type: 'approval.request' });
      if (read === 3) {
        c.decide({ decision: 'allow', requestId: 'r1' });
        c.decide({ decision: 'deny', requestId: 'r1' });
      }
      if (read === 4) c.push(completed);
    };

    await executor.execute(context);

    expect(emitted).toEqual([
      { data: request, type: 'approval.request' },
      { data: { by: 'user', decision: 'allow', requestId: 'r1' }, type: 'approval.resolved' },
    ]);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(channel.approvalsHeld.size).toBe(0);
    expect(channel.published.filter((command) => command.type === 'approval.respond')).toEqual([
      { decision: 'allow', requestId: 'r1', runId: RUN, type: 'approval.respond' },
    ]);
  });

  it('keeps a request a fenced attempt could not write, for the attempt that replaces it', async () => {
    const { channel, context, executor, flush } = setup();
    const fenced = new Error('fenced');
    flush.mockRejectedValueOnce(fenced);
    channel.script = (read, c) => {
      if (read === 1) {
        c.push({
          data: { detail: 'x', kind: 'tool', requestId: 'r1', title: 'Use a tool' },
          seq: 1,
          type: 'approval.request',
        });
      }
      if (read === 2) c.decide({ decision: 'allow', requestId: 'r1' });
    };

    await expect(executor.execute(context)).rejects.toBe(fenced);
    // Still waiting in Redis, and the stale attempt did not answer the device.
    expect([...channel.approvalsHeld.keys()]).toEqual(['r1']);
    expect(channel.published.map((command) => command.type)).toEqual(['run.start']);
  });

  it('denies an approval nobody answered in time', async () => {
    const { channel, clock, context, emitted, executor } = setup();
    const start = clock.now().getTime();
    channel.script = (read, c) => {
      if (read === 1) {
        c.push({
          data: { detail: 'x', kind: 'tool', requestId: 'r1', title: 'Use a tool' },
          seq: 1,
          type: 'approval.request',
        });
      }
      if (
        clock.now().getTime() - start > TIMINGS.approvalTimeoutMs + 2_000 &&
        c.events.length === 1
      ) {
        c.push(completed);
      }
    };

    await executor.execute(context);

    expect(emitted.at(-1)).toEqual({
      data: { by: 'timeout', decision: 'deny', requestId: 'r1' },
      type: 'approval.resolved',
    });
    expect(channel.published).toContainEqual(
      expect.objectContaining({ decision: 'deny', requestId: 'r1', type: 'approval.respond' }),
    );
  });

  it('resolves what is still pending as run-ended when the run ends', async () => {
    const { channel, context, emitted, executor } = setup();
    channel.script = (read, c) => {
      if (read !== 1) return;
      c.push(
        {
          data: { detail: 'x', kind: 'file_change', requestId: 'r9', title: 'Edit' },
          seq: 1,
          type: 'approval.request',
        },
        { data: { status: 'interrupted' }, seq: 2, type: 'terminal' },
      );
    };

    await expect(executor.execute(context)).resolves.toEqual({ kind: 'stopped' });
    expect(emitted.at(-1)).toEqual({
      data: { by: 'run-ended', decision: 'deny', requestId: 'r9' },
      type: 'approval.resolved',
    });
  });

  it('on cancel interrupts the device and stops once it reports interrupted', async () => {
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

  it('on cancel stops after the interrupt wait when the device never answers', async () => {
    const { channel, clock, context, executor } = setup({ cancelAfter: 1 });
    const start = clock.now().getTime();

    await expect(executor.execute(context)).resolves.toEqual({ kind: 'stopped' });
    expect(clock.now().getTime() - start).toBeGreaterThanOrEqual(TIMINGS.interruptWaitMs);
    expect(channel.published.at(-1)).toEqual({ runId: RUN, turn: 1, type: 'run.interrupt' });
  });

  it('fails transport when the companion never acknowledges run.start, though online', async () => {
    const { channel, clock, context, executor } = setup();
    const start = clock.now().getTime();

    const outcome = await executor.execute(context);

    expect(outcome).toMatchObject({
      failureClass: 'executor',
      kind: 'failed',
      localAgentFailure: { class: 'transport', provider: 'claude' },
    });
    expect(reasonOf(outcome)).toContain('baios-companion start');
    expect(clock.now().getTime() - start).toBeGreaterThanOrEqual(TIMINGS.startAckMs);
    expect(clock.now().getTime() - start).toBeLessThan(TIMINGS.runIdleMs);
    expect(channel.published.at(-1)).toEqual({ runId: RUN, turn: 1, type: 'run.interrupt' });
  });

  it('fails a turn past the maximum duration, however busy and online the device is', async () => {
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

  it('fails transport when nothing arrives and the device is gone for the idle timeout', async () => {
    const { channel, clock, context, executor } = setup();
    const start = clock.now().getTime();
    channel.script = (read, c) => {
      if (read === 1) c.push({ data: { text: 'hi' }, seq: 1, type: 'text.delta' });
      if (read === 2) c.online = false;
    };

    const outcome = await executor.execute(context);

    expect(outcome).toMatchObject({ failureClass: 'executor', kind: 'failed' });
    expect(reasonOf(outcome)).toContain('baios-companion start');
    expect(clock.now().getTime() - start).toBeGreaterThanOrEqual(TIMINGS.runIdleMs);
    expect(channel.published.at(-1)).toEqual({ runId: RUN, turn: 1, type: 'run.interrupt' });
  });

  it('keeps waiting past the idle timeout while the device is online and acknowledged', async () => {
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
    ['revoked', 'local-agent revoked', 'policy'],
    ['over-budget', 'local-agent budget', 'provider'],
  ] as const)(
    'ends the run at once on a %s abort, interrupting the device',
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

  it('fails offline after the grace when the device is not connected, sending nothing', async () => {
    const { channel, context, executor } = setup();
    channel.online = false;

    const outcome = await executor.execute(context);

    expect(outcome).toMatchObject({ failureClass: 'executor', kind: 'failed' });
    expect(reasonOf(outcome)).toContain('baios-companion start');
    expect(channel.published).toEqual([]);
  });

  describe('authorisation, re-checked on every attempt', () => {
    it('fails a run whose device is revoked, gone or now another person’s, sending nothing', async () => {
      for (const changed of [
        { id: DEVICE, name: 'Laptop', revokedAt: new Date(0), userId: USER },
        { id: DEVICE, name: 'Laptop', revokedAt: null, userId: 'someone-else' },
        undefined,
      ]) {
        const { channel, context, executor, revoke } = setup();
        revoke(changed);

        const outcome = await executor.execute(context);

        expect(outcome).toMatchObject({
          kind: 'failed',
          localAgentFailure: { class: 'policy', provider: 'claude' },
        });
        expect(reasonOf(outcome)).toContain('local-agent revoked');
        expect(channel.published).toEqual([]);
      }
    });

    it('fails a run whose starter lost project:agent.run', async () => {
      const { channel, context, executor, setGranted } = setup();
      setGranted(new Set([scoped('project:read', 'project')]));

      const outcome = await executor.execute(context);

      expect(reasonOf(outcome)).toContain('local-agent access');
      expect(channel.published).toEqual([]);
    });

    it('notices a revocation at the idle check of a running turn', async () => {
      const { channel, context, executor, revoke } = setup();
      channel.script = (read, c) => {
        if (read === 1) c.push({ data: { text: 'hi' }, seq: 1, type: 'text.delta' });
        if (read === 2) {
          revoke({ id: DEVICE, name: 'Laptop', revokedAt: new Date(0), userId: USER });
        }
      };

      const outcome = await executor.execute(context);

      expect(reasonOf(outcome)).toContain('local-agent revoked');
      expect(channel.published.at(-1)).toMatchObject({ type: 'run.interrupt' });
    });
  });

  describe('the CLI, re-checked against the policy on every turn', () => {
    it('fails a Codex turn on a ChatGPT plan where that is denied, sending nothing', async () => {
      const { channel, context, executor } = setup({ row: target({ provider: 'codex' }) });
      channel.report = {
        ...REPORT,
        providers: [{ ...claude, auth: { ...claude.auth, plan: 'Plus' }, provider: 'codex' }],
      };

      const outcome = await executor.execute(context);

      expect(outcome).toMatchObject({
        kind: 'failed',
        localAgentFailure: { class: 'policy', provider: 'codex' },
      });
      expect(reasonOf(outcome)).toContain('ChatGPT plan');
      expect(channel.published).toEqual([]);
    });

    it('fails a turn whose CLI was signed out or removed since admission', async () => {
      const signedOut = setup();
      signedOut.channel.report = {
        ...REPORT,
        providers: [{ ...claude, auth: { ...claude.auth, status: 'unauthenticated' } }],
      };
      await expect(signedOut.executor.execute(signedOut.context)).resolves.toMatchObject({
        localAgentFailure: { class: 'auth', provider: 'claude' },
      });

      const removed = setup();
      removed.channel.report = { ...REPORT, providers: [] };
      await expect(removed.executor.execute(removed.context)).resolves.toMatchObject({
        localAgentFailure: { class: 'provider', provider: 'claude' },
      });
      expect(removed.channel.published).toEqual([]);
    });
  });

  it('maps a signed-out CLI to a credential failure naming the login command', async () => {
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
      localAgentFailure: { class: 'auth', provider: 'claude' },
    });
    expect(reasonOf(outcome)).toContain('baios-companion login claude');
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

  it('fails a run with no local target without touching the device', async () => {
    const { channel, context, executor } = setup({ row: undefined });

    await expect(executor.execute(context)).resolves.toMatchObject({ kind: 'failed' });
    expect(channel.published).toEqual([]);
  });

  describe('the sandbox tool bridge (spec 041)', () => {
    const sandboxRow = () => target({ toolMode: 'sandbox', workspaceId: null });
    const call = (seq: number, name: string, input: Record<string, unknown>) =>
      ({ data: { callId: 'call-1', input, name }, seq, type: 'tool.call' }) as CompanionRunEvent;
    const results = (published: CompanionCommand[]) =>
      published.filter((command) => command.type === 'tool.result');

    it('readies the sandbox, offers the toolset, runs a tool.call as the cloud agent would, answers it and checkpoints the turn', async () => {
      const built = setup({ row: sandboxRow() });
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
      expect(start).toMatchObject({
        conversationKey: conversationKeyOf(ORG, 'project'),
        toolMode: 'sandbox',
        workspaceId: null,
      });
      expect(start.toolset?.map((tool) => tool.name)).toEqual([
        'fs_read',
        'fs_list',
        'fs_edit',
        'exec',
        'search',
        'find',
        'preview_status',
      ]);
      expect(start.toolset?.every((tool) => tool.inputSchema.type === 'object')).toBe(true);
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
      const { channel, context, emitted, executor, port } = setup({ row: sandboxRow() });
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
      const { channel, context, executor, files } = setup({ row: sandboxRow() });
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
      const { channel, clock, context, executor, port } = setup({ row: sandboxRow() });
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
      const { channel, context, executor, port } = setup({ row: sandboxRow() });
      channel.script = (read, c) => {
        if (read === 1) c.push(completed, call(100, 'fs_read', { path: 'README.md' }));
      };

      await executor.execute(context);

      expect(port.read).not.toHaveBeenCalled();
      expect(results(channel.published)).toEqual([]);
    });

    it('fails the run at the step bound and tells the device to stop', async () => {
      const { channel, context, executor } = setup({
        row: sandboxRow(),
        run: { committed: { openStepId: null, pauses: 0, toolEnds: 50 } },
      });
      channel.script = (read, c) => {
        if (read === 1) c.push(call(1, 'fs_read', { path: 'README.md' }));
      };

      await expect(executor.execute(context)).resolves.toMatchObject({ reason: 'step-limit' });
      expect(channel.published.at(-1)).toMatchObject({ type: 'run.interrupt' });
    });

    it('denies an approval request at once, asking no one', async () => {
      const { channel, context, emitted, executor } = setup({ row: sandboxRow() });
      channel.script = (read, c) => {
        if (read !== 1) return;
        c.push(
          {
            data: { detail: 'x', kind: 'command', requestId: 'r1', title: 'Run' },
            seq: 1,
            type: 'approval.request',
          },
          completed,
        );
      };

      await executor.execute(context);

      expect(emitted.some((event) => event.type === 'approval.request')).toBe(false);
      expect(channel.published).toContainEqual(
        expect.objectContaining({ decision: 'deny', requestId: 'r1', type: 'approval.respond' }),
      );
    });

    it('answers a tool.call on a workspace run with a refusal, and runs nothing', async () => {
      const { channel, context, executor, lifecycle, port } = setup();
      channel.script = (read, c) => {
        if (read === 1) c.push(call(1, 'fs_read', { path: 'README.md' }), completed);
      };

      await executor.execute(context);

      expect(lifecycle.ensureReady).not.toHaveBeenCalled();
      expect(port.read).not.toHaveBeenCalled();
      expect(results(channel.published)).toEqual([
        expect.objectContaining({ isError: true, ok: false }),
      ]);
    });
  });

  describe('admit', () => {
    const run = { orgId: ORG, projectId: 'p', runId: RUN, userId: USER };
    const device = { id: DEVICE, name: 'Laptop', revokedAt: null, userId: USER };
    const runTarget = { deviceId: DEVICE, provider: 'claude' as const, workspaceId: 'ws1' };

    function admitting(found: unknown, status: CompanionStatusReport | undefined = REPORT) {
      const built = setup();
      built.repository.deviceOn.mockResolvedValue(found as Device);
      built.channel.report = status;
      return built;
    }

    it('records the target with the requested permission mode, default when none', async () => {
      const { executor, repository } = admitting(device);

      await executor.admit({} as never, run, runTarget);
      await executor.admit({} as never, run, { ...runTarget, permissionMode: 'plan' });

      expect(repository.insertRun).toHaveBeenNthCalledWith(
        1,
        {},
        {
          deviceId: DEVICE,
          orgId: ORG,
          permissionMode: 'default',
          provider: 'claude',
          runId: RUN,
          toolMode: 'workspace',
          workspaceId: 'ws1',
        },
      );
      expect(repository.insertRun).toHaveBeenNthCalledWith(
        2,
        {},
        expect.objectContaining({ permissionMode: 'plan' }),
      );
    });

    it('refuses another person’s device, and a revoked one, as unknown', async () => {
      await expect(
        admitting({ ...device, userId: 'someone-else' }).executor.admit(
          {} as never,
          run,
          runTarget,
        ),
      ).rejects.toMatchObject({ type: 'not-found' });
      await expect(
        admitting({ ...device, revokedAt: new Date() }).executor.admit({} as never, run, runTarget),
      ).rejects.toMatchObject({ type: 'not-found' });
    });

    it('refuses an offline device', async () => {
      const { channel, executor } = admitting(device);
      channel.online = false;

      await expect(executor.admit({} as never, run, runTarget)).rejects.toMatchObject({
        type: 'local-agent-offline',
      });
    });

    it('refuses a CLI that is signed out, missing, or on a sign-in the policy blocks', async () => {
      const cases: [LocalAgentProviderStatus[], 'claude' | 'codex'][] = [
        [[], 'claude'],
        [[{ ...claude, auth: { ...claude.auth, status: 'unauthenticated' } }], 'claude'],
        [[{ ...claude, provider: 'codex' }], 'codex'],
      ];

      for (const [providers, provider] of cases) {
        await expect(
          admitting(device, { ...REPORT, providers }).executor.admit({} as never, run, {
            ...runTarget,
            provider,
          }),
        ).rejects.toMatchObject({ type: 'local-agent-provider-unavailable' });
      }
    });

    it('admits a target with no workspace as the sandbox tool mode, whatever workspaces exist', async () => {
      const { executor, repository } = admitting(device, { ...REPORT, workspaces: [] });

      await executor.admit({} as never, run, { deviceId: DEVICE, provider: 'claude' });

      expect(repository.insertRun).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ toolMode: 'sandbox', workspaceId: null }),
      );
    });

    it('refuses Codex in the sandbox tool mode (Claude only), before anything is recorded', async () => {
      const { executor, repository } = admitting(device, {
        ...REPORT,
        providers: [{ ...claude, provider: 'codex' }],
      });

      await expect(
        executor.admit({} as never, run, { deviceId: DEVICE, provider: 'codex' }),
      ).rejects.toMatchObject({ type: 'validation-failed' });
      expect(repository.insertRun).not.toHaveBeenCalled();
    });

    it('refuses an agent home as a localAgent target (422, naming nothing of it)', async () => {
      const { executor, repository } = admitting({ ...device, kind: 'cloud' });

      const refused = executor.admit({} as never, run, { deviceId: DEVICE, provider: 'claude' });

      await expect(refused).rejects.toMatchObject({ type: 'validation-failed' });
      await expect(refused).rejects.not.toHaveProperty('extensions.deviceId');
      expect(repository.insertRun).not.toHaveBeenCalled();
    });

    it('refuses a workspace the device did not report', async () => {
      await expect(
        admitting(device).executor.admit({} as never, run, { ...runTarget, workspaceId: 'other' }),
      ).rejects.toMatchObject({ type: 'local-agent-workspace-unknown' });
    });
  });

  describe('subscription runs (spec 041)', () => {
    const run = { orgId: ORG, projectId: 'p', runId: RUN, userId: USER };
    const homeRow = { deviceId: DEVICE, state: 'stopped' };

    function withHomes(homes: Record<string, unknown>) {
      return setup({
        homes: { enabled: true, touchDevice: vi.fn(() => Promise.resolve()), ...homes },
      });
    }

    it('records a connected home as a sandbox-tool-mode Claude run on its device', async () => {
      const { executor, repository } = withHomes({
        admissible: vi.fn(() => Promise.resolve(homeRow)),
      });

      await executor.admitSubscription({} as never, run, { provider: 'claude' });

      expect(repository.insertRun).toHaveBeenCalledWith(
        {},
        {
          deviceId: DEVICE,
          orgId: ORG,
          permissionMode: 'default',
          provider: 'claude',
          runId: RUN,
          toolMode: 'sandbox',
          workspaceId: null,
        },
      );
    });

    it('refuses a home that is missing or not signed in (409), and a deployment without homes (503)', async () => {
      const notConnected = withHomes({ admissible: vi.fn(() => Promise.resolve(undefined)) });
      await expect(
        notConnected.executor.admitSubscription({} as never, run, { provider: 'claude' }),
      ).rejects.toMatchObject({ type: 'subscription-not-connected' });
      expect(notConnected.repository.insertRun).not.toHaveBeenCalled();

      await expect(
        setup({ homes: { enabled: false } }).executor.admitSubscription({} as never, run, {
          provider: 'claude',
        }),
      ).rejects.toMatchObject({ type: 'subscription-unavailable' });
      await expect(
        setup().executor.admitSubscription({} as never, run, { provider: 'claude' }),
      ).rejects.toMatchObject({ type: 'subscription-unavailable' });
    });

    it('wakes the home first, and fails transport — in Settings words, origin subscription — when it cannot', async () => {
      const wake = vi.fn(() => Promise.resolve('failed'));
      const touchDevice = vi.fn(() => Promise.resolve());
      const { context, executor } = withHomes({
        isHome: () => Promise.resolve(true),
        touchDevice,
        wake,
      });

      const outcome = await executor.execute(context);

      // Bounded by the run: its fence signal and its cancel check go with the wake.
      expect(wake).toHaveBeenCalledWith(DEVICE, {
        cancelled: expect.any(Function) as unknown,
        signal: context.signal,
      });
      expect(touchDevice).toHaveBeenCalledWith(DEVICE);
      expect(outcome).toMatchObject({
        kind: 'failed',
        localAgentFailure: { class: 'transport', origin: 'subscription', provider: 'claude' },
      });
      expect(reasonOf(outcome)).toBe(
        'Your cloud workspace could not be reached — try again in a minute.',
      );
    });

    it('re-authorises before waking: a revoked device or a starter who lost access starts nothing', async () => {
      const wake = vi.fn(() => Promise.resolve('online'));
      const revoked = withHomes({ isHome: () => Promise.resolve(true), wake });
      revoked.revoke(undefined);

      expect(await revoked.executor.execute(revoked.context)).toMatchObject({
        kind: 'failed',
        localAgentFailure: { origin: 'subscription' },
      });

      const demoted = withHomes({ isHome: () => Promise.resolve(true), wake });
      demoted.setGranted(new Set());
      expect(await demoted.executor.execute(demoted.context)).toMatchObject({ kind: 'failed' });
      expect(wake).not.toHaveBeenCalled();
    });

    it('stops at once when the run is cancelled while its home starts', async () => {
      const { context, executor } = withHomes({
        isHome: () => Promise.resolve(true),
        wake: vi.fn(() => Promise.resolve('cancelled')),
      });

      await expect(executor.execute(context)).resolves.toEqual({ kind: 'stopped' });
    });

    it('stamps a person’s own device as origin device and keeps its companion guidance', async () => {
      const wake = vi.fn(() => Promise.resolve('online'));
      const { channel, context, executor } = withHomes({
        isHome: () => Promise.resolve(false),
        wake,
      });
      channel.online = false;

      const outcome = await executor.execute(context);

      expect(outcome).toMatchObject({ localAgentFailure: { origin: 'device' } });
      expect(reasonOf(outcome)).toMatch(/baios-companion start/);
      expect(wake).not.toHaveBeenCalled();
    });
  });
});
