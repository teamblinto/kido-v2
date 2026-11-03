import { Inject, Injectable, Logger } from '@nestjs/common';

import { AccountSecretService } from '../../../common/crypto/account-secret';
import { plaintext, revealPlaintext } from '../../../common/crypto/branded';
import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { NotFoundError } from '../../../common/errors/domain-error';
import type { TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { REFRESH_FLOOR_MS } from '../agent.constants';
import type { CredentialContext, LlmProviderName } from '../llm-provider.port';
import { ProviderError } from '../provider-error';
import { ByosProviders } from './byos-providers';
import { LinkedAccountRepository } from './linked-account.repository';
import type { LinkedAccount } from '@repo/contracts';
import { toContract } from './linked-account.repository';
import { BEARER_VERIFIERS, type BearerVerifiers, grantPurpose } from './byos-grant';
import type { LinkedAccountRow } from '@repo/db';
import {
  type ByosGrant,
  SUBSCRIPTION_CLIENTS,
  type SubscriptionClients,
  SubscriptionFailure,
} from './subscription-client.port';

type Outcome =
  | { readonly kind: 'ok'; readonly credential: CredentialContext }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'unreachable' };

/**
 * A person's current subscription credential (spec 032 US4, research R3/R4). The sealed grant on
 * the `linked_accounts` row is the cache; a refresh is single-flight under that row's lock, so ten
 * concurrent callers cost one provider call and every waiter re-reads the row the holder wrote.
 * The transaction holds the lock, the provider call and the write, and nothing else. A dead holder
 * releases the lock with its connection. Plaintext lives only in locals and the answer; the only
 * log lines are the refresh and a health transition (FR-024).
 */
@Injectable()
export class ByosTokenService {
  private readonly logger = new Logger(ByosTokenService.name);

  constructor(
    @Inject(ByosProviders) private readonly providers: ByosProviders,
    @Inject(SUBSCRIPTION_CLIENTS) private readonly clients: SubscriptionClients,
    @Inject(LinkedAccountRepository) private readonly accounts: LinkedAccountRepository,
    @Inject(AccountSecretService) private readonly secrets: AccountSecretService,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(BEARER_VERIFIERS) private readonly verifiers: BearerVerifiers,
  ) {}

  /**
   * Throws `SubscriptionFailure('rejected')` when the account needs reconnecting (now or already),
   * `ProviderError('unavailable')` when the provider could not be reached, and `NotFoundError`
   * when there is no linked account.
   */
  async current(
    userId: string,
    provider: LlmProviderName,
    options: { readonly force?: boolean } = {},
  ): Promise<CredentialContext> {
    const endpoint = this.providers.endpoint(provider);
    const client = this.clients[provider];
    if (endpoint === undefined || client === undefined) throw new ProviderError('unavailable');

    const outcome = await this.transactions.runInUserTransaction(
      userId,
      async (tx): Promise<Outcome> => {
        const row = await this.accounts.lockByProvider(tx, userId, provider);
        if (row === undefined) throw new NotFoundError('No linked account for this provider.');
        if (row.health === 'needs_reauth') return { kind: 'rejected' };

        const grant = await this.open(userId, provider, row.grantSealed);
        if (grant === undefined) {
          await this.needsReauth(tx, row);
          return { kind: 'rejected' };
        }

        const now = this.clock.now();
        const fresh = row.accessExpiresAt.getTime() - now.getTime() >= REFRESH_FLOOR_MS;
        const context = (next: ByosGrant, label: string): CredentialContext => ({
          accountLabel: label,
          apiKey: next.accessToken,
          endpoint,
          expiresAt: new Date(next.accessExpiresAt),
          mode: 'BYOS',
          provider,
        });
        if (fresh && options.force !== true) {
          return { credential: context(grant, row.accountLabel), kind: 'ok' };
        }

        let refreshed;
        try {
          refreshed = await client.refresh(grant.refreshToken);
        } catch (error) {
          if (!(error instanceof SubscriptionFailure)) throw error;
          if (error.kind === 'unreachable') return { kind: 'unreachable' };
          await this.needsReauth(tx, row);
          return { kind: 'rejected' };
        }

        const sealed = await this.secrets.seal(
          { purpose: grantPurpose(provider), userId },
          plaintext(JSON.stringify(refreshed.grant satisfies ByosGrant)),
        );
        await this.accounts.setGrant(tx, row.id, {
          accessExpiresAt: new Date(refreshed.grant.accessExpiresAt),
          accountLabel: row.accountLabel,
          grantSealed: sealed,
          lastCheckedAt: this.clock.now(),
        });
        this.logger.log(`BYOS refreshed [user=${userId} provider=${provider}]`);
        return { credential: context(refreshed.grant, row.accountLabel), kind: 'ok' };
      },
    );

    if (outcome.kind === 'rejected') throw new SubscriptionFailure('rejected');
    if (outcome.kind === 'unreachable') throw new ProviderError('unavailable');
    return outcome.credential;
  }

