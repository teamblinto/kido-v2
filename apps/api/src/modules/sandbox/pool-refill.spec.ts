import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  outbox,
  sandboxes,
  sandboxPool,
  sandboxPoolSettings,
  schema,
  type TemplateVersion,
  templateVersions,
} from '@repo/db';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  type MockInstance,
  vi,
} from 'vitest';

import { type FakeDaytona, startFakeDaytona } from '../../../test/support/fake-daytona';
import { openPool } from '../../../test/support/integration-database';
import { holdOutboxSuiteLock } from '../../../test/support/outbox-suite-lock';
import { FakeClock } from '../../common/clock/fake-clock';
import type { Environment } from '../../config/environment';
import type { ForgeDatabase } from '../../database/database.types';
import { OutboxWriter } from '../outbox/outbox-writer';
import { DaytonaAdapter } from './daytona.adapter';
import { PoolRefill } from './pool-refill';
import { PoolSettingsService } from './pool-settings';
import { DEFAULT_DAYTONA_TIMINGS, DEFAULT_SANDBOX_TIMINGS } from './sandbox.constants';
import { TemplateVersions } from './template-versions';

/** Probed once per run by `test/global-setup.ts`, which also owns the CI-must-not-skip rule. */
const reachable = inject('postgresReachable');
const pool = reachable ? openPool(process.env.DATABASE_URL ?? '') : undefined;

const NOW = '2026-09-13T10:00:00.000Z';
const OWNER = 'forge-refill-spec';
const BATCH = DEFAULT_SANDBOX_TIMINGS.refillBatch;
/**
 * The pool tables are shared with the other sandbox suites: `sandbox-claim.spec.ts` owns
 * `python` pool rows, `pool-settings.spec.ts` its settings row, and `sandbox-ops.consumer.spec.ts`
 * fills `vite-react`. This suite wipes and counts only these two, and reads the refill's
 * per-template output through its labels.
 */
const MINE = ['nextjs', 'node-api'] as const;
/** Waiting on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;
/** This suite's `template_versions` rows, wiped by digest so the e2e's rows are never touched. */
const DIGEST_PREFIX = 'refill-spec-';

/**
 * US1 (spec 014), the create half of `sandbox.refill` (research R10): per template, the deficit
 * against the current target becomes at most `refillBatch` creates, each a `POST /sandbox`, a
 * `sandbox_pool` row in `creating` and a `sandbox.op.requested { op: 'create' }` in one
 * transaction; a template without a current version is skipped with one `warn` and blocks
 * nothing (spec 015 FR-011, in place of 014's FR-022 snapshot setting — `versions.current` is
 * stubbed per template here, research R8); a `POST` that throws keeps the earlier pairs and
 * rethrows so the job retries.
 */
