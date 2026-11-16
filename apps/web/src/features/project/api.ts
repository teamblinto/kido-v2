import {
  authorizePreviewResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  type AddDomainRequest,
  type CheckpointDiffResponse,
  type Checkpoint,
  type CheckpointListResponse,
  type CreateDeploymentRequest,
  type CreateRunRequest,
  type DeploymentListResponse,
  type DeploymentLogResponse,
  type DeploymentResponse,
  type DomainListResponse,
  type DomainResponse,
  type FileContentResponse,
  type FileListResponse,
  type PreviewResponse,
  type PreviewVisibility,
  type RemoveDomainResponse,
  type RotatePreviewResponse,
  type RunEventsResponse,
  type RunInputRequest,
  type RunListResponse,
  type RunMessagesResponse,
  type RunResponse,
  type SiteResponse,
  type UpdateSiteRequest,
  type WakeResponse,
  type WriteFileRequest,
  type WriteFileResponse,
  addDomainRequestSchema,
  checkpointDiffResponseSchema,
  checkpointListResponseSchema,
  checkpointSchema,
  createDeploymentRequestSchema,
  createRunRequestSchema,
  deploymentListResponseSchema,
  deploymentLogResponseSchema,
  deploymentResponseSchema,
  domainListResponseSchema,
  domainResponseSchema,
  fileContentResponseSchema,
  fileListResponseSchema,
  previewResponseSchema,
  removeDomainResponseSchema,
  rotatePreviewResponseSchema,
  runEventsResponseSchema,
  runInputRequestSchema,
  runListResponseSchema,
  runMessagesResponseSchema,
  runResponseSchema,
  setPreviewVisibilityRequestSchema,
  siteResponseSchema,
  type SyncOperation,
  syncOperationSchema,
  updateSiteRequestSchema,
  wakeResponseSchema,
  writeFileRequestSchema,
  writeFileResponseSchema,
} from '@repo/contracts';

import { joinUrl } from '@repo/utils';

import { apiRequest } from '@/lib/api/client';
import { env } from '@/lib/env';

/**
 * The five calls the run console makes, as contracts/console-client.md names them.
 *
 * Every one goes through `apiRequest` with a schema from `@repo/contracts` — none is declared
 * here. A response the contract does not describe is a failure rather than a partial render, and
 * a refusal travels as an `ApiProblem` for `MESSAGES` to put a sentence to (FR-021): nothing below
 * constructs an error body or a message of its own.
 *
 * The `(orgId, projectId, …, signal?)` shape is `features/workspace/api.ts`'s, deliberately. The
 * organisation is derived from the resource being touched rather than from a header, and every
 * read can be cancelled by the query that superseded it.
 *
 * `GET …/runs/:runId/stream` is the exception at the foot of the file: a stream is opened by
 * `EventSource`, which takes a URL rather than a request, so it is a URL here and not a call.
 */

/** The path every project-scoped call below hangs off. */
function projectPath(orgId: string, projectId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
}

function runsPath(orgId: string, projectId: string): string {
  return `${projectPath(orgId, projectId)}/runs`;
}

/**
 * `?a=1&b=2` for the parameters that were given, `''` for none.
 *
 * An absent parameter is left out rather than sent empty: the API's queries are strict objects
 * with their own defaults, and `?limit=` is not the same request as no `limit` at all.
 */
function search(query: Readonly<Record<string, number | string | undefined>>): string {
  const params = new URLSearchParams();

  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(name, String(value));
    }
  }

  return params.size === 0 ? '' : `?${params.toString()}`;
}

/**
 * Start a run.
 *
 * The body is parsed here so the app cannot send the API a shape the contract does not name: it
 * is `{ prompt, model? }` and nothing else. `model` is the workspace picker's choice riding in on
 * a project's first run (spec 011 US6); left out, the API applies its default. Either way the run
 * reports the model it used and the console displays it, which is the whole of 012's FR-019.
 */
export async function createRun(
  orgId: string,
  projectId: string,
  body: CreateRunRequest,
  signal?: AbortSignal,
): Promise<RunResponse> {
  return apiRequest('POST', runsPath(orgId, projectId), {
    body: createRunRequestSchema.parse(body),
    schema: runResponseSchema,
    signal,
  });
}

