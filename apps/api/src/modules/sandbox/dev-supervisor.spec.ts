import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  supervise,
  type DevServerState,
  type DevServerTimings,
  type SuperviseOptions,
} from './dev-supervisor.mjs';

/** The three sandbox-local paths of data-model §3. Literals, because the supervisor's are too. */
const LOG_PATH = '/tmp/forge-devserver.log';
const PID_PATH = '/tmp/forge-devserver.pid';
/** Spec 030 contracts/preview-env.md § 1: the connector values, for the dev server child only. */
const PROJECT_ENV_PATH = '/tmp/forge-project.env';

/**
 * The sandbox's `/tmp`, modelled.
 *
 * `supervise` reads and writes the pidfile and the log for real — they are part of what it is, not
 * an injected seam — so the only honest way to prove that behaviour without a container is to put
 * a model of those two files behind `node:fs`. Everything else falls through to the real module,
 * which is what lets the packaging case at the bottom go on reading `nest-cli.json`.
 */
const disk = vi.hoisted(() => ({
  /** The log's size in bytes, grown by a spawned child and zeroed by the supervisor's cap. */
  logSize: 0,
  /** The pidfile's contents, or `undefined` for a file that is not there. */
  pid: undefined as string | undefined,
  /** `/tmp/forge-project.env`, or `undefined` for a file that is not there (spec 030). */
  projectEnv: undefined as string | undefined,
  /** Every `truncateSync`, as the supervisor called it. */
  truncations: [] as { length: number; path: string }[],
  /** Every `writeFileSync`, as the supervisor called it. */
  writes: [] as { data: string; path: string }[],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();

  return {
    ...actual,
    readFileSync: (path: string, encoding: BufferEncoding) => {
      if (path === PROJECT_ENV_PATH) {
        if (disk.projectEnv === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }

        return disk.projectEnv;
      }
      if (path !== PID_PATH) return actual.readFileSync(path, encoding);
      if (disk.pid === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

      return disk.pid;
    },
    statSync: (path: string) =>
      path === LOG_PATH ? { size: disk.logSize } : actual.statSync(path),
    truncateSync: (path: string, length: number) => {
      disk.truncations.push({ length, path });
      if (path === LOG_PATH) disk.logSize = length;
    },
    writeFileSync: (path: string, data: string) => {
      disk.writes.push({ data, path });
      if (path === PID_PATH) disk.pid = data;
    },
  };
});

/**
 * The supervisor's unit layer (spec 023, research R11).
 *
 * `dev-supervisor.mjs` runs inside a tenant sandbox, where there is no Daytona to ask, no port to
 * bind and no second to spare. Its whole shape exists so that it can be proved here instead: every
 * call that touches the world — the spawn, the connect, the report — is an argument, and so are the
 * clocks. Nothing below opens a socket, starts a process or waits on a real interval. The cases
 * that only probe run on real timers against `probeIntervalMs: 1`; every case that exercises the
 * restart budget runs on fake ones, so the full 1/2/4/8/16 s ladder and the five-minute cold retry
 * cost microseconds rather than the eight real minutes they describe.
 */
describe('supervise', () => {
  /**
   * The production numbers of data-model §5 with the probe interval turned down. Held here rather
   * than imported from `sandbox.constants.ts`: the supervisor never sees that module — it is handed
   * these six numbers through the env file — and a unit that is honest about its inputs should not
   * borrow the control plane's copy of them. The five numbers that are *not* turned down are the
   * point of half the cases below, and fake timers are what makes keeping them free.
   */
  const TIMINGS: DevServerTimings = {
    backoffBaseMs: 1_000,
    coldRetryMs: 300_000,
    logCapBytes: 1_048_576,
    probeIntervalMs: 1,
    stableResetMs: 60_000,
    startAttempts: 5,
  };

  /** What a scripted child does once it has been spawned. */
  type Behaviour = 'crash' | 'hold' | 'listen';

  /** A stand-in for the dev server: an emitter that can be told to exit, and a `kill` to watch. */
  class FakeChild extends EventEmitter {
    readonly kill = vi.fn(() => true);
  }

  /**
   * A `spawn` and a `connect` driven by a script, one entry per child.
   *
   * `crash` exits in the microtask after it is spawned — the crash loop the budget exists for, and
   * the reason `supervise` attaches its `exit` listener before its first `await`. `listen` answers
   * the first probe. `hold` does neither, which is a dev server that is still starting.
   */
  const scripted = (behaviours: readonly Behaviour[]) => {
    const children: FakeChild[] = [];
    const spawnedAt: number[] = [];

    const spawn = vi.fn(() => {
      const behaviour = behaviours[children.length] ?? 'crash';
      const child = new FakeChild();

      children.push(child);
      spawnedAt.push(Date.now());
      // A child that runs writes to the log; one in a crash loop writes a stack trace per restart.
      disk.logSize += 700_000;

      if (behaviour === 'crash') queueMicrotask(() => child.emit('exit', 1, null));

      return child;
    });

    const connect = vi.fn(() => Promise.resolve(behaviours[children.length - 1] === 'listen'));

    return { children, connect, spawn: spawn as unknown as SuperviseOptions['spawn'], spawnedAt };
  };

  /** A `report` that records the states it was handed, in order. */
  const recorder = () => {
    const states: DevServerState[] = [];
    const report = vi.fn((state: DevServerState) => {
      states.push(state);

      return Promise.resolve();
    });

    return { report, states };
  };

  /** Everything `supervise` needs that a case does not vary. */
  const options = (
    overrides: Pick<SuperviseOptions, 'connect' | 'spawn'> & Partial<SuperviseOptions>,
  ): SuperviseOptions => ({
    command: 'npm run dev',
    cwd: '/home/daytona/workspace',
    port: 3000,
    report: vi.fn(() => Promise.resolve()),
    timings: TIMINGS,
    ...overrides,
  });

  beforeEach(() => {
    disk.logSize = 0;
    disk.pid = undefined;
    disk.projectEnv = undefined;
    disk.truncations = [];
    disk.writes = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('spawns the dev command, probes until the port answers, and then supervises the child', async () => {
    const { children, spawn } = scripted(['hold']);
    const { report, states } = recorder();
    const aborter = new AbortController();
    // Two refusals then a connect: a dev server does not bind its port in the tick after it is
    // spawned, and the supervisor is required to keep asking rather than to conclude anything from
    // the first `ECONNREFUSED`.
    const connect = vi.fn(() => Promise.resolve(connect.mock.calls.length === 3));
    // Ends the case from inside the transition it is about, so that what is asserted below is the
    // supervisor's own state at the moment it decided the port was up, not a later one.
    report.mockImplementation((state: DevServerState) => {
      states.push(state);
      if (state === 'listening') {
        // The point of the case: a port that answered is a supervisor with something to supervise.
        // It does not probe again, and it does not touch a child that is doing its job.
        expect(children[0]?.kill).not.toHaveBeenCalled();
        aborter.abort();
      }

      return Promise.resolve();
    });

    await supervise(options({ connect, report, signal: aborter.signal, spawn }));

    expect(spawn).toHaveBeenCalledExactlyOnceWith('npm run dev', {
      cwd: '/home/daytona/workspace',
      // No project file: the supervisor's own environment, and no `FORGE_*` key of it (spec 030).
      env: withoutForge(process.env),
      // The template's `devCommand` is a command line, not a binary and an argv.
      shell: true,
      // The detached supervisor's own stdout and stderr are already the log file, so inheriting is
      // what puts the child's output there too (research R7).
      stdio: 'inherit',
    });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(connect).toHaveBeenLastCalledWith(3000);
    expect(states).toEqual(['starting', 'listening']);
    // FR-013: a supervisor that has stopped supervising leaves nothing running behind it.
    expect(children[0]?.kill).toHaveBeenCalledOnce();
  });

  it('keeps probing a port that never answers, and stops and kills the child when the signal aborts', async () => {
    const { children, spawn } = scripted(['hold']);
    const aborter = new AbortController();
    // The abort stands in for the thing that ends a supervisor in production — the sandbox going
    // away underneath it. Raised from inside the fifth refusal so the case is decided by the
    // supervisor's own loop rather than by a timer the suite would have to wait on.
    const connect = vi.fn(() => {
      if (connect.mock.calls.length === 5) aborter.abort();

      return Promise.resolve(false);
    });

    await expect(
      supervise(options({ connect, signal: aborter.signal, spawn })),
    ).resolves.toBeUndefined();

    // Five probes, not one: the supervisor draws no conclusion from a refusal, and an abort is the
    // only thing that ends this loop.
    expect(connect).toHaveBeenCalledTimes(5);
    // Nothing is left running behind a supervisor that has stopped supervising.
    expect(children[0]?.kill).toHaveBeenCalledOnce();
  });

  /**
   * Spec 030 contracts/preview-env.md § 4: the dev server — and only the dev server — gets the
   * project's connector values, read from `/tmp/forge-project.env` at each (re)launch. Nothing of
   * the supervisor's own `FORGE_*` world ever reaches it.
   */
  describe('project environment', () => {
    /** The env the first spawned child was handed. */
    const childEnv = async (): Promise<Record<string, string | undefined>> => {
      const { spawn } = scripted(['listen']);
      const aborter = new AbortController();
      const report = vi.fn((state: DevServerState) => {
        if (state === 'listening') aborter.abort();

        return Promise.resolve();
      });

      await supervise(
        options({
          connect: vi.fn(() => Promise.resolve(true)),
          report,
          signal: aborter.signal,
          spawn,
        }),
      );

      const [, spawnOptions] = (
        spawn as unknown as {
          mock: { calls: [string, { env: Record<string, string | undefined> }][] };
        }
      ).mock.calls[0]!;

      return spawnOptions.env;
    };

    it('the dev server child sees DATABASE_URL from /tmp/forge-project.env', async () => {
      disk.projectEnv = 'DATABASE_URL=postgres://u:p@ep-x.neon.tech/app?sslmode=require\n';

      expect((await childEnv()).DATABASE_URL).toBe(
        'postgres://u:p@ep-x.neon.tech/app?sslmode=require',
      );
    });

    it('the child never sees FORGE_CALLBACK_TOKEN, even from the supervisor’s own environment', async () => {
      vi.stubEnv('FORGE_CALLBACK_TOKEN', 'tok-secret');
      disk.projectEnv = 'SUPABASE_URL=https://abc.supabase.co\n';

      const env = await childEnv();

      vi.unstubAllEnvs();
      expect(env.FORGE_CALLBACK_TOKEN).toBeUndefined();
      expect(env.SUPABASE_URL).toBe('https://abc.supabase.co');
    });

    it('a FORGE_* key in the project file is dropped', async () => {
      disk.projectEnv = 'FORGE_CALLBACK_URL=https://evil.example\nDATABASE_URL=postgres://x\n';

      const env = await childEnv();

      expect(env.FORGE_CALLBACK_URL).toBeUndefined();
      expect(env.DATABASE_URL).toBe('postgres://x');
    });

    it('a missing project file means no extra environment', async () => {
      expect(await childEnv()).toEqual(withoutForge(process.env));
    });

    it('re-reads the file at each relaunch, so a value removed by unbind disappears', async () => {
      vi.useFakeTimers();
      disk.projectEnv = 'RESEND_API_KEY=re_first\n';
      const { children, spawn } = scripted(['crash', 'listen']);
      const aborter = new AbortController();
      const connect = vi.fn(() => Promise.resolve(children.length === 2));
      const report = vi.fn((state: DevServerState) => {
        if (state === 'listening') aborter.abort();

        return Promise.resolve();
      });
      const done = supervise(options({ connect, report, signal: aborter.signal, spawn }));

      await vi.advanceTimersByTimeAsync(0);
      disk.projectEnv = '';
      await vi.advanceTimersByTimeAsync(TIMINGS.backoffBaseMs);
      await done;

      const calls = (
        spawn as unknown as {
          mock: { calls: [string, { env: Record<string, string | undefined> }][] };
        }
      ).mock.calls;

      expect(calls[0]![1].env.RESEND_API_KEY).toBe('re_first');
      expect(calls[1]![1].env.RESEND_API_KEY).toBeUndefined();
    });
  });

  /**
   * The pidfile (T011, contracts §3, FR-007).
   *
   * One supervisor per sandbox, decided by `/tmp/forge-devserver.pid` and `process.kill(pid, 0)`.
   * A second supervisor has to be indistinguishable from no second supervisor: nothing spawned,
   * nothing reported, and the live owner's pid left exactly as it was.
   */
  describe('single instance', () => {
    it.each<[string, () => true]>([
      ['a signallable process', () => true],
      [
        'a process owned by somebody else',
        () => {
          throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        },
      ],
    ])(
      'refuses to start when the pidfile names %s, spawning nothing and reporting nothing',
      async (_case, kill) => {
        disk.pid = '4242\n';
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(kill);
        const { connect, spawn } = scripted(['listen']);
        const { report, states } = recorder();

        await expect(supervise(options({ connect, report, spawn }))).resolves.toBeUndefined();

        expect(killSpy).toHaveBeenCalledExactlyOnceWith(4242, 0);
        expect(spawn).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        expect(states).toEqual([]);
        // The owner's pidfile is not overwritten, so the owner stays the owner.
        expect(disk.writes).toEqual([]);
        expect(disk.pid).toBe('4242\n');
      },
    );

    it.each([
      ['is missing', undefined],
      ['cannot be parsed', 'not-a-pid\n'],
      ['names a dead process', '4242\n'],
    ])('takes ownership and writes its own pid when the pidfile %s', async (_case, contents) => {
      disk.pid = contents;
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      });
      const { connect, spawn } = scripted(['listen']);
      const { report, states } = recorder();
      const aborter = new AbortController();
      report.mockImplementation((state: DevServerState) => {
        states.push(state);
        if (state === 'listening') aborter.abort();

        return Promise.resolve();
      });

      await supervise(options({ connect, report, signal: aborter.signal, spawn }));

      expect(disk.writes).toEqual([{ data: `${process.pid}\n`, path: PID_PATH }]);
      expect(spawn).toHaveBeenCalledOnce();
      expect(states).toEqual(['starting', 'listening']);
    });
  });

  /**
   * Reporting (T023/T024, contracts §4, FR-014, FR-018, FR-019).
   *
   * On transition only. `backoff` is deliberately invisible on the wire, and a 500 ms probe posting
   * every tick would exhaust 017's per-sandbox rate limit in seconds while saying nothing new.
   */
  describe('reporting', () => {
    it('reports starting once per spawn and listening once on the first connect, never per probe tick', async () => {
      vi.useFakeTimers({ now: 0 });
      const { spawn } = scripted(['hold']);
      const { report, states } = recorder();
      const aborter = new AbortController();
      // Twenty refusals before the port answers: twenty probe ticks that must produce no report at
      // all, against a supervisor that is required to keep asking.
      const connect = vi.fn(() => {
        const answered = connect.mock.calls.length === 21;
        if (!answered) expect(states).toEqual(['starting']);

        return Promise.resolve(answered);
      });
      report.mockImplementation((state: DevServerState) => {
        states.push(state);
        if (state === 'listening') aborter.abort();

        return Promise.resolve();
      });

      const done = supervise(options({ connect, report, signal: aborter.signal, spawn }));
      await vi.advanceTimersByTimeAsync(TIMINGS.probeIntervalMs * 25);
      await done;

      expect(connect).toHaveBeenCalledTimes(21);
      // Two reports for twenty-one probes: one per transition, and `listening` is asserted once for
      // the life of the child rather than for every tick on which it remains true.
      expect(states).toEqual(['starting', 'listening']);
      expect(report).toHaveBeenCalledTimes(2);
    });

    it('does not stop the child or retry when a report fails, and still reports the next transition', async () => {
      vi.useFakeTimers({ now: 0 });
      const { children, spawn } = scripted(['crash', 'listen']);
      const attempted: DevServerState[] = [];
      const aborter = new AbortController();
      const connect = vi.fn(() => Promise.resolve(children.length === 2));
      // Every way a report can fail to arrive, in the order the transitions come: a non-2xx the
      // reporter surfaced, a thrown network error, and a timeout. None of them is the dev server's
      // problem (FR-018).
      const failures: Record<string, () => Promise<void>> = {
        0: () => Promise.reject(new Error('503 Service Unavailable')),
        1: () => {
          throw new TypeError('fetch failed');
        },
        2: () => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
      };
      const report = vi.fn((state: DevServerState) => {
        attempted.push(state);

        return failures[attempted.length - 1]?.() ?? Promise.resolve();
      });

      const done = supervise(options({ connect, report, signal: aborter.signal, spawn }));
      await vi.advanceTimersByTimeAsync(1_000);
      aborter.abort();
      await done;

      // Three transitions, three reports, no fourth: a failed report is dropped where it failed and
      // is never sent again, and the state it described is never re-asserted.
      expect(attempted).toEqual(['starting', 'starting', 'listening']);
      expect(report).toHaveBeenCalledTimes(3);
      // The child the third report was about is still the child the supervisor is supervising: a
      // broker that cannot be reached does not take a working dev server down with it.
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(children[1]?.kill).toHaveBeenCalledOnce();
      expect(children[1]?.kill).toHaveBeenCalledAfter(report);
    });
  });

  /**
   * The restart budget (T030–T034, data-model §4, research R5 and R7).
   *
   * Five fast attempts on a 1/2/4/8/16 s ladder, then one `failed` and a five-minute cold retry
   * that runs forever. Every case here is on fake timers, so the eight minutes it takes to describe
   * the last of them cost nothing to run.
   */
  describe('restarting', () => {
    /** Drive a supervisor through `ms` of fake time, then stop it and let it unwind. */
    const run = async (
      overrides: Pick<SuperviseOptions, 'connect' | 'report' | 'spawn'>,
      ms: number,
    ) => {
      vi.useFakeTimers({ now: 0 });
      const aborter = new AbortController();
      const done = supervise(options({ ...overrides, signal: aborter.signal }));

      await vi.advanceTimersByTimeAsync(ms);
      aborter.abort();
      await done;
    };

    it('restarts a child that crashes and reaches listening without ever reporting failed', async () => {
      const { connect, spawn, spawnedAt } = scripted(['crash', 'listen']);
      const { report, states } = recorder();

      await run({ connect, report, spawn }, 1_000);

      // FR-008: an unexpected exit is started again, and the restart is a transition like any other
      // — which is why `starting` appears twice and `backoff` appears not at all.
      expect(states).toEqual(['starting', 'starting', 'listening']);
      expect(states).not.toContain('failed');
      expect(spawn).toHaveBeenCalledTimes(2);
      // One base backoff between the crash and the restart, and nothing else waited on.
      expect(spawnedAt).toEqual([0, 1_000]);
    });

    it('spends five attempts on a 1/2/4/8/16 s ladder and then reports failed exactly once', async () => {
      const { connect, spawn, spawnedAt } = scripted(['crash', 'crash', 'crash', 'crash', 'crash']);
      const { report, states } = recorder();

      // 1 + 2 + 4 + 8 + 16 = 31 s of backoff across five attempts — SC-004's two minutes with room
      // to spare, and the exact ladder research R5 committed to.
      await run({ connect, report, spawn }, 31_000);

      expect(spawn).toHaveBeenCalledTimes(5);
      expect(spawnedAt).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
      expect(states).toEqual([
        'starting',
        'starting',
        'starting',
        'starting',
        'starting',
        'failed',
      ]);
      expect(states.filter((state) => state === 'failed')).toHaveLength(1);
    });

    it('stays quiet between cold retries once the fast budget is spent', async () => {
      const { connect, spawn } = scripted(['crash', 'crash', 'crash', 'crash', 'crash']);
      const { report, states } = recorder();

      // One millisecond short of the cold retry: SC-004's "consumes no measurable CPU afterwards"
      // is a supervisor parked on a single timer, not one polling anything.
      await run({ connect, report, spawn }, 31_000 + TIMINGS.coldRetryMs - 1);

      expect(spawn).toHaveBeenCalledTimes(5);
      expect(connect).not.toHaveBeenCalled();
      expect(states.filter((state) => state === 'failed')).toHaveLength(1);
    });

    it('cold-retries at coldRetryMs after failed and returns to listening with no external trigger', async () => {
      const { connect, spawn, spawnedAt } = scripted([
        'crash',
        'crash',
        'crash',
        'crash',
        'crash',
        'listen',
      ]);
      const { report, states } = recorder();

      await run({ connect, report, spawn }, 31_000 + TIMINGS.coldRetryMs);

      // Research R5: the cold retry is the same code path on a longer timer. Nothing outside the
      // sandbox asked for this — no endpoint, no agent hook, no recreated sandbox.
      expect(spawn).toHaveBeenCalledTimes(6);
      expect(spawnedAt.at(-1)).toBe(31_000 + TIMINGS.coldRetryMs);
      expect(states).toEqual([
        'starting',
        'starting',
        'starting',
        'starting',
        'starting',
        'failed',
        'starting',
        'listening',
      ]);
    });

    it('hands a full five-attempt budget back to a child that stayed up past stableResetMs', async () => {
      const { children, connect, spawn, spawnedAt } = scripted([
        'listen',
        'crash',
        'crash',
        'crash',
        'crash',
        'crash',
      ]);
      const { report, states } = recorder();

      vi.useFakeTimers({ now: 0 });
      const aborter = new AbortController();
      const done = supervise(options({ connect, report, signal: aborter.signal, spawn }));

      // A minute of honest service, and then the crash that would have exhausted a budget the
      // supervisor had not handed back (FR-010).
      await vi.advanceTimersByTimeAsync(TIMINGS.stableResetMs);
      children[0]?.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(32_000);
      aborter.abort();
      await done;

      // Five fresh attempts after the stable child, on a ladder that starts again at one second.
      expect(spawn).toHaveBeenCalledTimes(6);
      expect(spawnedAt).toEqual([0, 61_000, 62_000, 64_000, 68_000, 76_000]);
      expect(states).toEqual([
        'starting',
        'listening',
        'starting',
        'starting',
        'starting',
        'starting',
        'starting',
        'failed',
      ]);
    });

    it('keeps the log at or under logCapBytes while a child floods it', async () => {
      const { connect, spawn } = scripted(['crash', 'crash', 'crash', 'crash', 'crash']);
      const observed: number[] = [];
      // The log is checked and capped on the way into every transition, so the size the reporter
      // sees is the size the supervisor left behind.
      const report = vi.fn(() => {
        observed.push(disk.logSize);

        return Promise.resolve();
      });

      await run({ connect, report, spawn }, 31_000);

      // Five children writing 700 KB each is 3.5 MB of output through a 1 MiB cap.
      expect(observed).toHaveLength(6);
      for (const size of observed) expect(size).toBeLessThanOrEqual(TIMINGS.logCapBytes);
      expect(Math.max(...observed)).toBeGreaterThan(0);
      // Truncated to zero, never rotated: there is no reader, so there is nothing to keep
      // (research R7).
      expect(disk.truncations.length).toBeGreaterThan(0);
      expect(disk.truncations).toSatisfy((calls: { length: number; path: string }[]) =>
        calls.every((call) => call.path === LOG_PATH && call.length === 0),
      );
    });
  });
});

/**
 * The supervisor is the one file in `src/` that `tsc` does not compile and therefore does not emit.
 * It has to reach `dist/` anyway, because `SandboxOpsConsumer` reads it off the API image's disk on
 * every claim and resume (contracts §1) — a missing asset is a feature that is silently absent in
 * production and perfectly present on a developer's machine, where `src/` is right there.
 *
 * Asserted against the build config rather than against `dist/` itself: `pnpm check` runs the
 * suites before it runs the build, so a case that read `dist/` would be asserting on whatever the
 * last build happened to leave behind, and would pass vacuously on a clean checkout. The build is
 * proved by `pnpm --filter @repo/api build` putting the file at
 * `apps/api/dist/modules/sandbox/dev-supervisor.mjs`; this is what keeps the declaration that makes
 * it do so from being deleted by someone who does not know what it is for.
 */
/** The supervisor's environment as a child may see it: every `FORGE_*` key removed. */
function withoutForge(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('FORGE_')));
}

describe('dev-supervisor.mjs packaging', () => {
  it('is declared as a build asset, so it lands beside the compiled output', () => {
    const config = JSON.parse(readFileSync(join(__dirname, '../../../nest-cli.json'), 'utf8')) as {
      compilerOptions?: { assets?: { include?: string; outDir?: string }[] };
    };

    expect(config.compilerOptions?.assets).toContainEqual(
      expect.objectContaining({ include: 'modules/sandbox/dev-supervisor.mjs', outDir: 'dist' }),
    );
  });
});
