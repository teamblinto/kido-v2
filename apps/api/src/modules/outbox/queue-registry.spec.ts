import type { DiscoveryService } from '@nestjs/core';
import type * as BullMQ from 'bullmq';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../common/clock/fake-clock';
import { EventConsumer } from './consumer';
import type { ConsumerBase } from './consumer-base';
import type { Envelope } from './envelope';
import { QueueRegistry } from './queue-registry';

interface Added {
  readonly name: string;
  readonly opts: { readonly jobId?: string };
  readonly queue: string;
}

/** Every `add` on every queue the registry opened, in order: what `publish` handed BullMQ. */
const { adds } = vi.hoisted(() => ({ adds: [] as Added[] }));

/**
 * BullMQ replaced by the two shapes the registry touches: a `Queue` that records `add` and a
 * `Worker` that is an emitter. `UnrecoverableError` and the rest stay real for `dead-letter.ts`.
 */
vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof BullMQ>();
  const { EventEmitter } = await import('node:events');

  class Queue extends EventEmitter {
    constructor(readonly name: string) {
      super();
    }

    add(name: string, _data: unknown, opts: { jobId?: string }): Promise<void> {
      adds.push({ name, opts, queue: this.name });
      return Promise.resolve();
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  class Worker extends EventEmitter {
    constructor(
      readonly name: string,
      _processor: unknown,
      readonly opts: unknown,
    ) {
      super();
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  return { ...actual, Queue, Worker };
});

function envelope(): Envelope<'outbox.probe'> {
  return {
    aggregate: 'probe',
    aggregateId: 'a1',
    eventId: 'e1',
    occurredAt: '2026-09-13T10:00:00.000Z',
    orgId: null,
    payload: { probeId: 'p1' },
    traceId: null,
    type: 'outbox.probe',
  };
}

class PlainConsumer extends EventConsumer<'outbox.probe'> {
  readonly attempts = 1;
  readonly name = 'plain';
  readonly queue = 'probe';
  readonly types = ['outbox.probe'] as const;

  handle(): Promise<void> {
    return Promise.resolve();
  }
}

class StallTolerantConsumer extends EventConsumer<'outbox.probe'> {
  readonly attempts = 1;
  override readonly maxStalledCount = 2;
  readonly name = 'stall-tolerant';
  readonly queue = 'stall';
  readonly types = ['outbox.probe'] as const;

  handle(): Promise<void> {
    return Promise.resolve();
  }
}

class MailConsumer extends EventConsumer<'outbox.probe'> {
  readonly attempts = 1;
  readonly name = 'mail';
  readonly queue = 'mail';
  readonly types = ['outbox.probe'] as const;

  handle(): Promise<void> {
    return Promise.resolve();
  }
}

class AgentConsumer extends EventConsumer<'outbox.probe'> {
  readonly attempts = 1;
  readonly name = 'agent';
  override readonly profile = 'agent' as const;
  readonly queue = 'agent.run';
  readonly types = ['outbox.probe'] as const;

  handle(): Promise<void> {
    return Promise.resolve();
  }
}

class KeyedConsumer extends EventConsumer<'outbox.probe'> {
  readonly attempts = 1;
  readonly name = 'keyed';
  readonly queue = 'keyed';
  readonly types = ['outbox.probe'] as const;

  handle(): Promise<void> {
    return Promise.resolve();
  }

  override jobId(event: Envelope<'outbox.probe'>): string {
    return `keyed:${event.aggregateId}:${event.occurredAt.slice(0, 13)}`;
  }
}

function registry(
  injected: readonly EventConsumer[],
  discovered: readonly unknown[] = [],
): QueueRegistry {
  const discovery = {
    getProviders: () => discovered.map((instance) => ({ instance })),
  } as unknown as DiscoveryService;

  return new QueueRegistry(
    injected,
    {} as Redis,
    new FakeClock(0),
    { processJob: () => Promise.resolve() } as unknown as ConsumerBase,
    discovery,
  );
}

describe('QueueRegistry', () => {
  beforeEach(() => {
    adds.length = 0;
  });

  /**
   * Spec 006 research R3: the job id is the deduplication key. A consumer that defines `jobId`
   * names it; every other consumer keeps the event id, so a republish stays a no-op.
   */
  describe('publish', () => {
    it("uses the consumer's jobId when it defines one", async () => {
      const subject = registry([new KeyedConsumer()]);
      subject.build(new Set(['events']));

      await subject.publish(envelope());

      expect(adds.map(({ opts, queue }) => ({ jobId: opts.jobId, queue }))).toEqual([
        { jobId: 'keyed:a1:2026-09-13T10', queue: 'keyed' },
      ]);
    });

    it('falls back to the event id', async () => {
      const subject = registry([new PlainConsumer()]);
      subject.build(new Set(['events']));

      await subject.publish(envelope());

      expect(adds.map(({ opts, queue }) => ({ jobId: opts.jobId, queue }))).toEqual([
        { jobId: 'e1', queue: 'probe' },
      ]);
    });
  });

  /**
   * Spec 006 research R6: a module registers its consumer as an ordinary provider and the
   * registry finds it, so `outbox` imports no module and the root wires nothing. The injected
   * token stays for the e2e suites that override it.
   */
  /** Spec 008 research R6: the one `Worker` constructor passes a consumer's stall budget through. */
  it('passes maxStalledCount to the worker when the consumer names one, and omits it otherwise', () => {
    const subject = registry([]);
    const plain = subject.createWorker([new PlainConsumer()]) as unknown as { opts: object };
    const tolerant = subject.createWorker([new StallTolerantConsumer()]) as unknown as {
      opts: object;
    };

    expect(plain.opts).not.toHaveProperty('maxStalledCount');
    expect(tolerant.opts).toMatchObject({ maxStalledCount: 2 });
  });

  it('discovers EventConsumer providers and merges the injected list', () => {
    const subject = registry(
      [new PlainConsumer()],
      [new KeyedConsumer(), { notAConsumer: true }, undefined],
    );

    subject.build(new Set(['events']));

    expect([...subject.queues.keys()]).toEqual(['probe', 'probe.dlq', 'keyed', 'keyed.dlq']);
    expect(subject.workers.map((worker) => worker.name)).toEqual(['probe', 'keyed']);
  });

  /**
   * Spec 013 research R3: the relay publishes to every queue from the `events` process, so every
   * queue and DLQ exists wherever the module boots; a worker exists only where the consumer's
   * profile is in the set.
   */
  it('builds a queue and a dlq for every route but a worker only for queues whose profile is in the set', () => {
    const subject = registry([new MailConsumer(), new AgentConsumer()]);

    subject.build(new Set(['events']));

    expect([...subject.queues.keys()]).toEqual(['mail', 'mail.dlq', 'agent.run', 'agent.run.dlq']);
    expect(subject.workers.map((worker) => worker.name)).toEqual(['mail']);
  });

  /** Spec 014 data-model § Queues: a `cron`-only process drains `maintenance` and nothing else. */
  it('builds the maintenance worker and no other for a cron-only profile set', () => {
    class MaintenanceProbe extends EventConsumer<'outbox.probe'> {
      readonly attempts = 3;
      readonly name = 'maintenance';
      override readonly profile = 'cron' as const;
      readonly queue = 'maintenance';
      readonly types = ['outbox.probe'] as const;

      handle(): Promise<void> {
        return Promise.resolve();
      }
    }

    const subject = registry([new MailConsumer(), new AgentConsumer(), new MaintenanceProbe()]);

    subject.build(new Set(['cron']));

    expect([...subject.queues.keys()]).toEqual([
      'mail',
      'mail.dlq',
      'agent.run',
      'agent.run.dlq',
      'maintenance',
      'maintenance.dlq',
    ]);
    expect(subject.workers.map((worker) => worker.name)).toEqual(['maintenance']);
  });

  /** data-model.md § EventConsumer: a queue is drained by one profile. */
  it('refuses two consumers on one queue that disagree on the profile', () => {
    class OtherAgentConsumer extends EventConsumer<'outbox.probe'> {
      readonly attempts = 1;
      readonly name = 'other';
      readonly queue = 'agent.run';
      readonly types = [] as const;

      handle(): Promise<void> {
        return Promise.resolve();
      }
    }

    const subject = registry([new AgentConsumer(), new OtherAgentConsumer()]);

    expect(() => subject.build(new Set(['agent']))).toThrow(
      'queue "agent.run" is claimed by two profiles: agent, events',
    );
  });
});
