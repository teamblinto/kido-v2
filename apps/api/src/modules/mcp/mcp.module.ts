import { Module } from '@nestjs/common';

import { IdempotencyModule } from '../../common/idempotency/idempotency.module';
import { AgentModule } from '../agent/agent.module';
import { AuditModule } from '../audit/audit.module';
import { CheckpointsModule } from '../checkpoints/checkpoints.module';
import { ConnectorsModule } from '../connectors/connectors.module';
import { DeployModule } from '../deploy/deploy.module';
import { PreviewReader } from '../preview/preview-reader';
import { RbacModule } from '../rbac/rbac.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { McpGrantsController } from './controllers/mcp-grants.controller';
import { McpController } from './controllers/mcp.controller';
import { OAuthConsentController, OAuthController } from './controllers/oauth.controller';
import { OAuthMetadataController } from './controllers/oauth-metadata.controller';
import { McpBearerGuard } from './mcp-bearer.guard';
import { McpGrantRepository } from './oauth/mcp-grant.repository';
import { McpOAuthService } from './oauth/mcp-oauth.service';
import { McpPlatform } from './server/mcp-platform';
import { McpServerFactory } from './server/mcp-server.factory';

/**
 * Spec 046: the platform as a remote MCP server, and the OAuth 2.1 authorization server that lets
 * a person connect Claude, ChatGPT, Cursor or any other MCP client to their account. It owns no
 * product behaviour: every tool calls the services the web app's own routes call.
 */
@Module({
  controllers: [
    McpController,
    McpGrantsController,
    OAuthConsentController,
    OAuthController,
    OAuthMetadataController,
  ],
  imports: [
    AgentModule,
    AuditModule,
    CheckpointsModule,
    ConnectorsModule,
    DeployModule,
    IdempotencyModule,
    RbacModule,
    SandboxModule,
    TenancyModule,
  ],
  providers: [
    McpBearerGuard,
    McpGrantRepository,
    McpOAuthService,
    McpPlatform,
    McpServerFactory,
    // Provided here rather than exported from the global `PreviewModule`, whose one export is a
    // deliberate limit (preview.module.spec.ts); it needs only the catalogue and the config.
    PreviewReader,
  ],
})
export class McpModule {}
