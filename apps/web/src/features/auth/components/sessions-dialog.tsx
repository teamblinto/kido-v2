import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangleIcon, Loader2Icon, MonitorIcon } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useNow } from '@/hooks/use-now';
import { messageFor } from '@/lib/api/problem';
import { listSessions, revokeSession } from '../api';
import { describeAgent, describeLastSeen } from '../lib/device';

const SESSIONS_QUERY_KEY = ['sessions'] as const;

interface SessionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Criterion 6, as a screen: the devices this account is signed in on, and a way to end any of them.
 *
 * The list is the only response in the API that enumerates sessions, and `session.ts` is emphatic
 * about what it deliberately does not carry — no session token, and not the SHA-256 the store keys a
 * session by. The `id` here means nothing outside the caller's own list, which is exactly the
 * authority a row needs to be pointed at.
 *
 * Revoking somebody else's session id is a `404`, not a `403`, so there is nothing to guard here and
 * no way to learn whether an id exists.
 */
export function SessionsDialog({ onOpenChange, open }: SessionsDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const now = useNow();

  const sessions = useQuery({
    // Only asked for while the dialog is open. A device list is a snapshot somebody opened
    // deliberately, not something worth keeping warm behind a closed dialog.
    enabled: open,
    queryFn: ({ signal }) => listSessions(signal),
    queryKey: SESSIONS_QUERY_KEY,
    staleTime: 0,
  });

  const revoke = useMutation({
    mutationFn: revokeSession,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  const rows = sessions.data?.sessions ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Signed-in devices</DialogTitle>
          <DialogDescription>
            Every device holding a session for this account. Ending one takes effect on its next
            request.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {sessions.isLoading ? (
            <div className="flex items-center gap-2.5 py-6" role="status" aria-live="polite">
              <Loader2Icon className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
              <span className="text-body-sm text-subdued">Loading your devices…</span>
            </div>
          ) : null}

          {sessions.isError ? (
            <Alert variant="danger">
              <AlertTriangleIcon />
              <AlertTitle>
                {messageFor(sessions.error, 'We could not load your devices')}
              </AlertTitle>
              <AlertDescription>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    void sessions.refetch();
                  }}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {revoke.isError ? (
            <Alert variant="danger" className="mb-3">
              <AlertTriangleIcon />
              <AlertTitle>
                {messageFor(revoke.error, 'That device could not be signed out')}
              </AlertTitle>
            </Alert>
          ) : null}

          {sessions.isSuccess ? (
            <ul className="flex flex-col gap-2.5">
              {rows.map((session) => (
                <li
                  key={session.id}
                  className="border-line-subtle flex items-start gap-3 rounded-lg border p-3"
                >
                  <MonitorIcon
                    className="text-faint mt-0.5 size-[18px] shrink-0"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-label-sm text-foreground font-medium">
                      {describeAgent(session.userAgent)}
                    </p>
                    <p className="text-caption text-faint mt-0.5">
                      {session.ip} · last seen {describeLastSeen(session.lastSeenAt, now)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={revoke.isPending}
                    onClick={() => {
                      revoke.mutate(session.id);
                    }}
                  >
                    Sign out
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
