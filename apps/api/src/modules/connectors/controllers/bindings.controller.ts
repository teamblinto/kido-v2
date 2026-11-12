import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  type ApplyMigrationsResponse,
  type Binding,
  type BindingList,
  type MigrationProvider,
  type MigrationStatus,
  MIGRATION_PROVIDERS,
  type Operation,
  type OperationPage,
} from '@repo/contracts';

import { NotFoundError } from '../../../common/errors/domain-error';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { BindingService } from '../binding.service';
import { DatabaseMigrationService } from '../database-migrations';
import {
  ApplyMigrationsRequestDto,
  ApplyMigrationsResponseDto,
  BindingListResponseDto,
  MigrationStatusResponseDto,
  NeonBindRequestDto,
  NetlifyBindRequestDto,
  NetlifyPublishRequestDto,
  OperationPageResponseDto,
  OperationQueryDto,
  ResendBindRequestDto,
  SupabaseBindRequestDto,
} from '../dto/bindings.dto';
import { OperationResponseDto } from '../dto/connection.dto';
import { OperationService } from '../operation.service';

/** The providers this story binds through `PUT`, with the body each takes (contracts § 2). */
const BIND_BODIES = {
  neon: NeonBindRequestDto,
  netlify: NetlifyBindRequestDto,
  resend: ResendBindRequestDto,
  supabase: SupabaseBindRequestDto,
} as const;

type BindableProvider = keyof typeof BIND_BODIES;

function migratable(provider: string): MigrationProvider {
  if (!(MIGRATION_PROVIDERS as readonly string[]).includes(provider)) {
    throw new NotFoundError('No such database connector.');
  }

  return provider as MigrationProvider;
}

function bindable(provider: string): BindableProvider {
  if (!Object.hasOwn(BIND_BODIES, provider)) throw new NotFoundError('No such connector.');

  return provider as BindableProvider;
}

/**
 * A project's bindings (spec 030 contracts/bindings.md § 2): read for `project:read`; bind and
 * unbind for `org:connectors.manage` (an editor is refused before the service runs); the Neon
 * reset for `project:files.write`. A foreign org's project is a `404` like a missing one.
 */
@ApiTags('connectors')
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/projects/:projectId/connectors', version: '1' })
export class BindingsController {
  private readonly pipe = new ZodValidationPipe();

  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(BindingService) private readonly bindings: BindingService,
    @Inject(OperationService) private readonly operations: OperationService,
    @Inject(DatabaseMigrationService) private readonly migrations: DatabaseMigrationService,
  ) {}

  @Get()
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'List the project’s connector bindings (never a value)' })
  @ApiResponse({ status: 200, type: BindingListResponseDto })
  async list(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<BindingList> {
    return { items: await this.bindings.list(this.tenant.tx, { orgId, projectId }) };
  }

  @Get('operations')
  @RequirePermission('project:read')
  @ApiOperation({ summary: 'The project’s connector operations, newest first' })
  @ApiResponse({ status: 200, type: OperationPageResponseDto })
  async listOperations(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Query() query: OperationQueryDto,
  ): Promise<OperationPage> {
    // The project's existence and org, as the bindings read checks them.
    await this.bindings.list(this.tenant.tx, { orgId, projectId });

    return this.operations.list(this.tenant.tx, orgId, projectId, query);
  }

  @Post('neon/reset')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('project:files.write')
  @ApiOperation({ summary: 'Delete the preview branch and create it afresh' })
  @ApiResponse({ status: 202, type: OperationResponseDto })
  @ApiResponse({ description: 'A branch change is already in flight (`in-flight`).', status: 409 })
  resetNeon(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ): Promise<Operation> {
    return this.bindings.requestNeonReset(this.tenant.tx, { orgId, projectId }, caller.userId);
  }

  @Post('netlify/publish')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('project:deploy')
  @ApiOperation({ summary: 'Publish a succeeded release to the bound Netlify site' })
  @ApiResponse({ status: 202, type: OperationResponseDto })
  @ApiResponse({ description: 'Another project’s release, or none.', status: 404 })
  @ApiResponse({ description: 'A publish is already in flight (`in-flight`).', status: 409 })
  async publishNetlify(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<Operation> {
    const { deploymentId } = this.pipe.transform(body, {
      metatype: NetlifyPublishRequestDto,
      type: 'body',
    }) as NetlifyPublishRequestDto;

    return this.bindings.requestNetlifyPublish(
      this.tenant.tx,
      { orgId, projectId },
      caller.userId,
      deploymentId,
    );
  }

  @Get(':provider/migrations')
  @RequirePermission('project:read')
  @ApiOperation({
    summary: 'The migration versions the bound Neon or Supabase database has applied',
  })
  @ApiResponse({ status: 200, type: MigrationStatusResponseDto })
  @ApiResponse({ description: 'The project is not bound to that database.', status: 404 })
  @ApiResponse({ description: '`needs-reauth`, `disconnected`, `not-ready`.', status: 409 })
  migrationStatus(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('provider') provider: string,
  ): Promise<MigrationStatus> {
    return this.migrations.status(this.tenant.tx, { orgId, projectId }, migratable(provider));
  }

  @Post(':provider/migrations')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({
    summary: 'Apply pending SQL migrations, in version order, stopping at the first failure',
  })
  @ApiResponse({ status: 200, type: ApplyMigrationsResponseDto })
  @ApiResponse({
    description: '`missing-scope`: reconnect Supabase for database access.',
    status: 422,
  })
  async applyMigrations(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<ApplyMigrationsResponse> {
    const which = migratable(provider);
    const { migrations } = this.pipe.transform(body, {
      metatype: ApplyMigrationsRequestDto,
      type: 'body',
    }) as ApplyMigrationsRequestDto;

    return this.migrations.apply(
      this.tenant.tx,
      { orgId, projectId },
      caller.userId,
      which,
      migrations,
    );
  }

  @Put(':provider')
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Bind the project to a Neon or Supabase project or a Netlify site' })
  @ApiResponse({ description: 'The binding, with its operation.', status: 200 })
  @ApiResponse({
    description: '`needs-reauth`, `disconnected`, `removing`, `in-flight`.',
    status: 409,
  })
  @ApiResponse({ description: '`provider-unavailable`, with `Retry-After`.', status: 503 })
  async bind(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<Binding> {
    const which = bindable(provider);
    const parsed = this.pipe.transform(body, { metatype: BIND_BODIES[which], type: 'body' });

    return this.bindings.bind(this.tenant.tx, { orgId, projectId }, caller.userId, which, parsed);
  }

  @Delete(':provider')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Unbind: the resources are released, then the binding goes' })
  @ApiResponse({ status: 202, type: OperationResponseDto })
  unbind(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @Param('provider') provider: string,
  ): Promise<Operation> {
    return this.bindings.unbind(
      this.tenant.tx,
      { orgId, projectId },
      caller.userId,
      bindable(provider),
    );
  }
}
