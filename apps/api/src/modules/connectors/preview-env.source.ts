import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema } from '@repo/db';
import { and, eq, ne } from 'drizzle-orm';

import { revealPlaintext } from '../../common/crypto/branded';
import type { TenantTransaction } from '../../database/database.types';
import {
  PREVIEW_ENV_KEYS,
  type PreviewEnvKey,
  type PreviewEnvSource,
} from '../sandbox/sandbox.constants';
import {
  RESOURCE_SECRET_PURPOSES,
  ResourceSecrets,
  type ValueResourceKind,
} from './resource-secrets';

/** contracts/preview-env.md § 2: one line, no NUL, at most 4 096 bytes. */
const VALUE_PATTERN = /^[^\r\n\0]*$/u;
const MAX_VALUE_BYTES = 4096;

type Values = Partial<Record<PreviewEnvKey, string>>;

function isValueKind(kind: string): kind is ValueResourceKind {
  return kind in RESOURCE_SECRET_PURPOSES;
}

/** The keys one live resource contributes, from its opened value and its binding's config. */
function contribution(
  kind: ValueResourceKind,
  value: string,
  config: Record<string, unknown>,
): Values {
  switch (kind) {
    case 'neon_branch':
      return { DATABASE_URL: value };
    case 'supabase_publishable_key': {
      const url = `https://${String(config.projectRef)}.supabase.co`;

      return {
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: value,
        NEXT_PUBLIC_SUPABASE_URL: url,
        SUPABASE_PUBLISHABLE_KEY: value,
        SUPABASE_URL: url,
        VITE_SUPABASE_PUBLISHABLE_KEY: value,
        VITE_SUPABASE_URL: url,
      };
    }
    case 'resend_sending_key':
      return { RESEND_API_KEY: value, RESEND_FROM_DOMAIN: String(config.domainName) };
  }
}

/**
 * `PREVIEW_ENV_SOURCE` (spec 030 contracts/preview-env.md § 3): the project's bound bindings on
 * connections that are not `needs_reauth`, their `live` resources, each sealed value opened in
 * this call only. Emits only {@link PREVIEW_ENV_KEYS}; drops (and names by key only) any value
 * that is not one line of at most 4 096 bytes. Never calls a provider and never throws: a failing
 * binding contributes `{}`, a failure outside any binding yields `{}` (FR-009).
 */
@Injectable()
export class PreviewEnvReader {
  private readonly logger = new Logger(PreviewEnvReader.name);

  constructor(@Inject(ResourceSecrets) private readonly secrets: ResourceSecrets) {}

  readonly source: PreviewEnvSource = async (tx, orgId, projectId) => {
    try {
      // A savepoint: a failed statement here must not abort the caller's transaction.
      return await tx.transaction((savepoint) => this.read(savepoint, orgId, projectId));
    } catch (error) {
      this.logger.warn(
        `preview env for project ${projectId} unavailable: ${(error as Error).name}`,
      );

      return {};
    }
  };

  private async read(tx: TenantTransaction, orgId: string, projectId: string): Promise<Values> {
    const rows = await tx
      .select({
        bindingId: schema.connectorBindings.id,
        config: schema.connectorBindings.config,
        kind: schema.connectorResources.kind,
        secretId: schema.connectorResources.secretId,
      })
      .from(schema.connectorBindings)
      .innerJoin(
        schema.connections,
        and(
          eq(schema.connections.orgId, schema.connectorBindings.orgId),
          eq(schema.connections.id, schema.connectorBindings.connectionId),
        ),
      )
      .innerJoin(
        schema.connectorResources,
        and(
          eq(schema.connectorResources.orgId, schema.connectorBindings.orgId),
          eq(schema.connectorResources.bindingId, schema.connectorBindings.id),
        ),
      )
      .where(
        and(
          eq(schema.connectorBindings.orgId, orgId),
          eq(schema.connectorBindings.projectId, projectId),
          eq(schema.connectorBindings.state, 'bound'),
          ne(schema.connections.health, 'needs_reauth'),
          eq(schema.connectorResources.state, 'live'),
        ),
      );
    const out: Values = {};

    for (const row of rows) {
      if (row.secretId === null || !isValueKind(row.kind)) continue;

      let values: Values;

      try {
        const opened = await tx.transaction((savepoint) =>
          this.secrets.open(savepoint, orgId, row.kind as ValueResourceKind, row.secretId!),
        );

        if (opened === undefined) continue;
        values = contribution(row.kind, revealPlaintext(opened).toString('utf8'), row.config);
      } catch (error) {
        this.logger.warn(`binding ${row.bindingId} contributes nothing: ${(error as Error).name}`);
        continue;
      }

      for (const [key, value] of Object.entries(values) as [PreviewEnvKey, string][]) {
        if (!(PREVIEW_ENV_KEYS as readonly string[]).includes(key)) continue;

        if (!VALUE_PATTERN.test(value) || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
          this.logger.warn(`preview env value dropped [key=${key}]`);
          continue;
        }

        out[key] = value;
      }
    }

    return out;
  }
}
