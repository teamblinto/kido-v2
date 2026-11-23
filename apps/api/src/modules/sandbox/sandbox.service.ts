import { Inject, Injectable, Optional } from '@nestjs/common';
import { type RunConfig, type RunConfigInput, runConfigSchema } from '@repo/contracts';
import { projects, sandboxes } from '@repo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { posix } from 'node:path';
import { z } from 'zod';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import { TenantContext } from '../../database/tenant-context';
import type { TenantTransaction } from '../../database/database.types';
import { AuditService } from '../audit/audit.service';
import { OutboxWriter } from '../outbox/outbox-writer';
import { ProjectService } from '../tenancy/services/project.service';
import { DaytonaAdapter } from './daytona.adapter';
import { parseRunConfig, resolveDevPort } from './run-config';
import {
  applyAnchorEdit,
  assertFileSize,
  assertInsideRoot,
  assertMutationContext,
  checkCommand,
  filterSearch,
  jailPath,
  truncateOutput,
} from './sandbox-guards';
import { DAYTONA_TIMINGS, type DaytonaTimings, SANDBOX_DEV_LOG_PATH } from './sandbox.constants';

/** Spec 047: enough of the log to hold a stack trace and the install output before it. */
export const PREVIEW_LOG_TAIL_BYTES = 12 * 1024;
import { SandboxGuardError } from './sandbox.errors';
import type {
  ContentMatch,
  Edit,
  EditResult,
  ExecResult,
  FileEntry,
  MutationContext,
  PreviewStatus,
  SandboxPort,
  SandboxRef,
} from './sandbox.port';
import { SandboxLifecycleService } from './sandbox-lifecycle';
import { TemplateCatalogue } from './template-catalogue';
import { unifiedDiff } from './unified-diff';

/** Postgres's `unique_violation` — one sandbox per project, one project per Daytona id. */
const UNIQUE_VIOLATION = '23505';

/**
 * The one `sandboxes.ports` entry 017's callback writes (spec 023 data-model § 2). Anything else
 * under that key — a shape from before this schema, or nothing at all — is "never observed", which
 * `previewStatus` says in its own words rather than mistaking for a failure.
 */
const observationSchema = z.strictObject({
  observedAt: z.iso.datetime(),
  state: z.enum(['installing', 'listening', 'starting', 'failed']),
});

/** What the port needs from the row: which Daytona sandbox, and the root every path is jailed to. */
interface Located {
  readonly daytonaId: string;
  readonly root: string;
}

/**
 * The `SANDBOX_PORT` implementation (spec 010): the project's `sandboxes` row under the caller's
 * tenant transaction, then the §04 guards, then the adapter, then the answer in the port's own
 * types. The only file that knows the table; the adapter is the only one that knows a URL.
 */
