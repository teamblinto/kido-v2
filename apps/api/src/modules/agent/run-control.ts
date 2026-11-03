import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { QUEUE_REDIS } from '../../common/redis/redis.constants';
import { RUN_PROFILES_TOKEN } from '../../common/run-profiles/run-profiles.constants';
import type { RunProfile } from '../../config/run-profiles';

/** Names the subscriber in `CLIENT LIST`, so a stray one traces back here rather than to "a worker". */
export const RUN_CONTROL_CONNECTION = 'forge-queue-run-control';

const PATTERN = 'run:*:control';

/**
 * The cancel fast path (spec 008 research R7, FR-021): the request publishes on
 * `run:{id}:control` after its transaction commits, and every worker process holds one
 * `duplicate()`d subscriber on the pattern — a subscribed ioredis client can do nothing else, so
 * the shared queue client cannot be it. `seen` is what the executor's `cancelled()` asks first;
 * the row flag is the truth it falls back to, so a message this process missed costs one row read
 * at the next boundary, never a run that fails to stop.
 *
 * The `agent` profile holds runs, so it holds the subscriber (spec 013 R2).
 * ponytail: the seen set only ever grows by one id per cancel published anywhere; the consumer
 * forgets the runs it finished, and the rest is a uuid per cancelled run for the process lifetime.
 */
@Injectable()
export class RunControl implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RunControl.name);
  private readonly enabled: boolean;
  private readonly cancels = new Set<string>();
  private subscriber: Redis | undefined;

  constructor(
    @Inject(QUEUE_REDIS) private readonly redis: Redis,
    @Inject(RUN_PROFILES_TOKEN) profiles: ReadonlySet<RunProfile>,
  ) {
    this.enabled = profiles.has('agent');
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const subscriber = this.redis.duplicate({ connectionName: RUN_CONTROL_CONNECTION });

    subscriber.on('error', (error: Error) => this.logger.warn(error.message));
    subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
      if (message === 'cancel') {
        this.cancels.add(channel.slice('run:'.length, -':control'.length));
      }
    });
    this.subscriber = subscriber;
    await subscriber.psubscribe(PATTERN);
  }

  onApplicationShutdown(): Promise<void> {
    return this.close();
  }

  /** Fire and forget from the caller's point of view: the row flag is already committed. */
  async publish(runId: string, command: 'cancel'): Promise<void> {
    await this.redis.publish(`run:${runId}:control`, command);
  }

  /** Whether a cancel for this run has crossed the channel since this process subscribed. */
  seen(runId: string): boolean {
    return this.cancels.has(runId);
  }

  /** The consumer is done with the run; its flag is on the row for whoever asks next. */
  forget(runId: string): void {
    this.cancels.delete(runId);
  }

  async close(): Promise<void> {
    const subscriber = this.subscriber;

    this.subscriber = undefined;

    if (subscriber !== undefined && subscriber.status !== 'end') {
      await subscriber.quit();
    }
  }
}
