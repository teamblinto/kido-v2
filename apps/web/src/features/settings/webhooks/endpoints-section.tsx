import type { WebhookDeliverySummary, WebhookEndpointState } from '@repo/contracts';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DeliveryLog } from './delivery-log';
import { EndpointForm } from './endpoint-form';
import { SecretRevealDialog } from './secret-reveal-dialog';
import {
  useCreateWebhookEndpoint,
  useRotateWebhookSecret,
  useSendWebhookTest,
  useUpdateWebhookEndpoint,
  useWebhookEndpoints,
} from './use-webhooks';
import { WEBHOOK_FAILURE_COPY, webhookErrorCopy } from './webhook-reasons';

const STATE: Record<
  WebhookEndpointState,
  { readonly label: string; readonly variant: 'muted' | 'success' | 'warning' }
> = {
  disabled: { label: 'Disabled', variant: 'muted' },
  enabled: { label: 'Enabled', variant: 'success' },
  paused: { label: 'Paused', variant: 'warning' },
};

function formatted(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * The organisation's webhook endpoints (spec 029 US1): list, add, and send a test. A paused or
 * disabled endpoint (US3) offers "Enable"; a paused one says when it paused and why. Each endpoint
 * opens its delivery log (US4), and can rotate its secret, the new one shown once in the same
 * dialog as create's; while the old one still signs, the list says until when (US5).
 */
export function EndpointsSection({ orgId }: { readonly orgId: string }): React.JSX.Element {
  const endpoints = useWebhookEndpoints(orgId);
  const create = useCreateWebhookEndpoint(orgId);
  const test = useSendWebhookTest(orgId);
  const update = useUpdateWebhookEndpoint(orgId);
  const rotate = useRotateWebhookSecret(orgId);
  const [expireOld, setExpireOld] = useState<Readonly<Record<string, boolean>>>({});
  const [secret, setSecret] = useState<string | null>(null);
  const [tests, setTests] = useState<Readonly<Record<string, WebhookDeliverySummary>>>({});
  const [logOf, setLogOf] = useState<string | null>(null);

  return (
    <>
      {endpoints.isLoading ? (
        <div className="mt-6 flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading endpoints…</span>
        </div>
      ) : null}

      {endpoints.error === null ? null : (
        <Alert variant="danger" className="mt-6">
          {webhookErrorCopy(endpoints.error)}
        </Alert>
      )}

      {endpoints.isSuccess && endpoints.data.length === 0 ? (
        <p className="text-body-sm text-subdued mt-6">No endpoints yet.</p>
      ) : null}

      {endpoints.isSuccess && endpoints.data.length > 0 ? (
        <ul className="mt-6 flex flex-col gap-3">
          {endpoints.data.map((endpoint) => {
            const sent = tests[endpoint.id];
            const testError =
              test.isError && test.variables === endpoint.id ? webhookErrorCopy(test.error) : null;
            const enableError =
              update.isError && update.variables.id === endpoint.id
                ? webhookErrorCopy(update.error)
                : null;
            const rotateError =
              rotate.isError && rotate.variables.id === endpoint.id
                ? webhookErrorCopy(rotate.error)
                : null;

            return (
              <li key={endpoint.id} className="border-line rounded-lg border p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{endpoint.url}</p>
                    {endpoint.description === '' ? null : (
                      <p className="text-body-sm text-subdued">{endpoint.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={STATE[endpoint.state].variant}>
                      {STATE[endpoint.state].label}
                    </Badge>
                    {endpoint.state === 'enabled' ? null : (
                      <Button
                        size="sm"
                        disabled={update.isPending}
                        onClick={() => {
                          update.mutate({ body: { enabled: true }, id: endpoint.id });
                        }}
                      >
                        Enable
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={test.isPending}
                      onClick={() => {
                        test.mutate(endpoint.id, {
                          onSuccess: (delivery) => {
                            setTests((current) => ({ ...current, [endpoint.id]: delivery }));
                          },
                        });
                      }}
                    >
                      Send test
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-expanded={logOf === endpoint.id}
                      onClick={() => {
                        setLogOf((current) => (current === endpoint.id ? null : endpoint.id));
                      }}
                    >
                      Deliveries
                    </Button>
                  </div>
                </div>
                <p className="text-caption text-subdued mt-2">{endpoint.eventTypes.join(', ')}</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rotate.isPending}
                    onClick={() => {
                      rotate.mutate(
                        { body: { expireOld: expireOld[endpoint.id] ?? false }, id: endpoint.id },
                        {
                          onSuccess: (response) => {
                            setSecret(response.secret);
                          },
                        },
                      );
                    }}
                  >
                    Rotate secret
                  </Button>
                  <label className="text-body-sm flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={expireOld[endpoint.id] ?? false}
                      onChange={(event) => {
                        const { checked } = event.target;
                        setExpireOld((current) => ({ ...current, [endpoint.id]: checked }));
                      }}
                    />
                    Expire the old secret now
                  </label>
                </div>
                {endpoint.secretRotation === null ? null : (
                  <p className="text-body-sm mt-2">
                    The old secret also signs until{' '}
                    {formatted(endpoint.secretRotation.previousExpiresAt)}.
                  </p>
                )}
                {rotateError === null ? null : (
                  <Alert variant="danger" className="mt-2">
                    {rotateError}
                  </Alert>
                )}
                {endpoint.state === 'paused' && endpoint.pausedAt !== null ? (
                  <p className="text-body-sm mt-2">
                    Paused since {formatted(endpoint.pausedAt)} after 24 hours of failed deliveries.
                    {endpoint.lastFailure === null
                      ? null
                      : ` ${WEBHOOK_FAILURE_COPY[endpoint.lastFailure]}`}
                  </p>
                ) : null}
                {enableError === null ? null : (
                  <Alert variant="danger" className="mt-2">
                    {enableError}
                  </Alert>
                )}
                {sent === undefined ? null : (
                  <p className="text-body-sm mt-2" role="status">
                    Test {sent.eventType} delivery: {sent.state}
                  </p>
                )}
                {testError === null ? null : (
                  <Alert variant="danger" className="mt-2">
                    {testError}
                  </Alert>
                )}
                {logOf === endpoint.id ? (
                  <DeliveryLog orgId={orgId} endpointId={endpoint.id} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <EndpointForm
        orgId={orgId}
        busy={create.isPending}
        error={create.isError ? webhookErrorCopy(create.error) : null}
        onSubmit={(body) => {
          create.mutate(body, {
            onSuccess: (response) => {
              setSecret(response.secret);
            },
          });
        }}
      />

      <SecretRevealDialog
        secret={secret}
        onClose={() => {
          setSecret(null);
        }}
      />
    </>
  );
}
