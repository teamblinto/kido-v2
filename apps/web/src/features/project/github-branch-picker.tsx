import { branchNameSchema, type RepoLink, repoBranchListSchema } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiRequest } from '@/lib/api/client';
import { messageFor } from '@/lib/api/problem';

function markers(branch: { default: boolean; protected: boolean }): string | undefined {
  const words = [branch.default && 'Default', branch.protected && 'Protected'].filter(Boolean);

  return words.length === 0 ? undefined : words.join(' · ');
}

/**
 * Where pushes go. `lockedBecause` is why neither control works right now, said beside them rather
 * than left to a greyed-out button; the server refuses the same moments (spec 044, decision 9).
 */
export function GitHubBranchPicker({
  base,
  disabled,
  link,
  lockedBecause,
  onCreate,
  onSwitch,
}: {
  readonly base: string;
  readonly disabled: boolean;
  readonly link: RepoLink;
  readonly lockedBecause: string | undefined;
  readonly onCreate: (name: string) => void;
  readonly onSwitch: (branch: string) => void;
}): React.JSX.Element {
  const [newName, setNewName] = useState<string | undefined>(undefined);
  const locked = lockedBecause !== undefined || disabled;

  const branches = useQuery({
    enabled: link.state === 'linked',
    queryFn: ({ signal }) =>
      apiRequest('GET', `${base}/repo-link/branches`, { schema: repoBranchListSchema, signal }),
    queryKey: ['repo-branches', link.id, link.branch],
  });
  const listed = branches.data?.branches ?? [];
  // The linked branch stays selectable while the list loads, or if it has left the repository.
  const options = listed.some((branch) => branch.name === link.branch)
    ? listed
    : [{ default: false, name: link.branch, protected: false }, ...listed];
  const isNameValid = newName !== undefined && branchNameSchema.safeParse(newName).success;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Select disabled={locked} onValueChange={onSwitch} value={link.branch}>
          <SelectTrigger aria-label="Branch" className="text-body-sm h-8 min-w-0 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((branch) => (
              <SelectItem key={branch.name} description={markers(branch)} value={branch.name}>
                {branch.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={locked}
          aria-expanded={newName !== undefined}
          onClick={() => {
            setNewName(newName === undefined ? '' : undefined);
          }}
        >
          New branch
        </Button>
      </div>

      {newName !== undefined ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onCreate(newName);
            setNewName(undefined);
          }}
        >
          <Input
            aria-label="New branch name"
            className="h-8 min-w-0 flex-1"
            placeholder="my-branch"
            value={newName}
            onChange={(event) => {
              setNewName(event.target.value);
            }}
          />
          <Button type="submit" size="sm" disabled={locked || !isNameValid}>
            Create
          </Button>
        </form>
      ) : null}

      {branches.isError ? (
        <p className="text-body-sm text-danger" role="status">
          {messageFor(branches.error, 'The branches could not be loaded.')}
        </p>
      ) : null}

      <p className="text-body-sm text-subdued">
        {lockedBecause ?? "Switching changes where pushes go, not the project's files."}
      </p>
    </div>
  );
}
