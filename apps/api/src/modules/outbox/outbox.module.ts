import {
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { RUN_PROFILES_TOKEN } from '../../common/run-profiles/run-profiles.constants';
import { hasWorkerProfile, type RunProfile } from '../../config/run-profiles';

import { ConsumerBase } from './consumer-base';
import { OutboxWriter } from './outbox-writer';
import { EVENT_CONSUMERS } from './outbox.constants';
import { QueueRegistry } from './queue-registry';
import { OutboxRelay } from './relay';

/**
 * The transactional outbox: the writer producers append through, the relay that publishes what
 * they wrote, and the queues consumers drain (§10).
 *
 * Consumers are discovered (spec 006, research R6): a module lists its `EventConsumer` as an
 * ordinary provider and `QueueRegistry` finds it through `DiscoveryService`, so this module imports
 * no other and the root wires nothing. The `useValue: []` under `EVENT_CONSUMERS` stays for the
 * e2e suites that override it with a probe — Nest has no multi-provider.
 *
 * Only the writer leaves the module. The relay, the queues and the consumer base are wiring a
 * producer never sees; `OutboxWriter` and `EventConsumer` are the whole surface (FR-025).
 */
@Module({
  exports: [OutboxWriter],
  imports: [DiscoveryModule],
  providers: [
    { provide: EVENT_CONSUMERS, useValue: [] },
    ConsumerBase,
    OutboxRelay,
    OutboxWriter,
    QueueRegistry,
  ],
})
export class OutboxModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly registry: QueueRegistry,
    private readonly relay: OutboxRelay,
    @Inject(RUN_PROFILES_TOKEN) private readonly profiles: ReadonlySet<RunProfile>,
  ) {}

  /**
   * Queues at bootstrap rather than construction, so compiling the application is not a Redis
   * connection. Nothing at all without a worker profile (spec 013 R2/R3): an `api`-only process
   * appends and leaves the rows for one that relays — the test suites, which share one outbox
   * table across parallel workers, and the worker service. Otherwise the profile set says which
   * queues this process drains: every queue and DLQ is built, a worker only where the queue's
   * consumer declared a profile in the set, and the `events` profile relays — publishing to every
   * queue, including the ones another process drains.
   */
  onApplicationBootstrap(): void {
    if (!hasWorkerProfile(this.profiles)) {
      return;
    }

    this.registry.build(this.profiles);

    if (this.profiles.has('events')) {
      this.relay.start(this.registry.publish);
    }
  }

  /** The relay first, so nothing is published to a queue that is closing. */
  async onApplicationShutdown(): Promise<void> {
    await this.relay.stop();
    await this.registry.close();
  }
}
