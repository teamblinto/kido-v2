/**
 * An endpoint's signing secret (spec 029 research R10): `whsec_` plus base64url of 32 random bytes,
 * sealed per organisation through `DekService` under `SECRET_PURPOSE`, which is bound into the AAD
 * with the org, so it opens as nothing else. It is held as `Plaintext` from generation to the
 * signature and is never logged; the create (and later rotate) response is the one place it is
 * revealed.
 */
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { plaintext, type Plaintext } from '../../../common/crypto/branded';
import { DekService } from '../../../common/crypto/dek.service';
import type { TenantTransaction } from '../../../database/database.types';
import { SECRET_PURPOSE } from '../webhooks.constants';
import { type EndpointRow, EndpointRepository } from './endpoint.repository';

const SECRET_PREFIX = 'whsec_';
const SECRET_BYTES = 32;

@Injectable()
export class SigningSecrets {
  constructor(
    @Inject(DekService) private readonly dek: DekService,
    @Inject(EndpointRepository) private readonly endpoints: EndpointRepository,
  ) {}

  generate(): Plaintext {
    return plaintext(`${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`);
  }

  /** Seals `secret` into a new `secrets` row of the org; returns its id. */
  async seal(tx: TenantTransaction, orgId: string, secret: Plaintext): Promise<string> {
    const sealed = await this.dek.sealSecret(tx, orgId, SECRET_PURPOSE, secret);
    return this.endpoints.insertSecret(tx, orgId, SECRET_PURPOSE, sealed);
  }

  /**
   * The secrets that sign now, newest first: the current one, and the previous one while its
   * rotation overlap has not expired at `now`.
   */
  async openLive(
    tx: TenantTransaction,
    endpoint: Pick<
      EndpointRow,
      'orgId' | 'previousSecretExpiresAt' | 'previousSecretId' | 'secretId'
    >,
    now: Date,
  ): Promise<Plaintext[]> {
    const ids = [endpoint.secretId];
    if (
      endpoint.previousSecretId !== null &&
      endpoint.previousSecretExpiresAt !== null &&
      endpoint.previousSecretExpiresAt.getTime() > now.getTime()
    ) {
      ids.push(endpoint.previousSecretId);
    }

    const opened: Plaintext[] = [];
    for (const id of ids) {
      const row = await this.endpoints.sealedSecret(tx, endpoint.orgId, id);
      if (row === undefined) throw new Error(`webhook signing secret ${id} is missing`);
      opened.push(await this.dek.openSecret(tx, endpoint.orgId, SECRET_PURPOSE, row));
    }
    return opened;
  }
}
