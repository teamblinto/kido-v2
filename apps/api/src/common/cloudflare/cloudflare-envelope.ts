import { z } from 'zod';

/**
 * The Cloudflare v4 API envelope — request, `result`, `errors` and failure mapping — shared by the
 * platform's Cloudflare for SaaS adapter (spec 028) and the DNS connector's client (spec 030
 * research R13). It knows the header, the envelope and the retry split; what a failure *is* in the
 * caller's own vocabulary is the caller's, passed in as `CloudflareFailures`, so `common/` gains no
 * edge into a module.
 *
 * No error carries the request, the response or the `fetch` rejection as its `cause`: they are not
 * inspected and not re-stated, so the API token cannot leave through one.
 */
export const cloudflareErrorsSchema = z.array(
  z.object({ code: z.number().optional(), message: z.string() }),
);

export type CloudflareErrors = z.infer<typeof cloudflareErrorsSchema>;

/** The errors each caller throws, in its own vocabulary. */
export interface CloudflareFailures {
  /** A timeout, a network error, or a refused connection: nothing answered. */
  readonly unreachable: () => Error;
  /** A `2xx` whose body this version does not understand. */
  readonly unreadable: () => Error;
  /** `429` or `5xx`. */
  readonly retryable: (status: number) => Error;
  /** Any other status, with the provider's errors. */
  readonly refused: (status: number, errors: CloudflareErrors) => Error;
}

export interface CloudflareRequest {
  readonly body?: string;
  readonly method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
}

export async function send(
  token: string,
  url: string,
  init: CloudflareRequest,
  timeoutMs: number,
  failures: Pick<CloudflareFailures, 'unreachable'>,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  try {
    return await globalThis.fetch(url, {
      body: init.body,
      headers,
      method: init.method,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Not inspected and not kept as `cause`: a `fetch` rejection quotes the URL. A timeout and
    // a refused connection are the same to a check: nothing answered.
    throw failures.unreachable();
  }
}

/** The envelope's `result`, or the caller's `unreadable` when this version does not understand it. */
export async function result<T>(
  response: Response,
  schema: z.ZodType<T>,
  failures: Pick<CloudflareFailures, 'unreadable'>,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw failures.unreadable();
  }
  const parsed = z.object({ result: schema }).safeParse(body);
  if (!parsed.success) throw failures.unreadable();
  return parsed.data.result;
}

/** The envelope's `errors`, or none when the body is not the envelope. */
export async function errors(response: Response): Promise<CloudflareErrors> {
  try {
    const parsed = z.object({ errors: cloudflareErrorsSchema }).safeParse(await response.json());
    return parsed.success ? parsed.data.errors : [];
  } catch {
    return [];
  }
}

/** `429` and `5xx` retry (the outbox's `classifyHttpStatus` rule); every other status is refused. */
export function failure(
  status: number,
  envelopeErrors: CloudflareErrors,
  failures: Pick<CloudflareFailures, 'refused' | 'retryable'>,
): Error {
  if (status === 429 || status >= 500) return failures.retryable(status);
  return failures.refused(status, envelopeErrors);
}
