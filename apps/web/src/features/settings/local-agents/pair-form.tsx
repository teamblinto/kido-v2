import { localAgentUserCodeSchema } from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StepUpDialog } from '@/features/auth/components/two-factor-dialog';
import { useNow } from '@/hooks/use-now';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { PLATFORM_NAME, formatCountdown, normaliseUserCode } from './local-agent-copy';
import {
  LOCAL_AGENTS_QUERY_KEY,
  approvePairing,
  denyPairing,
  getPairingPreview,
} from './local-agents-api';

type Outcome = 'approved' | 'denied';

/**
 * Approve the code the companion printed (spec 040 § 3 decision 3). The code arrives in the
 * address when the person followed the companion's link, and is typed otherwise. Either way it is
 * typed again to approve: a link someone else sent (phishing) loads a preview, never a pairing.
 */
export function PairForm({ initialCode }: { readonly initialCode: string }): React.JSX.Element {
  const inputId = useId();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState(() => normaliseUserCode(initialCode));
  const [confirmation, setConfirmation] = useState('');
  const [outcome, setOutcome] = useState<{ code: string; kind: Outcome }>();
  const [steppingUp, setSteppingUp] = useState(false);
  const now = useNow(1000);

  const parsed = localAgentUserCodeSchema.safeParse(typed);
  const code = parsed.success ? parsed.data : undefined;
  const decided = outcome !== undefined && outcome.code === code;

  const preview = useQuery({
    enabled: code !== undefined && !decided,
    queryFn: ({ signal }) => getPairingPreview(code ?? '', signal),
    queryKey: ['local-agent-pairing', code],
    retry: false,
  });

  const approve = useMutation({
    mutationFn: approvePairing,
    onError: (failure) => {
      if (ApiProblem.is(failure, 'step-up-required')) setSteppingUp(true);
    },
    onSuccess: (_, approved) => {
      setOutcome({ code: approved, kind: 'approved' });
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_QUERY_KEY });
    },
  });
  const deny = useMutation({
    mutationFn: denyPairing,
    onSuccess: (_, denied) => {
      setOutcome({ code: denied, kind: 'denied' });
    },
  });

  const expired =
    preview.data !== undefined && Date.parse(preview.data.expiresAt) <= now && !decided;
  const busy = approve.isPending || deny.isPending;
  const confirmed =
    code !== undefined &&
    localAgentUserCodeSchema.safeParse(normaliseUserCode(confirmation)).data === code;
  // `step-up-required` is answered by the dialog, not reported beside it.
  const failure =
    approve.error !== null && !ApiProblem.is(approve.error, 'step-up-required')
      ? approve.error
      : (deny.error ?? preview.error);

  return (
    <section aria-labelledby="pair-heading" className="border-line mt-6 rounded-lg border p-4">
      <h2 id="pair-heading" className="text-heading-sm font-semibold">
        Pair a computer
      </h2>

      <form
        className="mt-3 flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          setTyped(normaliseUserCode(typed));
        }}
      >
        <Label htmlFor={inputId}>Pairing code</Label>
        <Input
          id={inputId}
          autoComplete="off"
          spellCheck={false}
          placeholder="XXXX-XXXX"
          className="max-w-[220px] font-mono uppercase"
          aria-describedby={`${inputId}-hint`}
          value={typed}
          onChange={(event) => {
            setTyped(normaliseUserCode(event.target.value));
          }}
        />
        <p id={`${inputId}-hint`} className="text-caption text-subdued">
          The code the companion printed when you ran its pair command.
        </p>
      </form>

      {code !== undefined && preview.isLoading ? (
        <p className="text-body-sm text-subdued mt-3 flex items-center gap-2" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Looking up the code…
        </p>
      ) : null}

      {preview.data === undefined || decided || code === undefined ? null : (
        <div className="bg-subtle mt-4 grid gap-3 rounded-md p-3">
          <dl className="text-body-sm grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-subdued">Computer</dt>
            <dd>{preview.data.name}</dd>
            <dt className="text-subdued">System</dt>
            <dd>{PLATFORM_NAME[preview.data.platform]}</dd>
            <dt className="text-subdued">Companion</dt>
            <dd>{preview.data.companionVersion}</dd>
            <dt className="text-subdued">Requested</dt>
            <dd>{new Date(preview.data.requestedAt).toLocaleString()}</dd>
            <dt className="text-subdued">From network</dt>
            <dd className="font-mono">{preview.data.requesterIp ?? 'Unknown'}</dd>
            <dt className="text-subdued">Expires in</dt>
            <dd>{expired ? 'Expired' : formatCountdown(preview.data.expiresAt, now)}</dd>
          </dl>
          <p className="text-body-sm text-warning font-medium" role="note">
            Only approve if you just ran <code className="font-mono">baios-companion pair</code> on
            your own computer. It will be able to run agents for you.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${inputId}-confirm`}>Type the code again to approve</Label>
            <Input
              id={`${inputId}-confirm`}
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXX-XXXX"
              className="max-w-[220px] font-mono uppercase"
              aria-describedby={`${inputId}-confirm-hint`}
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
              }}
            />
            <p id={`${inputId}-confirm-hint`} className="text-caption text-subdued">
              Copy it from the companion’s output on your computer, not from a message or link.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || expired || !confirmed}
              onClick={() => {
                approve.mutate(code);
              }}
            >
              {approve.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || expired}
              onClick={() => {
                deny.mutate(code);
              }}
            >
              Deny
            </Button>
          </div>
        </div>
      )}

      <div aria-live="polite" className="mt-3">
        {expired ? (
          <p className="text-body-sm text-warning" role="alert">
            This code has expired. Run the pair command again for a new one.
          </p>
        ) : decided ? (
          <p className="text-body-sm text-success" role="status">
            {outcome.kind === 'approved'
              ? 'Paired. The companion picks this up within a few seconds; then run baios-companion start.'
              : 'Pairing denied. That computer was not given access.'}
          </p>
        ) : failure === null ? null : (
          <p className="text-body-sm text-danger" role="alert">
            {messageFor(failure, 'That pairing code could not be checked.')}
          </p>
        )}
      </div>

      <StepUpDialog
        open={steppingUp}
        description="Pairing a computer needs a recent second factor. Enter the code from your authenticator app to continue."
        onOpenChange={setSteppingUp}
        onSteppedUp={() => {
          // One retry, not a loop: a second refusal renders as the error it is.
          if (code !== undefined) approve.mutate(code);
        }}
      />
    </section>
  );
}
