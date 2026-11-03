import { relations } from 'drizzle-orm';

import { auditLog } from './schema/audit';
import { providerKeys } from './schema/byok';
import { linkedAccounts } from './schema/byos';
import { checkpoints } from './schema/checkpoints';
import { connections, repoLinks, syncOperations } from './schema/connectors';
import { projectContext } from './schema/context';
import { deployments, projectSites } from './schema/deploy';
import { users } from './schema/identity';
import { oauthIdentities } from './schema/oauth';
import { invitations } from './schema/rbac';
import { sandboxes } from './schema/sandbox';
import { orgDataKeys, secrets } from './schema/secrets';
import {
  memberships,
  orgs,
  projectGrants,
  projects,
  workspaceMembers,
  workspaces,
} from './schema/tenancy';
import { emailVerificationTokens, mfaRecoveryCodes, passwordResetTokens } from './schema/tokens';

/**
 * Relations are the query-API view of the foreign keys declared in `./schema`. Where the key is
 * composite, so is the relation — `fields` and `references` carry both columns, so a generated
 * join can never degrade into the single-column join the composite key exists to prevent.
 *
 * `memberships` has two edges to `users` (the member, and whoever invited them), so both sides are
 * disambiguated with an explicit `relationName`.
 *
 * `audit_log.actor_id` has no relation because it has no foreign key: the trail outlives the rows
 * it names, which is argued where the table is declared.
 */
export const usersRelations = relations(users, ({ many }) => ({
  emailVerificationTokens: many(emailVerificationTokens),
  invitedMemberships: many(memberships, { relationName: 'membershipInviter' }),
  linkedAccounts: many(linkedAccounts),
  memberships: many(memberships, { relationName: 'membershipUser' }),
  mfaRecoveryCodes: many(mfaRecoveryCodes),
  oauthIdentities: many(oauthIdentities),
  passwordResetTokens: many(passwordResetTokens),
  projectGrants: many(projectGrants),
  providerKeysAdded: many(providerKeys),
  sentInvitations: many(invitations),
}));

export const orgsRelations = relations(orgs, ({ many }) => ({
  auditLog: many(auditLog),
  connections: many(connections),
  dataKeys: many(orgDataKeys),
  invitations: many(invitations),
  memberships: many(memberships),
  projectGrants: many(projectGrants),
  projects: many(projects),
  providerKeys: many(providerKeys),
  secrets: many(secrets),
  workspaceMembers: many(workspaceMembers),
  workspaces: many(workspaces),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  invitedByUser: one(users, {
    fields: [memberships.invitedBy],
    references: [users.id],
    relationName: 'membershipInviter',
  }),
  org: one(orgs, { fields: [memberships.orgId], references: [orgs.id] }),
  user: one(users, {
    fields: [memberships.userId],
    references: [users.id],
    relationName: 'membershipUser',
  }),
}));

export const workspacesRelations = relations(workspaces, ({ many, one }) => ({
  members: many(workspaceMembers),
  org: one(orgs, { fields: [workspaces.orgId], references: [orgs.id] }),
  projects: many(projects),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  org: one(orgs, { fields: [workspaceMembers.orgId], references: [orgs.id] }),
  user: one(users, { fields: [workspaceMembers.userId], references: [users.id] }),
  workspace: one(workspaces, {
    fields: [workspaceMembers.orgId, workspaceMembers.workspaceId],
    references: [workspaces.orgId, workspaces.id],
  }),
}));

export const projectsRelations = relations(projects, ({ many, one }) => ({
  context: one(projectContext, {
    fields: [projects.orgId, projects.id],
    references: [projectContext.orgId, projectContext.projectId],
  }),
  deployments: many(deployments),
  grants: many(projectGrants),
  repoLink: one(repoLinks, {
    fields: [projects.orgId, projects.id],
    references: [repoLinks.orgId, repoLinks.projectId],
  }),
  sandboxes: many(sandboxes),
  site: one(projectSites, {
    fields: [projects.orgId, projects.id],
    references: [projectSites.orgId, projectSites.projectId],
  }),
  syncOperations: many(syncOperations),
  org: one(orgs, { fields: [projects.orgId], references: [orgs.id] }),
  workspace: one(workspaces, {
    fields: [projects.orgId, projects.workspaceId],
    references: [workspaces.orgId, workspaces.id],
  }),
}));

export const projectContextRelations = relations(projectContext, ({ one }) => ({
  project: one(projects, {
    fields: [projectContext.orgId, projectContext.projectId],
    references: [projects.orgId, projects.id],
  }),
}));

