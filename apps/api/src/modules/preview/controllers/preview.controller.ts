import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  type AuthorizePreviewResponse,
  PREVIEW_LABEL_ROTATED,
  type PreviewResponse,
  type RotatePreviewResponse,
} from '@repo/contracts';
import { projects } from '@repo/db';
import { eq } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import type { Environment } from '../../../config/environment';
import { TenantContext } from '../../../database/tenant-context';
import { AuditService } from '../../audit/audit.service';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { TemplateCatalogue } from '../../sandbox/template-catalogue';
import { ProjectService } from '../../tenancy/services/project.service';
import {
  AuthorizePreviewResponseDto,
  previewAuthorizeRequestSchema,
  PreviewAuthorizeRequestDto,
  PreviewResponseDto,
  RotatePreviewResponseDto,
  SetPreviewVisibilityRequestDto,
} from '../dto/preview.dto';
import { GrantService } from '../grant.service';
import { PreviewError } from '../preview.errors';
import { PreviewReader } from '../preview-reader';

/**
 * A project's preview as its readers see it (spec 017 US1, contracts § 2): the URL the gateway
 * serves it on, the port the template declares, who may reach it, and its start-up `stage` (the
 * `sandboxes` row and the dev server's last report, `previewStage`; nothing is woken, so the web
 * can poll it and mount the frame only at `ready`). The rows are schema reads
 * under the request's tenant transaction — 016's precedent, never another module's repository —
 * because `ProjectService.read` answers the `ProjectSummary` shape, which by design carries no
 * label, template or visibility. The label leaves here only folded into `url`.
 *
 * Rotation and visibility (US3) are the owner's alone — `project:preview.rotate` is held by no
 * other project role — and each writes its row, its audit entry and (for rotation) its outbox
 * event on the one request transaction, so none of the three lands without the others (FR-040).
 * `Idempotency-Key` is not mentioned: `IdempotencyInterceptor` is an `APP_INTERCEPTOR`, so every
 * unsafe route honours it by existing (`invitation.controller.ts` says why that is not opt-in).
 */
@ApiTags('preview')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/preview', version: '1' })
export class PreviewController {
  private readonly reader: PreviewReader;

  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(TemplateCatalogue) private readonly catalogue: TemplateCatalogue,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
    config: ConfigService<Environment, true>,
  ) {
    this.reader = new PreviewReader(catalogue, config);
  }

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read where the project’s preview is served and who may reach it' })
  @ApiResponse({ status: 200, type: PreviewResponseDto })
  async read(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<PreviewResponse> {
    return this.reader.read(this.tenant.tx, orgId, projectId);
  }

  @Post('rotate')
  @HttpCode(200)
  @RequirePermission('project:preview.rotate')
  @ApiOperation({ summary: 'Rotate the preview label; the old URL stops resolving' })
  @ApiResponse({ status: 200, type: RotatePreviewResponseDto })
  async rotate(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<RotatePreviewResponse> {
    const row = await this.reader.row(this.tenant.tx, orgId, projectId);
    const tx = this.tenant.tx;
    const { label, previousLabel } = await this.projects.rotatePreviewLabel(
      { orgId, projectId },
      tx,
    );

    await this.audit.record(tx, {
      action: 'preview.label-rotated',
      actorId: caller.userId,
      metadata: {},
      orgId,
      target: projectId,
    });
    await this.outbox.append(tx, {
      aggregateId: projectId,
      orgId,
      payload: { orgId, previousLabel, projectId },
      type: 'project.preview-label.rotated',
    });

    const { port, url } = this.reader.link(row.template, label);
    return { port, status: PREVIEW_LABEL_ROTATED, url };
  }

  @Put('visibility')
  @RequirePermission('project:preview.rotate')
  @ApiOperation({ summary: 'Set who may reach the project’s preview' })
  @ApiResponse({ status: 200, type: PreviewResponseDto })
  async setVisibility(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() { visibility }: SetPreviewVisibilityRequestDto,
  ): Promise<PreviewResponse> {
    const row = await this.reader.row(this.tenant.tx, orgId, projectId);

    // The same value writes nothing, the way a same-name rename does (R10).
    if (visibility !== row.previewVisibility) {
      const tx = this.tenant.tx;
      await tx
        .update(projects)
        .set({ previewVisibility: visibility, updatedAt: this.clock.now() })
        .where(eq(projects.id, projectId));
      await this.audit.record(tx, {
        action: 'preview.visibility-changed',
        actorId: caller.userId,
        metadata: { from: row.previewVisibility, to: visibility },
        orgId,
        target: projectId,
      });
    }

    return this.reader.answer(
      this.tenant.tx,
      orgId,
      projectId,
      row.template,
      row.previewLabel,
      visibility,
    );
  }
}

/**
 * The grant exchange's product-origin half (spec 017 US2, contracts § 2): the only preview route
 * not under `orgs/:orgId`, because the caller presents a label and the org is derived from it. A
 * separate class rather than a method on `PreviewController` so that class's `@ResourceOrg()` and
 * the `:orgId` path never apply here: `SessionGuard` still runs (no `@Public()`), no permission is
 * demanded, and membership is `GrantService`'s check against the resolved project. Every refusal —
 * unknown label, non-member, a return host that is not this label's preview host — is the one
 * `not-found`, so the answer never says which (FR-024, spec edge cases). The answer is a readable
 * `200 { url }` rather than a `302`: the page calls this with `fetch`, and a cross-origin redirect
 * is opaque to `fetch`, so the target has to be a body the page can follow itself.
 */
@ApiTags('preview')
@Controller({ path: 'preview', version: '1' })
export class PreviewAuthorizeController {
  constructor(@Inject(GrantService) private readonly grants: GrantService) {}

  @Post('authorize')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a single-use code and name the preview URL that redeems it' })
  @ApiResponse({ status: 200, type: AuthorizePreviewResponseDto })
  async authorize(
    @CurrentUser() caller: AuthenticatedUser,
    @Body() input: PreviewAuthorizeRequestDto,
  ): Promise<AuthorizePreviewResponse> {
    // Re-parsed here so a direct call is held to the same authority grammar the pipe enforces.
    const body = previewAuthorizeRequestSchema.safeParse(input).data;
    if (body === undefined) {
      throw new PreviewError('project-not-found', 'No such preview.');
    }
    const code = await this.grants.issueCode({
      label: body.label,
      returnHost: body.returnHost,
      userId: caller.userId,
    });
    if (code === undefined) {
      throw new PreviewError('project-not-found', 'No such preview.');
    }
    // ponytail: an authority with an explicit port is the local gateway (`pnpm dev:gateway`, R18),
    // which speaks plain HTTP; a deployed preview domain carries none. Make it configuration if a
    // deployment ever serves previews on a non-default port.
    // Rebuilt from the parsed parts, never from the request string, so nothing the DTO's grammar
    // let through can become userinfo, a path or a second host.
    const [hostname, port] = body.returnHost.split(':');
    const url = new URL(`${port === undefined ? 'https' : 'http'}://${hostname!}/`);
    if (port !== undefined) url.port = port;
    url.searchParams.set('code', code);
    return { url: url.href };
  }
}
