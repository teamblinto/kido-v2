import { posix } from 'node:path';

import { SandboxGuardError } from './sandbox.errors';
import type { MutationContext } from './sandbox.port';

/**
 * The §04 guards as pure functions (spec 010 US2, research R4–R6): no Nest, no wire, so every
 * rule is proved without a server. `SandboxService` is the only caller; each refusal is a typed
 * `SandboxGuardError` thrown before any mutating request exists.
 */

/** `run_id/step_id` — two non-empty segments, one separator, so a log line reads back to a step. */
const OPERATION_ID = /^[^/]+\/[^/]+$/;

/**
 * FR-009: a mutation names its run, its step and the epoch its lease was on, or it does not
 * happen. Called first in `edit` and `exec`, before the row is read and before any request is
 * built, so a worker that forgot the context leaves nothing behind in the sandbox.
 */
export function assertMutationContext(
  ctx: MutationContext | undefined,
): asserts ctx is MutationContext {
  if (
    ctx === undefined ||
    typeof ctx.operationId !== 'string' ||
    !OPERATION_ID.test(ctx.operationId) ||
    !Number.isInteger(ctx.leaseEpoch) ||
    ctx.leaseEpoch < 0
  ) {
    throw new SandboxGuardError(
      'missing-mutation-context',
      'A mutation must name its operation and lease epoch.',
    );
  }
}

/**
 * The lexical half of the path jail (FR-004): a relative path, normalised, refused if absolute,
 * if it climbs out, or if it carries a NUL; joined to the root. The sandbox-side half is
 * {@link assertInsideRoot} on the daemon's `realpath` of the result.
 */
export function jailPath(root: string, input: string): string {
  const normalised = posix.normalize(input);
  if (
    input.includes('\0') ||
    posix.isAbsolute(input) ||
    normalised === '..' ||
    normalised.startsWith('../')
  ) {
    throw new SandboxGuardError('path-escape', 'The path leaves the workspace.', { path: input });
  }
  return posix.join(root, normalised);
}

/** The resolved path is the root or under it; `root + '/'` so a sibling named `root2` is outside. */
export function assertInsideRoot(root: string, resolved: string): void {
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new SandboxGuardError('path-escape', 'The path resolves outside the workspace.');
  }
}

/**
 * The daemon feeds the whole string to `bash` on stdin, so any of these runs a second program.
 * ponytail: a regex, not a shell parser — a quoted `;` is refused too; 011 asks if a real call needs one.
 */
export const SHELL_OPERATOR = /[;&|`$<>\n]|\$\(/;

/** FR-006: the program is the first token by base name, and the text carries no shell operator. */
export function checkCommand(command: string, allowlist: readonly string[]): void {
  const program = posix.basename(command.trim().split(/\s+/, 1)[0] ?? '');
  if (program === '' || SHELL_OPERATOR.test(command) || !allowlist.includes(program)) {
    throw new SandboxGuardError('command-not-allowed', 'The command is not allowed.', {
      program,
    });
  }
}

/**
 * Move `index` off a UTF-8 continuation byte to a character start — back for the head's end,
 * forward for the tail's start — so neither cut splits a character and neither half grows.
 */
const boundary = (buffer: Buffer, index: number, step: -1 | 1): number => {
  let at = index;
  while (at > 0 && at < buffer.length && (buffer[at]! & 0xc0) === 0x80) at += step;
  return at;
};

/**
 * FR-006: over the cap keep the head and the tail, half each, with a marker between naming the
 * bytes dropped. Counted in bytes on the UTF-8 buffer, cut on character boundaries.
 */
export function truncateOutput(
  buffer: Buffer,
  capBytes: number,
): { output: string; truncated: boolean } {
  if (buffer.length <= capBytes) return { output: buffer.toString('utf8'), truncated: false };

  const half = Math.floor(capBytes / 2);
  const headEnd = boundary(buffer, half, -1);
  const tailStart = boundary(buffer, buffer.length - (capBytes - half), 1);
  const dropped = tailStart - headEnd;

  return {
    output:
      `${buffer.subarray(0, headEnd).toString('utf8')}\n…[${dropped} bytes dropped]…\n` +
      buffer.subarray(tailStart).toString('utf8'),
    truncated: true,
  };
}

/**
 * FR-005: the anchor must occur exactly once, counted without overlap; one match is one match, and
 * the replacement is never rescanned. Exact bytes, no trimming — 011's prompt asks for that.
 */
export function applyAnchorEdit(current: string, search: string, replace: string): string {
  let matches = 0;
  let first = -1;
  for (let at = search === '' ? -1 : current.indexOf(search); at !== -1;) {
    if (matches === 0) first = at;
    matches += 1;
    at = current.indexOf(search, at + search.length);
  }

  if (matches === 0) {
    throw new SandboxGuardError('anchor-not-found', 'The anchor matches nowhere in the file.', {
      matches,
    });
  }
  if (matches > 1) {
    throw new SandboxGuardError('anchor-ambiguous', 'The anchor matches more than once.', {
      matches,
    });
  }
  return current.slice(0, first) + replace + current.slice(first + search.length);
}

/** FR-005: neither the current file nor the result may exceed the cap. */
export function assertFileSize(bytes: number, cap: number): void {
  if (bytes > cap) {
    throw new SandboxGuardError('file-too-large', 'The file exceeds the size cap.', { bytes, cap });
  }
}

/**
 * FR-007: at most `cap` results, none under an excluded directory wherever it sits in the tree.
 * Binary files are the daemon's own exclusion (research R2). Paths are root-relative.
 */
export function filterSearch<T extends string | { readonly path: string }>(
  matches: readonly T[],
  options: { readonly cap: number; readonly excludes: readonly string[] },
): T[] {
  const pathOf = (match: T): string => (typeof match === 'string' ? match : match.path);
  return matches
    .filter(
      (match) => !options.excludes.some((prefix) => `/${pathOf(match)}`.includes(`/${prefix}`)),
    )
    .slice(0, options.cap);
}
