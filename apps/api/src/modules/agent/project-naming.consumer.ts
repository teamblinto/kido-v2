import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { agentRuns, projects, repoLinks, runMessages, syncOperations } from '@repo/db';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { AuditService } from '../audit/audit.service';
import { EventConsumer } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { SANDBOX_PORT, type SandboxPort } from '../sandbox/sandbox.port';
import {
  cleanGeneratedName,
  NAMING_SYSTEM_PROMPT,
  namingPrompt,
  readmeExcerpt,
} from '../tenancy/project-naming';
import { CredentialResolver } from './byok/credential-resolver';
import { LLM_PROVIDER, type LlmProvider } from './llm-provider.port';

export const PROJECT_NAMING_QUEUE = 'project.naming';

/** Cheap models, in the order tried; the first the person or organisation can pay for answers. */
const NAMING_MODELS = ['claude-haiku-4-5', 'gpt-5-mini'] as const;

/** A name is a nicety: a slow provider is abandoned rather than waited on. */
const NAMING_TIMEOUT_MS = 15_000;

interface NamingPlan {
  readonly prompt: string | null;
  readonly repository: string | null;
  readonly userId: string | null;
}

/**
 * Spec 047: a project whose name is still provisional — a prompt's first line, or a humanised
 * repository name — gets one a person would have chosen.
 *
 * The hint is read here, never carried on the event (ids only): the first message of the project's
 * first run, or the repository's owner/name with its README and `package.json` description read
 * from the sandbox. One short call to a cheap model through the same credential resolution a run
 * uses (the organisation's key or the person's linked subscription). With neither, the provisional
 * name stays, which is already readable.
 *
 * The rename is conditional on `name_pending` still being true, in the same statement, so a person
 * who renamed the project in the meantime always wins. A model answer that is not a plausible name
 * is discarded.
 */
@Injectable()
export class ProjectNamingConsumer extends EventConsumer<
  'project.naming.requested',
  NamingPlan | undefined
> {
  readonly attempts = 2;
  readonly name = 'project-naming';
  override readonly profile = 'events' as const;
  readonly queue = PROJECT_NAMING_QUEUE;
  readonly types = ['project.naming.requested'] as const;
  private readonly logger = new Logger(ProjectNamingConsumer.name);

  constructor(
    @Inject(CredentialResolver) private readonly resolver: CredentialResolver,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Optional() @Inject(SANDBOX_PORT) private readonly port?: SandboxPort,
  ) {
    super();
  }

  async handle(
    event: Envelope<'project.naming.requested'>,
    tx: TenantTransaction,
  ): Promise<NamingPlan | undefined> {
    const { orgId, projectId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const [project] = await tx
      .select({ namePending: projects.namePending })
      .from(projects)
      .where(
        and(eq(projects.orgId, orgId), eq(projects.id, projectId), isNull(projects.deletedAt)),
      );
    if (project?.namePending !== true) return undefined;

    const [first] = await tx
      .select({ content: runMessages.content, userId: agentRuns.userId })
      .from(runMessages)
      .innerJoin(agentRuns, eq(agentRuns.id, runMessages.runId))
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.projectId, projectId),
          eq(runMessages.role, 'user'),
        ),
      )
      .orderBy(asc(agentRuns.createdAt), asc(runMessages.at))
      .limit(1);
    const [link] = await tx
      .select({ name: repoLinks.name, owner: repoLinks.owner })
      .from(repoLinks)
      .where(and(eq(repoLinks.orgId, orgId), eq(repoLinks.projectId, projectId)))
      .limit(1);
    const [imported] = await tx
      .select({ userId: syncOperations.requestedBy })
      .from(syncOperations)
      .where(and(eq(syncOperations.orgId, orgId), eq(syncOperations.projectId, projectId)))
      .orderBy(desc(syncOperations.createdAt))
      .limit(1);

    return {
      prompt: first?.content ?? null,
      repository: link === undefined ? null : `${link.owner}/${link.name}`,
      userId: first?.userId ?? imported?.userId ?? null,
    };
  }

  override async effect(
    event: Envelope<'project.naming.requested'>,
    plan: NamingPlan | undefined,
  ): Promise<void> {
    if (plan === undefined) return;
    const { orgId, projectId } = event.payload;
    // Neither a prompt nor a repository: nothing describes the project yet. A later run asks again.
    if (plan.prompt === null && plan.repository === null) return;

    const scope = { orgId, userId: plan.userId };
    const ref = { orgId, projectId };
    const read = async (path: string): Promise<string | undefined> =>
      this.port === undefined || plan.repository === null
        ? undefined
        : this.transactions
            .runInTenantScope(scope, () => this.port!.read(ref, path))
            .catch(() => undefined);

    const readme = readmeExcerpt((await read('README.md')) ?? (await read('readme.md')));
    const description = descriptionOf(await read('package.json'));
    const name = await this.generate(orgId, plan.userId, {
      description,
      prompt: plan.prompt,
      readme,
      repository: plan.repository,
    });

    await this.transactions.runInTenantScope(scope, async (tx) => {
      // Conditional on the flag in the same statement: a rename that landed first wins.
      const renamed = await tx
        .update(projects)
        .set({ namePending: false, ...(name === null ? {} : { name }) })
        .where(
          and(
            eq(projects.orgId, orgId),
            eq(projects.id, projectId),
            eq(projects.namePending, true),
          ),
        )
        .returning({ id: projects.id });
      if (renamed.length > 0 && name !== null) {
        await this.audit.record(tx, {
          action: 'project.named',
          actorId: null,
          metadata: { name },
          orgId,
          target: projectId,
        });
      }
    });
  }

  /** One cheap call, or null when nothing can pay for it or the answer is not a name. */
  private async generate(
    orgId: string,
    userId: string | null,
    hint: Parameters<typeof namingPrompt>[0],
  ): Promise<string | null> {
    if (userId === null) return null;

    for (const model of NAMING_MODELS) {
      const resolution = await this.transactions
        .runInTenantScope({ orgId, userId }, (tx) =>
          this.resolver.forModel(tx, orgId, userId, model),
        )
        .catch(() => undefined);
      if (resolution?.kind !== 'byok' && resolution?.kind !== 'byos') continue;

      try {
        const turn = await this.llm.client(resolution.credential, model).complete(
          {
            messages: [{ content: namingPrompt(hint), role: 'user' }],
            system: NAMING_SYSTEM_PROMPT,
            tools: [],
          },
          { onDelta: () => undefined, signal: AbortSignal.timeout(NAMING_TIMEOUT_MS) },
        );
        return cleanGeneratedName(turn.text);
      } catch (error) {
        this.logger.warn(`project naming with ${model} failed: ${(error as Error).name}`);
      }
    }

    return null;
  }
}

/** `package.json`'s `description`, when it has a usable one. */
function descriptionOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as { description?: unknown };
    return typeof parsed.description === 'string' && parsed.description.trim() !== ''
      ? parsed.description.trim()
      : null;
  } catch {
    return null;
  }
}
