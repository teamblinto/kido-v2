import type { BeginLinkResponse, LinkedAccount, LlmProvider } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/features/auth/components/two-factor-dialog';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { linkErrorCopy } from './linked-account-copy';
import {
  beginLink,
  completeLink,
  isPending,
  listLinkedAccounts,
  unlinkAccount,
  verifyLinkedAccount,
} from './linked-accounts-api';

const LINKED_ACCOUNTS_QUERY_KEY = ['linked-accounts'] as const;

const PROVIDER_NAME: Record<LlmProvider, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
};

const HEALTH: Record<
  LinkedAccount['health'],
  { readonly label: string; readonly variant: 'success' | 'warning' }
> = {
  healthy: { label: 'Healthy', variant: 'success' },
  needs_reauth: { label: 'Needs reconnecting', variant: 'warning' },
};

function formatTime(iso: string): string {
  // The viewer's own time zone: `toLocaleString` without a `timeZone` option.
  return new Date(iso).toLocaleString();
}

/**
 * The person's own subscription accounts (spec 032 US2): one card per provider the organisation
 * **offers**. Nothing of the grant is ever shown — only the provider's display label.
 */
export function ConnectedAccountsSection(): React.JSX.Element {
  const list = useQuery({
    queryFn: ({ signal }) => listLinkedAccounts(signal),
    queryKey: LINKED_ACCOUNTS_QUERY_KEY,
  });

  if (list.isLoading) {
    return (
      <div className="mt-4 flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">Loading connected accounts…</span>
      </div>
    );
  }

  if (list.isError || list.data === undefined) {
    return (
      <p className="text-body-sm text-danger mt-4" role="alert">
        {messageFor(list.error, 'Connected accounts could not be loaded.')}
      </p>
    );
  }

  const { accounts, offered } = list.data;

  if (offered.length === 0) {
    // FR-003: nothing linkable, just where Claude and OpenAI come from instead.
    return (
      <p className="text-body-sm text-subdued mt-4">
        Your organisation uses its own API key for Claude and OpenAI, so there is nothing to connect
        here.
      </p>
    );
  }

  return (
    <div className="mt-4 grid gap-4">
      {offered.map((provider) => (
        <AccountCard
          key={provider}
          provider={provider}
          linked={accounts.find((a) => a.provider === provider)}
        />
      ))}
    </div>
  );
}

function AccountCard({
  linked,
  provider,
}: {
  readonly linked: LinkedAccount | undefined;
  readonly provider: LlmProvider;
}): React.JSX.Element {
  const name = PROVIDER_NAME[provider];
  const id = useId();
  const queryClient = useQueryClient();
  const [steppingUp, setSteppingUp] = useState(false);
  const [device, setDevice] = useState<Extract<BeginLinkResponse, { kind: 'device' }>>();
  const [waiting, setWaiting] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: LINKED_ACCOUNTS_QUERY_KEY });

  const begin = useMutation({
    mutationFn: () => beginLink(provider),
    onError: (failure) => {
      if (ApiProblem.is(failure, 'step-up-required')) setSteppingUp(true);
    },
    onSuccess: (result) => {
      if (result.kind === 'redirect') {
        window.location.assign(result.url);
      } else {
        setWaiting(false);
        setDevice(result);
      }
    },
  });
  const poll = useMutation({
    mutationFn: (state: string) => completeLink(provider, { state }),
    onSuccess: (result) => {
      if (isPending(result)) {
        setWaiting(true);

        return undefined;
      }
      setDevice(undefined);

      return refresh();
    },
  });
  const verify = useMutation({
    mutationFn: () => verifyLinkedAccount(provider),
    onSuccess: refresh,
  });
  const unlink = useMutation({
    mutationFn: () => unlinkAccount(provider),
    onSuccess: refresh,
  });

  const busy = begin.isPending || poll.isPending || verify.isPending || unlink.isPending;
  // `step-up-required` is answered by the dialog, not reported beside it.
  const beginError =
    begin.error !== null && !ApiProblem.is(begin.error, 'step-up-required') ? begin.error : null;
  const error = beginError ?? poll.error ?? verify.error ?? unlink.error;

  return (
    <section className="border-line rounded-lg border p-4" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h3 id={`${id}-heading`} className="text-heading-sm font-semibold">
          {name}
        </h3>
        <div className="flex flex-wrap gap-2">
          {linked === undefined || linked.health === 'needs_reauth' ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                begin.mutate();
              }}
            >
              {begin.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {linked === undefined ? 'Connect' : 'Reconnect'}
            </Button>
          ) : null}
          {linked === undefined ? null : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  verify.mutate();
                }}
              >
                {verify.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                Check now
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Disconnect your ${name} account?`)) unlink.mutate();
                }}
              >
                Disconnect
              </Button>
            </>
          )}
        </div>
      </div>

      {linked === undefined ? (
        <p className="text-body-sm text-subdued mt-2">Not connected.</p>
      ) : (
        <dl className="text-body-sm mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-subdued">Account</dt>
          <dd>{linked.accountLabel}</dd>
          <dt className="text-subdued">Health</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <Badge variant={HEALTH[linked.health].variant}>{HEALTH[linked.health].label}</Badge>
            {linked.limitedUntil === null ? null : (
              <span className="text-warning">Limited until {formatTime(linked.limitedUntil)}</span>
            )}
          </dd>
          <dt className="text-subdued">Connected</dt>
          <dd>{formatTime(linked.linkedAt)}</dd>
          <dt className="text-subdued">Last checked</dt>
          <dd>{formatTime(linked.lastCheckedAt)}</dd>
        </dl>
      )}

      {device === undefined ? null : (
        <div className="bg-secondary/40 mt-4 grid gap-2 rounded-md p-3">
          <p className="text-body-sm">
            Open{' '}
            <a
              className="underline"
              href={device.verificationUri}
              target="_blank"
              rel="noreferrer noopener"
            >
              {device.verificationUri}
            </a>{' '}
            and enter this code:
          </p>
          <p className="font-mono text-heading-sm" aria-label="Device code">
            {device.userCode}
          </p>
          <p className="text-caption text-subdued">Expires {formatTime(device.expiresAt)}.</p>
          {waiting ? (
            <p className="text-caption text-subdued" role="status">
              {name} has not confirmed yet. Finish there, then try again.
            </p>
          ) : null}
          <div>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                poll.mutate(device.state);
              }}
            >
              I have entered the code
            </Button>
          </div>
        </div>
      )}

      <div aria-live="assertive">
        {error === null ? null : (
          <p className="text-caption text-danger mt-2" role="alert">
            {linkErrorCopy(error, name)}
          </p>
        )}
      </div>

      <StepUpDialog
        open={steppingUp}
        description={`Connecting ${name === 'OpenAI' ? 'an' : 'a'} ${name} account needs a recent second factor. Enter the code from your authenticator app to continue.`}
        onOpenChange={setSteppingUp}
        onSteppedUp={() => {
          // One retry, not a loop: a second refusal renders as the error it is.
          begin.mutate();
        }}
      />
    </section>
  );
}
