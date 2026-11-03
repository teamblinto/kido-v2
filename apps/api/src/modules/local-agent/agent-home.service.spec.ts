import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Logger } from '@nestjs/common';
import type { AgentHomeRow } from '@repo/db';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { ConflictError, RateLimitedError } from '../../common/errors/domain-error';
import { DaytonaError } from '../sandbox/sandbox.errors';
import type { AgentHomeRepository } from './agent-home.repository';
import { AgentHomeService, type AgentHomeTimings, composeStatus } from './agent-home.service';
import { DEFAULT_LOCAL_AGENT_TIMINGS } from './local-agent.constants';
import type { LocalAgentRepository } from './local-agent.repository';
import { LocalAgentStore } from './local-agent.store';

const USER = 'b0410000-0000-4000-8000-0000000000a1';
const DEVICE = 'b0410000-0000-4000-8000-0000000000d1';
const NOW = new Date('2026-11-03T10:00:00.000Z');
const CODE = 'Abc123_sign-in.code#XyZ';
const TIMINGS: AgentHomeTimings = {
  disconnectStartMs: 50,
  onlineMs: 50,
  pollMs: 1,
  reportMs: 50,
  sandboxReadyMs: 50,
};

const base = {
  message: null,
  plan: null,
  provider: 'claude',
  signIn: null,
  updatedAt: NOW.toISOString(),
} as const;

function home(overrides: Partial<AgentHomeRow> = {}): AgentHomeRow {
  return {
    createdAt: NOW,
    daytonaId: 'sbx-home-1',
    deviceId: DEVICE,
    id: 'b0410000-0000-4000-8000-0000000000e1',
    lastError: null,
    lastUsedAt: NOW,
    provider: 'claude',
    sandboxCreatedAt: null,
    startedAt: null,
    state: 'running',
    updatedAt: NOW,
    userId: USER,
    ...overrides,
  };
}

