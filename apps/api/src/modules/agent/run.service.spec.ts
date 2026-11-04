import { OPTIONAL_DEPS_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import { usageRunListResponseSchema } from '@repo/contracts';
import type { AgentRun } from '@repo/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { Environment } from '../../config/environment';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import type { TenantContext } from '../../database/tenant-context';
import type { AuditService } from '../audit/audit.service';
import type { CheckpointService } from '../checkpoints/checkpoint.service';
import type { OutboxWriter } from '../outbox/outbox-writer';
import type { ProjectService } from '../tenancy/services/project.service';
import type { CredentialResolver, ResolutionKind } from './byok/credential-resolver';
import type { RunControl } from './run-control';
import { RUN_LINE_LIMIT } from './agent.constants';
import { RunExecutorRegistry } from './run-executor-registry';
import { RunService } from './run.service';
import type { RunStore } from './run-store';
import type { RunStreamPublisher } from './run-stream-publisher';

const START = '2026-09-14T10:00:00.000Z';
const ORG = 'c1000000-0000-4000-8000-000000000001';
const PROJECT = 'c1000000-0000-4000-8000-000000000002';
const USER = 'c1000000-0000-4000-8000-000000000003';
const RUN = 'c1000000-0000-4000-8000-000000000004';

const tx = { tag: 'tx' } as unknown as TenantTransaction;

function row(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cancelRequestedAt: null,
    contextSkips: [],
    costMicros: 0,
    createdAt: new Date(START),
    credentialChoice: null,
    credentialMode: 'PLATFORM',
    endedAt: null,
    failureClass: null,
    id: RUN,
    inputTokens: 0,
    leaseEpoch: 0,
    leaseOwner: null,
    leaseUntil: null,
    model: 'claude-sonnet-5',
    nextSeq: 1,
    orgId: ORG,
    outputTokens: 0,
    projectId: PROJECT,
    startedAt: null,
    status: 'queued',
    summary: null,
    summaryThroughMessageId: null,
    summaryTokens: 0,
    updatedAt: new Date(START),
    userId: USER,
    ...overrides,
  };
}

/**
 * The request side over fakes: the order and content of the writes on create, and the `404`
 * collapse on reads. The e2e suite proves the same over HTTP and real Postgres.
 */
