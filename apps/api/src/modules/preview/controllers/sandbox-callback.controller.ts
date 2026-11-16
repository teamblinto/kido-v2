import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { sandboxCallbackRequestSchema } from '@repo/contracts';
import { projects, sandboxes } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { ForbiddenError } from '../../../common/errors/domain-error';
import type { TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import { Public } from '../../identity/decorators/public.decorator';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { parseRunConfig, resolveDevPort } from '../../sandbox/run-config';
import { TemplateCatalogue } from '../../sandbox/template-catalogue';
import {
  CALLBACK_REJECTION,
  SANDBOX_CALLBACK,
  SandboxCallbackGuard,
} from '../sandbox-callback.guard';
import type { SandboxCallbackClaims } from '../sandbox-callback.token';

/** Why a body the guard admitted was still refused. One `403` on the wire for both (contract § 4). */
type CallbackRefusal = 'undeclared-port' | 'unknown-action';

/**
 * Spec 047: automatic repair runs per failure streak. Two, because the first fix often uncovers
 * the next error, and a third attempt at the same failure is spending somebody's subscription on a
 * loop; a `listening` report ends the streak and hands the budget back.
 */
export const MAX_PREVIEW_REPAIRS = 2;

/**
 * The callback broker (spec 017 US5, contracts § 6, research R11): the one route a sandbox may
 * reach. `@Public()` because the caller is a process with a token, not a member with a session;
 * `SandboxCallbackGuard` is what admits it, and everything that names a sandbox — org, project,
 * Daytona id — is read from the claims the guard verified and re-checked against the row, never
 * from the body. The body is parsed here rather than by a DTO: a shape outside the declared set (an
 * unknown action, a `project` of its own, anything extra — the union is strict) is a refusal that
 * has to be audited (`sandbox-callback.refused`), and the validation pipe's `400` would say more
 * than the guard's uniform `403` does.
 *
 * Spec 023 R9 adds the second refusal: a `preview.status` naming any port but the project's
 * template `devPort`. Under 017 nothing wrote `sandboxes.ports` at all, so any port in the
 * unprivileged range was as honest a key as another; with a writer, an unconstrained map is a
 * tenant-controlled key space in a column the gateway's neighbours read. Nothing 017 declared
 * moves for it — the schema keeps its shape, the guard keeps its three re-checks, the token keeps
 * its claims — this is one more `because` on the refusal path that already existed (FR-016,
 * FR-025–FR-027).
 */
@ApiTags('internal')
@Public()
@UseGuards(SandboxCallbackGuard)
@Controller({ path: 'internal/sandbox-callbacks', version: '1' })
export class SandboxCallbackController {
  constructor(
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
  ) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'A sandbox reports what it observed on one of its ports' })
  @ApiResponse({ status: 204 })
  async receive(
    @Req() request: Record<PropertyKey, unknown>,
    @Body() body: unknown,
  ): Promise<void> {
    const claims = request[SANDBOX_CALLBACK] as SandboxCallbackClaims;
    const parsed = sandboxCallbackRequestSchema.safeParse(body);

    const because = await this.transactions.runInTenantTransaction(claims.org, async (tx) => {
      if (!parsed.success) return this.refuse(tx, claims, 'unknown-action');
      // The declared port is the only key this map may grow (R9). A template that declares none
      // has no port to report on, so every port it names is undeclared.
      const project = await this.project(tx, claims);
      const declared = project === undefined ? undefined : resolveDevPort(this.catalogue, project);
      if (declared !== parsed.data.port) return this.refuse(tx, claims, 'undeclared-port');
      // `preview.status` is the whole set today; the union grows by a branch here (contract § 7).
      const entry = { observedAt: this.clock.now().toISOString(), state: parsed.data.state };
      await tx
        .update(sandboxes)
        .set({
          ports: sql`${sandboxes.ports} || ${JSON.stringify({ [parsed.data.port]: entry })}::jsonb`,
        })
        .where(
          and(
            eq(sandboxes.orgId, claims.org),
            eq(sandboxes.projectId, claims.project),
            eq(sandboxes.daytonaId, claims.sandbox),
          ),
        );
      await this.repairs(tx, claims, project?.runConfig, parsed.data.state);
      return undefined;
    });

    // One body for every refusal, the guard's: the reason is the audit row's, never the response's.
    if (because !== undefined) throw new ForbiddenError(CALLBACK_REJECTION);
  }

  /** Audits the refusal inside the caller's transaction and names it, so the `403` stays uniform. */
  private async refuse(
    tx: TenantTransaction,
    claims: SandboxCallbackClaims,
    because: CallbackRefusal,
  ): Promise<CallbackRefusal> {
    await this.audit.record(tx, {
      action: 'sandbox-callback.refused',
      actorId: null,
      metadata: { because, sandbox: claims.sandbox },
      orgId: claims.org,
      target: claims.project,
    });
    return because;
  }

  /**
   * The calling project's template and run profile, read under the caller's own transaction. The
   * port is `resolveDevPort`'s, the reading the route broker makes: no row or no declared dev
   * server is no port — and no port matches nothing, because `port` is a required number.
   */
  private async project(tx: TenantTransaction, claims: SandboxCallbackClaims) {
    const [project] = await tx
      .select({ runConfig: projects.runConfig, template: projects.template })
      .from(projects)
      .where(and(eq(projects.orgId, claims.org), eq(projects.id, claims.project)))
      .limit(1);
    return project;
  }

  /**
   * Spec 047's self-healing trigger, in the report's own transaction. A project with a run profile
   * whose dev server (or install) spent its fast budget gets one repair run per report, up to
   * {@link MAX_PREVIEW_REPAIRS} per streak; `listening` ends the streak. A template project has no
   * profile and is left exactly as before.
   */
  private async repairs(
    tx: TenantTransaction,
    claims: SandboxCallbackClaims,
    raw: unknown,
    state: 'failed' | 'installing' | 'listening' | 'starting',
  ): Promise<void> {
    const config = parseRunConfig(raw);
    if (config === null) return;

    const next =
      state === 'listening' && config.repairs > 0
        ? 0
        : state === 'failed' && config.repairs < MAX_PREVIEW_REPAIRS
          ? config.repairs + 1
          : undefined;
    if (next === undefined) return;

    await tx
      .update(projects)
      .set({ runConfig: { ...config, repairs: next } })
      .where(and(eq(projects.orgId, claims.org), eq(projects.id, claims.project)));

    if (next > 0) {
      await this.outbox.append(tx, {
        aggregateId: claims.project,
        orgId: claims.org,
        payload: { attempt: next, orgId: claims.org, projectId: claims.project },
        type: 'project.preview.failed',
      });
    }
  }
}