/** Just enough of ioredis for the store's agent-home methods, recording every command. */
function fakeRedis() {
  const values = new Map<string, string>();
  const calls: { command: string; args: unknown[] }[] = [];
  let subscribers = 1;
  let onPublish: (message: string) => void = () => undefined;
  const record = (command: string, args: unknown[]) => calls.push({ args, command });
  const set = (key: string, value: string, ...rest: unknown[]) => {
    record('set', [key, value, ...rest]);
    if (rest.includes('NX') && values.has(key)) return null;
    values.set(key, value);
    return 'OK';
  };
  const redis = {
    del: (...keys: string[]) => {
      record('del', keys);
      for (const key of keys) values.delete(key);
      return Promise.resolve(keys.length);
    },
    // The store's one Lua script here: RELEASE (delete only while the key holds our token).
    eval: (_script: string, _keys: number, key: string, token: string) => {
      record('eval', [key, token]);
      if (values.get(key) !== token) return Promise.resolve(0);
      values.delete(key);
      return Promise.resolve(1);
    },
    exists: (key: string) => {
      record('exists', [key]);
      return Promise.resolve(values.has(key) ? 1 : 0);
    },
    get: (key: string) => {
      record('get', [key]);
      return Promise.resolve(values.get(key) ?? null);
    },
    multi: () => {
      const ops: (() => unknown)[] = [];
      const chain = {
        exec: () => Promise.resolve(ops.map((op) => [null, op()])),
        incr: (key: string) => {
          ops.push(() => {
            const next = Number(values.get(key) ?? '0') + 1;
            values.set(key, String(next));
            return next;
          });
          return chain;
        },
        set: (...args: [string, string, ...unknown[]]) => {
          ops.push(() => set(...args));
          return chain;
        },
        ttl: () => {
          ops.push(() => 60);
          return chain;
        },
      };
      return chain;
    },
    publish: (channel: string, message: string) => {
      record('publish', [channel, message]);
      onPublish(message);
      return Promise.resolve(subscribers);
    },
    set: (key: string, value: string, ...rest: unknown[]) =>
      Promise.resolve(set(key, value, ...rest)),
    xadd: (...args: unknown[]) => {
      record('xadd', args);
      return Promise.resolve('1-0');
    },
  };
  return {
    calls,
    onPublish: (listener: (message: string) => void) => (onPublish = listener),
    redis: redis as unknown as Redis,
    setSubscribers: (n: number) => (subscribers = n),
    values,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    AGENT_HOME_EGRESS_ALLOW_CIDRS: [],
    AGENT_HOME_ENABLED: true,
    AGENT_HOME_IDLE_MINUTES: 30,
    AGENT_HOME_RUNNER_BUNDLE: undefined,
    AGENT_HOME_SERVER_URL: 'http://host.docker.internal:3000',
    AGENT_HOME_UNUSED_DAYS: 14,
    DEPLOY_ENV: 'local',
    LOCAL_AGENT_ENABLED: true,
    SANDBOX_OWNER: 'forge-test',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as never;
}

function build(
  options: {
    row?: AgentHomeRow;
    config?: Record<string, unknown>;
    timings?: Partial<AgentHomeTimings>;
  } = {},
) {
  const started = Date.now();
  const redis = fakeRedis();
  const store = new LocalAgentStore(redis.redis, DEFAULT_LOCAL_AGENT_TIMINGS);
  let row = options.row;
  const lastUse = (each: AgentHomeRow) => each.lastUsedAt ?? each.updatedAt;
  const homes = {
    byDevice: vi.fn(() => Promise.resolve(row)),
    // The conditional update, as the repository's SQL decides it: still running, still unused.
    claimIdle: vi.fn((_id: string, cutoff: Date) => {
      if (row?.state !== 'running' || lastUse(row) >= cutoff) return Promise.resolve(undefined);
      row = { ...row, state: 'stopping' };
      return Promise.resolve(row);
    }),
    findOrCreate: vi.fn(() => Promise.resolve(row)),
    forUser: vi.fn(() => Promise.resolve(row)),
    forUserOn: vi.fn(() => Promise.resolve(row)),
    inStates: vi.fn(() => Promise.resolve(row === undefined ? [] : [row])),
    recover: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => {
      row = undefined;
      return Promise.resolve();
    }),
    rotateToken: vi.fn(() => Promise.resolve()),
    touchDevice: vi.fn((_deviceId: string, at: Date) => {
      if (row !== undefined) row = { ...row, lastUsedAt: at };
      return Promise.resolve(row);
    }),
    unusedSince: vi.fn((cutoff: Date) =>
      Promise.resolve(row !== undefined && (row.lastUsedAt ?? row.createdAt) < cutoff ? [row] : []),
    ),
    update: vi.fn((_id: string, values: Partial<AgentHomeRow>) => {
      if (row !== undefined) row = { ...row, ...values };
      return Promise.resolve();
    }),
    withSandbox: vi.fn(() => Promise.resolve(row?.daytonaId ? [row] : [])),
  };
  const devices = { liveRunsOf: vi.fn(() => Promise.resolve([] as { runId: string }[])) };
  const daytona = {
    create: vi.fn(),
    describe: vi.fn(() => Promise.resolve({ state: 'started' })),
    execute: vi.fn(() => Promise.resolve({ exitCode: 0, result: '', timedOut: false })),
    listByLabels: vi.fn(() => Promise.resolve([] as { id: string; createdAt?: string }[])),
    remove: vi.fn(() => Promise.resolve()),
    removeSnapshot: vi.fn(() => Promise.resolve()),
    setNetwork: vi.fn(() => Promise.resolve()),
    start: vi.fn(() => Promise.resolve()),
    startSession: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    stopSession: vi.fn(() => Promise.resolve()),
    upload: vi.fn(() => Promise.resolve()),
  };
  const versions = {
    current: vi.fn(() => Promise.resolve({ snapshot: 'forge-tpl-agent-home-x' })),
    retirable: vi.fn(() => Promise.resolve([] as { readyAt: Date; snapshot: string }[])),
    retire: vi.fn(() => Promise.resolve()),
  };
  const service = new AgentHomeService(
    homes as unknown as AgentHomeRepository,
    devices as unknown as LocalAgentRepository,
    store,
    daytona as never,
    versions as never,
    // Ticks from NOW, so the waits (presence, sandbox) reach their deadlines.
    { now: () => new Date(NOW.getTime() + (Date.now() - started)) },
    { ...TIMINGS, ...options.timings },
    config(options.config),
  );
  /** The runner shows up once its session is started. */
  const runnerComesUp = () =>
    daytona.startSession.mockImplementation(() => {
      redis.values.set(`local-agent:presence:${DEVICE}`, 'conn');
      return Promise.resolve();
    });
  return {
    daytona,
    devices,
    homes,
    redis,
    row: () => row,
    runnerComesUp,
    service,
    store,
    versions,
  };
}

