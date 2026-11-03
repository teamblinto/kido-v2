import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  PROJECT_TEMPLATES,
  type ProjectTemplate,
  sandboxCallbackRequestSchema,
} from '@repo/contracts';
import { projects, sandboxes } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { ForbiddenError } from '../../../common/errors/domain-error';
import type { TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import { Public } from '../../identity/decorators/public.decorator';
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
      const declared = await this.declaredPort(tx, claims);
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
   * The port the calling project's template declares, read under the caller's own transaction.
   * The same reading `RouteBrokerService.devPort` makes: no row, no template or no `devPort` is no
   * port — and no port matches nothing, because `port` is a required number in the schema.
   */
  private async declaredPort(
    tx: TenantTransaction,
    claims: SandboxCallbackClaims,
  ): Promise<number | undefined> {
    const [project] = await tx
      .select({ template: projects.template })
      .from(projects)
      .where(and(eq(projects.orgId, claims.org), eq(projects.id, claims.project)))
      .limit(1);
    const template = project?.template ?? null;
    if (template === null || !(PROJECT_TEMPLATES as readonly string[]).includes(template)) {
      return undefined;
    }
    const declared = this.catalogue.get(template as ProjectTemplate).manifest.devPort;
    return declared === undefined ? undefined : Number(declared);
  }
}
