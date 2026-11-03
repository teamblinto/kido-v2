import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { messageFor } from '@/lib/api/problem';
import { createWorkspace, deleteWorkspace, listWorkspaces, renameWorkspace } from '../api';

interface WorkspacesDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly orgId: string;
}

/**
 * The organisation's workspaces — the API's containers inside an organisation, not the sidebar's
 * organisation switcher — with create, rename and delete (spec 007). All three are behind
 * `org:settings.update`, so a member without it sees the API's refusal rather than a hidden button.
 */
export function WorkspacesDialog({
  onOpenChange,
  open,
  orgId,
}: WorkspacesDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');

  const workspaces = useQuery({
    enabled: open && orgId !== '',
    queryFn: ({ signal }) => listWorkspaces(orgId, signal),
    queryKey: ['workspaces', orgId],
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['workspaces', orgId] });
  };

  const create = useMutation({
    mutationFn: (value: string) => createWorkspace(orgId, { name: value }),
    onSuccess: () => {
      setName('');
      refresh();
    },
  });
  const rename = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) =>
      renameWorkspace(orgId, id, { name: value }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteWorkspace(orgId, id),
    onSuccess: () => {
      refresh();
      // Its projects were archived with it.
      void queryClient.invalidateQueries({ queryKey: ['projects', orgId] });
      void queryClient.invalidateQueries({ queryKey: ['project', orgId] });
    },
  });

  const error = create.error ?? rename.error ?? remove.error ?? workspaces.error;
  const isBusy = create.isPending || rename.isPending || remove.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Workspaces</DialogTitle>
          <DialogDescription>
            The containers this organisation’s projects live in.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {error === null ? null : (
            <Alert variant="danger">
              {messageFor(error, 'That did not work. Please try again.')}
            </Alert>
          )}

          <ul className="flex flex-col gap-1">
            {(workspaces.data?.workspaces ?? []).map((workspace) => (
              <li key={workspace.id} className="flex items-center gap-2">
                <span className="text-label-sm min-w-0 flex-1 truncate">{workspace.name}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isBusy}
                  aria-label={`Rename ${workspace.name}`}
                  onClick={() => {
                    const value = window.prompt('Rename workspace', workspace.name)?.trim();
                    if (value !== undefined && value !== '' && value !== workspace.name) {
                      rename.mutate({ id: workspace.id, value });
                    }
                  }}
                >
                  Rename
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isBusy}
                  aria-label={`Delete ${workspace.name}`}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete ${workspace.name}? Every project in it is archived with it.`,
                      )
                    ) {
                      remove.mutate(workspace.id);
                    }
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>

          <form
            className="flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() !== '') create.mutate(name.trim());
            }}
          >
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="new-workspace-name">New workspace</Label>
              <Input
                id="new-workspace-name"
                maxLength={120}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </div>
            <Button type="submit" disabled={isBusy || name.trim() === ''}>
              Create
            </Button>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
