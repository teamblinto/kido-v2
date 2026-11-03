import type { Domain, RemoveDomainResponse } from '@repo/contracts';
import { useId, useState } from 'react';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface RemoveDomainDialogProps {
  readonly domain: Pick<Domain, 'displayHostname' | 'hostname'>;
  /** A refusal of the last attempt, already put into words. */
  readonly error: string | undefined;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  /** The accepted removal: once present, the dialog lists what may now be deleted from DNS. */
  readonly removed: RemoveDomainResponse | undefined;
}

/**
 * The step between "Remove" and the request (US5 #2): the hostname must be typed, so the decision
 * is about the name being released rather than "are you sure". Afterwards it shows the records the
 * member created, which they now delete themselves — until they do, the platform answers nothing
 * for the hostname.
 */
export function RemoveDomainDialog({
  domain,
  error,
  isPending,
  onConfirm,
  onOpenChange,
  open,
  removed,
}: RemoveDomainDialogProps): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const name = domain.displayHostname;
  const entered = typed.trim();
  const matches = entered === name || entered.toLowerCase() === domain.hostname;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setTyped('');
        }

        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        {removed === undefined ? (
          <>
            <DialogHeader>
              <DialogTitle>Remove {name}?</DialogTitle>
              <DialogDescription>
                It stops serving the site and is released, so it can be added again only with a new
                verification.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="flex flex-col gap-2">
              <Label htmlFor={inputId}>Type {name} to confirm</Label>
              <Input
                id={inputId}
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
              />
              {error === undefined ? null : (
                <p role="alert" className="text-danger text-body-sm">
                  {error}
                </p>
              )}
            </DialogBody>

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
              <Button type="button" disabled={!matches || isPending} onClick={onConfirm}>
                {isPending ? 'Removing…' : 'Remove domain'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{name} is being removed</DialogTitle>
              <DialogDescription>
                You can now delete these records from your DNS provider.
              </DialogDescription>
            </DialogHeader>

            <DialogBody>
              <ul className="flex flex-col gap-2" aria-label="Records to delete">
                {removed.deletableRecords.map((record) => (
                  <li
                    key={`${record.type} ${record.name}`}
                    className="bg-muted text-body-sm flex flex-col gap-0.5 rounded-md p-2.5"
                  >
                    <span className="text-subdued">{record.type}</span>
                    <code className="font-mono break-all">{record.name}</code>
                    <code className="text-subdued font-mono break-all">{record.value}</code>
                  </li>
                ))}
              </ul>
            </DialogBody>

            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
