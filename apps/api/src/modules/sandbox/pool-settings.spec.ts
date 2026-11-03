import type { ConfigService } from '@nestjs/config';
import { sandboxPoolSettings, schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { openPool } from '../../../test/support/integration-database';
import { FakeClock } from '../../common/clock/fake-clock';
import type { Environment } from '../../config/environment';
import type { ForgeDatabase } from '../../database/database.types';
import { PoolSettingsService } from './pool-settings';

const reachable = inject('postgresReachable');
const pool = reachable ? openPool(process.env.DATABASE_URL ?? '') : undefined;

const NOW = '2026-09-13T10:00:00.000Z';
/**
 * Not `nextjs` or `node-api`: `pool-refill.spec.ts` asserts on their settings rows, and this suite
 * holds no outbox suite lock, so it runs in a parallel worker — a shared row is a race. Nobody
 * writes `python` settings.
 */
const MINE = 'python';

/**
 * US3 (spec 014, FR-019): the dial. `upsert` refuses a depth outside `0..64` and a template
 * outside `PROJECT_TEMPLATES`, naming each; an absent row reads as the environment default. The
 * snapshot left the dial in spec 015 (research R8): the pool creates from the current version.
 */
describe.skipIf(!reachable)('PoolSettingsService', () => {
  const db: ForgeDatabase = drizzle(pool!, { schema });
  const clock = new FakeClock(NOW);
  const config = {
    get: () => 'local',
  } as unknown as ConfigService<Environment, true>;
  const service = new PoolSettingsService(db, config, clock);

  beforeEach(async () => {
    await db.delete(sandboxPoolSettings).where(eq(sandboxPoolSettings.template, MINE));
  });

  afterAll(async () => {
    await db.delete(sandboxPoolSettings).where(eq(sandboxPoolSettings.template, MINE));
    await pool?.end();
  });

  it.each([-1, 65, 1.5, Number.NaN])('refuses depth %s naming the range 0..64', async (depth) => {
    await expect(service.upsert(MINE, { depth })).rejects.toThrow('0..64');
    expect(await service.read(MINE)).toMatchObject({ targetDepth: 1 });
  });

  it('refuses a template outside PROJECT_TEMPLATES, naming it', async () => {
    await expect(service.upsert('rails', { depth: 2 })).rejects.toThrow('rails');
  });

  it('an absent row reads as the environment default (local → 1)', async () => {
    expect(await service.read(MINE)).toEqual({ targetDepth: 1, template: MINE });
  });

  it('upsert then read round-trips, with updated_at from the clock', async () => {
    expect(await service.upsert(MINE, { depth: 12 })).toEqual({ targetDepth: 12, template: MINE });
    expect(await service.read(MINE)).toEqual({ targetDepth: 12, template: MINE });
    const [row] = await db
      .select()
      .from(sandboxPoolSettings)
      .where(eq(sandboxPoolSettings.template, MINE));
    expect(row?.updatedAt).toEqual(new Date(NOW));
  });

  it('the bounds 0 and 64 are accepted', async () => {
    await service.upsert(MINE, { depth: 64 });
    expect(await service.read(MINE)).toEqual({ targetDepth: 64, template: MINE });
    await service.upsert(MINE, { depth: 0 });
    expect(await service.read(MINE)).toEqual({ targetDepth: 0, template: MINE });
  });
});