  /**
   * 032 T043: is the account still good? Under the row lock: refresh when due, then the adapter's
   * bearer check. `ok` reads `healthy` (a recovery from `needs_reauth` is logged); `rejected`
   * reads `needs_reauth` with its one mail, and only on the transition; `unreachable` changes
   * nothing but `last_checked_at`. Unlike `current`, a `needs_reauth` row is checked too.
   */
  async verify(userId: string, provider: LlmProviderName): Promise<LinkedAccount> {
    const endpoint = this.providers.endpoint(provider);
    const client = this.clients[provider];
    if (endpoint === undefined || client === undefined) {
      throw new NotFoundError('No such provider.');
    }

    return this.transactions.runInUserTransaction(userId, async (tx) => {
      const row = await this.accounts.lockByProvider(tx, userId, provider);
      if (row === undefined) throw new NotFoundError('No linked account for this provider.');
      const now = this.clock.now();
      const answer = async (
        health: LinkedAccountRow['health'],
        at = now,
      ): Promise<LinkedAccount> => {
        await this.accounts.touch(tx, row.id, at);
        return toContract({ ...row, health, lastCheckedAt: at });
      };
      const reject = async (): Promise<LinkedAccount> => {
        if (row.health !== 'needs_reauth') await this.needsReauth(tx, row);
        return answer('needs_reauth');
      };

      let grant = await this.open(userId, provider, row.grantSealed);
      if (grant === undefined) return reject();
      let expiresAt = row.accessExpiresAt;
      if (expiresAt.getTime() - now.getTime() < REFRESH_FLOOR_MS) {
        try {
          grant = (await client.refresh(grant.refreshToken)).grant;
        } catch (error) {
          if (!(error instanceof SubscriptionFailure)) throw error;
          if (error.kind === 'unreachable') return answer(row.health);
          return reject();
        }
        expiresAt = new Date(grant.accessExpiresAt);
        await this.accounts.setGrant(tx, row.id, {
          accessExpiresAt: expiresAt,
          accountLabel: row.accountLabel,
          grantSealed: await this.secrets.seal(
            { purpose: grantPurpose(provider), userId },
            plaintext(JSON.stringify(grant satisfies ByosGrant)),
          ),
          lastCheckedAt: now,
        });
        this.logger.log(`BYOS refreshed [user=${userId} provider=${provider}]`);
      }

      const check = await this.verifiers[provider].verifyBearer({
        accountLabel: row.accountLabel,
        apiKey: grant.accessToken,
        endpoint,
        expiresAt,
        mode: 'BYOS',
        provider,
      });
      if (check === 'unreachable') return answer(row.health);
      if (check === 'rejected') return reject();
      if (row.health === 'needs_reauth') {
        await this.accounts.setHealth(tx, row.id, 'healthy');
        this.logger.log(
          `BYOS health [user=${userId} provider=${provider} from=needs_reauth to=healthy]`,
        );
      }
      return answer('healthy');
    });
  }

  /**
   * 032 T041: a 401 straight after a refresh that worked. The account reads `needs_reauth`, with
   * its one mail, unless it already does.
   */
  async markRejected(userId: string, provider: LlmProviderName): Promise<void> {
    await this.transactions.runInUserTransaction(userId, async (tx) => {
      const row = await this.accounts.lockByProvider(tx, userId, provider);
      if (row !== undefined && row.health !== 'needs_reauth') await this.needsReauth(tx, row);
    });
  }

  /** 032 T046: the provider's reset, recorded on the account; health is untouched. */
  async setLimitedUntil(userId: string, provider: LlmProviderName, at: Date): Promise<void> {
    await this.transactions.runInUserTransaction(userId, async (tx) => {
      const row = await this.accounts.byProviderOn(tx, userId, provider);
      if (row !== undefined) await this.accounts.setLimitedUntil(tx, row.id, at);
    });
  }

  /** 032 T046: a model call on the account worked, so any recorded limit is over. */
  async clearLimit(userId: string, provider: LlmProviderName): Promise<void> {
    await this.transactions.runInUserTransaction(userId, (tx) =>
      this.accounts.clearLimitedUntil(tx, userId, provider),
    );
  }

  /** The grant, or `undefined` when it no longer opens (an unknown KEK: R2's known gap). */
  private async open(
    userId: string,
    provider: LlmProviderName,
    sealed: Buffer,
  ): Promise<ByosGrant | undefined> {
    try {
      const opened = await this.secrets.open({ purpose: grantPurpose(provider), userId }, sealed);
      return JSON.parse(revealPlaintext(opened).toString('utf8')) as ByosGrant;
    } catch {
      return undefined;
    }
  }

  /** The transition and its one mail share the caller's transaction (R10, FR-020). */
  private async needsReauth(tx: TenantTransaction, row: LinkedAccountRow): Promise<void> {
    await this.accounts.setHealth(tx, row.id, 'needs_reauth');
    await this.outbox.append(tx, {
      aggregateId: row.id,
      payload: { kind: 'needs-reauth', provider: row.provider, recipientUserId: row.userId },
      type: 'mail.byos',
    });
    this.logger.warn(
      `BYOS health [user=${row.userId} provider=${row.provider} from=healthy to=needs_reauth]`,
    );
  }
}
