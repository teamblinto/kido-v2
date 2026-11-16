import {
  connectionListSchema,
  type Repository,
  repositoryPageSchema,
  syncOperationSchema,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranchIcon, Loader2, LockIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { listWorkspaces } from '@/features/workspace/api';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { apiRequest } from '@/lib/api/client';
import { messageFor } from '@/lib/api/problem';
import { projectPath, routes } from '@/lib/routes';

/**
 * Import a GitHub repository into a new project (spec 026 US1, spec 047).
 *
 * One step: pick a repository. Nothing about how it runs is asked for. The server detects the
 * stack from the clone, installs the dependencies and starts the dev server, names the project,
 * and repairs a failing start with the agent. The project page shows the progress, so the import
 * hands off to it as soon as the import is queued.
 */
export function ProjectNewImportPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeOrg, isLoading: orgsLoading } = useOrgs();
  const orgId = activeOrg?.id ?? '';
  const [query, setQuery] = useState('');

  const workspaces = useQuery({
    enabled: orgId !== '',
    queryFn: ({ signal }) => listWorkspaces(orgId, signal),
    queryKey: ['workspaces', orgId],
  });
  const workspaceId = workspaces.data?.workspaces[0]?.id ?? '';

  // The repository list is spec 018's, paged under the connection it belongs to — reused rather
  // than reimplemented, which is why importing needs no new list endpoint.
  const connectors = useQuery({
    enabled: orgId !== '',
    queryFn: ({ signal }) =>
      apiRequest('GET', `/orgs/${encodeURIComponent(orgId)}/connectors`, {
        schema: connectionListSchema,
        signal,
      }),
    queryKey: ['connectors', orgId],
  });
  const connectionId =
    connectors.data?.connections.find((connection) => connection.provider === 'github')?.id ?? '';

  const repositories = useQuery({
    enabled: connectionId !== '',
    queryFn: ({ signal }) =>
      apiRequest(
        'GET',
        `/orgs/${encodeURIComponent(orgId)}/connectors/${encodeURIComponent(connectionId)}/repositories`,
        { schema: repositoryPageSchema, signal },
      ),
    queryKey: ['import-repositories', orgId, connectionId],
  });

  const start = useMutation({
    // The repository alone: the default branch, a detected run profile and a generated name.
    mutationFn: (repository: Repository) =>
      apiRequest(
        'POST',
        `/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/imports`,
        { body: { repoId: repository.id }, schema: syncOperationSchema },
      ),
    // The operation is queued, not finished: the project page shows the import and the start-up.
    onSuccess: (operation) => {
      void queryClient.invalidateQueries({ queryKey: ['projects', orgId] });
      void navigate(projectPath(operation.projectId));
    },
  });

  const error = connectors.error ?? repositories.error ?? start.error ?? workspaces.error;
  const needle = query.trim().toLowerCase();
  const visible = (repositories.data?.repositories ?? []).filter((repository) =>
    repository.fullName.toLowerCase().includes(needle),
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-heading-lg font-semibold">Import from GitHub</h1>
      <p className="text-body-sm text-subdued mt-1">
        Pick a repository. We work out how it runs, install it and start a live preview — no setup
        needed.
      </p>

      {error !== null && error !== undefined ? (
        <Alert variant="danger" className="mt-6">
          {messageFor(error, 'Something went wrong. Please try again.')}
        </Alert>
      ) : null}

      {orgsLoading || connectors.isLoading || repositories.isLoading ? (
        <p className="text-body-sm text-subdued mt-6 flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading repositories…
        </p>
      ) : connectionId === '' ? (
        <Alert variant="warning" className="mt-6">
          <Link to={routes.connectorsSettings} className="font-medium underline">
            Connect GitHub
          </Link>{' '}
          for this organisation first, then come back to import a repository.
        </Alert>
      ) : (
        <section className="mt-6" aria-labelledby="repositories-heading">
          <h2 id="repositories-heading" className="sr-only">
            Repositories
          </h2>
          <Input
            aria-label="Filter repositories"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search repositories"
            value={query}
          />
          {visible.length === 0 ? (
            <p className="text-body-sm text-subdued mt-4">
              {needle === ''
                ? 'The GitHub App cannot see any repositories yet. Grant it access to one in GitHub.'
                : 'No repository matches that search.'}
            </p>
          ) : (
            <ul className="border-line-subtle divide-line-subtle mt-3 divide-y rounded-lg border">
              {visible.map((repository) => {
                const importing = start.isPending && start.variables?.id === repository.id;

                return (
                  <li
                    key={repository.id}
                    className="flex items-center justify-between gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="text-body-sm text-foreground flex items-center gap-1.5 truncate font-medium">
                        {repository.fullName}
                        {repository.private ? (
                          <LockIcon className="text-faint size-3 shrink-0" aria-label="Private" />
                        ) : null}
                      </p>
                      <p className="text-caption text-faint mt-0.5 flex items-center gap-1">
                        <GitBranchIcon className="size-3" aria-hidden />
                        {repository.defaultBranch}
                      </p>
                    </div>
                    <Button
                      aria-label={`Import ${repository.fullName}`}
                      disabled={start.isPending || workspaceId === ''}
                      onClick={() => start.mutate(repository)}
                      size="sm"
                    >
                      {importing ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Importing
                        </>
                      ) : (
                        'Import'
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {repositories.data?.nextCursor !== undefined ? (
            <Badge variant="neutral" className="mt-3">
              Showing the first {repositories.data.repositories.length} — search to narrow down
            </Badge>
          ) : null}
        </section>
      )}
    </main>
  );
}
