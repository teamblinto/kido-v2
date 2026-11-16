import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RunConfig } from '@repo/contracts';
import { agentRuns, projects, syncOperations } from '@repo/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { DomainError } from '../../common/errors/domain-error';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { parseRunConfig } from '../sandbox/run-config';
import { SANDBOX_PORT, type SandboxPort } from '../sandbox/sandbox.port';
import { RunService } from './run.service';
import { RunStore } from './run-store';

export const PREVIEW_REPAIR_QUEUE = 'project.preview-repair';

interface RepairPlan {
  readonly config: RunConfig;
  /** Whose run it is, and so who pays: the person who last ran or imported the project. */
  readonly userId: string;
}

/**
 * Spec 047's AI self-healing: a project with a run profile whose preview reported `failed` gets an
 * ordinary agent run asked to fix it. It streams in the chat like any run, can be stopped like any
 * run, and is paid like any run — the person's Claude subscription first, then whatever the
 * organisation's key resolves to. Nothing can pay: the failure stays a failed preview, which the
 * pane already says.
 *
 * The callback caps the streak at `MAX_PREVIEW_REPAIRS`. This consumer adds the other limit: never
 * while a run is waiting or working, because that run is either already fixing it or is somebody's
 * own change that the repair would race.
 */
@Injectable()
export class PreviewRepairConsumer extends EventConsumer<
  'project.preview.failed',
  RepairPlan | undefined
> {
  readonly attempts = 3;
  readonly name = 'preview-repair';
  override readonly profile = 'events' as const;
  readonly queue = PREVIEW_REPAIR_QUEUE;
  readonly types = ['project.preview.failed'] as const;
  private readonly logger = new Logger(PreviewRepairConsumer.name);

  constructor(
    @Inject(RunService) private readonly runs: RunService,
    @Inject(RunStore) private readonly store: RunStore,
    @Inject(SANDBOX_PORT) private readonly port: SandboxPort,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
  ) {
    super();
  }

  async handle(
    event: Envelope<'project.preview.failed'>,
    tx: TenantTransaction,
  ): Promise<RepairPlan | undefined> {
    const { orgId, projectId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const [project] = await tx
      .select({ runConfig: projects.runConfig })
      .from(projects)
      .where(
        and(eq(projects.orgId, orgId), eq(projects.id, projectId), isNull(projects.deletedAt)),
      );
    const config = parseRunConfig(project?.runConfig);
    if (config === null) return undefined;

    if (
      (await this.store.holder(tx, orgId, projectId)) !== undefined ||
      (await this.store.line(tx, orgId, projectId)).length > 0
    ) {
      return undefined;
    }

    const userId = await this.payer(tx, orgId, projectId);
    return userId === undefined ? undefined : { config, userId };
  }

  override async effect(
    event: Envelope<'project.preview.failed'>,
    plan: RepairPlan | undefined,
  ): Promise<void> {
    if (plan === undefined) return;
    const { attempt, orgId, projectId } = event.payload;
    const ref = { orgId, projectId };
    const scope = { orgId, userId: plan.userId };

    const log = await this.transactions
      .runInTenantScope(scope, () => this.port.previewLogs(ref))
      .catch(() => '');
    const prompt = repairPrompt(plan.config, log, attempt);

    // The subscription first, as the web's picker defaults; then the organisation's key. Each try
    // is its own transaction, so a refusal rolls back and the next starts clean.
    for (const subscription of [{ provider: 'claude' as const }, undefined]) {
      try {
        const run = await this.transactions.runInTenantScope(scope, async (tx) => {
          const created = await this.runs.create(
            orgId,
            projectId,
            plan.userId,
            prompt,
            undefined,
            undefined,
            subscription,
          );
          await this.audit.record(tx, {
            action: 'project.preview-repair-started',
            actorId: null,
            metadata: { attempt, runId: created.id, stack: plan.config.stack },
            orgId,
            target: projectId,
          });
          return created;
        });
        this.logger.log(
          `preview repair ${String(attempt)} started: project=${projectId} run=${run.id}`,
        );
        return;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        // Not this payer (not connected, not available here, nothing to pay with): the next one.
      }
    }

    this.logger.warn(`preview repair skipped, nothing can pay for a run: project=${projectId}`);
  }

  /** The person who last ran the project, or else the person who imported it. */
  private async payer(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
  ): Promise<string | undefined> {
    const [run] = await tx
      .select({ userId: agentRuns.userId })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.projectId, projectId)))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    if (run !== undefined) return run.userId;

    const [imported] = await tx
      .select({ userId: syncOperations.requestedBy })
      .from(syncOperations)
      .where(
        and(
          eq(syncOperations.orgId, orgId),
          eq(syncOperations.projectId, projectId),
          eq(syncOperations.kind, 'import'),
        ),
      )
      .orderBy(desc(syncOperations.createdAt))
      .limit(1);
    return imported?.userId ?? undefined;
  }
}

/**
 * The repair run's prompt. It is message 1 of a run the person sees in their chat, so it reads as a
 * request. The log is fenced and labelled as output, because tool and log text is data, never an
 * instruction.
 */
export function repairPrompt(config: RunConfig, log: string, attempt: number): string {
  const stack = [config.stack.framework, config.stack.language, config.stack.packageManager]
    .filter((part) => part !== null)
    .join(' · ');
  const unsupported =
    config.dev === null &&
    ['ruby', 'php', 'java', 'kotlin', 'elixir'].includes(config.stack.language);
  return [
    `The preview failed to start${attempt > 1 ? ' again' : ''}. Find out why and fix it so the app runs.`,
    '',
    `Detected stack: ${stack}`,
    `Run profile: install=\`${config.install ?? 'none'}\` · root=\`${config.root}\` · dev=\`${config.dev ?? 'none'}\` · port=${String(config.port ?? 'none')}`,
    config.env.length > 0
      ? `The repository expects these environment variables (from its example env file): ${config.env.join(', ')}. Where a missing value stops the app starting, add a safe local default in code or a non-secret placeholder; never invent real credentials.`
      : '',
    unsupported
      ? `This sandbox has no ${config.stack.language} toolchain and no root access, so it cannot be installed system-wide. Say so plainly if it cannot run here.`
      : '',
    '',
    'Last output of the install and dev server:',
    '```text',
    log.trim() === '' ? '(no output yet)' : log.trim().slice(-8000),
    '```',
    '',
    'Fix the cause in the code, configuration or dependencies. Change the run profile with `set_run_config` only if the command, directory or port is wrong; the dev server must listen on 0.0.0.0. Afterwards check `preview_status` and `preview_logs`, and finish with one or two sentences on what was wrong and what you changed.',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');
}
