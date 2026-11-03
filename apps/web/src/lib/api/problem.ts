import {
  type ProblemDetail,
  type ProjectAccessConflictReason,
  type RunLineConflictReason,
  type ProblemTypeSlug,
  problemDetailSchema,
  problemTypeSlugFromUri,
} from '@repo/contracts';

/**
 * A failure the API described, as the client throws it.
 *
 * The whole reason `PROBLEM_TYPE_SLUGS` is a closed vocabulary is that a client branches on the
 * class of failure rather than on prose, so {@link slug} is the field callers read and
 * {@link ApiProblem.message} exists for the console. A `type` this build of the contract does not
 * know leaves `slug` as `undefined` — `problemTypeSlugFromUri` returns nothing for an unrecognised
 * URI precisely so a client meeting a newer server degrades to its generic branch instead of
 * throwing inside its error handler.
 */
export class ApiProblem extends Error {
  readonly detail: ProblemDetail | undefined;
  readonly slug: ProblemTypeSlug | undefined;
  readonly status: number;

  constructor(status: number, detail: ProblemDetail | undefined) {
    super(detail?.detail ?? `The request failed with status ${String(status)}.`);
    this.detail = detail;
    this.name = 'ApiProblem';
    this.slug = detail === undefined ? undefined : problemTypeSlugFromUri(detail.type);
    this.status = status;
  }

  /** Narrowing helper, so a `catch` block reads as a decision rather than a cast. */
  static is(error: unknown, slug?: ProblemTypeSlug): error is ApiProblem {
    return error instanceof ApiProblem && (slug === undefined || error.slug === slug);
  }

  /**
   * The rejected fields, keyed by the last segment of their JSON pointer.
   *
   * `validation-failed` carries RFC 9457's `errors` extension — a `pointer` naming the location and
   * a `detail` for a human — and a form renders those beside the inputs they belong to. Anything
   * without a usable pointer is dropped rather than guessed at, because attaching a message to the
   * wrong field is worse than showing it only in the summary.
   */
  fieldErrors(): Readonly<Record<string, string>> {
    const errors: Record<string, string> = {};

    for (const issue of this.detail?.errors ?? []) {
      const field = issue.pointer.split('/').filter(Boolean).at(-1);

      if (field !== undefined && !(field in errors)) {
        errors[field] = issue.detail;
      }
    }

    return errors;
  }
}

/** A network failure, a CORS refusal, or an abort — no response, so nothing to parse. */
export class ApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super('The service could not be reached. Check your connection and try again.', { cause });
    this.name = 'ApiUnreachableError';
  }
}

/**
 * Parse an error response body, tolerating one that is not a problem document at all.
 *
 * A 502 from a proxy in front of the API is an HTML page, and a client that threw a `SyntaxError`
 * while handling it would replace a message the user can act on with one nobody can. So a body that
 * does not parse simply yields `undefined`, and {@link ApiProblem} falls back to its status.
 */
