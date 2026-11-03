import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { problemDetailSchema, usageRunListResponseSchema } from '@repo/contracts';
import { type NewAgentRun, schema } from '@repo/db';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  // Reads only: the rows are inserted as they stand, and nothing here runs.
  process.env.RUN_PROFILES = 'api';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.THROTTLE_LIMIT = '100000';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const usageOf = (orgId: string, query = '') => `/api/v1/orgs/${orgId}/usage/runs${query}`;

/**
 * Settings → Usage (contracts usage.ts): `GET /orgs/:orgId/usage/runs` lists the caller's own runs
 * in the organisation, newest first, keyset-paged, with what paid for each. Another member's runs
 * and another organisation's never appear; the guard refuses another organisation outright.
 */
describe('Usage (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and Redis', () => {
    let app: INestApplication;
    let world: TwoTenantWorld;
    let member: Principal;
    let transactions: TenantTransactionRunner;
    /** Alpha owner's runs, oldest first. */
    const own: string[] = [];
    let memberRun: string;
    let betaRun: string;

    async function insert(orgId: string, run: Omit<NewAgentRun, 'orgId'>): Promise<string> {
      const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .insert(schema.agentRuns)
          .values({ ...run, orgId })
          .returning({ id: schema.agentRuns.id }),
      );

      return row!.id;
    }

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      transactions = app.get(TenantTransactionRunner);
      world = await createTwoTenantWorld(app);
      member = await signUpAndIn(app, 'usage-member');
      await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
        tx.insert(schema.memberships).values({
          acceptedAt: new Date(),
          orgId: world.alpha.orgId,
          role: 'member',
          userId: member.userId,
        }),
      );

      const { orgId, owner, projectId } = world.alpha;
      const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 9, minute));
      const ended = { endedAt: at(59), startedAt: at(58), status: 'succeeded' as const };

      // Ended rows: a project holds one started, non-terminal run at most (031).
      own.push(
        await insert(orgId, {
          ...ended,
          costMicros: 4_200,
          createdAt: at(1),
          credentialMode: 'PLATFORM',
          model: 'claude-sonnet-5',
          projectId,
          userId: owner.userId,
        }),
        await insert(orgId, {
          ...ended,
          createdAt: at(2),
          credentialMode: 'BYOK',
          inputTokens: 120,
          model: 'claude-opus-5',
          outputTokens: 30,
          projectId,
          userId: owner.userId,
        }),
        await insert(orgId, {
          createdAt: at(3),
          credentialMode: 'BYOS',
          model: 'claude',
          projectId,
          userId: owner.userId,
        }),
      );
      memberRun = await insert(orgId, {
        ...ended,
        createdAt: at(4),
        credentialMode: 'BYOK',
        model: 'claude-sonnet-5',
        projectId,
        userId: member.userId,
      });
      betaRun = await insert(world.beta.orgId, {
        ...ended,
        createdAt: at(5),
        credentialMode: 'BYOK',
        model: 'claude-sonnet-5',
        projectId: world.beta.projectId,
        userId: world.beta.owner.userId,
      });
    }, 600_000);

    afterAll(async () => {
      if (world) await destroyTwoTenantWorld(app, world);
      if (member) {
        await app
          .get<ForgeDatabase>(APP_DATABASE)
          .delete(schema.users)
          .where(inArray(schema.users.email, [member.email]));
      }
      await app?.close();
    });

    it('lists the caller’s own runs, newest first, with what paid and the project’s name', async () => {
      const response = await http(app)
        .get(usageOf(world.alpha.orgId))
        .set('Cookie', world.alpha.owner.cookie)
        .expect(200);
      const page = usageRunListResponseSchema.parse(response.body);

      expect(page.nextCursor).toBeNull();
      expect(page.runs.map((run) => run.id)).toEqual([...own].reverse());
      expect(page.runs.map((run) => [run.paidWith, run.costMicros, run.model])).toEqual([
        ['subscription', null, null],
        ['api-key', null, 'claude-opus-5'],
        ['platform-credits', 4_200, 'claude-sonnet-5'],
      ]);
      expect(page.runs[1]).toMatchObject({
        finishedAt: new Date(Date.UTC(2026, 10, 3, 9, 59)).toISOString(),
        inputTokens: 120,
        outputTokens: 30,
        projectId: world.alpha.projectId,
        status: 'succeeded',
      });
      expect(page.runs[1]!.projectName.length).toBeGreaterThan(0);
    });

    it('another member’s and another organisation’s runs never appear', async () => {
      const ownerPage = usageRunListResponseSchema.parse(
        (
          await http(app)
            .get(usageOf(world.alpha.orgId))
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200)
        ).body,
      );
      const memberPage = usageRunListResponseSchema.parse(
        (await http(app).get(usageOf(world.alpha.orgId)).set('Cookie', member.cookie).expect(200))
          .body,
      );
      const betaPage = usageRunListResponseSchema.parse(
        (
          await http(app)
            .get(usageOf(world.beta.orgId))
            .set('Cookie', world.beta.owner.cookie)
            .expect(200)
        ).body,
      );

      expect(ownerPage.runs.map((run) => run.id)).not.toContain(memberRun);
      expect(ownerPage.runs.map((run) => run.id)).not.toContain(betaRun);
      expect(memberPage.runs.map((run) => run.id)).toEqual([memberRun]);
      expect(betaPage.runs.map((run) => run.id)).toEqual([betaRun]);

      // Another organisation's list is the guard's refusal, not an empty page.
      const refused = await http(app)
        .get(usageOf(world.beta.orgId))
        .set('Cookie', world.alpha.owner.cookie)
        .expect(403);
      expect(problemDetailSchema.parse(refused.body).type).toContain('permission-denied');
      expect(JSON.stringify(refused.body)).not.toContain(betaRun);
      await http(app)
        .get(usageOf(world.alpha.orgId))
        .set('Cookie', world.outsider.cookie)
        .expect(403);
      await http(app).get(usageOf(world.alpha.orgId)).expect(401);
    });

    it('pages by keyset cursor without a gap or a repeat', async () => {
      const first = usageRunListResponseSchema.parse(
        (
          await http(app)
            .get(usageOf(world.alpha.orgId, '?limit=2'))
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200)
        ).body,
      );

      expect(first.runs).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = usageRunListResponseSchema.parse(
        (
          await http(app)
            .get(usageOf(world.alpha.orgId, `?limit=2&cursor=${first.nextCursor!}`))
            .set('Cookie', world.alpha.owner.cookie)
            .expect(200)
        ).body,
      );

      expect(second.nextCursor).toBeNull();
      expect([...first.runs, ...second.runs].map((run) => run.id)).toEqual([...own].reverse());

      await http(app)
        .get(usageOf(world.alpha.orgId, '?limit=500'))
        .set('Cookie', world.alpha.owner.cookie)
        .expect(422);
    });
  });
});
