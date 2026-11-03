import {
  connectionListSchema,
  importMismatchResponseSchema,
  type LinkPosition,
  type PutRepoLinkRequest,
  type RepoLink,
  repoLinkSchema,
  repositoryPageSchema,
  SYNC_FAILURE_REASONS,
  type SyncFailureReason,
  type SyncOperation,
  syncOperationPageSchema,
  syncOperationSchema,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiRequest } from '@/lib/api/client';
import { ApiProblem, messageFor } from '@/lib/api/problem';

/** Contracts § 3's vocabulary as copy. Local on purpose: no slug, no `MESSAGES` entry (R12). */
const REASON_COPY: Record<SyncFailureReason, string> = {
  'branch-not-found': 'That branch no longer exists on the repository.',
  'bundle-too-large': 'The repository is too large to send.',
  'create-unsupported': 'This connection cannot create repositories. Choose an existing one.',
  diverged: 'The repository and the project have diverged.',
  'empty-repo': 'That repository has no commits to import.',
  'git-failed': 'Git failed. Try again.',
  'import-checkout-failed': 'The repository could not be checked out. Try the import again.',
  'name-taken': 'A repository with that name already exists.',
  'needs-reauth': 'GitHub needs reconnecting. Ask an owner to verify the connector.',
  'not-linked': 'The project is not linked to a repository.',
  'nothing-to-push': 'Nothing to push: the project has no checkpoint yet.',
  'operation-in-flight': 'A sync is already in progress.',
  'provider-unavailable': 'GitHub is unavailable right now. Try again later.',
  'remote-ahead': 'The repository is ahead of the project. Pull first.',
  'repo-too-large': 'That repository is too large to import.',
  'run-active': 'A run is active. Wait for it to finish.',
  'timed-out': 'The sync timed out.',
};

const POSITION: Record<
  LinkPosition,
  { readonly label: string; readonly variant: 'info' | 'muted' | 'success' | 'warning' }
> = {
  ahead: { label: 'Ahead of GitHub', variant: 'info' },
  behind: { label: 'Behind GitHub', variant: 'warning' },
  diverged: { label: 'Diverged', variant: 'warning' },
  level: { label: 'Level with GitHub', variant: 'success' },
  unknown: { label: 'Not synced yet', variant: 'muted' },
};

const STATE: Record<SyncOperation['state'], 'danger' | 'info' | 'muted' | 'success'> = {
  failed: 'danger',
  queued: 'muted',
  running: 'info',
  succeeded: 'success',
};

function isReason(value: unknown): value is SyncFailureReason {
  return typeof value === 'string' && (SYNC_FAILURE_REASONS as readonly string[]).includes(value);
}

/** A refusal's `reason` extension (contracts § 4) beats the generic slug copy. */
function errorCopy(error: unknown): string {
  const reason = ApiProblem.is(error) ? error.detail?.reason : undefined;

  return isReason(reason) ? REASON_COPY[reason] : messageFor(error);
}

interface GitHubPanelProps {
  readonly orgId: string;
  readonly projectId: string;
}

/**
 * The project's GitHub link (spec 018 US2–US5): link to a new or existing repository, push, pull,
 * unlink, and see the last few operations. Unlinking never touches the repository on GitHub.
 */
