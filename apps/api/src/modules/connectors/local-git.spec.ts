import { execFile, execFileSync } from 'node:child_process';
import type * as ChildProcess from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { plaintext } from '../../common/crypto/branded';
import type { Environment } from '../../config/environment';
import { GIT_TIMEOUT_MS, LocalGit, LocalGitError, TEMP_PREFIX } from './local-git';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();

  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const execFileMock = vi.mocked(execFile);

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });

    return true;
  } catch {
    console.log('SKIPPING local-git: no git on PATH');

    return false;
  }
}

const TOKEN = `ghs_${'secret'.repeat(6)}`;
const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q'];

function gitOf(installUrl = 'https://github.com/'): LocalGit {
  return new LocalGit({ get: () => installUrl } as unknown as ConfigService<Environment, true>, {
    now: () => new Date(),
  });
}

describe.skipIf(!hasGit())('LocalGit', () => {
  let scratch: string;
  let remote: string;
  const git = gitOf();

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'local-git-spec-'));
    remote = join(scratch, 'remote.git');
    await git.run(['init', '--bare', '-b', 'main', remote], { cwd: scratch });
  });

  afterAll(async () => {
    await rm(scratch, { force: true, recursive: true });
  });

  afterEach(() => {
    execFileMock.mockClear();
  });

  it('remoteUrl and the auth header key share the install origin, not the API origin', () => {
    expect(git.gitOrigin).toBe('https://github.com');
    expect(git.remoteUrl('acme', 'forge')).toBe('https://github.com/acme/forge.git');
    expect(gitOf('https://ghes.example/').remoteUrl('a', 'b')).toBe('https://ghes.example/a/b.git');
  });

  it('withTempRepo makes a 0700 forge-sync-* directory and removes it even when fn throws', async () => {
    let seen = '';

    await expect(
      git.withTempRepo('op-1', async (dir) => {
        seen = dir;
        expect(dir.startsWith(join(tmpdir(), `${TEMP_PREFIX}op-1-`))).toBe(true);
        if (process.platform !== 'win32') expect((await stat(dir)).mode & 0o777).toBe(0o700);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(stat(seen)).rejects.toThrow();
  });

  it('runs a real push and pull round trip against a bare remote', async () => {
    const sha = await git.withTempRepo('op-2', async (dir) => {
      const work = join(dir, 'work');

      await git.run(['clone', '-q', remote, work], { cwd: dir });
      await writeFile(join(work, 'a.txt'), 'a\n');
      await git.run(['add', 'a.txt'], { cwd: work });
      await git.run([...COMMIT, '-m', 'first'], { cwd: work });
      const head = (await git.run(['rev-parse', 'HEAD'], { cwd: work })).stdout.trim();

      await git.run(['push', '-q', 'origin', `${head}:refs/heads/main`], { cwd: work });

      return head;
    });

    const { stdout } = await git.run(['rev-parse', 'refs/heads/main'], { cwd: remote });

    expect(stdout.trim()).toBe(sha);
    expect(await git.isAncestor(remote, sha, sha)).toBe(true);
  });

  it('isAncestor answers false on exit 1 and throws on anything else', async () => {
    const head = (await git.run(['rev-parse', 'HEAD'], { cwd: remote })).stdout.trim();

    await git.withTempRepo('op-3', async (dir) => {
      const other = join(dir, 'other');

      await git.run(['init', '-q', '-b', 'main', other], { cwd: dir });
      await git.run([...COMMIT, '--allow-empty', '-m', 'x'], { cwd: other });
      const unrelated = (await git.run(['rev-parse', 'HEAD'], { cwd: other })).stdout.trim();

      await git.run(['fetch', '-q', remote, 'main'], { cwd: other });
      await expect(git.isAncestor(other, unrelated, head)).resolves.toBe(false);
      await expect(git.isAncestor(other, head, unrelated)).resolves.toBe(false);
    });
    await expect(git.isAncestor(remote, 'no-such-ref', head)).rejects.toMatchObject({
      reason: 'git-failed',
    });
  });

  it('classifies a failing command as git-failed with its stderr', async () => {
    const error: unknown = await git
      .run(['rev-parse', '--verify', 'nope'], { cwd: remote })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LocalGitError);
    expect(error).toMatchObject({ reason: 'git-failed' });
    expect((error as LocalGitError).stderr).toContain('fatal');
    expect((error as LocalGitError).exitCode).not.toBe(0);
  });

  it('classifies a killed child as timed-out', async () => {
    execFileMock.mockImplementationOnce(((
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (error: unknown) => void,
    ) => {
      callback(Object.assign(new Error('killed'), { killed: true, stderr: '' }));
    }) as never);

    await expect(git.run(['status'], { cwd: remote })).rejects.toMatchObject({
      reason: 'timed-out',
    });
  });

  it('carries the token in the environment header only — never in argv', async () => {
    await git.run(['rev-parse', 'HEAD'], { auth: plaintext(TOKEN), cwd: remote });

    const [file, args, options] = execFileMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; timeout: number },
    ];

    expect(file).toBe('git');
    expect(JSON.stringify(args)).not.toContain(TOKEN);
    expect(options.timeout).toBe(GIT_TIMEOUT_MS);
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(options.env.GIT_CONFIG_COUNT).toBe('2');
    expect(options.env.GIT_CONFIG_KEY_1).toBe('http.https://github.com/.extraheader');
    expect(options.env.GIT_CONFIG_VALUE_1).toBe(
      `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
    );
  });

  it('forwards no GIT_TRACE* or GIT_CURL_VERBOSE from the parent: they would print the header', async () => {
    vi.stubEnv('GIT_TRACE', '1');
    vi.stubEnv('GIT_TRACE_CURL', '1');
    vi.stubEnv('GIT_CURL_VERBOSE', '1');

    await git.run(['rev-parse', 'HEAD'], { auth: plaintext(TOKEN), cwd: remote });

    const options = execFileMock.mock.lastCall?.[2] as unknown as { env: NodeJS.ProcessEnv };

    expect(Object.keys(options.env).filter((key) => key.startsWith('GIT_TRACE'))).toEqual([]);
    expect(options.env.GIT_CURL_VERBOSE).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('sets no auth header without a token', async () => {
    await git.run(['rev-parse', 'HEAD'], { cwd: remote });

    const options = execFileMock.mock.calls[0]?.[2] as unknown as { env: NodeJS.ProcessEnv };

    // Spec 044: no credential, and no ambient helper either.
    expect(options.env.GIT_CONFIG_COUNT).toBe('1');
    expect(options.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(options.env.GIT_CONFIG_VALUE_0).toBe('');
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('sweepStale on module init removes forge-sync-* older than an hour and keeps fresh ones', async () => {
    const stale = await mkdtemp(join(tmpdir(), `${TEMP_PREFIX}stale-`));
    const fresh = await mkdtemp(join(tmpdir(), `${TEMP_PREFIX}fresh-`));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    await mkdir(join(stale, 'nested'));
    await utimes(stale, twoHoursAgo, twoHoursAgo);
    try {
      await git.onModuleInit();
      await expect(stat(stale)).rejects.toThrow();
      await expect(stat(fresh)).resolves.toBeTruthy();
      const left = await readdir(tmpdir());

      expect(left.some((n) => n.startsWith(`${TEMP_PREFIX}stale-`))).toBe(false);
    } finally {
      await rm(fresh, { force: true, recursive: true });
      await rm(stale, { force: true, recursive: true });
    }
  });
});
