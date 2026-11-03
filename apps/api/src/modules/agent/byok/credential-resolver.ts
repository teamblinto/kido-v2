import { Inject, Injectable } from '@nestjs/common';
import { providerOf, SUBSCRIPTION_MODELS } from '@repo/contracts';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { revealPlaintext } from '../../../common/crypto/branded';
import { DekService } from '../../../common/crypto/dek.service';
import type { TenantTransaction } from '../../../database/database.types';
import { OrgService } from '../../tenancy/services/org.service';
import { ByosProviders } from '../byos/byos-providers';
import { ByosTokenService } from '../byos/byos-token.service';
import { LinkedAccountRepository } from '../byos/linked-account.repository';
import { SubscriptionFailure } from '../byos/subscription-client.port';
import type { CredentialContext, LlmProviderName } from '../llm-provider.port';
import { purposeFor } from './key-shapes';
import { ProviderKeyRepository } from './provider-key.repository';

/** contracts/byok.md § 4 and 032 contracts § 5: what a run on `model` would use, or why not. */
export type Resolution =
  | { kind: 'byos'; credential: CredentialContext }
  | { kind: 'byok'; credential: CredentialContext; keyId: string }
  | { kind: 'needs_reauth'; provider: LlmProviderName; lastFour: string }
  | { kind: 'subscription-needs-reauth'; provider: LlmProviderName; accountLabel: string }
  | {
      kind: 'subscription-limited';
      provider: LlmProviderName;
      accountLabel: string;
      resetsAt: Date;
      /** What `credential: 'organisation'` would use (R7); `null` when nothing would. */
      alternativeMode: 'BYOK' | null;
    }
  | { kind: 'no-credential'; provider: LlmProviderName }
  | { kind: 'unknown-model' };

/** `kindOnly`'s answer: every refusal in full, the usable kinds without their credential. */
export type ResolutionKind =
  Exclude<Resolution, { kind: 'byos' | 'byok' }> | { kind: 'byos' | 'byok' };

export interface ResolveOptions {
  /** 032 A3: honoured only while the caller's subscription is limited. */
  readonly credential?: 'organisation';
}

/** What the row lookups settle before any secret is opened. */
type Located =
  | { kind: 'byos'; provider: LlmProviderName; accountLabel: string }
  | { kind: 'byok'; keyId: string; lastFour: string; provider: LlmProviderName; secretId: string }
  | Exclude<Resolution, { kind: 'byos' | 'byok' }>;

/**
 * 032 R7 then 020 R6. First the starter's own subscription: used when the provider is offered,
 * the organisation allows personal accounts, the starter linked one and the model is one it
 * serves; a `needs_reauth` or limited subscription refuses rather than falling through (FR-014),
 * except that a limited one yields to `credential: 'organisation'`. Otherwise the organisation's
 * key; a `needs_reauth` key refuses, and no key is `no-credential` — platform credits, the old
 * fallback, are retired. Secrets are opened only in `forModel` — `kindOnly` is the run-create
 * answer and opens nothing.
 */
@Injectable()
export class CredentialResolver {
  /** The ids a subscription serves (R8); a field so a spec can narrow it. */
  served: Readonly<Record<LlmProviderName, readonly string[]>> = SUBSCRIPTION_MODELS;

  constructor(
    @Inject(ProviderKeyRepository) private readonly keys: ProviderKeyRepository,
    @Inject(DekService) private readonly dek: DekService,
    @Inject(OrgService) private readonly orgs: OrgService,
    @Inject(ByosProviders) private readonly byos: ByosProviders,
    @Inject(LinkedAccountRepository) private readonly linked: LinkedAccountRepository,
    @Inject(ByosTokenService) private readonly tokens: ByosTokenService,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  async forModel(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    model: string,
    options: ResolveOptions = {},
  ): Promise<Resolution> {
    const located = await this.locate(tx, orgId, userId, model, options);

    if (located.kind === 'byos') {
      try {
        return { credential: await this.tokens.current(userId, located.provider), kind: 'byos' };
      } catch (error) {
        if (!(error instanceof SubscriptionFailure)) throw error;
        return {
          accountLabel: located.accountLabel,
          kind: 'subscription-needs-reauth',
          provider: located.provider,
        };
      }
    }

    if (located.kind !== 'byok') {
      return located;
    }

    const { keyId, lastFour, provider, secretId } = located;
    const sealed = await this.keys.sealedSecret(tx, orgId, secretId);

    if (sealed === undefined) {
      return { kind: 'no-credential', provider };
    }

    const secret = await this.dek.openSecret(tx, orgId, purposeFor(provider), sealed);

    return {
      credential: {
        apiKey: revealPlaintext(secret).toString('utf8'),
        keyLastFour: lastFour,
        mode: 'BYOK',
        provider,
      },
      keyId,
      kind: 'byok',
    };
  }

  /** The same decision with no plaintext behind it (run create only refuses or accepts). */
  async kindOnly(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    model: string,
    options: ResolveOptions = {},
  ): Promise<ResolutionKind> {
    const located = await this.locate(tx, orgId, userId, model, options);

    return located.kind === 'byos' || located.kind === 'byok' ? { kind: located.kind } : located;
  }

  private async locate(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    model: string,
    options: ResolveOptions,
  ): Promise<Located> {
    const provider = providerOf(model);

    if (provider === undefined) {
      return { kind: 'unknown-model' };
    }

    const subscription = await this.subscription(tx, orgId, userId, provider, model);

    if (subscription !== undefined) {
      const { accountLabel } = subscription;
      if (subscription.health === 'needs_reauth') {
        return { accountLabel, kind: 'subscription-needs-reauth', provider };
      }
      const limitedUntil = subscription.limitedUntil;
      const limited = limitedUntil !== null && limitedUntil.getTime() > this.clock.now().getTime();
      if (!limited) {
        return { accountLabel, kind: 'byos', provider };
      }
      if (options.credential !== 'organisation') {
        const alternative = await this.organisation(tx, orgId, provider);
        return {
          accountLabel,
          alternativeMode: alternative.kind === 'byok' ? 'BYOK' : null,
          kind: 'subscription-limited',
          provider,
          resetsAt: limitedUntil,
        };
      }
    }

    return this.organisation(tx, orgId, provider);
  }

  /** The starter's linked row when R7 step 1's conditions hold, cheapest check first. */
  private async subscription(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
    provider: LlmProviderName,
    model: string,
  ) {
    if (!this.served[provider].includes(model)) return undefined;
    const row = await this.linked.byProviderOn(tx, userId, provider);
    if (row === undefined) return undefined;
    if (!(await this.byos.offered(provider, tx))) return undefined;
    if (!(await this.orgs.personalAccountsAllowed(tx, orgId))) return undefined;
    return row;
  }

  /** The organisation's key for the provider, or nothing to pay with. */
  private async organisation(
    tx: TenantTransaction,
    orgId: string,
    provider: LlmProviderName,
  ): Promise<Located> {
    const key = await this.keys.byProvider(tx, orgId, provider);

    if (key === undefined) {
      return { kind: 'no-credential', provider };
    }

    return key.health === 'healthy'
      ? { keyId: key.id, kind: 'byok', lastFour: key.lastFour, provider, secretId: key.secretId }
      : { kind: 'needs_reauth', lastFour: key.lastFour, provider };
  }
}