export function GitHubPanel({ orgId, projectId }: GitHubPanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const base = `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
  const linkKey = ['repo-link', orgId, projectId];
  const syncKey = ['sync', orgId, projectId];

  const connectors = useQuery({
    queryFn: ({ signal }) =>
      apiRequest('GET', `/orgs/${encodeURIComponent(orgId)}/connectors`, {
        schema: connectionListSchema,
        signal,
      }),
    queryKey: ['connectors', orgId],
  });
  const link = useQuery({
    queryFn: ({ signal }) =>
      apiRequest('GET', `${base}/repo-link`, { schema: repoLinkSchema.nullable(), signal }),
    queryKey: linkKey,
  });
  const sync = useQuery({
    enabled: link.data !== null && link.data !== undefined,
    queryFn: ({ signal }) =>
      apiRequest('GET', `${base}/sync`, { schema: syncOperationPageSchema, signal }),
    queryKey: syncKey,
  });
  // Spec 026 contracts § 4: the FR-016 warning. One line, never an error — a runtime the
  // repository disagrees with blocks nothing, so this query is deliberately outside `error`.
  const mismatch = useQuery({
    enabled: link.data !== null && link.data !== undefined,
    queryFn: ({ signal }) =>
      apiRequest('GET', `${base}/import-mismatch`, {
        schema: importMismatchResponseSchema,
        signal,
      }),
    queryKey: ['import-mismatch', orgId, projectId],
  });

  const put = useMutation({
    mutationFn: (body: PutRepoLinkRequest) =>
      apiRequest('PUT', `${base}/repo-link`, { body, schema: repoLinkSchema }),
    onSuccess: (data) => {
      queryClient.setQueryData(linkKey, data);
    },
  });
  const syncMutation = (kind: SyncOperation['kind']) => ({
    mutationFn: () => apiRequest('POST', `${base}/sync/${kind}`, { schema: syncOperationSchema }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: syncKey }),
        queryClient.invalidateQueries({ queryKey: linkKey }),
      ]),
  });
  const push = useMutation(syncMutation('push'));
  const pull = useMutation(syncMutation('pull'));
  const unlink = useMutation({
    mutationFn: () => apiRequest('DELETE', `${base}/repo-link`),
    onSuccess: () => {
      queryClient.setQueryData(linkKey, null);
    },
  });

  const error =
    put.error ??
    push.error ??
    pull.error ??
    unlink.error ??
    link.error ??
    connectors.error ??
    sync.error;
  const github = connectors.data?.connections.find((c) => c.provider === 'github');
  const refusedReason = ApiProblem.is(error) ? error.detail?.reason : undefined;
  const showConnection =
    github !== undefined &&
    (refusedReason === 'needs-reauth' || refusedReason === 'provider-unavailable');

  return (
    <section
      className="border-line m-4 rounded-lg border p-4"
      aria-labelledby="github-panel-heading"
    >
      <h2 id="github-panel-heading" className="text-heading-sm font-semibold">
        GitHub
      </h2>

      {error !== null && error !== undefined ? (
        <Alert variant="danger" className="mt-3">
          {errorCopy(error)}
          {showConnection ? (
            <span className="block" data-testid="connection-state">
              Connection: {github.health === 'needs_reauth' ? 'needs reconnecting' : github.health}
              {github.circuitOpenUntil !== null
                ? ` until ${new Date(github.circuitOpenUntil).toLocaleString()}`
                : ''}
            </span>
          ) : null}
        </Alert>
      ) : null}

      {link.isLoading || connectors.isLoading ? (
        <div className="mt-3 flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading…</span>
        </div>
      ) : null}

      {link.isSuccess && link.data === null && connectors.isSuccess ? (
        github === undefined ? (
          <p className="text-body-sm text-subdued mt-2">
            Connect GitHub in the organisation settings first.
          </p>
        ) : (
          <LinkForm
            canCreate={github.canCreateRepositories}
            connectionId={github.id}
            disabled={put.isPending}
            onSubmit={(body) => {
              put.mutate(body);
            }}
            orgId={orgId}
          />
        )
      ) : null}

      {mismatch.data?.templateMismatch != null ? (
        <p className="text-body-sm text-subdued mt-3" data-testid="template-mismatch">
          This project runs on {mismatch.data.templateMismatch.chosen}, but the repository looks
          like {mismatch.data.templateMismatch.detected.join(', ')}. Nothing is blocked — change the
          project’s template if that is wrong.
        </p>
      ) : null}

      {link.data !== null && link.data !== undefined ? (
        <Linked
          busy={push.isPending || pull.isPending || unlink.isPending}
          link={link.data}
          onPull={() => {
            pull.mutate();
          }}
          onPush={() => {
            push.mutate();
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
          operations={sync.data?.operations.slice(0, 5) ?? []}
        />
      ) : null}
    </section>
  );
}

function LinkForm({
  canCreate,
  connectionId,
  disabled,
  onSubmit,
  orgId,
}: {
  readonly canCreate: boolean;
  readonly connectionId: string;
  readonly disabled: boolean;
  readonly onSubmit: (body: PutRepoLinkRequest) => void;
  readonly orgId: string;
}): React.JSX.Element {
  const [mode, setMode] = useState<'choose' | 'create'>(canCreate ? 'create' : 'choose');
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [filter, setFilter] = useState('');

  const repositories = useQuery({
    enabled: mode === 'choose',
    queryFn: ({ signal }) =>
      apiRequest(
        'GET',
        `/orgs/${encodeURIComponent(orgId)}/connectors/${encodeURIComponent(connectionId)}/repositories?query=${encodeURIComponent(filter)}`,
        { schema: repositoryPageSchema, signal },
      ),
    queryKey: ['repositories', orgId, connectionId, filter],
  });

  return (
    <div className="mt-3 flex flex-col gap-3">
      {canCreate ? (
        <div className="flex gap-2" role="group" aria-label="Link mode">
          <Button
            size="sm"
            variant={mode === 'create' ? 'default' : 'outline'}
            aria-pressed={mode === 'create'}
            onClick={() => {
              setMode('create');
            }}
          >
            Create
          </Button>
          <Button
            size="sm"
            variant={mode === 'choose' ? 'default' : 'outline'}
            aria-pressed={mode === 'choose'}
            onClick={() => {
              setMode('choose');
            }}
          >
            Choose
          </Button>
        </div>
      ) : null}

      {mode === 'create' ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({ create: { name, private: isPrivate } });
          }}
        >
          <Label htmlFor="github-repo-name">Repository name</Label>
          <Input
            id="github-repo-name"
            value={name}
            pattern="[A-Za-z0-9._\-]{1,100}"
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <label className="text-body-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(event) => {
                setIsPrivate(event.target.checked);
              }}
            />
            Private
          </label>
          <Button type="submit" size="sm" disabled={disabled || name === ''}>
            Create and link
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="github-repo-filter">Find a repository</Label>
          <Input
            id="github-repo-filter"
            value={filter}
            placeholder="Filter by name"
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
          {repositories.isSuccess && repositories.data.repositories.length === 0 ? (
            <p className="text-body-sm text-subdued">No repositories match.</p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {repositories.data?.repositories.map((repo) => (
              <li key={repo.id} className="flex items-center justify-between gap-3">
                <span className="text-body-sm truncate">{repo.fullName}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-label={`Link ${repo.fullName}`}
                  onClick={() => {
                    onSubmit({ existing: { repoId: repo.id } });
                  }}
                >
                  Link
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Linked({
  busy,
  link,
  onPull,
  onPush,
  onUnlink,
  operations,
}: {
  readonly busy: boolean;
  readonly link: RepoLink;
  readonly onPull: () => void;
  readonly onPush: () => void;
  readonly onUnlink: () => void;
  readonly operations: readonly SyncOperation[];
}): React.JSX.Element {
  const disconnected = link.state === 'disconnected';

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-body-sm truncate font-medium">
            {link.repository.fullName} · {link.branch}
          </p>
          <p className="text-body-sm text-subdued">
            Last pushed: {link.lastPushedCheckpointId ?? 'never'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={POSITION[link.position].variant}>{POSITION[link.position].label}</Badge>
          <Button size="sm" disabled={busy || disconnected} onClick={onPush}>
            Push
          </Button>
          <Button size="sm" variant="outline" disabled={busy || disconnected} onClick={onPull}>
            Pull
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onUnlink}>
            Unlink
          </Button>
        </div>
      </div>

      {disconnected ? (
        <Alert variant="warning">
          The connector was removed. Reconnect the organisation&apos;s GitHub to push or pull again.
        </Alert>
      ) : null}

      {/*
        Spec 026 US3 (SC-010). A push at GitHub reaches this panel as one refreshed field — the
        link's `remoteHeadSha` — and nothing else moved: no run, no checkpoint, no operation to
        list. So the news is stated here rather than in the operation list, the commit is named so
        that it is a fact and not a mood, and the only thing offered is the pull that would answer
        it. Nothing is done automatically: FR-034 says a delivery never pulls.
      */}
      {!disconnected && link.position === 'behind' && link.remoteHeadSha !== null ? (
        <Alert variant="warning">
          <span data-testid="remote-ahead">
            The repository is ahead of the project at{' '}
            <code className="font-mono">{link.remoteHeadSha.slice(0, 7)}</code>. Pull to bring the
            project up to date.
          </span>
          <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={onPull}>
            Pull from GitHub
          </Button>
        </Alert>
      ) : null}

      {operations.length > 0 ? (
        <ul className="text-body-sm flex flex-col gap-1" aria-label="Recent operations">
          {operations.map((op) => (
            <li key={op.id} className="flex flex-wrap items-center gap-2">
              <Badge variant={STATE[op.state]}>{op.state}</Badge>
              <span className="capitalize">{op.kind}</span>
              <span className="text-subdued">
                {op.requestedBy.name} · {new Date(op.createdAt).toLocaleString()}
              </span>
              {op.reason !== null ? (
                <span className="text-danger">{REASON_COPY[op.reason]}</span>
              ) : null}
              {op.kind === 'pull' && op.state === 'succeeded' ? (
                <span className="text-subdued">
                  {op.commits} {op.commits === 1 ? 'checkpoint' : 'checkpoints'} pulled from GitHub
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
