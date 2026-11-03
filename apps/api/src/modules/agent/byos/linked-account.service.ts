import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BeginLinkResponse,
  CompleteLinkPending,
  CompleteLinkRequest,
  LinkedAccount,
  LinkedAccountList,
} from '@repo/contracts';
import { createHash, randomBytes } from 'node:crypto';

import { AccountSecretService } from '../../../common/crypto/account-secret';
import { plaintext, revealPlaintext } from '../../../common/crypto/branded';
import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { NotFoundError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import type { LlmProviderName } from '../llm-provider.port';
import { BEARER_VERIFIERS, type BearerVerifiers, grantPurpose } from './byos-grant';
import { ByosTokenService } from './byos-token.service';
import { byosRefusal, stateInvalid } from './byos.errors';
import { ByosProviders } from './byos-providers';
import { type LinkState, LinkStateStore } from './link-state.store';
import { LinkedAccountRepository, toContract } from './linked-account.repository';
import {
  type ByosGrant,
  type GrantResult,
  SUBSCRIPTION_CLIENTS,
  type SubscriptionClient,
  type SubscriptionClients,
  SubscriptionFailure,
} from './subscription-client.port';

// Moved to `byos-grant.ts` so `ByosTokenService` and this service do not import each other.
export { BEARER_VERIFIERS, type BearerVerifiers, grantPurpose } from './byos-grant';

/**
 * Linking a person's own subscription (spec 032 US2, contracts § 1). Everything here is the
 * caller's own: the state is bound to their session, the grant is sealed to their user id, and
 * every row names them. A replaced or removed grant is revoked at the provider after the commit,
 * best effort. Log lines name the user and provider and nothing of the grant (FR-024).
 */
@Injectable()
export class LinkedAccountService {
  private readonly logger = new Logger(LinkedAccountService.name);
  private readonly appUrl: string;

  constructor(
    @Inject(ByosProviders) private readonly providers: ByosProviders,
    @Inject(SUBSCRIPTION_CLIENTS) private readonly clients: SubscriptionClients,
    @Inject(BEARER_VERIFIERS) private readonly verifiers: BearerVerifiers,
    @Inject(LinkStateStore) private readonly states: LinkStateStore,
    @Inject(LinkedAccountRepository) private readonly accounts: LinkedAccountRepository,
    @Inject(AccountSecretService) private readonly secrets: AccountSecretService,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(ByosTokenService) private readonly tokens: ByosTokenService,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  async list(userId: string): Promise<LinkedAccountList> {
    const [offered, rows] = await Promise.all([
      this.providers.offeredList(),
      this.accounts.list(userId),
    ]);
    return { accounts: rows.map(toContract), offered };
  }

  async begin(
    userId: string,
    sessionId: string,
    provider: LlmProviderName,
  ): Promise<BeginLinkResponse> {
    const client = this.client(provider);
    const verifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    // Issued first so the provider sees the real state; a device flow re-issues with its code.
    const state = await this.states.issue(userId, sessionId, provider, verifier);
    const started = await this.providerCall(() =>
      client.begin({ codeChallenge, redirectUri: this.redirectUri(provider), state }),
    );
    if (started.kind === 'redirect') return started;

    // The device code stays server-side (D3); spend the first state and hand out one carrying it.
    await this.states.consume(state, { provider, sessionId, userId });
    const deviceState = await this.states.issue(userId, sessionId, provider, verifier, {
      deviceCode: started.deviceCode,
      intervalSeconds: started.intervalSeconds,
    });
    return {
      expiresAt: started.expiresAt.toISOString(),
      kind: 'device',
      state: deviceState,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
    };
  }

  async complete(
    userId: string,
    sessionId: string,
    provider: LlmProviderName,
    body: CompleteLinkRequest,
  ): Promise<LinkedAccount | CompleteLinkPending> {
    const link = await this.states.consume(body.state, { provider, sessionId, userId });
    if (link === undefined) throw stateInvalid();
    if (body.error !== undefined) {
      throw byosRefusal(body.error === 'access_denied' ? 'denied' : 'exchange-refused');
    }

    const client = this.client(provider);
    const exchanged = await this.providerCall(() =>
      client.exchange({
        code: body.code,
        deviceCode: link.deviceCode,
        redirectUri: this.redirectUri(provider),
        state: body.state,
        verifier: link.pkce,
      }),
    );
    if ('pending' in exchanged) {
      await this.states.restore(body.state, sessionId, link satisfies LinkState);
      return { pending: true, retryAfterSeconds: exchanged.retryAfterSeconds };
    }

    await this.verifyNew(provider, exchanged);
    return this.store(userId, provider, client, exchanged);
  }

  /** 032 T043: on-demand check of the caller's own account; the token service does the work. */
  verify(userId: string, provider: LlmProviderName): Promise<LinkedAccount> {
    if (this.clients[provider] === undefined) throw new NotFoundError('No such provider.');
    return this.tokens.verify(userId, provider);
  }

  async unlink(userId: string, provider: LlmProviderName): Promise<void> {
    const previous = await this.transactions.runInUserTransaction(userId, async (tx) => {
      const row = await this.accounts.lockByProvider(tx, userId, provider);
      if (row === undefined) return undefined;
      const refresh = await this.refreshOf(userId, provider, row.grantSealed);
      await this.accounts.delete(tx, userId, provider);
      return { refresh };
    });
    if (previous === undefined) throw new NotFoundError('No linked account for this provider.');

    this.logger.log(`BYOS unlinked [user=${userId} provider=${provider}]`);
    await this.revoke(userId, provider, this.clients[provider], previous.refresh);
  }

  private async store(
    userId: string,
    provider: LlmProviderName,
    client: SubscriptionClient,
    result: GrantResult,
  ): Promise<LinkedAccount> {
    const sealed = await this.secrets.seal(
      { purpose: grantPurpose(provider), userId },
      plaintext(JSON.stringify(result.grant satisfies ByosGrant)),
    );
    const now = this.clock.now();
    const { previous, row } = await this.transactions.runInUserTransaction(userId, async (tx) => {
      const existing = await this.accounts.lockByProvider(tx, userId, provider);
      const refresh =
        existing === undefined
          ? undefined
          : await this.refreshOf(userId, provider, existing.grantSealed);
      const stored = await this.accounts.upsert(tx, {
        accessExpiresAt: new Date(result.grant.accessExpiresAt),
        accountLabel: result.accountLabel,
        grantSealed: sealed,
        lastCheckedAt: now,
        linkedAt: now,
        provider,
        userId,
      });
      return { previous: existing === undefined ? undefined : { refresh }, row: stored };
    });

    this.logger.log(
      `BYOS ${previous === undefined ? 'linked' : 'relinked'} [user=${userId} provider=${provider}]`,
    );
    if (previous !== undefined) await this.revoke(userId, provider, client, previous.refresh);
    return toContract(row);
  }

  /** The new token must work before anything is stored (contracts § 1). */
  private async verifyNew(provider: LlmProviderName, result: GrantResult): Promise<void> {
    const endpoint = this.providers.endpoint(provider);
    if (endpoint === undefined) throw new NotFoundError('No such provider.');
    const check = await this.verifiers[provider].verifyBearer({
      accountLabel: result.accountLabel,
      apiKey: result.grant.accessToken,
      endpoint,
      expiresAt: new Date(result.grant.accessExpiresAt),
      mode: 'BYOS',
      provider,
    });
    if (check === 'rejected') throw byosRefusal('exchange-refused');
    if (check === 'unreachable') throw byosRefusal('provider-unavailable');
  }

  /** The previous grant's refresh token, or `undefined` when it no longer opens. */
  private async refreshOf(
    userId: string,
    provider: LlmProviderName,
    sealed: Buffer,
  ): Promise<string | undefined> {
    try {
      const opened = await this.secrets.open({ purpose: grantPurpose(provider), userId }, sealed);
      return (JSON.parse(revealPlaintext(opened).toString('utf8')) as ByosGrant).refreshToken;
    } catch {
      return undefined;
    }
  }

  /** Best effort, after the commit: a failure is logged by class and changes nothing here. */
  private async revoke(
    userId: string,
    provider: LlmProviderName,
    client: SubscriptionClient | undefined,
    refreshToken: string | undefined,
  ): Promise<void> {
    if (client?.revoke === undefined || refreshToken === undefined) return;
    try {
      await client.revoke(refreshToken);
    } catch (error) {
      const kind = error instanceof SubscriptionFailure ? error.kind : 'unexpected';
      this.logger.warn(`BYOS revoke failed [user=${userId} provider=${provider} class=${kind}]`);
    }
  }

  private client(provider: LlmProviderName): SubscriptionClient {
    const client = this.clients[provider];
    if (client === undefined) throw new NotFoundError('No such provider.');
    return client;
  }

  /** A provider call whose classified failure becomes the contract's refusal. */
  private async providerCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof SubscriptionFailure)) throw error;
      if (error.kind === 'unreachable') throw byosRefusal('provider-unavailable');
      throw byosRefusal(error.kind === 'denied' ? 'denied' : 'exchange-refused');
    }
  }

  private redirectUri(provider: LlmProviderName): string {
    return `${this.appUrl.replace(/\/+$/, '')}/account/connected-accounts/${provider}/callback`;
  }
}
