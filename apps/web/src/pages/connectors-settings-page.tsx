import {
  type Connection,
  type ConnectorProvider,
  connectionListSchema,
  connectionSchema,
  installResponseSchema,
  operationSchema,
  type PasteTokenProvider,
  supabaseInstallResponseSchema,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StepUpDialog } from '@/features/auth/components/two-factor-dialog';
import { PersonalAccountsPolicySwitch } from '@/features/settings/personal-accounts-policy';
import { GITHUB_RETURN_KEY } from '@/features/project/lib/github-sync';
import { PasteTokenDialog } from '@/features/settings/paste-token-dialog';
import { ProviderKeysSection } from '@/features/settings/provider-keys-section';
import { SettingsNav } from '@/features/settings/settings-nav';
import { useOrgs } from '@/features/workspace/hooks/use-orgs';
import { apiRequest } from '@/lib/api/client';
import { ApiProblem, messageFor } from '@/lib/api/problem';

const HEALTH: Record<
  Connection['health'],
  { readonly label: string; readonly variant: 'danger' | 'success' | 'warning' }
> = {
  healthy: { label: 'Healthy', variant: 'success' },
  needs_reauth: { label: 'Needs reconnecting', variant: 'warning' },
  unavailable: { label: 'Unavailable', variant: 'danger' },
};

/** One card per provider, in this order (spec 030). */
const PROVIDERS: readonly {
  readonly provider: ConnectorProvider;
  readonly name: string;
  /** What stops working while the connection needs reconnecting. */
  readonly refused: string;
}[] = [
  { name: 'GitHub', provider: 'github', refused: 'Pushes and pulls are refused until it is.' },
  { name: 'Netlify', provider: 'netlify', refused: 'Publishing is refused until it is.' },
  { name: 'Neon', provider: 'neon', refused: 'Preview databases are refused until it is.' },
  { name: 'Supabase', provider: 'supabase', refused: 'Project keys are refused until it is.' },
  { name: 'Resend', provider: 'resend', refused: 'Sending keys are refused until it is.' },
  { name: 'Cloudflare', provider: 'cloudflare', refused: 'DNS writes are refused until it is.' },
];

const PASTED: ReadonlySet<ConnectorProvider> = new Set(['netlify', 'neon', 'resend', 'cloudflare']);

function connectorsPath(orgId: string, rest = ''): string {
  return `/orgs/${encodeURIComponent(orgId)}/connectors${rest}`;
}

/**
 * The organisation's connectors (spec 018 US1, spec 030 US1): one card per provider. GitHub and
 * Supabase connect by a redirect and come back through their callback pages; Netlify, Neon, Resend
 * and Cloudflare take a pasted token, verified before it is stored. A credential never leaves the
 * API — only its fingerprint does. Removal needs a recent second factor.
 */
