import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { orgListResponseSchema, projectResponseSchema } from '@repo/contracts';
import { outbox, schema } from '@repo/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import { RunAccessConsumer } from '../src/modules/agent/run-access.consumer';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { PasswordHasher } from '../src/modules/identity/password/hasher';
import type { Envelope } from '../src/modules/outbox/envelope';
import { ProjectInvitationMailConsumer } from '../src/modules/tenancy/services/project-invitation-mail.consumer';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '100';
  process.env.LOGIN_THROTTLE_IP_BURST = '4000';
});

/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOGIN = '/api/v1/auth/login';
const ORGS = '/api/v1/orgs';
const PASSWORD = 'thermos-quibble-tundra-vellum';

const RUN = randomInt(0, 256);
let issuedAddresses = 0;

function nextClientAddress(): string {
  issuedAddresses += 1;

  const slot = (RUN * 256 + issuedAddresses) % 65_536;

  return `198.34.${Math.floor(slot / 256)}.${slot % 256}`;
}

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

interface Client {
  readonly cookie: string;
  readonly email: string;
  readonly userId: string;
}

interface Tenant {
  readonly orgId: string;
  readonly projectIds: string[];
}

/**
 * Spec 031 US2 end to end (quickstart, SC-004–SC-006, FR-019, FR-035): an owner shares one
 * project by email, the invitee signs up and accepts, and every change of heart holds on the next
 * request.
 */
