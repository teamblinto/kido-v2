/**
 * The one error shape a provider adapter throws (contracts/llm-provider.md, research R3).
 *
 * `message` is always the class name — no SDK error message, body or header is ever kept beyond
 * `requestId` (FR-023). `classify()` maps the SDK's error classes onto ours without importing the
 * SDK (the adapter is its only importer): it walks the prototype chain by constructor name, which
 * is the `instanceof` chain of research R3 spelled without the import.
 */

export type ProviderFailureClass =
  | 'unauthorised'
  | 'rate-limited'
  | 'overloaded'
  | 'unavailable'
  | 'timeout'
  | 'connection-lost'
  | 'rejected'
  | 'context-too-long'
  | 'malformed-response'
  | 'refused'
  | 'no-credential';

export const TRANSIENT: ReadonlySet<ProviderFailureClass> = new Set([
  'rate-limited',
  'overloaded',
  'unavailable',
  'timeout',
  'connection-lost',
  'malformed-response',
]);

export class ProviderError extends Error {
  readonly class: ProviderFailureClass;
  readonly transient: boolean;
  readonly requestId?: string;
  readonly status?: number;
  /** The service's own wait from `retry-after`, when it sent one; the executor caps it. */
  readonly retryAfterMs?: number;

  constructor(
    failureClass: ProviderFailureClass,
    options?: { requestId?: string; status?: number; retryAfterMs?: number },
  ) {
    super(failureClass);
    this.name = 'ProviderError';
    this.class = failureClass;
    this.transient = TRANSIENT.has(failureClass);
    this.requestId = options?.requestId;
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/**
 * `retry-after-ms`, else `retry-after` in seconds — the two forms the SDK's own retry reads.
 * ponytail: an HTTP-date `retry-after` needs a clock this pure function has none of and the API
 * sends seconds; it falls through to the executor's backoff. Parse it against the ClockPort if a
 * service ever sends one.
 */
function retryAfter(headers: SdkApiError['headers']): number | undefined {
  const ms = Number(headers?.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const seconds = Number(headers?.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** The one substring test R3 allows on a 400: the API's own wording for a full context window. */
const CONTEXT_WINDOW = /prompt is too long|context (?:limit|window)/i;

/** The SDK's `APIError` members read for classification; nothing else is looked at. */
interface SdkApiError {
  readonly status?: number;
  readonly headers?: { get(name: string): string | null };
  readonly type?: string | null;
  readonly message: string;
}

/** Constructor names up the prototype chain — the `instanceof` chain, SDK-import-free. */
function lineage(error: object): Set<string> {
  const names = new Set<string>();
  for (
    let proto: unknown = Object.getPrototypeOf(error);
    proto !== null;
    proto = Object.getPrototypeOf(proto)
  ) {
    names.add((proto as { constructor: { name: string } }).constructor.name);
  }
  return names;
}

/** The error and every `cause` beneath it. */
function causes(error: Error): (Error & { code?: unknown })[] {
  const chain: Error[] = [];
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) chain.push(cause);
  return chain;
}

/** R3's table, most specific first: `APIConnectionError` before `APIError`, `.type` before status. */
export function classify(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error; // already ours (`refused`, a stop we cannot read)
  if (!(error instanceof Error)) return new ProviderError('malformed-response');
  const is = lineage(error);
  if (is.has('APIConnectionTimeoutError')) return new ProviderError('timeout');
  if (is.has('APIConnectionError')) return new ProviderError('connection-lost');
  if (!is.has('APIError')) {
    // Mid-body the SDK wraps the transport's error in a bare `AnthropicError` whose cause is the
    // fetch failure: a `TimeoutError` when the transport gave up, undici's `UND_ERR_*` when the
    // socket went away — R3's "stream ended early". Anything else is a response we cannot read.
    for (const cause of causes(error)) {
      if (cause.name === 'TimeoutError') return new ProviderError('timeout');
      if (typeof cause.code === 'string' && cause.code.startsWith('UND_ERR')) {
        return new ProviderError('connection-lost');
      }
    }
    return new ProviderError('malformed-response');
  }

  const { status, headers, type, message } = error as Error & SdkApiError;
  const of = (failureClass: ProviderFailureClass) =>
    new ProviderError(failureClass, {
      requestId: headers?.get('request-id') ?? undefined,
      retryAfterMs: retryAfter(headers),
      status,
    });

  if (type === 'overloaded_error') return of('overloaded');
  if (is.has('AuthenticationError') || is.has('PermissionDeniedError')) return of('unauthorised');
  if (is.has('RateLimitError')) return of('rate-limited');
  if (is.has('InternalServerError')) return of('unavailable');
  if (is.has('BadRequestError')) {
    return of(
      type === 'invalid_request_error' && CONTEXT_WINDOW.test(message)
        ? 'context-too-long'
        : 'rejected',
    );
  }
  // 404 (model unknown to the key), 422, and any other 4xx: the request itself. An `APIError` with
  // no status is the SSE `error` event the stream carries mid-body (`api_error`): the service.
  return of(status === undefined ? 'unavailable' : 'rejected');
}
