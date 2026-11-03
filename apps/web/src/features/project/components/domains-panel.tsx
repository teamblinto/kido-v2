import type { CloudflareOffer, Domain, DomainRecord } from '@repo/contracts';
import { CopyIcon, Loader2 } from 'lucide-react';
import { useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StepUpDialog } from '@/features/auth/components/two-factor-dialog';
import { ApiProblem } from '@/lib/api/problem';
import {
  useAddDomain,
  useCheckDomain,
  useCloudflareOffer,
  useDomains,
  useRemoveDomain,
  useRetryDomain,
  useWriteWithCloudflare,
} from '../hooks/use-domains';
import {
  DOMAIN_FAILURE_COPY,
  DOMAIN_RECORD_PURPOSE_COPY,
  DOMAIN_RECORD_STATUS_COPY,
  DOMAIN_STATE_COPY,
  domainErrorCopy,
} from '../lib/domain-reasons';
import { RemoveDomainDialog } from './remove-domain-dialog';

interface DomainsPanelProps {
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
}

/**
 * The project's custom domains (spec 028 US5): each one's state, the DNS records to create with a
 * copy action for each, and — for a member holding `org:domains.manage`, which the list's
 * `canManage` reports — add, check now, retry and remove. Anyone who may read the project sees
 * the same list and no action at all, as the deploy panel does.
 */
export function DomainsPanel({ orgId, projectId }: DomainsPanelProps): React.JSX.Element {
  const project = { orgId, projectId };

  const domains = useDomains(project);
  const add = useAddDomain(project);
  const check = useCheckDomain(project);
  const retry = useRetryDomain(project);
  const remove = useRemoveDomain(project);

  const [hostname, setHostname] = useState('');
  const [removing, setRemoving] = useState<Domain | undefined>(undefined);
  const inputId = useId();

  const rows = domains.data?.items ?? [];
  const canManage = domains.data?.canManage ?? false;

  const rowError = (domain: Domain): string | undefined => {
    if (check.error !== null && check.variables === domain.id) {
      return domainErrorCopy(check.error);
    }

    if (retry.error !== null && retry.variables === domain.id) {
      return domainErrorCopy(retry.error);
    }

    return undefined;
  };

  return (
    <section className="flex flex-col gap-4 p-4" aria-labelledby="domains-panel-heading">
      <h2 id="domains-panel-heading" className="text-heading-sm font-semibold">
        Domains
      </h2>

      {domains.isLoading ? (
        <div className="flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading…</span>
        </div>
      ) : null}

      {domains.error === null ? null : (
        <Alert variant="danger">{domainErrorCopy(domains.error)}</Alert>
      )}

      {canManage ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate(hostname, {
              onSuccess: () => {
                setHostname('');
              },
            });
          }}
        >
          <Label htmlFor={inputId}>Hostname</Label>
          <div className="flex gap-2">
            <Input
              id={inputId}
              autoComplete="off"
              spellCheck={false}
              placeholder="app.example.com"
              className="h-8 text-body-sm"
              value={hostname}
              onChange={(event) => {
                setHostname(event.target.value);
              }}
            />
            <Button size="sm" type="submit" disabled={hostname.trim() === '' || add.isPending}>
              Add domain
            </Button>
          </div>
          {add.error === null ? null : <Alert variant="danger">{domainErrorCopy(add.error)}</Alert>}
        </form>
      ) : null}

      {domains.isSuccess && !canManage ? (
        <p className="text-body-sm text-subdued">
          Only organisation owners and admins can add or change domains.
        </p>
      ) : null}

      {domains.isSuccess && rows.length === 0 ? (
        <p className="text-body-sm text-subdued">No custom domains yet.</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-4" aria-label="Custom domains">
          {rows.map((domain) => (
            <DomainRow
              key={domain.id}
              busy={check.isPending || retry.isPending}
              canManage={canManage}
              domain={domain}
              orgId={orgId}
              error={rowError(domain)}
              onCheck={() => {
                check.mutate(domain.id);
              }}
              onRemove={() => {
                remove.reset();
                setRemoving(domain);
              }}
              onRetry={() => {
                retry.mutate(domain.id);
              }}
            />
          ))}
        </ul>
      ) : null}

      {removing === undefined ? null : (
        <RemoveDomainDialog
          key={removing.id}
          domain={removing}
          error={remove.error === null ? undefined : domainErrorCopy(remove.error)}
          isPending={remove.isPending}
          onConfirm={() => {
            remove.mutate(removing.id);
          }}
          onOpenChange={(open) => {
            if (!open) {
              setRemoving(undefined);
            }
          }}
          open
          removed={remove.data}
        />
      )}
    </section>
  );
}

