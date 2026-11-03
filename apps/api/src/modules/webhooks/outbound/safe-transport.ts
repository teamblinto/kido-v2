/**
 * The outbound webhook transport (spec 029 research R8): resolve, check, pin, send, bounded.
 *
 * 1. Resolve the host through `WebhookResolverPort` (pinned to `DNS_RESOLVERS`). A literal IP host
 *    skips the resolver but not the check.
 * 2. Classify every answer with the injected `DestinationPolicy`, on every attempt, after
 *    resolution. None allowed → `destination-refused`, and no byte is sent.
 * 3. `https.request` (or `http.request` for an `http:` URL, which only local admits) with a
 *    `lookup` that returns exactly the approved address, so there is no second resolution;
 *    `servername` set to the host and `rejectUnauthorized: true`; `agent: false`, so no pooled
 *    socket crosses endpoints; only the contract's header set; one overall deadline.
 * 4. Read the answer: a body past 64 KB destroys the socket as `response-too-large`; the first
 *    4 KB and at most 32 headers of 1 KB each, never `set-cookie`, are kept for the log. A
 *    redirect is never followed: `request` does not follow.
 *
 * The transport never classifies an HTTP status: `classifyAttempt` does.
 *
 * Rejected alternatives:
 *
 * - Global `fetch`: it exposes no `lookup` hook, so the connection cannot be pinned to the address
 *   that was checked.
 * - An `undici` `Agent({connect})`: it could pin, but it makes `undici` a direct dependency of the
 *   api (ask-first); it is only transitive today, and the builtins already do the job.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import {
  ATTEMPT_TIMEOUT_MS,
  RESPONSE_KEEP_BYTES,
  RESPONSE_READ_LIMIT,
} from '../webhooks.constants';
import { DESTINATION_POLICY, type DestinationPolicy } from './destination';
import { WEBHOOK_RESOLVER, type WebhookResolverPort } from './resolver.port';

export const MAX_KEPT_HEADERS = 32;
export const MAX_KEPT_HEADER_BYTES = 1024;
export const WEBHOOK_USER_AGENT = 'Forge-Webhooks/1';

/** One attempt: the URL, the exact body bytes, and the four `Forge-*` values. */
export interface WebhookRequest {
  readonly url: string;
  readonly body: string;
  readonly deliveryId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly signature: string;
}

/** The transport's own failures; HTTP statuses are left to `classifyAttempt`. */
export type TransportError =
  | 'connection-failed'
  | 'destination-refused'
  | 'dns-failed'
  | 'response-too-large'
  | 'timeout'
  | 'tls-failed';

export interface TransportResult {
  /** The address connected to; null when none was chosen. */
  readonly address: string | null;
  readonly durationMs: number;
  /** The response status; null when no response head arrived. */
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  /** The first 4 KB of the response body, as UTF-8. */
  readonly body: string;
  readonly error: TransportError | null;
}

export interface SafeTransportOptions {
  /** Extra trust roots, for tests; production uses the system store. */
  readonly ca?: string | Buffer;
  readonly timeoutMs?: number;
}

export const SAFE_TRANSPORT_OPTIONS = Symbol('forge.webhooks.safe-transport-options');

interface Exchange {
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly error: TransportError | null;
}

@Injectable()
export class SafeTransport {
  private readonly ca: string | Buffer | undefined;
  private readonly timeoutMs: number;

  constructor(
    @Inject(WEBHOOK_RESOLVER) private readonly resolver: WebhookResolverPort,
    @Inject(DESTINATION_POLICY) private readonly policy: DestinationPolicy,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Optional() @Inject(SAFE_TRANSPORT_OPTIONS) options: SafeTransportOptions | null = null,
  ) {
    this.ca = options?.ca;
    this.timeoutMs = options?.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  }

