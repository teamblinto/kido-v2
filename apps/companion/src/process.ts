import {
  type ChildProcess,
  spawn,
  type SpawnOptions,
  spawnSync,
  type StdioOptions,
} from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, extname, join, resolve } from 'node:path';

import { scrub } from './log.ts';

/**
 * Spawning the person's CLIs (spec 040 § 7): no shell, hidden console windows, a process group on
 * POSIX so the whole tree can be killed, and the environment passed through (the CLI's own sign-in
 * is its business) minus the companion's own `BAIOS_*` settings, which no CLI needs.
 */

export interface ResolvedBinary {
  /** What is actually executed. */
  command: string;
  /** The resolved file, for display. */
  path: string;
  prefixArgs: string[];
  /** A Windows `.cmd`/`.bat` shim, run through `cmd.exe /d /s /c` with strict quoting. */
  viaCmd: boolean;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toResolved(
  path: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ResolvedBinary {
  const ext = extname(path).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, path, prefixArgs: [path], viaCmd: false };
  }
  if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return { command: envValue(env, 'COMSPEC') ?? 'cmd.exe', path, prefixArgs: [], viaCmd: true };
  }
  return { command: path, path, prefixArgs: [], viaCmd: false };
}

/**
 * The override if set (it must exist), else a PATH lookup. Windows honours `PATHEXT` and prefers a
 * real `.exe`/`.com` anywhere on PATH over a `.cmd`/`.bat` shim.
 */
export function resolveBinary(
  name: string,
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ResolvedBinary | null {
  if (override) return isFile(override) ? toResolved(resolve(override), platform, env) : null;
  const dirs = (envValue(env, 'PATH') ?? '').split(delimiter).filter(Boolean);
  if (platform === 'win32') {
    const exts = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((ext) => ext.toLowerCase())
      .filter(Boolean);
    const native = exts.filter((ext) => ext === '.exe' || ext === '.com');
    const shims = exts.filter((ext) => ext === '.cmd' || ext === '.bat');
    for (const group of [native, shims]) {
      for (const dir of dirs) {
        for (const ext of group) {
          const candidate = join(dir, name + ext);
          if (isFile(candidate)) return toResolved(candidate, platform, env);
        }
      }
    }
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (isFile(candidate)) return toResolved(candidate, platform, env);
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * One argument for a `cmd.exe /s /c "…"` line. Inside double quotes cmd treats `&|<>()^` as text;
 * what it still interprets (`"`, `%`, `!`, line breaks) is refused rather than escaped.
 */
export function quoteForCmd(arg: string): string {
  if (/["%!\r\n\0]/.test(arg)) {
    throw new Error('Argument contains a character that cannot be passed safely to cmd.exe.');
  }
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
}

export interface SpawnBinaryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** POSIX: own process group so `killTree` reaches grandchildren. Off for interactive logins. */
  group?: boolean;
  stdio?: StdioOptions;
}

/** `env` without any `BAIOS_*` variable (token file path, server URL, insecure flag, …). */
export function withoutBaiosVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^BAIOS_/i.test(key)));
}

export function spawnBinary(
  binary: ResolvedBinary,
  args: string[],
  options: SpawnBinaryOptions = {},
): ChildProcess {
  const base: SpawnOptions = {
    cwd: options.cwd,
    detached: process.platform !== 'win32' && options.group !== false,
    env: withoutBaiosVars(options.env ?? process.env),
    shell: false,
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
  let child: ChildProcess;
  if (binary.viaCmd) {
    const line = [binary.path, ...args].map(quoteForCmd).join(' ');
    child = spawn(binary.command, ['/d', '/s', '/c', `"${line}"`], {
      ...base,
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn(binary.command, [...binary.prefixArgs, ...args], base);
  }
  live.add(child);
  const forget = () => live.delete(child);
  child.once('exit', forget);
  child.once('error', forget);
  return child;
}

/** Every CLI process this companion started and that has not exited yet. */
const live = new Set<ChildProcess>();

/**
 * Kills every live child's process tree, synchronously, for `exit`, a crash or a second Ctrl+C,
 * where nothing async will run any more. Best effort.
 */
export function killAllChildrenSync(): void {
  for (const child of live) {
    if (hasExited(child) || child.pid === undefined) continue;
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      child.kill('SIGKILL');
    }
  }
  live.clear();
}

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves true once the child exits, false after `ms`. */
export function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((done) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      done(false);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      done(true);
    };
    child.once('exit', onExit);
  });
}

/** `taskkill /T /F` on Windows, the process group on POSIX. */
export async function killTree(child: ChildProcess): Promise<void> {
  if (hasExited(child) || child.pid === undefined) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise<void>((done) => {
      killer.once('exit', () => done());
      killer.once('error', () => done());
    });
    if (!hasExited(child)) child.kill();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Ends stdin, waits `graceMs` for a clean exit, then kills the tree. */
export async function shutdownChild(child: ChildProcess, graceMs: number): Promise<void> {
  child.stdin?.end();
  if (!(await waitForExit(child, graceMs))) await killTree(child);
}

/** The last lines of a child's stderr, ANSI-stripped and scrubbed, for crash messages. */
export class StderrTail {
  private lines: string[] = [];
  private partial = '';
  private readonly maxLines: number;

  constructor(maxLines = 20) {
    this.maxLines = maxLines;
  }

  push(chunk: Buffer | string): void {
    // eslint-disable-next-line no-control-regex
    const text = (this.partial + chunk.toString()).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    const parts = text.split(/\r?\n/);
    this.partial = (parts.pop() ?? '').slice(-2_000);
    for (const line of parts) {
      if (line.trim()) this.lines.push(line.slice(0, 500));
    }
    if (this.lines.length > this.maxLines) this.lines = this.lines.slice(-this.maxLines);
  }

  text(): string {
    const all = this.partial.trim() ? [...this.lines, this.partial.slice(0, 500)] : this.lines;
    return scrub(all.slice(-this.maxLines).join('\n'));
  }
}

/** Runs a short command and collects its output (for `--version` and status probes). */
export function runCapture(
  binary: ResolvedBinary,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((done, fail) => {
    let child: ChildProcess;
    try {
      child = spawnBinary(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 100_000) stderr += chunk.toString();
    });
    const timer = setTimeout(() => void killTree(child), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code, stderr, stdout });
    });
  });
}