/**
 * Ask a run to stop.
 *
 * `202` with no body: the request is recorded and the run's own `cancelRequestedAt` reports it on
 * the next read. The `202` is the acknowledgement the console reflects while the run is still
 * finishing — cancellation is a request, and the terminal `state` event arrives later (FR-013).
 */
export async function cancelRun(
  orgId: string,
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<void> {
  return apiRequest('POST', `${runsPath(orgId, projectId)}/${encodeURIComponent(runId)}/cancel`, {
    signal,
  });
}

/** Answer a run that is `awaiting_input`. `202` with no body: the run goes back through the queue. */
export async function answerRun(
  orgId: string,
  projectId: string,
  runId: string,
  body: RunInputRequest,
  signal?: AbortSignal,
): Promise<void> {
  return apiRequest('POST', `${runsPath(orgId, projectId)}/${encodeURIComponent(runId)}/input`, {
    body: runInputRequestSchema.parse(body),
    signal,
  });
}

export async function getRun(
  orgId: string,
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<RunResponse> {
  return apiRequest('GET', `${runsPath(orgId, projectId)}/${encodeURIComponent(runId)}`, {
    schema: runResponseSchema,
    signal,
  });
}

/**
 * A page of a run's durable events, `seq > after`, ascending.
 *
 * How a finished run is rebuilt: the caller pages on `after` until `lastSeq` is reached, opening
 * no stream at all (FR-014).
 */
export async function getRunEvents(
  orgId: string,
  projectId: string,
  runId: string,
  query: { readonly after?: number; readonly limit?: number } = {},
  signal?: AbortSignal,
): Promise<RunEventsResponse> {
  return apiRequest(
    'GET',
    `${runsPath(orgId, projectId)}/${encodeURIComponent(runId)}/events${search(query)}`,
    { schema: runEventsResponseSchema, signal },
  );
}

/** The project's runs, newest first — the listing that answers "which run was last". */
export async function listRuns(
  orgId: string,
  projectId: string,
  query: { readonly cursor?: string; readonly limit?: number } = {},
  signal?: AbortSignal,
): Promise<RunListResponse> {
  return apiRequest('GET', `${runsPath(orgId, projectId)}${search(query)}`, {
    schema: runListResponseSchema,
    signal,
  });
}

/** The project's conversation across its runs, newest first. */
export async function listRunMessages(
  orgId: string,
  projectId: string,
  query: { readonly cursor?: string | undefined; readonly limit?: number } = {},
  signal?: AbortSignal,
): Promise<RunMessagesResponse> {
  return apiRequest('GET', `${runsPath(orgId, projectId)}/messages${search(query)}`, {
    schema: runMessagesResponseSchema,
    signal,
  });
}

/**
 * One directory of the project's working tree (contracts/files.md § 1).
 *
 * `path` is relative to the workspace root and `''` is the root itself, which is why it is always
 * sent: the jail is the API's, and leaving the parameter off would be a different request.
 */
export async function listFiles(
  orgId: string,
  projectId: string,
  path: string,
  signal?: AbortSignal,
): Promise<FileListResponse> {
  return apiRequest('GET', `${projectPath(orgId, projectId)}/files${search({ path })}`, {
    schema: fileListResponseSchema,
    signal,
  });
}

/**
 * One file's bytes (§ 2).
 *
 * The answer is discriminated on `renderable`: binary and over-the-cap files come back as a
 * reason rather than as content, so the editor has something to say instead of something to
 * render.
 */
export async function readFile(
  orgId: string,
  projectId: string,
  path: string,
  signal?: AbortSignal,
): Promise<FileContentResponse> {
  return apiRequest('GET', `${projectPath(orgId, projectId)}/files/content${search({ path })}`, {
    schema: fileContentResponseSchema,
    signal,
  });
}

/**
 * Save one file's bytes (024 contracts/file-write.md § 2).
 *
 * `PUT`, because the request names the resource it replaces and carries its whole content. The
 * body is parsed here for the same reason every other write's is: the schema is strict, and a
 * key the contract does not name is better refused in this process than in the API's.
 *
 * The idempotency key is required and is a parameter rather than something minted here — a retry
 * of the *same* save must carry the *same* key, and only the caller knows whether this is a retry
 * or a second decision. The answer is discriminated on `saved`: `false` means the content was
 * already there and the checkpoint is the current head, not a new one (FR-005).
 */
export async function writeFile(
  orgId: string,
  projectId: string,
  body: WriteFileRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<WriteFileResponse> {
  return apiRequest('PUT', `${projectPath(orgId, projectId)}/files/content`, {
    body: writeFileRequestSchema.parse(body),
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    schema: writeFileResponseSchema,
    signal,
  });
}

/**
 * Ask the sandbox to wake (§ 3).
 *
 * Idempotent, and it answers rather than waits: `{ ready: false, because: 'resuming' }` is the
 * normal reply to the first call, and the page keeps asking until `ready`.
 */
export async function wakeSandbox(
  orgId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<WakeResponse> {
  return apiRequest('POST', `${projectPath(orgId, projectId)}/files/wake`, {
    schema: wakeResponseSchema,
    signal,
  });
}

/** A page of the project's checkpoints, newest first (spec 016). */
export async function listCheckpoints(
  orgId: string,
  projectId: string,
  query: { readonly cursor?: string; readonly limit?: number } = {},
  signal?: AbortSignal,
): Promise<CheckpointListResponse> {
  return apiRequest('GET', `${projectPath(orgId, projectId)}/checkpoints${search(query)}`, {
    schema: checkpointListResponseSchema,
    signal,
  });
}

/** One checkpoint's diff against its parent — immutable, so it is never refetched. */
export async function getCheckpointDiff(
  orgId: string,
  projectId: string,
  checkpointId: string,
  signal?: AbortSignal,
): Promise<CheckpointDiffResponse> {
  return apiRequest(
    'GET',
    `${projectPath(orgId, projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/diff`,
    { schema: checkpointDiffResponseSchema, signal },
  );
}

/**
 * Restore the workspace to a checkpoint, which lands as a new checkpoint of its own.
 *
 * The key is a parameter rather than something generated here: a retry of the *same* revert must
 * carry the *same* key, and only the caller knows whether this is a retry or a second decision.
 */
export async function revertCheckpoint(
  orgId: string,
  projectId: string,
  checkpointId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Checkpoint> {
  return apiRequest(
    'POST',
    `${projectPath(orgId, projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/revert`,
    {
      headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
      schema: checkpointSchema,
      signal,
    },
  );
}

/** Where the preview is served and who may reach it (spec 017). */
/**
 * The requester's own import (spec 026 R2, spec 047), readable after a failure withdrew its project:
 * the project page polls it while the import runs, and says why when it failed.
 */
export async function getImport(
  orgId: string,
  workspaceId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<SyncOperation> {
  return apiRequest(
    'GET',
    `/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/imports/${encodeURIComponent(operationId)}`,
    { schema: syncOperationSchema, signal },
  );
}

export async function getPreview(
  orgId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<PreviewResponse> {
  return apiRequest('GET', `${projectPath(orgId, projectId)}/preview`, {
    schema: previewResponseSchema,
    signal,
  });
}

/** Set who may reach the preview. Behind `project:preview.rotate`, as the rotate is. */
export async function setPreviewVisibility(
  orgId: string,
  projectId: string,
  visibility: PreviewVisibility,
  signal?: AbortSignal,
): Promise<PreviewResponse> {
  return apiRequest('PUT', `${projectPath(orgId, projectId)}/preview/visibility`, {
    body: setPreviewVisibilityRequestSchema.parse({ visibility }),
    schema: previewResponseSchema,
    signal,
  });
}

/** Rotate the preview label: the old URL stops resolving and the answer carries the new one. */
export async function rotatePreview(
  orgId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<RotatePreviewResponse> {
  return apiRequest('POST', `${projectPath(orgId, projectId)}/preview/rotate`, {
    schema: rotatePreviewResponseSchema,
    signal,
  });
}

/**
 * The address a non-public preview is framed at: its own, carrying a single-use grant code
 * (contracts/preview.md § 4). The frame redeems the code itself, so the grant cookie lands in the
 * frame's partition; a top-level exchange would set it where the frame never looks.
 */
export async function framePreviewAddress(url: string, signal?: AbortSignal): Promise<string> {
  const { host, hostname } = new URL(url);
  const { url: target } = await apiRequest('POST', '/preview/authorize', {
    // `<label>-<port>.<domain>`: the label is the first label up to its `-<port>`.
    body: { label: hostname.split('.', 1)[0]!.split('-', 1)[0], returnHost: host },
    schema: authorizePreviewResponseSchema,
    signal,
  });

  // The code rides in the frame's address: it goes to the preview's own host or nowhere.
  if (new URL(target).host !== host) {
    throw new Error('The preview grant named another host.');
  }

  return target;
}

/**
 * Ask for a deploy (spec 027, contracts/deployments.md). `202`: the deployment is queued, not live.
 *
 * An omitted `checkpointId` means the project's head. The idempotency key is a parameter, as
 * `revertCheckpoint`'s is: only the caller knows whether this is a retry or a second decision.
 */
export async function createDeployment(
  orgId: string,
  projectId: string,
  body: CreateDeploymentRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<DeploymentResponse> {
  return apiRequest('POST', `${projectPath(orgId, projectId)}/deployments`, {
    body: createDeploymentRequestSchema.parse(body),
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    schema: deploymentResponseSchema,
    signal,
  });
}

/** A page of the project's deployments, newest first. No row carries its log. */
export async function listDeployments(
  orgId: string,
  projectId: string,
  query: { readonly cursor?: string; readonly limit?: number } = {},
  signal?: AbortSignal,
): Promise<DeploymentListResponse> {
  return apiRequest('GET', `${projectPath(orgId, projectId)}/deployments${search(query)}`, {
    schema: deploymentListResponseSchema,
    signal,
  });
}

/** One deployment's stored, scrubbed log tail — `''` before its build ends. */
export async function getDeploymentLog(
  orgId: string,
  projectId: string,
  deploymentId: string,
  signal?: AbortSignal,
): Promise<DeploymentLogResponse> {
  return apiRequest(
    'GET',
    `${projectPath(orgId, projectId)}/deployments/${encodeURIComponent(deploymentId)}/log`,
    { schema: deploymentLogResponseSchema, signal },
  );
}

/** The project's site: its address once it has gone live, and whether it can be deployed at all. */
export async function getSite(
  orgId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<SiteResponse> {
  return apiRequest('GET', `${projectPath(orgId, projectId)}/site`, {
    schema: siteResponseSchema,
    signal,
  });
}

/**
 * Move the site pointer: `release` a succeeded deployment (rollback / roll-forward, no build) or
 * take the site `offline`. Idempotent by target state, so it carries no idempotency key.
 */
export async function updateSite(
  orgId: string,
  projectId: string,
  body: UpdateSiteRequest,
  signal?: AbortSignal,
): Promise<SiteResponse> {
  return apiRequest('PUT', `${projectPath(orgId, projectId)}/site`, {
    body: updateSiteRequestSchema.parse(body),
    schema: siteResponseSchema,
    signal,
  });
}

function domainsPath(orgId: string, projectId: string): string {
  return `${projectPath(orgId, projectId)}/domains`;
}

function domainPath(orgId: string, projectId: string, domainId: string): string {
  return `${domainsPath(orgId, projectId)}/${encodeURIComponent(domainId)}`;
}

/**
 * The project's custom domains, newest first (spec 028, contracts/domains.md). At most ten live
 * per project, so unpaged. `canManage` is the caller's `org:domains.manage`, which the project
 * read's permissions cannot say (research R12).
 */
export async function listDomains(
  orgId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<DomainListResponse> {
  return apiRequest('GET', domainsPath(orgId, projectId), {
    schema: domainListResponseSchema,
    signal,
  });
}

export async function getDomain(
  orgId: string,
  projectId: string,
  domainId: string,
  signal?: AbortSignal,
): Promise<DomainResponse> {
  return apiRequest('GET', domainPath(orgId, projectId, domainId), {
    schema: domainResponseSchema,
    signal,
  });
}

/**
 * Add a hostname. `201`: the domain is `pending` and carries the records to create; nothing waits
 * for DNS. The key is required and is a parameter, as `createDeployment`'s is.
 */
export async function addDomain(
  orgId: string,
  projectId: string,
  body: AddDomainRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<DomainResponse> {
  return apiRequest('POST', domainsPath(orgId, projectId), {
    body: addDomainRequestSchema.parse(body),
    headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    schema: domainResponseSchema,
    signal,
  });
}

/** Ask for a check now. `202`; limited to one a minute per domain (`429` with `retryAfter`). */
export async function checkDomain(
  orgId: string,
  projectId: string,
  domainId: string,
  signal?: AbortSignal,
): Promise<DomainResponse> {
  return apiRequest('POST', `${domainPath(orgId, projectId, domainId)}/check`, {
    schema: domainResponseSchema,
    signal,
  });
}

/** Retry a `failed` domain: back to `pending` with a new ownership value and a new window. */
export async function retryDomain(
  orgId: string,
  projectId: string,
  domainId: string,
  idempotencyKey?: string,
  signal?: AbortSignal,
): Promise<DomainResponse> {
  return apiRequest('POST', `${domainPath(orgId, projectId, domainId)}/retry`, {
    headers: idempotencyKey === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
    schema: domainResponseSchema,
    signal,
  });
}

/**
 * Remove a domain. `202`: it is `removing`, and the answer lists the records the member created and
 * may now delete. Idempotent by target state, so it carries no key.
 */
export async function removeDomain(
  orgId: string,
  projectId: string,
  domainId: string,
  signal?: AbortSignal,
): Promise<RemoveDomainResponse> {
  return apiRequest('DELETE', domainPath(orgId, projectId, domainId), {
    schema: removeDomainResponseSchema,
    signal,
  });
}

/**
 * The address of a run's event stream.
 *
 * A URL rather than a function that fetches, because `EventSource` opens the connection itself —
 * and it is built here so the prefix and the path shape are decided in one place with the five
 * calls above, rather than assembled by hand in a hook.
 *
 * `EventSource` can set no headers, which is why the session travels as a cookie and why the
 * absolute form matters: it sends credentials only for a same-origin URL unless asked, and
 * `joinUrl('', …)` gives exactly the same-origin path the dev proxy and the edge both serve.
 */
export function runStreamUrl(orgId: string, projectId: string, runId: string): string {
  return joinUrl(
    env.VITE_API_URL,
    `/api/v1${runsPath(orgId, projectId)}/${encodeURIComponent(runId)}/stream`,
  );
}

/** `…/projects/:projectId/attachments[/:attachmentId]` (spec 048). */
function attachmentPath(orgId: string, projectId: string, attachmentId?: string): string {
  const base = `${projectPath(orgId, projectId)}/attachments`;

  return attachmentId === undefined ? base : `${base}/${encodeURIComponent(attachmentId)}`;
}

/** The upload address for a file called `name`; the file itself is the body (`attachment-upload.ts`). */
export function attachmentUploadPath(orgId: string, projectId: string, name: string): string {
  return `${attachmentPath(orgId, projectId)}${search({ name })}`;
}

/** Where an attachment's bytes are read: an `<img src>` or a download link, by session cookie. */
export function attachmentContentUrl(
  orgId: string,
  projectId: string,
  attachmentId: string,
): string {
  return joinUrl(
    env.VITE_API_URL,
    `/api/v1${attachmentPath(orgId, projectId, attachmentId)}/content`,
  );
}

/** Drop an attachment that was uploaded and never sent. `204`; refused once a message links it. */
export async function deleteAttachment(
  orgId: string,
  projectId: string,
  attachmentId: string,
): Promise<void> {
  return apiRequest('DELETE', attachmentPath(orgId, projectId, attachmentId));
}
