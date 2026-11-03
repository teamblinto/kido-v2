/**
 * Every mail the platform sends, as a closed catalogue.
 *
 * A rendered message carries its template id for two reasons. §10 will deduplicate the `mail` queue
 * "by template plus recipient plus hour", and that key has to be derivable from the job payload
 * without re-rendering the body — which is also §10's rule that payloads carry ids, not contents.
 * And it gives the console adapter, the fake and every test an identity to assert on that is not a
 * subject line somebody will reword.
 *
 * Closed, so a task that adds a mail adds it here and every exhaustive switch over the set stops
 * compiling until it is handled — the same discipline `problem-types.ts` applies to error slugs.
 */
export const MAIL_TEMPLATE_IDS = Object.freeze([
  'account-exists',
  // Spec 032: a linked subscription needs reconnecting, or its provider was withdrawn (§ 6).
  'byos-account',
  // Spec 028: the four custom-domain notices, rendered from `mail.domain` (US3, US4).
  'domain-drifted',
  'domain-failed',
  'domain-release-warning',
  'domain-released',
  'email-verification',
  'invitation',
  'password-reset',
  // Spec 031: an invitation to one project (contracts/sharing.md § 7).
  'project-invitation',
  // Spec 029: an endpoint paused after 24 h of failures, rendered from `mail.webhook` (US3).
  'webhook-paused',
] as const);

export type MailTemplateId = (typeof MAIL_TEMPLATE_IDS)[number];

/**
 * A message that has already been rendered, ready for a transport to carry.
 *
 * There is deliberately no `from`: it comes from `MAIL_FROM` and is bound by the adapter, so no
 * call site can send as an address the deployment has not been configured to send as. There is
 * deliberately no `cc`, `bcc` or array of recipients either — every mail in spec 001 goes to one
 * person, and a multi-recipient transactional mail is how one tenant's address ends up visible to
 * another's.
 *
 * Both body parts are required. HTML-only transactional mail is a deliverability problem, and the
 * console adapter reads its clickable link out of the text part.
 */
export interface MailMessage {
  readonly html: string;
  readonly subject: string;
  readonly template: MailTemplateId;
  readonly text: string;
  /** One address. Never a display name — a rendered `Name <addr>` is a header-injection surface. */
  readonly to: string;
}

/**
 * Why a send did not happen, in our vocabulary rather than a vendor's.
 *
 * §05 is explicit that provider errors are classified and re-stated, never passed through: a
 * provider's error body frequently echoes part of the request, so forwarding it verbatim moves
 * tenant content into our logs, our error tracker and our UI at once. It also pins our integration
 * shape — which vendor, which endpoint, which field name — into a document we may hand to a user.
 *
 * The set is small on purpose. It is the set of *distinct responses*: retry later, fix the address,
 * page an operator. A reason nobody would act on differently does not earn an entry.
 */
export const MAIL_FAILURE_REASONS = Object.freeze([
  /** The address itself was refused. Retrying delivers it to the same address. */
  'invalid-recipient',
  /** Our credentials or sender identity are wrong. An operator fixes this; a retry cannot. */
  'not-configured',
  /** The provider refused this message for a reason that will not change on a retry. */
  'rejected',
  /** We are over a rate limit. The same message will succeed later. */
  'throttled',
  /** Nothing answered, or something answered 5xx. Transient by assumption. */
  'unavailable',
] as const);

export type MailFailureReason = (typeof MAIL_FAILURE_REASONS)[number];

/**
 * §10's retry rule, applied once here rather than per adapter.
 *
 * "Classify before retrying. A 4xx from a connector, a validation error or a permission denial is
 * terminal — retrying it eight times over a day burns quota and delays the user's error message.
 * Only timeouts, 5xx and 429 are retried."
 *
 * Deriving the flag centrally is what stops two adapters disagreeing about whether a throttle is
 * worth retrying, and it is the table the future `mail` queue will read to decide.
 */
