import type { CanActivate, ExecutionContext, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DomainError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';

/**
 * Cloudflare's siteverify endpoint. A constant rather than configuration for the reason
 * `PROBLEM_TYPE_BASE_URI` is one: two deployments of the same code must not verify against
 * different oracles, and an operator who could point this somewhere else could point it at
 * something that always answers `success: true`.
 */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Where the widget's token is read from.
 *
 * A header rather than a body field, and that is not a stylistic choice. Every request body on
 * these two routes is a `strictObject` published by `@repo/contracts` (ADR 010) — `signupRequestSchema`
 * rejects an unknown key rather than dropping it — so a `cf-turnstile-response` member would have to
 * be added to the *contract* of signup and of password reset, in a package the web app shares, to
 * carry something that is not part of either request. It would also have to be optional there,
 * because this guard is inert when unconfigured, which is a contract that documents a required field
 * as optional and then enforces it out of band.
 *
 * A header keeps the anti-automation token beside the other transport-level credentials — the
 * session cookie and the CSRF header — where it belongs, and leaves both schemas describing only
 * what signup and reset actually are. The name is Cloudflare's own field name, so the widget's
 * output is copied across unrenamed.
 */
export const TURNSTILE_TOKEN_HEADER = 'cf-turnstile-response';

/**
 * Short, because this sits in front of a human waiting on a form. Cloudflare's own guidance is that
 * siteverify answers in tens of milliseconds; three seconds is long enough that a slow path still
 * completes and short enough that an unreachable verifier is reported rather than endured.
 */
const REQUEST_TIMEOUT_MS = 3_000;

/**
 * Long enough for a real token — Cloudflare's are a few hundred characters — and bounded so this
 * header is not a way to push kilobytes through `fetch` to a third party one unauthenticated
 * request at a time, on the two routes that have no session to rate-limit against.
 */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;

/** One sentence, and it names the remedy. It never quotes the token back. */
const REJECTION = 'The anti-automation check did not pass. Please complete it again and resend.';

/** Same shape: what the caller should do, with no detail about which upstream failed or how. */
const UNAVAILABLE = 'The anti-automation check could not be completed. Please try again shortly.';

/**
 * The token was absent, malformed, or refused by Cloudflare (§03).
 *
 * One error for all of those, deliberately. `problem-detail.ts` argues it at length: distinguishing
 * "you sent no token" from "your token had expired" from "that token was minted for another site"
 * tells an automated caller which half to work on, and a human's remedy is identical in all three.
 */
export class TurnstileCheckFailedError extends DomainError {
  constructor() {
    super('turnstile-check-failed', REJECTION);
  }
}

/**
 * Siteverify could not be reached, or did not answer usefully.
 *
 * **This refuses the request.** It is the one decision in this file with a defensible alternative,
 * so here is the argument. `HibpAdapter` fails *open* under ADR 008 because the breach check is
 * advisory — a breached password that slips through an outage is caught at the next password change,
 * and the zxcvbn floor and Argon2id still apply. Nothing analogous is true here: Turnstile is the
 * only thing standing between an automated caller and the two endpoints in this codebase that send
 * mail to an address nobody has proved they own. A verifier that fails open is an amplifier that
 * turns on the moment somebody makes it unreachable, and "make the verifier unreachable" is a
 * cheaper attack than solving the challenge.
 *
 * The usual objection to failing closed — that it converts a third party's outage into our own — is
 * unusually weak in this deployment. Siteverify is served by Cloudflare, and §03 puts Cloudflare in
 * front of every request that reaches this process at all. A Cloudflare outage broad enough to take
 * siteverify down is already an outage in which no signup reaches this guard to be refused.
 *
 * A `503` rather than the `502` an upstream failure would usually earn: the caller's remedy is to
 * wait and resend *the same* token, not to solve a fresh challenge, and 503 is the status that says
 * so. `ProblemDetailsFilter` sends `Cache-Control: no-store` on every problem document, so this
 * answer does not outlive the outage that produced it.
 */
export class TurnstileUnavailableError extends DomainError {
  constructor() {
    super('service-unavailable', UNAVAILABLE);
  }
}

/** The part of the platform request this reads, declared structurally so nothing here imports Express. */
interface TokenBearingRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
}

/** The half of siteverify's response this acts on. Everything else it returns is diagnostic. */
interface SiteverifyResponse {
  readonly success?: unknown;
}

/**
 * Server-side Turnstile **verification** on signup and password reset (§03, T31).
 *
 * ## What this is not
 *
 * It does not issue a challenge. §03 places issuance at the Cloudflare edge, along with the WAF, the
 * bot mitigation and the coarse IP limits, and the edge is where it belongs: a challenge minted here
 * would need a site key, a widget, a nonce store and a replay window that Cloudflare already
 * operates, and the origin would be answering the requests the edge exists to absorb. This class is
 * the other half of a control that already exists — the part that checks the edge's work reached us.
 *
 * ## Inert when unconfigured
 *
 * `TURNSTILE_SECRET_KEY` is optional in `environment.ts`, and a deployment without one is an
 * ordinary state, not a misconfiguration: a developer's machine has no Cloudflare in front of it, so
 * there is no widget to produce a token and nothing a verification could mean. With no key the guard
 * admits every request and says so **once, at boot**.
 *
 * Once, and at boot, is the whole of the design here. The obvious implementation warns from
 * `canActivate`, which is correct on the first request and is a log line per signup attempt
 * thereafter — on the one machine whose operator is most likely to be reading the log, and least
 * likely to want it buried. Boot is also the moment the message is *actionable*: it is next to the
 * rest of the configuration the process just resolved, before any traffic, where "this deployment is
 * not verifying Turnstile" reads as a fact about the deployment rather than as a fact about the
 * request that happened to be first.
 *
 * Applied with `@UseGuards` on exactly two handlers rather than registered as a fourth `APP_GUARD`.
 * `IdentityModule` argues the opposite for `SessionGuard` — authentication is the default and
 * `@Public()` is the exception — and the argument does not carry over: an anti-automation check is
 * not a property every route should have, it is a property of the two unauthenticated routes that
 * cost real money to abuse. A global guard plus a `@Turnstile()` opt-in would be the same two call
 * sites with a decorator and a metadata read in front of them.
 */
