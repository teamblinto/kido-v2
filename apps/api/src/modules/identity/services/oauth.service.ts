import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OauthProvider } from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { DomainError } from '../../../common/errors/domain-error';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import type { Environment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import type { DeviceFingerprint } from '../device-fingerprint';
import {
  OAUTH_PROVIDERS_PORT,
  type OauthProviderPort,
  type ProviderIdentity,
  type VerifiedIdentity,
} from './oauth-provider.port';
import { type IssuedSession, SessionService } from './session.service';

/** 32 bytes, the same budget a session token gets: far past guessing, short enough for a URL. */
const STATE_BYTES = 32;

/**
 * RFC 7636 §4.1 allows 43–128 characters; 32 random bytes is 43 base64url characters, which is the
 * floor and is 256 bits of entropy. There is nothing to buy above it — the verifier is transmitted
 * once, over TLS, to an endpoint that has already been authenticated.
 */
const VERIFIER_BYTES = 32;

/**
 * One sentence for every way a `state` fails to resolve.
 *
 * Never minted here, minted for the other provider, expired, or already spent — one message, in the
 * spirit of `CsrfMiddleware`'s single rejection. Distinguishing them tells an attacker which half of
 * the mechanism their forged callback got past, and the user's remedy is the same in all four
 * cases: start the sign-in again.
 */
const STATE_REJECTED =
  'This sign-in link is no longer valid. Start signing in with the provider again.';

const DENIED = 'The sign-in was not approved at the provider.';

const EMAIL_UNVERIFIED =
  'The provider has not verified an email address for this account, so it cannot be linked to an ' +
  'existing account here. Verify your address with the provider and try again.';

const NOT_CONFIGURED = 'Signing in with this provider is not enabled on this deployment.';

/** The Redis key one pending flow is stored under. The argument is always a digest, never a state. */
export function oauthStateKey(stateHash: string): string {
  return `oauth:s:${stateHash}`;
}

/** Criterion 9's "cleanly disabled when unconfigured", as the one error both routes may throw. */
export class OauthProviderNotConfiguredError extends DomainError {
  constructor(provider: OauthProvider) {
    super('oauth-provider-not-configured', NOT_CONFIGURED, { provider });
  }
}

/** Missing, unknown, expired, spent, or minted for a different provider. */
export class OauthStateError extends DomainError {
  constructor() {
    super('oauth-state-invalid', STATE_REJECTED);
  }
}

/** The provider said the user declined — RFC 6749's `access_denied` and its neighbours. */
export class OauthDeniedError extends DomainError {
  constructor(provider: OauthProvider) {
    super('oauth-authorization-denied', DENIED, { provider });
  }
}

/** The token or profile call did not produce an identity. Never carries the provider's own text. */
export class OauthExchangeError extends DomainError {
  constructor(provider: OauthProvider) {
    super(
      'oauth-exchange-failed',
      'The provider did not complete the sign-in. Try again in a moment.',
      { provider },
    );
  }
}

/**
 * The proof-of-control refusal (criterion 9). Thrown only on the *linking* path.
 *
 * Extends `DomainError` with the slug directly rather than `ForbiddenError`, for the reason every
 * other refinement in this module does: the catalogue is what maps `oauth-email-unverified` onto
 * 403, and a subclass that inherited `forbidden` and then reassigned `type` would depend on field
 * initialisation order to be correct.
 */
export class OauthEmailUnverifiedError extends DomainError {
  constructor(provider: OauthProvider) {
    super('oauth-email-unverified', EMAIL_UNVERIFIED, { provider });
  }
}

/** This account already federates to a different account at the same provider. */
export class OauthAccountAlreadyLinkedError extends DomainError {
  constructor(provider: OauthProvider) {
    super(
      'oauth-account-already-linked',
      'This account is already linked to a different account at this provider. Sign in with that ' +
        'one, or unlink it first.',
      { provider },
    );
  }
}

/** What {@link OauthService.begin} hands the controller: somewhere to send the browser. */
export interface StartedFlow {
  readonly authorizationUrl: string;
}

/** What a completed flow produces. The session token goes to a cookie and nowhere else. */
export interface CompletedFlow {
  readonly session: IssuedSession;
  readonly userId: string;
}

/** What the controller knows about a callback before this service looks at any of it. */
export interface CallbackAttempt {
  readonly code?: string;
  /** The session the browser arrived holding, if any. Revoked on the way through. */
  readonly currentToken?: string;
  readonly device: DeviceFingerprint;
  /** RFC 6749 §4.1.2.1, present when the provider refused instead of redirecting with a code. */
  readonly error?: string;
  readonly state?: string;
}

/** The pending flow, as the fields a Redis hash can hold. */
interface StoredState {
  codeVerifier: string;
  createdAt: string;
  /**
   * Which provider the flow was started for, checked on the way back out.
   *
   * Without it, a state minted at `/auth/oauth/github` would complete at
   * `/auth/oauth/google/callback`, and the code would be exchanged at the wrong token endpoint with
   * the wrong client credentials. It never *succeeds* — the exchange fails — but it fails as a 502
   * pointing at an innocent provider, and a mechanism whose misuse is only caught downstream is one
   * misuse away from not being caught at all.
   */
  provider: string;
}

/**
 * The provider-agnostic half of criterion 9: strict `state`, PKCE, and the rules about which local
 * account a federated identity is allowed to become.
 *
 * ## The `state` is the CSRF defence, and it is strict in three separate senses
 *
 * **Server-side.** It is 32 bytes of `randomBytes` minted here, not a value derived from anything
 * the caller sent and not a signed blob the caller holds. The browser is never trusted to keep it —
 * the record lives in the session Redis, which is the `noeviction` role §09 keeps apart from the
 * cache precisely so that a pending sign-in is not evicted under memory pressure.
 *
 * **Single-use.** Consumption is `GETDEL`: one round trip that reads and removes atomically. A
 * `GET` followed by a `DEL` would leave a window in which two callbacks racing on the same state
 * both read it and both proceed, which is the whole of what "single-use" is meant to prevent. The
 * replay is refused because the record is *gone*, not because a flag was checked.
 *
 * **Short-lived.** `OAUTH_STATE_TTL_SECONDS`, and the window does not slide.
 *
 * Only the SHA-256 of the state is ever a Redis key, exactly as `SessionService` keys sessions by a
 * digest: the state travels through a third party and lands in the provider's logs, the browser's
 * history and our own access log, so a dump of the session instance must not be a list of flows
 * anybody could complete. SHA-256 rather than Argon2 for the same reason it gives — the input is
 * 256 bits of `randomBytes`, and there is no dictionary to slow anyone down against.
 *
 * PKCE sits underneath all of that and answers a different question: `state` proves the callback
 * belongs to a flow this server started, and the verifier proves the *code* is being redeemed by
 * the party that started it. They are not redundant. A code intercepted from a redirect — an open
 * redirector, a referrer leak, a malicious app registered for a custom scheme — is useless without
 * the verifier, which never leaves this process until the token call.
 *
 * ## Which account a federated identity becomes
 *
 * Three cases, and the second is the one criterion 9 is written around:
 *
 * 1. **The identity is already linked.** `unique (provider, provider_user_id)` resolves it to
 *    exactly one account. Sign in. Whether the provider still vouches for an address is not asked:
 *    the link was made on proof, and a user unverifying their GitHub address afterwards does not
 *    unmake it.
 * 2. **The identity is new and the provider has proved an address we already hold.** Link, then
 *    sign in — and *only* here. An unproved address never reaches this branch, because
 *    {@link VerifiedIdentity} is the only shape that carries one.
 * 3. **The identity is new and the address is ours to give.** Create the account. `password_hash`
 *    stays null — §11's OAuth-only account — and `email_verified_at` is stamped, because the same
 *    proof that would have been good enough to link is good enough to confirm.
 *
 * An unproved identity that is not already linked cannot reach any of the three. That is the
 * takeover this exists to prevent: without it, anybody who can persuade a provider to *display* an
 * address they do not control — a self-hosted forge, a provider that lets an address be claimed
 * before it is confirmed, an account whose address was changed and not re-verified — signs in as
 * whoever holds that address here.
 *
 * ## What is never written
 *
 * `users.email` is never updated from a provider. The address on `oauth_identities` records what
 * was asserted *at link time*, for the audit trail, and is not refreshed on later sign-ins: it is
 * evidence about a past decision, and evidence that is silently rewritten is not evidence. A
 * client secret, an authorization code and an access token never reach a log line on any path
 * through this class.
 */
@Injectable()
export class OauthService {
  private readonly adapters: ReadonlyMap<OauthProvider, OauthProviderPort>;
  private readonly appUrl: string;
  private readonly apiPrefix: string;
  private readonly apiVersion: string;
  private readonly logger = new Logger(OauthService.name);
  private readonly stateTtlSeconds: number;

  constructor(
    @Inject(APP_DATABASE) private readonly database: ForgeDatabase,
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(OAUTH_PROVIDERS_PORT) adapters: readonly OauthProviderPort[],
    private readonly sessions: SessionService,
    config: ConfigService<Environment, true>,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    this.apiPrefix = config.get('API_PREFIX', { infer: true });
    this.apiVersion = config.get('API_VERSION', { infer: true });
    this.appUrl = config.get('APP_URL', { infer: true });
    this.stateTtlSeconds = config.get('OAUTH_STATE_TTL_SECONDS', { infer: true });
  }

  /**
   * Start a flow: mint the state and the PKCE pair, store them, and answer with the URL the browser
   * is bounced to.
   *
   * The record is written *before* the URL is handed back, and there is no path on which a browser
   * is sent to a provider for a state Redis has not acknowledged — a flow that could not be stored
   * is one that could never be completed, and failing here is a retry rather than a sign-in that
   * dead-ends at the callback.
   */
  async begin(provider: OauthProvider): Promise<StartedFlow> {
    const adapter = this.configured(provider);
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const codeVerifier = randomBytes(VERIFIER_BYTES).toString('base64url');
    const record: StoredState = {
      codeVerifier,
      createdAt: this.clock.now().toISOString(),
      provider,
    };

    await this.redis
      .multi()
      .hset(oauthStateKey(hashState(state)), record)
      .expire(oauthStateKey(hashState(state)), this.stateTtlSeconds)
      .exec();

    this.logger.log(`OAuth flow started [provider=${provider}]`);

    return {
      authorizationUrl: adapter.authorizationUrl({
        codeChallenge: challengeFor(codeVerifier),
        redirectUri: this.redirectUri(provider),
        state,
      }),
    };
  }

  /**
   * Finish a flow: spend the state, exchange the code, resolve the account, establish the session.
   *
   * The order is the design. The state is consumed **first** — before the provider is contacted and
   * before anything is read from the database — so a replayed callback costs one Redis round trip
   * rather than a token exchange, and so a caller cannot use this route to make us hammer a
   * provider with codes. It is consumed even when the query carries a provider-side `error`,
   * because a flow the user cancelled is a flow that is over.
   */
  async complete(provider: OauthProvider, attempt: CallbackAttempt): Promise<CompletedFlow> {
    const adapter = this.configured(provider);
    // Unconditional, and before the `error` branch below: whatever else this callback is, the flow
    // it names is finished. Leaving the record behind on the refusal arm would keep a completable
    // state alive for its full TTL after the user pressed Cancel.
    const pending = await this.consumeState(attempt.state, provider);

    if (attempt.error !== undefined) {
      // The provider's own string is deliberately not echoed to the client or the log: it is
      // attacker-influenceable text on a route anybody can call, and `access_denied` is the only
      // value it has ever needed to distinguish.
      this.logger.warn(`OAuth flow declined at the provider [provider=${provider}]`);

      throw new OauthDeniedError(provider);
    }

    if (attempt.code === undefined) {
      // A callback with a spent-able state, no error and no code is not a flow this server started
      // the way it thinks it did. Answered as a state failure rather than a validation error, so it
      // is indistinguishable from the replay above.
      throw new OauthStateError();
    }

    const identity = await adapter.identify({
      code: attempt.code,
      codeVerifier: pending.codeVerifier,
      redirectUri: this.redirectUri(provider),
    });
    const userId = await this.resolveAccount(provider, identity);

    // Session fixation, exactly as `LoginService` handles it: whatever the browser arrived holding
    // stops working here, whether it was their own stale session or one planted on a shared
    // machine. Before the new session is created, so there is no window in which both are live.
    if (attempt.currentToken !== undefined) {
      await this.sessions.revoke(attempt.currentToken);
    }

    this.logger.log(`OAuth sign-in completed [provider=${provider} user=${userId}]`);

    return { session: await this.sessions.create(userId, attempt.device), userId };
  }

  /**
   * The adapter for a provider this deployment has switched on.
   *
   * Both routes call this first, which is what makes "disabled" a stable, catalogued refusal rather
   * than a `TypeError` deep in an adapter holding an undefined client id.
   *
   * A provider with *no adapter at all* is answered identically, and that is deliberate rather than
   * defensive: `google` is in the published vocabulary from T05's database enum onward and its
   * adapter lands in T23, so until then "this deployment cannot complete a Google sign-in" is
   * exactly true and exactly what the caller needs to know. It is also what makes T23 purely
   * additive — the route already exists and already says the right thing.
   */
  private configured(provider: OauthProvider): OauthProviderPort {
    const adapter = this.adapters.get(provider);

    if (adapter?.isConfigured() !== true) {
      throw new OauthProviderNotConfiguredError(provider);
    }

    return adapter;
  }

  /**
   * Spend the state, or refuse.
   *
   * `HGETALL` + `DEL` in one `MULTI` rather than `GETDEL`, because the record is a hash: the two
   * commands are queued together and executed with nothing interleaved, so two callbacks racing on
   * one state cannot both find it. The loser reads an empty hash and is refused exactly as a replay
   * an hour later is.
   *
   * The provider is compared *after* the record is destroyed, so a state cannot be probed against
   * one provider and then spent against another.
   */
  private async consumeState(
    state: string | undefined,
    provider: OauthProvider,
  ): Promise<StoredState> {
    if (state === undefined) {
      throw new OauthStateError();
    }

    const key = oauthStateKey(hashState(state));
    const [read] = (await this.redis.multi().hgetall(key).del(key).exec()) ?? [];
    const stored = read?.[1] as Record<string, string | undefined> | undefined;

    if (typeof stored?.codeVerifier !== 'string' || stored.provider !== provider) {
      this.logger.warn(`OAuth callback refused: unrecognised state [provider=${provider}]`);

      throw new OauthStateError();
    }

    return {
      codeVerifier: stored.codeVerifier,
      createdAt: stored.createdAt ?? '',
      provider: stored.provider,
    };
  }

  /**
   * The three cases, in the order that keeps the second one honest.
   *
   * The existing-link lookup runs before the proof check, which is what lets an already-linked
   * account sign in with a provider that has since stopped vouching for its address. Every path
   * that could *create* a link is below the check and takes a {@link VerifiedIdentity}, so there is
   * no arm on which an unproved address is matched against `users.email`.
   */
  private async resolveAccount(
    provider: OauthProvider,
    identity: ProviderIdentity,
  ): Promise<string> {
    const linked = await this.findLinked(provider, identity.providerUserId);

    if (linked !== null) {
      return linked;
    }

    if (identity.kind === 'unverified') {
      this.logger.warn(
        `OAuth link refused: the provider vouched for no address [provider=${provider}]`,
      );

      throw new OauthEmailUnverifiedError(provider);
    }

    return this.linkOrCreate(provider, identity);
  }

  private async findLinked(
    provider: OauthProvider,
    providerUserId: string,
  ): Promise<string | null> {
    const [row] = await this.database
      .select({ userId: schema.oauthIdentities.userId })
      .from(schema.oauthIdentities)
      .where(
        and(
          eq(schema.oauthIdentities.provider, provider),
          eq(schema.oauthIdentities.providerUserId, providerUserId),
        ),
      )
      .limit(1);

    return row?.userId ?? null;
  }

  /**
   * Link the proved address to the account that holds it, or create the account that will.
   *
   * Both inserts are `on conflict do nothing` followed by a re-read, for the reason
   * `SignupService.createIfAbsent` gives at length: two callbacks arriving at once for the same new
   * address both see no row and both insert, and the loser of that race must be answered like
   * somebody who arrived an hour late rather than with a 23505 the route has no branch for.
   */
  private async linkOrCreate(provider: OauthProvider, identity: VerifiedIdentity): Promise<string> {
    const existing = await this.findByEmail(identity.email);
    const userId = existing ?? (await this.createOauthAccount(identity.email));

    const [linked] = await this.database
      .insert(schema.oauthIdentities)
      .values({
        email: identity.email,
        provider,
        providerUserId: identity.providerUserId,
        userId,
      })
      // Both unique constraints, and they mean different things. `(provider, provider_user_id)`
      // losing means another request linked this same provider account first — harmless, and the
      // re-read below finds it. `(user_id, provider)` losing means this local account already
      // federates to a *different* account at this provider, which is the conflict below.
      .onConflictDoNothing()
      .returning({ id: schema.oauthIdentities.id });

    if (linked !== undefined) {
      this.logger.log(`OAuth identity linked [provider=${provider} user=${userId}]`);

      return userId;
    }

    const raced = await this.findLinked(provider, identity.providerUserId);

    if (raced !== null) {
      return raced;
    }

    this.logger.warn(
      `OAuth link refused: the account already federates to this provider ` +
        `[provider=${provider} user=${userId}]`,
    );

    throw new OauthAccountAlreadyLinkedError(provider);
  }

  private async findByEmail(email: string): Promise<string | null> {
    const [user] = await this.database
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    return user?.id ?? null;
  }

  /**
   * §11's OAuth-only account: a `users` row with no password hash.
   *
   * `email_verified_at` is stamped at creation, and that is not a shortcut. The provider has proved
   * control of exactly this address — the same proof that authorises linking to an account somebody
   * already owns — so sending a confirmation mail would be asking the user to re-prove, through a
   * weaker channel, something they just proved through a stronger one. It is stamped from the
   * injected clock rather than `now()` so the tests that drive a fake one see a consistent instant.
   */
  private async createOauthAccount(email: string): Promise<string> {
    const [created] = await this.database
      .insert(schema.users)
      .values({ email, emailVerifiedAt: this.clock.now(), passwordHash: null })
      .onConflictDoNothing({ target: schema.users.email })
      .returning({ id: schema.users.id });

    if (created !== undefined) {
      // No address: §05 keeps mailboxes out of the log, exactly as `SignupService` does.
      this.logger.log(`Account created from an OAuth sign-in [user=${created.id}]`);

      return created.id;
    }

    const raced = await this.findByEmail(email);

    if (raced === null) {
      // The insert was refused and the row is not there to read. Not reachable through the unique
      // index — a conflict on it means a row exists — so this is a genuine fault rather than a race,
      // and a 500 is the right way to be wrong about it.
      throw new Error('the OAuth account insert conflicted but no row could be read back');
    }

    return raced;
  }

  /**
   * Where the provider sends the browser back to.
   *
   * Derived from `APP_URL` and the API's own prefix and version rather than configured separately,
   * because §03 settles it: the API is served same-origin under `app.forge.dev/api/v1` *precisely*
   * so the session cookie can be `__Host-` with no `Domain`. A separately configured redirect base
   * would be a way to point the callback at an origin the session cookie cannot be written for —
   * the sign-in would appear to succeed and the user would land signed out.
   *
   * It is rebuilt per call rather than cached, so it is one expression and cannot drift from the
   * value the token exchange sends; providers compare the two byte for byte.
   */
  private redirectUri(provider: OauthProvider): string {
    const base = `${this.appUrl.replace(/\/+$/, '')}/`;

    return new URL(
      `${this.apiPrefix}/v${this.apiVersion}/auth/oauth/${provider}/callback`,
      base,
    ).toString();
  }
}

/** RFC 7636 §4.2's `S256`: base64url of the SHA-256 of the verifier, unpadded. */
function challengeFor(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}
