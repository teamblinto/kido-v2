/**
 * The sandbox port (spec 010, contracts/sandbox-port.md): the one boundary 011's tool broker
 * consumes. Addressed by `(orgId, projectId)` — never a Daytona id, URL or header — and bound by
 * `SandboxModule` under {@link SANDBOX_PORT}; `SandboxService` is the only implementation.
 *
 * Every method resolves the project's `sandboxes` row inside the caller's tenant transaction,
 * jails `path` to the row's `workspace_root`, and only then reaches the adapter. Throws
 * `SandboxGuardError` (a §04 guard) or `DaytonaError` (the wire) — `sandbox.errors.ts`; nothing
 * else escapes.
 */
import type { RunConfig, RunConfigInput } from '@repo/contracts';

export const SANDBOX_PORT = Symbol('forge.sandbox.port');

/** The project whose sandbox is meant. A Daytona id is never accepted here. */
export interface SandboxRef {
  readonly orgId: string;
  readonly projectId: string;
}

/**
 * Who is mutating and under which fence: `run_id/step_id` and the run's `lease_epoch` (spec 008).
 * Required on `edit` and `exec`, forwarded as headers on every request of the operation so a
 * stale worker's writes can be traced and, from 011, refused. A member's own operation (a
 * checkpoint diff or revert, spec 016) holds no lease: it carries epoch 0 and an operation id
 * named after the row, `diff/<id>` or `revert/<id>`.
 */
export interface MutationContext {
  readonly leaseEpoch: number;
  readonly operationId: `${string}/${string}`;
}

/** `kind: 'link'` when the entry's `realpath` differs from its own path — listed, never followed. */
export interface FileEntry {
  readonly kind: 'file' | 'directory' | 'link';
  readonly name: string;
  readonly size: number;
}

/** A full write, or one anchored replacement that must match exactly once. */
export type Edit =
  | { readonly path: string; readonly content: string }
  | { readonly path: string; readonly search: string; readonly replace: string };

export interface EditResult {
  /** Unified diff, `--- a/<path>` / `+++ b/<path>`, empty when nothing changed. */
  readonly diff: string;
  /** Size of the file after the edit. */
  readonly bytes: number;
}

/** stdout and stderr are one merged stream (research R2); a timeout carries no output at all. */
export type ExecResult =
  | {
      readonly timedOut: false;
      readonly exitCode: number;
      readonly output: string;
      readonly truncated: boolean;
    }
  | { readonly timedOut: true; readonly output: ''; readonly truncated: false };

export interface ContentMatch {
  readonly line: number;
  /** Relative to the workspace root. */
  readonly path: string;
  readonly text: string;
}

/**
 * The project's preview port and what its sandbox last said about it (spec 023,
 * contracts/preview-status-tool.md § 2). Three shapes because there are three truths: the template
 * declares no port; it declares one and nothing has ever been observed; it declares one and here is
 * the state that was seen and when. An absent observation is not a failure — `at` is the control
 * plane's clock, never the sandbox's.
 */
export type PreviewStatus =
  | { readonly port: null }
  | { readonly port: number; readonly observed: null }
  | {
      readonly port: number;
      readonly observed: {
        readonly state: 'installing' | 'starting' | 'listening' | 'failed';
        readonly at: string;
      };
    };

export interface SandboxPort {
  /** Whole file as UTF-8; refuses over `fileCapBytes`, refuses a directory or a missing path. */
  read(ref: SandboxRef, path: string, ctx?: MutationContext): Promise<string>;
  /** Whole file as bytes; refuses over `bundleCapBytes`, jailed like `read`. Requires `ctx` (spec 016). */
  download(ref: SandboxRef, path: string, ctx: MutationContext): Promise<Buffer>;
  /** Whole file from bytes; jailed like `download`, only under `.git/`, refuses over `bundleCapBytes` (spec 018). Requires `ctx`. */
  upload(ref: SandboxRef, path: string, body: Buffer, ctx: MutationContext): Promise<void>;
  /** Direct children, name-sorted; `kind: 'link'` when the entry resolves elsewhere. */
  list(ref: SandboxRef, path: string, ctx?: MutationContext): Promise<readonly FileEntry[]>;
  /** Full write or single-anchor replace; returns a unified diff. Requires `ctx`. */
  edit(ref: SandboxRef, edit: Edit, ctx: MutationContext): Promise<EditResult>;
  /** One allowlisted program, 120 s, 64 KiB head/tail. Requires `ctx`. */
  exec(ref: SandboxRef, command: string, ctx: MutationContext): Promise<ExecResult>;
  /** Substring content search under `path` (default root), capped, vendor paths excluded. */
  search(
    ref: SandboxRef,
    query: { readonly text: string; readonly path?: string },
    ctx?: MutationContext,
  ): Promise<readonly ContentMatch[]>;
  /** Base-name glob under `path` (default root), capped, vendor paths excluded. */
  find(
    ref: SandboxRef,
    query: { readonly glob: string; readonly path?: string },
    ctx?: MutationContext,
  ): Promise<readonly string[]>;
  /**
   * The declared preview port and the sandbox's last word on it (spec 023). The one method that
   * reaches no adapter — a manifest and a row are the whole answer — so it costs nothing and
   * still answers for a hibernated sandbox.
   */
  previewStatus(ref: SandboxRef, ctx?: MutationContext): Promise<PreviewStatus>;
  /** Spec 047: the tail of the dev server's (and install's) log; '' when there is none yet. */
  previewLogs(ref: SandboxRef, ctx?: MutationContext): Promise<string>;
  /**
   * Spec 047: replace the project's run profile and restart its dev server with it. `actorId` is
   * the run's person, for the audit trail. Answers the stored profile.
   */
  setRunConfig(
    ref: SandboxRef,
    input: RunConfigInput,
    ctx: MutationContext,
    actorId: string | null,
  ): Promise<RunConfig>;
}
