import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RbacModule } from '../rbac/rbac.module';
import { InvitationController } from './controllers/invitation.controller';
import { MembershipController } from './controllers/membership.controller';
import { OrgSettingsController } from './controllers/org-settings.controller';
import { OrgController, OrgReadController } from './controllers/org.controller';
import { ProjectAccessController } from './controllers/project-access.controller';
import { ProjectGrantController } from './controllers/project-grant.controller';
import { ProjectController } from './controllers/project.controller';
import { WorkspaceController } from './controllers/workspace.controller';
import { WorkspaceProjectController } from './controllers/workspace-project.controller';
import { PresenceController } from './presence/presence.controller';
import { PresenceService } from './presence/presence.service';
import { InvitationMailConsumer } from './services/invitation-mail.consumer';
import { InvitationService } from './services/invitation.service';
import { MembershipService } from './services/membership.service';
import { OrgService } from './services/org.service';
import { ProjectGrantService } from './services/project-grant.service';
import { ProjectInvitationMailConsumer } from './services/project-invitation-mail.consumer';
import { ProjectInvitationService } from './services/project-invitation.service';
import { ProjectService } from './services/project.service';
import { WorkspaceService } from './services/workspace.service';

/**
 * Organisations, memberships, workspaces and projects (T27), plus the project grants that make
 * somebody a guest (T30) — the tenant model §11's three scopes and its guest state are defined over.
 *
 * ## What is not here
 *
 * A route that adds a member directly: invitations are T29's. Project writes arrived with spec 007
 * on `WorkspaceProjectController`; workspace writes with the same spec on `WorkspaceController`.
 *
 * ## The two imports
 *
 * `IdentityModule` for `SessionService`, which `MembershipService` calls to revoke a removed
 * member's sessions wholesale (§11). `RbacModule` for `PermissionCache` and
 * `PermissionResolutionService` — the first is what a membership, workspace-role or grant change
 * invalidates, and the second is what `ProjectService.list` asks which projects the caller may see,
 * rather than deriving visibility a second time and differently.
 *
 * Both edges point the way §02 requires: a typed service interface through Nest DI, never another
 * module's repository. Nothing here touches an identity table, and nothing in `identity` touches a
 * tenancy one.
 *
 * `AuditService` arrives from the global `AuditModule`, and `TenantContext` and
 * `TenantTransactionRunner` from the global `DatabaseModule`.
 */
@Module({
  controllers: [
    InvitationController,
    MembershipController,
    OrgController,
    OrgReadController,
    OrgSettingsController,
    PresenceController,
    ProjectAccessController,
    ProjectController,
    ProjectGrantController,
    WorkspaceController,
    WorkspaceProjectController,
  ],
  exports: [
    InvitationService,
    MembershipService,
    OrgService,
    PresenceService,
    ProjectGrantService,
    ProjectInvitationService,
    ProjectService,
    WorkspaceService,
  ],
  // `OutboxModule` for `OutboxWriter`: an invitation appends its mail event (spec 006) and a
  // project its lifecycle events (spec 007).
  imports: [IdentityModule, OutboxModule, RbacModule],
  providers: [
    // Discovered by `QueueRegistry`, not exported (spec 006 research R6).
    InvitationMailConsumer,
    InvitationService,
    MembershipService,
    OrgService,
    PresenceService,
    ProjectGrantService,
    // Spec 031: discovered by `QueueRegistry`, like `InvitationMailConsumer`.
    ProjectInvitationMailConsumer,
    ProjectInvitationService,
    ProjectService,
    WorkspaceService,
  ],
})
export class TenancyModule {}
