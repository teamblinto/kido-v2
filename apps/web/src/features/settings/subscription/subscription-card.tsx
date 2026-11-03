import type { SubscriptionList, SubscriptionStatus } from '@repo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useNow } from '@/hooks/use-now';
import { messageFor } from '@/lib/api/problem';
import { formatCountdown } from '../local-agents/local-agent-copy';
import {
  SUBSCRIPTIONS_QUERY_KEY,
  cancelSubscriptionSignIn,
  connectSubscription,
  disconnectSubscription,
  isClaudeSignInUrl,
  isTransitional,
  submitSubscriptionCode,
  useSubscriptions,
} from './subscription-api';

const SETTING_UP = 'Setting up your private workspace… this can take a minute the first time.';

const STATE_TEXT: Record<SubscriptionStatus['state'], string> = {
  'awaiting-sign-in': 'Sign in with Claude to finish connecting.',
  connected: 'Connected',
  disconnected: 'Not connected.',
  error: 'Something went wrong with your Claude subscription.',
  provisioning: SETTING_UP,
  'signed-out': 'Your Claude sign-in has ended.',
  starting: SETTING_UP,
  verifying: 'Checking your code with Claude…',
};

function stateText(status: SubscriptionStatus): string {
  if (status.state === 'connected') {
    return status.plan === null ? 'Connected' : `Connected · ${status.plan}`;
  }
  if (status.state === 'error' || status.state === 'signed-out') {
    return status.message ?? STATE_TEXT[status.state];
  }

  return STATE_TEXT[status.state];
}

/**
 * Spec 041: run Claude Code on the person's own Claude plan, in a private cloud workspace. The
 * sign-in is Anthropic's; BAIOS only relays the one-time code.
 */
export function SubscriptionCard(): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [confirming, setConfirming] = useState(false);
  const list = useSubscriptions();
  const status = list.data?.claude;

  const refresh = () => queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_QUERY_KEY });
  const connect = useMutation({
    mutationFn: connectSubscription,
    onSuccess: (next) => {
      queryClient.setQueryData<SubscriptionList>(SUBSCRIPTIONS_QUERY_KEY, { claude: next });
      statusRef.current?.focus();
    },
  });
  const cancel = useMutation({ mutationFn: cancelSubscriptionSignIn, onSuccess: refresh });
  const disconnect = useMutation({
    mutationFn: disconnectSubscription,
    onSuccess: () => {
      setConfirming(false);
      statusRef.current?.focus();

      return refresh();
    },
  });
  const error = connect.error ?? cancel.error ?? disconnect.error;
  const busy =
    status !== undefined && isTransitional(status.state) && status.state !== 'awaiting-sign-in';

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="border-line mt-4 rounded-lg border p-4"
      id="claude-subscription"
    >
      <h2 id={`${id}-heading`} className="text-heading-sm font-semibold">
        Claude subscription
      </h2>
      <p className="text-body-sm text-subdued mt-1">
        Runs Claude Code on your own Claude plan in a private cloud workspace. BAIOS never sees your
        Claude password or tokens. Usage counts against your Claude plan&apos;s limits.
      </p>

      <div aria-live="polite" className="mt-3 flex items-center gap-2" role="status">
        {list.isLoading || busy ? (
          <Loader2 className="text-subdued size-4 animate-spin" aria-hidden="true" />
        ) : null}
        <p ref={statusRef} tabIndex={-1} className="text-body-sm outline-none">
          {status !== undefined
            ? stateText(status)
            : list.isError
              ? messageFor(list.error, 'Your Claude subscription could not be loaded.')
              : 'Loading…'}
        </p>
      </div>

      {status === undefined ? null : (
        <div className="mt-3">
          {status.state === 'disconnected' ||
          status.state === 'error' ||
          status.state === 'signed-out' ? (
            <Button
              size="sm"
              disabled={connect.isPending}
              onClick={() => {
                connect.mutate();
              }}
            >
              {status.state === 'disconnected' ? 'Connect Claude subscription' : 'Reconnect'}
            </Button>
          ) : null}

          {status.state === 'awaiting-sign-in' ? (
            <SignInSteps
              cancelling={cancel.isPending}
              onCancel={() => {
                cancel.mutate();
              }}
              onSubmitted={() => {
                statusRef.current?.focus();
                return refresh();
              }}
              signIn={status.signIn}
            />
          ) : null}

          {status.state === 'connected' ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      )}

      {error === null ? null : (
        <p className="text-caption text-danger mt-2" role="alert">
          {messageFor(error)}
        </p>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Disconnect your Claude subscription?</DialogTitle>
            <DialogDescription>
              BAIOS signs Claude Code out and deletes your private workspace. Runs go back to being
              paid by BAIOS until you connect again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={disconnect.isPending}
              onClick={() => {
                disconnect.mutate();
              }}
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SignInSteps({
  cancelling,
  onCancel,
  onSubmitted,
  signIn,
}: {
  readonly cancelling: boolean;
  readonly onCancel: () => void;
  readonly onSubmitted: () => Promise<unknown>;
  readonly signIn: SubscriptionStatus['signIn'];
}): React.JSX.Element {
  const id = useId();
  const now = useNow(1_000);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const expired = signIn !== null && Date.parse(signIn.expiresAt) <= now;

  // The code is read from the uncontrolled field and the field is emptied before the request
  // leaves: it never sits in React state, a query cache, the address or storage.
  async function send(form: HTMLFormElement): Promise<void> {
    const entry = new FormData(form).get('code');
    const code = typeof entry === 'string' ? entry.trim() : '';
    form.reset();
    if (code.length === 0) return;
    setSending(true);
    setFailure(null);
    try {
      await submitSubscriptionCode(code);
      await onSubmitted();
    } catch (caught) {
      setFailure(caught);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid gap-3">
      <ol className="text-body-sm grid list-decimal gap-3 pl-5">
        <li>
          {signIn !== null && isClaudeSignInUrl(signIn.url) ? (
            <a
              className="text-brand-text font-medium underline-offset-4 hover:underline"
              href={signIn.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              Sign in with Claude
            </a>
          ) : (
            <span className="text-subdued">Waiting for the sign-in link…</span>
          )}{' '}
          <span className="text-subdued">(opens in a new tab)</span>
        </li>
        <li>
          <form
            className="grid gap-1.5"
            method="post"
            onSubmit={(event) => {
              event.preventDefault();
              void send(event.currentTarget);
            }}
          >
            <Label htmlFor={`${id}-code`}>Paste the code Claude shows you</Label>
            <div className="flex gap-2">
              <Input
                id={`${id}-code`}
                name="code"
                autoComplete="off"
                maxLength={512}
                required
                spellCheck={false}
                className="h-8"
              />
              <Button type="submit" size="sm" disabled={sending || expired}>
                {sending ? 'Submitting…' : 'Submit'}
              </Button>
            </div>
          </form>
        </li>
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="ghost" disabled={cancelling} onClick={onCancel}>
          Cancel
        </Button>
        {signIn === null ? null : (
          <span className="text-caption text-subdued">
            {expired
              ? 'This sign-in has expired. Cancel and connect again.'
              : `Expires in ${formatCountdown(signIn.expiresAt, now)}`}
          </span>
        )}
      </div>

      {failure === null ? null : (
        <p className="text-caption text-danger" role="alert">
          {messageFor(failure, 'That code could not be sent. Try again.')}
        </p>
      )}
    </div>
  );
}