describe.skipIf(!reachable)('PoolRefill', () => {
  const db: ForgeDatabase = drizzle(pool!, { schema });
  const clock = new FakeClock(NOW);
  let fake: FakeDaytona;
  let adapter: DaytonaAdapter;
  let refill: PoolRefill;
  let versions: TemplateVersions;
  /** What the stubbed `versions.current` answers per template: a snapshot name, or nothing. */
  const currentOf = new Map<string, string>();
  let warn: MockInstance;
  let suiteLock: { release: () => Promise<void> } | undefined;

  beforeAll(async () => {
    // The relay suites drain the outbox rows this suite appends: one outbox-writing suite at a time.
    suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
    fake = await startFakeDaytona();
    const env = {
      DAYTONA_API_KEY: fake.apiKey,
      DAYTONA_API_URL: fake.apiUrl,
      DEPLOY_ENV: 'local',
      SANDBOX_OWNER: OWNER,
    };
    const config = {
      get: (key: keyof typeof env) => env[key],
    } as unknown as ConfigService<Environment, true>;
    adapter = new DaytonaAdapter(config, DEFAULT_DAYTONA_TIMINGS, clock);
    versions = new TemplateVersions(db);
    refill = new PoolRefill(
      db,
      adapter,
      new OutboxWriter(clock),
      new PoolSettingsService(db, config, clock),
      versions,
      config,
      DEFAULT_SANDBOX_TIMINGS,
      clock,
    );
  }, LOCKED_BOOT_TIMEOUT_MS);

  const wipe = async () => {
    await db.delete(sandboxPool).where(inArray(sandboxPool.template, [...MINE]));
    await db.delete(templateVersions).where(like(templateVersions.digest, `${DIGEST_PREFIX}%`));
    await db.delete(sandboxPoolSettings).where(inArray(sandboxPoolSettings.template, [...MINE]));
  };

  beforeEach(async () => {
    await wipe();
    fake.requests.length = 0;
    currentOf.clear();
    vi.spyOn(versions, 'current').mockImplementation((template) => {
      const snapshot = currentOf.get(template);
      return Promise.resolve(snapshot === undefined ? null : ({ snapshot } as TemplateVersion));
    });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await wipe();
    await fake.close();
    await pool?.end();
    await suiteLock?.release();
  });

  /** The dial row, and what the template's current version answers (`null`: none published). */
  const setTarget = (
    template: (typeof MINE)[number],
    targetDepth: number,
    snapshot: string | null,
  ) => {
    if (snapshot !== null) currentOf.set(template, snapshot);
    return db.insert(sandboxPoolSettings).values({ targetDepth, template, updatedAt: clock.now() });
  };

  /** The creates for this suite's templates, read off the labels the refill sent. */
  const posts = () =>
    fake.requests.filter(
      (r) =>
        r.method === 'POST' &&
        r.path === '/api/sandbox' &&
        (MINE as readonly string[]).includes(
          (JSON.parse(r.body) as { labels: Record<string, string> }).labels['forge.template']!,
        ),
    );

  /** The `no current version` warns for this suite's templates only; the others' pools are not ours. */
  const warnsFor = (template: (typeof MINE)[number]) =>
    warn.mock.calls.filter(([message]) => String(message).includes(`pool ${template}:`));

  const rows = (template: (typeof MINE)[number]) =>
    db.select().from(sandboxPool).where(eq(sandboxPool.template, template));

  const createOps = async (poolIds: readonly string[]) => {
    const all = await db
      .select()
      .from(outbox)
      .where(
        and(eq(outbox.type, 'sandbox.op.requested'), inArray(outbox.aggregateId, [...poolIds])),
      )
      .orderBy(asc(outbox.seq));
    return all.map((row) => row.payload as { op: string; poolId?: string });
  };

  it('creates min(deficit, refillBatch) per template: POST, a creating row, a create op', async () => {
    await setTarget('nextjs', BATCH + 4, 'snap-next');
    await setTarget('node-api', 2, 'snap-node');
    await db.insert(sandboxPool).values({
      daytonaId: 'already-ready',
      snapshot: 'snap-node',
      state: 'ready',
      template: 'node-api',
    });

    await refill.refill();

    expect(posts()).toHaveLength(BATCH + 1);
    expect(JSON.parse(posts()[0]!.body)).toMatchObject({
      labels: { 'forge.kind': 'pool', 'forge.owner': OWNER, 'forge.template': 'nextjs' },
      snapshot: 'snap-next',
    });

    const next = await rows('nextjs');
    expect(next).toHaveLength(BATCH);
    for (const row of next) {
      expect(row).toMatchObject({ node: fake.runnerId, snapshot: 'snap-next', state: 'creating' });
      expect(fake.sandboxes.has(row.daytonaId)).toBe(true);
    }
    const created = [...next, ...(await rows('node-api')).filter((r) => r.state === 'creating')];
    expect(created).toHaveLength(BATCH + 1);

    const ops = await createOps(created.map((r) => r.id));
    expect(ops).toHaveLength(BATCH + 1);
    expect(new Set(ops.map((op) => op.op))).toEqual(new Set(['create']));
    expect(new Set(ops.map((op) => op.poolId))).toEqual(new Set(created.map((r) => r.id)));
  });

  it('counts creating and ready against the current target, so the next pass takes the rest', async () => {
    await setTarget('nextjs', BATCH + 2, 'snap-next');

    await refill.refill();
    await refill.refill();
    expect(await rows('nextjs')).toHaveLength(BATCH + 2);

    await refill.refill();
    expect(posts()).toHaveLength(BATCH + 2);
  });

  it('without a settings row uses the default depth and, with no current version, skips with one warn', async () => {
    await refill.refill();

    expect(posts()).toHaveLength(0);
    for (const template of MINE) {
      expect(await rows(template)).toHaveLength(0);
      expect(warnsFor(template)).toHaveLength(1);
    }
    // DEPLOY_ENV=local → 1 (research R10): the default reached the refill, not a zero.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nextjs'));
    expect(warnsFor('nextjs')[0]![0]).toContain('target 1');
  });

  it('a template without a current version does not block the others', async () => {
    await setTarget('nextjs', 2, null);
    await setTarget('node-api', 2, 'snap-node');

    await refill.refill();

    expect(warnsFor('nextjs')).toHaveLength(1);
    expect(warnsFor('node-api')).toHaveLength(0);
    expect(await rows('nextjs')).toHaveLength(0);
    expect(await rows('node-api')).toHaveLength(2);
  });

  it('a POST that throws keeps the earlier pairs committed and rethrows', async () => {
    await setTarget('nextjs', 3, 'snap-next');
    const create = adapter.create.bind(adapter);
    let calls = 0;
    vi.spyOn(adapter, 'create').mockImplementation(async (input) => {
      calls += 1;
      if (calls === 3) throw new Error('daytona down');
      return create(input);
    });

    await expect(refill.refill()).rejects.toThrow('daytona down');

    const kept = await rows('nextjs');
    expect(kept).toHaveLength(2);
    expect(await createOps(kept.map((r) => r.id))).toHaveLength(2);
  });

  /** `n` ready rows on `snapshot`, `ready_at` one minute apart from `NOW + offsetMinutes`. */
  const seedReady = (
    template: (typeof MINE)[number],
    n: number,
    snapshot = 'snap',
    offsetMinutes = 0,
  ) =>
    db.insert(sandboxPool).values(
      Array.from({ length: n }, (_, i) => ({
        daytonaId: `${template}-${snapshot}-ready-${i}`,
        readyAt: new Date(Date.parse(NOW) + (offsetMinutes + i) * 60_000),
        snapshot,
        state: 'ready' as const,
        template,
      })),
    );

  it('releases ready rows beyond the target, oldest ready_at first: releasing + release op, one tx', async () => {
    await setTarget('nextjs', 2, 'snap');
    await seedReady('nextjs', 5);
    const before = await db.select().from(sandboxes);

    await refill.refill();

    const all = await rows('nextjs');
    const releasing = all.filter((r) => r.state === 'releasing');
    expect(releasing.map((r) => r.daytonaId).sort()).toEqual([
      'nextjs-snap-ready-0',
      'nextjs-snap-ready-1',
      'nextjs-snap-ready-2',
    ]);
    expect(
      all
        .filter((r) => r.state === 'ready')
        .map((r) => r.daytonaId)
        .sort(),
    ).toEqual(['nextjs-snap-ready-3', 'nextjs-snap-ready-4']);
    const ops = await createOps(releasing.map((r) => r.id));
    expect(ops).toHaveLength(3);
    expect(new Set(ops.map((op) => op.op))).toEqual(new Set(['release']));
    expect(new Set(ops.map((op) => op.poolId))).toEqual(new Set(releasing.map((r) => r.id)));
    expect(posts()).toHaveLength(0);
    expect(await db.select().from(sandboxes)).toEqual(before);
  });

  it('counts against the current target each pass: lowered mid-way, the next pass releases, creates nothing twice', async () => {
    await setTarget('nextjs', 3, 'snap');
    await seedReady('nextjs', 1);

    await refill.refill();
    expect(posts()).toHaveLength(2);

    await db
      .update(sandboxPoolSettings)
      .set({ targetDepth: 0 })
      .where(eq(sandboxPoolSettings.template, 'nextjs'));
    await refill.refill();

    expect(posts()).toHaveLength(2);
    const all = await rows('nextjs');
    expect(all.filter((r) => r.state === 'releasing').map((r) => r.daytonaId)).toEqual([
      'nextjs-snap-ready-0',
    ]);
    // `creating` rows are never released; they settle through the create op.
    expect(all.filter((r) => r.state === 'creating')).toHaveLength(2);
    expect(await createOps(all.map((r) => r.id))).toHaveLength(3);
  });

  /**
   * US1 (spec 015, FR-012..014, contract § 7): a version change rolls the pool over fill-before-
   * drain. Only rows on the current snapshot count toward the target; superseded rows are released
   * only once the current version alone meets it, every superseded `ready` row before any
   * current-version surplus; a superseded `creating` row settles through its own op.
   */
  describe('rollover', () => {
    it('counts only current-snapshot rows toward the target and, short of it, releases nothing', async () => {
      await setTarget('nextjs', 2, 'snap-b');
      await seedReady('nextjs', 2, 'snap-a');
      await db.insert(sandboxPool).values({
        daytonaId: 'nextjs-snap-a-creating',
        snapshot: 'snap-a',
        state: 'creating',
        template: 'nextjs',
      });

      await refill.refill();

      expect(posts()).toHaveLength(2);
      const all = await rows('nextjs');
      expect(all.filter((r) => r.state === 'releasing')).toHaveLength(0);
      expect(all.filter((r) => r.snapshot === 'snap-b')).toHaveLength(2);
      expect(all).toHaveLength(5);
    });

    it('once the current version meets the target, releases every superseded ready row before any current surplus', async () => {
      await setTarget('nextjs', 2, 'snap-b');
      // The superseded rows are the *newest* ready rows: their release is by version, not by age.
      await seedReady('nextjs', 3, 'snap-b');
      await seedReady('nextjs', 2, 'snap-a', 10);
      await db.insert(sandboxPool).values({
        daytonaId: 'nextjs-snap-a-creating',
        snapshot: 'snap-a',
        state: 'creating',
        template: 'nextjs',
      });

      await refill.refill();

      expect(posts()).toHaveLength(0);
      const all = await rows('nextjs');
      const releasing = all.filter((r) => r.state === 'releasing');
      expect(releasing.map((r) => r.daytonaId).sort()).toEqual([
        'nextjs-snap-a-ready-0',
        'nextjs-snap-a-ready-1',
        'nextjs-snap-b-ready-0',
      ]);
      expect(
        all
          .filter((r) => r.state === 'ready')
          .map((r) => r.daytonaId)
          .sort(),
      ).toEqual(['nextjs-snap-b-ready-1', 'nextjs-snap-b-ready-2']);
      expect(all.filter((r) => r.state === 'creating').map((r) => r.daytonaId)).toEqual([
        'nextjs-snap-a-creating',
      ]);
      // Superseded first, then the current-version surplus: the outbox order is the release order.
      const byId = new Map(all.map((r) => [r.id, r.daytonaId]));
      const ops = await createOps(releasing.map((r) => r.id));
      expect(ops.map((op) => byId.get(op.poolId!))).toEqual([
        'nextjs-snap-a-ready-0',
        'nextjs-snap-a-ready-1',
        'nextjs-snap-b-ready-0',
      ]);
    });

    it('a superseded creating row is left to settle even when the target is met', async () => {
      await setTarget('nextjs', 1, 'snap-b');
      await seedReady('nextjs', 1, 'snap-b');
      await db.insert(sandboxPool).values({
        daytonaId: 'nextjs-snap-a-creating',
        snapshot: 'snap-a',
        state: 'creating',
        template: 'nextjs',
      });

      await refill.refill();

      expect(posts()).toHaveLength(0);
      const all = await rows('nextjs');
      expect(all.map((r) => [r.daytonaId, r.state]).sort()).toEqual([
        ['nextjs-snap-a-creating', 'creating'],
        ['nextjs-snap-b-ready-0', 'ready'],
      ]);
    });
  });
  /**
   * US4 (spec 015 FR-010, research R5, contract § 7): after the release step, every `ready`
   * version that is not current and has no `sandbox_pool` row on its snapshot — in any state,
   * `releasing` included — has its image removed and its row `retired`; a `409` (`snapshot-busy`)
   * leaves the row for the next pass; `building` and `failed` rows are never retired.
   */
  describe('retirement', () => {
    const version = (
      snapshot: string,
      state: TemplateVersion['state'] = 'ready',
      current = false,
    ) =>
      db.insert(templateVersions).values({
        createdAt: clock.now(),
        current,
        digest: `${DIGEST_PREFIX}${snapshot}`,
        failureReason: state === 'failed' ? 'build failed' : null,
        readyAt: state === 'ready' ? clock.now() : null,
        snapshot,
        state,
        template: 'nextjs',
        updatedAt: clock.now(),
      });

    const versionRows = () =>
      db
        .select({
          retiredAt: templateVersions.retiredAt,
          snapshot: templateVersions.snapshot,
          state: templateVersions.state,
        })
        .from(templateVersions)
        .where(like(templateVersions.digest, `${DIGEST_PREFIX}%`))
        .orderBy(asc(templateVersions.snapshot));

    const removes = () =>
      fake.requests.filter((r) => r.method === 'DELETE' && r.path.startsWith('/api/snapshots/'));

    it('retires an unreferenced superseded version: DELETE the snapshot, then retired + retired_at', async () => {
      await setTarget('nextjs', 1, 'snap-b');
      await seedReady('nextjs', 1, 'snap-b');
      await version('snap-a');
      await version('snap-b', 'ready', true);
      fake.snapshots.set('snap-a', { errorReason: null, name: 'snap-a', state: 'active' });

      await refill.refill();

      expect(removes().map((r) => r.path)).toEqual(['/api/snapshots/snap-a']);
      expect(await versionRows()).toEqual([
        { retiredAt: clock.now(), snapshot: 'snap-a', state: 'retired' },
        { retiredAt: null, snapshot: 'snap-b', state: 'ready' },
      ]);
    });

    it('a releasing row still references its version: nothing is removed until it settles', async () => {
      await setTarget('nextjs', 1, 'snap-b');
      await seedReady('nextjs', 1, 'snap-b');
      await seedReady('nextjs', 1, 'snap-a');
      await version('snap-a');
      await version('snap-b', 'ready', true);

      await refill.refill();

      const all = await rows('nextjs');
      expect(all.filter((r) => r.snapshot === 'snap-a').map((r) => r.state)).toEqual(['releasing']);
      expect(removes()).toHaveLength(0);
      expect((await versionRows()).map((r) => r.state)).toEqual(['ready', 'ready']);
    });

    it('snapshot-busy leaves the row ready for the next pass and blocks nothing else', async () => {
      await setTarget('nextjs', 0, 'snap-c');
      await version('snap-a');
      await version('snap-b');
      await version('snap-c', 'ready', true);
      fake.refuseNext('remove-snapshot', 409);

      await refill.refill();

      expect(
        removes()
          .map((r) => r.path)
          .sort(),
      ).toEqual(['/api/snapshots/snap-a', '/api/snapshots/snap-b']);
      const states = (await versionRows()).map((r) => `${r.snapshot}:${r.state}`);
      expect(states).toContain('snap-c:ready');
      expect(states.filter((s) => s.endsWith(':retired'))).toHaveLength(1);
      expect(states.filter((s) => s.endsWith(':ready'))).toHaveLength(2);
    });

    it('never retires the current version with zero rows, nor building or failed rows', async () => {
      await setTarget('nextjs', 0, 'snap-c');
      await version('snap-a', 'building');
      await version('snap-b', 'failed');
      await version('snap-c', 'ready', true);

      await refill.refill();

      expect(removes()).toHaveLength(0);
      expect((await versionRows()).map((r) => r.state)).toEqual(['building', 'failed', 'ready']);
    });
  });
});
