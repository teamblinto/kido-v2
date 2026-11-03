import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConnectorResource } from '@repo/db';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { TenantTransaction } from '../../database/database.types';
import { RESOURCE_RELEASERS, type ResourceReleasers } from './connection-remove.handler';
import type { OperationContext, OperationHandler } from './connector-ops.consumer';
import { ProviderFailure } from './providers/provider';
import { ResourceRepository } from './resource.repository';

/**
 * `resource_release` (spec 030 contracts/provider-adapters.md § 7): the live resources the
 * operation names — a domain's DNS records (`domain_id`), a binding's resources (`binding_id`), or
 * one resource (`resource_id`) — each moved to `releasing`, released through its kind's
 * {@link ResourceReleaser}, and closed `released`. Only resources of the operation's connection are
 * touched. A retryable failure retries the job (released rows are not touched again); on the last
 * attempt, or on a terminal failure, that resource is left `failed` and the rest still released.
 */
@Injectable()
export class ResourceReleaseHandler implements OperationHandler {
  private readonly logger = new Logger(ResourceReleaseHandler.name);

  constructor(
    @Inject(ResourceRepository) private readonly resources: ResourceRepository,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(RESOURCE_RELEASERS) private readonly releasers: ResourceReleasers,
  ) {}

  async run({
    connection,
    credential,
    inTenant,
    lastAttempt,
    operation,
  }: OperationContext): Promise<void> {
    const { orgId } = operation;
    const targets = await inTenant((tx) => this.targets(tx, operation));

    for (const resource of targets.filter((row) => row.connectionId === connection.id)) {
      if (resource.state === 'live') {
        await inTenant((tx) => this.resources.transition(tx, orgId, resource.id, 'releasing'));
      }

      try {
        const releaser = this.releasers.get(resource.kind);
        if (releaser === undefined) throw new ProviderFailure('validation');
        await releaser.release(credential, resource);
      } catch (error) {
        if (!(error instanceof ProviderFailure)) throw error;
        if (error.retryable && !lastAttempt) throw error;

        this.logger.warn(`resource ${resource.id} not released [category=${error.category}]`);
        await inTenant((tx) => this.resources.transition(tx, orgId, resource.id, 'failed'));
        continue;
      }

      await inTenant((tx) =>
        this.resources.transition(tx, orgId, resource.id, 'released', {
          releasedAt: this.clock.now(),
        }),
      );
    }
  }

  private async targets(
    tx: TenantTransaction,
    operation: OperationContext['operation'],
  ): Promise<ConnectorResource[]> {
    const { orgId } = operation;

    if (operation.domainId !== null) {
      const rows = await this.resources.listForDomain(tx, orgId, operation.domainId, {
        liveOnly: true,
      });

      return rows.filter((row) => row.kind === 'cloudflare_dns_record');
    }

    if (operation.bindingId !== null) {
      return this.resources.listForBinding(tx, orgId, operation.bindingId, { liveOnly: true });
    }

    if (operation.resourceId !== null) {
      const row = await this.resources.byId(tx, orgId, operation.resourceId);

      return row === undefined ? [] : [row];
    }

    return [];
  }
}