describe('RunService', () => {
  let store: Record<
    | 'allocateSeq'
    | 'appendEvents'
    | 'holder'
    | 'insertMessage'
    | 'insertRun'
    | 'line'
    | 'listRuns'
    | 'listUsage'
    | 'readEvents'
    | 'readExcerpt'
    | 'readRun'
    | 'requestCancel'
    | 'setModel'
    | 'transition'
    | 'waitingRun',
    ReturnType<typeof vi.fn>
  >;
  let projects: { read: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let outbox: { append: ReturnType<typeof vi.fn> };
  let control: { publish: ReturnType<typeof vi.fn> };
  let publisher: { sync: ReturnType<typeof vi.fn> };
  let resolver: { forModel: ReturnType<typeof vi.fn>; kindOnly: ReturnType<typeof vi.fn> };
  let afterCommit: (() => Promise<void>)[];
  let service: RunService;
  let clock: FakeClock;
  let checkpoints: { lockProject: ReturnType<typeof vi.fn> };
  let registry: RunExecutorRegistry;

  beforeEach(() => {
    clock = new FakeClock(START);
    store = {
      allocateSeq: vi.fn(() => Promise.resolve(1)),
      appendEvents: vi.fn(() => Promise.resolve()),
      holder: vi.fn(() => Promise.resolve(undefined)),
      insertMessage: vi.fn(() => Promise.resolve({ id: 'm1' })),
      insertRun: vi.fn(() => Promise.resolve(row())),
      listRuns: vi.fn(() =>
        Promise.resolve({
          nextCursor: 'Y3Vyc29y',
          runs: [
            { ...row({ nextSeq: 13, status: 'succeeded' }), promptExcerpt: 'Build the page' },
            { ...row(), promptExcerpt: '' },
          ],
        }),
      ),
      readEvents: vi.fn(() =>
        Promise.resolve([
          {
            at: new Date(START),
            data: { from: null, to: 'queued' },
            orgId: ORG,
            runId: RUN,
            seq: 1,
            type: 'state',
          },
        ]),
      ),
      listUsage: vi.fn(() => Promise.resolve({ nextCursor: null, runs: [] })),
      readExcerpt: vi.fn(() => Promise.resolve('Build a todo app')),
      readRun: vi.fn(() => Promise.resolve(row({ nextSeq: 5 }))),
      requestCancel: vi.fn(() => Promise.resolve({ first: true, status: 'running' })),
      setModel: vi.fn(() => Promise.resolve()),
      transition: vi.fn(() => Promise.resolve()),
      line: vi.fn(() => Promise.resolve([])),
      waitingRun: vi.fn(() => Promise.resolve(undefined)),
    };
    checkpoints = { lockProject: vi.fn(() => Promise.resolve()) };
    projects = { read: vi.fn(() => Promise.resolve({ createdAt: START, id: PROJECT, name: 'P' })) };
    audit = { record: vi.fn(() => Promise.resolve()) };
    outbox = { append: vi.fn(() => Promise.resolve({ eventId: 'e1' })) };
    control = { publish: vi.fn(() => Promise.resolve()) };
    publisher = { sync: vi.fn(() => Promise.resolve(1)) };
    resolver = {
      forModel: vi.fn(() => Promise.reject(new Error('the plaintext must not be opened here'))),
      kindOnly: vi.fn((): Promise<ResolutionKind> => Promise.resolve({ kind: 'byok' })),
    };
    afterCommit = [];
    registry = new RunExecutorRegistry();
    vi.spyOn(registry, 'isLocal').mockResolvedValue(false);
    service = new RunService(
      {
        onCommit: (hook: () => Promise<void>) => afterCommit.push(hook),
        tx,
      } as unknown as TenantContext,
      store as unknown as RunStore,
      projects as unknown as ProjectService,
      audit as unknown as AuditService,
      outbox as unknown as OutboxWriter,
      control as unknown as RunControl,
      clock,
      { get: () => 'claude-sonnet-5' } as unknown as ConfigService<Environment, true>,
      publisher as unknown as RunStreamPublisher,
      resolver as unknown as CredentialResolver,
      checkpoints as unknown as CheckpointService,
      registry,
    );
  });

  describe('create', () => {
    it('writes the row, the prompt, seq 1, the audit row and the outbox row on the request transaction', async () => {
      const response = await service.create(ORG, PROJECT, USER, 'build me a todo app');

      expect(projects.read).toHaveBeenCalledWith(ORG, PROJECT);
      expect(store.insertRun).toHaveBeenCalledWith(tx, {
        credentialMode: 'BYOK',
        model: 'claude-sonnet-5',
        orgId: ORG,
        projectId: PROJECT,
        userId: USER,
      });
      expect(store.insertMessage).toHaveBeenCalledWith(tx, {
        content: 'build me a todo app',
        orgId: ORG,
        role: 'user',
        runId: RUN,
      });
      expect(store.allocateSeq).toHaveBeenCalledWith(tx, { orgId: ORG, runId: RUN }, 1);
      expect(store.appendEvents).toHaveBeenCalledWith(tx, { orgId: ORG, runId: RUN }, [
        { at: clock.now(), data: { from: null, to: 'queued' }, seq: 1, type: 'state' },
      ]);
      expect(audit.record).toHaveBeenCalledWith(tx, {
        action: 'agent-run.created',
        actorId: USER,
        metadata: { model: 'claude-sonnet-5', projectId: PROJECT },
        orgId: ORG,
        target: RUN,
      });
      expect(outbox.append).toHaveBeenCalledWith(tx, {
        aggregateId: RUN,
        orgId: ORG,
        payload: { orgId: ORG, projectId: PROJECT, runId: RUN },
        type: 'agent-run.requested',
      });
      expect(response).toEqual({
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cancelRequestedAt: null,
        contextSkips: [],
        createdAt: START,
        endedAt: null,
        failureClass: null,
        id: RUN,
        inputTokens: 0,
        lastSeq: 1,
        model: 'claude-sonnet-5',
        outputTokens: 0,
        projectId: PROJECT,
        promptExcerpt: '',
        startedAt: null,
        status: 'queued',
        userId: USER,
      });
    });

    /** Spec 009 research R1: seq 1 reaches the stream once it is committed, never before. */
    it('syncs the stream after commit, once the outbox row is written', async () => {
      await service.create(ORG, PROJECT, USER, 'build me a todo app');

      expect(publisher.sync).not.toHaveBeenCalled();
      expect(afterCommit).toHaveLength(1);

      for (const hook of afterCommit) {
        await hook();
      }

      expect(publisher.sync).toHaveBeenCalledWith(ORG, RUN);
      expect(outbox.append.mock.invocationCallOrder[0]).toBeLessThan(
        publisher.sync.mock.invocationCallOrder[0]!,
      );
    });

    it('writes nothing when the project is not live', async () => {
      projects.read.mockRejectedValueOnce(new NotFoundError('No such project.'));

      await expect(service.create(ORG, PROJECT, USER, 'x')).rejects.toThrow(NotFoundError);

      expect(store.insertRun).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('records the chosen model on the row', async () => {
      await service.create(ORG, PROJECT, USER, 'build me a todo app', 'claude-haiku-4-5');

      expect(store.insertRun).toHaveBeenCalledWith(tx, {
        credentialMode: 'BYOK',
        model: 'claude-haiku-4-5',
        orgId: ORG,
        projectId: PROJECT,
        userId: USER,
      });
      expect(audit.record).toHaveBeenCalledWith(tx, {
        action: 'agent-run.created',
        actorId: USER,
        metadata: { model: 'claude-haiku-4-5', projectId: PROJECT },
        orgId: ORG,
        target: RUN,
      });
    });

    it('falls back to the configured default', async () => {
      await service.create(ORG, PROJECT, USER, 'build me a todo app');

      expect(store.insertRun).toHaveBeenCalledWith(tx, {
        credentialMode: 'BYOK',
        model: 'claude-sonnet-5',
        orgId: ORG,
        projectId: PROJECT,
        userId: USER,
      });
    });

    it('stamps BYOS when the starter’s own subscription pays (never the retired PLATFORM)', async () => {
      resolver.kindOnly.mockResolvedValueOnce({ kind: 'byos' });

      await service.create(ORG, PROJECT, USER, 'build me a todo app');

      expect(store.insertRun).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ credentialMode: 'BYOS' }),
      );
    });

    it('refuses an unlisted model before writing', async () => {
      resolver.kindOnly.mockResolvedValueOnce({ kind: 'unknown-model' });

      await expect(
        service.create(ORG, PROJECT, USER, 'build me a todo app', 'gpt-4'),
      ).rejects.toMatchObject({ extensions: { model: 'gpt-4' }, type: 'validation-failed' });

      expect(resolver.kindOnly).toHaveBeenCalledWith(tx, ORG, USER, 'gpt-4', {});
      expect(projects.read).not.toHaveBeenCalled();
      expect(store.insertRun).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    /** No key and no subscription: platform credits are retired, so nothing pays for the run. */
    it('refuses a run nothing can pay for as subscription-not-connected, before any write', async () => {
      resolver.kindOnly.mockResolvedValueOnce({ kind: 'no-credential', provider: 'anthropic' });

      await expect(
        service.create(ORG, PROJECT, USER, 'build me a todo app', 'claude-sonnet-5'),
      ).rejects.toMatchObject({
        extensions: { model: 'claude-sonnet-5', provider: 'anthropic' },
        type: 'subscription-not-connected',
      });

      expect(projects.read).not.toHaveBeenCalled();
      expect(store.insertRun).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('refuses a needs_reauth key as conflict naming the provider and the last four, before any write', async () => {
      resolver.kindOnly.mockResolvedValueOnce({
        kind: 'needs_reauth',
        lastFour: 'k3y4',
        provider: 'anthropic',
      });

      await expect(
        service.create(ORG, PROJECT, USER, 'build me a todo app', 'claude-sonnet-5'),
      ).rejects.toMatchObject({
        extensions: { keyLastFour: 'k3y4', provider: 'anthropic', reason: 'needs-reauth' },
        type: 'conflict',
      });

      expect(projects.read).not.toHaveBeenCalled();
      expect(store.insertRun).not.toHaveBeenCalled();
    });

    it('refuses a subscription needing reconnection as conflict, before any write (032)', async () => {
      resolver.kindOnly.mockResolvedValueOnce({
        accountLabel: 'ada@example.com',
        kind: 'subscription-needs-reauth',
        provider: 'openai',
      });

      await expect(
        service.create(ORG, PROJECT, USER, 'build me a todo app', 'gpt-5.2'),
      ).rejects.toMatchObject({
        extensions: { provider: 'openai', reason: 'subscription-needs-reauth' },
        type: 'conflict',
      });

      expect(projects.read).not.toHaveBeenCalled();
      expect(store.insertRun).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('refuses a limited subscription as conflict with resetsAt and the alternative (032)', async () => {
      resolver.kindOnly.mockResolvedValueOnce({
        accountLabel: 'ada@example.com',
        alternativeMode: 'BYOK',
        kind: 'subscription-limited',
        provider: 'anthropic',
        resetsAt: new Date('2026-09-24T12:00:00.000Z'),
      });

      const refusal = await service
        .create(ORG, PROJECT, USER, 'build me a todo app', 'claude-sonnet-5')
        .catch((error: unknown) => error);

      expect(refusal).toMatchObject({
        extensions: {
          alternativeMode: 'BYOK',
          provider: 'anthropic',
          reason: 'subscription-limited',
          resetsAt: '2026-09-24T12:00:00.000Z',
        },
        type: 'conflict',
      });
      expect(JSON.stringify(refusal)).not.toContain('ada@example.com');
      expect(store.insertRun).not.toHaveBeenCalled();
    });

    it("passes credential: 'organisation' to the resolver and records it on the run (032 A3)", async () => {
      resolver.kindOnly.mockResolvedValueOnce({ kind: 'byok' });

      await service.create(
        ORG,
        PROJECT,
        USER,
        'build me a todo app',
        'claude-sonnet-5',
        'organisation',
      );

      expect(resolver.kindOnly).toHaveBeenCalledWith(tx, ORG, USER, 'claude-sonnet-5', {
        credential: 'organisation',
      });
      expect(store.insertRun).toHaveBeenCalledWith(tx, {
        credentialChoice: 'organisation',
        credentialMode: 'BYOK',
        model: 'claude-sonnet-5',
        orgId: ORG,
        projectId: PROJECT,
        userId: USER,
      });
    });

    it('accepts a byok resolution without opening the plaintext', async () => {
      resolver.kindOnly.mockResolvedValueOnce({ kind: 'byok' });

      await service.create(ORG, PROJECT, USER, 'build me a todo app');

      expect(resolver.forModel).not.toHaveBeenCalled();
      expect(store.insertRun).toHaveBeenCalledTimes(1);
    });

    /** The holder waits on a person; queued behind it, a new run would wait forever. */
    describe('while the project’s run waits for input', () => {
      beforeEach(() => {
        store.holder.mockResolvedValue(
          row({ startedAt: new Date(START), status: 'awaiting_input' }),
        );
        // The row as the transaction sees it: waiting until the answer's transition re-queues it.
        store.readRun.mockImplementation(() =>
          Promise.resolve(
            row({
              startedAt: new Date(START),
              status: store.transition.mock.calls.length > 0 ? 'queued' : 'awaiting_input',
            }),
          ),
        );
      });

      it('answers that run with the prompt and returns it, inserting no new run', async () => {
        const response = await service.create(ORG, PROJECT, USER, 'and make it blue');

        expect(store.holder).toHaveBeenCalledWith(tx, ORG, PROJECT);
        expect(store.insertRun).not.toHaveBeenCalled();
        expect(store.insertMessage).toHaveBeenCalledWith(tx, {
          content: 'and make it blue',
          orgId: ORG,
          role: 'user',
          runId: RUN,
        });
        expect(store.transition).toHaveBeenCalledWith(tx, {
          from: 'awaiting_input',
          orgId: ORG,
          runId: RUN,
          to: 'queued',
        });
        expect(outbox.append).toHaveBeenCalledTimes(1);
        expect(response).toMatchObject({ id: RUN, status: 'queued' });
      });

      it('applies the follow-up’s model to the answered run', async () => {
        await service.create(ORG, PROJECT, USER, 'and make it blue', 'claude-opus-5');

        expect(resolver.kindOnly).toHaveBeenCalledWith(tx, ORG, USER, 'claude-opus-5', {});
        expect(store.setModel).toHaveBeenCalledWith(
          tx,
          { orgId: ORG, runId: RUN },
          'claude-opus-5',
        );
        expect(store.insertRun).not.toHaveBeenCalled();
      });
    });

    it('queues behind a holder that is not waiting on a person', async () => {
      store.holder.mockResolvedValueOnce(row({ startedAt: new Date(START), status: 'running' }));

      await service.create(ORG, PROJECT, USER, 'build me a todo app');

      expect(store.insertRun).toHaveBeenCalledTimes(1);
      expect(store.transition).not.toHaveBeenCalled();
    });

    /** 041: the CLI picks its own default; AGENT_DEFAULT_MODEL is a catalogue id it may not serve. */
    it('records the provider, not AGENT_DEFAULT_MODEL, for a subscription run with no model', async () => {
      const admitSubscription = vi.fn(() => Promise.resolve());
      registry.register({ admitSubscription, execute: vi.fn(), release: vi.fn() });

      await service.create(ORG, PROJECT, USER, 'build me a todo app', undefined, undefined, {
        provider: 'claude',
      });

      expect(resolver.kindOnly).not.toHaveBeenCalled();
      expect(store.insertRun).toHaveBeenCalledWith(tx, {
        credentialMode: 'BYOS',
        model: 'claude',
        orgId: ORG,
        projectId: PROJECT,
        userId: USER,
      });
    });
  });

  /** FR-021: the flag and the audit row commit with the request; the channel hears of it after. */
  /** Spec 031 US1: the line's limit on create, and a waiting run cancelled in the request. */
  describe('the line (031)', () => {
    it('cancels a never-started run in the request and emits agent-run.finished', async () => {
      store.waitingRun.mockResolvedValueOnce(row());

      await service.cancel(ORG, PROJECT, RUN, USER);

      // `transition` to a terminal state is what appends `agent-run.finished` (spec 029).
      expect(store.transition).toHaveBeenCalledWith(tx, {
        from: 'queued',
        orgId: ORG,
        reason: 'cancelled-waiting',
        runId: RUN,
        to: 'cancelled',
      });
      expect(store.requestCancel).not.toHaveBeenCalled();

      for (const hook of afterCommit) {
        await hook();
      }

      expect(control.publish).not.toHaveBeenCalled();
      expect(publisher.sync).toHaveBeenCalledWith(ORG, RUN);
    });

    it('keeps cooperative cancellation for a started run', async () => {
      await service.cancel(ORG, PROJECT, RUN, USER);

      expect(store.transition).not.toHaveBeenCalled();
      expect(store.requestCancel).toHaveBeenCalledWith(tx, ORG, PROJECT, RUN);

      for (const hook of afterCommit) {
        await hook();
      }

      expect(control.publish).toHaveBeenCalledWith(RUN, 'cancel');
    });

    it('refuses a sixth waiting run with 409 queue-full and inserts nothing', async () => {
      store.line.mockResolvedValueOnce(Array.from({ length: RUN_LINE_LIMIT }, () => row()));

      const failure = await service
        .create(ORG, PROJECT, USER, 'Build it')
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictError);
      expect(failure).toMatchObject({ extensions: { reason: 'queue-full' } });
      expect(store.insertRun).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });

    it('takes the project writer lock before counting the line', async () => {
      const trace: string[] = [];

      checkpoints.lockProject.mockImplementationOnce(() => {
        trace.push('lock:project');
        return Promise.resolve();
      });
      store.line.mockImplementationOnce(() => {
        trace.push('line');
        return Promise.resolve([]);
      });

      await service.create(ORG, PROJECT, USER, 'Build it');

      expect(checkpoints.lockProject).toHaveBeenCalledWith(tx, { orgId: ORG, projectId: PROJECT });
      expect(trace).toEqual(['lock:project', 'line']);
    });
  });

  describe('cancel', () => {
    it('sets the flag on a live run, audits it, and publishes on the channel only after commit', async () => {
      await service.cancel(ORG, PROJECT, RUN, USER);

      expect(store.requestCancel).toHaveBeenCalledWith(tx, ORG, PROJECT, RUN);
      expect(audit.record).toHaveBeenCalledWith(tx, {
        action: 'agent-run.cancel-requested',
        actorId: USER,
        metadata: { projectId: PROJECT, status: 'running' },
        orgId: ORG,
        target: RUN,
      });
      expect(control.publish).not.toHaveBeenCalled();

      for (const hook of afterCommit) {
        await hook();
      }

      expect(control.publish).toHaveBeenCalledWith(RUN, 'cancel');
    });

    it('is a no-op on a repeat: success again, no second audit row, no second message', async () => {
      store.requestCancel.mockResolvedValueOnce({ first: false, status: 'running' });

      await service.cancel(ORG, PROJECT, RUN, USER);

      expect(audit.record).not.toHaveBeenCalled();
      expect(afterCommit).toEqual([]);
    });

    it('answers conflict naming the state for a run that has ended, and writes nothing', async () => {
      store.requestCancel.mockResolvedValueOnce(undefined);
      store.readRun.mockResolvedValueOnce(row({ status: 'succeeded' }));

      await expect(service.cancel(ORG, PROJECT, RUN, USER)).rejects.toThrow(
        new ConflictError('Run is succeeded.'),
      );

      expect(audit.record).not.toHaveBeenCalled();
      expect(afterCommit).toEqual([]);
    });

    it('answers not-found for a run the project does not hold', async () => {
      store.requestCancel.mockResolvedValueOnce(undefined);
      store.readRun.mockResolvedValueOnce(undefined);

      await expect(service.cancel(ORG, PROJECT, RUN, USER)).rejects.toThrow(NotFoundError);
    });

    /** No worker holds these states, so none would hear the channel: the request ends the run. */
    it.each(['awaiting_input', 'paused', 'queued'] as const)(
      'ends a %s run no worker holds in the request, with no channel message',
      async (status) => {
        store.requestCancel.mockResolvedValueOnce({ first: true, status });

        await service.cancel(ORG, PROJECT, RUN, USER);

        // A terminal `transition` appends the `state` event and `agent-run.finished` (the release).
        expect(store.transition).toHaveBeenCalledWith(tx, {
          from: status,
          orgId: ORG,
          reason: 'cancelled-waiting',
          runId: RUN,
          to: 'cancelled',
        });
        expect(audit.record).toHaveBeenCalledWith(tx, {
          action: 'agent-run.cancel-requested',
          actorId: USER,
          metadata: { projectId: PROJECT, status },
          orgId: ORG,
          target: RUN,
        });

        for (const hook of afterCommit) {
          await hook();
        }

        expect(publisher.sync).toHaveBeenCalledWith(ORG, RUN);
        expect(control.publish).not.toHaveBeenCalled();
      },
    );

    it('still ends a waiting run on a repeat ask, without a second audit row', async () => {
      store.requestCancel.mockResolvedValueOnce({ first: false, status: 'awaiting_input' });

      await service.cancel(ORG, PROJECT, RUN, USER);

      expect(store.transition).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ from: 'awaiting_input', to: 'cancelled' }),
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('clears a subscription run’s runner-side state after commit, and only after', async () => {
      const release = vi.fn(() => Promise.resolve());

      vi.spyOn(registry, 'isLocal').mockResolvedValue(true);
      registry.register({ admitSubscription: vi.fn(), execute: vi.fn(), release });
      store.requestCancel.mockResolvedValueOnce({ first: true, status: 'awaiting_input' });

      await service.cancel(ORG, PROJECT, RUN, USER);

      expect(release).not.toHaveBeenCalled();

      for (const hook of afterCommit) {
        await hook();
      }

      expect(release).toHaveBeenCalledWith(RUN);
    });

    it('leaves a held run to its worker: no transition', async () => {
      await service.cancel(ORG, PROJECT, RUN, USER);

      expect(store.transition).not.toHaveBeenCalled();
    });
  });

  /** 040 hardening: the registry decides who may answer a local run, so it is never optional. */
  it('requires the executor registry (no fail-open authorisation when it is missing)', () => {
    const optional = (Reflect.getMetadata(OPTIONAL_DEPS_METADATA, RunService) ?? []) as number[];
    const params = Reflect.getMetadata('design:paramtypes', RunService) as unknown[];

    expect(optional).not.toContain(params.indexOf(RunExecutorRegistry));
    expect(params).toContain(RunExecutorRegistry);
  });

  /** US4: the answer is message 2, the run is re-queued without an epoch, and dispatched again. */
  describe('input', () => {
    it('adds the message, moves awaiting_input → queued, audits it and appends a new outbox row', async () => {
      store.readRun.mockResolvedValueOnce(row({ status: 'awaiting_input' }));

      await service.input(ORG, PROJECT, RUN, USER, 'go on');

      expect(store.insertMessage).toHaveBeenCalledWith(tx, {
        content: 'go on',
        orgId: ORG,
        role: 'user',
        runId: RUN,
      });
      expect(store.transition).toHaveBeenCalledWith(tx, {
        from: 'awaiting_input',
        orgId: ORG,
        runId: RUN,
        to: 'queued',
      });
      expect(audit.record).toHaveBeenCalledWith(tx, {
        action: 'agent-run.input',
        actorId: USER,
        metadata: { messageId: 'm1', projectId: PROJECT },
        orgId: ORG,
        target: RUN,
      });
      expect(outbox.append).toHaveBeenCalledWith(tx, {
        aggregateId: RUN,
        orgId: ORG,
        payload: { orgId: ORG, projectId: PROJECT, runId: RUN },
        type: 'agent-run.requested',
      });
    });

    it('syncs the stream after commit', async () => {
      store.readRun.mockResolvedValueOnce(row({ status: 'awaiting_input' }));

      await service.input(ORG, PROJECT, RUN, USER, 'go on');

      expect(publisher.sync).not.toHaveBeenCalled();

      for (const hook of afterCommit) {
        await hook();
      }

      expect(publisher.sync).toHaveBeenCalledWith(ORG, RUN);
    });

    it.each<AgentRun['status']>(['running', 'paused', 'succeeded'])(
      'answers conflict naming the state for a run that is %s, and writes nothing',
      async (status) => {
        store.readRun.mockResolvedValueOnce(row({ status }));

        await expect(service.input(ORG, PROJECT, RUN, USER, 'go on')).rejects.toThrow(
          new ConflictError(`Run is ${status}.`),
        );

        expect(store.insertMessage).not.toHaveBeenCalled();
        expect(store.transition).not.toHaveBeenCalled();
        expect(outbox.append).not.toHaveBeenCalled();
      },
    );

    it('answers not-found for a run the project does not hold', async () => {
      store.readRun.mockResolvedValueOnce(undefined);

      await expect(service.input(ORG, PROJECT, RUN, USER, 'go on')).rejects.toThrow(NotFoundError);
    });

    describe('with a model', () => {
      beforeEach(() => {
        store.readRun.mockResolvedValue(row({ status: 'awaiting_input' }));
      });

      it('switches the run to a model the catalogue pays for, from this answer on', async () => {
        await service.input(ORG, PROJECT, RUN, USER, 'go on', 'claude-opus-5');

        expect(resolver.kindOnly).toHaveBeenCalledWith(tx, ORG, USER, 'claude-opus-5', {});
        expect(store.setModel).toHaveBeenCalledWith(
          tx,
          { orgId: ORG, runId: RUN },
          'claude-opus-5',
        );
        expect(store.setModel.mock.invocationCallOrder[0]).toBeLessThan(
          store.transition.mock.invocationCallOrder[0]!,
        );
        expect(audit.record).toHaveBeenCalledWith(tx, {
          action: 'agent-run.input',
          actorId: USER,
          metadata: { messageId: 'm1', model: 'claude-opus-5', projectId: PROJECT },
          orgId: ORG,
          target: RUN,
        });
      });

      it.each<ResolutionKind>([
        { kind: 'unknown-model' },
        { kind: 'no-credential', provider: 'openai' },
      ])('refuses a model outside the catalogue as 422, writing nothing ($kind)', async (kind) => {
        resolver.kindOnly.mockResolvedValueOnce(kind);

        await expect(
          service.input(ORG, PROJECT, RUN, USER, 'go on', 'gpt-5.2'),
        ).rejects.toMatchObject({ extensions: { model: 'gpt-5.2' }, type: 'validation-failed' });
        expect(store.setModel).not.toHaveBeenCalled();
        expect(store.insertMessage).not.toHaveBeenCalled();
        expect(store.transition).not.toHaveBeenCalled();
      });

      it('resolves as the starter would, honouring their credential choice', async () => {
        const OTHER = 'c1000000-0000-4000-8000-000000000009';
        store.readRun.mockResolvedValue(
          row({ credentialChoice: 'organisation', status: 'awaiting_input' }),
        );

        await service.input(ORG, PROJECT, RUN, OTHER, 'go on', 'claude-opus-5');

        expect(resolver.kindOnly).toHaveBeenCalledWith(tx, ORG, USER, 'claude-opus-5', {
          credential: 'organisation',
        });
      });
    });

    /** Spec 041: the answer runs on the starter's own subscription, so only the starter may give it. */
    describe('on a run on the starter’s own subscription', () => {
      const OTHER = 'c1000000-0000-4000-8000-000000000009';

      function local(registered: boolean): RunService {
        const registry = new RunExecutorRegistry();
        vi.spyOn(registry, 'isLocal').mockResolvedValue(true);
        if (registered)
          registry.register({
            admitSubscription: vi.fn(),
            execute: vi.fn(),
            release: vi.fn(),
          });

        return new RunService(
          { onCommit: (hook: () => Promise<void>) => afterCommit.push(hook), tx } as never,
          store as unknown as RunStore,
          projects as unknown as ProjectService,
          audit as unknown as AuditService,
          outbox as unknown as OutboxWriter,
          control as unknown as RunControl,
          clock,
          { get: () => 'claude-sonnet-5' } as unknown as ConfigService<Environment, true>,
          publisher as unknown as RunStreamPublisher,
          resolver as unknown as CredentialResolver,
          checkpoints as unknown as CheckpointService,
          registry,
        );
      }

      it('takes the starter’s answer', async () => {
        store.readRun.mockResolvedValue(row({ status: 'awaiting_input' }));

        await local(true).input(ORG, PROJECT, RUN, USER, 'go on');

        expect(store.transition).toHaveBeenCalled();
      });

      it('refuses another member’s answer (403), writing nothing', async () => {
        store.readRun.mockResolvedValue(row({ status: 'awaiting_input' }));

        await expect(local(true).input(ORG, PROJECT, RUN, OTHER, 'go on')).rejects.toThrow(
          ForbiddenError,
        );
        expect(store.insertMessage).not.toHaveBeenCalled();
        expect(store.transition).not.toHaveBeenCalled();
      });

      it('switches to any plain CLI model id or alias, with no catalogue lookup', async () => {
        store.readRun.mockResolvedValue(row({ model: 'claude', status: 'awaiting_input' }));

        await local(true).input(ORG, PROJECT, RUN, USER, 'go on', 'opus');

        expect(resolver.kindOnly).not.toHaveBeenCalled();
        expect(store.setModel).toHaveBeenCalledWith(tx, { orgId: ORG, runId: RUN }, 'opus');
      });

      it('refuses a model that is no plain CLI token as 422, writing nothing', async () => {
        store.readRun.mockResolvedValue(row({ status: 'awaiting_input' }));

        await expect(
          local(true).input(ORG, PROJECT, RUN, USER, 'go on', '--dangerously-skip-permissions'),
        ).rejects.toMatchObject({ type: 'validation-failed' });
        expect(store.setModel).not.toHaveBeenCalled();
        expect(store.transition).not.toHaveBeenCalled();
      });

      it('refuses any answer where subscription runs are off (409), writing nothing', async () => {
        store.readRun.mockResolvedValue(row({ status: 'awaiting_input' }));

        await expect(local(false).input(ORG, PROJECT, RUN, USER, 'go on')).rejects.toThrow(
          ConflictError,
        );
        expect(store.insertMessage).not.toHaveBeenCalled();
      });
    });
  });

  /** US4: no route until 019; the reaper and the suites re-queue a paused run through this. */
  describe('resume', () => {
    it('moves paused → queued, appends a new outbox row, and syncs the stream after commit', async () => {
      store.readRun.mockResolvedValueOnce(row({ status: 'paused' }));

      await service.resume(ORG, PROJECT, RUN);

      expect(publisher.sync).not.toHaveBeenCalled();

      for (const hook of afterCommit) {
        await hook();
      }

      expect(publisher.sync).toHaveBeenCalledWith(ORG, RUN);

      expect(store.transition).toHaveBeenCalledWith(tx, {
        from: 'paused',
        orgId: ORG,
        runId: RUN,
        to: 'queued',
      });
      expect(outbox.append).toHaveBeenCalledWith(tx, {
        aggregateId: RUN,
        orgId: ORG,
        payload: { orgId: ORG, projectId: PROJECT, runId: RUN },
        type: 'agent-run.requested',
      });
      expect(store.insertMessage).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('answers conflict naming the state for a run that is not paused', async () => {
      store.readRun.mockResolvedValueOnce(row({ status: 'awaiting_input' }));

      await expect(service.resume(ORG, PROJECT, RUN)).rejects.toThrow(
        new ConflictError('Run is awaiting_input.'),
      );

      expect(store.transition).not.toHaveBeenCalled();
      expect(outbox.append).not.toHaveBeenCalled();
    });
  });

  describe('usage', () => {
    it('lists the caller’s own runs and maps what paid, the cost and the CLI default; an agent-home run is the subscription', async () => {
      store.listUsage.mockResolvedValueOnce({
        nextCursor: 'bmV4dA',
        runs: [
          {
            ...row({ credentialMode: 'BYOS', model: 'claude' }),
            inAgentHome: true,
            projectName: 'P',
          },
          {
            ...row({ costMicros: 0, credentialMode: 'BYOK' }),
            inAgentHome: false,
            projectName: 'P',
          },
          {
            ...row({
              costMicros: 4_200,
              credentialMode: 'PLATFORM',
              endedAt: new Date(START),
              status: 'succeeded',
            }),
            inAgentHome: false,
            projectName: 'Q',
          },
          // An agent-home run from before spec 043, never stamped: the column's PLATFORM default.
          { ...row({ credentialMode: 'PLATFORM' }), inAgentHome: true, projectName: 'Q' },
        ],
      });

      const page = await service.usage(ORG, USER, { cursor: 'Y3Vyc29y', limit: 3 });

      expect(store.listUsage).toHaveBeenCalledWith(tx, ORG, USER, { cursor: 'Y3Vyc29y', limit: 3 });
      expect(usageRunListResponseSchema.parse(page)).toEqual(page);
      expect(page.nextCursor).toBe('bmV4dA');
      expect(page.runs.map((run) => [run.paidWith, run.costMicros, run.model])).toEqual([
        ['subscription', null, null],
        ['api-key', null, 'claude-sonnet-5'],
        ['platform-credits', 4_200, 'claude-sonnet-5'],
        ['subscription', null, 'claude-sonnet-5'],
      ]);
      expect(page.runs[2]).toMatchObject({
        finishedAt: START,
        projectName: 'Q',
        status: 'succeeded',
      });
    });
  });

  describe('reads', () => {
    it('reads by (org, project, run) and exposes next_seq - 1 as lastSeq', async () => {
      const response = await service.read(ORG, PROJECT, RUN);

      expect(store.readRun).toHaveBeenCalledWith(tx, ORG, PROJECT, RUN);
      expect(response.lastSeq).toBe(4);
      expect(response.promptExcerpt).toBe('Build a todo app');
    });

    it('answers not-found for a run the project does not hold', async () => {
      store.readRun.mockResolvedValue(undefined);

      await expect(service.read(ORG, PROJECT, RUN)).rejects.toThrow(NotFoundError);
      await expect(service.events(ORG, PROJECT, RUN, 0, 10)).rejects.toThrow(NotFoundError);

      expect(store.readEvents).not.toHaveBeenCalled();
    });

    it('passes the cursor page through and maps every row with its excerpt', async () => {
      const page = await service.list(ORG, PROJECT, { cursor: 'Y3Vyc29y', limit: 2 });

      expect(store.listRuns).toHaveBeenCalledWith(tx, ORG, PROJECT, {
        cursor: 'Y3Vyc29y',
        limit: 2,
      });
      expect(page.nextCursor).toBe('Y3Vyc29y');
      expect(page.runs.map((run) => run.lastSeq)).toEqual([12, 0]);
      expect(page.runs.map((run) => run.promptExcerpt)).toEqual(['Build the page', '']);
    });

    it('pages events after a seq and reports the run’s lastSeq', async () => {
      const page = await service.events(ORG, PROJECT, RUN, 0, 10);

      expect(store.readEvents).toHaveBeenCalledWith(tx, ORG, RUN, 0, 10);
      expect(page).toEqual({
        events: [
          { at: START, data: { from: null, to: 'queued' }, run: RUN, seq: 1, type: 'state' },
        ],
        lastSeq: 4,
      });
    });
  });
});
