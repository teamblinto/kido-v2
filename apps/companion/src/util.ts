import { homedir } from 'node:os';

import { scrubTokens } from './log.ts';

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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pathPattern(path: string): RegExp | null {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return null;
  const prefix = /^[\\/]/.test(path) ? '[\\\\/]+' : '';
  const source = `${prefix}${segments.map(escapeRegExp).join('[\\\\/]+')}(?![A-Za-z0-9._-])`;
  return new RegExp(source, process.platform === 'win32' ? 'gi' : 'g');
}

/**
 * Prepares tool input or output for the server: the home directory becomes `~`, credential-shaped
 * strings are removed, and long strings are cut, at any depth.
 */
export function redactPaths(maxString = 8_000): <T>(value: T) => T {
  const home = pathPattern(homedir());
  const text = (value: string) =>
    truncate(scrubTokens(home ? value.replace(home, '~') : value), maxString);
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