export async function readProblem(response: Response): Promise<ProblemDetail | undefined> {
  try {
    const parsed = problemDetailSchema.safeParse(await response.json());

    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What to show a person for each failure the API can report.
 *
 * One table rather than a string at each call site, because the closed vocabulary only pays for
 * itself if the client's reaction is decided once. Three of the entries below exist purely so a
 * user can tell apart failures that a bare "forbidden" would flatten: `permission-denied` means
 * stop and ask an administrator, `step-up-required` means prove yourself again, and
 * `csrf-check-failed` means retry — opposite remedies behind one status code.
 *
 * Screens still override where they know better. A sign-in page says something specific about
 * `unauthorized`; everywhere else that slug means the session ended.
 */
const MESSAGES: Readonly<Record<ProblemTypeSlug, string>> = {
  'bad-gateway': 'The service is temporarily unavailable. Please try again shortly.',
  'bad-request': 'That request could not be understood. Please check what you entered.',
  conflict: 'That conflicts with something that already exists.',
  'csrf-check-failed': 'Your session check expired. Please try again.',
  'current-password-incorrect': 'That password is incorrect.',
  'email-not-verified': 'Confirm your email address before you can do this.',
  forbidden: 'You do not have access to this.',
  'gateway-timeout': 'The service took too long to respond. Please try again shortly.',
  gone: 'That is no longer available.',
  'idempotency-key-in-flight': 'That is still being processed. Give it a moment and try again.',
  'idempotency-key-reused': 'That request was already sent. Start again to make a new one.',
  'import-branch-not-found':
    'That branch no longer exists on the repository. Choose another branch and try again.',
  'import-empty-repo':
    'That repository has no commits yet. Push something to it first, then import it.',
  'import-repo-too-large': 'That repository is too large to import.',
  'internal-server-error': 'Something went wrong on our side. Please try again.',
  'local-agent-offline':
    'Your computer is not connected. Run baios-companion start on it, then try again.',
  'local-agent-pairing-invalid':
    'That pairing code is not valid or has expired. Run baios-companion pair again for a new one.',
  'local-agent-provider-unavailable':
    'That agent is not ready on your computer. Check it is installed and signed in, then try again.',
  'local-agent-revoked': 'That computer was disconnected. Pair it again to use it.',
  'local-agent-workspace-unknown':
    'Your computer does not have that workspace any more. Add it again with baios-companion workspace add.',
  'method-not-allowed': 'That action is not available here.',
  'mfa-code-incorrect': 'That code is incorrect. Check your authenticator app and try again.',
  'not-acceptable': 'That response format is not supported.',
  'not-found': 'We could not find that.',
  'not-implemented': 'That is not available yet.',
  'oauth-account-already-linked':
    'That account is already connected to a different sign-in. Use the original account, or disconnect it first.',
  'oauth-authorization-denied': 'The sign-in was cancelled. Try again when you are ready.',
  'oauth-email-unverified':
    'Your provider has not verified that email address. Verify it with them, then try again.',
  'oauth-exchange-failed': 'That sign-in could not be completed. Please try again.',
  'oauth-provider-not-configured': 'That sign-in method is not available on this deployment.',
  'oauth-state-invalid': 'That sign-in took too long. Please start again.',
  'password-breached':
    'This password has appeared in a data breach. Choose a different one — it was checked without ever being sent.',
  'password-too-weak': 'That password is too easy to guess. Try three unrelated words.',
  'password-uses-personal-information':
    'That password contains your own details. Choose something unrelated to your account.',
  'payload-too-large': 'That is too large to send.',
  'permission-denied': 'You do not have permission to do this. Ask an administrator for access.',
  'rate-limited': 'Too many attempts. Please wait a moment and try again.',
  'request-timeout': 'That request took too long. Please try again.',
  'service-unavailable': 'The service is temporarily unavailable. Please try again shortly.',
  'step-up-required': 'Confirm it is you before making this change.',
  'subscription-not-connected': 'Connect your Claude subscription in Settings.',
  'subscription-unavailable':
    'Running on your own Claude subscription is not available right now. Try again later.',
  'token-already-used': 'That link has already been used. Request a new one.',
  'token-expired': 'That link has expired. Request a new one.',
  'token-invalid': 'That link is not valid. Check you copied the whole address.',
  'turnstile-check-failed': 'The security check did not pass. Please complete it again.',
  unauthorized: 'Your session has ended. Please sign in again.',
  'unsupported-media-type': 'That format is not supported.',
  'validation-failed': 'Please check the highlighted fields and try again.',
  'verification-address-changed':
    'That link was replaced when the address changed. Check your newest email for the current one.',
};

/**
 * Refusal `reason`s whose sentence beats the slug's (spec 031, contracts/run-line.md § 1 and
 * contracts/sharing.md § 5). Keyed by the contracts' closed enums, so a reason without a sentence
 * fails `typecheck`; a reason this build does not know falls through to the slug's sentence.
 */
const REASON_MESSAGES: Readonly<
  Record<ProjectAccessConflictReason | RunLineConflictReason, string>
> = {
  'last-owner': 'A project needs at least one owner. Make someone else an owner first.',
  'queue-full': 'Five runs are already waiting on this project. Try again when one has started.',
};

const isKnownReason = (reason: unknown): reason is keyof typeof REASON_MESSAGES =>
  typeof reason === 'string' && Object.hasOwn(REASON_MESSAGES, reason);

/** The sentence to show for a thrown error, whatever kind it turns out to be. */
export function messageFor(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (error instanceof ApiUnreachableError) {
    return error.message;
  }

  if (!(error instanceof ApiProblem)) {
    return fallback;
  }

  const reason = error.detail?.reason;

  if (isKnownReason(reason)) {
    return REASON_MESSAGES[reason];
  }

  return error.slug === undefined ? fallback : MESSAGES[error.slug];
}
