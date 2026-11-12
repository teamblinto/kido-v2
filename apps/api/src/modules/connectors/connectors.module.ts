import { Module } from '@nestjs/common';
import type { ConnectorOpKind, ConnectorProvider } from '@repo/contracts';
import type { ConnectorResource } from '@repo/db';

import { AuditModule } from '../audit/audit.module';
import { CheckpointsModule } from '../checkpoints/checkpoints.module';
import { DeployModule } from '../deploy/deploy.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RbacModule } from '../rbac/rbac.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AutoSyncConsumer } from './autosync.consumer';
import { BindingRepository } from './binding.repository';
import { BindingService } from './binding.service';
import { ConnectionRepository } from './connection.repository';
import {
  ConnectionRemoveHandler,
  RESOURCE_RELEASERS,
  type ResourceReleaser,
  type ResourceReleasers,
} from './connection-remove.handler';
import { CloudflareDnsService } from './cloudflare-dns.service';
import { CloudflareRecordReleaser } from './cloudflare-record.releaser';
import { ConnectionService } from './connection.service';
import { ConnectorHealthConsumer, RESEND_DOMAIN_READER } from './connector-health.consumer';
import {
  CONNECTOR_OP_HANDLERS,
  ConnectorOpsConsumer,
  type OperationHandler,
  type OperationHandlers,
} from './connector-ops.consumer';
import { ConnectorDomainConsumer } from './connector-domain.consumer';
import { ConnectorListings } from './connector-listings';
import { ConnectorProjectConsumer } from './connector-project.consumer';
import { BindingsController } from './controllers/bindings.controller';
import { DatabaseMigrationService } from './database-migrations';
import { CloudflareDnsController } from './controllers/cloudflare-dns.controller';
import { ConnectorListingsController } from './controllers/connector-listings.controller';
import { ConnectorsController } from './controllers/connectors.controller';
import { ProviderConnectController } from './controllers/provider-connect.controller';
import { RepoLinkController } from './controllers/repo-link.controller';
import { SyncController } from './controllers/sync.controller';
import { DnsWriteHandler } from './dns-write.handler';
import { GITHUB_APP_CLIENT, GithubAppClient } from './github-app.client';
import { WebhookDeliveryConsumer } from './webhook.consumer';
import { ImportController, ImportMismatchController } from './controllers/import.controller';
import { ImportRunner } from './import.runner';
import { ImportService } from './import.service';
import { InstallStateStore } from './install-state';
import { LOCAL_GIT, LocalGit } from './local-git';
import { NetlifyPublishHandler } from './netlify-publish.handler';
import { OperationRepository } from './operation.repository';
import {
  BindingReleaseHandler,
  NeonBranchHandler,
  NeonBranchReleaser,
  ResendKeyHandler,
  ResendKeyReleaser,
  SupabaseKeyHandler,
  SupabaseKeyReleaser,
} from './preview-resource.handlers';
import { OperationService } from './operation.service';
import {
  CLOUDFLARE_DNS_CLIENT,
  CloudflareDnsClient,
} from './providers/cloudflare/cloudflare-dns.client';
import { NEON_CLIENT, NeonClient } from './providers/neon/neon.client';
import { NETLIFY_CLIENT, NetlifyClient } from './providers/netlify/netlify.client';
import {
  PROVIDER_VERIFIERS,
  type ProviderVerifier,
  type ProviderVerifiers,
} from './providers/provider';
import { RESEND_CLIENT, ResendClient } from './providers/resend/resend.client';
import { SUPABASE_CLIENT, SupabaseClient } from './providers/supabase/supabase.client';
import { PullRunner } from './pull.consumer';
import { IMPORT_RUNNER, PULL_RUNNER, SyncConsumer } from './push.consumer';
import { RepoLinkRepository } from './repo-link.repository';
import { RepoLinkService } from './repo-link.service';
import { ResourceReleaseHandler } from './resource-release.handler';
import { ResourceRepository } from './resource.repository';
import { ResourceSecrets } from './resource-secrets';
import { SyncRepository } from './sync.repository';
import { SyncService } from './sync.service';