@Injectable()
export class TurnstileGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(TurnstileGuard.name);

  /**
   * Read once and held. Never logged, never returned, never put in an error — the only place it
   * goes is the encrypted request body to Cloudflare in {@link verify}.
   */
  private readonly secret: string | undefined;

  constructor(config: ConfigService<Environment, true>) {
    this.secret = config.get('TURNSTILE_SECRET_KEY', { infer: true });
  }

  /**
   * The one log line, on the one code path that has something to say.
   *
   * `onModuleInit` rather than the constructor so that "at boot" is a property of the lifecycle
   * rather than of when Nest happened to resolve an enhancer, and so a test can assert it by calling
   * one method rather than by counting instantiations.
   *
   * A `warn` rather than a `log`: on a developer's machine this is expected and ignorable, and on a
   * deployment that lost its secret in a config change it is the only warning anyone will get.
   */
  onModuleInit(): void {
    if (this.secret === undefined) {
      this.logger.warn(
        'TURNSTILE_SECRET_KEY is not set: signup and password reset are not verifying Turnstile tokens',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Inert, and silent. Not a `debug` line either: a per-request log is a per-request log at
    // whatever level it is written, and this branch is the *normal* one on every developer machine.
    if (this.secret === undefined) {
      return true;
    }

    const request = context.switchToHttp().getRequest<TokenBearingRequest>();
    const token = tokenFrom(request);

    // Refused here rather than sent on, so an absent token costs a round trip to nobody. Cloudflare
    // would answer `missing-input-response` to the same effect, more slowly and at their expense.
    if (token === undefined) {
      throw new TurnstileCheckFailedError();
    }

    if (!(await this.verify(token, this.secret))) {
      throw new TurnstileCheckFailedError();
    }

    return true;
  }

  /**
   * Whether Cloudflare says this token is good.
   *
   * The secret is passed in rather than read from the field so that the narrowing `canActivate`
   * already performed survives into here — the alternative is a second `undefined` check on a value
   * that cannot be undefined, or a non-null assertion on the one field in this class that must never
   * be handled carelessly.
   *
   * `remoteip` is deliberately not sent. It is optional, and when it *is* sent Cloudflare requires it
   * to match the address that solved the challenge — so getting it a shade wrong, which any
   * disagreement between our `trust proxy` chain and the edge's own view of the client would do,
   * turns every signup into a refusal that no log line here can explain. The replay it would prevent
   * is already bounded: a Turnstile token is single-use and lives about five minutes.
   *
   * Nothing in here is logged. Not the secret, not the token, and not Cloudflare's `error-codes`
   * either — those are per-request and name the token's failure mode, which is the distinction
   * `TurnstileCheckFailedError` exists to withhold.
   */
  private async verify(token: string, secret: string): Promise<boolean> {
    let payload: unknown;

    try {
      const response = await fetch(TURNSTILE_VERIFY_URL, {
        // `application/x-www-form-urlencoded`, which is what siteverify documents. Built with
        // `URLSearchParams` rather than string concatenation so a token containing an `&` cannot
        // append a field of its own to the request.
        body: new URLSearchParams({ response: token, secret }),
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new TurnstileUnavailableError();
      }

      payload = await response.json();
    } catch (error) {
      // A timeout, a refused connection, a body that is not JSON, and a non-2xx all arrive here and
      // all mean the same thing: nobody verified anything. The rethrow keeps this from swallowing
      // the error it just threw itself.
      throw error instanceof TurnstileUnavailableError ? error : new TurnstileUnavailableError();
    }

    // `=== true` rather than a truthiness test. A body that parsed but is not siteverify's — an
    // interception page, a JSON error envelope, `null` — must not be able to pass by carrying any
    // truthy `success`, and `null` has no properties to read at all.
    return (payload as SiteverifyResponse | null)?.success === true;
  }
}

/**
 * The token this request presented, or `undefined` if it presented nothing usable.
 *
 * A repeated header arrives as an array; the first value is the request's own, exactly as
 * `auth.controller.ts` reads `User-Agent`. An over-long value is dropped rather than truncated —
 * truncating produces a token that is certainly invalid and sends it to Cloudflare anyway.
 */
function tokenFrom(request: TokenBearingRequest): string | undefined {
  const header = request.headers?.[TURNSTILE_TOKEN_HEADER];
  const raw = Array.isArray(header) ? header[0] : header;
  const token = raw?.trim();

  if (token === undefined || token.length === 0 || token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
    return undefined;
  }

  return token;
}
