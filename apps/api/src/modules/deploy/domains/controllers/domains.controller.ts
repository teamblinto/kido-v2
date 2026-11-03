import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  type DomainListResponse,
  type DomainResponse,
  IDEMPOTENCY_KEY_HEADER,
  type RemoveDomainResponse,
} from '@repo/contracts';

import { ValidationFailedError } from '../../../../common/validation/validation-failed.error';
import { TenantContext } from '../../../../database/tenant-context';
import { CurrentUser } from '../../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../identity/services/session.service';
import { RequirePermission } from '../../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../../rbac/resource-org.resolver';
import { DomainService } from '../domain.service';
import {
  AddDomainRequestDto,
  DomainListResponseDto,
  DomainResponseDto,
  RemoveDomainResponseDto,
} from '../dto/domain.dto';

/**
 * A project's custom domains (spec 028 US1, contracts/domains.md). The reads are `project:read`;
 * the add is `org:domains.manage` (owner and admin, research R12), which says nothing about the
 * project, so the service re-checks the project belongs to the org. The add answers `201` with the
 * `pending` row and requires an `Idempotency-Key` — a keyless double-submit would be a second
 * attempt at a held hostname — which the application-wide idempotency interceptor then replays.
 * The remove (US2) is `org:domains.manage` too, answers `202` with the domain in `removing` while
 * the edge is asked to let it go, and is idempotent by its target state, so it takes no key.
 * Check now and retry (US4) are `org:domains.manage` too. Check now answers `202` — the check runs
 * on the consumer — and is limited by the row, not by a key. Retry answers `200` with the domain
 * back in `pending`; its `Idempotency-Key` is optional, and when sent the interceptor replays it.
 */
@ApiTags('deploy')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/domains', version: '1' })
export class DomainsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(DomainService) private readonly domains: DomainService,
  ) {}

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'List the project’s custom domains, newest first' })
  @ApiResponse({ status: 200, type: DomainListResponseDto })
  list(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<DomainListResponse> {
    return this.domains.list(this.tenant.tx, { orgId, projectId }, caller.userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('org:domains.manage')
  @ApiOperation({ summary: 'Add a custom domain; it is pending until its DNS records are found' })
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: true })
  @ApiResponse({ status: 201, type: DomainResponseDto })
  @ApiResponse({
    description:
      'Invalid, apex, reserved or unavailable hostname; archived or not deployable; domains unavailable (`reason`).',
    status: 409,
  })
  async add(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: AddDomainRequestDto,
    @Headers(IDEMPOTENCY_KEY_HEADER.toLowerCase()) idempotencyKey: string | undefined,
  ): Promise<DomainResponse> {
    if (idempotencyKey === undefined) {
      throw new ValidationFailedError('custom', [
        {
          code: 'idempotency_key_required',
          detail: `${IDEMPOTENCY_KEY_HEADER} is required to add a domain.`,
          pointer: `/headers/${IDEMPOTENCY_KEY_HEADER.toLowerCase()}`,
        },
      ]);
    }

    return {
      domain: await this.domains.add(this.tenant.tx, { orgId, projectId }, caller.userId, body),
    };
  }

  @Get(':domainId')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'Read one custom domain' })
  @ApiResponse({ status: 200, type: DomainResponseDto })
  async read(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('domainId') domainId: string,
  ): Promise<DomainResponse> {
    return { domain: await this.domains.get(this.tenant.tx, { orgId, projectId }, domainId) };
  }

  @Post(':domainId/check')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('org:domains.manage')
  @ApiOperation({ summary: 'Ask for a check of a pending or drifted domain now' })
  @ApiResponse({ status: 202, type: DomainResponseDto })
  @ApiResponse({ description: 'Asked less than a minute ago (`retryAfter`).', status: 429 })
  async check(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('domainId') domainId: string,
  ): Promise<DomainResponse> {
    return { domain: await this.domains.checkNow(this.tenant.tx, { orgId, projectId }, domainId) };
  }

  @Post(':domainId/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org:domains.manage')
  @ApiOperation({ summary: 'Retry a failed domain with a new ownership value and a new window' })
  @ApiHeader({ name: IDEMPOTENCY_KEY_HEADER, required: false })
  @ApiResponse({ status: 200, type: DomainResponseDto })
  @ApiResponse({
    description:
      'Not failed, hostname unavailable, limit reached, archived or domains unavailable (`reason`).',
    status: 409,
  })
  async retry(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('domainId') domainId: string,
  ): Promise<DomainResponse> {
    return {
      domain: await this.domains.retry(
        this.tenant.tx,
        { orgId, projectId },
        caller.userId,
        domainId,
      ),
    };
  }

  @Delete(':domainId')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('org:domains.manage')
  @ApiOperation({
    summary:
      'Remove a custom domain: it stops serving now and is released once the edge lets it go',
  })
  @ApiResponse({ status: 202, type: RemoveDomainResponseDto })
  remove(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('domainId') domainId: string,
  ): Promise<RemoveDomainResponse> {
    return this.domains.remove(this.tenant.tx, { orgId, projectId }, caller.userId, domainId);
  }
}