  async send(request: WebhookRequest): Promise<TransportResult> {
    const started = this.clock.now().getTime();
    const finish = (address: string | null, exchange: Exchange): TransportResult => ({
      address,
      durationMs: Math.max(0, this.clock.now().getTime() - started),
      ...exchange,
    });

    const url = new URL(request.url);
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;

    let candidates: readonly string[];
    if (isIP(host) !== 0) {
      candidates = [host];
    } else {
      const resolution = await this.resolver.resolve(host);
      if (resolution.kind !== 'answer') return finish(null, failed('dns-failed'));
      candidates = resolution.addresses;
    }

    const address = candidates.find((candidate) => this.policy.isAllowedAddress(candidate));
    if (address === undefined) return finish(null, failed('destination-refused'));

    return finish(address, await this.exchange(url, host, address, request));
  }

  private exchange(
    url: URL,
    host: string,
    address: string,
    request: WebhookRequest,
  ): Promise<Exchange> {
    const secure = url.protocol === 'https:';
    const family = isIP(address);
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) {
        (
          callback as unknown as (
            error: null,
            addresses: { address: string; family: number }[],
          ) => void
        )(null, [{ address, family }]);
      } else {
        callback(null, address, family);
      }
    };
    const signal = AbortSignal.timeout(this.timeoutMs);
    const body = Buffer.from(request.body, 'utf8');

    const options: RequestOptions & {
      servername?: string;
      rejectUnauthorized?: boolean;
      ca?: string | Buffer;
    } = {
      agent: false,
      headers: {
        'content-length': String(body.length),
        'content-type': 'application/json',
        'forge-delivery-id': request.deliveryId,
        'forge-event-id': request.eventId,
        'forge-event-type': request.eventType,
        'forge-signature': request.signature,
        'user-agent': WEBHOOK_USER_AGENT,
      },
      host,
      lookup,
      method: 'POST',
      path: `${url.pathname}${url.search}`,
      port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
      signal,
    };
    if (secure) {
      options.rejectUnauthorized = true;
      if (isIP(host) === 0) options.servername = host;
      if (this.ca !== undefined) options.ca = this.ca;
    }

    return new Promise<Exchange>((resolve) => {
      let settled = false;
      let connected = false;
      let secured = !secure;
      let status: number | null = null;
      let headers: Record<string, string> = {};
      const kept: Buffer[] = [];
      let keptBytes = 0;
      let totalBytes = 0;

      const settle = (exchange: Exchange) => {
        if (settled) return;
        settled = true;
        resolve(exchange);
      };
      const current = (error: TransportError | null): Exchange => ({
        body: Buffer.concat(kept).toString('utf8'),
        error,
        headers,
        status,
      });

      const onError = () => {
        if (signal.aborted) return settle(current('timeout'));
        if (status !== null) return settle(current('connection-failed'));
        if (connected && !secured) return settle(current('tls-failed'));
        settle(current('connection-failed'));
      };

      const onResponse = (response: IncomingMessage) => {
        status = response.statusCode ?? null;
        headers = keepHeaders(response);
        response.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (keptBytes < RESPONSE_KEEP_BYTES) {
            const slice = chunk.subarray(0, RESPONSE_KEEP_BYTES - keptBytes);
            kept.push(slice);
            keptBytes += slice.length;
          }
          if (totalBytes > RESPONSE_READ_LIMIT) {
            settle(current('response-too-large'));
            outgoing.destroy();
            response.destroy();
          }
        });
        response.on('end', () => settle(current(null)));
        response.on('error', onError);
        response.on('aborted', onError);
      };

      const outgoing: ClientRequest = (secure ? httpsRequest : httpRequest)(options, onResponse);
      outgoing.on('socket', (socket) => {
        socket.once('connect', () => {
          connected = true;
        });
        socket.once('secureConnect', () => {
          secured = true;
        });
      });
      outgoing.on('error', onError);
      outgoing.end(body);
    });
  }
}

function failed(error: TransportError): Exchange {
  return { body: '', error, headers: {}, status: null };
}

/** At most 32 headers, each value cut to 1 KB, never `set-cookie`. */
function keepHeaders(response: IncomingMessage): Record<string, string> {
  const kept: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of Object.entries(response.headers)) {
    if (count >= MAX_KEPT_HEADERS) break;
    if (name === 'set-cookie' || value === undefined) continue;
    const text = Array.isArray(value) ? value.join(', ') : value;
    kept[name] = text.slice(0, MAX_KEPT_HEADER_BYTES);
    count += 1;
  }
  return kept;
}
