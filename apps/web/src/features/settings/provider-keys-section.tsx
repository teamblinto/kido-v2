import {
  BYOK_REFUSAL_REASONS,
  type ByokRefusalReason,
  LLM_PROVIDERS,
  type LlmProvider,
  type OrgRoleName,
  type ProviderKey,
} from '@repo/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiProblem, messageFor } from '@/lib/api/problem';
import {
  listProviderKeys,
  putProviderKey,
  removeProviderKey,
  verifyProviderKey,
} from './provider-keys-api';

const PROVIDER: Record<LlmProvider, { readonly name: string; readonly prefix: string }> = {
  anthropic: { name: 'Anthropic', prefix: 'sk-ant-' },
  openai: { name: 'OpenAI', prefix: 'sk-' },
};

const HEALTH: Record<
  ProviderKey['health'],
  { readonly label: string; readonly variant: 'danger' | 'success' | 'warning' }
> = {
  healthy: { label: 'Healthy', variant: 'success' },
  needs_reauth: { label: 'Needs a new key', variant: 'warning' },
  unavailable: { label: 'Unavailable', variant: 'danger' },
};

/** Contracts § 1's refusal vocabulary as copy. Local on purpose: no slug, no `MESSAGES` entry. */
const REASON_COPY: Record<ByokRefusalReason, (provider: string) => string> = {
  'could-not-verify': () => 'The provider could not be reached. Try again shortly.',
  'key-rejected': () => 'The provider rejected this key.',
  'needs-reauth': () => 'This key no longer works. Replace or remove it.',
  'wrong-shape': (provider) => `That does not look like an ${provider} key.`,
};

/** `putProviderKeyRequestSchema`'s floor, mirrored so the button says so before the server does. */
const MIN_KEY_LENGTH = 20;

function isReason(value: unknown): value is ByokRefusalReason {
  return typeof value === 'string' && (BYOK_REFUSAL_REASONS as readonly string[]).includes(value);
}

function errorCopy(error: unknown, provider: string): string {
  const reason = ApiProblem.is(error) ? error.detail?.reason : undefined;

  return isReason(reason) ? REASON_COPY[reason](provider) : messageFor(error);
}

interface ProviderKeysSectionProps {
  readonly orgId: string;
  readonly role: OrgRoleName;
}

/**
 * The organisation's own LLM keys (spec 020 US1/US3/US4): one card per provider. A key goes up
 * once and never comes back — the card shows its last four and fingerprint only. Controls follow
 * `org:connectors.manage`, which the rbac catalogue grants to owners and admins.
 */
export function ProviderKeysSection({ orgId, role }: ProviderKeysSectionProps): React.JSX.Element {
  const canManage = role === 'owner' || role === 'admin';
  const keys = useQuery({
    queryFn: ({ signal }) => listProviderKeys(orgId, signal),
    queryKey: ['provider-keys', orgId],
  });

  if (keys.isLoading) {
    return (
      <div className="mt-4 flex items-center gap-2.5" role="status" aria-live="polite">
        <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
        <span className="text-body-sm text-subdued">Loading provider keys…</span>
      </div>
    );
  }

  if (keys.isError) {
    return (
      <p className="text-body-sm text-danger mt-4" role="alert">
        {messageFor(keys.error, 'Provider keys could not be loaded.')}
      </p>
    );
  }

  return (
    <div className="mt-4 grid gap-4">
      {LLM_PROVIDERS.map((provider) => (
        <ProviderCard
          key={provider}
          canManage={canManage}
          orgId={orgId}
          provider={provider}
          stored={keys.data?.keys.find((k) => k.provider === provider)}
        />
      ))}
    </div>
  );
}

function ProviderCard({
  canManage,
  orgId,
  provider,
  stored,
}: {
  readonly canManage: boolean;
  readonly orgId: string;
  readonly provider: LlmProvider;
  readonly stored: ProviderKey | undefined;
}): React.JSX.Element {
  const { name, prefix } = PROVIDER[provider];
  const id = useId();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['provider-keys', orgId] });

  const put = useMutation({
    mutationFn: (key: string) => putProviderKey(orgId, provider, key),
    onSuccess: () => {
      setApiKey('');

      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => removeProviderKey(orgId, provider),
    onSuccess: refresh,
  });
  const verify = useMutation({
    mutationFn: () => verifyProviderKey(orgId, provider),
    onSuccess: refresh,
  });

  const busy = put.isPending || remove.isPending || verify.isPending;
  const error = put.error ?? remove.error ?? verify.error;

  return (
    <section className="border-line rounded-lg border p-4" aria-labelledby={`${id}-heading`}>
      <div className="flex items-center justify-between gap-4">
        <h3 id={`${id}-heading`} className="text-heading-sm font-semibold">
          {name}
        </h3>
        {canManage && stored !== undefined ? (
          <div className="flex gap-2">
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
              Verify
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Remove the ${name} key? Runs fall back to the platform key.`)) {
                  remove.mutate();
                }
              }}
            >
              Remove
            </Button>
          </div>
        ) : null}
      </div>

      {stored === undefined ? (
        <p className="text-body-sm text-subdued mt-2">No key stored.</p>
      ) : (
        <dl className="text-body-sm mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-subdued">Key</dt>
          <dd className="font-mono">••••{stored.lastFour}</dd>
          <dt className="text-subdued">Fingerprint</dt>
          <dd className="font-mono">{stored.fingerprint}</dd>
          <dt className="text-subdued">Health</dt>
          <dd className="flex items-center gap-2">
            <Badge variant={HEALTH[stored.health].variant}>{HEALTH[stored.health].label}</Badge>
            {stored.health === 'needs_reauth' ? (
              <span className="text-warning">
                {name} no longer accepts it — replace or remove this key.
              </span>
            ) : null}
          </dd>
          <dt className="text-subdued">Added by</dt>
          <dd>
            {stored.addedBy?.name ?? 'A former member'} ·{' '}
            {new Date(stored.addedAt).toLocaleString()}
          </dd>
          <dt className="text-subdued">Last verified</dt>
          <dd>{new Date(stored.lastVerifiedAt).toLocaleString()}</dd>
        </dl>
      )}

      {canManage ? (
        <form
          className="mt-4 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            put.mutate(apiKey.trim());
          }}
        >
          <Label htmlFor={`${id}-key`}>API key</Label>
          <Input
            id={`${id}-key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-hint`}
            aria-invalid={put.isError ? true : undefined}
            disabled={busy}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
            }}
          />
          <p id={`${id}-hint`} className="text-caption text-subdued">
            Starts with <code>{prefix}</code>. Checked with {name} before it is stored; shown only
            as its last four afterwards.
          </p>
          <div aria-live="assertive">
            {error !== null ? (
              <p className="text-caption text-danger" role="alert">
                {errorCopy(error, name)}
              </p>
            ) : null}
          </div>
          <div>
            <Button
              size="sm"
              type="submit"
              disabled={busy || apiKey.trim().length < MIN_KEY_LENGTH}
            >
              {put.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {stored === undefined ? 'Add key' : 'Replace key'}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