export const projectGrantsRelations = relations(projectGrants, ({ one }) => ({
  org: one(orgs, { fields: [projectGrants.orgId], references: [orgs.id] }),
  project: one(projects, {
    fields: [projectGrants.orgId, projectGrants.projectId],
    references: [projects.orgId, projects.id],
  }),
  user: one(users, { fields: [projectGrants.userId], references: [users.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  org: one(orgs, { fields: [auditLog.orgId], references: [orgs.id] }),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  invitedByUser: one(users, { fields: [invitations.invitedBy], references: [users.id] }),
  org: one(orgs, { fields: [invitations.orgId], references: [orgs.id] }),
}));

export const orgDataKeysRelations = relations(orgDataKeys, ({ many, one }) => ({
  org: one(orgs, { fields: [orgDataKeys.orgId], references: [orgs.id] }),
  secrets: many(secrets),
}));

export const secretsRelations = relations(secrets, ({ one }) => ({
  dataKey: one(orgDataKeys, {
    fields: [secrets.orgId, secrets.dekId],
    references: [orgDataKeys.orgId, orgDataKeys.id],
  }),
  org: one(orgs, { fields: [secrets.orgId], references: [orgs.id] }),
}));

export const emailVerificationTokensRelations = relations(emailVerificationTokens, ({ one }) => ({
  user: one(users, { fields: [emailVerificationTokens.userId], references: [users.id] }),
}));

export const mfaRecoveryCodesRelations = relations(mfaRecoveryCodes, ({ one }) => ({
  user: one(users, { fields: [mfaRecoveryCodes.userId], references: [users.id] }),
}));

export const oauthIdentitiesRelations = relations(oauthIdentities, ({ one }) => ({
  user: one(users, { fields: [oauthIdentities.userId], references: [users.id] }),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, { fields: [passwordResetTokens.userId], references: [users.id] }),
}));

export const sandboxesRelations = relations(sandboxes, ({ one }) => ({
  org: one(orgs, { fields: [sandboxes.orgId], references: [orgs.id] }),
  project: one(projects, {
    fields: [sandboxes.orgId, sandboxes.projectId],
    references: [projects.orgId, projects.id],
  }),
}));

export const connectionsRelations = relations(connections, ({ many, one }) => ({
  connectedByUser: one(users, { fields: [connections.connectedBy], references: [users.id] }),
  org: one(orgs, { fields: [connections.orgId], references: [orgs.id] }),
  repoLinks: many(repoLinks),
  secret: one(secrets, {
    fields: [connections.orgId, connections.secretId],
    references: [secrets.orgId, secrets.id],
  }),
}));

export const linkedAccountsRelations = relations(linkedAccounts, ({ one }) => ({
  user: one(users, { fields: [linkedAccounts.userId], references: [users.id] }),
}));

export const providerKeysRelations = relations(providerKeys, ({ one }) => ({
  addedByUser: one(users, { fields: [providerKeys.addedBy], references: [users.id] }),
  org: one(orgs, { fields: [providerKeys.orgId], references: [orgs.id] }),
  secret: one(secrets, {
    fields: [providerKeys.orgId, providerKeys.secretId],
    references: [secrets.orgId, secrets.id],
  }),
}));

export const repoLinksRelations = relations(repoLinks, ({ many, one }) => ({
  connection: one(connections, {
    fields: [repoLinks.orgId, repoLinks.connectionId],
    references: [connections.orgId, connections.id],
  }),
  lastPushedCheckpoint: one(checkpoints, {
    fields: [repoLinks.orgId, repoLinks.lastPushedCheckpointId],
    references: [checkpoints.orgId, checkpoints.id],
  }),
  linkedByUser: one(users, { fields: [repoLinks.linkedBy], references: [users.id] }),
  org: one(orgs, { fields: [repoLinks.orgId], references: [orgs.id] }),
  project: one(projects, {
    fields: [repoLinks.orgId, repoLinks.projectId],
    references: [projects.orgId, projects.id],
  }),
  syncOperations: many(syncOperations),
}));

export const syncOperationsRelations = relations(syncOperations, ({ many, one }) => ({
  checkpoints: many(checkpoints),
  link: one(repoLinks, {
    fields: [syncOperations.orgId, syncOperations.linkId],
    references: [repoLinks.orgId, repoLinks.id],
  }),
  org: one(orgs, { fields: [syncOperations.orgId], references: [orgs.id] }),
  project: one(projects, {
    fields: [syncOperations.orgId, syncOperations.projectId],
    references: [projects.orgId, projects.id],
  }),
  requestedByUser: one(users, { fields: [syncOperations.requestedBy], references: [users.id] }),
}));

export const checkpointsRelations = relations(checkpoints, ({ one }) => ({
  syncOperation: one(syncOperations, {
    fields: [checkpoints.orgId, checkpoints.syncOperationId],
    references: [syncOperations.orgId, syncOperations.id],
  }),
}));

export const deploymentsRelations = relations(deployments, ({ one }) => ({
  checkpoint: one(checkpoints, {
    fields: [deployments.orgId, deployments.checkpointId],
    references: [checkpoints.orgId, checkpoints.id],
  }),
  org: one(orgs, { fields: [deployments.orgId], references: [orgs.id] }),
  project: one(projects, {
    fields: [deployments.orgId, deployments.projectId],
    references: [projects.orgId, projects.id],
  }),
  requestedByUser: one(users, { fields: [deployments.requestedBy], references: [users.id] }),
}));

export const projectSitesRelations = relations(projectSites, ({ one }) => ({
  currentDeployment: one(deployments, {
    fields: [projectSites.orgId, projectSites.currentDeploymentId],
    references: [deployments.orgId, deployments.id],
  }),
  org: one(orgs, { fields: [projectSites.orgId], references: [orgs.id] }),
  project: one(projects, {
    fields: [projectSites.orgId, projectSites.projectId],
    references: [projects.orgId, projects.id],
  }),
  updatedByUser: one(users, { fields: [projectSites.updatedBy], references: [users.id] }),
}));
