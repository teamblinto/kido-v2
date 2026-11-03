import pg from 'pg';

const { Pool } = pg;

/** Hides the password before a connection string reaches a console line or an assertion message. */
export function redactUrl(url: string): string {
  return url.replace(/:\/\/[^@]*@/, '://***@');
}

export function openPool(connectionString: string, max = 1): pg.Pool {
  return new Pool({ connectionString, connectionTimeoutMillis: 3_000, max });
}

async function isReachable(pool: pg.Pool): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides whether an integration suite may skip, and makes that decision loud either way.
 *
 * The spec's testing strategy allows a skip on a machine with no Docker so `pnpm check` stays
 * green there. CI sets `EXPECT_INTEGRATION=1`, where an unreachable database is a failure rather
 * than a silence — otherwise the four §09 proofs in this directory would pass by not running.
 */
export async function postgresReachable(suite: string, urls: readonly string[]): Promise<boolean> {
  const pools = urls.map((url) => openPool(url));
  const probes = await Promise.all(pools.map(isReachable));

  await Promise.all(pools.map((pool) => pool.end()));

  if (probes.every(Boolean)) {
    return true;
  }

  const unreachable = urls.filter((_, index) => !probes[index]).map(redactUrl);

  if (process.env.EXPECT_INTEGRATION === '1') {
    throw new Error(
      `EXPECT_INTEGRATION=1 but Postgres is unreachable at ${unreachable.join(', ')} — ` +
        `CI must not skip "${suite}".`,
    );
  }

  console.warn(
    [
      '',
      '='.repeat(100),
      `SKIPPING "${suite}": Postgres is unreachable at ${unreachable.join(', ')}.`,
      'Start it with `docker compose up -d postgres`, then `pnpm --filter @repo/db db:migrate`.',
      'CI runs this suite with EXPECT_INTEGRATION=1, where an unreachable database is a failure.',
      '='.repeat(100),
      '',
    ].join('\n'),
  );

  return false;
}
