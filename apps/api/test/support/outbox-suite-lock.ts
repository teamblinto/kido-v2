import pg from 'pg';

/**
 * Not `OUTBOX_RELAY_LOCK`, which the relay takes per batch: this one is held for a whole suite.
 * `outbox.constants.ts` asks the next advisory lock in the codebase to pick a different number.
 */
const OUTBOX_SUITE_LOCK = 7_301_006;

/**
 * Serialises the suites that run a relay against the shared outbox table.
 *
 * Vitest runs files in parallel and the outbox table is one table: a relay in `relay.spec.ts`
 * publishes through a fake that records and marks, so a row the e2e suite committed can be marked
 * published with no job behind it — and the e2e suite's relay, publishing for real, takes the rows
 * the relay spec is counting between its two fake publishers. Both are correct relays doing what a
 * relay does; the fix is that only one suite runs one at a time.
 *
 * A session-level lock on a connection of its own, held until `release` ends that connection.
 * Session locks are exactly what research R3 rejects for the relay under PgBouncer — and exactly
 * right here, where the connection is direct and the lock's lifetime is the suite's.
 */
export async function holdOutboxSuiteLock(url: string): Promise<{ release: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: url });

  await client.connect();
  await client.query('select pg_advisory_lock($1)', [OUTBOX_SUITE_LOCK]);

  return { release: () => client.end() };
}
