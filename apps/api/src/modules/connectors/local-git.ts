import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { type Plaintext, revealPlaintext } from '../../common/crypto/branded';
import type { Environment } from '../../config/environment';

/** Behind a token (plan III) so the consumers are unit-tested without a shell. */
export const LOCAL_GIT = Symbol('forge.connectors.localGit');

export const TEMP_PREFIX = 'forge-sync-';
export const GIT_TIMEOUT_MS = 120_000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
const STALE_AFTER_MS = 60 * 60 * 1000;

export type LocalGitReason = 'git-failed' | 'timed-out';

export class LocalGitError extends Error {
  constructor(
    readonly reason: LocalGitReason,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(`git ${reason}: ${stderr.trim().split('\n')[0] ?? ''}`);
    this.name = 'LocalGitError';
  }
}

export interface RunOptions {
  /** The installation token; it travels in the environment, never in argv (R1). */
  readonly auth?: Plaintext;
  readonly cwd: string;
}

export interface RunResult {
  readonly stderr: string;
  readonly stdout: string;
}

@Injectable()
export class LocalGit implements OnModuleInit {
  /**
   * The origin git talks to. On github.com the API lives on `api.github.com` but clones go to
   * `github.com`, which is `GITHUB_INSTALL_URL`; on GHES both are one host. The extraheader key
   * matches by URL prefix, so `remoteUrl` and the key MUST share this origin — never build a
   * remote URL elsewhere.
   */
  readonly gitOrigin: string;
  private readonly logger = new Logger(LocalGit.name);

  constructor(
    config: ConfigService<Environment, true>,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    this.gitOrigin = new URL(config.get('GITHUB_INSTALL_URL', { infer: true })).origin;
  }

  async onModuleInit(): Promise<void> {
    await this.sweepStale();
  }

  /** The one URL a consumer clones from or pushes to; the auth header is keyed to its origin. */
  remoteUrl(owner: string, name: string): string {
    return `${this.gitOrigin}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}.git`;
  }

  /** `0700`, named by the operation, removed in `finally`; a crash leaves it to `sweepStale`. */
  async withTempRepo<T>(operationId: string, fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), `${TEMP_PREFIX}${operationId}-`));

    await chmod(dir, 0o700);
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }

  async run(args: readonly string[], { auth, cwd }: RunOptions): Promise<RunResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

    // `GIT_TRACE*` / `GIT_CURL_VERBOSE` would print the extraheader — the token — to stderr.
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_TRACE') || key === 'GIT_CURL_VERBOSE') delete env[key];
    }

    if (auth !== undefined) {
      const basic = Buffer.from(`x-access-token:${revealPlaintext(auth).toString('utf8')}`);

      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = `http.${this.gitOrigin}/.extraheader`;
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic.toString('base64')}`;
    }

    try {
      return await new Promise<RunResult>((resolve, reject) => {
        execFile(
          'git',
          args,
          { cwd, env, maxBuffer: OUTPUT_CAP_BYTES, timeout: GIT_TIMEOUT_MS },
          (error: Error | null, stdout, stderr) => {
            if (error === null) resolve({ stderr, stdout });
            else reject(error);
          },
        );
      });
    } catch (error) {
      const failure = error as { code?: number | string; killed?: boolean; stderr?: string };
      const stderr = failure.stderr ?? String(error);

      throw new LocalGitError(
        failure.killed === true ? 'timed-out' : 'git-failed',
        stderr,
        typeof failure.code === 'number' ? failure.code : null,
      );
    }
  }

  /** `merge-base --is-ancestor a b`: exit 1 is the answer "no", every other failure is a failure. */
  async isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
    try {
      await this.run(['merge-base', '--is-ancestor', a, b], { cwd });

      return true;
    } catch (error) {
      if (error instanceof LocalGitError && error.exitCode === 1) return false;
      throw error;
    }
  }

  /** Removes `forge-sync-*` directories older than an hour — what a crashed worker left behind. */
  async sweepStale(): Promise<number> {
    const root = tmpdir();
    const cutoff = this.clock.now().getTime() - STALE_AFTER_MS;
    let swept = 0;

    for (const name of await readdir(root)) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const path = join(root, name);
      const info = await stat(path).catch(() => null);

      if (info === null || !info.isDirectory() || info.mtimeMs > cutoff) continue;
      await rm(path, { force: true, recursive: true });
      swept += 1;
    }
    if (swept > 0)
      this.logger.warn(`swept ${swept} stale sync director${swept === 1 ? 'y' : 'ies'}`);

    return swept;
  }
}
