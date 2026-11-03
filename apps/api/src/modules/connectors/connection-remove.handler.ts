import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConnectorResource } from '@repo/db';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { Plaintext } from '../../common/crypto/branded';
import { ConnectionService } from './connection.service';
import type { OperationContext, OperationHandler } from './connector-ops.consumer';
import { ProviderFailure } from './providers/provider';
import { ResourceRepository } from './resource.repository';

/**
 * One resource kind's release at its provider. A `404` is success (already gone) and is the
 * releaser's to swallow; a {@link ProviderFailure} is retried or left `failed` by the handler.
 */
export interface ResourceReleaser {
  release(credential: Plaintext, resource: ConnectorResource): Promise<void>;
}

export type ResourceReleasers = ReadonlyMap<ConnectorResource['kind'], ResourceReleaser>;

/**
 * Per resource kind; empty until the stories that create resources register theirs (Neon branch —
 * T058, Resend key — T076, Cloudflare record — T096). GitHub creates none.
 */
export const RESOURCE_RELEASERS = Symbol('forge.connectors.resourceReleasers');

/**
 * `connection_remove` (spec 030 contracts/provider-adapters.md § 7): every live resource of the
 * connection is released **with the credential still sealed**, then the provider revoke
 * (Supabase's grant, GitHub's installation), then the secret and the row are deleted, bindings
 * left `disconnected`, and `connector.removed` audited naming any resource left `failed`.
 *
 * A retryable release failure retries the whole job (released rows are not touched again); on the
 * last attempt, or on a terminal failure, that resource is left `failed` and the removal completes.
 */
@Injectable()
export class ConnectionRemoveHandler implements OperationHandler {
  private readonly logger = new Logger(ConnectionRemoveHandler.name);

  constructor(
    @Inject(ConnectionService) private readonly connections: ConnectionService,
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
    const { orgId } = connection;
    const live = await inTenant((tx) => this.resources.listLive(tx, orgId, connection.id));
    const failed: { kind: string; name: string }[] = [];

    for (const resource of live) {
      if (resource.state === 'live') {
        await inTenant((tx) => this.resources.transition(tx, orgId, resource.id, 'releasing'));
      }

      const releaser = this.releasers.get(resource.kind);

      try {
        if (releaser === undefined) throw new ProviderFailure('validation');
        await releaser.release(credential, resource);
      } catch (error) {
        if (!(error instanceof ProviderFailure)) throw error;
        if (error.retryable && !lastAttempt) throw error;

        this.logger.warn(`resource ${resource.id} not released [category=${error.category}]`);
        await inTenant((tx) => this.resources.transition(tx, orgId, resource.id, 'failed'));
        failed.push({ kind: resource.kind, name: resource.name });
        continue;
      }

      await inTenant((tx) =>
        this.resources.transition(tx, orgId, resource.id, 'released', {
          releasedAt: this.clock.now(),
        }),
      );
    }

    await this.connections.revokeAtProvider(connection, credential);
    await inTenant((tx) =>
      this.connections.finishRemoval(tx, connection, operation.requestedBy, failed),
    );
  }
}
