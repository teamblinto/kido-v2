import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Sandbox, type SandboxPoolEntry, schema } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { QUEUE_REDIS } from '../../common/redis/redis.constants';
import type { Environment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { EventConsumer, RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { DaytonaAdapter } from './daytona.adapter';
import {
  DEFAULT_DEV_SERVER_TIMINGS,
  DEV_SERVER_TIMINGS,
  PREVIEW_ENV_SOURCE,
  type PreviewEnvSource,
  SANDBOX_CALLBACK_ENV_PATH,
  SANDBOX_PROJECT_ENV_PATH,
  SANDBOX_CALLBACK_MINTER,
  SANDBOX_DEV_SUPERVISOR_PATH,
  SANDBOX_OPS_QUEUE,
  SANDBOX_TIMINGS,
  type DevServerTimings,
  type SandboxCallbackMinter,
  type SandboxTimings,
  poolFrontKey,
} from './sandbox.constants';
import { DaytonaError } from './sandbox.errors';
import { TemplateCatalogue } from './template-catalogue';

type OpEvent = Envelope<'sandbox.op.requested'>;

/**
 * The launch returns in milliseconds — the first supervisor re-spawns itself detached and exits
 * (contracts/dev-supervisor § 2) — so ten seconds is a ceiling, not a budget.
 */
const DEV_LAUNCH_TIMEOUT_SECONDS = 10;

/** What `handle` re-read: a project row under its tenant, or a platform pool row. */
export type OpTarget =
  | { readonly kind: 'project'; readonly orgId: string; readonly row: Sandbox }
  | { readonly kind: 'pool'; readonly row: SandboxPoolEntry };

/** A template's dev server as the env file carries it: both fields, or the template declares none. */
interface DevServerDeclaration {
  readonly command: string;
  readonly port: string;
}

/** The readiness budget ran out while Daytona still answered another state — a retry, not a verdict. */
export class ReadinessTimeoutError extends Error {
  constructor(daytonaId: string, state: string) {
    super(`sandbox ${daytonaId} still ${state} after the readiness budget`);
    this.name = 'ReadinessTimeoutError';
  }
}

/**
 * The one consumer for every sandbox op (spec 014 contract § 4, research R5). `handle` re-reads the
 * row and returns `undefined` when the target state is already recorded (FR-010); `effect` drives
 * Daytona with no transaction held and then settles the record in its own transaction — tenant
 * for a project row, platform for a pool row — so the DLQ row and the record agree (FR-033).
 *
 * A `resume` carrying a `leaseEpoch` is stale when a newer `resume` for the same sandbox has been
 * recorded with a higher epoch: `agent_runs.lease_epoch` is another module's table, so the fence
 * the sandbox module can see is its own outbox trail (the same read the scheduler makes).
 */
@Injectable()
export class SandboxOpsConsumer extends EventConsumer<
  'sandbox.op.requested',
  OpTarget | undefined
> {
  readonly attempts = 5;
  override readonly concurrency = 16;
  readonly name = 'sandbox-ops';
  override readonly profile = 'events' as const;
  readonly queue = SANDBOX_OPS_QUEUE;
  readonly types = ['sandbox.op.requested'] as const;

  private readonly logger = new Logger(SandboxOpsConsumer.name);
  private readonly owner: string;
  private readonly callbackUrl: string;
  /** The supervisor's bytes, read from the image once per process and uploaded verbatim. */
  private supervisor: Buffer | undefined;

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(QUEUE_REDIS) private readonly redis: Redis,
    @Inject(DaytonaAdapter) private readonly daytona: DaytonaAdapter,
    @Inject(SANDBOX_TIMINGS) private readonly timings: SandboxTimings,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SANDBOX_CALLBACK_MINTER) private readonly mint: SandboxCallbackMinter,
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    config: ConfigService<Environment, true>,
    // Optional with a default, as `TEMPLATES_DIR` is on the catalogue: the numbers travel into the
    // sandbox on one env line, and a suite that binds the token shortens them without a second
    // mechanism (contracts/dev-supervisor § 1).
    @Optional()
    @Inject(DEV_SERVER_TIMINGS)
    private readonly devTimings: DevServerTimings = DEFAULT_DEV_SERVER_TIMINGS,
    // Spec 030 contracts/preview-env.md § 3: bound by `connectors`' global `PreviewEnvModule`. A
    // suite without it delivers an empty project file, which is what a project with no bindings
    // gets anyway.
    @Optional()
    @Inject(PREVIEW_ENV_SOURCE)
    private readonly previewEnv?: PreviewEnvSource,
  ) {
    super();
    this.owner = config.get('SANDBOX_OWNER', { infer: true });
    this.callbackUrl = config.get('SANDBOX_CALLBACK_URL', { infer: true });
  }

  override jobId(event: OpEvent): string {
    const { op, poolId, since, sandboxId } = event.payload;

    // `.` as `mailJobId` does: BullMQ refuses a custom id containing `:`, and a refused `add`
    // fails the relay's whole tick — every row behind this one waits forever.
    //
    // One job per transition cycle: requests for the same cycle collapse (a stop is asked for
    // once), and a later cycle, or the reconciler's retry of a stale one (it moves
    // `transition_since`), is a new job. Target and op alone let the first cycle's completed job,
    // kept a day by JOB_RETENTION, swallow every later hibernate: the row sat in `hibernating`
    // with every run refused (spec 043).
    const cycle = since === undefined ? '' : `.${String(Date.parse(since))}`;

    return `${sandboxId ?? poolId ?? 'none'}.${op}${cycle}`;
  }

  async handle(event: OpEvent, tx: TenantTransaction): Promise<OpTarget | undefined> {
    const target = await this.load(event, tx);

    if (target === undefined) {
      return undefined;
    }

    switch (event.payload.op) {
      case 'create':
        return inTransition(target, 'creating') ? target : undefined;
      case 'label':
      case 'release':
        return target;
      case 'hibernate':
        return target.kind === 'project' &&
          target.row.state !== 'hibernated' &&
          target.row.transition === 'hibernating'
          ? target
          : undefined;
      case 'resume':
        return target.kind === 'project' &&
          target.row.state === 'hibernated' &&
          target.row.transition === 'resuming' &&
          !(await this.staleEpoch(tx, target.row.id, event.payload.leaseEpoch))
          ? target
          : undefined;
    }
  }

  override async effect(event: OpEvent, target: OpTarget | undefined, attempt = 1): Promise<void> {
    if (target === undefined) {
      return;
    }

    try {
      switch (event.payload.op) {
        case 'create':
          await this.create(target);
          return;
        case 'label':
          await this.label(target);
          return;
        case 'hibernate':
          if (target.kind === 'project') await this.hibernate(target);
          return;
        case 'resume':
          if (target.kind === 'project') await this.resume(target);
          return;
        case 'release':
          await this.release(target);
          return;
      }
    } catch (error) {
      const retryable =
        error instanceof DaytonaError && error.retryable
          ? new RetryableFailure(error.kind === 'unreachable' ? 'timeout' : 'upstream-5xx', error)
          : error instanceof ReadinessTimeoutError
            ? new RetryableFailure('timeout', error)
            : undefined;

      // A retry keeps the record in transition (US5 scenario 2); the last attempt's failure is
      // dead-lettered, so the record is settled with it (FR-033) — and still thrown as retryable,
      // so the attempt chain reads as what happened.
      if (retryable !== undefined && attempt < this.attempts) {
        throw retryable;
      }

      // Daytona has no such sandbox: the record is a ghost until the next claim replaces it (FR-026).
      if (
        error instanceof DaytonaError &&
        error.kind === 'sandbox-not-found' &&
        target.kind === 'project'
      ) {
        await this.settleProject(target, { lostAt: this.clock.now() });
      }

      await this.settleFailure(target, error);
      throw retryable ?? error;
    }
  }

  /** The `create` row: wait for `started`, ask the daemon its work dir, record both. */
  private async create(target: OpTarget): Promise<void> {
    const { daytonaId } = target.row;
    const dto = await this.awaitState(daytonaId, 'started');
    const workspaceRoot = await this.daytona.workDir(daytonaId);
    const node = dto.runnerId ?? null;
    const now = this.clock.now();

    if (target.kind === 'project') {
      await this.deliverSandboxRuntime(target, workspaceRoot);
      await this.settleProject(target, {
        failureReason: null,
        node,
        state: 'active',
        stateEnteredAt: now,
        transition: null,
        transitionSince: null,
        workspaceRoot,
      });

      return;
    }

    await this.db
      .update(schema.sandboxPool)
      .set({ failureReason: null, node, readyAt: now, state: 'ready', workspaceRoot })
      .where(eq(schema.sandboxPool.id, target.row.id));
    await this.redis.rpush(poolFrontKey(target.row.template), target.row.id);
  }

  /** `stop`, wait for `stopped`, record it: the disk is the snapshot (research R1). */
  private async hibernate(target: Extract<OpTarget, { kind: 'project' }>): Promise<void> {
    await this.daytona.stop(target.row.daytonaId);
    await this.awaitState(target.row.daytonaId, 'stopped');
    const now = this.clock.now();

    await this.settleProject(target, {
      failureReason: null,
      hibernatedAt: now,
      state: 'hibernated',
      stateEnteredAt: now,
      transition: null,
      transitionSince: null,
    });
  }

  /** `start`, wait for `started`, ask the work dir again (the daemon may have moved), record active. */
  private async resume(target: Extract<OpTarget, { kind: 'project' }>): Promise<void> {
    const { daytonaId } = target.row;
    await this.daytona.start(daytonaId);
    const dto = await this.awaitState(daytonaId, 'started');
    const workspaceRoot = await this.daytona.workDir(daytonaId);
    await this.deliverSandboxRuntime(target, workspaceRoot);
    const now = this.clock.now();

    await this.settleProject(target, {
      failureReason: null,
      hibernatedAt: null,
      lastSeenAt: now,
      node: dto.runnerId ?? null,
      state: 'active',
      stateEnteredAt: now,
      transition: null,
      transitionSince: null,
      workspaceRoot,
    });
  }

  /** `DELETE ?force=true` (`404` is success), then the row goes; a project row leaves an audit entry. */
  private async release(target: OpTarget): Promise<void> {
    await this.daytona.remove(target.row.daytonaId);

    if (target.kind === 'pool') {
      await this.db.delete(schema.sandboxPool).where(eq(schema.sandboxPool.id, target.row.id));
      return;
    }

    const { daytonaId, id, projectId } = target.row;
    await this.transactions.runInTenantTransaction(target.orgId, async (tx) => {
      await tx.delete(schema.sandboxes).where(eq(schema.sandboxes.id, id));
      await this.audit.record(tx, {
        action: 'sandbox.released',
        actorId: null,
        metadata: { daytonaId, projectId },
        orgId: target.orgId,
        target: id,
      });
    });
  }

  /** A replace, not a merge (research R2): the whole map every time. */
  private async label(target: OpTarget): Promise<void> {
    if (target.kind !== 'project') {
      return;
    }

    const [project] = await this.transactions.runInTenantTransaction(target.orgId, (tx) =>
      tx
        .select({ template: schema.projects.template })
        .from(schema.projects)
        .where(eq(schema.projects.id, target.row.projectId)),
    );

    await this.daytona.setLabels(target.row.daytonaId, {
      'forge.kind': 'project',
      'forge.owner': this.owner,
      'forge.project': target.row.projectId,
      'forge.template': project?.template ?? '',
    });

    // A pool claim queues only `label`, against a sandbox already started: this is its delivery.
    // A cold claim's row is still `creating` here, and `create` delivers once it has started.
    if (target.row.transition !== 'creating')
      await this.deliverSandboxRuntime(target, target.row.workspaceRoot);
  }

  /**
   * Everything the sandbox needs to run itself, at each of the three moments a sandbox becomes
   * this project's (spec 023, contracts/dev-supervisor § 1): mint, upload the env file, upload the
   * supervisor, launch it.
   *
   * Spec 017 R11 owns the first two lines — the callback token is minted at claim and re-minted on
   * resume, and it reaches the sandbox as `FORGE_CALLBACK_TOKEN` / `FORGE_CALLBACK_URL` in
   * `SANDBOX_CALLBACK_ENV_PATH`. A file over the daemon rather than a container env, because a
   * pool sandbox is created before its project exists and a running env cannot be changed on
   * resume. The file is rewritten whole every time.
   *
   * A template that declares a dev server adds three lines to it and gets the supervisor and the
   * launch; one that declares none — `python` — gets the token alone, and nothing else changes for
   * it.
   */
  private async deliverSandboxRuntime(
    target: Extract<OpTarget, { kind: 'project' }>,
    workspaceRoot: string | null,
  ): Promise<void> {
    const token = await this.mint({
      leaseEpoch: 0,
      org: target.orgId,
      project: target.row.projectId,
      sandbox: target.row.daytonaId,
    });
    const dev = await this.devServer(target);
    const lines = [
      `FORGE_CALLBACK_TOKEN=${token}`,
      `FORGE_CALLBACK_URL=${this.callbackUrl}`,
      // Unquoted, one line each: `devCommand` is the template's own field, reviewed in this
      // repository, and the timings are numbers.
      ...(dev === undefined
        ? []
        : [
            `FORGE_DEV_COMMAND=${dev.command}`,
            `FORGE_DEV_PORT=${dev.port}`,
            `FORGE_DEV_TIMINGS=${JSON.stringify(this.devTimings)}`,
          ]),
    ];

    await this.daytona.upload(
      target.row.daytonaId,
      SANDBOX_CALLBACK_ENV_PATH,
      Buffer.from(`${lines.join('\n')}\n`),
    );
    await this.deliverProjectEnv(target);

    if (dev !== undefined) {
      // The last start's reports name a dev server this start does not have (a hibernated
      // `listening` would read as `ready` until the new `starting` lands, and the preview stage
      // would send the web to a frame nothing serves). Cleared before the launch, so every report
      // from here on is this start's.
      await this.settleProject(target, { ports: {} });
      await this.launchDevServer(target, dev, workspaceRoot);
    }
  }

  /**
   * Spec 030 contracts/preview-env.md § 1: the project's connector values, rewritten whole at the
   * same three moments as the callback file, empty when there are none (so a value an unbind
   * removed is gone at the next start). The source never throws; nothing here fails the claim.
   * The supervisor hands this file to the dev server child alone.
   */
  private async deliverProjectEnv(target: Extract<OpTarget, { kind: 'project' }>): Promise<void> {
    const values =
      this.previewEnv === undefined
        ? {}
        : await this.transactions.runInTenantTransaction(target.orgId, (tx) =>
            this.previewEnv!(tx, target.orgId, target.row.projectId),
          );
    const lines = Object.entries(values)
      .filter(([key]) => !key.startsWith('FORGE_'))
      .map(([key, value]) => `${key}=${value}`);

    await this.daytona.upload(
      target.row.daytonaId,
      SANDBOX_PROJECT_ENV_PATH,
      Buffer.from(lines.length === 0 ? '' : `${lines.join('\n')}\n`),
    );
  }

  /**
   * The supervisor, uploaded verbatim from the API image on every delivery so a fix reaches a
   * sandbox at its next claim or resume with no rebuild, then started through the adapter — above
   * the agent's `execAllowlist`, which the agent still cannot express (contracts § 2). Exit `0`
   * means launched, not listening; listening is only ever asserted by a report.
   *
   * Nothing here fails the claim. A sandbox whose dev server did not start is spec 017's "nothing
   * is serving yet", which is a working state: the failure is one `warn` line of fields, in the
   * adapter's vocabulary, and the op settles as it would have.
   */
  private async launchDevServer(
    target: Extract<OpTarget, { kind: 'project' }>,
    dev: DevServerDeclaration,
    workspaceRoot: string | null,
  ): Promise<void> {
    // The `cwd` the launch needs. A claimed pool row and a resumed row both carry one; a row that
    // does not is not one to guess a directory for.
    if (workspaceRoot === null) {
      this.warnLaunch(target, dev.port, 'no-workspace-root');

      return;
    }

    try {
      this.supervisor ??= readFileSync(join(__dirname, 'dev-supervisor.mjs'));
      await this.daytona.upload(target.row.daytonaId, SANDBOX_DEV_SUPERVISOR_PATH, this.supervisor);
      const outcome = await this.daytona.execute(target.row.daytonaId, {
        command: `node ${SANDBOX_DEV_SUPERVISOR_PATH}`,
        cwd: workspaceRoot,
        timeoutSeconds: DEV_LAUNCH_TIMEOUT_SECONDS,
      });

      if (outcome.timedOut) this.warnLaunch(target, dev.port, 'timeout');
      else if (outcome.exitCode !== 0)
        this.warnLaunch(target, dev.port, `exit-${outcome.exitCode}`);
    } catch (error) {
      this.warnLaunch(
        target,
        dev.port,
        error instanceof DaytonaError
          ? `daytona:${error.kind}`
          : error instanceof Error
            ? error.name
            : 'unknown',
      );
    }
  }

  /** The adapter's line: fields only, never a body, an output or the supervisor's own words. */
  private warnLaunch(
    target: Extract<OpTarget, { kind: 'project' }>,
    port: string,
    kind: string,
  ): void {
    this.logger.warn(
      `dev server launch failed: daytonaId=${target.row.daytonaId} ` +
        `project=${target.row.projectId} port=${port} kind=${kind}`,
    );
  }

  /** The project's template manifest, when it declares a dev server; `undefined` when it does not. */
  private async devServer(
    target: Extract<OpTarget, { kind: 'project' }>,
  ): Promise<DevServerDeclaration | undefined> {
    const [project] = await this.transactions.runInTenantTransaction(target.orgId, (tx) =>
      tx
        .select({ template: schema.projects.template })
        .from(schema.projects)
        .where(eq(schema.projects.id, target.row.projectId)),
    );
    // A `find` rather than `get`: `projects.template` is free text to the compiler, and a row
    // naming a template the catalogue does not hold is a project with no dev server, not a throw.
    const manifest = this.catalogue.all().find(({ id }) => id === project?.template)?.manifest;

    return manifest?.devCommand === undefined || manifest.devPort === undefined
      ? undefined
      : { command: manifest.devCommand, port: manifest.devPort };
  }

  /** Polls `describe` every `readyPollMs` until Daytona answers `state`, up to `readyBudgetMs`. */
  private async awaitState(daytonaId: string, state: string) {
    const deadline = this.clock.now().getTime() + this.timings.readyBudgetMs;

    for (;;) {
      const dto = await this.daytona.describe(daytonaId);

      if (dto.state === state) {
        return dto;
      }

      if (this.clock.now().getTime() >= deadline) {
        throw new ReadinessTimeoutError(daytonaId, dto.state);
      }

      await sleep(this.timings.readyPollMs);
    }
  }

  /** The terminal settle, its own transaction: the reason on the row, the transition cleared. */
  private async settleFailure(target: OpTarget, error: unknown): Promise<void> {
    const failureReason =
      error instanceof DaytonaError
        ? `daytona:${error.kind}: ${error.message}`
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);

    if (target.kind === 'project') {
      await this.settleProject(target, { failureReason, transition: null, transitionSince: null });

      return;
    }

    await this.db
      .update(schema.sandboxPool)
      .set({ failureReason })
      .where(eq(schema.sandboxPool.id, target.row.id));
  }

  private settleProject(
    target: Extract<OpTarget, { kind: 'project' }>,
    values: Partial<Sandbox>,
  ): Promise<unknown> {
    return this.transactions.runInTenantTransaction(target.orgId, (tx) =>
      tx.update(schema.sandboxes).set(values).where(eq(schema.sandboxes.id, target.row.id)),
    );
  }

  /** Stale: a `resume` for this sandbox has been recorded with a higher `leaseEpoch` than ours. */
  private async staleEpoch(
    tx: TenantTransaction,
    sandboxId: string,
    leaseEpoch: number | undefined,
  ): Promise<boolean> {
    if (leaseEpoch === undefined) {
      return false;
    }

    const [newest] = await tx
      .select({ epoch: sql<number | null>`max((${schema.outbox.payload}->>'leaseEpoch')::int)` })
      .from(schema.outbox)
      .where(
        and(
          eq(schema.outbox.type, 'sandbox.op.requested'),
          eq(schema.outbox.aggregateId, sandboxId),
          sql`${schema.outbox.payload}->>'op' = 'resume'`,
        ),
      );

    return newest?.epoch !== null && newest?.epoch !== undefined && newest.epoch > leaseEpoch;
  }

  private async load(event: OpEvent, tx: TenantTransaction): Promise<OpTarget | undefined> {
    const { orgId, poolId, sandboxId } = event.payload;

    if (sandboxId !== undefined && orgId !== undefined) {
      await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
      const [row] = await tx
        .select()
        .from(schema.sandboxes)
        .where(eq(schema.sandboxes.id, sandboxId));

      return row === undefined ? undefined : { kind: 'project', orgId, row };
    }

    if (poolId !== undefined) {
      const [row] = await tx
        .select()
        .from(schema.sandboxPool)
        .where(eq(schema.sandboxPool.id, poolId));

      return row === undefined ? undefined : { kind: 'pool', row };
    }

    return undefined;
  }
}

/** A project row's `transition`, or a pool row's `state` — the pool has no separate column. */
function inTransition(target: OpTarget, transition: 'creating'): boolean {
  return target.kind === 'project'
    ? target.row.transition === transition
    : target.row.state === transition;
}

/** The global timer rather than `timers/promises`, so a suite's fake clock can drive the wait. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