describe('composeStatus', () => {
  const compose = (input: Partial<Parameters<typeof composeStatus>[0]>) =>
    composeStatus({
      auth: undefined,
      base,
      home: { lastError: null, state: 'running' },
      now: NOW,
      signIn: undefined,
      ...input,
    });
  const authenticated = {
    checkedAt: NOW.toISOString(),
    plan: 'Max',
    status: 'authenticated' as const,
  };

  it('is connected, with the plan, on an authenticated verdict', () => {
    expect(compose({ auth: authenticated })).toEqual({ ...base, plan: 'Max', state: 'connected' });
  });

  it('offers a live sign-in URL, and drops an expired one', () => {
    const signIn = {
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      phase: 'url' as const,
      url: 'https://claude.com/cai/oauth/authorize?x=1',
    };
    expect(compose({ signIn })).toEqual({
      ...base,
      signIn: { expiresAt: signIn.expiresAt, url: signIn.url },
      state: 'awaiting-sign-in',
    });
    expect(compose({ signIn: { ...signIn, expiresAt: NOW.toISOString() } }).state).toBe(
      'signed-out',
    );
  });

  it('stays verifying after a code until the status report says authenticated', () => {
    expect(compose({ signIn: { phase: 'verifying' } }).state).toBe('verifying');
    expect(compose({ auth: authenticated, signIn: { phase: 'verifying' } }).state).toBe(
      'connected',
    );
  });

  it('reports provisioning, starting and error from the home, error with its reason', () => {
    expect(compose({ home: { lastError: null, state: 'provisioning' } }).state).toBe(
      'provisioning',
    );
    expect(compose({ home: { lastError: null, state: 'starting' } }).state).toBe('starting');
    expect(compose({ signIn: { phase: 'requested' } }).state).toBe('starting');
    expect(compose({ home: { lastError: 'gone', state: 'error' } })).toEqual({
      ...base,
      message: 'gone',
      state: 'error',
    });
  });

  it('is signed out with Settings guidance, never the companion command', () => {
    const status = compose({
      auth: { checkedAt: NOW.toISOString(), plan: null, status: 'unauthenticated' },
    });
    expect(status.state).toBe('signed-out');
    expect(status.message).not.toMatch(/baios-companion/);
    expect(compose({ signIn: { message: 'Bad code.', phase: 'failed' } }).message).toBe(
      'Bad code.',
    );
  });
});

