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
  Query,
} from '@nestjs/common';
import { ApiExtraModels, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import type {
  Connection,
  ConnectionList,
  InstallResponse,
  Operation,
  RepositoryPage,
} from '@repo/contracts';

import { TenantContext } from '../../../database/tenant-context';
import { CurrentUser } from '../../identity/decorators/current-user.decorator';
import { StepUp } from '../../identity/decorators/step-up.decorator';
import type { AuthenticatedUser } from '../../identity/services/session.service';
import { RequirePermission } from '../../rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../../rbac/resource-org.resolver';
import { ConnectionService } from '../connection.service';
import { OperationService } from '../operation.service';
import {
  CompleteInstallRequestDto,
  ConnectionListResponseDto,
  GithubConnectionResponseDto,
  InstallResponseDto,
  OperationResponseDto,
  ProviderConnectionResponseDto,
  RepositoryPageResponseDto,
  RepositoryQueryDto,
} from '../dto/connection.dto';

/**
 * An organisation's connectors (spec 018 US1, contracts § 1): read for a member, connect and
 * remove for `org:connectors.manage`. Every response is the contract row — the sealed token's
 * fingerprint and nothing else of it (SC-002). `POST :connectionId/verify` runs the health check
 * synchronously (US4).
 */
@ApiTags('connectors')
@ApiExtraModels(GithubConnectionResponseDto, ProviderConnectionResponseDto)
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/connectors', version: '1' })
export class ConnectorsController {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(OperationService) private readonly operations: OperationService,
  ) {}

  @Get()
  @RequirePermission('org:connectors.read')
  @ApiOperation({ summary: 'List the organisation’s connectors' })
  @ApiResponse({ status: 200, type: ConnectionListResponseDto })
  async list(@Param('orgId') orgId: string): Promise<ConnectionList> {
    const rows = await this.connections.list(this.tenant.tx, orgId);

    return { connections: rows.map((row) => this.connections.toContract(row)) };
  }

  @Post('github/install')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Start installing the GitHub App for this organisation' })
  @ApiResponse({ status: 200, type: InstallResponseDto })
  @ApiResponse({ description: 'The GitHub App is not configured on this deployment.', status: 501 })
  install(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
  ): Promise<InstallResponse> {
    return this.connections.beginInstall(orgId, caller.userId);
  }

  @Post('github/complete')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Finish the installation GitHub sent the browser back from' })
  @ApiResponse({ status: 201, type: GithubConnectionResponseDto })
  @ApiResponse({ description: 'The state is unknown, spent or for another org.', status: 400 })
  @ApiResponse({ description: 'GitHub did not confirm the installation.', status: 502 })
  async complete(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: CompleteInstallRequestDto,
  ): Promise<Connection> {
    const row = await this.connections.completeInstall(this.tenant.tx, orgId, caller.userId, body);

    return this.connections.toContract(await this.connections.byId(this.tenant.tx, orgId, row.id));
  }

  /**
   * Spec 030 contracts/bindings.md § 1, R14: removal is queued (`connection_remove`) and the
   * connection refused new work at once. Every provider's removal — GitHub's included — needs a
   * recent second factor.
   */
  @Delete(':connectionId')
  @HttpCode(HttpStatus.ACCEPTED)
  @StepUp()
  @RequirePermission('org:connectors.manage')
  @ApiOperation({
    summary:
      'Remove the connector: its resources are released, its links and bindings kept, disconnected',
  })
  @ApiResponse({ status: 202, type: OperationResponseDto })
  @ApiResponse({ description: 'No recent second factor.', status: 403 })
  async remove(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('connectionId') connectionId: string,
  ): Promise<Operation> {
    const operation = await this.connections.requestRemoval(
      this.tenant.tx,
      orgId,
      caller.userId,
      connectionId,
    );

    return this.operations.toContract(operation);
  }

  @Post(':connectionId/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('org:connectors.manage')
  @ApiOperation({ summary: 'Check the connection against GitHub now and answer its state' })
  @ApiResponse({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(GithubConnectionResponseDto) },
        { $ref: getSchemaPath(ProviderConnectionResponseDto) },
      ],
    },
    status: 200,
  })
  async verify(
    @CurrentUser() caller: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Param('connectionId') connectionId: string,
  ): Promise<Connection> {
    const row = await this.connections.verify(this.tenant.tx, orgId, connectionId, caller.userId);

    return this.connections.toContract(row);
  }

  @Get(':connectionId/repositories')
  @RequirePermission('org:connectors.read')
  @ApiOperation({ summary: 'List the repositories the installation can see, filtered by name' })
  @ApiResponse({ status: 200, type: RepositoryPageResponseDto })
  async repositories(
    @Param('orgId') orgId: string,
    @Param('connectionId') connectionId: string,
    @Query() query: RepositoryQueryDto,
  ): Promise<RepositoryPage> {
    await this.connections.byId(this.tenant.tx, orgId, connectionId);

    return this.connections.listRepositories(this.tenant.tx, orgId, query);
  }
}
