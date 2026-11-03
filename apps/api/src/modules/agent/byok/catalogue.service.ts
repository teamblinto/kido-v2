import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CatalogueEntry,
  type CatalogueModel,
  MODEL_CATALOGUE,
  type ModelCatalogueResponse,
  SUBSCRIPTION_MODELS,
} from '@repo/contracts';

import type { LinkedAccountRow } from '@repo/db';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { OrgService } from '../../tenancy/services/org.service';
import { PLATFORM_PROVIDER } from '../agent.constants';
import { ByosProviders } from '../byos/byos-providers';
import { LinkedAccountRepository } from '../byos/linked-account.repository';
import type { LlmProviderName } from '../llm-provider.port';
import { PlatformCredentials } from '../platform-credentials';
import { ProviderKeyRepository } from './provider-key.repository';

/**
 * The per-organisation catalogue (spec 020 § 2, research R8), per caller since 032 R8: an entry
 * the caller's own subscription would pay for (R7 step 1) is `BYOS` — unavailable behind a
 * `needs_reauth` subscription, and carrying `limitedUntil` and the organisation's alternative while
 * limited. Otherwise 020: the platform provider's models are always listed — `PLATFORM` unless the
 * organisation holds its own key for that provider — and another provider's models only while a
 * key for it exists. `available` is false behind a `needs_reauth` key, or for the platform
 * provider when no platform credential is configured. `default` is `AGENT_DEFAULT_MODEL` when
 * available, else the first available entry.
 */
@Injectable()
export class CatalogueService {
  private readonly defaultModel: string;

  constructor(
    @Inject(ConfigService) config: ConfigService<Environment, true>,
    @Inject(ProviderKeyRepository) private readonly keys: ProviderKeyRepository,
    @Inject(PlatformCredentials) private readonly platform: PlatformCredentials,
    @Inject(OrgService) private readonly orgs: OrgService,
    @Inject(ByosProviders) private readonly byos: ByosProviders,
    @Inject(LinkedAccountRepository) private readonly linked: LinkedAccountRepository,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {
    this.defaultModel = config.get('AGENT_DEFAULT_MODEL', { infer: true });
  }

  async forOrg(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
  ): Promise<ModelCatalogueResponse> {
    const health = new Map(
      (await this.keys.forOrg(tx, orgId)).map((key) => [key.provider, key.health]),
    );
    const subscriptions = await this.subscriptions(tx, orgId, userId);
    const models: CatalogueModel[] = [];

    for (const entry of MODEL_CATALOGUE) {
      const own = subscriptions.get(entry.provider);
      const byos =
        own !== undefined && SUBSCRIPTION_MODELS[entry.provider].includes(entry.id)
          ? this.subscriptionEntry(entry, own, health)
          : undefined;
      const organisation = this.organisationEntry(entry, health);
      const chosen = byos ?? organisation;

      if (chosen !== undefined) models.push(chosen);
    }

    const available = models.filter((model) => model.available).map((model) => model.id);

    return {
      default: available.includes(this.defaultModel)
        ? this.defaultModel
        : (available[0] ?? this.defaultModel),
      models,
    };
  }

  /** The caller's linked rows that R7 step 1 would consider, by provider. */
  private async subscriptions(
    tx: TenantTransaction,
    orgId: string,
    userId: string,
  ): Promise<Map<LlmProviderName, LinkedAccountRow>> {
    const rows = await this.linked.listOn(tx, userId);
    if (rows.length === 0) return new Map();
    const [offered, allowed] = await Promise.all([
      this.byos.offeredList(tx),
      this.orgs.personalAccountsAllowed(tx, orgId),
    ]);
    if (!allowed) return new Map();
    return new Map(
      rows.filter((row) => offered.includes(row.provider)).map((row) => [row.provider, row]),
    );
  }

  private subscriptionEntry(
    entry: CatalogueEntry,
    own: Pick<LinkedAccountRow, 'health' | 'limitedUntil'>,
    health: Map<LlmProviderName, string>,
  ): CatalogueModel {
    if (own.health === 'needs_reauth') {
      return {
        ...entry,
        available: false,
        credentialMode: 'BYOS',
        unavailableReason: 'subscription-needs-reauth',
      };
    }
    const limited =
      own.limitedUntil !== null && own.limitedUntil.getTime() > this.clock.now().getTime();
    if (!limited) return { ...entry, available: true, credentialMode: 'BYOS' };

    const alternative = this.organisationEntry(entry, health);
    return {
      ...entry,
      ...(alternative?.available === true && alternative.credentialMode !== 'BYOS'
        ? { alternativeMode: alternative.credentialMode }
        : {}),
      available: true,
      credentialMode: 'BYOS',
      limitedUntil: own.limitedUntil!.toISOString(),
    };
  }

  /** 020's entry, or `undefined` when the organisation cannot run this provider at all. */
  private organisationEntry(
    entry: CatalogueEntry,
    health: Map<LlmProviderName, string>,
  ): CatalogueModel | undefined {
    const key = health.get(entry.provider);

    if (key !== undefined) {
      return key === 'healthy'
        ? { ...entry, available: true, credentialMode: 'BYOK' }
        : {
            ...entry,
            available: false,
            credentialMode: 'BYOK',
            unavailableReason: 'key-needs-reauth',
          };
    }
    if (entry.provider === PLATFORM_PROVIDER) {
      return {
        ...entry,
        available: this.platform.context() !== undefined,
        credentialMode: 'PLATFORM',
      };
    }
    return undefined;
  }
}
