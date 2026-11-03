import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
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

interface SecretRevealDialogProps {
  /** The signing secret, or `null` when closed. The caller drops it on close. */
  readonly secret: string | null;
  readonly onClose: () => void;
}

/** Shows a new or rotated endpoint signing secret exactly once (FR-005, US5). */
export function SecretRevealDialog({
  onClose,
  secret,
}: SecretRevealDialogProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Signing secret</DialogTitle>
          <DialogDescription>Use it to verify the Forge-Signature header.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Alert variant="warning">
            Copy it now. You will not see this again once this dialog is closed.
          </Alert>
          <code className="bg-muted mt-3 block rounded p-2 font-mono text-sm break-all">
            {secret}
          </code>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (secret !== null) {
                void navigator.clipboard?.writeText(secret).then(() => {
                  setCopied(true);
                });
              }
            }}
          >
            {copied ? 'Copied' : 'Copy secret'}
          </Button>
          <Button
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
