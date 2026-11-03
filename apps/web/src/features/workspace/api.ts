import {
  type AcceptInvitationResponse,
  type CreateOrgRequest,
  IDEMPOTENCY_KEY_HEADER,
  type InvitationAcceptedResponse,
  type InviteMemberRequest,
  acceptInvitationRequestSchema,
  acceptInvitationResponseSchema,
  invitationAcceptedResponseSchema,
  inviteMemberRequestSchema,
  type CreateProjectRequest,
  type CreateWorkspaceRequest,
  type ModelCatalogueResponse,
  type OrgListResponse,
  type OrgMemberListResponse,
  type OrgResponse,
  type ProjectListResponse,
  type ProjectResponse,
  type RenameProjectRequest,
  type RenameWorkspaceRequest,
  type TemplateCatalogueResponse,
  type WorkspaceListResponse,
  type WorkspaceResponse,
  createOrgRequestSchema,
  createProjectRequestSchema,
  createWorkspaceRequestSchema,
  modelCatalogueResponseSchema,
  orgListResponseSchema,
  orgMemberListResponseSchema,
  orgResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  renameProjectRequestSchema,
  renameWorkspaceRequestSchema,
  templateCatalogueResponseSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
} from '@repo/contracts';

import { apiRequest } from '@/lib/api/client';

/**
 * The tenancy reads, the one write spec 001 exposes, and the project create spec 007 adds.
 *
 * Every path below the first takes an `orgId`, which is the shape §11 requires: the organisation is
 * derived from the resource being touched, never from a header or a body field. `GET /orgs` is the
 * exception that makes the rest usable — the one read rooted at a person rather than at an
 * organisation, and the route a client calls to learn which id to put in every other URL.
 */

export async function listOrgs(signal?: AbortSignal): Promise<OrgListResponse> {
  return apiRequest('GET', '/orgs', { schema: orgListResponseSchema, signal });
}

export async function createOrg(body: CreateOrgRequest): Promise<OrgResponse> {
  return apiRequest('POST', '/orgs', {
    body: createOrgRequestSchema.parse(body),
    schema: orgResponseSchema,
  });
}

export async function listWorkspaces(
  orgId: string,
  signal?: AbortSignal,
): Promise<WorkspaceListResponse> {
  return apiRequest('GET', `/orgs/${encodeURIComponent(orgId)}/workspaces`, {
    schema: workspaceListResponseSchema,
    signal,
  });
}

function workspacePath(orgId: string, workspaceId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`;
}

/** Workspace writes (spec 007), all behind `org:settings.update`. Rename and delete answer `204`. */
export async function createWorkspace(
  orgId: string,
  body: CreateWorkspaceRequest,
): Promise<WorkspaceResponse> {
  return apiRequest('POST', `/orgs/${encodeURIComponent(orgId)}/workspaces`, {
    body: createWorkspaceRequestSchema.parse(body),
    schema: workspaceResponseSchema,
  });
}

export async function renameWorkspace(
  orgId: string,
  workspaceId: string,
  body: RenameWorkspaceRequest,
): Promise<void> {
  return apiRequest('PATCH', workspacePath(orgId, workspaceId), {
    body: renameWorkspaceRequestSchema.parse(body),
  });
}

/** An archive, not a purge: the workspace's live projects are archived with it. */
export async function deleteWorkspace(orgId: string, workspaceId: string): Promise<void> {
  return apiRequest('DELETE', workspacePath(orgId, workspaceId));
}

/** Project writes live under the workspace, because the permissions admitting them are its. */
export async function renameProject(
  orgId: string,
  workspaceId: string,
  projectId: string,
  body: RenameProjectRequest,
): Promise<void> {
  return apiRequest(
    'PATCH',
    `${workspacePath(orgId, workspaceId)}/projects/${encodeURIComponent(projectId)}`,
    { body: renameProjectRequestSchema.parse(body) },
  );
}

export async function deleteProject(
  orgId: string,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  return apiRequest(
    'DELETE',
    `${workspacePath(orgId, workspaceId)}/projects/${encodeURIComponent(projectId)}`,
  );
}

/**
 * The projects the caller may read.
 *
 * The listing *excludes* what the caller cannot see rather than refusing per item, which is what
 * makes it safe to render straight into a shelf: a guest sees only their granted projects, and the
 * count is not a count of the organisation's work.
 */
export async function listProjects(
  orgId: string,
  signal?: AbortSignal,
): Promise<ProjectListResponse> {
  return apiRequest('GET', `/orgs/${encodeURIComponent(orgId)}/projects`, {
    schema: projectListResponseSchema,
    signal,
  });
}

export async function listMembers(
  orgId: string,
  signal?: AbortSignal,
): Promise<OrgMemberListResponse> {
  return apiRequest('GET', `/orgs/${encodeURIComponent(orgId)}/members`, {
    schema: orgMemberListResponseSchema,
    signal,
  });
}

/**
 * `POST /orgs/:orgId/invitations` (T29). One `Idempotency-Key` per call, so a retried request does
 * not mint a second invitation.
 */
export async function inviteMember(
  orgId: string,
  body: InviteMemberRequest,
): Promise<InvitationAcceptedResponse> {
  return apiRequest('POST', `/orgs/${encodeURIComponent(orgId)}/invitations`, {
    body: inviteMemberRequestSchema.parse(body),
    headers: { [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() },
    schema: invitationAcceptedResponseSchema,
  });
}

/** `POST /orgs/:orgId/invitations/accept` (T29): the caller becomes a member. */
export async function acceptInvitation(
  orgId: string,
  token: string,
): Promise<AcceptInvitationResponse> {
  return apiRequest('POST', `/orgs/${encodeURIComponent(orgId)}/invitations/accept`, {
    body: acceptInvitationRequestSchema.parse({ token }),
    schema: acceptInvitationResponseSchema,
  });
}

export async function getProject(
  orgId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectResponse> {
  return apiRequest(
    'GET',
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`,
    { schema: projectResponseSchema, signal },
  );
}

/**
 * `POST /orgs/:orgId/workspaces/:workspaceId/projects` (spec 007). Under the workspace because the
 * permission that admits it is a workspace-scoped one; the body is parsed here so a client cannot
 * send the API a shape the contract does not name.
 */
export async function createProject(
  orgId: string,
  workspaceId: string,
  body: CreateProjectRequest,
  signal?: AbortSignal,
): Promise<ProjectResponse> {
  return apiRequest(
    'POST',
    `/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/projects`,
    { body: createProjectRequestSchema.parse(body), schema: projectResponseSchema, signal },
  );
}

/**
 * `GET /orgs/:orgId/models` (spec 011, per organisation since 020 § 2): the models a run may use,
 * each stamped with the credential a run on it would be recorded as, and which one is the default.
 */
export async function fetchModelCatalogue(
  orgId: string,
  signal?: AbortSignal,
): Promise<ModelCatalogueResponse> {
  return apiRequest('GET', `/orgs/${encodeURIComponent(orgId)}/models`, {
    schema: modelCatalogueResponseSchema,
    signal,
  });
}

/**
 * The template catalogue (spec 015): deployment-wide and tenant-blind, so no `orgId` in the path.
 *
 * Session-long — nothing about it changes while a page is open, which is why the query that holds
 * it is never invalidated.
 */
export async function listTemplates(signal?: AbortSignal): Promise<TemplateCatalogueResponse> {
  return apiRequest('GET', '/templates', { schema: templateCatalogueResponseSchema, signal });
}
