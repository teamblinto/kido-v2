import { Inject, Injectable, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Queue, Worker, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { QUEUE_REDIS } from '../../common/redis/redis.constants';
import type { RunProfile } from '../../config/run-profiles';
import { fullJitter } from './backoff';
import { EventConsumer } from './consumer';
import { ConsumerBase } from './consumer-base';
import { attachDeadLetter, type DeadLetterQueue } from './dead-letter';
import type { Envelope } from './envelope';
import type { EventType } from './events';
import { EVENT_CONSUMERS, JOB_RETENTION } from './outbox.constants';
import type { Publish } from './relay';

type EventQueue = Queue<Envelope, void, EventType>;

/**
 * The two intervals a stall is measured in. Shipped workers keep BullMQ's 30 s for both (research
 * R6); the poison suite shortens them so two stalls cost seconds, not a minute.
 */
export type WorkerTimings = Pick<WorkerOptions, 'lockDuration' | 'stalledInterval'>;

/** One queue an event type reaches, with the budget of the consumer that drains it there. */
interface Route {
  readonly attempts: number;
  readonly consumer: EventConsumer;
  readonly queue: EventQueue;
}

/**
 * The queues, built from the registered consumers at bootstrap (research R11, contract § Queues).
 *
 * Per distinct `consumer.queue`: one `Queue`, one `Queue` named `<queue>.dlq` with no worker (the
 * `failed` listener writes it — R7), and one `Worker` whose processor finds the consumer by
 * `job.name`, which is the event type, and runs the base. The relay's routing table is derived
 * from the same registration, so the relay cannot publish to a queue nobody drains.
 *
 * Every queue and worker shares the `QUEUE_REDIS` client; BullMQ duplicates it for each worker's
 * blocking connection, which is why that client has no per-request retry cap (R2).
 *
 * Consumers come from two places (spec 006, research R6): any provider in the application that is
 * an `EventConsumer`, found through `DiscoveryService` so a module registers its consumer as an
 * ordinary provider and `outbox` imports nothing; and the `EVENT_CONSUMERS` token, kept for the
 * e2e suites that override it with a probe.
 */
@Injectable()
export class QueueRegistry {
  private readonly logger = new Logger(QueueRegistry.name);
  private readonly routes = new Map<EventType, Route[]>();
  private readonly unrouted = new Set<string>();

  /** By name — `<queue>` and `<queue>.dlq` alike; the DLQ has no worker. */
  readonly queues = new Map<string, DeadLetterQueue | EventQueue>();
  readonly workers: Worker<Envelope, void, EventType>[] = [];

  constructor(
    @Inject(EVENT_CONSUMERS) private readonly consumers: readonly EventConsumer[],
    @Inject(QUEUE_REDIS) private readonly connection: Redis,
    @Inject(CLOCK) private readonly clock: ClockPort,
    private readonly base: ConsumerBase,
    private readonly discovery: DiscoveryService,
  ) {}

  /**
   * Every queue and its DLQ, whatever the profile — the relay publishes to all of them from the
   * `events` process; a worker only where the queue's profile is in the set (spec 013 R3).
   */
  build(profiles: ReadonlySet<RunProfile>): void {
    const byQueue = new Map<string, EventConsumer[]>();
    const discovered = this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter((instance): instance is EventConsumer => instance instanceof EventConsumer);

    for (const consumer of [...this.consumers, ...discovered]) {
      byQueue.set(consumer.queue, [...(byQueue.get(consumer.queue) ?? []), consumer]);
    }

    for (const [name, consumers] of byQueue) {
      const claimed = [...new Set(consumers.map((consumer) => consumer.profile))];
      const [profile] = claimed;

      if (profile === undefined || claimed.length > 1) {
        throw new Error(`queue "${name}" is claimed by two profiles: ${claimed.join(', ')}`);
      }

      const queue = this.queue<EventQueue>(name);
      this.queue<DeadLetterQueue>(`${name}.dlq`);

      for (const consumer of consumers) {
        for (const type of consumer.types) {
          this.routes.set(type, [
            ...(this.routes.get(type) ?? []),
            { attempts: consumer.attempts, consumer, queue },
          ]);
        }
      }

      if (profiles.has(profile)) {
        this.workers.push(this.createWorker(consumers));
      }
    }
  }

  /**
   * One worker on the queue `consumers` share, with the processor, the strategy and the
   * dead-letter listener every worker carries; the queue and its DLQ are opened once and reused.
   * Public, with the timings open, for one caller: the poison suite (US4) builds workers on the
   * probe queue with a short lock and closes them mid-job to stand in for a crash (research R6).
   * Not pushed onto `workers` — what a caller builds, the caller closes.
   */
  createWorker(
    consumers: readonly EventConsumer[],
    timings: WorkerTimings = {},
  ): Worker<Envelope, void, EventType> {
    const [first] = consumers;

    if (first === undefined || consumers.some((consumer) => consumer.queue !== first.queue)) {
      throw new Error('A worker drains one queue; every consumer given must name it.');
    }

    const name = first.queue;
    const queue = this.queue<EventQueue>(name);
    const dlq = this.queue<DeadLetterQueue>(`${name}.dlq`);
    const handlers = new Map<EventType, EventConsumer>();

    for (const consumer of consumers) {
      for (const type of consumer.types) {
        // A job has one name and reaches one handler; two consumers of the same type on one
        // queue would silently drop one of them. Refused at boot rather than at the first event.
        if (handlers.has(type)) {
          throw new Error(`Two consumers on queue "${name}" both take "${type}".`);
        }

        handlers.set(type, consumer);
      }
    }

    const worker = new Worker<Envelope, void, EventType>(
      name,
      (job) => {
        const consumer = handlers.get(job.name);

        if (consumer === undefined) {
          throw new Error(`No consumer on queue "${name}" takes "${job.name}".`);
        }

        return this.base.processJob(consumer, job);
      },
      {
        // The lowest asked for, so a consumer that kept the default of 1 keeps its order.
        concurrency: Math.min(...consumers.map((consumer) => consumer.concurrency)),
        connection: this.connection,
        // The first consumer's, when it names one: a stall budget is a property of the job that
        // stalls, and the queues that share a worker today have one consumer each.
        ...(first.maxStalledCount === undefined ? {} : { maxStalledCount: first.maxStalledCount }),
        settings: { backoffStrategy: fullJitter },
        ...timings,
      },
    );

    worker.on('error', (error) => this.logger.warn(`worker ${name}: ${error.message}`));
    attachDeadLetter(worker, queue, dlq, this.clock, this.logger);

    return worker;
  }

  /**
   * What the relay calls per row: one job per routed queue, named by the type, carrying the
   * envelope, with the event id as job id so a republish is a no-op (R4) — unless the consumer
   * names its own (`jobId`, spec 006 R3), in which case that is the deduplication key. An
   * unrouted type is a `warn` once — the row is still marked published, because there is nothing
   * to hold it for.
   */
  readonly publish: Publish = async (envelope) => {
    const routes = this.routes.get(envelope.type) ?? [];

    if (routes.length === 0) {
      if (!this.unrouted.has(envelope.type)) {
        this.unrouted.add(envelope.type);
        this.logger.warn(`no consumer registered for "${envelope.type}"; marking published`);
      }

      return;
    }

    for (const { attempts, consumer, queue } of routes) {
      await queue.add(envelope.type, envelope, {
        attempts,
        backoff: { type: 'full-jitter' },
        jobId: consumer.jobId?.(envelope) ?? envelope.eventId,
        ...JOB_RETENTION,
      });
    }
  };

  /** Workers first, so no job is taken after its queue is gone. */
  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }

  /** The queue by name, opened on first use: one `Queue` per name, however many workers drain it. */
  private queue<Q extends DeadLetterQueue | EventQueue>(name: string): Q {
    const open = this.queues.get(name) as Q | undefined;

    if (open !== undefined) {
      return open;
    }

    const queue = new Queue(name, { connection: this.connection }) as Q;

    // As in `redis.module.ts`: an `error` with no listener is an unhandled error, and the health
    // indicator on the same client is the signal that matters.
    queue.on('error', (error) => this.logger.warn(`queue ${name}: ${error.message}`));
    this.queues.set(name, queue);

    return queue;
  }
}
