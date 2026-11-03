import { Inject, Injectable } from '@nestjs/common';
import type { ConnectorResource } from '@repo/db';

import type { Plaintext } from '../../common/crypto/branded';
import { DekService } from '../../common/crypto/dek.service';
import type { TenantTransaction } from '../../database/database.types';
import { ConnectionRepository } from './connection.repository';

/**
 * The purpose each value-carrying resource is sealed under (data-model § 6). The purpose is part
 * of the AEAD's associated data: a value sealed for one kind never opens as another.
 */
export const RESOURCE_SECRET_PURPOSES = {
  neon_branch: 'connector:neon:branch-uri',
  resend_sending_key: 'connector:resend:sending-key',
  supabase_publishable_key: 'connector:supabase:publishable-key',
} as const satisfies Partial<Record<ConnectorResource['kind'], string>>;

export type ValueResourceKind = keyof typeof RESOURCE_SECRET_PURPOSES;

/**
 * Seals and opens a resource's value (a branch URI, a publishable or sending key) as a `secrets`
 * row. Only the ops handlers seal; only `PREVIEW_ENV_SOURCE` opens (data-model § 6).
 */
@Injectable()
export class ResourceSecrets {
  constructor(
    @Inject(DekService) private readonly dek: DekService,
    @Inject(ConnectionRepository) private readonly repository: ConnectionRepository,
  ) {}

  async seal(
    tx: TenantTransaction,
    orgId: string,
    kind: ValueResourceKind,
    value: Plaintext,
  ): Promise<string> {
    const purpose = RESOURCE_SECRET_PURPOSES[kind];
    const sealed = await this.dek.sealSecret(tx, orgId, purpose, value);

    return this.repository.insertSecret(tx, orgId, purpose, sealed);
  }

  /** The value, or undefined when the row is gone. Throws when it does not open. */
  async open(
    tx: TenantTransaction,
    orgId: string,
    kind: ValueResourceKind,
    secretId: string,
  ): Promise<Plaintext | undefined> {
    const row = await this.repository.sealedSecret(tx, orgId, secretId);

    return row === undefined
      ? undefined
      : this.dek.openSecret(tx, orgId, RESOURCE_SECRET_PURPOSES[kind], row);
  }

  async delete(tx: TenantTransaction, orgId: string, secretId: string | null): Promise<void> {
    await this.repository.deleteSecret(tx, orgId, secretId);
  }
}