describe('Project sharing (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let app: INestApplication;
    let suiteLock: { release: () => Promise<void> } | undefined;
    let database: ForgeDatabase;
    let hasher: PasswordHasher;
    let transactions: TenantTransactionRunner;
    let projects: ProjectService;
    const orgIds: string[] = [];
    const mailboxes = new Set<string>();

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    async function signUpAndIn(email = `t031e-${randomUUID()}@example.test`): Promise<Client> {
      mailboxes.add(email);

      const [user] = await database
        .insert(schema.users)
        .values({ email, emailVerifiedAt: new Date(), passwordHash: await hasher.hash(PASSWORD) })
        .returning({ id: schema.users.id });

      const response = await unsafe(http().post(LOGIN))
        .set('X-Forwarded-For', nextClientAddress())
        .send({ email, password: PASSWORD })
        .expect(200);

      const header = ((response.headers as unknown as Record<string, string[] | undefined>)[
        'set-cookie'
      ] ?? [])[0];

      return { cookie: header!.split(';')[0]!, email, userId: user!.id };
    }

    async function seedTenant(owner: Client): Promise<Tenant> {
      const created = await unsafe(http().post(ORGS), [owner.cookie])
        .send({ name: 'Acme', slug: `t031e-${randomUUID().slice(0, 8)}` })
        .expect(201);

      const orgId = (created.body as { org: { id: string } }).org.id;

      orgIds.push(orgId);

      const [workspace] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );

      const projectIds = await transactions.runInTenantScope(
        { orgId, userId: owner.userId },
        async () => {
          const ids: string[] = [];

          for (const name of ['Alpha', 'Beta']) {
            const project = await projects.create({
              actorId: owner.userId,
              name,
              orgId,
              ownerId: owner.userId,
              workspaceId: workspace!.id,
            });

            ids.push(project.id);
          }

          return ids;
        },
      );

      return { orgId, projectIds };
    }

    /** The newest outbox row of a type in an org, as the relay would hand it to a consumer. */
    async function lastEvent<T extends 'mail.project-invitation' | 'project.access-removed'>(
      type: T,
      orgId: string,
    ): Promise<Envelope<T>> {
      const [row] = await database
        .select()
        .from(outbox)
        .where(and(eq(outbox.type, type), eq(outbox.originOrgId, orgId)))
        .orderBy(desc(outbox.seq))
        .limit(1);

      return {
        aggregate: row!.aggregate,
        aggregateId: row!.aggregateId,
        eventId: row!.id,
        occurredAt: row!.occurredAt.toISOString(),
        orgId,
        payload: row!.payload,
        traceId: null,
        type,
      } as unknown as Envelope<T>;
    }

    /** Invite over HTTP, run the mail job, and return the token the mail carries. */
    async function inviteAndMail(
      owner: Client,
      tenant: Tenant,
      email: string,
      role = 'editor',
    ): Promise<string> {
      await unsafe(
        http().post(`${ORGS}/${tenant.orgId}/projects/${tenant.projectIds[0]!}/invitations`),
        [owner.cookie],
      )
        .send({ email, role })
        .expect(202);

      const consumer = app.get(ProjectInvitationMailConsumer, { strict: false });
      const event = await lastEvent('mail.project-invitation', tenant.orgId);
      const message = await database.transaction((tx) => consumer.handle(event, tx));
      const token = /project-invitations\/accept\/([A-Za-z0-9_-]+)\?org=/.exec(
        message?.text ?? '',
      )?.[1];

      return token ?? expect.unreachable('the mail carries no link');
    }

    function accept(guest: Client, orgId: string, token: string) {
      return unsafe(http().post(`${ORGS}/${orgId}/project-invitations/accept`), [
        guest.cookie,
      ]).send({ token });
    }

    /** A guest who accepted an editor invitation to the tenant's first project. */
    async function sharedWith(role = 'editor') {
      const owner = await signUpAndIn();
      const tenant = await seedTenant(owner);
      const email = `t031e-${randomUUID()}@example.test`;
      const token = await inviteAndMail(owner, tenant, email, role);
      const guest = await signUpAndIn(email);

      await accept(guest, tenant.orgId, token).expect(200);

      return { guest, owner, tenant };
    }

    function projectPath(tenant: Tenant, index = 0): string {
      return `${ORGS}/${tenant.orgId}/projects/${tenant.projectIds[index]!}`;
    }

    beforeAll(async () => {
      // This suite reads a mail's single-use token itself; another suite's relay must not get there first.
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      hasher = app.get(PasswordHasher);
      transactions = app.get(TenantTransactionRunner);
      projects = app.get(ProjectService);
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      if (mailboxes.size > 0) {
        await database.delete(schema.users).where(inArray(schema.users.email, [...mailboxes]));
      }

      await app?.close();
      await suiteLock?.release();
    });

    it('invite → mail job → accept as a new account → GET /orgs lists the org as guest → the project is readable', async () => {
      const owner = await signUpAndIn();
      const tenant = await seedTenant(owner);
      const email = `t031e-${randomUUID()}@example.test`;

      const token = await inviteAndMail(owner, tenant, email);

      // The account is created after the invitation, as a newcomer's would be.
      const guest = await signUpAndIn(email);

      const accepted = await accept(guest, tenant.orgId, token).expect(200);

      expect(accepted.body).toEqual({ projectId: tenant.projectIds[0] });

      const listed = await http().get(ORGS).set('Cookie', guest.cookie).expect(200);

      expect(orgListResponseSchema.parse(listed.body).orgs).toEqual([
        expect.objectContaining({ access: 'guest', id: tenant.orgId, role: null }),
      ]);

      const project = await http().get(projectPath(tenant)).set('Cookie', guest.cookie).expect(200);

      expect(projectResponseSchema.parse(project.body).project.id).toBe(tenant.projectIds[0]);
    });

    it('the guest is refused another project, the member list and org settings', async () => {
      const { guest, tenant } = await sharedWith();

      for (const path of [
        projectPath(tenant, 1),
        `${ORGS}/${tenant.orgId}/members`,
        `${ORGS}/${tenant.orgId}`,
      ]) {
        const response = await http().get(path).set('Cookie', guest.cookie);

        expect([403, 404], path).toContain(response.status);
      }
    });

    it('a role change and a removal hold on the very next request', async () => {
      const { guest, owner, tenant } = await sharedWith('editor');
      const grant = `${projectPath(tenant)}/grants/${guest.userId}`;
      const permissions = async () =>
        projectResponseSchema.parse(
          (await http().get(projectPath(tenant)).set('Cookie', guest.cookie).expect(200)).body,
        ).project.permissions;

      expect(await permissions()).toContain('project:agent.run');

      await unsafe(http().put(grant), [owner.cookie]).send({ role: 'viewer' }).expect(200);

      expect(await permissions()).not.toContain('project:agent.run');

      await unsafe(http().delete(grant), [owner.cookie]).expect(200);

      const gone = await http().get(projectPath(tenant)).set('Cookie', guest.cookie);

      expect([403, 404]).toContain(gone.status);
    });

    it("removal cancels the guest's waiting and running runs", async () => {
      const { guest, owner, tenant } = await sharedWith('editor');
      const projectId = tenant.projectIds[0]!;
      const runs = await transactions.runInTenantTransaction(tenant.orgId, (tx) =>
        tx
          .insert(schema.agentRuns)
          .values([
            {
              model: 'test',
              orgId: tenant.orgId,
              projectId,
              startedAt: new Date(),
              status: 'running',
              userId: guest.userId,
            },
            {
              model: 'test',
              orgId: tenant.orgId,
              projectId,
              status: 'queued',
              userId: guest.userId,
            },
          ])
          .returning({ id: schema.agentRuns.id }),
      );

      await unsafe(http().delete(`${projectPath(tenant)}/grants/${guest.userId}`), [
        owner.cookie,
      ]).expect(200);

      const consumer = app.get(RunAccessConsumer, { strict: false });
      const event = await lastEvent('project.access-removed', tenant.orgId);

      expect(event.payload).toEqual({ orgId: tenant.orgId, projectId, userId: guest.userId });

      const effects = await database.transaction((tx) => consumer.handle(event, tx));

      expect(effects.waiting).toEqual([runs[1]!.id]);
      expect(effects.cancelled).toEqual([runs[0]!.id]);
    });

    it('the last owner cannot be removed', async () => {
      const owner = await signUpAndIn();
      const tenant = await seedTenant(owner);

      const refused = await unsafe(http().delete(`${projectPath(tenant)}/grants/${owner.userId}`), [
        owner.cookie,
      ]).expect(409);

      expect(refused.body).toMatchObject({ reason: 'last-owner' });
    });
  });
});