describe('AgentHomeService', () => {
  it('delivers the code on the live channel only: never XADD, never stored, never logged', async () => {
    const { redis, service, store } = build({ row: home() });
    await store.setSignIn(DEVICE, { phase: 'url', url: 'https://claude.com/x' }, 600);
    const logs = [
      vi.spyOn(Logger.prototype, 'log'),
      vi.spyOn(Logger.prototype, 'warn'),
      vi.spyOn(Logger.prototype, 'error'),
      vi.spyOn(Logger.prototype, 'debug'),
    ];

    await service.submitCode(USER, CODE);

    const carrying = redis.calls.filter((call) => JSON.stringify(call.args).includes(CODE));
    expect(carrying).toEqual([
      {
        args: [
          `local-agent:auth:${DEVICE}`,
          JSON.stringify({ code: CODE, provider: 'claude', type: 'auth.login.code' }),
        ],
        command: 'publish',
      },
    ]);
    expect(redis.calls.some((call) => call.command === 'xadd')).toBe(false);
    expect([...redis.values.values()].join()).not.toContain(CODE);
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(CODE);
    expect(await store.signIn(DEVICE)).toEqual({ phase: 'verifying' });
  });

  it('refuses a code with no sign-in waiting, and one the runner is not there to receive', async () => {
    const { redis, service, store } = build({ row: home() });
    await expect(service.submitCode(USER, CODE)).rejects.toBeInstanceOf(ConflictError);

    await store.setSignIn(DEVICE, { phase: 'url', url: 'https://claude.com/x' }, 600);
    redis.setSubscribers(0);
    await expect(service.submitCode(USER, CODE)).rejects.toBeInstanceOf(ConflictError);
  });

  it('keeps the URL briefly and treats ok:true as verifying, not connected', async () => {
    const { service, store } = build({ row: home() });
    const device = { id: DEVICE, kind: 'cloud' } as never;

    await service.onAuthEvent(device, {
      provider: 'claude',
      type: 'auth.login.url',
      url: 'https://claude.com/cai/oauth/authorize?x',
    });
    expect((await store.signIn(DEVICE))?.phase).toBe('url');

    await service.onAuthEvent(device, {
      message: null,
      ok: true,
      provider: 'claude',
      type: 'auth.login.result',
    });
    expect((await service.status(USER)).state).toBe('verifying');
  });

  it('is disconnected with a reason when the feature is off, and refuses to connect', async () => {
    const { service } = build({ config: { AGENT_HOME_ENABLED: false }, row: home() });
    expect((await service.status(USER)).state).toBe('disconnected');
    await expect(service.connect(USER)).rejects.toMatchObject({ type: 'subscription-unavailable' });
  });

  describe('idle stop', () => {
    const old = new Date(NOW.getTime() - 31 * 60_000);

    it('stops a running home unused past the limit, session first, and marks it stopped', async () => {
      const { daytona, row, service } = build({ row: home({ lastUsedAt: old }) });
      expect(await service.idleStop()).toBe(1);
      expect(daytona.stopSession).toHaveBeenCalledWith('sbx-home-1', 'baios-runner');
      expect(daytona.stop).toHaveBeenCalledWith('sbx-home-1');
      expect(row()?.state).toBe('stopped');
    });

    it('leaves a recently used home, one with an active run, and one mid sign-in', async () => {
      expect(await build({ row: home() }).service.idleStop()).toBe(0);

      const busy = build({ row: home({ lastUsedAt: old }) });
      busy.devices.liveRunsOf.mockResolvedValue([{ runId: 'r' }]);
      expect(await busy.service.idleStop()).toBe(0);

      const signingIn = build({ row: home({ lastUsedAt: old }) });
      await signingIn.store.setSignIn(DEVICE, { phase: 'requested' }, 600);
      expect(await signingIn.service.idleStop()).toBe(0);
      expect(signingIn.daytona.stop).not.toHaveBeenCalled();
    });
  });

  describe('reconcile', () => {
    it('marks a home whose sandbox vanished as error and forgets the sandbox id', async () => {
      const { daytona, row, service } = build({ row: home() });
      daytona.describe.mockRejectedValue(new DaytonaError('sandbox-not-found', 'gone', 404));
      expect(await service.reconcile()).toEqual({ egress: 0, missing: 1, orphaned: 0 });
      expect(row()).toMatchObject({ daytonaId: null, state: 'error' });
    });

    it('deletes an old agent-home sandbox no home claims, and spares a young one', async () => {
      const { daytona, service } = build({ row: home() });
      daytona.listByLabels.mockResolvedValue([
        { id: 'sbx-home-1' },
        { createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(), id: 'sbx-orphan' },
        { createdAt: NOW.toISOString(), id: 'sbx-young' },
      ]);
      expect(await service.reconcile()).toEqual({ egress: 0, missing: 0, orphaned: 1 });
      expect(daytona.listByLabels).toHaveBeenCalledWith({
        baios: 'agent-home',
        owner: 'forge-test',
      });
      expect(daytona.remove).toHaveBeenCalledExactlyOnceWith('sbx-orphan');
    });
  });

  describe('wake (the executor’s start-home path)', () => {
    const bundle = path.join(mkdtempSync(path.join(tmpdir(), 'agent-home-')), 'main.js');
    writeFileSync(bundle, 'console.log("runner")');

    it('is not-a-home for a person’s own computer', async () => {
      expect(await build().service.wake(DEVICE)).toBe('not-a-home');
    });

    it('starts a stopped home: fresh token, bundle and 0600 token file, runner session, presence', async () => {
      const { daytona, homes, redis, row, service } = build({
        config: { AGENT_HOME_RUNNER_BUNDLE: bundle },
        row: home({ state: 'stopped' }),
      });
      daytona.describe.mockResolvedValueOnce({ state: 'stopped' });
      // The runner shows up once its session is started.
      daytona.startSession.mockImplementation(() => {
        redis.values.set(`local-agent:presence:${DEVICE}`, 'conn');
        return Promise.resolve();
      });

      expect(await service.wake(DEVICE)).toBe('online');

      expect(daytona.start).toHaveBeenCalledWith('sbx-home-1');
      expect(homes.rotateToken).toHaveBeenCalledOnce();
      const [, tokenPath, token] = daytona.upload.mock.calls[1] as unknown as [
        string,
        string,
        Buffer,
      ];
      expect(daytona.upload.mock.calls[0]).toEqual(
        expect.arrayContaining(['sbx-home-1', '/opt/baios/runner.mjs']),
      );
      expect(tokenPath).toBe('/opt/baios/token');
      expect(token.toString()).toMatch(/^bld_/);
      expect(daytona.execute).toHaveBeenCalledWith(
        'sbx-home-1',
        expect.objectContaining({
          command: 'chmod 600 /opt/baios/token',
        }),
      );
      const [, session, command] = daytona.startSession.mock.calls[0] as unknown as string[];
      expect(session).toBe('baios-runner');
      expect(command).toContain('node /opt/baios/runner.mjs start --hosted');
      expect(command).toContain('BAIOS_ALLOW_INSECURE_HTTP=1');
      expect(command).toContain('DISABLE_AUTOUPDATER=1');
      expect(command).toContain('CLAUDE_CONFIG_DIR=/home/daytona/.claude');
      expect(command).not.toContain(token.toString());
      expect(row()?.state).toBe('running');
    });

    it('fails (and marks the home error) when the runner never comes online', async () => {
      const { row, service } = build({
        config: { AGENT_HOME_RUNNER_BUNDLE: bundle },
        row: home({ state: 'stopped' }),
      });
      expect(await service.wake(DEVICE)).toBe('failed');
      await vi.waitFor(() => expect(row()?.state).toBe('error'));
    });

    it('creates a missing home, and adopts the sandbox a timed-out create still made', async () => {
      const { daytona, redis, row, service } = build({
        config: { AGENT_HOME_RUNNER_BUNDLE: bundle },
        row: home({ daytonaId: null, state: 'provisioning' }),
      });
      daytona.create.mockRejectedValue(new DaytonaError('unreachable', 'no answer'));
      daytona.listByLabels.mockResolvedValue([{ id: 'sbx-adopted', state: 'started' }] as never);
      daytona.startSession.mockImplementation(() => {
        redis.values.set(`local-agent:presence:${DEVICE}`, 'conn');
        return Promise.resolve();
      });

      expect(await service.wake(DEVICE)).toBe('online');
      expect(daytona.listByLabels).toHaveBeenCalledWith({
        baios: 'agent-home',
        owner: 'forge-test',
        provider: 'claude',
        userId: USER,
      });
      expect(row()).toMatchObject({ daytonaId: 'sbx-adopted', state: 'running' });
    });

    it('never sends the insecure-http flag off a laptop', async () => {
      const { daytona, redis, service } = build({
        config: {
          AGENT_HOME_RUNNER_BUNDLE: bundle,
          AGENT_HOME_SERVER_URL: 'https://api.example',
          DEPLOY_ENV: 'production',
        },
        row: home({ state: 'stopped' }),
      });
      daytona.startSession.mockImplementation(() => {
        redis.values.set(`local-agent:presence:${DEVICE}`, 'conn');
        return Promise.resolve();
      });
      await service.wake(DEVICE);
      expect(String(daytona.startSession.mock.calls[0])).not.toContain('INSECURE');
    });
  });
  describe('hardening', () => {
    const bundle = path.join(mkdtempSync(path.join(tmpdir(), 'agent-home-')), 'main.js');
    writeFileSync(bundle, 'console.log("runner")');
    const AUTH = `local-agent:home-auth:${DEVICE}`;
    const verdict = (status: string, checkedAt: Date) =>
      JSON.stringify({ checkedAt: checkedAt.toISOString(), plan: 'Max', status });
    const hourAgo = new Date(NOW.getTime() - 3_600_000);
    const published = (redis: ReturnType<typeof fakeRedis>, type: string) =>
      redis.calls.filter(
        (call) => call.command === 'publish' && String(call.args[1]).includes(`"${type}"`),
      );

    describe('a stale sign-in verdict', () => {
      it('is dropped when a new sandbox is created, and the creation time recorded', async () => {
        const { daytona, redis, row, runnerComesUp, service } = build({
          config: { AGENT_HOME_RUNNER_BUNDLE: bundle },
          row: home({ daytonaId: null, state: 'provisioning' }),
        });
        redis.values.set(AUTH, verdict('authenticated', hourAgo));
        daytona.create.mockResolvedValue({ id: 'sbx-new', state: 'started' });
        runnerComesUp();

        expect(await service.wake(DEVICE)).toBe('online');
        expect(redis.values.has(AUTH)).toBe(false);
        expect(row()?.sandboxCreatedAt).toBeInstanceOf(Date);
      });

      it('is dropped when reconcile finds the sandbox gone', async () => {
        const { daytona, redis, row, service } = build({ row: home() });
        redis.values.set(AUTH, verdict('authenticated', hourAgo));
        daytona.describe.mockRejectedValue(new DaytonaError('sandbox-not-found', 'gone', 404));

        await service.reconcile();

        expect(redis.values.has(AUTH)).toBe(false);
        expect(row()?.sandboxCreatedAt).toBeNull();
      });

      it('older than the current sandbox never admits a run, nor shows connected', async () => {
        const { redis, service } = build({
          row: home({ sandboxCreatedAt: NOW, state: 'stopped' }),
        });
        redis.values.set(AUTH, verdict('authenticated', hourAgo));

        expect(await service.admissible({} as never, USER, 'claude')).toBeUndefined();
        expect((await service.status(USER)).state).toBe('signed-out');

        redis.values.set(AUTH, verdict('authenticated', NOW));
        expect(await service.admissible({} as never, USER, 'claude')).toBeDefined();
      });

      it('older than the current start does not skip the sign-in; a fresh one does', async () => {
        const stale = build({ row: home({ startedAt: NOW }) });
        stale.redis.values.set(`local-agent:presence:${DEVICE}`, 'conn');
        stale.redis.values.set(AUTH, verdict('authenticated', hourAgo));
        await stale.service.connect(USER);
        await vi.waitFor(() => expect(published(stale.redis, 'auth.login.start')).toHaveLength(1));

        const fresh = build({ row: home({ startedAt: hourAgo }) });
        fresh.redis.values.set(`local-agent:presence:${DEVICE}`, 'conn');
        fresh.redis.values.set(AUTH, verdict('authenticated', NOW));
        await fresh.service.connect(USER);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(published(fresh.redis, 'auth.login.start')).toHaveLength(0);
      });
    });

    describe('egress', () => {
      const CIDRS = ['10.0.0.0/8'];

      it('is applied on every start, before the runner starts', async () => {
        const { daytona, runnerComesUp, service } = build({
          config: { AGENT_HOME_EGRESS_ALLOW_CIDRS: CIDRS, AGENT_HOME_RUNNER_BUNDLE: bundle },
          row: home({ state: 'stopped' }),
        });
        runnerComesUp();

        expect(await service.wake(DEVICE)).toBe('online');
        expect(daytona.setNetwork).toHaveBeenCalledWith('sbx-home-1', {
          allowList: CIDRS,
          blockAll: false,
        });
        expect(daytona.setNetwork.mock.invocationCallOrder[0]).toBeLessThan(
          daytona.startSession.mock.invocationCallOrder[0]!,
        );
      });

      it('fails the start closed when it cannot be applied', async () => {
        const { daytona, row, service } = build({
          config: { AGENT_HOME_EGRESS_ALLOW_CIDRS: CIDRS, AGENT_HOME_RUNNER_BUNDLE: bundle },
          row: home({ state: 'stopped' }),
        });
        daytona.setNetwork.mockRejectedValue(new DaytonaError('upstream', 'no'));

        expect(await service.wake(DEVICE)).toBe('failed');
        expect(daytona.startSession).not.toHaveBeenCalled();
        expect(row()?.state).toBe('error');
      });

      it('is re-applied to a running home when the allowlist changed, which stops if it cannot be', async () => {
        const changed = build({ config: { AGENT_HOME_EGRESS_ALLOW_CIDRS: CIDRS }, row: home() });
        changed.redis.values.set(`local-agent:home-egress:${DEVICE}`, '192.168.0.0/16');
        expect((await changed.service.reconcile()).egress).toBe(1);
        expect(changed.daytona.setNetwork).toHaveBeenCalledOnce();
        expect(await changed.store.homeEgress(DEVICE)).toBe('10.0.0.0/8');
        expect((await changed.service.reconcile()).egress).toBe(0);

        const refused = build({ config: { AGENT_HOME_EGRESS_ALLOW_CIDRS: CIDRS }, row: home() });
        refused.daytona.setNetwork.mockRejectedValue(new DaytonaError('upstream', 'no'));
        await refused.service.reconcile();
        expect(refused.daytona.stop).toHaveBeenCalledWith('sbx-home-1');
        expect(refused.row()?.state).toBe('stopped');
      });
    });

    describe('start bounds', () => {
      it('returns promptly on the run’s cancel, and throws on its fence', async () => {
        const { daytona, service } = build({
          config: { AGENT_HOME_RUNNER_BUNDLE: bundle },
          row: home({ state: 'stopped' }),
          timings: { onlineMs: 2_000 },
        });
        daytona.describe.mockResolvedValue({ state: 'starting' });
        const begun = Date.now();

        expect(
          await service.wake(DEVICE, {
            cancelled: () => Promise.resolve(true),
            signal: new AbortController().signal,
          }),
        ).toBe('cancelled');
        expect(Date.now() - begun).toBeLessThan(1_000);

        const fenced = new AbortController();
        fenced.abort(new Error('fenced'));
        await expect(
          service.wake(DEVICE, { cancelled: () => Promise.resolve(false), signal: fenced.signal }),
        ).rejects.toThrow('fenced');
      });

      it('caps the whole wait, a lock held elsewhere included, at onlineMs', async () => {
        const { daytona, redis, service } = build({ row: home({ state: 'stopped' }) });
        redis.values.set('local-agent:home-start:b0410000-0000-4000-8000-0000000000e1', 'other');
        const begun = Date.now();

        expect(await service.wake(DEVICE)).toBe('failed');
        expect(Date.now() - begun).toBeLessThan(1_000);
        expect(daytona.start).not.toHaveBeenCalled();
        // Never the other holder's lock.
        expect(
          redis.values.get('local-agent:home-start:b0410000-0000-4000-8000-0000000000e1'),
        ).toBe('other');
      });

      it('bumps last_used_at first, and waits out an idle stop rather than trust its dying runner', async () => {
        const LOCK = 'local-agent:home-start:b0410000-0000-4000-8000-0000000000e1';
        const PRESENCE = `local-agent:presence:${DEVICE}`;
        const { homes, redis, runnerComesUp, service } = build({
          config: { AGENT_HOME_RUNNER_BUNDLE: bundle },
          row: home({ state: 'stopping' }),
          timings: { onlineMs: 2_000 },
        });
        redis.values.set(PRESENCE, 'old-runner');
        redis.values.set(LOCK, 'idle-stop');
        setTimeout(() => {
          redis.values.delete(PRESENCE);
          redis.values.delete(LOCK);
          void homes.update('', { state: 'stopped' });
        }, 30);
        runnerComesUp();

        expect(await service.wake(DEVICE)).toBe('online');
        expect(homes.touchDevice).toHaveBeenCalledBefore(homes.rotateToken);
        expect(homes.rotateToken).toHaveBeenCalledOnce();
      });
    });

    describe('idle stop', () => {
      const old = new Date(NOW.getTime() - 31 * 60_000);

      it('is a conditional claim: a home used since the read keeps running', async () => {
        const { daytona, homes, service } = build({ row: home() });
        homes.inStates.mockResolvedValue([home({ lastUsedAt: old })]);

        expect(await service.idleStop()).toBe(0);
        expect(daytona.stop).not.toHaveBeenCalled();
      });

      it('counts queued and starting runs as live, and skips a home whose lock is held', async () => {
        const { devices, redis, service } = build({ row: home({ lastUsedAt: old }) });
        devices.liveRunsOf.mockResolvedValueOnce([{ runId: 'queued-run' }]);

        expect(await service.idleStop()).toBe(0);
        expect(devices.liveRunsOf).toHaveBeenCalledWith(
          DEVICE,
          expect.arrayContaining(['queued', 'starting', 'running']),
        );

        redis.values.set('local-agent:home-start:b0410000-0000-4000-8000-0000000000e1', 'other');
        expect(await service.idleStop()).toBe(0);
      });

      it('leaves the home in error, with the reason, when Daytona will not stop it', async () => {
        const { daytona, row, service } = build({ row: home({ lastUsedAt: old }) });
        daytona.stop.mockRejectedValue(new DaytonaError('upstream', 'no'));

        expect(await service.idleStop()).toBe(0);
        expect(row()).toMatchObject({
          lastError: expect.stringMatching(/did not stop/) as unknown,
          state: 'error',
        });
      });
    });

    describe('abuse', () => {
      it('throttles connect, code and cancel per person', async () => {
        const { redis, service } = build({ row: home() });
        redis.values.set(`local-agent:presence:${DEVICE}`, 'conn');
        redis.values.set(AUTH, verdict('authenticated', NOW));

        for (let i = 0; i < 5; i += 1) await service.connect(USER);
        await expect(service.connect(USER)).rejects.toMatchObject({ type: 'rate-limited' });

        for (let i = 0; i < 10; i += 1) await service.cancel(USER);
        await expect(service.cancel(USER)).rejects.toBeInstanceOf(RateLimitedError);

        for (let i = 0; i < 10; i += 1) {
          await expect(service.submitCode(USER, CODE)).rejects.toBeInstanceOf(ConflictError);
        }
        await expect(service.submitCode(USER, CODE)).rejects.toBeInstanceOf(RateLimitedError);
      });

      it('lets everyone connect today (the entitlement hook)', () => {
        expect(build().service.canConnectSubscription(USER)).toBe(true);
      });

      it('sweeps a home not signed in and unused past AGENT_HOME_UNUSED_DAYS, and keeps a signed-in one', async () => {
        const unused = new Date(NOW.getTime() - 15 * 86_400_000);
        const swept = build({ row: home({ lastUsedAt: unused, state: 'stopped' }) });
        swept.redis.values.set(AUTH, verdict('unauthenticated', unused));

        expect(await swept.service.sweepUnused()).toBe(1);
        expect(swept.daytona.remove).toHaveBeenCalledWith('sbx-home-1');
        expect(swept.homes.remove).toHaveBeenCalledOnce();
        expect(swept.redis.values.has(AUTH)).toBe(false);

        const kept = build({ row: home({ lastUsedAt: unused, state: 'stopped' }) });
        kept.redis.values.set(AUTH, verdict('authenticated', unused));
        expect(await kept.service.sweepUnused()).toBe(0);
        expect(await build({ row: home() }).service.sweepUnused()).toBe(0);
      });

      it('retires superseded agent-home snapshots, keeping the current and the previous', async () => {
        const { daytona, service, versions } = build();
        const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
        versions.retirable.mockResolvedValue([
          { readyAt: at(30), snapshot: 'snap-2' },
          { readyAt: at(10), snapshot: 'snap-3-previous' },
          { readyAt: at(50), snapshot: 'snap-1' },
        ]);

        expect(await service.retireTemplates()).toBe(2);
        expect(versions.retirable).toHaveBeenCalledWith('agent-home');
        expect(daytona.removeSnapshot.mock.calls).toEqual([['snap-2'], ['snap-1']]);
        expect(versions.retire).toHaveBeenCalledTimes(2);
      });
    });

    describe('disconnect', () => {
      it('starts an offline home to sign it out first', async () => {
        const { daytona, redis, runnerComesUp, service, store } = build({
          config: { AGENT_HOME_RUNNER_BUNDLE: bundle },
          row: home({ state: 'stopped' }),
        });
        runnerComesUp();
        redis.onPublish((message) => {
          if (message.includes('auth.logout')) {
            void store.saveHomeAuth(DEVICE, {
              checkedAt: new Date(NOW.getTime() + 60_000).toISOString(),
              plan: null,
              status: 'unauthenticated',
            });
          }
        });

        await service.disconnect(USER);

        expect(daytona.startSession).toHaveBeenCalled();
        expect(published(redis, 'auth.logout')).toHaveLength(1);
        expect(daytona.remove).toHaveBeenCalledWith('sbx-home-1');
        expect(await service.status(USER)).toMatchObject({ message: null, state: 'disconnected' });
      });

      it('deletes anyway when the home cannot be started, and says how to end the session', async () => {
        const { daytona, service } = build({
          config: { AGENT_HOME_RUNNER_BUNDLE: bundle },
          row: home({ state: 'stopped' }),
        });

        await service.disconnect(USER);

        expect(daytona.remove).toHaveBeenCalledWith('sbx-home-1');
        expect(await service.status(USER)).toMatchObject({
          message: expect.stringMatching(/Claude account settings/) as unknown,
          state: 'disconnected',
        });
      });
    });

    it('moves a home in error back to running once its runner reports', async () => {
      const { homes, service } = build({ row: home({ state: 'error' }) });
      await service.onReport(DEVICE);
      expect(homes.recover).toHaveBeenCalledWith(DEVICE);
    });
  });
});
