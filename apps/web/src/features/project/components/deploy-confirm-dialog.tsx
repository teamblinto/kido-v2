import type { Checkpoint } from '@repo/contracts';

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

interface DeployConfirmDialogProps {
  /** The checkpoint that would go live — the head, as the history names it. */
  readonly checkpoint: Pick<Checkpoint, 'createdAt' | 'label'>;
  /** A refusal of the last attempt, already put into words. */
  readonly error: string | undefined;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

/**
 * The step between "Deploy" and the request (US6 #1): it names what goes live by the words the
 * history uses, so the decision is about something the person can read rather than "are you sure".
 * Nothing is requested until the confirm button is pressed.
 */
export function DeployConfirmDialog({
  checkpoint,
  error,
  isPending,
  onConfirm,
  onOpenChange,
  open,
}: DeployConfirmDialogProps): React.JSX.Element {
  const { label } = checkpoint;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Deploy “{label}”?</DialogTitle>
          <DialogDescription>
            The project as it was at “{label}”, saved{' '}
            {new Date(checkpoint.createdAt).toLocaleString()}, is built and published. When the
            build succeeds it replaces what the site serves now; the previous release stays in the
            history and can be rolled back to.
          </DialogDescription>
        </DialogHeader>

        {error === undefined ? null : (
          <DialogBody>
            <p role="alert" className="text-danger text-body-sm">
              {error}
            </p>
          </DialogBody>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button type="button" disabled={isPending} onClick={onConfirm}>
            {isPending ? 'Deploying…' : `Deploy “${label}”`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
