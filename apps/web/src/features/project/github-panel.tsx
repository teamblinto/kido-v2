import {
  type AuthorizeRepoCreateRequest,
  authorizeRepoCreateResponseSchema,
  importMismatchResponseSchema,
  installResponseSchema,
  type PatchRepoLinkRequest,
  type PutRepoLinkRequest,
  type RepoLink,
  repoLinkSchema,
  type SyncCommitResponse,
  syncCommitResponseSchema,
  type SyncOperation,
  syncOperationSchema,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api/client';
import { ApiProblem } from '@/lib/api/problem';
import { GitHubLinkForm } from './github-link-form';
import { GitHubLinked } from './github-linked';
import { invalidateGitSync, useGitSync } from './hooks/use-git-sync';
import {
  errorCopy,
  GITHUB_AUTHORIZE_KEY,
  GITHUB_RETURN_KEY,
  githubPanelPath,
} from './lib/github-sync';

function commitNote(result: SyncCommitResponse): string {
  if (result.operation !== null) return 'On its way to GitHub.';

  return result.checkpointId === null
    ? 'Nothing new to commit'
    : 'Saved; it will go out with the sync in progress';
}

interface GitHubPanelProps {
  /** `project:files.write`. Without it the panel reports and offers nothing the API would refuse. */
  readonly canWrite?: boolean;
  readonly isRunActive?: boolean;
  readonly orgId: string;
  readonly projectId: string;
  /** Prefills a new repository's name. */
  readonly projectName?: string | undefined;
}

/**
 * The project's GitHub link (specs 018, 044): connect, give the project a repository, then push,
 * pull, unlink, and see the last few operations. Unlinking never touches the repository on GitHub.
 * Every trip through GitHub comes back here.
 */
export function GitHubPanel({
  canWrite = true,
  isRunActive = false,
  orgId,
  projectId,
  projectName,
}: GitHubPanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const base = `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
  const linkKey = ['repo-link', orgId, projectId];
  const { connection, error: readError, ...git } = useGitSync(orgId, projectId);
  const { link } = git;
  const refresh = () => invalidateGitSync(queryClient, orgId, projectId);

  // Spec 026 contracts § 4: the FR-016 warning. One line, never an error — a runtime the
  // repository disagrees with blocks nothing, so this query is deliberately outside `error`.
  const mismatch = useQuery({
    enabled: link !== null && link !== undefined,
    queryFn: ({ signal }) =>
      apiRequest('GET', `${base}/import-mismatch`, {
        schema: importMismatchResponseSchema,
        signal,
      }),
    queryKey: ['import-mismatch', orgId, projectId],
  });

  const install = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/orgs/${encodeURIComponent(orgId)}/connectors/github/install`, {
        schema: installResponseSchema,
      }),
    onSuccess: ({ installUrl }) => {
      window.sessionStorage.setItem(GITHUB_RETURN_KEY, githubPanelPath(projectId));
      window.location.assign(installUrl);
    },
  });
  const put = useMutation({
    mutationFn: (body: PutRepoLinkRequest) =>
      apiRequest('PUT', `${base}/repo-link`, { body, schema: repoLinkSchema }),
    onSuccess: (data) => {
      queryClient.setQueryData(linkKey, data);
    },
  });
  const authorize = useMutation({
    mutationFn: (body: AuthorizeRepoCreateRequest) =>
      apiRequest('POST', `${base}/repo-link/authorize`, {
        body,
        schema: authorizeRepoCreateResponseSchema,
      }),
    onSuccess: ({ authorizeUrl }) => {
      window.sessionStorage.setItem(
        GITHUB_AUTHORIZE_KEY,
        JSON.stringify({ projectId, returnTo: githubPanelPath(projectId) }),
      );
      window.location.assign(authorizeUrl);
    },
  });
  const syncMutation = (kind: SyncOperation['kind']) => ({
    mutationFn: () => apiRequest('POST', `${base}/sync/${kind}`, { schema: syncOperationSchema }),
    onSuccess: refresh,
  });
  const push = useMutation(syncMutation('push'));
  const pull = useMutation(syncMutation('pull'));
  const commit = useMutation({
    mutationFn: (message: string) =>
      apiRequest('POST', `${base}/sync/commit`, {
        body: message === '' ? {} : { message },
        schema: syncCommitResponseSchema,
      }),
    onSuccess: refresh,
  });
  // No response schema on these two: the panel reads the link back rather than rely on the reply.
  const patch = useMutation({
    mutationFn: (body: PatchRepoLinkRequest) => apiRequest('PATCH', `${base}/repo-link`, { body }),
    // The switch and the picker move on the click; a refusal reads the truth back.
    onMutate: (body) => {
      queryClient.setQueryData<RepoLink | null>(linkKey, (current) =>
        current === null || current === undefined ? current : { ...current, ...body },
      );
    },
    onSettled: refresh,
  });
  const createBranch = useMutation({
    mutationFn: (name: string) =>
      apiRequest('POST', `${base}/repo-link/branches`, { body: { name } }),
    onSuccess: refresh,
  });
  const unlink = useMutation({
    mutationFn: () => apiRequest('DELETE', `${base}/repo-link`),
    onSuccess: () => {
      queryClient.setQueryData(linkKey, null);
    },
  });

  const actions = [install, put, authorize, push, pull, commit, patch, createBranch, unlink];
  // Only the last thing tried speaks: a refusal stays until something newer has happened.
  const last = actions.reduce((a, b) => (b.submittedAt > a.submittedAt ? b : a));
  const busy = actions.some((action) => action.isPending);
  const error = last.error ?? readError;

  const refusedReason = ApiProblem.is(error) ? error.detail?.reason : undefined;
  const showConnection =
    connection !== undefined &&
    (refusedReason === 'needs-reauth' || refusedReason === 'provider-unavailable');

  return (
    <section
      className="border-line m-4 rounded-lg border p-4"
      aria-labelledby="github-panel-heading"
    >
      <h2
        id="github-panel-heading"
        className="text-heading-sm font-semibold outline-none"
        tabIndex={-1}
      >
        GitHub
      </h2>

      {error !== null ? (
        <Alert variant="danger" className="mt-3 block">
          {errorCopy(error)}
          {showConnection ? (
            <span className="block" data-testid="connection-state">
              Connection:{' '}
              {connection.health === 'needs_reauth' ? 'needs reconnecting' : connection.health}
              {connection.circuitOpenUntil !== null
                ? ` until ${new Date(connection.circuitOpenUntil).toLocaleString()}`
                : ''}
            </span>
          ) : null}
        </Alert>
      ) : null}

      {connection?.health === 'needs_reauth' && link?.state !== 'disconnected' ? (
        <Alert variant="warning" className="mt-3 flex flex-col items-start gap-2">
          GitHub needs reconnecting before this project can push or pull.
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              install.mutate();
            }}
          >
            Reconnect GitHub
          </Button>
        </Alert>
      ) : null}

      {git.isLoading ? (
        <div className="mt-3 flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading…</span>
        </div>
      ) : null}

      {git.status === 'not-connected' ? (
        <div className="mt-2 flex flex-col items-start gap-3">
          <p className="text-body-sm text-subdued">
            Keep this project&apos;s code on GitHub, updated after every turn.
          </p>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              install.mutate();
            }}
          >
            Connect GitHub
          </Button>
        </div>
      ) : null}

      {git.status === 'not-linked' && connection !== undefined ? (
        <GitHubLinkForm
          connection={connection}
          disabled={busy}
          onAuthorize={(body) => {
            authorize.mutate(body);
          }}
          onSubmit={(body) => {
            put.mutate(body);
          }}
          orgId={orgId}
          projectName={projectName}
        />
      ) : null}

      {mismatch.data?.templateMismatch != null ? (
        <p className="text-body-sm text-subdued mt-3" data-testid="template-mismatch">
          This project runs on {mismatch.data.templateMismatch.chosen}, but the repository looks
          like {mismatch.data.templateMismatch.detected.join(', ')}. Nothing is blocked — change the
          project’s template if that is wrong.
        </p>
      ) : null}

      {link !== null && link !== undefined ? (
        <GitHubLinked
          canWrite={canWrite}
          base={base}
          busy={busy}
          commitNote={
            last === commit && commit.data !== undefined ? commitNote(commit.data) : undefined
          }
          isInFlight={git.isInFlight}
          isRunActive={isRunActive}
          link={link}
          onAutoSync={(autoSync) => {
            patch.mutate({ autoSync });
          }}
          onCommit={(message, onSaved) => {
            commit.mutate(message, { onSuccess: onSaved });
          }}
          onCreateBranch={(name) => {
            createBranch.mutate(name);
          }}
          onPull={() => {
            pull.mutate();
          }}
          onPush={() => {
            push.mutate();
          }}
          onReconnect={() => {
            install.mutate();
          }}
          onSwitchBranch={(branch) => {
            patch.mutate({ branch });
          }}
          onUnlink={() => {
            if (
              window.confirm(
                'Unlink this project from its repository? The repository on GitHub is not changed.',
              )
            ) {
              unlink.mutate();
            }
          }}
          operations={git.operations}
        />
      ) : null}
    </section>
  );
}
