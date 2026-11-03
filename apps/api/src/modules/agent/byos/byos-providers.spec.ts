import type { ConfigService } from '@nestjs/config';
import { schema } from '@repo/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { Environment } from '../../../config/environment';
import type { ForgeDatabase } from '../../../database/database.types';
import { ByosProviders } from './byos-providers';

const postgres = inject('postgresReachable');

const OPENAI_SET: Record<string, string> = {
  BYOS_OPENAI_API_BASE_URL: 'https://sub.openai.test/api',
  BYOS_OPENAI_AUTHORIZE_URL: 'https://auth.openai.test/authorize',
  BYOS_OPENAI_CLIENT_ID: 'client',
  BYOS_OPENAI_SCOPES: 'openid email',
  BYOS_OPENAI_TOKEN_URL: 'https://auth.openai.test/token',
};

function config(values: Record<string, string>): ConfigService<Environment, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<Environment, true>;
}

class Rollback extends Error {}

/**
 * The provider gate's read side (032 R12). `forge_app` may not DELETE from `byos_providers`, so
 * each case writes its rows inside a transaction that is rolled back.
 */
describe.skipIf(!postgres)('ByosProviders', () => {
  let pool: pg.Pool;
  let database: ForgeDatabase;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    database = drizzle(pool, { schema });
  });

  afterAll(() => pool.end());

  async function within(
    rows: { provider: 'anthropic' | 'openai'; status: 'in_force' | 'withdrawn' }[],
    values: Record<string, string>,
    check: (providers: ByosProviders) => Promise<void>,
  ): Promise<void> {
    await database
      .transaction(async (tx) => {
        for (const row of rows) {
          await tx.insert(schema.byosProviders).values({
            ...row,
            record: `docs/byos/${row.provider}.md`,
            signedOffAt: new Date(),
            withdrawnAt: row.status === 'withdrawn' ? new Date() : null,
          });
        }
        await check(new ByosProviders(tx, config(values)));
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
  }

  it('offers nothing when no row exists, even when configured', async () => {
    await within([], OPENAI_SET, async (providers) => {
      expect(await providers.offered('openai')).toBe(false);
      expect(await providers.offeredList()).toEqual([]);
    });
  });

  it('offers nothing for a withdrawn provider', async () => {
    await within([{ provider: 'openai', status: 'withdrawn' }], OPENAI_SET, async (providers) => {
      expect(await providers.offered('openai')).toBe(false);
      expect(await providers.offeredList()).toEqual([]);
    });
  });

  it('offers nothing for a provider in force but unconfigured', async () => {
    await within([{ provider: 'anthropic', status: 'in_force' }], OPENAI_SET, async (providers) => {
      expect(await providers.offered('anthropic')).toBe(false);
      expect(await providers.offeredList()).toEqual([]);
    });
  });

  it('offers a provider in force and configured, and only that one', async () => {
    await within(
      [
        { provider: 'openai', status: 'in_force' },
        { provider: 'anthropic', status: 'withdrawn' },
      ],
      OPENAI_SET,
      async (providers) => {
        expect(await providers.offered('openai')).toBe(true);
        expect(await providers.offered('anthropic')).toBe(false);
        expect(await providers.offeredList()).toEqual(['openai']);
      },
    );
  });

  it('endpoint() is the configured base URL with no headers until a sheet names some', () => {
    const providers = new ByosProviders({} as ForgeDatabase, config(OPENAI_SET));

    expect(providers.endpoint('openai')).toEqual({
      baseURL: 'https://sub.openai.test/api',
      headers: {},
    });
    expect(providers.endpoint('anthropic')).toBeUndefined();
  });
});