export function ConnectorsSettingsPage(): React.JSX.Element {
  const { activeOrg, isLoading: orgsLoading } = useOrgs();
  const orgId = activeOrg?.id ?? '';
  const queryClient = useQueryClient();
  const queryKey = ['connectors', orgId];
  const [pasting, setPasting] = useState<PasteTokenProvider | undefined>(undefined);
  const [steppingUpFor, setSteppingUpFor] = useState<string | undefined>(undefined);

  const connectors = useQuery({
    enabled: orgId !== '',
    queryFn: ({ signal }) =>
      apiRequest('GET', connectorsPath(orgId), { schema: connectionListSchema, signal }),
    queryKey,
    // While a removal runs, the card follows it to its end.
    refetchInterval: (query) =>
      query.state.data?.connections.some(
        (c) => c.provider !== 'github' && c.removalRequestedAt !== null,
      ) === true
        ? 2_000
        : false,
  });

  const install = useMutation({
    mutationFn: async (provider: 'github' | 'supabase') => {
      // A connect abandoned from a project must not carry this one back there.
      window.sessionStorage.removeItem(GITHUB_RETURN_KEY);

      return provider === 'github'
        ? (
            await apiRequest('POST', connectorsPath(orgId, '/github/install'), {
              schema: installResponseSchema,
            })
          ).installUrl
        : (
            await apiRequest('POST', connectorsPath(orgId, '/supabase/install'), {
              schema: supabaseInstallResponseSchema,
            })
          ).url;
    },
    onSuccess: (url) => {
      window.location.assign(url);
    },
  });

  const verify = useMutation({
    mutationFn: (connectionId: string) =>
      apiRequest('POST', connectorsPath(orgId, `/${encodeURIComponent(connectionId)}/verify`), {
        schema: connectionSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const remove = useMutation({
    mutationFn: (connectionId: string) =>
      apiRequest('DELETE', connectorsPath(orgId, `/${encodeURIComponent(connectionId)}`), {
        schema: operationSchema,
      }),
    onError: (failure, connectionId) => {
      if (ApiProblem.is(failure, 'step-up-required')) {
        setSteppingUpFor(connectionId);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  function connect(provider: ConnectorProvider): void {
    if (provider === 'github' || provider === 'supabase') {
      install.mutate(provider);
    } else {
      setPasting(provider);
    }
  }

  // `step-up-required` is answered by the dialog, not reported beside it.
  const removeError =
    remove.error !== null && !ApiProblem.is(remove.error, 'step-up-required') ? remove.error : null;
  const error = install.error ?? verify.error ?? removeError ?? connectors.error;
  const busy = install.isPending || verify.isPending || remove.isPending;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <SettingsNav />
      <h1 className="text-heading-lg font-semibold">Connectors</h1>
      <p className="text-body-sm text-subdued mt-1">
        Connect each provider once for the organisation. Credentials are sealed and never shown.
      </p>

      {error !== null && error !== undefined ? (
        <Alert variant="danger" className="mt-6">
          {messageFor(error, 'Something went wrong. Please try again.')}
        </Alert>
      ) : null}

      {orgsLoading || connectors.isLoading ? (
        <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading connectors…</span>
        </div>
      ) : null}

      {connectors.isSuccess
        ? PROVIDERS.map((entry) => (
            <ProviderCard
              key={entry.provider}
              {...entry}
              busy={busy}
              connection={connectors.data.connections.find((c) => c.provider === entry.provider)}
              onConnect={() => {
                connect(entry.provider);
              }}
              onRemove={(id) => {
                remove.mutate(id);
              }}
              onVerify={(id) => {
                verify.mutate(id);
              }}
            />
          ))
        : null}

      <PasteTokenDialog
        orgId={orgId}
        provider={pasting}
        onOpenChange={(open) => {
          if (!open) setPasting(undefined);
        }}
        onConnected={() => {
          void queryClient.invalidateQueries({ queryKey });
        }}
      />

      <StepUpDialog
        open={steppingUpFor !== undefined}
        description="Removing a connector needs a recent second factor. Enter the code from your authenticator app to continue."
        onOpenChange={(open) => {
          if (!open) setSteppingUpFor(undefined);
        }}
        onSteppedUp={() => {
          // One retry, not a loop: a second refusal renders as the error it is.
          if (steppingUpFor !== undefined) remove.mutate(steppingUpFor);
        }}
      />

      {activeOrg?.role != null ? (
        <>
          <h2 className="text-heading-md mt-10 font-semibold">Model providers</h2>
          <p className="text-body-sm text-subdued mt-1">
            Run on the organisation's own Anthropic or OpenAI key. A key is checked with the
            provider before it is stored and is never shown again.
          </p>
          {/* A guest (spec 031) holds no org role, and no provider keys section. */}
          <ProviderKeysSection orgId={activeOrg.id} role={activeOrg.role} />
          <PersonalAccountsPolicySwitch orgId={activeOrg.id} role={activeOrg.role} />
        </>
      ) : null}
    </main>
  );
}

interface ProviderCardProps {
  readonly busy: boolean;
  readonly connection: Connection | undefined;
  readonly name: string;
  readonly provider: ConnectorProvider;
  readonly refused: string;
  readonly onConnect: () => void;
  readonly onRemove: (connectionId: string) => void;
  readonly onVerify: (connectionId: string) => void;
}

function ProviderCard({
  busy,
  connection,
  name,
  onConnect,
  onRemove,
  onVerify,
  provider,
  refused,
}: ProviderCardProps): React.JSX.Element {
  const headingId = `${provider}-heading`;
  const removing =
    connection !== undefined && 'removalRequestedAt' in connection
      ? connection.removalRequestedAt !== null
      : false;
  const failedResources =
    connection !== undefined && 'failedResources' in connection ? connection.failedResources : [];

  return (
    <section className="border-line mt-6 rounded-lg border p-4" aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-4">
        <h2 id={headingId} className="text-heading-sm font-semibold">
          {name}
        </h2>
        {connection === undefined ? (
          <Button size="sm" disabled={busy} onClick={onConnect}>
            Connect
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || removing}
              onClick={() => {
                onVerify(connection.id);
              }}
            >
              Verify
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || removing}
              onClick={() => {
                onRemove(connection.id);
              }}
            >
              {removing ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        )}
      </div>

      {removing ? (
        <p className="text-body-sm text-subdued mt-3" role="status">
          Removing… its resources are being released first.
        </p>
      ) : null}

      {connection?.health === 'needs_reauth' && !removing ? (
        <Alert variant="warning" className="mt-3 flex items-center justify-between gap-4">
          <span>
            {name} needs reconnecting. {refused}
          </span>
          <Button size="sm" disabled={busy} onClick={onConnect}>
            Reconnect
          </Button>
        </Alert>
      ) : null}

      {connection?.health === 'unavailable' ? (
        <p className="text-body-sm text-danger mt-3" role="status">
          {name} is unavailable. Retrying
          {'circuitOpenUntil' in connection && connection.circuitOpenUntil !== null
            ? ` after ${new Date(connection.circuitOpenUntil).toLocaleString()}`
            : ' shortly'}
          .
        </p>
      ) : null}

      {failedResources.length > 0 ? (
        <Alert variant="danger" className="mt-3">
          Not released at {name}: {failedResources.map((r) => r.name).join(', ')}. Remove them there
          by hand.
        </Alert>
      ) : null}

      {connection === undefined ? (
        <p className="text-body-sm text-subdued mt-2">Not connected.</p>
      ) : (
        <dl className="text-body-sm mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-subdued">Account</dt>
          <dd>
            {connection.provider === 'github' ? connection.account.login : connection.account.name}
          </dd>
          <dt className="text-subdued">Health</dt>
          <dd>
            <Badge variant={HEALTH[connection.health].variant}>
              {HEALTH[connection.health].label}
            </Badge>
          </dd>
          {connection.provider !== 'github' ? (
            <>
              <dt className="text-subdued">Permissions</dt>
              <dd>{connection.scopes.join(', ') || '—'}</dd>
            </>
          ) : null}
          <dt className="text-subdued">Credential</dt>
          <dd className="font-mono">{connection.credentialFingerprint ?? '—'}</dd>
          <dt className="text-subdued">Connected by</dt>
          <dd>
            {connection.connectedBy.name} · {new Date(connection.connectedAt).toLocaleString()}
          </dd>
        </dl>
      )}

      {PASTED.has(provider) && connection !== undefined && !removing ? (
        <p className="text-caption text-faint mt-2">
          Reconnect with a new token at any time; the old one is replaced.
        </p>
      ) : null}
    </section>
  );
}
