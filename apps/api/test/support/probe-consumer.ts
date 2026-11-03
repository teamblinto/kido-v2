import { EventConsumer, RetryableFailure } from '../../src/modules/outbox/consumer';
import type { Envelope } from '../../src/modules/outbox/envelope';

/** What the suite can make the next `handle` do. */
export type ProbeBehaviour = 'ok' | 'retryable' | 'stall' | 'terminal';

/** One delivery the probe accepted, with a monotonic timestamp the suite pairs with the commit's. */
export interface ProbeSeen {
  readonly at: number;
  readonly eventId: string;
  readonly probeId: string;
}

/**
 * The spec's "test consumer only": the one registrant of `EVENT_CONSUMERS`, and it lives under
 * `test/` so that nothing in `src/` can import it (FR-028). The e2e suite overrides the token with
 * an instance and steers it through `behaviour`; `handleCalls` counts every pickup, `seen` only the
 * ones that resolved, so a stalled or failed delivery is visible as the difference.
 *
 * `stall` returns a promise that never settles on its own rather than sleeping, because the point
 * of the poison case (US4) is a lock the worker cannot renew — a timer would resolve eventually and
 * turn a stall into a slow success. Its resolver is kept in `stalls` for the suite to release once
 * the case is proved: the handler runs inside the consumer base's transaction, and a promise that
 * never settled would hold that pool connection past the application's shutdown.
 */
export class ProbeConsumer extends EventConsumer<'outbox.probe'> {
  readonly attempts: number;
  readonly name: string;
  readonly queue: string;
  readonly types = ['outbox.probe'] as const;

  behaviour: ProbeBehaviour = 'ok';
  handleCalls = 0;
  readonly seen: ProbeSeen[] = [];
  readonly stalls: (() => void)[] = [];

  /** Defaults are the spec's probe; the two-consumer and spent-budget cases pass their own. */
  constructor(name = 'probe', queue = name, attempts = 5) {
    super();
    this.attempts = attempts;
    this.name = name;
    this.queue = queue;
  }

  handle(event: Envelope<'outbox.probe'>): Promise<void> {
    this.handleCalls += 1;
    switch (this.behaviour) {
      case 'retryable':
        return Promise.reject(new RetryableFailure('throttled'));
      case 'terminal':
        return Promise.reject(new Error('boom'));
      case 'stall':
        return new Promise<void>((resolve) => this.stalls.push(resolve));
      case 'ok':
        this.seen.push({
          at: performance.now(),
          eventId: event.eventId,
          probeId: event.payload.probeId,
        });
        return Promise.resolve();
    }
  }
}
