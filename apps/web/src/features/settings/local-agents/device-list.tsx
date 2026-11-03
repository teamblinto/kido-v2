import type { LocalAgentDevice, LocalAgentProviderStatus } from '@repo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { StepUpDialog } from '@/features/auth/components/two-factor-dialog';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import { CopyCommand } from './copy-command';
import {
  AUTH_METHOD_NAME,
  PLATFORM_NAME,
  PROVIDER_NAME,
  WORKSPACE_ADD_COMMAND,
  providerFix,
} from './local-agent-copy';
import { LOCAL_AGENTS_QUERY_KEY, revokeLocalAgent, useLocalAgents } from './local-agents-api';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** The person's paired computers and what each one can run (spec 040 § 4). */
export function DeviceList(): React.JSX.Element {
  const list = useLocalAgents();

  return (
    <section aria-labelledby="devices-heading" className="mt-8">
      <h2 id="devices-heading" className="text-heading-sm font-semibold">
        Your computers
      </h2>
      {list.isLoading ? (
        <p className="text-body-sm text-subdued mt-3 flex items-center gap-2" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading your computers…
        </p>
      ) : list.data === undefined ? (
        <p className="text-body-sm text-danger mt-3" role="alert">
          {messageFor(list.error, 'Your computers could not be loaded.')}
        </p>
      ) : list.data.devices.length === 0 ? (
        <p className="text-body-sm text-subdued mt-3">No computers paired yet.</p>
      ) : (
        <div className="mt-3 grid gap-4">
          {list.data.devices.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))}
        </div>
      )}
    </section>
  );
}

function DeviceCard({ device }: { readonly device: LocalAgentDevice }): React.JSX.Element {
  const id = useId();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [steppingUp, setSteppingUp] = useState(false);

  const revoke = useMutation({
    mutationFn: () => revokeLocalAgent(device.id),
    onError: (failure) => {
      if (ApiProblem.is(failure, 'step-up-required')) {
        setConfirming(false);
        setSteppingUp(true);
      }
    },
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: LOCAL_AGENTS_QUERY_KEY });
    },
  });
  const error =
    revoke.error !== null && !ApiProblem.is(revoke.error, 'step-up-required') ? revoke.error : null;

  return (
    <section className="border-line rounded-lg border p-4" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${id}-heading`} className="text-heading-sm font-semibold">
            {device.name}
          </h3>
          <Badge variant={device.online ? 'success' : 'muted'}>
            {device.online ? 'Online' : 'Offline'}
          </Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Revoke
        </Button>
      </div>

      <p className="text-caption text-subdued mt-1">
        {PLATFORM_NAME[device.platform]} · companion {device.companionVersion} ·{' '}
        {device.lastSeenAt === null
          ? 'never connected'
          : `last seen ${formatTime(device.lastSeenAt)}`}
      </p>

      <ul className="mt-3 grid gap-3" aria-label={`Agents on ${device.name}`}>
        {device.providers.map((status) => (
          <ProviderRow key={status.provider} status={status} />
        ))}
      </ul>

      <div className="text-body-sm mt-3">
        <h4 className="text-label-sm text-subdued font-medium">Workspaces</h4>
        {device.workspaces.length === 0 ? (
          <p className="text-caption text-subdued mt-1">
            None yet. Add one on this computer with <CopyCommand command={WORKSPACE_ADD_COMMAND} />
          </p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-2" aria-label={`Workspaces on ${device.name}`}>
            {device.workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Badge variant="outline">{workspace.label}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error === null ? null : (
        <p className="text-caption text-danger mt-2" role="alert">
          {messageFor(error)}
        </p>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Revoke {device.name}?</DialogTitle>
            <DialogDescription>
              It stops being able to run agents for you, and any run on it now is stopped. To use it
              again, pair it again.
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
              disabled={revoke.isPending}
              onClick={() => {
                revoke.mutate();
              }}
            >
              {revoke.isPending ? 'Revoking…' : 'Revoke computer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <StepUpDialog
        open={steppingUp}
        description={`Revoking ${device.name} needs a recent second factor. Enter the code from your authenticator app to continue.`}
        onOpenChange={setSteppingUp}
        onSteppedUp={() => {
          revoke.mutate();
        }}
      />
    </section>
  );
}

function ProviderRow({ status }: { readonly status: LocalAgentProviderStatus }): React.JSX.Element {
  const name = PROVIDER_NAME[status.provider];
  const fix = providerFix(status);
  const { auth } = status;
  const signIn =
    auth.status === 'authenticated'
      ? [
          'Signed in',
          auth.method === null ? undefined : `with ${AUTH_METHOD_NAME[auth.method]}`,
          auth.plan === null ? undefined : `(${auth.plan})`,
        ]
          .filter((part) => part !== undefined)
          .join(' ')
      : auth.status === 'unauthenticated'
        ? 'Not signed in'
        : 'Sign-in status unknown';

  return (
    <li className="bg-subtle grid gap-1 rounded-md p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label-sm font-semibold">{name}</span>
        <span className="text-caption text-subdued">
          {status.installed ? `version ${status.version ?? 'unknown'}` : 'Not installed'}
        </span>
        {status.installed ? <span className="text-caption text-subdued">· {signIn}</span> : null}
        <Badge variant={status.policy.allowed ? 'success' : 'danger'}>
          {status.policy.allowed ? 'Allowed' : 'Blocked'}
        </Badge>
      </div>
      {status.policy.allowed || status.policy.reason === null ? null : (
        <p className="text-caption text-danger">{status.policy.reason}</p>
      )}
      {status.message === null ? null : (
        <p className="text-caption text-subdued">{status.message}</p>
      )}
      {fix === undefined ? null : (
        <p className="text-caption text-subdued flex flex-wrap items-center gap-1.5">
          {fix.hint} <CopyCommand command={fix.command} />
        </p>
      )}
    </li>
  );
}
