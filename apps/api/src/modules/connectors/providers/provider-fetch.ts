/**
 * The request half every connector adapter shares (spec 030 research R4, factored out of 018's
 * `github-fetch.ts`): built-in `fetch`, a ten-second ceiling, `redirect: 'error'` (every host is a
 * fixed provider origin; a redirect is never followed with a credential attached), and the body of
 * a non-2xx left unread unless the caller opts in — the one provider whose error *name* decides the
 * category (Resend, R5) — and then capped at `ERROR_BODY_LIMIT` characters, never logged here.
 *
 * It never throws: the outcome is a value each adapter maps to its own categories. No arm carries
 * the `fetch` rejection, which quotes the URL.
 */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** The most of an error body an opted-in caller is handed (R4). */
export const ERROR_BODY_LIMIT = 4_096;

export interface ProviderFetchOptions {
  readonly timeoutMs?: number;
  /** Read (at most `ERROR_BODY_LIMIT` characters of) the body of a non-2xx. */
  readonly readErrorBody?: boolean;
}

export type ProviderResponse =
  | {
      readonly kind: 'ok';
      readonly status: number;
      readonly headers: Headers;
      readonly body: unknown;
    }
  | {
      readonly kind: 'status';
      readonly status: number;
      readonly headers: Headers;
      readonly errorBody?: string;
    }
  /** A 2xx whose body is not JSON. */
  | { readonly kind: 'unparseable'; readonly status: number }
  /** DNS, a refused connection, the timeout, a redirect: nothing usable answered. */
  | { readonly kind: 'unreachable' };

export async function providerFetch(
  url: string,
  init: RequestInit,
  options: ProviderFetchOptions = {},
): Promise<ProviderResponse> {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unreachable' };
  }

  if (!response.ok) {
    if (options.readErrorBody === true) {
      return {
        errorBody: await readCapped(response),
        headers: response.headers,
        kind: 'status',
        status: response.status,
      };
    }

    // Not read, not cancelled: untouched, as 018's `githubFetch` always left it.
    return { headers: response.headers, kind: 'status', status: response.status };
  }

  if (response.status === 204) {
    return { body: undefined, headers: response.headers, kind: 'ok', status: 204 };
  }

  try {
    return {
      body: await response.json(),
      headers: response.headers,
      kind: 'ok',
      status: response.status,
    };
  } catch {
    return { kind: 'unparseable', status: response.status };
  }
}

/** At most `ERROR_BODY_LIMIT` characters; the rest of the stream is cancelled, not drained. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';

  const decoder = new TextDecoder();
  let text = '';

  try {
    while (text.length < ERROR_BODY_LIMIT) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return text.slice(0, ERROR_BODY_LIMIT);
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text.slice(0, ERROR_BODY_LIMIT);
}
