import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { outbox, schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { openPool } from '../../../test/support/integration-database';
import { holdOutboxSuiteLock } from '../../../test/support/outbox-suite-lock';
import { CLOCK } from '../../common/clock/clock.port';
import { FakeClock } from '../../common/clock/fake-clock';
import type { Environment } from '../../config/environment';
import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import type { Envelope } from './envelope';
import { RELAY_BATCH } from './outbox.constants';
import { OutboxWriter } from './outbox-writer';
import { OutboxRelay, type Publish } from './relay';

/** Probed once per run by `test/global-setup.ts`, which also owns the CI-must-not-skip rule. */
const reachable = inject('postgresReachable');

/** `forge_app`, as the relay runs: two connections, so two relays can hold two transactions. */
const pool = reachable ? openPool(process.env.DATABASE_URL ?? '', 2) : undefined;

const NOW = '2026-09-13T10:00:00.000Z';
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

/**
 * A `publish` the suite steers. It records every envelope, rejects the next `failures` calls, and
 * holds each accepted call for `holdMs` so that a tick keeps its transaction — and the lock —
 * open long enough for a second relay to contend for it.
 */
class FakePublish {
  readonly calls: Envelope[] = [];
  failures = 0;

  constructor(private readonly holdMs = 0) {}

  readonly fn: Publish = async (envelope) => {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('queue store down');
    }

    await sleep(this.holdMs);
    this.calls.push(envelope);
  };

  /** How many of `ids` this instance published — the other suites' rows are noise here. */
  countOf(ids: readonly string[]): number {
    return this.calls.filter((call) => ids.includes(call.eventId)).length;
  }
}

/** Polls `predicate` until it holds or `ms` elapse; the loop cases have no other clock to wait on. */
async function until(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }

    await sleep(100);
  }

  return predicate();
}

/**
 * US2 (spec 005), the relay half: what a producer committed reaches `publish` in `seq` order and
 * is marked only after `publish` accepted it (FR-010); one process publishes at a time and another
 * takes over within a tick when it stops (FR-009/012, research R3); a failed tick — the queue
 * store down, the table not yet migrated — is a `warn` line and the next tick, never a crash
 * (FR-014).
 *
 * The outbox table is shared with every other integration suite, so every assertion is scoped to
 * the rows this suite inserted: a foreign unpublished row is published in passing and never
 * counted.
 */
