import {
  type GithubConnection,
  type PutRepoLinkRequest,
  repositoryPageSchema,
} from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiRequest } from '@/lib/api/client';
import { messageFor } from '@/lib/api/problem';
import { REASON_COPY, repositorySlug } from './lib/github-sync';

/**
 * Giving the project a repository: a new one by default, an existing one otherwise. A personal
 * account's create is a trip through GitHub's approval (spec 044, decision 7), so `onAuthorize`
 * rather than `onSubmit`, and the button says so.
 */
export function GitHubLinkForm({
  connection,
  disabled,
  onAuthorize,
  onSubmit,
  orgId,
  projectName,
}: {
  readonly connection: GithubConnection;
  readonly disabled: boolean;
  readonly onAuthorize: (body: { name: string; private: boolean }) => void;
  readonly onSubmit: (body: PutRepoLinkRequest) => void;
  readonly orgId: string;
  readonly projectName: string | undefined;
}): React.JSX.Element {
  const canCreate = connection.canCreateRepositories;
  const isPersonal = connection.account.type === 'user';
  const [mode, setMode] = useState<'choose' | 'create'>(canCreate ? 'create' : 'choose');
  // Undefined until edited, so the name follows the project's if that arrives after this does.
  const [editedName, setEditedName] = useState<string | undefined>(undefined);
  const name = editedName ?? repositorySlug(projectName ?? '');
  const [isPrivate, setIsPrivate] = useState(true);
  const [filter, setFilter] = useState('');
  const [branch, setBranch] = useState('');

  const repositories = useQuery({
    enabled: mode === 'choose',
    queryFn: ({ signal }) =>
      apiRequest(
        'GET',
        `/orgs/${encodeURIComponent(orgId)}/connectors/${encodeURIComponent(connection.id)}/repositories?query=${encodeURIComponent(filter)}`,
        { schema: repositoryPageSchema, signal },
      ),
    queryKey: ['repositories', orgId, connection.id, filter],
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
            Create new
          </Button>
          <Button
            size="sm"
            variant={mode === 'choose' ? 'default' : 'outline'}
            aria-pressed={mode === 'choose'}
            onClick={() => {
              setMode('choose');
            }}
          >
            Choose existing
          </Button>
        </div>
      ) : (
        <p className="text-body-sm text-subdued">{REASON_COPY['create-unsupported']}</p>
      )}

      {mode === 'create' ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();

            if (isPersonal) {
              onAuthorize({ name, private: isPrivate });
            } else {
              onSubmit({ create: { name, private: isPrivate } });
            }
          }}
        >
          <Label htmlFor="github-repo-name">Repository name</Label>
          <Input
            id="github-repo-name"
            value={name}
            pattern="[A-Za-z0-9._\-]{1,100}"
            required
            onChange={(event) => {
              setEditedName(event.target.value);
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
          {isPersonal ? (
            <p className="text-body-sm text-subdued">GitHub will ask you to approve this once.</p>
          ) : null}
          <Button type="submit" size="sm" disabled={disabled || name === ''}>
            {isPersonal ? 'Continue on GitHub' : 'Create and link'}
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
          <Label htmlFor="github-repo-branch">Branch (optional)</Label>
          <Input
            id="github-repo-branch"
            value={branch}
            placeholder="The repository's default"
            onChange={(event) => {
              setBranch(event.target.value);
            }}
          />
          {repositories.isPending ? (
            <p className="text-body-sm text-subdued" role="status">
              Loading repositories…
            </p>
          ) : null}
          {repositories.isError ? (
            <p className="text-body-sm text-danger" role="status">
              {messageFor(repositories.error)}
            </p>
          ) : null}
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
                    const chosen = branch.trim();

                    onSubmit({
                      existing: { repoId: repo.id, ...(chosen === '' ? {} : { branch: chosen }) },
                    });
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
