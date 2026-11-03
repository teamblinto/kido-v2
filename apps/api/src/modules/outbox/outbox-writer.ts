import { Inject, Injectable } from '@nestjs/common';
import { outbox } from '@repo/db';
import type { z } from 'zod';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { TenantTransaction } from '../../database/database.types';
import { EVENTS, type EventPayload, type EventType, MAX_PAYLOAD_BYTES } from './events';

/** A programmer error: the caller had no transaction, so there is nothing to be atomic with. */
export class OutboxWriteOutsideTransactionError extends Error {
  constructor() {
    super('OutboxWriter.append needs the transaction handle of the state change it belongs to.');
    this.name = 'OutboxWriteOutsideTransactionError';
  }
}

/** A programmer error: the catalogue is closed, and a type not in it has no consumer to reach. */
export class UnknownEventTypeError extends Error {
  constructor(type: string) {
    super(`${JSON.stringify(type)} is not in the event catalogue.`);
    this.name = 'UnknownEventTypeError';
  }
}

/** A programmer error: the payload is not what the catalogue entry declares. Issues, never values. */
export class InvalidEventPayloadError extends Error {
  constructor(
    type: string,
    readonly issues: readonly z.core.$ZodIssue[],
  ) {
    super(`The payload of ${JSON.stringify(type)} fails its schema: ${describe(issues)}.`);
    this.name = 'InvalidEventPayloadError';
  }
}

/** A programmer error: an event carries ids, not contents, and 4 096 bytes is more than ids. */
export class EventPayloadTooLargeError extends Error {
  constructor(type: string, bytes: number) {
    super(
      `The payload of ${JSON.stringify(type)} is ${bytes} bytes; at most ${MAX_PAYLOAD_BYTES}.`,
    );
    this.name = 'EventPayloadTooLargeError';
  }
}

/** Paths and codes only. Zod's own message would carry the offending value for some issues. */
function describe(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((issue) => `${issue.path.join('.') || '$'} ${issue.code}`).join(', ');
}

export interface OutboxEvent<T extends EventType> {
  readonly aggregateId: string;
  readonly orgId?: string;
  readonly payload: EventPayload<T>;
  readonly traceId?: string;
  readonly type: T;
}

/**
 * The producer side of the outbox (contracts/outbox-module.md § Producer side).
 *
 * `append` inserts on the handle it is given and does nothing else: no after-commit hook, no
 * publish, no Redis. The row commits when the caller's transaction commits and vanishes when it
 * rolls back, which is the whole guarantee (FR-004). Everything it refuses is a bug in the caller,
 * so each refusal is a named error that propagates and takes the caller's transaction with it.
 */
@Injectable()
export class OutboxWriter {
  constructor(@Inject(CLOCK) private readonly clock: ClockPort) {}

  async append<T extends EventType>(
    tx: TenantTransaction,
    event: OutboxEvent<T>,
  ): Promise<{ eventId: string }> {
    // `rollback` is what a `ForgeDatabase` lacks: it has `insert` too, but no transaction to be
    // atomic with. Checked before anything else, so a missing handle never reaches the driver.
    if (!isTransaction(tx)) {
      throw new OutboxWriteOutsideTransactionError();
    }

    const entry = (EVENTS as Record<string, (typeof EVENTS)[EventType] | undefined>)[event.type];

    if (entry === undefined) {
      throw new UnknownEventTypeError(event.type);
    }

    // Size before shape. The shipped catalogue admits nothing near the cap, so a schema-first
    // order would make the size rule unreachable — and a payload a hundred times the cap is
    // refused for being large before Zod walks it.
    const bytes = Buffer.byteLength(JSON.stringify(event.payload));

    if (bytes > MAX_PAYLOAD_BYTES) {
      throw new EventPayloadTooLargeError(event.type, bytes);
    }

    const parsed = entry.payload.safeParse(event.payload);

    if (!parsed.success) {
      throw new InvalidEventPayloadError(event.type, parsed.error.issues);
    }

    const [row] = await tx
      .insert(outbox)
      .values({
        aggregate: entry.aggregate,
        aggregateId: event.aggregateId,
        occurredAt: this.clock.now(),
        originOrgId: event.orgId ?? null,
        payload: parsed.data,
        traceId: event.traceId ?? null,
        type: event.type,
      })
      .returning({ id: outbox.id });

    return { eventId: row!.id };
  }
}

function isTransaction(tx: unknown): tx is TenantTransaction {
  return (
    typeof tx === 'object' &&
    tx !== null &&
    typeof (tx as TenantTransaction).insert === 'function' &&
    typeof (tx as TenantTransaction).rollback === 'function'
  );
}
