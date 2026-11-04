import {
  connectionListSchema,
  type GithubConnection,
  type RepoLink,
  repoLinkSchema,
  type SyncOperation,
  type SyncOperationPage,
  syncOperationPageSchema,
} from '@repo/contracts';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '@/lib/api/client';

export type GitSyncStatus =
  'ahead' | 'needs-attention' | 'not-connected' | 'not-linked' | 'synced' | 'syncing';

export const SYNC_POLL_ACTIVE_MS = 3_000;
export const SYNC_POLL_IDLE_MS = 30_000;

function isInFlight(operations: readonly SyncOperation[] | undefined): boolean {
  return operations?.some((op) => op.state === 'queued' || op.state === 'running') ?? false;
}

/** `nothing-to-push` is a refusal with nothing to fix; every other failure wants a look. */
function hasFailed(operation: SyncOperation | undefined): boolean {
  return operation?.state === 'failed' && operation.reason !== 'nothing-to-push';
}

/**
 * One word for where the project stands with GitHub. Undefined until the reads can say: a guest
 * may read the link but not the connectors, and must not be told GitHub is not connected.
 */
export function deriveGitSyncStatus(input: {
  readonly connection: GithubConnection | undefined;
  readonly connectorsKnown: boolean;
  readonly link: RepoLink | null | undefined;
  readonly operations: readonly SyncOperation[];
}): GitSyncStatus | undefined {
  const { connection, connectorsKnown, link, operations } = input;

  if (link === undefined) return undefined;

  if (link === null) {
    if (!connectorsKnown) return undefined;

    return connection === undefined ? 'not-connected' : 'not-linked';
  }

  if (link.state === 'disconnected') return 'needs-attention';
  if (isInFlight(operations)) return 'syncing';

  if (
    link.sideBranch !== null ||
    link.position === 'behind' ||
    link.position === 'diverged' ||
    connection?.health === 'needs_reauth' ||
    hasFailed(operations[0])
  ) {
    return 'needs-attention';
  }

  return link.position === 'level' ? 'synced' : 'ahead';
}

/** Everything a checkpoint or a finished action can have moved. */
export function invalidateGitSync(
  client: QueryClient,
  orgId: string | undefined,
  projectId: string | undefined,
): Promise<unknown> {
  return Promise.all(
    [
      ['repo-link', orgId, projectId],
      ['sync', orgId, projectId],
      ['connectors', orgId],
      ['checkpoints', orgId, projectId],
    ].map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}

export interface GitSync {
  readonly connection: GithubConnection | undefined;
  readonly error: Error | null;
  readonly isInFlight: boolean;
  readonly isLoading: boolean;
  /** Undefined while loading, null when the project has no repository. */
  readonly link: RepoLink | null | undefined;
  /** Newest first. */
  readonly operations: readonly SyncOperation[];
  readonly status: GitSyncStatus | undefined;
}

/**
 * The project's GitHub state, one source for the panel, the history and the topbar chip. All of
 * them read the same three query entries, so mounting more of them asks for nothing more.
 */
export function useGitSync(orgId: string | undefined, projectId: string | undefined): GitSync {
  const client = useQueryClient();
  const ready = orgId !== undefined && projectId !== undefined && projectId !== '';
  const org = encodeURIComponent(orgId ?? '');
  const base = `/orgs/${org}/projects/${encodeURIComponent(projectId ?? '')}`;
  const syncKey = ['sync', orgId, projectId];

  const connectors = useQuery({
    enabled: orgId !== undefined,
    queryFn: ({ signal }) =>
      apiRequest('GET', `/orgs/${org}/connectors`, { schema: connectionListSchema, signal }),
    queryKey: ['connectors', orgId],
  });
  const link = useQuery({
    enabled: ready,
    queryFn: ({ signal }) =>
      apiRequest('GET', `${base}/repo-link`, { schema: repoLinkSchema.nullable(), signal }),
    queryKey: ['repo-link', orgId, projectId],
    refetchInterval: (query) =>
      query.state.data === null || query.state.data === undefined ? false : SYNC_POLL_IDLE_MS,
  });
  const linked = link.data !== null && link.data !== undefined;
  const sync = useQuery({
    enabled: ready && linked,
    queryFn: async ({ signal }) => {
      const page = await apiRequest('GET', `${base}/sync`, {
        schema: syncOperationPageSchema,
        signal,
      });
      const before = client.getQueryData<SyncOperationPage>(syncKey);

      // Here rather than in an effect, so three mounted readers settle it once. What a finished
      // operation moved is the link's position and, for a pull, the history.
      if (isInFlight(before?.operations) && !isInFlight(page.operations)) {
        void client.invalidateQueries({ queryKey: ['repo-link', orgId, projectId] });
        void client.invalidateQueries({ queryKey: ['checkpoints', orgId, projectId] });
      }

      return page;
    },
    queryKey: syncKey,
    // `ahead` under auto-sync: the turn's push is about to appear, so don't sit on the idle pace.
    // Not once it has an answer: a side branch or a failure stays `ahead` until someone acts.
    refetchInterval: (query) =>
      isInFlight(query.state.data?.operations) ||
      (link.data?.autoSync === true &&
        link.data.position === 'ahead' &&
        link.data.sideBranch === null &&
        query.state.data?.operations[0]?.state !== 'failed')
        ? SYNC_POLL_ACTIVE_MS
        : SYNC_POLL_IDLE_MS,
  });

  const connection = connectors.data?.connections.find(
    (c): c is GithubConnection => c.provider === 'github',
  );
  const operations = (linked ? sync.data?.operations : undefined) ?? [];

  return {
    connection,
    error: link.error ?? connectors.error ?? sync.error,
    isInFlight: isInFlight(operations),
    isLoading: link.isLoading || connectors.isLoading,
    link: link.data,
    operations,
    status: deriveGitSyncStatus({
      connection,
      connectorsKnown: connectors.isSuccess,
      link: link.data,
      operations,
    }),
  };
}