function formatted(iso: string): string {
  return new Date(iso).toLocaleString();
}

function DomainRow({
  busy,
  canManage,
  domain,
  error,
  onCheck,
  onRemove,
  onRetry,
  orgId,
}: {
  readonly busy: boolean;
  readonly canManage: boolean;
  readonly domain: Domain;
  readonly orgId: string | undefined;
  readonly error: string | undefined;
  readonly onCheck: () => void;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const nameId = useId();
  const state = DOMAIN_STATE_COPY[domain.state];
  const name = domain.displayHostname;
  const caa = domain.check?.caa;

  return (
    <li
      aria-labelledby={nameId}
      className="border-line-subtle flex flex-col gap-2 border-b pb-4 last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span id={nameId} className="text-body-sm min-w-0 flex-1 truncate font-medium">
          {name}
        </span>
        <Badge variant={state.variant}>{state.label}</Badge>
      </div>

      <p className="text-body-sm text-subdued">{state.description}</p>

      {domain.state === 'pending' && domain.windowEndsAt !== null ? (
        <p className="text-body-sm text-subdued">
          Checked automatically until {formatted(domain.windowEndsAt)}.
        </p>
      ) : null}

      {domain.state === 'drifted' && domain.releaseAt !== null ? (
        <p className="text-body-sm text-subdued">
          Released on {formatted(domain.releaseAt)} unless the records are restored.
        </p>
      ) : null}

      {domain.failureReason === null ? null : (
        <p className="text-body-sm text-danger">{DOMAIN_FAILURE_COPY[domain.failureReason]}</p>
      )}

      {caa?.verdict === 'blocked' ? (
        <p className="text-body-sm text-subdued">
          The CAA record on <code className="font-mono">{caa.zone}</code> is{' '}
          <code className="font-mono break-all">{caa.record}</code>.
        </p>
      ) : null}

      {domain.check?.message == null ? null : (
        <p className="text-body-sm text-subdued">The provider said: “{domain.check.message}”</p>
      )}

      {domain.check === null ? null : (
        <p className="text-caption text-faint">Last checked {formatted(domain.check.at)}</p>
      )}

      {domain.state === 'removing' || domain.records.length === 0 ? null : (
        <RecordTable records={domain.records} />
      )}

      {canManage && domain.state === 'pending' ? (
        <CloudflareOfferBlock domainId={domain.id} name={name} orgId={orgId} />
      ) : null}

      {error === undefined ? null : <p className="text-body-sm text-danger">{error}</p>}

      {canManage && domain.state !== 'removing' ? (
        <div className="flex flex-wrap gap-2">
          {domain.state === 'pending' || domain.state === 'drifted' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Check ${name} now`}
              onClick={onCheck}
            >
              Check now
            </Button>
          ) : null}
          {domain.state === 'failed' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Retry ${name}`}
              onClick={onRetry}
            >
              Retry
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" aria-label={`Remove ${name}`} onClick={onRemove}>
            Remove
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** What the offer's refusal reasons mean beside the manual step (spec 030 FR-010, FR-011). */
const CLOUDFLARE_FALLBACK_COPY = {
  'needs-reauth':
    'Reconnect Cloudflare in Connectors to write these records, or create them by hand.',
  'zone-not-found':
    'No zone your Cloudflare token can see holds this domain. Create the records by hand.',
} as const;

/** Spec 030 US6 (SC-007): Cloudflare not answering, or its circuit open. */
export const CLOUDFLARE_UNAVAILABLE_COPY =
  'Cloudflare is not answering right now. Create the records by hand, or try again shortly.';

function isProviderUnavailable(error: Error | null): boolean {
  if (!ApiProblem.is(error)) return false;

  return (error.detail as Record<string, unknown> | undefined)?.reason === 'provider-unavailable';
}

type DnsConflict = NonNullable<CloudflareOffer['conflict']>;

/** A write refused `409 record-conflict` names the record it found (contracts/bindings.md § 3). */
function refusedConflict(error: Error | null): DnsConflict | undefined {
  if (!ApiProblem.is(error, 'conflict')) return undefined;

  const extensions = error.detail as Record<string, unknown> | undefined;
  const record = extensions?.record as Partial<DnsConflict> | undefined;

  if (extensions?.reason !== 'record-conflict' || typeof record?.name !== 'string') {
    return undefined;
  }

  return { content: record.content ?? '', name: record.name, type: record.type ?? '' };
}

/**
 * Spec 030 US2: "Write with Cloudflare" beside the manual records, for a pending domain whose zone
 * the organisation's Cloudflare token can edit. The write asks for a recent second factor; a
 * `step-up-required` answer opens the dialog and the write is retried once. A different record
 * already at a name is named, and the manual step stays the way forward.
 */
function CloudflareOfferBlock({
  domainId,
  name,
  orgId,
}: {
  readonly domainId: string;
  readonly name: string;
  readonly orgId: string | undefined;
}): React.JSX.Element | null {
  const write = useWriteWithCloudflare(orgId, domainId);
  const offer = useCloudflareOffer(orgId, domainId, {
    enabled: true,
    writing: write.isSuccess,
  });
  const [steppingUp, setSteppingUp] = useState(false);

  const data = offer.data;

  // Spec 030 US6: the circuit is open (or Cloudflare is down) — say so beside the manual step.
  if (data === undefined && isProviderUnavailable(offer.error)) {
    return <p className="text-body-sm text-subdued">{CLOUDFLARE_UNAVAILABLE_COPY}</p>;
  }

  if (data === undefined || data.status === 'not-connected') return null;

  if (data.status === 'written') {
    return <p className="text-body-sm text-subdued">Records written by Cloudflare.</p>;
  }

  if (data.status !== 'writable') {
    return <p className="text-body-sm text-subdued">{CLOUDFLARE_FALLBACK_COPY[data.status]}</p>;
  }

  const refused =
    write.error !== null && !ApiProblem.is(write.error, 'step-up-required') ? write.error : null;
  const conflict = data.conflict ?? refusedConflict(refused);

  if (conflict !== undefined) {
    return (
      <p className="text-body-sm text-subdued">
        Cloudflare already has a different {conflict.type} record at{' '}
        <code className="font-mono break-all">{conflict.name}</code>
        {conflict.content === '' ? null : (
          <>
            {' '}
            (<code className="font-mono break-all">{conflict.content}</code>)
          </>
        )}
        . It is not overwritten: create the records by hand, or change that record first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {write.isSuccess ? (
        <p className="text-body-sm text-subdued" role="status">
          Writing the records with Cloudflare…
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={write.isPending}
            aria-label={`Write ${name} records with Cloudflare`}
            onClick={() => {
              write.mutate(undefined, {
                onError: (failure) => {
                  if (ApiProblem.is(failure, 'step-up-required')) setSteppingUp(true);
                },
              });
            }}
          >
            Write with Cloudflare
          </Button>
          <span className="text-body-sm text-subdued">
            In your zone <code className="font-mono">{data.zone?.name}</code>, or create them by
            hand.
          </span>
        </div>
      )}
      {refused === null ? null : (
        <p className="text-body-sm text-danger">{domainErrorCopy(refused)}</p>
      )}
      <StepUpDialog
        open={steppingUp}
        description="Writing DNS records needs a recent second factor. Enter the code from your authenticator app to continue."
        onOpenChange={setSteppingUp}
        onSteppedUp={() => {
          setSteppingUp(false);
          // One retry, not a loop: a second refusal renders as the error it is.
          write.mutate();
        }}
      />
    </div>
  );
}

function RecordTable({
  records,
}: {
  readonly records: readonly DomainRecord[];
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="text-body-sm w-full border-collapse" aria-label="DNS records">
        <thead>
          <tr className="text-subdued text-left">
            <th scope="col" className="py-1 pr-2 font-medium">
              Type
            </th>
            <th scope="col" className="py-1 pr-2 font-medium">
              Name
            </th>
            <th scope="col" className="py-1 pr-2 font-medium">
              Value
            </th>
            <th scope="col" className="py-1 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const purpose = DOMAIN_RECORD_PURPOSE_COPY[record.purpose];

            return (
              <tr key={record.purpose} className="border-line-subtle border-t align-top">
                <td className="py-1.5 pr-2">{record.type}</td>
                <td className="py-1.5 pr-2">
                  <CopyableValue label={`Copy the ${purpose} name`} value={record.name} />
                </td>
                <td className="py-1.5 pr-2">
                  <CopyableValue label={`Copy the ${purpose} value`} value={record.value} />
                </td>
                <td className="text-subdued py-1.5">{DOMAIN_RECORD_STATUS_COPY[record.status]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CopyableValue({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <span className="flex items-start gap-1.5">
      <code className="min-w-0 font-mono break-all">{value}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value).catch(() => undefined);
        }}
        className="text-subdued hover:text-foreground mt-0.5 shrink-0 rounded-sm transition-colors"
      >
        <CopyIcon className="size-3.5" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </button>
    </span>
  );
}
