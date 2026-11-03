import type { z } from 'zod';

/**
 * The runner's only network client: outbound HTTPS to `${server}/api/v1`, bearer device token,
 * RFC 9457 problem bodies on errors. A 401 means the device token was revoked or is unknown, and
 * is raised as its own error so every caller stops the same way.
 */

export const REVOKED_MESSAGE = 'BAIOS no longer accepts this runner’s device token.';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }

  /** 408, 429 and 5xx are worth retrying; any other 4xx will fail the same way again. */
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export class DeviceRevokedError extends Error {
  constructor() {
    super(REVOKED_MESSAGE);
    this.name = 'DeviceRevokedError';
  }
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * `https:`, or `http:` only on a loopback host (anywhere with `allowInsecureHttp`:
 * `BAIOS_ALLOW_INSECURE_HTTP=1`, for a local stack); returned without a trailing slash.
 */
export function normalizeServerUrl(input: string, allowInsecureHttp = false): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Not a URL: ${input}`);
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowInsecureHttp))) {
    throw new Error('The server URL must use https:// (http:// is allowed only for localhost).');
  }
  if (url.username || url.password) throw new Error('The server URL must not contain credentials.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function problemMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { detail?: unknown; title?: unknown };
    const parts = [body.title, body.detail].filter((part) => typeof part === 'string');
    if (parts.length) return `${response.status} ${parts.join(': ')}`;
  } catch {
    // not problem+json
  }
  return `${response.status} ${response.statusText}`.trim();
}

export class ApiClient {
  readonly base: string;
  private readonly token: string;

  constructor(server: string, token: string, allowInsecureHttp = false) {
    this.base = `${normalizeServerUrl(server, allowInsecureHttp)}/api/v1`;
    this.token = token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, authorization: `Bearer ${this.token}` };
  }

  private async check(response: Response): Promise<Response> {
    if (response.ok) return response;
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new DeviceRevokedError();
    }
    throw new HttpError(response.status, await problemMessage(response));
  }

  /** POST a JSON body; parses the response with `schema` when given. */
  async post<T = undefined>(
    path: string,
    body: unknown,
    schema?: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.check(
      await fetch(`${this.base}${path}`, {
        body: JSON.stringify(body),
        headers: this.headers({ accept: 'application/json', 'content-type': 'application/json' }),
        method: 'POST',
        // A redirect could carry the bearer token somewhere else; never follow one.
        redirect: 'error',
        signal,
      }),
    );
    if (!schema) {
      await response.body?.cancel().catch(() => undefined);
      return undefined as T;
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error(`Unexpected response from ${path}.`);
    return parsed.data;
  }

  /** Opens the SSE command stream; the caller reads `body`. */
  async connect(lastEventId: string, signal: AbortSignal): Promise<Response> {
    const extra: Record<string, string> = {
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
    };
    if (lastEventId) extra['last-event-id'] = lastEventId;
    return this.check(
      await fetch(`${this.base}/local-agent/connect`, {
        headers: this.headers(extra),
        redirect: 'error',
        signal,
      }),
    );
  }
}
