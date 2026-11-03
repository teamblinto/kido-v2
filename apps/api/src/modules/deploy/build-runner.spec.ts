import type { ProjectTemplate } from '@repo/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import type { TenantTransaction } from '../../database/database.types';
import type { TenantTransactionRunner } from '../../database/tenant-transaction';
import type { RepoBundler } from '../checkpoints/repo-bundler';
import { RetryableFailure } from '../outbox/consumer';
import {
  type BuildSandbox,
  BuildSandboxError,
  type BuildSandboxHandle,
} from '../sandbox/build-sandbox.service';
import type { ExecuteOutcome } from '../sandbox/daytona.adapter';
import { DaytonaError } from '../sandbox/sandbox.errors';
import type { TemplateCatalogue } from '../sandbox/template-catalogue';
import {
  BUILD_ARCHIVE_PATH,
  BUILD_BUNDLE_PATH,
  type BuildInput,
  type BuildOutcome,
  BuildRunner,
} from './build-runner';
import { BUILD_TIMEOUT_MS, LOG_TAIL_MAX_BYTES, TAR_DOWNLOAD_MAX_BYTES } from './deploy.constants';

const ORG = '0199aaaa-0000-7000-8000-000000000001';
const PROJECT = '0199aaaa-0000-7000-8000-000000000002';
const DEPLOYMENT = '0199aaaa-0000-7000-8000-000000000003';
const SHA = 'a'.repeat(40);
const TEMPLATE: ProjectTemplate = 'vite-react';
const HANDLE: BuildSandboxHandle = { id: 'build-1', snapshot: 'snap', workDir: '/home/daytona' };
const INPUT: BuildInput = {
  deploymentId: DEPLOYMENT,
  gitSha: SHA,
  orgId: ORG,
  projectId: PROJECT,
  template: TEMPLATE,
};
const BUNDLE = Buffer.from('bundle-bytes');
const MINUTE = 60 * 1000;

// ---- a minimal ustar writer (the reader's own spec covers the format) ----

const BLOCK = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

function member(name: string, body: string, type = '0'): Buffer {
  const bytes = Buffer.from(body, 'utf8');
  const block = Buffer.alloc(BLOCK);
  const put = (offset: number, value: string): void => {
    Buffer.from(value, 'utf8').copy(block, offset);
  };
  put(0, name);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(type === '0' ? bytes.length : 0, 12));
  put(136, octal(0, 12));
  put(156, type);
  put(257, 'ustar\0');
  put(263, '00');
  put(148, '        ');
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, octal(sum, 7) + ' ');
  if (type !== '0') return block;
  const rest = bytes.length % BLOCK;
  return Buffer.concat([block, bytes, Buffer.alloc(rest === 0 ? 0 : BLOCK - rest)]);
}

function tarOf(...members: Buffer[]): Buffer {
  return Buffer.concat([...members, Buffer.alloc(BLOCK * 2)]);
}

const SITE = tarOf(
  member('./', '', '5'),
  member('./index.html', '<h1>hi</h1>'),
  member('./assets/app.js', 'console.log(1)'),
  member('./evil', '', '2'),
);

// ---- doubles ----

type Call =
  | { readonly op: 'bundle'; readonly scope: unknown }
  | { readonly op: 'create'; readonly template: string; readonly deploymentId: string }
  | { readonly op: 'put'; readonly path: string; readonly body: Buffer }
  | { readonly op: 'run'; readonly command: string; readonly timeoutMs: number }
  | { readonly op: 'get'; readonly path: string; readonly capBytes: number }
  | { readonly op: 'remove'; readonly id: string };

const ok = (result = 'ok\n'): ExecuteOutcome => ({ exitCode: 0, result, timedOut: false });
const fail = (result: string, exitCode = 1): ExecuteOutcome => ({
  exitCode,
  result,
  timedOut: false,
});

interface Harness {
  readonly calls: Call[];
  readonly clock: FakeClock;
  readonly runner: BuildRunner;
  /** Per-command answers, matched by prefix; unmatched commands succeed. */
  readonly answers: Map<string, () => ExecuteOutcome | Promise<ExecuteOutcome>>;
  archive: Buffer | (() => Promise<Buffer>);
  create: () => Promise<BuildSandboxHandle>;
  remove: () => Promise<void>;
  bundle: () => Promise<{ body: Buffer; head: string }>;
  build: { command: string; output: string } | undefined;
}

