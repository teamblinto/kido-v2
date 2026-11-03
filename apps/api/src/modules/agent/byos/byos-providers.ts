import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_PROVIDERS } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';

import type { Environment } from '../../../config/environment';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import type { LlmProviderName } from '../llm-provider.port';
import { type ByosClientConfig, byosClientConfig } from './byos-config';

/**
 * The provider gate's read side (spec 032 research R12). A provider is offered iff its
 * `byos_providers` row is `in_force` **and** its `BYOS_<P>_*` set is complete: the row
 * is the switch, the configuration is the means. `byos_providers` is a platform table, so
 * the read goes through `APP_DATABASE` with no tenant scope, once per call — a withdrawal takes
 * effect for the next caller, not the next deploy.
 */
@Injectable()
export class ByosProviders {
  constructor(
    @Inject(APP_DATABASE) private readonly database: ForgeDatabase,
    @Inject(ConfigService) private readonly config: ConfigService<Environment, true>,
  ) {}

  /** The provider's client configuration, or `undefined` when its set is absent. */
  configuration(provider: LlmProviderName): ByosClientConfig | undefined {
    return byosClientConfig(
      (key) => this.config.get(key as keyof Environment, { infer: true }),
      provider,
    );
  }

  /** `on`: a transaction the caller already holds, so no second connection is taken. */
  async offered(provider: LlmProviderName, on?: TenantTransaction): Promise<boolean> {
    if (this.configuration(provider) === undefined) return false;
    const [row] = await (on ?? this.database)
      .select({ status: schema.byosProviders.status })
      .from(schema.byosProviders)
      .where(eq(schema.byosProviders.provider, provider))
      .limit(1);
    return row?.status === 'in_force';
  }

  async offeredList(on?: TenantTransaction): Promise<LlmProviderName[]> {
    const configured = LLM_PROVIDERS.filter(
      (provider) => this.configuration(provider) !== undefined,
    );
    if (configured.length === 0) return [];
    const rows = await (on ?? this.database)
      .select({ provider: schema.byosProviders.provider })
      .from(schema.byosProviders)
      .where(eq(schema.byosProviders.status, 'in_force'));
    const inForce = new Set(rows.map((row) => row.provider));
    return configured.filter((provider) => inForce.has(provider));
  }

  /** The subscription profile for the adapters (R9); headers stay empty until a sheet names some. */
  endpoint(
    provider: LlmProviderName,
  ): { baseURL: string; headers: Readonly<Record<string, string>> } | undefined {
    const configuration = this.configuration(provider);
    return configuration === undefined
      ? undefined
      : { baseURL: configuration.apiBaseUrl, headers: {} };
  }

  /**
   * The operator command's write (T018), on the caller's transaction so a withdrawal and its mail
   * events commit together. `in_force` upserts the sign-off; `withdrawn` stamps an existing row and
   * answers `false` when there was none (nothing was ever offered, so nothing is withdrawn).
   */
  async setStatus(
    tx: TenantTransaction,
    provider: LlmProviderName,
    change:
      | { readonly status: 'in_force'; readonly record: string; readonly signedOffAt: Date }
      | { readonly status: 'withdrawn'; readonly at: Date },
  ): Promise<boolean> {
    const table = schema.byosProviders;
    if (change.status === 'in_force') {
      const values = {
        record: change.record,
        signedOffAt: change.signedOffAt,
        status: 'in_force' as const,
        withdrawnAt: null,
      };
      await tx
        .insert(table)
        .values({ provider, ...values })
        .onConflictDoUpdate({ set: values, target: table.provider });
      return true;
    }
    const rows = await tx
      .update(table)
      .set({ status: 'withdrawn', withdrawnAt: change.at })
      .where(eq(table.provider, provider))
      .returning({ provider: table.provider });
    return rows.length > 0;
  }
}