const RETRYABLE: Readonly<Record<MailFailureReason, boolean>> = Object.freeze({
  'invalid-recipient': false,
  'not-configured': false,
  rejected: false,
  throttled: true,
  unavailable: true,
});

export interface MailFailure {
  /** Our own words. Never a response body, never a vendor message, never the recipient's token. */
  readonly detail: string;
  readonly reason: MailFailureReason;
  readonly retryable: boolean;
  /**
   * The transport status, when there was a response at all.
   *
   * A bare HTTP status is not vendor internals in the sense §05 forbids — it carries no request
   * echo and no message — and it is the one number that tells an operator a 403 from a 503 without
   * turning on debug logging. Same judgement `OpenBaoTransportError` makes.
   */
  readonly status: number | undefined;
}

/**
 * The outcome of a send. Note what is absent: this type has no failure that arrives as an
 * exception.
 *
 * `send` **resolves** for a failed delivery rather than rejecting, and that is the single most
 * load-bearing decision in this port (ADR 004). Mail accompanies account creation, and a mail
 * failure must not roll back the account it accompanies. If a delivery failure were thrown, a
 * caller who forgot one `try` would abort the transaction it sat in — turning a Resend outage into
 * a signup outage — and a caller who forgot one after the commit would answer the request with a
 * 500 for an account that exists, which also breaks T13's enumeration-safety.
 *
 * Resolving makes the safe thing the default thing: nothing a caller omits can roll anything back.
 * The cost is that ignoring the result silently drops a mail, which is why the type is a
 * discriminated union rather than `void` — the outcome is visible at the call site, and the caller
 * audits it (§10's classification is right here in `failure.retryable`).
 *
 * Programmer errors still throw. A message this port cannot represent is a bug, not a delivery
 * failure.
 */
export interface MailDelivered {
  readonly outcome: 'sent';
  /** The vendor's id, for the audit trail. `undefined` where there is no vendor. */
  readonly providerMessageId: string | undefined;
}

export interface MailNotDelivered {
  readonly failure: MailFailure;
  readonly outcome: 'failed';
}

export type MailDelivery = MailDelivered | MailNotDelivered;

/** A successful delivery. `providerMessageId` is omitted by adapters with nothing to report. */
export function mailSent(providerMessageId?: string): MailDelivered {
  return { outcome: 'sent', providerMessageId };
}

/**
 * A failed delivery, with the retryable flag derived rather than supplied.
 *
 * Frozen so a caller cannot relabel a terminal failure as retryable on the way to the audit row.
 */
export function mailFailed(
  reason: MailFailureReason,
  detail: string,
  status?: number,
): MailNotDelivered {
  return {
    failure: Object.freeze({ detail, reason, retryable: RETRYABLE[reason], status }),
    outcome: 'failed',
  };
}

/**
 * The injection token, beside the interface for the reason `clock.port.ts` gives. A symbol, because
 * a string token collides silently with any other package that reaches for the same word.
 */
export const MAILER = Symbol('forge.mailer');

/**
 * The one way anything in this application sends mail (spec 001, ADR 004).
 *
 * One method, and it takes an already-rendered message. Rendering lives in `templates/`, which
 * keeps every adapter a pure transport: adding a provider means writing one `send`, not learning
 * how three templates are laid out. Per-template methods (`sendVerification`, …) were rejected for
 * the same reason — they put the template catalogue inside the port, so every new mail would change
 * the interface that four other tasks are written against.
 *
 * `send` never rejects for a delivery failure; see {@link MailDelivery}. Callers branch on
 * `outcome` and audit the failure — they do not `try`.
 *
 * Mail is sent synchronously today. The §10 BullMQ `mail` queue is a later phase, and this port is
 * what makes that hand-off a one-adapter change: a `QueuedMailer` enqueues the same `MailMessage`
 * and answers `sent` for "accepted for delivery", with no call site touched. Nothing in this module
 * anticipates it further than that (ADR 004).
 */
export interface MailerPort {
  send(message: MailMessage): Promise<MailDelivery>;
}