function harness(): Harness {
  const calls: Call[] = [];
  const clock = new FakeClock('2026-09-22T10:00:00.000Z');
  const tx = {} as TenantTransaction;

  const h: Omit<Harness, 'runner'> = {
    answers: new Map(),
    archive: SITE,
    build: { command: 'npm run build', output: 'dist' },
    bundle: () => Promise.resolve({ body: BUNDLE, head: 'b'.repeat(40) }),
    calls,
    clock,
    create: () => Promise.resolve(HANDLE),
    remove: () => Promise.resolve(),
  };

  const sandbox: BuildSandbox = {
    create: (template, deploymentId) => {
      calls.push({ deploymentId, op: 'create', template });
      return h.create();
    },
    get: (_handle, path, capBytes) => {
      calls.push({ capBytes, op: 'get', path });
      return typeof h.archive === 'function' ? h.archive() : Promise.resolve(h.archive);
    },
    put: (_handle, path, body) => {
      calls.push({ body, op: 'put', path });
      return Promise.resolve();
    },
    remove: (handle) => {
      calls.push({ id: handle.id, op: 'remove' });
      return h.remove();
    },
    run: (_handle, command, timeoutMs) => {
      calls.push({ command, op: 'run', timeoutMs });
      for (const [prefix, answer] of h.answers) {
        if (command.startsWith(prefix)) return Promise.resolve(answer());
      }
      return Promise.resolve(ok());
    },
  };

  const bundler = {
    current: vi.fn((given: TenantTransaction, ref: unknown, ctx: unknown) => {
      expect(given).toBe(tx);
      expect(ref).toEqual({ orgId: ORG, projectId: PROJECT });
      expect(ctx).toMatchObject({ operationId: `deploy/${DEPLOYMENT}` });
      return h.bundle();
    }),
  } as unknown as RepoBundler;

  const transactions = {
    runInTenantScope: vi.fn(
      async (scope: unknown, fn: (t: TenantTransaction) => Promise<unknown>) => {
        calls.push({ op: 'bundle', scope });
        return fn(tx);
      },
    ),
  } as unknown as TenantTransactionRunner;

  const catalogue = {
    get: (id: ProjectTemplate) => {
      expect(id).toBe(TEMPLATE);
      return { manifest: { build: h.build } };
    },
  } as unknown as TemplateCatalogue;

  const runner = new BuildRunner(sandbox, bundler, transactions, catalogue, clock);
  return Object.assign(h, { runner });
}

const commands = (calls: readonly Call[]): string[] =>
  calls.flatMap((call) => (call.op === 'run' ? [call.command] : []));

const removed = (calls: readonly Call[]): number =>
  calls.filter((call) => call.op === 'remove').length;

