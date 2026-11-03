import { randomUUID } from 'node:crypto';

import { outbox, schema } from '@repo/db';
import { count, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { openPool } from '../../../test/support/integration-database';
import { FakeClock } from '../../common/clock/fake-clock';
import type { ForgeDatabase } from '../../database/database.types';
import {
  EventPayloadTooLargeError,
  InvalidEventPayloadError,
  OutboxWriteOutsideTransactionError,
  OutboxWriter,
  UnknownEventTypeError,
} from './outbox-writer';

/** Probed once per run by `test/global-setup.ts`, which also owns the CI-must-not-skip rule. */
const reachable = inject('postgresReachable');

/** `forge_app`, as the request path: the writer runs on the caller's transaction, never bypass. */
const pool = reachable ? openPool(process.env.DATABASE_URL ?? '', 2) : undefined;

const NOW = '2026-09-13T10:00:00.000Z';

/** A probe event with a fresh aggregate id, so every assertion counts only its own rows. */
function probe(): { aggregateId: string; payload: { probeId: string }; type: 'outbox.probe' } {
  return { aggregateId: randomUUID(), payload: { probeId: randomUUID() }, type: 'outbox.probe' };
}

/**
 * US1 (spec 005): an event happens iff its state change happens. The row is written on the
 * caller's transaction handle and nowhere else, so there is no after-commit step to forget and no
 * event without its state change (FR-004/005). The four refusals are programmer errors: they
 * propagate, and the caller's transaction rolls back with them (FR-006/007).
 */
describe.skipIf(!reachable)('OutboxWriter', () => {
  const db: ForgeDatabase = drizzle(pool!, { schema });
  const clock = new FakeClock(NOW);
  const writer = new OutboxWriter(clock);

  afterAll(async () => {
    await pool?.end();
  });

  async function rowsFor(aggregateId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(outbox)
      .where(eq(outbox.aggregateId, aggregateId));

    return row!.n;
  }

  it('appends one unpublished row when the transaction commits', async () => {
    const event = probe();

    const { eventId } = await db.transaction((tx) => writer.append(tx, event));

    const [row] = await db.select().from(outbox).where(eq(outbox.id, eventId));

    expect(row).toMatchObject({
      aggregate: 'probe',
      aggregateId: event.aggregateId,
      occurredAt: clock.now(),
      payload: event.payload,
      publishedAt: null,
      type: 'outbox.probe',
    });
    expect(row!.seq).toEqual(expect.any(Number));
    expect(await rowsFor(event.aggregateId)).toBe(1);
  });

  it('leaves no row when the transaction rolls back', async () => {
    const event = probe();

    class CallerFailed extends Error {}

    await expect(
      db.transaction(async (tx) => {
        await writer.append(tx, event);
        throw new CallerFailed();
      }),
    ).rejects.toBeInstanceOf(CallerFailed);

    expect(await rowsFor(event.aggregateId)).toBe(0);
  });

  it('refuses to append outside a transaction', async () => {
    const event = probe();

    await expect(writer.append(undefined as never, event)).rejects.toBeInstanceOf(
      OutboxWriteOutsideTransactionError,
    );

    expect(await rowsFor(event.aggregateId)).toBe(0);
  });

  /** The plain database has `insert` too; what it lacks is a transaction to be atomic with. */
  it('refuses the database handle itself, which is not a transaction', async () => {
    const event = probe();

    await expect(writer.append(db as never, event)).rejects.toBeInstanceOf(
      OutboxWriteOutsideTransactionError,
    );

    expect(await rowsFor(event.aggregateId)).toBe(0);
  });

  it('refuses an event type outside the catalogue', async () => {
    const event = { ...probe(), type: 'outbox.unknown' as 'outbox.probe' };

    await expect(db.transaction((tx) => writer.append(tx, event))).rejects.toBeInstanceOf(
      UnknownEventTypeError,
    );

    expect(await rowsFor(event.aggregateId)).toBe(0);
  });

  /** "Ids, never contents": the refusal names the issue, not the value that caused it (§10). */
  it('refuses a payload the catalogue schema rejects', async () => {
    const event = {
      ...probe(),
      payload: { email: 'someone@example.com', probeId: 'not-a-uuid' } as never,
    };

    const failure = await db.transaction((tx) => writer.append(tx, event)).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(InvalidEventPayloadError);
    expect((failure as Error).message).not.toContain('someone@example.com');
    expect((failure as Error).message).not.toContain('not-a-uuid');
    expect(await rowsFor(event.aggregateId)).toBe(0);
  });

  it('refuses a payload over 4 096 bytes', async () => {
    const event = { ...probe(), payload: { probeId: 'x'.repeat(4_096) } as never };

    await expect(db.transaction((tx) => writer.append(tx, event))).rejects.toBeInstanceOf(
      EventPayloadTooLargeError,
    );

    expect(await rowsFor(event.aggregateId)).toBe(0);
  });

  it('records org and trace ids when given, null when not', async () => {
    const orgId = randomUUID();
    const tagged = { ...probe(), orgId, traceId: 'req-42' };
    const bare = probe();

    const [taggedEvent, bareEvent] = await db.transaction(async (tx) => [
      await writer.append(tx, tagged),
      await writer.append(tx, bare),
    ]);

    const [taggedRow] = await db.select().from(outbox).where(eq(outbox.id, taggedEvent.eventId));
    const [bareRow] = await db.select().from(outbox).where(eq(outbox.id, bareEvent.eventId));

    expect(taggedRow).toMatchObject({ originOrgId: orgId, traceId: 'req-42' });
    expect(bareRow).toMatchObject({ originOrgId: null, traceId: null });
  });
});
