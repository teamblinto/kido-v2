import {
  type WebhookAttempt,
  type WebhookDeliveryListQuery,
  type WebhookDeliveryState,
  type WebhookEventType,
  webhookDeliveryStateSchema,
  webhookEventTypeSchema,
} from '@repo/contracts';
import { Loader2 } from 'lucide-react';
import { useId, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useReplayWebhookDelivery, useWebhookDeliveries, useWebhookDelivery } from './use-webhooks';
import { WEBHOOK_FAILURE_COPY, webhookErrorCopy } from './webhook-reasons';

const STATE: Record<
  WebhookDeliveryState,
  { readonly label: string; readonly variant: 'danger' | 'muted' | 'success' | 'warning' }
> = {
  failed: { label: 'Failed', variant: 'danger' },
  not_sent: { label: 'Not sent', variant: 'muted' },
  pending: { label: 'Pending', variant: 'warning' },
  succeeded: { label: 'Succeeded', variant: 'success' },
};

const SELECT = 'border-line bg-raised text-label-sm text-subdued rounded-md border px-2 py-1';

function formatted(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * One endpoint's delivery log (spec 029 US4): newest first, filtered by state and event type,
 * 50 to a page. A delivery expands to its body and its attempts, newest first, each with the
 * status (or the failure), the response headers and the start of the response body, shown as
 * received and never interpreted. Replay is offered while the body is held.
 */
export function DeliveryLog({
  endpointId,
  orgId,
}: {
  readonly endpointId: string;
  readonly orgId: string;
}): React.JSX.Element {
  const stateId = useId();
  const typeId = useId();
  const [state, setState] = useState<WebhookDeliveryState | undefined>(undefined);
  const [eventType, setEventType] = useState<WebhookEventType | undefined>(undefined);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);
  const query: WebhookDeliveryListQuery = { cursor, eventType, state };
  const deliveries = useWebhookDeliveries(orgId, endpointId, query);

  return (
    <section aria-label="Delivery log" className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={stateId} className="text-label-sm text-subdued">
          State
        </label>
        <select
          id={stateId}
          className={SELECT}
          value={state ?? ''}
          onChange={(event) => {
            setState(
              event.target.value === ''
                ? undefined
                : webhookDeliveryStateSchema.parse(event.target.value),
            );
            setCursor(undefined);
          }}
        >
          <option value="">Any state</option>
          {webhookDeliveryStateSchema.options.map((value) => (
            <option key={value} value={value}>
              {STATE[value].label}
            </option>
          ))}
        </select>
        <label htmlFor={typeId} className="text-label-sm text-subdued">
          Event type
        </label>
        <select
          id={typeId}
          className={SELECT}
          value={eventType ?? ''}
          onChange={(event) => {
            setEventType(
              event.target.value === ''
                ? undefined
                : webhookEventTypeSchema.parse(event.target.value),
            );
            setCursor(undefined);
          }}
        >
          <option value="">Any event</option>
          {webhookEventTypeSchema.options.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      {deliveries.isLoading ? (
        <div className="flex items-center gap-2.5" role="status" aria-live="polite">
          <Loader2 className="text-subdued size-[18px] animate-spin" aria-hidden="true" />
          <span className="text-body-sm text-subdued">Loading deliveries…</span>
        </div>
      ) : null}

      {deliveries.error === null ? null : (
        <Alert variant="danger">{webhookErrorCopy(deliveries.error)}</Alert>
      )}

      {deliveries.isSuccess && deliveries.data.items.length === 0 ? (
        <p className="text-body-sm text-subdued">No deliveries in the last 30 days.</p>
      ) : null}

      {deliveries.isSuccess && deliveries.data.items.length > 0 ? (
        <ul aria-label="Deliveries" className="flex flex-col gap-2">
          {deliveries.data.items.map((delivery) => (
            <li key={delivery.id} className="border-line rounded-md border p-3">
              <button
                type="button"
                aria-expanded={open === delivery.id}
                className="flex w-full items-center justify-between gap-3 text-left"
                onClick={() => {
                  setOpen((current) => (current === delivery.id ? null : delivery.id));
                }}
              >
                <span className="font-mono text-sm">{delivery.eventType}</span>
                <span className="text-caption text-subdued">
                  {formatted(delivery.createdAt)} · {delivery.attempts} attempt(s)
                </span>
                <Badge variant={STATE[delivery.state].variant}>{STATE[delivery.state].label}</Badge>
              </button>
              {open === delivery.id ? (
                <DeliveryDetail orgId={orgId} endpointId={endpointId} deliveryId={delivery.id} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex gap-2">
        {cursor === undefined ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCursor(undefined);
            }}
          >
            Newest
          </Button>
        )}
        {deliveries.data?.nextCursor == null ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setCursor(deliveries.data?.nextCursor ?? undefined);
            }}
          >
            Older
          </Button>
        )}
      </div>
    </section>
  );
}

function DeliveryDetail({
  deliveryId,
  endpointId,
  orgId,
}: {
  readonly deliveryId: string;
  readonly endpointId: string;
  readonly orgId: string;
}): React.JSX.Element {
  const delivery = useWebhookDelivery(orgId, endpointId, deliveryId);
  const replay = useReplayWebhookDelivery(orgId, endpointId);

  if (delivery.error !== null) {
    return (
      <Alert variant="danger" className="mt-2">
        {webhookErrorCopy(delivery.error)}
      </Alert>
    );
  }
  if (delivery.data === undefined) {
    return <p className="text-body-sm text-subdued mt-2">Loading delivery…</p>;
  }

  const { attemptLog, body, state } = delivery.data;

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div>
        <p className="text-label-sm text-subdued">Body</p>
        {body === null ? (
          <p className="text-body-sm">Expired: bodies are kept for 7 days.</p>
        ) : (
          <pre className="bg-raised overflow-x-auto rounded-md p-2 text-xs whitespace-pre-wrap">
            {body}
          </pre>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={body === null || state === 'pending' || replay.isPending}
          onClick={() => {
            replay.mutate(deliveryId);
          }}
        >
          Replay
        </Button>
        {replay.isError ? <Alert variant="danger">{webhookErrorCopy(replay.error)}</Alert> : null}
      </div>

      {attemptLog.length === 0 ? (
        <p className="text-body-sm text-subdued">No attempts yet.</p>
      ) : (
        <ol aria-label="Attempts" className="flex flex-col gap-2">
          {attemptLog.map((attempt, index) => (
            <li
              key={`${attempt.attemptedAt}-${String(index)}`}
              className="border-line rounded-md border p-2"
            >
              <AttemptRow attempt={attempt} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function AttemptRow({ attempt }: { readonly attempt: WebhookAttempt }): React.JSX.Element {
  const outcome =
    attempt.status === null
      ? attempt.failure === null
        ? 'No response'
        : WEBHOOK_FAILURE_COPY[attempt.failure]
      : `HTTP ${String(attempt.status)}`;
  const headers =
    attempt.responseHeaders === null
      ? null
      : Object.entries(attempt.responseHeaders)
          .map(([name, value]) => `${name}: ${value}`)
          .join('\n');

  return (
    <>
      <p className="text-body-sm">
        {outcome} · {attempt.durationMs} ms · {formatted(attempt.attemptedAt)}
        {attempt.manual ? ' · manual' : ''}
      </p>
      {headers === null || headers === '' ? null : (
        <pre className="bg-raised mt-1 overflow-x-auto rounded-md p-2 text-xs">{headers}</pre>
      )}
      {attempt.responseBody === null ? null : (
        <pre className="bg-raised mt-1 overflow-x-auto rounded-md p-2 text-xs whitespace-pre-wrap">
          {attempt.responseBody}
        </pre>
      )}
    </>
  );
}