/**
 * The GitHub connector (spec 018). `CheckpointsModule` for the bundler the push reads,
 * `SandboxModule` for the port the pull applies through, `OutboxModule` for the sync operations,
 * `AuditModule` for the trail, `RbacModule` and `IdentityModule` for the routes' guards; the crypto
 * seal, Redis, the clock and the transaction runner arrive from the global modules. No guard of
 * its own: the routes ride the global guard chain untouched.
 */
@Module({
  controllers: [
    BindingsController,
    ConnectorListingsController,
    CloudflareDnsController,
    ConnectorsController,
    ImportController,
    ImportMismatchController,
    ProviderConnectController,
    RepoLinkController,
    SyncController,
  ],
  exports: [
    BindingService,
    ConnectionService,
    GITHUB_APP_CLIENT,
    LOCAL_GIT,
    RepoLinkService,
    ResourceSecrets,
    SyncService,
  ],
  imports: [
    AuditModule,
    CheckpointsModule,
    // Spec 030 contracts/provider-adapters.md § 8: the Netlify publish reads a release through
    // `ReleaseReader`, the Cloudflare write a domain's records through `DomainRecordsReader` —
    // both `deploy` exports. The reverse edge never exists (`.dependency-cruiser.cjs`).
    DeployModule,
    IdentityModule,
    OutboxModule,
    RbacModule,
    SandboxModule,
    // Spec 026 R12: an import creates a project, and `ProjectService` owns that. The one new
    // module edge this feature declares (`.dependency-cruiser.cjs`); never `projects`' repository.
    TenancyModule,
    // Spec 029 R1: the inbound pipeline moved to `webhooks`; the consumer reads and settles a
    // delivery through `InboundDeliveryService`, never the repository.
    WebhooksModule,
  ],
  providers: [
    // Spec 044: `checkpoint.created` on `connector.autosync`, beside the mirror's own queue.
    AutoSyncConsumer,
    BindingReleaseHandler,
    BindingRepository,
    BindingService,
    DatabaseMigrationService,
    // Spec 030 US2: the Cloudflare offer and write on a custom domain, its release on removal.
    CloudflareDnsService,
    CloudflareRecordReleaser,
    DnsWriteHandler,
    ResourceReleaseHandler,
    ConnectionRemoveHandler,
    ConnectionRepository,
    ConnectionService,
    ConnectorHealthConsumer,
    // Spec 030 US6: the pending-Resend-domain re-check reads through the Resend client (US5).
    { provide: RESEND_DOMAIN_READER, useExisting: RESEND_CLIENT },
    // Spec 030 R15: provider writes, on the `connector.ops` queue.
    ConnectorOpsConsumer,
    // `domain.removing` → the release of the records written through Cloudflare, on `connector.ops`.
    ConnectorDomainConsumer,
    ConnectorListings,
    // Spec 030 T075: an archived project's bindings released, on `connector.ops` too.
    ConnectorProjectConsumer,
    ImportService,
    NeonBranchHandler,
    NetlifyPublishHandler,
    NeonBranchReleaser,
    ResendKeyHandler,
    ResendKeyReleaser,
    SupabaseKeyHandler,
    SupabaseKeyReleaser,
    InstallStateStore,
    OperationRepository,
    OperationService,
    RepoLinkRepository,
    RepoLinkService,
    ResourceRepository,
    ResourceSecrets,
    SyncRepository,
    SyncConsumer,
    SyncService,
    // Spec 026 US4; the receiving controller and its verifier live in `webhooks` since spec 029. The
    // consumer is an ordinary provider, which is how `QueueRegistry` discovers it and how the
    // `connector.webhook` queue comes to exist on the `events` lane.
    WebhookDeliveryConsumer,
    { provide: GITHUB_APP_CLIENT, useClass: GithubAppClient },
    { provide: IMPORT_RUNNER, useClass: ImportRunner },
    { provide: LOCAL_GIT, useClass: LocalGit },
    { provide: PULL_RUNNER, useClass: PullRunner },
    // Spec 030 contracts/provider-adapters.md §§ 2–6: one adapter per provider.
    { provide: CLOUDFLARE_DNS_CLIENT, useClass: CloudflareDnsClient },
    { provide: NEON_CLIENT, useClass: NeonClient },
    { provide: NETLIFY_CLIENT, useClass: NetlifyClient },
    { provide: RESEND_CLIENT, useClass: ResendClient },
    { provide: SUPABASE_CLIENT, useClass: SupabaseClient },
    // Spec 030 R3: one verifier per non-GitHub provider, keyed by provider. Each provider's story
    // adds its adapter's token to `inject` and one entry to the map — registration is one line.
    // Spec 030: one handler per operation kind; each provider's story adds its entries.
    {
      inject: [
        ConnectionRemoveHandler,
        DnsWriteHandler,
        BindingReleaseHandler,
        NeonBranchHandler,
        SupabaseKeyHandler,
        NetlifyPublishHandler,
        ResendKeyHandler,
      ],
      provide: CONNECTOR_OP_HANDLERS,
      useFactory: (
        remove: ConnectionRemoveHandler,
        dnsWrite: DnsWriteHandler,
        release: BindingReleaseHandler,
        neonBranch: NeonBranchHandler,
        supabaseKey: SupabaseKeyHandler,
        netlifyPublish: NetlifyPublishHandler,
        resendKey: ResendKeyHandler,
      ): OperationHandlers =>
        new Map<ConnectorOpKind, OperationHandler>([
          ['connection_remove', remove],
          ['dns_write', dnsWrite],
          // Spec 030 US3: a binding's release also drops its values and, once empty, the row.
          ['resource_release', release],
          ['neon_branch_create', neonBranch],
          ['neon_branch_reset', neonBranch],
          ['supabase_key_fetch', supabaseKey],
          // Spec 030 US4 (R11); its timeout is `STALE_PUBLISH_MS`.
          ['netlify_publish', netlifyPublish],
          // Spec 030 US5: the domain-restricted sending key.
          ['resend_key_mint', resendKey],
        ]),
    },
    // Per resource kind; the stories that create resources add theirs (T058, T076, T096).
    {
      inject: [
        CloudflareRecordReleaser,
        NeonBranchReleaser,
        SupabaseKeyReleaser,
        ResendKeyReleaser,
      ],
      provide: RESOURCE_RELEASERS,
      useFactory: (
        cloudflareRecord: CloudflareRecordReleaser,
        neonBranch: NeonBranchReleaser,
        supabaseKey: SupabaseKeyReleaser,
        resendKey: ResendKeyReleaser,
      ): ResourceReleasers =>
        new Map<ConnectorResource['kind'], ResourceReleaser>([
          ['cloudflare_dns_record', cloudflareRecord],
          ['neon_branch', neonBranch],
          ['resend_sending_key', resendKey],
          ['supabase_publishable_key', supabaseKey],
        ]),
    },
    {
      inject: [NETLIFY_CLIENT, NEON_CLIENT, SUPABASE_CLIENT, RESEND_CLIENT, CLOUDFLARE_DNS_CLIENT],
      provide: PROVIDER_VERIFIERS,
      useFactory: (
        netlify: NetlifyClient,
        neon: NeonClient,
        supabase: SupabaseClient,
        resend: ResendClient,
        cloudflare: CloudflareDnsClient,
      ): ProviderVerifiers =>
        new Map<ConnectorProvider, ProviderVerifier>([
          ['netlify', netlify],
          ['neon', neon],
          ['supabase', supabase],
          ['resend', resend],
          ['cloudflare', cloudflare],
        ]),
    },
  ],
})
export class ConnectorsModule {}
