import {
  type ImportCandidate,
  type InspectImportResponse,
  inspectImportResponseSchema,
  type ProjectTemplate,
  connectionListSchema,
  type Repository,
  repositoryPageSchema,
  syncOperationSchema,
} from '@repo/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
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

const TEMPLATE_LABELS: Record<ProjectTemplate, string> = {
  nextjs: 'Next.js',
  'node-api': 'Node API',
  python: 'Python',
  'vite-react': 'Vite + React',
};

/**
 * Import a GitHub repository into a new project (spec 026 US1).
 *
 * Three steps, and the middle one is the point: pick a repository from spec 018's paged list, let
 * the server inspect it, and **confirm** a template. The confirmation is not a formality — the
 * server refuses to guess (FR-011/FR-012), so an `unrecognised` or `ambiguous` repository arrives
 * here with no template selected and the button stays disabled until a person picks one. The
 * evidence for each candidate is rendered beside it, because the whole reason for proposing rather
 * than deciding is that the user can check the reasoning.
 *
 * All four are always offered, whatever the outcome: FR-013 says the editor may override a
 * confident proposal, and an override you can only make by editing the request is not one.
 */
export function ProjectNewImportPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { activeOrg, isLoading: orgsLoading } = useOrgs();
  const orgId = activeOrg?.id ?? '';

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Repository | null>(null);
  const [inspection, setInspection] = useState<InspectImportResponse | null>(null);
  const [template, setTemplate] = useState<ProjectTemplate | null>(null);
  const [name, setName] = useState('');

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

  const inspect = useMutation({
    mutationFn: (repository: Repository) =>
      apiRequest(
        'POST',
        `/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/imports/inspect`,
        { body: { repoId: repository.id }, schema: inspectImportResponseSchema },
      ),
    onSuccess: (answer, repository) => {
      setSelected(repository);
      setInspection(answer);
      // FR-011: only a single unambiguous proposal is pre-selected, and even that is confirmed.
      setTemplate(answer.outcome === 'proposed' ? (answer.candidates[0]?.template ?? null) : null);
      setName((current) => (current === '' ? repository.name : current));
    },
  });

  const start = useMutation({
    mutationFn: () =>
      apiRequest(
        'POST',
        `/orgs/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}/imports`,
        {
          body: {
            branch: inspection!.branch,
            name,
            repoId: inspection!.repo.id,
            template: template!,
          },
          schema: syncOperationSchema,
        },
      ),
    // The operation is queued, not finished: the project page polls it through spec 018's routes.
    onSuccess: (operation) => navigate(projectPath(operation.projectId)),
  });

  const error =
    connectors.error ?? repositories.error ?? inspect.error ?? start.error ?? workspaces.error;
  const candidates: readonly ImportCandidate[] = inspection?.candidates ?? [];
  const canStart =
    template !== null && name.trim() !== '' && inspection !== null && !inspection.empty;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-heading-lg font-semibold">Import a repository</h1>
      <p className="text-body-sm text-subdued mt-1">
        Pick a repository, confirm how it should run, and we’ll clone it into a new project.
      </p>

      {error !== null && error !== undefined ? (
        <Alert variant="danger" className="mt-6">
          {messageFor(error, 'Something went wrong. Please try again.')}
        </Alert>
      ) : null}

      {orgsLoading || connectors.isLoading || repositories.isLoading ? (
        <p className="mt-6 flex items-center gap-2">
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
          <h2 id="repositories-heading" className="text-body-md font-medium">
            Repositories
          </h2>
          <Input
            aria-label="Filter repositories"
            className="mt-2"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name"
            value={query}
          />
          <ul className="mt-3 space-y-2">
            {(repositories.data?.repositories ?? [])
              .filter((repository) =>
                repository.name.toLowerCase().includes(query.trim().toLowerCase()),
              )
              .map((repository) => (
                <li key={repository.id} className="flex items-center justify-between gap-3">
                  <span>{repository.fullName}</span>
                  <Button
                    disabled={inspect.isPending}
                    onClick={() => inspect.mutate(repository)}
                    variant="outline"
                  >
                    Inspect
                  </Button>
                </li>
              ))}
          </ul>
        </section>
      )}

      {inspection !== null && selected !== null ? (
        <section className="mt-8" aria-labelledby="proposal-heading">
          <h2 id="proposal-heading" className="text-body-md font-medium">
            {selected.fullName}
          </h2>

          {inspection.empty ? (
            <Alert variant="warning" className="mt-3">
              That branch has no commits yet. Push one first, then import it.
            </Alert>
          ) : null}

          {!inspection.empty && inspection.outcome === 'unrecognised' ? (
            <Alert variant="warning" className="mt-3">
              We couldn’t tell how this repository runs. Pick a template and we’ll use it as it is —
              nothing from the template is added to your files.
            </Alert>
          ) : null}

          {inspection.outcome === 'ambiguous' ? (
            <Alert variant="warning" className="mt-3">
              This repository matches more than one template. Pick the one you want.
            </Alert>
          ) : null}

          <fieldset className="mt-4">
            <legend className="text-body-sm text-subdued">Template</legend>
            {(Object.keys(TEMPLATE_LABELS) as ProjectTemplate[])
              .map((id) => ({
                evidence: candidates.find((candidate) => candidate.template === id)?.evidence ?? [],
                template: id,
              }))
              .map((candidate) => (
                <label className="mt-2 flex items-center gap-3" key={candidate.template}>
                  <input
                    checked={template === candidate.template}
                    name="template"
                    onChange={() => setTemplate(candidate.template)}
                    type="radio"
                    value={candidate.template}
                  />
                  <span>{TEMPLATE_LABELS[candidate.template]}</span>
                  {candidate.evidence.map((signal) => (
                    <Badge key={signal} variant="neutral">
                      {signal}
                    </Badge>
                  ))}
                </label>
              ))}
          </fieldset>

          <label className="mt-4 block" htmlFor="import-name">
            Project name
          </label>
          <Input id="import-name" onChange={(event) => setName(event.target.value)} value={name} />

          <Button
            className="mt-4"
            disabled={!canStart || start.isPending}
            onClick={() => start.mutate()}
          >
            Import repository
          </Button>
        </section>
      ) : null}
    </main>
  );
}
