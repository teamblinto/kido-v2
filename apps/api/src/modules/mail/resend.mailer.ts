import { Logger } from '@nestjs/common';

import {
  type MailDelivery,
  type MailFailureReason,
  type MailMessage,
  type MailerPort,
  mailFailed,
  mailSent,
} from './mailer.port';

/** Resend's transactional send endpoint. The only URL this adapter ever calls. */
export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Bounded, and short.
 *
 * This send sits on the signup request path until the §10 `mail` queue exists, so the timeout is
 * part of how long a user waits to see "check your email". It can afford to be short because the
 * failure is not fatal: a timed-out send is classified `unavailable`, audited, and retryable, so
 * waiting longer only buys a slightly better chance of avoiding a retry we are set up to do anyway.
 */
const REQUEST_TIMEOUT_MS = 5_000;

/** Just enough of a `fetch` response for this adapter, so no DOM lib is pulled into the API's types. */
export interface ResendResponse {
  json(): Promise<unknown>;
  readonly ok: boolean;
  readonly status: number;
}

export type ResendFetch = (
  url: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: string;
    signal?: AbortSignal;
  },
) => Promise<ResendResponse>;

export interface ResendMailerOptions {
  readonly apiKey: string;
  /** Injected in tests; production uses the platform `fetch`. No HTTP dependency is added. */
  readonly fetch?: ResendFetch;
  readonly from: string;
}

const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;
const UNPROCESSABLE = 422;

/**
 * A transport status, as one of our reasons.
 *
 * §10's rule decides the retryable half — "only timeouts, 5xx and 429 are retried" — and the
 * terminal half is split only where the *response* differs: 401 and 403 mean our key or our sender
 * identity is wrong, which an operator fixes and a retry cannot; 422 is Resend's status for a
 * rejected `to` field, which means this address will never accept this mail. Everything else in the
 * 4xx range is one terminal class, because inventing distinctions we cannot act on differently is
 * how a classification stops being read.
 */
function reasonFor(status: number): MailFailureReason {
  if (status === TOO_MANY_REQUESTS || status >= SERVER_ERROR) {
    return status === TOO_MANY_REQUESTS ? 'throttled' : 'unavailable';
  }

  if (status === 401 || status === 403) {
    return 'not-configured';
  }

  return status === UNPROCESSABLE ? 'invalid-recipient' : 'rejected';
}

/**
 * Resend over the platform `fetch` (spec 001: no HTTP client dependency is added).
 *
 * ## Nothing the vendor says comes back out
 *
 * §05 is explicit: "provider errors are classified and re-stated rather than passed through. A
 * provider's error body frequently echoes part of the request … so forwarding it verbatim into our
 * UI, our logs and our error tracker moves tenant content into three systems that were never scoped
 * to hold it." A Resend 4xx body quotes the offending field, which for us is a recipient address or
 * a subject, and its `Invalid \`to\` field` messages have been known to echo the request.
 *
 * So the body of a failed response is **never read** — not read and discarded, not read and
 * truncated, not read for a log. The status is the whole of what crosses back, and it becomes one
 * of our reasons. That also keeps our integration shape — which vendor, which field names, which
 * error vocabulary — out of anything we might one day hand to a user.
 *
 * A thrown transport error is treated the same way: its message can carry the URL, the resolved
 * address and occasionally a header, so it is counted and dropped rather than re-stated.
 *
 * ## It does not throw
 *
 * Every failure resolves as `{ outcome: 'failed' }`. See {@link MailDelivery} and ADR 004: a mail
 * failure must not roll back the account creation it accompanies, and the way to guarantee that is
 * for there to be nothing to catch.
 */
export class ResendMailer implements MailerPort {
  private readonly apiKey: string;
  private readonly fetch: ResendFetch | undefined;
  private readonly from: string;
  private readonly logger = new Logger(ResendMailer.name);

  constructor(options: ResendMailerOptions) {
    this.apiKey = options.apiKey;
    this.fetch = options.fetch;
    this.from = options.from;
  }

  async send(message: MailMessage): Promise<MailDelivery> {
    // Resolved per call rather than in the constructor so a test can replace the global, and so
    // construction never depends on a global existing yet.
    const send = this.fetch ?? ((url, init) => globalThis.fetch(url, init));
    let response: ResendResponse;

    try {
      response = await send(RESEND_ENDPOINT, {
        body: JSON.stringify({
          from: this.from,
          html: message.html,
          subject: message.subject,
          text: message.text,
          to: message.to,
        }),
        headers: {
          // A bearer credential in a query string is written to every proxy access log in between.
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The thrown error is deliberately not inspected, not logged and not re-stated: a `fetch`
      // rejection message carries the URL and the resolved address, and an `AbortError` adds
      // nothing a timeout does not already say.
      return this.failed(message, 'unavailable', 'Resend did not respond before the timeout.');
    }

    if (!response.ok) {
      return this.failed(
        message,
        reasonFor(response.status),
        `Resend answered with status ${response.status}.`,
        response.status,
      );
    }

    return mailSent(await providerMessageId(response));
  }

  /**
   * One log line per failure, carrying the template and the classification and nothing else.
   *
   * Not the recipient: whether an address appears in a log is the caller's decision, made where the
   * enumeration-safety rules are known, not this adapter's. Not the subject, the body, or the link.
   */
  private failed(
    message: MailMessage,
    reason: MailFailureReason,
    detail: string,
    status?: number,
  ): MailDelivery {
    const delivery = mailFailed(reason, detail, status);

    this.logger.warn(
      `mail not delivered: template=${message.template} reason=${reason} status=${status ?? 'none'}`,
    );

    return delivery;
  }
}

/**
 * The id Resend assigns, for the audit trail.
 *
 * Absent or unreadable is not a failure: the mail was accepted, and answering `failed` because we
 * could not parse the receipt would have the caller retry a message that already went out.
 */
async function providerMessageId(response: ResendResponse): Promise<string | undefined> {
  try {
    const payload = (await response.json()) as { id?: unknown } | null;

    return typeof payload?.id === 'string' ? payload.id : undefined;
  } catch {
    return undefined;
  }
}