@Injectable()
export class SandboxService implements SandboxPort {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DaytonaAdapter) private readonly daytona: DaytonaAdapter,
    @Inject(DAYTONA_TIMINGS) private readonly timings: DaytonaTimings,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(SandboxLifecycleService) private readonly lifecycle: SandboxLifecycleService,
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    // Spec 047: a changed run profile restarts the dev server through `project.env.changed`.
    @Optional() @Inject(OutboxWriter) private readonly outbox?: OutboxWriter,
  ) {}

  /**
   * Registration (US3, contracts/sandbox-port.md § Registration) — not on the port; the script is
   * the only caller. Daytona is asked first, so a sandbox it does not know or has stopped writes
   * nothing; the row and its audit entry then live or die together in the caller's transaction.
   */
  async register(
    tx: TenantTransaction,
    entry: { readonly daytonaId: string; readonly orgId: string; readonly projectId: string },
  ): Promise<{ id: string; node: string | null; workspaceRoot: string }> {
    const { daytonaId, orgId, projectId } = entry;
    await this.projects.read(orgId, projectId);
    const node = (await this.daytona.lookup(daytonaId)).runnerId ?? null;
    const workspaceRoot = await this.daytona.workDir(daytonaId);
    // Registered is seen and entered now (014 FR-011): the sweep's two clocks start here.
    const now = this.clock.now();

    let id: string;
    try {
      const [row] = await tx
        .insert(sandboxes)
        .values({
          daytonaId,
          lastSeenAt: now,
          node,
          orgId,
          projectId,
          stateEnteredAt: now,
          workspaceRoot,
        })
        .returning({ id: sandboxes.id });
      id = row!.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          'This project already has a sandbox, or this Daytona sandbox is already registered.',
        );
      }
      throw error;
    }

    await this.audit.record(tx, {
      action: 'sandbox.registered',
      actorId: null,
      metadata: { daytonaId, node, projectId },
      orgId,
      target: id,
    });

    return { id, node, workspaceRoot };
  }

  async read(ref: SandboxRef, path: string, ctx?: MutationContext): Promise<string> {
    const box = await this.resolve(ref);
    const { target } = await this.locate(box, path, ctx);

    return (await this.fetch(box, target, ctx)).toString('utf8');
  }

  /** `read` without the decode and under the bundle cap (spec 016): a checkpoint's bundle. */
  async download(ref: SandboxRef, path: string, ctx: MutationContext): Promise<Buffer> {
    assertMutationContext(ctx);
    const box = await this.resolve(ref);
    const { target } = await this.locate(box, path, ctx);

    return this.fetch(box, target, ctx, this.timings.bundleCapBytes);
  }

  /**
   * `download`'s mirror image (spec 018 R6): a pull bundle written under `.git/` only, refused
   * over the bundle cap before the jail's `realpath` — the path may not exist yet.
   */
  async upload(ref: SandboxRef, path: string, body: Buffer, ctx: MutationContext): Promise<void> {
    assertMutationContext(ctx);
    if (!posix.normalize(path).startsWith('.git/')) {
      throw new SandboxGuardError('path-outside-git', 'An upload lands under `.git/` only.', {
        path,
      });
    }
    if (body.length > this.timings.bundleCapBytes) {
      throw new SandboxGuardError('bundle-too-large', 'The bundle exceeds the size cap.', {
        bytes: body.length,
        cap: this.timings.bundleCapBytes,
      });
    }
    const box = await this.resolve(ref);
    const { target } = await this.locate(box, path, ctx, true);
    await this.daytona.upload(box.daytonaId, target, body, ctx);
  }

  /**
   * One `files` call and one batched `realpath` (research R4): the daemon `stat`s through links,
   * so an entry whose real path is not its own is reported as `link` and never followed.
   */
  async list(ref: SandboxRef, path: string, ctx?: MutationContext): Promise<readonly FileEntry[]> {
    const box = await this.resolve(ref);
    const { target: dir } = await this.locate(box, path, ctx);
    const entries = [...(await this.daytona.list(box.daytonaId, dir, ctx))].sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    const own = entries.map((entry) => posix.join(dir, entry.name));
    const real = await this.daytona.realpaths(box.daytonaId, own, ctx);

    return entries.map((entry, index) => ({
      kind: real[index] !== own[index] ? 'link' : entry.isDir ? 'directory' : 'file',
      name: entry.name,
      size: entry.size,
    }));
  }

  async edit(ref: SandboxRef, edit: Edit, ctx: MutationContext): Promise<EditResult> {
    assertMutationContext(ctx);
    const box = await this.resolve(ref);
    const { exists, target } = await this.locate(box, edit.path, ctx, 'content' in edit);
    const before = exists ? (await this.fetch(box, target, ctx)).toString('utf8') : null;
    const after =
      'content' in edit ? edit.content : applyAnchorEdit(before ?? '', edit.search, edit.replace);
    const bytes = Buffer.from(after, 'utf8');
    assertFileSize(bytes.length, this.timings.fileCapBytes);

    await this.daytona.upload(box.daytonaId, target, bytes, ctx);

    return { bytes: bytes.length, diff: unifiedDiff(before, after, edit.path) };
  }

  async exec(ref: SandboxRef, command: string, ctx: MutationContext): Promise<ExecResult> {
    assertMutationContext(ctx);
    checkCommand(command, this.timings.execAllowlist);
    const box = await this.resolve(ref);
    const outcome = await this.daytona.execute(
      box.daytonaId,
      { command, cwd: box.root, timeoutSeconds: this.timings.execWallClockMs / 1000 },
      ctx,
    );
    if (outcome.timedOut) return { output: '', timedOut: true, truncated: false };

    const { output, truncated } = truncateOutput(
      Buffer.from(outcome.result, 'utf8'),
      this.timings.outputCapBytes,
    );
    return { exitCode: outcome.exitCode, output, timedOut: false, truncated };
  }

  async search(
    ref: SandboxRef,
    query: { readonly text: string; readonly path?: string },
    ctx?: MutationContext,
  ): Promise<readonly ContentMatch[]> {
    const box = await this.resolve(ref);
    const { target: dir } = await this.locate(box, query.path ?? '.', ctx);
    const matches = await this.daytona.find(box.daytonaId, dir, query.text, ctx);

    return filterSearch(
      matches.map((match) => ({
        line: match.line,
        path: posix.relative(box.root, match.file),
        text: match.content,
      })),
      { ...this.searchBounds, within: posix.relative(box.root, dir) },
    );
  }

  async find(
    ref: SandboxRef,
    query: { readonly glob: string; readonly path?: string },
    ctx?: MutationContext,
  ): Promise<readonly string[]> {
    const box = await this.resolve(ref);
    const { target: dir } = await this.locate(box, query.path ?? '.', ctx);
    const files = await this.daytona.search(box.daytonaId, dir, query.glob, ctx);

    return filterSearch(
      files.map((file) => posix.relative(box.root, file)),
      { ...this.searchBounds, within: posix.relative(box.root, dir) },
    );
  }

  /**
   * The preview's declared port and the sandbox's last word on it (spec 023,
   * contracts/preview-status-tool.md § 2). `ProjectService.read` first, as every other method
   * does — a foreign or archived project is "no sandbox" here too — then the manifest's `devPort`
   * and the row's `ports` entry, both under the caller's transaction.
   *
   * `resolve` is deliberately not used: it refuses a `hibernated` row and touches the lifecycle
   * clocks, and neither belongs to a question that reads a row and a manifest. Nothing here
   * reaches Daytona, so the answer costs nothing and a sleeping sandbox still has one. `ctx` is
   * taken for the port's shape and goes nowhere, because there is no request to fence.
   */
  /**
   * Spec 047: the tail of the supervisor's log — the dev server's and the install's merged output.
   * The file is outside the workspace jail and the agent's allowlist, so this is the one way to it;
   * a fixed command with no tenant input, read-only, and '' when the file does not exist yet.
   */
  async previewLogs(ref: SandboxRef, ctx?: MutationContext): Promise<string> {
    const box = await this.resolve(ref);
    const outcome = await this.daytona.execute(
      box.daytonaId,
      {
        command: `tail -c ${String(PREVIEW_LOG_TAIL_BYTES)} ${SANDBOX_DEV_LOG_PATH} 2>/dev/null || true`,
        cwd: box.root,
        timeoutSeconds: 10,
      },
      ctx,
    );

    return outcome.timedOut ? '' : outcome.result;
  }

  /**
   * Spec 047: the agent's `set_run_config`. Validated by the same schema detection writes through,
   * stored with `source: 'agent'`, audited, and applied by `project.env.changed` — the event that
   * already restarts a running dev server with a fresh delivery (and is a no-op for a sleeping one,
   * whose resume reads the profile anyway). `repairs` carries over: a fix the agent made is still
   * inside the streak that asked for it.
   */
  async setRunConfig(
    ref: SandboxRef,
    input: RunConfigInput,
    ctx: MutationContext,
    actorId: string | null,
  ): Promise<RunConfig> {
    assertMutationContext(ctx);
    try {
      await this.projects.read(ref.orgId, ref.projectId);
    } catch (error) {
      if (error instanceof NotFoundError) throw noSandbox();
      throw error;
    }

    const tx = this.tenant.tx;
    const row = await tx.query.projects.findFirst({
      columns: { runConfig: true },
      where: and(eq(projects.orgId, ref.orgId), eq(projects.id, ref.projectId)),
    });
    const current = parseRunConfig(row?.runConfig);
    const next = runConfigSchema.parse({
      ...input,
      env: input.env ?? current?.env ?? [],
      repairs: current?.repairs ?? 0,
      root: input.root ?? current?.root ?? '.',
      source: 'agent',
      stack: input.stack ??
        current?.stack ?? { framework: null, language: 'unknown', packageManager: null },
    });

    await tx
      .update(projects)
      .set({ runConfig: next, updatedAt: this.clock.now() })
      .where(and(eq(projects.orgId, ref.orgId), eq(projects.id, ref.projectId)));
    await this.audit.record(tx, {
      action: 'project.run-config-changed',
      actorId,
      metadata: { dev: next.dev, install: next.install, port: next.port, root: next.root },
      orgId: ref.orgId,
      target: ref.projectId,
    });
    await this.outbox?.append(tx, {
      aggregateId: ref.projectId,
      orgId: ref.orgId,
      payload: { orgId: ref.orgId, projectId: ref.projectId },
      type: 'project.env.changed',
    });

    return next;
  }

  async previewStatus(ref: SandboxRef, _ctx?: MutationContext): Promise<PreviewStatus> {
    try {
      await this.projects.read(ref.orgId, ref.projectId);
    } catch (error) {
      if (error instanceof NotFoundError) throw noSandbox();
      throw error;
    }

    // `ProjectSummary` carries no template (§11: the summary is what a guest may see), so the
    // column is read here, under the tenant transaction the check just passed.
    const project = await this.tenant.tx.query.projects.findFirst({
      columns: { runConfig: true, template: true },
      where: and(
        eq(projects.orgId, ref.orgId),
        eq(projects.id, ref.projectId),
        isNull(projects.deletedAt),
      ),
    });
    const port = project === undefined ? undefined : resolveDevPort(this.catalogue, project);
    if (port === undefined) return { port: null };

    const row = await this.tenant.tx.query.sandboxes.findFirst({
      columns: { ports: true },
      where: and(eq(sandboxes.orgId, ref.orgId), eq(sandboxes.projectId, ref.projectId)),
    });
    const observed = observationSchema.safeParse(portEntry(row?.ports, port));
    if (!observed.success) return { observed: null, port };

    return { observed: { at: observed.data.observedAt, state: observed.data.state }, port };
  }

  private get searchBounds(): { cap: number; excludes: readonly string[] } {
    return { cap: this.timings.searchCap, excludes: this.timings.searchExcludes };
  }

  /**
   * `ProjectService.read` first — RLS and `deleted_at is null` already hide a foreign or archived
   * project, and both are "no sandbox" to the caller — then the touch (014 contract § 1: every
   * port call is a sign of use, and it flips `idle → active` before the call is served, FR-004),
   * then the row under the same transaction. A row mid-transition or `hibernated` is refused
   * naming the state (FR-008/FR-009), never resumed from here; so is a lost one, which a wake
   * replaces.
   */
  private async resolve(ref: SandboxRef): Promise<Located> {
    try {
      await this.projects.read(ref.orgId, ref.projectId);
    } catch (error) {
      if (error instanceof NotFoundError) throw noSandbox();
      throw error;
    }

    await this.lifecycle.touch(this.tenant.tx, ref);
    const row = await this.tenant.tx.query.sandboxes.findFirst({
      where: and(eq(sandboxes.orgId, ref.orgId), eq(sandboxes.projectId, ref.projectId)),
    });
    if (row === undefined) throw noSandbox();
    // Not "no sandbox": a wake replaces it and restores the workspace, so callers offer one.
    if (row.lostAt !== null) {
      throw new SandboxGuardError('sandbox-not-ready', 'The sandbox was lost.', { state: 'lost' });
    }
    if (row.transition !== null) {
      throw new SandboxGuardError('sandbox-not-ready', `The sandbox is ${row.transition}.`, {
        transition: row.transition,
      });
    }
    if (row.state === 'hibernated' || row.state === 'archived') {
      throw new SandboxGuardError('sandbox-not-ready', `The sandbox is ${row.state}.`, {
        state: row.state,
      });
    }
    // Null until the daemon answered `work-dir` (spec 014): the sandbox is still coming up.
    if (row.workspaceRoot === null) {
      throw new SandboxGuardError('sandbox-not-ready', 'The sandbox is still starting.');
    }

    return { daytonaId: row.daytonaId, root: row.workspaceRoot };
  }

  /**
   * The path jail (FR-004, research R4): the lexical check, then one `realpath -e` through the
   * daemon — of the target, or of its nearest existing ancestor when the file may not exist yet —
   * re-checked against the root. Every later call names the resolved path, so a link swapped in between cannot
   * redirect it. A path that must exist and does not is `path-not-found` without another request.
   */
  private async locate(
    box: Located,
    path: string,
    ctx: MutationContext | undefined,
    mayBeNew = false,
  ): Promise<{ exists: boolean; target: string }> {
    const joined = jailPath(box.root, path);
    const resolved = await this.daytona.realpath(box.daytonaId, joined, ctx);
    if (resolved !== undefined) {
      assertInsideRoot(box.root, resolved);
      return { exists: true, target: resolved };
    }

    if (!mayBeNew) {
      throw new SandboxGuardError('path-not-found', 'No such path in the sandbox.', { path });
    }
    // A new file may sit in directories that do not exist yet — the upload creates them, as a
    // save of `src/new.ts` into a tree with no `src` needs. So walk up to the nearest ancestor
    // that exists and jail *that*: every component below it is missing, so none of them can be a
    // link, and the lexical check has already kept them from climbing: `joined` is under the
    // root, so the walk ends at the root at the latest.
    const missing = [posix.basename(joined)];
    let ancestor = posix.dirname(joined);
    for (;;) {
      const real = await this.daytona.realpath(box.daytonaId, ancestor, ctx);
      if (real !== undefined) {
        assertInsideRoot(box.root, real);
        return { exists: false, target: posix.join(real, ...missing.reverse()) };
      }
      if (ancestor === box.root) {
        throw new SandboxGuardError('path-not-found', 'No such path in the sandbox.', { path });
      }
      missing.push(posix.basename(ancestor));
      ancestor = posix.dirname(ancestor);
    }
  }

  /** The bytes of a regular file under the cap: `info` first, so an oversize file is never fetched. */
  private async fetch(
    box: Located,
    target: string,
    ctx: MutationContext | undefined,
    cap = this.timings.fileCapBytes,
  ): Promise<Buffer> {
    const info = await this.daytona.info(box.daytonaId, target, ctx);
    if (info.isDir) {
      throw new SandboxGuardError('not-a-file', 'The path is a directory.', { path: target });
    }
    assertFileSize(info.size, cap);
    return this.daytona.download(box.daytonaId, target, ctx);
  }
}

/** `ports` is `jsonb`, so it is `unknown` until something reads a key out of it (data-model § 2). */
function portEntry(ports: unknown, port: number): unknown {
  if (typeof ports !== 'object' || ports === null) return undefined;
  return (ports as Record<string, unknown>)[String(port)];
}

const noSandbox = (): SandboxGuardError =>
  new SandboxGuardError('no-sandbox', 'This project has no sandbox.');

/** Drizzle wraps the driver error; the SQLSTATE is a bounded `cause` walk away (as `OrgService`). */
function isUniqueViolation(error: unknown): boolean {
  for (
    let cause = error, depth = 0;
    typeof cause === 'object' && cause !== null && depth < 5;
    depth++
  ) {
    if ((cause as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}
