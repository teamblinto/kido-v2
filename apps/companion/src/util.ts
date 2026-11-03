import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { scrubTokens } from './log.ts';

export const WORKSPACE_TOKEN = '<workspace>';

/** A push-driven async iterable: adapters push normalized events, the run manager iterates. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ done: false, value: item });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ done: false, value: item });
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

/** Jittered exponential backoff: 1 s, 2 s, 4 s … capped at 30 s, each scaled into [50 %, 100 %]. */
export function backoffDelay(attempt: number, baseMs = 1_000, maxMs = 30_000): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

/** Resolves after `ms`, or early (without rejecting) when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted) return done();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      done();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A path inside the workspace as forward-slash relative text, or null when it is the root itself
 * or lies outside it — absolute paths never leave the machine (ADR decision 5).
 */
export function toWorkspaceRelative(root: string, path: string): string | null {
  const rel = relative(root, isAbsolute(path) ? path : resolve(root, path));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

/**
 * Writes here can run code, or change what a tool does the next time someone opens the folder (git
 * hooks and config, editor and agent settings, CI, env files, package scripts), so they always need
 * an explicit approval, even in `acceptEdits`. Matched against the workspace-relative path.
 */
export const SENSITIVE_PATHS: readonly RegExp[] = [
  /(?:^|\/)\.(?:git|claude|codex|vscode|idea|husky)(?:\/|$)/i,
  /(?:^|\/)\.github\/workflows(?:\/|$)/i,
  /(?:^|\/)\.env[^/]*$/i,
  /(?:^|\/)(?:package\.json|\.npmrc|\.mcp\.json|\.gitmodules)$/i,
];

export const isSensitivePath = (relativePath: string): boolean =>
  SENSITIVE_PATHS.some((pattern) => pattern.test(relativePath));

/**
 * Where a write to `path` really lands, workspace-relative, or null when that is outside the
 * workspace or cannot be told safely. Symlink-safe: the nearest existing ancestor is resolved by the
 * OS and the missing rest appended. Hard-linked files and Windows names the OS would alias (trailing
 * dot or space, `:` streams) count as unsafe.
 */
export function resolveWriteTarget(root: string, path: string): string | null {
  const full = resolve(root, path);
  if (process.platform === 'win32' && /:|[. ](?:[\\/]|$)/.test(full.slice(2))) return null;
  try {
    let existing = full;
    const rest: string[] = [];
    for (;;) {
      try {
        const stat = lstatSync(existing);
        if (rest.length === 0 && stat.isFile() && stat.nlink > 1) return null;
        break;
      } catch {
        const parent = dirname(existing);
        if (parent === existing) return null;
        rest.unshift(basename(existing));
        existing = parent;
      }
    }
    const target = join(realpathSync.native(existing), ...rest);
    return toWorkspaceRelative(realpathSync.native(root), target);
  } catch {
    return null; // e.g. a dangling symlink
  }
}

/** True when an edit may be applied without asking: inside the workspace and not sensitive. */
export function isRoutineWrite(root: string, path: string): boolean {
  const target = resolveWriteTarget(root, path);
  return target !== null && !isSensitivePath(target);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pathPattern(path: string): RegExp | null {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return null;
  const prefix = /^[\\/]/.test(path) ? '[\\\\/]+' : '';
  const source = `${prefix}${segments.map(escapeRegExp).join('[\\\\/]+')}(?![A-Za-z0-9._-])`;
  return new RegExp(source, process.platform === 'win32' ? 'gi' : 'g');
}

/**
 * Prepares tool input or output for the server: the workspace root becomes `<workspace>` (visible,
 * unlike `.`, so `rm -rf <workspace>` reads as what it is), the home directory `~`, credential-shaped
 * strings are removed, and long strings are cut, at any depth. A null root rewrites only home.
 */
export function redactPaths(root: string | null, maxString = 8_000): <T>(value: T) => T {
  const patterns: [RegExp | null, string][] = [
    [root ? pathPattern(root) : null, WORKSPACE_TOKEN],
    [pathPattern(homedir()), '~'],
  ];
  const text = (value: string) => {
    let out = value;
    for (const [pattern, replacement] of patterns) {
      if (pattern) out = out.replace(pattern, replacement);
    }
    return truncate(scrubTokens(out), maxString);
  };
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return text(value);
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => walk(item, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, walk(item, depth + 1)]),
    );
  };
  return <T>(value: T) => walk(value, 0) as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
