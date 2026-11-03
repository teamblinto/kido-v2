import type { Checkpoint } from '@repo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { messageFor } from '@/lib/api/problem';
import { useRevert } from '../hooks/use-checkpoints';

interface RevertDialogProps {
  readonly checkpoint: Checkpoint;
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
  /** A run is still going, so the tree it is writing to must not be rewritten underneath it. */
  readonly isRunActive: boolean;
}

/**
 * Going back to an earlier point, with the confirmation that makes it a decision.
 *
 * Two of the three gates from FR-010 are not here on purpose: whether the caller may write files
 * at all, and whether this row is the head, are both answered by whoever renders the history — an
 * unpermitted caller gets no trigger rendered, rather than a disabled one that advertises an
 * action they cannot take. What is left is the gate that changes minute to minute, so it arrives
 * as a prop and disables the trigger with the reason rather than hiding it.
 *
 * The confirmation names the point by the same words the row does. A destructive action that only
 * says "are you sure" asks about something the person has to remember; this one asks about
 * something they can read.
 */
export function RevertDialog({
  checkpoint,
  isRunActive,
  orgId,
  projectId,
}: RevertDialogProps): React.JSX.Element {
  const label = checkpoint.label;
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const revert = useRevert({ orgId, projectId });

  return (
    <div className="border-line-subtle border-t px-4 py-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isRunActive}
        title={isRunActive ? 'A run is active' : undefined}
        onClick={() => {
          revert.reset();
          setOpen(true);
        }}
      >
        Revert to this point
      </Button>
      {isRunActive ? (
        <span className="text-faint text-body-sm ml-2 align-middle">A run is active</span>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Go back to “{label}”?</DialogTitle>
            <DialogDescription>
              Every file in this project is restored to how it was at “{label}”, saved{' '}
              {new Date(checkpoint.createdAt).toLocaleString()}. Work done since then stays in the
              history, but it leaves the files.
            </DialogDescription>
          </DialogHeader>

          {revert.error === null ? null : (
            <DialogBody>
              <p role="alert" className="text-danger text-body-sm">
                {messageFor(revert.error)}
              </p>
            </DialogBody>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={revert.isPending}
              onClick={() => {
                revert.mutate(checkpoint.id, {
                  onError: () => {
                    /*
                     * A refusal may be the list's fault — the head moved, or the point was
                     * mirrored away — so the history is re-read before the person decides what to
                     * do next. `useRevert` refetches on success; this is the other half.
                     */
                    void queryClient.invalidateQueries({ queryKey: ['checkpoints'] });
                  },
                  onSuccess: () => {
                    setOpen(false);
                  },
                });
              }}
            >
              {revert.isPending ? 'Going back…' : `Go back to “${label}”`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