describe('BuildRunner (spec 027 T034, research R3/R5/R15)', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('bundles in a tenant scope, then uploads under .git/, fetches, checks out, installs, builds, tars and downloads, in order', async () => {
    const outcome = await h.runner.run(INPUT);

    expect(h.calls.map((call) => call.op)).toEqual([
      'bundle',
      'create',
      'put',
      'run',
      'run',
      'run',
      'run',
      'run',
      'run',
      'run',
      'get',
      'remove',
    ]);
    expect(h.calls[0]).toEqual({ op: 'bundle', scope: { orgId: ORG, userId: null } });
    expect(h.calls[1]).toEqual({ deploymentId: DEPLOYMENT, op: 'create', template: TEMPLATE });
    expect(h.calls[2]).toEqual({ body: BUNDLE, op: 'put', path: BUILD_BUNDLE_PATH });
    expect(BUILD_BUNDLE_PATH.startsWith('.git/')).toBe(true);
    expect(commands(h.calls)).toEqual([
      'git init -q',
      `git fetch -q ${BUILD_BUNDLE_PATH} ${SHA}`,
      `git checkout -q -f --detach ${SHA}`,
      'git clean -q -f -d -x',
      'npm ci',
      'npm run build',
      `tar -cf ${BUILD_ARCHIVE_PATH} -C dist .`,
    ]);
    expect(h.calls[10]).toEqual({
      capBytes: TAR_DOWNLOAD_MAX_BYTES,
      op: 'get',
      path: BUILD_ARCHIVE_PATH,
    });
    expect(BUILD_ARCHIVE_PATH).toBe('/tmp/forge-out.tar');

    expect(outcome.kind).toBe('built');
    if (outcome.kind !== 'built') return;
    expect(outcome.files.map((file) => [file.path, file.body.toString()])).toEqual([
      ['index.html', '<h1>hi</h1>'],
      ['assets/app.js', 'console.log(1)'],
    ]);
    expect(outcome.totalBytes).toBe('<h1>hi</h1>'.length + 'console.log(1)'.length);
    expect(outcome.dropped).toBe(1);
    expect(outcome.log).toContain('$ npm ci');
    expect(outcome.log).toContain('$ npm run build');
    expect(outcome.log).toMatch(/dropped 1 /);
  });

  it('gives every command the whole remaining 15-minute budget and no more', async () => {
    h.answers.set('npm ci', () => {
      h.clock.advance(4 * MINUTE);
      return ok();
    });
    h.answers.set('npm run build', () => {
      h.clock.advance(6 * MINUTE);
      return ok();
    });

    await h.runner.run(INPUT);

    const timeouts = new Map(
      h.calls.flatMap((call) => (call.op === 'run' ? [[call.command, call.timeoutMs]] : [])),
    );
    expect(timeouts.get('git init -q')).toBe(BUILD_TIMEOUT_MS);
    expect(timeouts.get('npm ci')).toBe(BUILD_TIMEOUT_MS);
    expect(timeouts.get('npm run build')).toBe(BUILD_TIMEOUT_MS - 4 * MINUTE);
    expect(timeouts.get(`tar -cf ${BUILD_ARCHIVE_PATH} -C dist .`)).toBe(
      BUILD_TIMEOUT_MS - 10 * MINUTE,
    );
    for (const timeout of timeouts.values()) {
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(BUILD_TIMEOUT_MS);
    }
  });

  it('counts the budget from before the bundle and the sandbox create', async () => {
    h.bundle = () => {
      h.clock.advance(2 * MINUTE);
      return Promise.resolve({ body: BUNDLE, head: SHA });
    };
    h.create = () => {
      h.clock.advance(3 * MINUTE);
      return Promise.resolve(HANDLE);
    };

    await h.runner.run(INPUT);

    const first = h.calls.find((call) => call.op === 'run');
    expect(first).toMatchObject({
      command: 'git init -q',
      timeoutMs: BUILD_TIMEOUT_MS - 5 * MINUTE,
    });
  });

  it('fails timeout without running the next command once the budget is spent, and removes the sandbox', async () => {
    h.answers.set('npm ci', () => {
      h.clock.advance(BUILD_TIMEOUT_MS);
      return ok();
    });

    const outcome = await h.runner.run(INPUT);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'timeout' });
    expect(commands(h.calls)).not.toContain('npm run build');
    expect(h.calls.some((call) => call.op === 'get')).toBe(false);
    expect(removed(h.calls)).toBe(1);
  });

  it('fails timeout when a command is timed out by the sandbox', async () => {
    h.answers.set('npm run build', () => ({ timedOut: true }));

    const outcome = await h.runner.run(INPUT);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'timeout' });
    expect(outcome.log).toContain('timed out');
    expect(removed(h.calls)).toBe(1);
  });

  it.each([
    ['npm ci', 'install-failed'],
    ['npm run build', 'build-failed'],
    ['tar -cf', 'no-output'],
    ['git fetch', 'platform'],
    ['git init', 'platform'],
    ['git checkout', 'platform'],
    ['git clean', 'platform'],
  ] as const)(
    'a non-zero exit from `%s` fails %s, keeps its output in the log and removes the sandbox',
    async (prefix, reason) => {
      h.answers.set(prefix, () => fail(`boom from ${prefix}\n`, 2));

      const outcome = await h.runner.run(INPUT);

      expect(outcome).toMatchObject({ kind: 'failed', reason });
      expect(outcome.log).toContain(`boom from ${prefix}`);
      expect(outcome.log).toContain('exit 2');
      const ran = commands(h.calls);
      expect(ran[ran.length - 1]?.startsWith(prefix)).toBe(true);
      expect(h.calls.some((call) => call.op === 'get')).toBe(false);
      expect(removed(h.calls)).toBe(1);
    },
  );

  it('fails output-too-large when the archive is over the download cap', async () => {
    h.archive = () => Promise.reject(new BuildSandboxError('too-large', 'over'));

    const outcome = await h.runner.run(INPUT);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'output-too-large' });
    expect(removed(h.calls)).toBe(1);
  });

  it('fails no-output for an archive with no regular file', async () => {
    h.archive = tarOf(member('./', '', '5'));

    const outcome = await h.runner.run(INPUT);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'no-output' });
    expect(removed(h.calls)).toBe(1);
  });

  it('fails platform for a malformed archive', async () => {
    h.archive = Buffer.alloc(700, 1);

    const outcome = await h.runner.run(INPUT);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'platform' });
    expect(removed(h.calls)).toBe(1);
  });

  it('fails platform, creating nothing, when the template declares no build', async () => {
    h.build = undefined;

    const outcome = await h.runner.run(INPUT);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'platform' });
    expect(h.calls.some((call) => call.op === 'create')).toBe(false);
  });

  it('refuses an output directory that is not a plain relative path, before any sandbox', async () => {
    h.build = { command: 'npm run build', output: 'dist; rm -rf /' };

    const outcome = await h.runner.run(INPUT);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'platform' });
    expect(h.calls.some((call) => call.op === 'create')).toBe(false);
  });

  it('refuses a git sha that is not 40 hex characters, before any sandbox', async () => {
    const outcome = await h.runner.run({ ...INPUT, gitSha: 'HEAD; true' });

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'platform' });
    expect(h.calls.some((call) => call.op === 'create')).toBe(false);
  });

  it('fails platform when the template has no published snapshot; nothing to remove', async () => {
    h.create = () => Promise.reject(new BuildSandboxError('not-published', 'none'));

    const outcome = await h.runner.run(INPUT);

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'platform' });
    expect(removed(h.calls)).toBe(0);
  });

  it('turns a sandbox that never started into a RetryableFailure', async () => {
    h.create = () => Promise.reject(new BuildSandboxError('not-started', 'slow'));

    await expect(h.runner.run(INPUT)).rejects.toBeInstanceOf(RetryableFailure);
    expect(removed(h.calls)).toBe(0);
  });

  it('rethrows any other create failure as it is', async () => {
    const error = new DaytonaError('upstream', 'create refused', 503);
    h.create = () => Promise.reject(error);

    await expect(h.runner.run(INPUT)).rejects.toBe(error);
    expect(removed(h.calls)).toBe(0);
  });

  it('rethrows a download failure other than the cap and still removes the sandbox', async () => {
    const error = new DaytonaError('unreachable', 'download cut');
    h.archive = () => Promise.reject(error);

    await expect(h.runner.run(INPUT)).rejects.toBe(error);
    expect(removed(h.calls)).toBe(1);
  });

  it('lets a bundle failure through untouched, before any sandbox exists', async () => {
    const error = new RetryableFailure('timeout');
    h.bundle = () => Promise.reject(error);

    await expect(h.runner.run(INPUT)).rejects.toBe(error);
    expect(h.calls.some((call) => call.op === 'create')).toBe(false);
  });

  it('rethrows a sandbox failure mid-build and still removes the sandbox', async () => {
    const error = new DaytonaError('upstream', 'daemon down', 502);
    h.answers.set('npm ci', () => Promise.reject(error));

    await expect(h.runner.run(INPUT)).rejects.toBe(error);
    expect(removed(h.calls)).toBe(1);
  });

  it('keeps the outcome when remove fails in finally (the reconciler reaps the orphan)', async () => {
    h.remove = () => Promise.reject(new DaytonaError('upstream', 'gone wrong', 500));

    const outcome: BuildOutcome = await h.runner.run(INPUT);

    expect(outcome.kind).toBe('built');
    expect(removed(h.calls)).toBe(1);
  });

  it('keeps the original error when remove also fails', async () => {
    const error = new Error('first');
    h.answers.set('npm run build', () => Promise.reject(error));
    h.remove = () => Promise.reject(new Error('second'));

    await expect(h.runner.run(INPUT)).rejects.toBe(error);
    expect(removed(h.calls)).toBe(1);
  });

  it('keeps only the tail of a long log, within the log_tail cap', async () => {
    const noise = 'x'.repeat(100 * 1024);
    h.answers.set('npm run build', () => fail(`${noise}\nthe last line\n`));

    const outcome = await h.runner.run(INPUT);

    expect(Buffer.byteLength(outcome.log, 'utf8')).toBeLessThanOrEqual(LOG_TAIL_MAX_BYTES);
    expect(outcome.log).toContain('the last line');
    expect(outcome.log).not.toContain('$ git init');
  });
});