describe.skipIf(!reachable)('OutboxRelay', () => {
  const db: ForgeDatabase = drizzle(pool!, { schema });
  const clock = new FakeClock(NOW);
  const TICK_MS = 50;
  /** The one key the relay reads (spec 006 research R8); a typed stub, not a compiled module. */
  const config = {
    get: (key: keyof Environment) => (key === 'OUTBOX_RELAY_TICK_MS' ? TICK_MS : undefined),
  } as unknown as ConfigService<Environment, true>;
  let suiteLock: { release: () => Promise<void> };

  // The e2e suites run a real relay against this same table; one relay-running suite at a time.
  // Same wait as the e2e suites: eighteen of them queue on this lock under EXPECT_INTEGRATION=1.
  beforeAll(async () => {
    suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
  }, LOCKED_BOOT_TIMEOUT_MS);

  /**
   * The backlog, published in passing before each case. Every suite that boots the API without a
   * worker profile appends outbox rows and leaves them for a relay (OutboxModule), so by the time
   * this file runs in a full `pnpm test` there can be more than `RELAY_BATCH` of them — older than
   * this suite's rows, so one `tick` publishes only foreign ones and a 50 ms-per-row fake holds a
   * tick for seconds. Under the suite lock no other relay runs, so a drained table stays drained
   * apart from what the case itself emits; the assertions below are unchanged.
   */
  beforeEach(async () => {
    const drain = new OutboxRelay(db, clock, config);
    const discard: Publish = () => Promise.resolve();

    while ((await drain.tick(discard)) === RELAY_BATCH) {
      // `RELAY_BATCH` means there may be more.
    }
  });

  afterAll(async () => {
    await suiteLock?.release();
    await pool?.end();
  });

  /** `n` probe rows for one fresh aggregate, in one transaction, in insertion order. */
  async function emit(n: number): Promise<string[]> {
    const aggregateId = randomUUID();

    return db.transaction(async (tx) => {
      const ids: string[] = [];

      for (let i = 0; i < n; i += 1) {
        const [row] = await tx
          .insert(outbox)
          .values({
            aggregate: 'probe',
            aggregateId,
            occurredAt: clock.now(),
            payload: { probeId: randomUUID() },
            type: 'outbox.probe',
          })
          .returning({ id: outbox.id });

        ids.push(row!.id);
      }

      return ids;
    });
  }

  async function publishedAtOf(ids: readonly string[]): Promise<(Date | null)[]> {
    const rows = await db
      .select({ id: outbox.id, publishedAt: outbox.publishedAt })
      .from(outbox)
      .where(inArray(outbox.id, ids));

    return ids.map((id) => rows.find((row) => row.id === id)!.publishedAt);
  }

  async function isPublished(id: string): Promise<boolean> {
    const [row] = await db
      .select({ publishedAt: outbox.publishedAt })
      .from(outbox)
      .where(eq(outbox.id, id));

    return row!.publishedAt !== null;
  }

  it('publishes unpublished rows in seq order and marks them published', async () => {
    const publish = new FakePublish();
    const relay = new OutboxRelay(db, clock, config);
    const ids = await emit(3);

    await relay.tick(publish.fn);

    const ours = publish.calls.filter((call) => ids.includes(call.eventId));

    expect(ours.map((call) => call.eventId)).toEqual(ids);
    expect(ours[0]).toMatchObject({
      aggregate: 'probe',
      occurredAt: NOW,
      orgId: null,
      traceId: null,
      type: 'outbox.probe',
    });
    expect(await publishedAtOf(ids)).toEqual([clock.now(), clock.now(), clock.now()]);
  });

  it('marks nothing when publish rejects and republishes on the next tick', async () => {
    const publish = new FakePublish();
    const relay = new OutboxRelay(db, clock, config);
    const ids = await emit(2);

    publish.failures = 1;

    await expect(relay.tick(publish.fn)).rejects.toThrow('queue store down');
    expect(await publishedAtOf(ids)).toEqual([null, null]);

    await relay.tick(publish.fn);

    expect(publish.countOf(ids)).toBe(2);
    expect(await publishedAtOf(ids)).toEqual([clock.now(), clock.now()]);
  });

  it('publishes from one of two relays only', async () => {
    const first = new FakePublish(50);
    const second = new FakePublish(50);
    const ids = await emit(3);

    await Promise.all([
      new OutboxRelay(db, clock, config).tick(first.fn),
      new OutboxRelay(db, clock, config).tick(second.fn),
    ]);

    const counts = [first.countOf(ids), second.countOf(ids)];

    expect(counts.filter((n) => n > 0)).toEqual([3]);
  });

  it('takes over when the publishing relay stops', async () => {
    const publishes = [new FakePublish(), new FakePublish()];
    const relays = [new OutboxRelay(db, clock, config), new OutboxRelay(db, clock, config)];

    relays[0]!.start(publishes[0]!.fn);
    relays[1]!.start(publishes[1]!.fn);

    try {
      const [before] = await emit(1);

      expect(await until(() => isPublished(before!), 10_000)).toBe(true);

      const leader = publishes[0]!.countOf([before!]) === 1 ? 0 : 1;
      const other = 1 - leader;

      await relays[leader]!.stop();

      const [after] = await emit(1);

      expect(await until(() => isPublished(after!), 10_000)).toBe(true);
      expect(publishes[other]!.countOf([after!])).toBe(1);
      expect(publishes[leader]!.countOf([after!])).toBe(0);
    } finally {
      await Promise.all(relays.map((relay) => relay.stop()));
    }
  });

  /**
   * Spec 006 research R8: the tick is `OUTBOX_RELAY_TICK_MS`, not a constant, so the suites can
   * make it short. Read off the timer the loop arms rather than waited for: the delay is the
   * property, and a wait proves only an upper bound.
   */
  it('ticks at the configured interval', async () => {
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const relay = new OutboxRelay(db, clock, config);

    relay.start(new FakePublish().fn);

    try {
      expect(timeouts).toHaveBeenLastCalledWith(expect.any(Function), TICK_MS);
    } finally {
      timeouts.mockRestore();
      await relay.stop();
    }
  });

  it('keeps ticking after a failed tick', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const publish = new FakePublish();
    const relay = new OutboxRelay(db, clock, config);
    const [id] = await emit(1);

    publish.failures = 1;
    relay.start(publish.fn);

    try {
      expect(await until(() => isPublished(id!), 10_000)).toBe(true);
      expect(publish.countOf([id!])).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('queue store down'));
    } finally {
      await relay.stop();
    }
  });

  /**
   * FR-013/014: the request path never waits on the queue store. Read off the constructor
   * metadata rather than exercised, because the property is "there is no such dependency" — the
   * relay reaches the database through `APP_DATABASE` alone, and the writer holds no Redis client
   * at all.
   */
  it('leaves the request path alone', () => {
    const tokensOf = (target: object): unknown[] =>
      (Reflect.getMetadata('self:paramtypes', target) as { index: number; param: unknown }[])
        .sort((a, b) => a.index - b.index)
        .map((dep) => dep.param);

    expect(tokensOf(OutboxRelay)).toEqual([APP_DATABASE, CLOCK, ConfigService]);
    expect(tokensOf(OutboxWriter)).toEqual([CLOCK]);
  });
});
