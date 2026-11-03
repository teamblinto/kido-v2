import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  problemDetailSchema,
  projectListResponseSchema,
  projectResponseSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { OutboxWriter } from '../src/modules/outbox/outbox-writer';
import { QueueRegistry } from '../src/modules/outbox/queue-registry';
import { OutboxRelay } from '../src/modules/outbox/relay';
import { PermissionCache } from '../src/modules/rbac/permission-cache';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { unsafe } from './support/csrf-client';
import { holdOutboxSuiteLock } from './support/outbox-suite-lock';
import {
  createTwoTenantWorld,
  destroyTwoTenantWorld,
  http,
  type Principal,
  signUpAndIn,
  type TwoTenantWorld,
} from './support/two-tenant-fixture';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const ORGS = '/api/v1/orgs';
/** Booting waits on the outbox suite lock, which another relay suite may hold for minutes. */
const LOCKED_BOOT_TIMEOUT_MS = 600_000;

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** A problem body without the members that differ per request. */
function comparable(body: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(
      ([member]) => member !== 'instance' && member !== 'requestId',
    ),
  );
}

/**
 * Spec 007: the workspace and project lifecycle over HTTP, one `it` per authorisation cell
 * (SC-002) and one per success criterion the spec's matrix names.
 */
describe('Project lifecycle (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let app: INestApplication;
    let world: TwoTenantWorld;
    let transactions: TenantTransactionRunner;
    let suiteLock: { release: () => Promise<void> } | undefined;
    const extraEmails: string[] = [];

    function projectsPath(orgId: string, workspaceId: string): string {
      return `${ORGS}/${orgId}/workspaces/${workspaceId}/projects`;
    }

    function create(who: Principal, body: object, key?: string): request.Test {
      const { orgId, workspaceId } = world.alpha;
      const test = unsafe(http(app).post(projectsPath(orgId, workspaceId)), [who.cookie]);

      return (key === undefined ? test : test.set('Idempotency-Key', key)).send(body);
    }

    function rename(
      who: Principal,
      projectId: string,
      body: object,
      workspaceId = world.alpha.workspaceId,
    ): request.Test {
      const path = `${projectsPath(world.alpha.orgId, workspaceId)}/${projectId}`;

      return unsafe(http(app).patch(path), [who.cookie]).send(body);
    }

    function archive(who: Principal, projectId: string): request.Test {
      const { orgId, workspaceId } = world.alpha;

      return unsafe(http(app).delete(`${projectsPath(orgId, workspaceId)}/${projectId}`), [
        who.cookie,
      ]).send();
    }

    async function created(who: Principal, name: string): Promise<string> {
      const response = await create(who, { name }).expect(201);

      return projectResponseSchema.parse(response.body).project.id;
    }

    function read(who: Principal, projectId: string): request.Test {
      return http(app)
        .get(`${ORGS}/${world.alpha.orgId}/projects/${projectId}`)
        .set('Cookie', who.cookie);
    }

    /** A signed-in account, optionally an alpha member, optionally holding a workspace role. */
    async function principal(
      label: string,
      membership?: {
        orgRole?: 'admin' | 'billing' | 'member';
        projectGrant?: string;
        workspaceRole?: 'admin' | 'editor' | 'viewer';
      },
    ): Promise<Principal> {
      const who = await signUpAndIn(app, label);

      extraEmails.push(who.email);

      if (membership !== undefined) {
        const { orgId, workspaceId } = world.alpha;

        await transactions.runInTenantTransaction(orgId, async (tx) => {
          await tx.insert(schema.memberships).values({
            acceptedAt: new Date(),
            orgId,
            role: membership.orgRole ?? 'member',
            userId: who.userId,
          });

          if (membership.workspaceRole !== undefined) {
            await tx
              .insert(schema.workspaceMembers)
              .values({ orgId, role: membership.workspaceRole, userId: who.userId, workspaceId });
          }

          if (membership.projectGrant !== undefined) {
            await tx.insert(schema.projectGrants).values({
              orgId,
              projectId: membership.projectGrant,
              role: 'editor',
              userId: who.userId,
            });
          }
        });
      }

      return who;
    }

    async function projectRow(orgId: string, projectId: string) {
      return transactions.runInTenantTransaction(orgId, async (tx) => ({
        grants: await tx
          .select({ role: schema.projectGrants.role, userId: schema.projectGrants.userId })
          .from(schema.projectGrants)
          .where(eq(schema.projectGrants.projectId, projectId)),
        project: (
          await tx
            .select({
              name: schema.projects.name,
              previewLabel: schema.projects.previewLabel,
              template: schema.projects.template,
            })
            .from(schema.projects)
            .where(eq(schema.projects.id, projectId))
        )[0],
      }));
    }

    async function projectCount(orgId: string, name: string): Promise<number> {
      const rows = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .select({ id: schema.projects.id })
          .from(schema.projects)
          .where(and(eq(schema.projects.orgId, orgId), eq(schema.projects.name, name))),
      );

      return rows.length;
    }

    beforeAll(async () => {
      // This suite appends thousands of events and the app's relay publishes them for real, so it
      // is serialised with the other relay-running suites (see `outbox-suite-lock.ts`).
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      transactions = app.get(TenantTransactionRunner);
      world = await createTwoTenantWorld(app);
    }, LOCKED_BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await destroyTwoTenantWorld(app, world);

      if (extraEmails.length > 0) {
        await app
          .get<ForgeDatabase>(APP_DATABASE)
          .delete(schema.users)
          .where(inArray(schema.users.email, extraEmails));
      }

      // Drain what this suite appended before closing: a tail of unpublished rows would sit at
      // the head of the next relay suite's batch.
      const publish = app.get(QueueRegistry).publish;

      while ((await app.get(OutboxRelay).tick(publish)) > 0) {
        // keep ticking
      }

      await app?.close();
      await suiteLock?.release();
    });

    describe('POST /orgs/:orgId/workspaces/:workspaceId/projects', () => {
      it('lets a workspace editor create a project, grants them owner, and lists it', async () => {
        const editor = await principal('editor', { workspaceRole: 'editor' });

        const response = await create(editor, { name: 'Shop', template: 'nextjs' }).expect(201);
        const { project } = projectResponseSchema.parse(response.body);

        expect(project.name).toBe('Shop');

        const { grants, project: row } = await projectRow(world.alpha.orgId, project.id);

        expect(row).toMatchObject({ name: 'Shop', template: 'nextjs' });
        expect(grants).toEqual([{ role: 'owner', userId: editor.userId }]);

        const listed = await http(app)
          .get(`${ORGS}/${world.alpha.orgId}/projects`)
          .set('Cookie', editor.cookie)
          .expect(200);

        expect(
          projectListResponseSchema.parse(listed.body).projects.map((entry) => entry.id),
        ).toContain(project.id);
      });

      it('defaults the template to vite-react', async () => {
        const response = await create(world.alpha.owner, { name: 'Defaulted' }).expect(201);
        const { project } = projectResponseSchema.parse(response.body);

        expect((await projectRow(world.alpha.orgId, project.id)).project?.template).toBe(
          'vite-react',
        );
      });

      /**
       * SC-002: `403 permission-denied` for a viewer, a member with no workspace role and a guest
       * of the organisation. None of them learns whether the workspace exists, and nothing is
       * written.
       */
      it.each([
        ['a workspace viewer', () => principal('viewer', { workspaceRole: 'viewer' })],
        ['an org member with no workspace role', () => principal('member', {})],
        ['a signed-in outsider', () => Promise.resolve(world.outsider)],
      ])('refuses %s with permission-denied and writes nothing', async (_label, who) => {
        const name = `Refused ${randomUUID()}`;
        const response = await create(await who(), { name }).expect(403);

        expect(problemDetailSchema.parse(response.body).type).toContain('permission-denied');
        expect(await projectCount(world.alpha.orgId, name)).toBe(0);
      });

      /** The uniform denial (§10.7): another tenant's owner gets the viewer's answer, byte for byte. */
      it('answers the other tenant’s owner exactly as it answers a viewer', async () => {
        const viewer = await principal('viewer-2', { workspaceRole: 'viewer' });
        const asViewer = await create(viewer, { name: 'Probe' }).expect(403);
        const asBeta = await create(world.beta.owner, { name: 'Probe' }).expect(403);

        expect(comparable(asBeta.body)).toEqual(comparable(asViewer.body));
        expect(await projectCount(world.alpha.orgId, 'Probe')).toBe(0);
      });

      it.each([
        ['an unknown template', { name: 'X', template: 'rails' }],
        ['an empty name', { name: '' }],
        ['a whitespace-only name', { name: '   ' }],
        ['a 121-character name', { name: 'a'.repeat(121) }],
      ])('refuses %s with validation-failed', async (_label, body) => {
        const response = await create(world.alpha.owner, body).expect(422);

        expect(problemDetailSchema.parse(response.body).type).toContain('validation-failed');
      });

      /** SC-005. */
      it('replays an Idempotency-Key with the original body and one row', async () => {
        const key = randomUUID();
        const name = `Once ${randomUUID()}`;

        const first = await create(world.alpha.owner, { name }, key).expect(201);
        const replay = await create(world.alpha.owner, { name }, key).expect(201);

        expect(replay.body).toStrictEqual(first.body);
        expect(await projectCount(world.alpha.orgId, name)).toBe(1);
      });

      /** The interceptor's existing answer for a reused key is a `409`, not the spec's `422`. */
      it('refuses the same key with a different body', async () => {
        const key = randomUUID();

        await create(world.alpha.owner, { name: 'First' }, key).expect(201);

        const response = await create(world.alpha.owner, { name: 'Second' }, key).expect(409);

        expect(problemDetailSchema.parse(response.body).type).toContain('idempotency-key-reused');
      });

      /**
       * SC-003, at the service level for speed: a thousand labels, all distinct, all 32 lowercase
       * hex characters, and none a prefix of the project's own id or name.
       */
      it('mints a thousand distinct 32-hex labels that carry nothing about the project', async () => {
        const projects = app.get(ProjectService);
        const { orgId, owner, workspaceId } = world.alpha;
        const ids = new Set<string>();

        await transactions.runInTenantScope({ orgId, userId: owner.userId }, async () => {
          for (let index = 0; index < 1_000; index += 1) {
            const name = `bulk-${index}`;
            const project = await projects.create({
              actorId: owner.userId,
              name,
              orgId,
              ownerId: owner.userId,
              workspaceId,
            });

            ids.add(project.id);
            expect(name.startsWith(project.id)).toBe(false);
          }
        });

        const rows = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ id: schema.projects.id, previewLabel: schema.projects.previewLabel })
            .from(schema.projects)
            .where(inArray(schema.projects.id, [...ids])),
        );

        expect(rows).toHaveLength(1_000);
        expect(new Set(rows.map((row) => row.previewLabel)).size).toBe(1_000);

        for (const row of rows) {
          expect(row.previewLabel).toMatch(/^[0-9a-f]{32}$/);
          expect(row.id.replaceAll('-', '').startsWith(row.previewLabel)).toBe(false);
        }
      }, 120_000);
    });

    /**
     * US2: the audit row and the outbox event are written on the same handle as the project, so
     * either all of them commit or none of them do (SC-004).
     */
    describe('events and audit', () => {
      function db(): ForgeDatabase {
        return app.get<ForgeDatabase>(APP_DATABASE);
      }

      async function outboxFor(projectId: string) {
        return db()
          .select({ payload: schema.outbox.payload, type: schema.outbox.type })
          .from(schema.outbox)
          .where(eq(schema.outbox.aggregateId, projectId));
      }

      /**
       * `audit_log` is under RLS, so it is read inside the tenant; `outbox` is not, so it is scoped
       * by the payload's `orgId` — other suites append `project.created` rows in parallel.
       */
      async function auditFor(projectId: string): Promise<string[]> {
        const rows = await transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
          tx
            .select({ action: schema.auditLog.action })
            .from(schema.auditLog)
            .where(eq(schema.auditLog.target, projectId)),
        );

        return rows.map((row) => row.action).sort();
      }

      async function tally(): Promise<{ audit: number; outbox: number }> {
        const [audit, outbox] = await Promise.all([
          transactions.runInTenantTransaction(world.alpha.orgId, (tx) =>
            tx
              .select({ id: schema.auditLog.id })
              .from(schema.auditLog)
              .where(eq(schema.auditLog.action, 'project.created')),
          ),
          db()
            .select({ id: schema.outbox.id })
            .from(schema.outbox)
            .where(
              and(
                eq(schema.outbox.type, 'project.created'),
                sql`${schema.outbox.payload} ->> 'orgId' = ${world.alpha.orgId}`,
              ),
            ),
        ]);

        return { audit: audit.length, outbox: outbox.length };
      }

      it('appends one project.created with an ids-only payload and both audit rows', async () => {
        const { orgId, owner, workspaceId } = world.alpha;
        const response = await create(owner, { name: 'Heard', template: 'nextjs' }).expect(201);
        const { project } = projectResponseSchema.parse(response.body);

        expect(await outboxFor(project.id)).toEqual([
          {
            payload: {
              actorId: owner.userId,
              orgId,
              projectId: project.id,
              template: 'nextjs',
              workspaceId,
            },
            type: 'project.created',
          },
        ]);
        expect(await auditFor(project.id)).toEqual(['project-grant.granted', 'project.created']);
      });

      it('appends one project.archived and records project.deleted after an archive', async () => {
        const { orgId, owner, workspaceId } = world.alpha;
        const projectId = await created(owner, 'Archived');

        await archive(owner, projectId).expect(204);

        expect(
          (await outboxFor(projectId)).filter((row) => row.type === 'project.archived'),
        ).toEqual([
          {
            payload: { actorId: owner.userId, orgId, projectId, workspaceId },
            type: 'project.archived',
          },
        ]);
        expect(await auditFor(projectId)).toContain('project.deleted');
      });

      /** SC-004: a failure after the insert leaves no project, grant, audit row or event behind. */
      it('leaves nothing behind when the event cannot be appended', async () => {
        const name = `Rolled back ${randomUUID()}`;
        const before = await tally();
        const append = vi
          .spyOn(app.get(OutboxWriter), 'append')
          .mockRejectedValueOnce(new Error('outbox unavailable'));

        try {
          await create(world.alpha.owner, { name }).expect(500);
        } finally {
          append.mockRestore();
        }

        expect(await projectCount(world.alpha.orgId, name)).toBe(0);
        expect(await tally()).toEqual(before);

        const grants = await db()
          .select({ id: schema.projectGrants.projectId })
          .from(schema.projectGrants)
          .leftJoin(schema.projects, eq(schema.projects.id, schema.projectGrants.projectId))
          .where(isNull(schema.projects.id));

        expect(grants).toEqual([]);
      });
    });

    describe('PATCH /orgs/:orgId/workspaces/:workspaceId/projects/:projectId', () => {
      it('lets a workspace editor rename; the read shows the new name and the label is unchanged', async () => {
        const editor = await principal('renamer', { workspaceRole: 'editor' });
        const projectId = await created(editor, 'Before');
        const before = await projectRow(world.alpha.orgId, projectId);

        await rename(editor, projectId, { name: 'After' }).expect(204);

        const response = await read(editor, projectId).expect(200);

        expect(projectResponseSchema.parse(response.body).project.name).toBe('After');
        expect((await projectRow(world.alpha.orgId, projectId)).project?.previewLabel).toBe(
          before.project?.previewLabel,
        );
      });

      it('refuses a workspace viewer with permission-denied', async () => {
        const projectId = await created(world.alpha.owner, 'Viewed');
        const viewer = await principal('viewer-3', { workspaceRole: 'viewer' });
        const response = await rename(viewer, projectId, { name: 'Nope' }).expect(403);

        expect(problemDetailSchema.parse(response.body).type).toContain('permission-denied');
      });

      /**
       * The path names a workspace the caller *may* write to, but the project lives in another
       * one. A workspace the caller holds no role in would be the guard's `403` instead.
       */
      it('answers not-found for a project under the wrong workspace id', async () => {
        const { orgId, owner } = world.alpha;
        const projectId = await created(owner, 'Misfiled');
        const otherWorkspaceId = await transactions.runInTenantTransaction(orgId, async (tx) => {
          const [workspace] = await tx
            .insert(schema.workspaces)
            .values({ name: 'Other', orgId })
            .returning({ id: schema.workspaces.id });

          await tx
            .insert(schema.workspaceMembers)
            .values({ orgId, role: 'admin', userId: owner.userId, workspaceId: workspace!.id });

          return workspace!.id;
        });

        await app.get(PermissionCache).invalidate(orgId, owner.userId);

        const response = await rename(owner, projectId, { name: 'X' }, otherWorkspaceId).expect(
          404,
        );

        expect(problemDetailSchema.parse(response.body).type).toContain('not-found');
      });

      it('answers not-found for an archived project', async () => {
        const projectId = await created(world.alpha.owner, 'Gone');

        await archive(world.alpha.owner, projectId).expect(204);

        const response = await rename(world.alpha.owner, projectId, { name: 'X' }).expect(404);

        expect(problemDetailSchema.parse(response.body).type).toContain('not-found');
      });

      it('refuses an empty name with validation-failed', async () => {
        const projectId = await created(world.alpha.owner, 'Named');
        const response = await rename(world.alpha.owner, projectId, { name: '' }).expect(422);

        expect(problemDetailSchema.parse(response.body).type).toContain('validation-failed');
      });
    });

    describe('DELETE /orgs/:orgId/workspaces/:workspaceId/projects/:projectId', () => {
      /**
       * SC-006: after the archive the project is gone from every read and from the resolved set.
       * The read is a `403`, not a `404`: R5's join means no grant on it resolves any more — the
       * creator's included — so the guard's uniform denial answers before the service could.
       */
      it('lets a workspace admin archive; the project then vanishes from reads and from access', async () => {
        const admin = await principal('archiver', { workspaceRole: 'admin' });
        const projectId = await created(world.alpha.owner, 'Doomed');
        const editor = await principal('former-editor', { projectGrant: projectId });

        await read(editor, projectId).expect(200);

        await archive(admin, projectId).expect(204);

        await read(world.alpha.owner, projectId).expect(403);

        const listed = await http(app)
          .get(`${ORGS}/${world.alpha.orgId}/projects`)
          .set('Cookie', world.alpha.owner.cookie)
          .expect(200);

        expect(
          projectListResponseSchema.parse(listed.body).projects.map((entry) => entry.id),
        ).not.toContain(projectId);

        const former = await read(editor, projectId).expect(403);

        expect(problemDetailSchema.parse(former.body).type).toContain('permission-denied');

        await archive(admin, projectId).expect(404);
      });

      it.each([
        ['a workspace editor', () => principal('editor-2', { workspaceRole: 'editor' })],
        [
          'a project editor with no workspace role',
          (projectId: string) => principal('grantee', { projectGrant: projectId }),
        ],
      ])('refuses %s with permission-denied', async (_label, who) => {
        const projectId = await created(world.alpha.owner, 'Kept');
        const response = await archive(await who(projectId), projectId).expect(403);

        expect(problemDetailSchema.parse(response.body).type).toContain('permission-denied');

        await read(world.alpha.owner, projectId).expect(200);
      });
    });
    describe('/orgs/:orgId/workspaces', () => {
      function workspacesPath(workspaceId?: string): string {
        const base = `${ORGS}/${world.alpha.orgId}/workspaces`;

        return workspaceId === undefined ? base : `${base}/${workspaceId}`;
      }

      function createWorkspace(who: Principal, body: object): request.Test {
        return unsafe(http(app).post(workspacesPath()), [who.cookie]).send(body);
      }

      async function createdWorkspace(who: Principal, name: string): Promise<string> {
        const response = await createWorkspace(who, { name }).expect(201);

        return workspaceResponseSchema.parse(response.body).workspace.id;
      }

      function renameWorkspace(who: Principal, workspaceId: string, body: object): request.Test {
        return unsafe(http(app).patch(workspacesPath(workspaceId)), [who.cookie]).send(body);
      }

      function archiveWorkspace(who: Principal, workspaceId: string): request.Test {
        return unsafe(http(app).delete(workspacesPath(workspaceId)), [who.cookie]).send();
      }

      function readWorkspace(who: Principal, workspaceId: string): request.Test {
        return http(app).get(workspacesPath(workspaceId)).set('Cookie', who.cookie);
      }

      async function listedIds(who: Principal): Promise<string[]> {
        const response = await http(app)
          .get(workspacesPath())
          .set('Cookie', who.cookie)
          .expect(200);

        return workspaceListResponseSchema.parse(response.body).workspaces.map((entry) => entry.id);
      }

      it.each([
        ['an org admin', () => principal('ws-admin', { orgRole: 'admin' })],
        ['the org owner', () => Promise.resolve(world.alpha.owner)],
      ])(
        'lets %s create a workspace they then hold admin in, and lists it',
        async (_label, who) => {
          const caller = await who();
          const response = await createWorkspace(caller, { name: 'Fresh' }).expect(201);
          const { workspace } = workspaceResponseSchema.parse(response.body);

          expect(workspace).toMatchObject({ name: 'Fresh', role: 'admin' });
          expect(await listedIds(caller)).toContain(workspace.id);
        },
      );

      it.each([
        ['an org member', () => principal('ws-member', { orgRole: 'member' })],
        ['a billing member', () => principal('ws-billing', { orgRole: 'billing' })],
      ])('refuses %s with permission-denied', async (_label, who) => {
        const response = await createWorkspace(await who(), { name: 'Nope' }).expect(403);

        expect(problemDetailSchema.parse(response.body).type).toContain('permission-denied');
      });

      it('renames with 204 and the read shows the new name', async () => {
        const { owner } = world.alpha;
        const workspaceId = await createdWorkspace(owner, 'Before');

        await renameWorkspace(owner, workspaceId, { name: 'After' }).expect(204);

        const response = await readWorkspace(owner, workspaceId).expect(200);

        expect(workspaceResponseSchema.parse(response.body).workspace.name).toBe('After');
      });

      /**
       * SC-007: archiving a workspace with two live and one archived project writes exactly two
       * `project.archived` events, two `project.deleted` rows and one `workspace.deleted` row, and
       * afterwards the workspace and both projects answer as though they never existed.
       */
      it('archives the workspace and cascades to its live projects only', async () => {
        const { orgId, owner } = world.alpha;
        const workspaceId = await createdWorkspace(owner, 'Cascade');
        const path = projectsPath(orgId, workspaceId);

        async function project(name: string): Promise<string> {
          const response = await unsafe(http(app).post(path), [owner.cookie])
            .send({ name })
            .expect(201);

          return projectResponseSchema.parse(response.body).project.id;
        }

        const live = [await project('Live 1'), await project('Live 2')];
        const gone = await project('Already gone');

        await unsafe(http(app).delete(`${path}/${gone}`), [owner.cookie])
          .send()
          .expect(204);

        const db = app.get<ForgeDatabase>(APP_DATABASE);
        const eventsBefore = await db
          .select({ id: schema.outbox.id })
          .from(schema.outbox)
          .where(eq(schema.outbox.type, 'project.archived'));

        await archiveWorkspace(owner, workspaceId).expect(204);

        await readWorkspace(owner, workspaceId).expect(403);
        expect(await listedIds(owner)).not.toContain(workspaceId);

        for (const projectId of live) {
          await read(owner, projectId).expect(403);
        }

        const events = await db
          .select({ aggregateId: schema.outbox.aggregateId })
          .from(schema.outbox)
          .where(eq(schema.outbox.type, 'project.archived'));

        expect(events.length - eventsBefore.length).toBe(2);
        expect(events.map((row) => row.aggregateId)).toEqual(expect.arrayContaining(live));

        const audit = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ action: schema.auditLog.action, target: schema.auditLog.target })
            .from(schema.auditLog)
            .where(inArray(schema.auditLog.target, [workspaceId, ...live])),
        );

        expect(audit.filter((row) => row.action === 'project.deleted')).toHaveLength(2);
        expect(audit.filter((row) => row.action === 'workspace.deleted')).toEqual([
          { action: 'workspace.deleted', target: workspaceId },
        ]);

        await archiveWorkspace(owner, workspaceId).expect(404);
      });

      /** US4-4: the organisation's last live workspace can be archived too. Beta has exactly one. */
      it('archives the org’s last workspace', async () => {
        const { orgId, owner, workspaceId } = world.beta;
        const path = `${ORGS}/${orgId}/workspaces`;

        await unsafe(http(app).delete(`${path}/${workspaceId}`), [owner.cookie])
          .send()
          .expect(204);

        const after = await http(app).get(path).set('Cookie', owner.cookie).expect(200);

        expect(workspaceListResponseSchema.parse(after.body).workspaces).toEqual([]);
      });
    });
  });
});
