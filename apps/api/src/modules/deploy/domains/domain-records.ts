import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { CHALLENGE_PREFIX } from './domain.constants';
import { type Domain, DomainRepository } from './domain.repository';
import { ownershipTxtValue } from './ownership-token';

export interface RecordValue {
  readonly name: string;
  readonly content: string;
}

/** The two records a member publishes for a domain (spec 028): ownership TXT and routing CNAME. */
export interface DomainRecords {
  readonly hostname: string;
  readonly projectId: string;
  readonly state: Domain['state'];
  readonly ownership: RecordValue;
  readonly cname: RecordValue;
}

/** The records of one domain row, with the edge's routing target (`''` when domains are off). */
export function recordsOf(row: Domain, target: string | undefined): DomainRecords {
  return {
    cname: { content: target ?? '', name: row.hostname },
    hostname: row.hostname,
    projectId: row.projectId,
    ownership: {
      content: ownershipTxtValue(row.ownershipToken),
      name: `${CHALLENGE_PREFIX}${row.hostname}`,
    },
    state: row.state,
  };
}

/**
 * Spec 030 contracts/provider-adapters.md § 6, § 8: a domain's records, the values
 * `DomainService.toContract` shows, for the Cloudflare connector. Exported by `DeployModule`;
 * `deploy` never imports `connectors`.
 */
@Injectable()
export class DomainRecordsReader {
  private readonly target: string | undefined;

  constructor(
    @Inject(DomainRepository) private readonly domains: DomainRepository,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.target = config.get('CUSTOM_HOSTNAME_TARGET', { infer: true });
  }

  /** `undefined` when the domain is not the organisation's, or is `removed`. */
  async records(
    tx: TenantTransaction,
    orgId: string,
    domainId: string,
  ): Promise<DomainRecords | undefined> {
    const row = await this.domains.findInOrg(tx, orgId, domainId);

    return row === undefined ? undefined : recordsOf(row, this.target);
  }
}
