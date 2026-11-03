import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import type * as Crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../../../app.module';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { PermissionCache } from '../../rbac/permission-cache';
import { MembershipService } from './membership.service';
import { OrgService } from './org.service';
import { ProjectService } from './project.service';

// `randomBytes` as itself, except where one test scripts a preview-label collision.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();

  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

describe('ProjectService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let moduleRef: TestingModule;
    let database: ForgeDatabase;
    let orgs: OrgService;
    let memberships: MembershipService;
    let projects: ProjectService;
    let transactions: TenantTransactionRunner;
    let cache: PermissionCache;
    const orgIds: string[] = [];
    const userIds: string[] = [];

    async function seedUser(): Promise<string> {
      const [user] = await database
        .insert(schema.users)
        .values({ email: `t27p-${randomUUID()}@example.test`, passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userIds.push(user!.id);

      return user!.id;
    }

    async function asRequest<T>(orgId: string, userId: string, fn: () => Promise<T>): Promise<T> {
      return transactions.runInTenantScope({ orgId, userId }, () => fn());
    }

    /** An organisation with three projects in its default workspace. */
    async function fixture() {
      const ownerId = await seedUser();
      const org = await orgs.create(ownerId, {
        name: 'Three projects',
        slug: `t27p-${randomUUID().slice(0, 8)}`,
      });

      orgIds.push(org.id);

      const [workspace] = await transactions.runInTenantTransaction(org.id, (tx) =>
        tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
      );

      const created = await asRequest(org.id, ownerId, async () => [
        await projects.create({
          actorId: ownerId,
          name: 'One',
          orgId: org.id,
          ownerId,
          workspaceId: workspace!.id,
        }),
        await projects.create({
          actorId: ownerId,
          name: 'Two',
          orgId: org.id,
          ownerId,
          workspaceId: workspace!.id,
        }),
        await projects.create({
          actorId: ownerId,
          name: 'Three',
          orgId: org.id,
          ownerId,
          workspaceId: workspace!.id,
        }),
      ]);

      return { orgId: org.id, ownerId, projects: created, workspaceId: workspace!.id };
    }

    async function grant(orgId: string, projectId: string, userId: string): Promise<void> {
      await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.insert(schema.projectGrants).values({ orgId, projectId, role: 'viewer', userId }),
      );
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();

      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      orgs = moduleRef.get(OrgService);
      memberships = moduleRef.get(MembershipService);
      projects = moduleRef.get(ProjectService);
      transactions = moduleRef.get(TenantTransactionRunner);
      cache = moduleRef.get(PermissionCache);
    }, 60_000);

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      if (userIds.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, userIds));
      }

      await moduleRef?.close();
    });

    /**
     * **The exclusion, not a refusal.** One grant out of three projects, and the list is one entry
     * long — the other two are absent rather than present-and-forbidden. A per-item refusal would
     * tell the caller the organisation has three projects, which is a fact about the organisation
     * that somebody with access to one corner of it has no business learning.
     */
    it('lists only the projects the caller may read', async () => {
      const { orgId, projects: all } = await fixture();
      const guestId = await seedUser();

      await grant(orgId, all[1]!.id, guestId);

      const visible = await asRequest(orgId, guestId, () => projects.list(orgId, guestId));

      expect(visible.map((project) => project.id)).toEqual([all[1]!.id]);
    });

    it('lists nothing for somebody with no access, rather than refusing', async () => {
      const { orgId } = await fixture();
      const strangerId = await seedUser();

      await expect(
        asRequest(orgId, strangerId, () => projects.list(orgId, strangerId)),
      ).resolves.toEqual([]);
    });

    /**
     * An org role is not a project role — §11's scopes compose and none cascades — so an owner with
     * no grant and no workspace role over these projects sees none of them. `OrgService.create`
     * gives the creator a workspace role, which is why this uses a *second* owner.
     */
    it('gives an org owner no project they hold no role over', async () => {
      const { orgId, ownerId } = await fixture();
      const secondOwnerId = await seedUser();

      await asRequest(orgId, ownerId, () =>
        memberships.add({ orgId, role: 'owner', userId: secondOwnerId }),
      );

      await expect(
        asRequest(orgId, secondOwnerId, () => projects.list(orgId, secondOwnerId)),
      ).resolves.toEqual([]);
    });

    it('reads one project by id', async () => {
      const { orgId, projects: all, ownerId } = await fixture();

      await expect(
        asRequest(orgId, ownerId, () => projects.read(orgId, all[0]!.id, ownerId)),
      ).resolves.toMatchObject({ id: all[0]!.id, name: 'One' });
    });

    /**
     * **The read carries the caller's own permissions, unqualified.** The client renders a control
     * per permission, and it must be reading the same resolved set the routes enforce — not a
     * second derivation from a role name that can drift from the catalogue.
     */
    it('fills the read with the caller’s project-qualified permissions, unqualified', async () => {
      const { orgId, projects: all, ownerId } = await fixture();

      const project = await asRequest(orgId, ownerId, () =>
        projects.read(orgId, all[0]!.id, ownerId),
      );

      expect(project.permissions).toContain('project:files.write');
      expect(project.permissions).toContain('project:read');
      expect(project.permissions.every((entry) => !entry.includes('@'))).toBe(true);
    });

    /** A viewer holds `project:read` on it and nothing else — no write control is offered. */
    it('gives a viewer read and not files.write', async () => {
      const { orgId, projects: all } = await fixture();
      const viewerId = await seedUser();

      await grant(orgId, all[0]!.id, viewerId);

      const project = await asRequest(orgId, viewerId, () =>
        projects.read(orgId, all[0]!.id, viewerId),
      );

      expect(project.permissions).toEqual(['project:read']);
    });

    /**
     * A list row's `permissions` is empty by design (spec 022 R3): filling it would mean one
     * resolved set per row, and nothing renders per-project controls from a listing.
     */
    it('leaves a list row’s permissions empty', async () => {
      const { orgId, projects: all } = await fixture();
      const viewerId = await seedUser();

      await grant(orgId, all[1]!.id, viewerId);

      const visible = await asRequest(orgId, viewerId, () => projects.list(orgId, viewerId));

      expect(visible.map((project) => project.permissions)).toEqual([[]]);
    });

    it('answers not-found for a project id that names nothing in this tenant', async () => {
      const { orgId, ownerId } = await fixture();

      await expect(
        asRequest(orgId, ownerId, () => projects.read(orgId, randomUUID(), ownerId)),
      ).rejects.toMatchObject({ type: 'not-found' });
    });

    /**
     * The preview label is the hostname a preview is served on (Appendix A) and is globally unique.
     * Random rather than derived from the name: a name-derived label would publish the project's
     * name to anybody who could guess it, and renaming would move a live URL.
     */
    it('mints a preview label that carries nothing about the project', async () => {
      const { orgId, projects: all } = await fixture();

      const labels = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx.select({ previewLabel: schema.projects.previewLabel }).from(schema.projects),
      );

      expect(new Set(labels.map((row) => row.previewLabel)).size).toBe(all.length);

      for (const { previewLabel } of labels) {
        expect(previewLabel).toMatch(/^[0-9a-f]{32}$/);
        expect(previewLabel.toLowerCase()).not.toContain('one');
      }
    });

    /** Spec 007. What `create` writes besides the row: the template, the grant, the audit and the event. */
    describe('create', () => {
      async function rowsFor(orgId: string, projectId: string) {
        return transactions.runInTenantTransaction(orgId, async (tx) => ({
          events: await tx
            .select({ payload: schema.outbox.payload, type: schema.outbox.type })
            .from(schema.outbox)
            .where(eq(schema.outbox.aggregateId, projectId)),
          project: (
            await tx
              .select({
                previewLabel: schema.projects.previewLabel,
                template: schema.projects.template,
              })
              .from(schema.projects)
              .where(eq(schema.projects.id, projectId))
          )[0],
        }));
      }

      it('stores the template, defaulting to vite-react', async () => {
        const { orgId, ownerId, workspaceId } = await fixture();

        const defaulted = await asRequest(orgId, ownerId, () =>
          projects.create({ actorId: ownerId, name: 'Default', orgId, ownerId, workspaceId }),
        );
        const chosen = await asRequest(orgId, ownerId, () =>
          projects.create({
            actorId: ownerId,
            name: 'Chosen',
            orgId,
            ownerId,
            template: 'python',
            workspaceId,
          }),
        );

        expect((await rowsFor(orgId, defaulted.id)).project?.template).toBe('vite-react');
        expect((await rowsFor(orgId, chosen.id)).project?.template).toBe('python');
      });

      it('appends project.created with ids and the template only, in the same transaction', async () => {
        const { orgId, ownerId, workspaceId } = await fixture();

        const project = await asRequest(orgId, ownerId, () =>
          projects.create({ actorId: ownerId, name: 'Evented', orgId, ownerId, workspaceId }),
        );

        expect((await rowsFor(orgId, project.id)).events).toEqual([
          {
            payload: {
              actorId: ownerId,
              orgId,
              projectId: project.id,
              template: 'vite-react',
              workspaceId,
            },
            type: 'project.created',
          },
        ]);
      });

      /**
       * R4: the label is checked for freedom before the insert rather than caught on the unique
       * index, because a failed statement aborts the transaction. The collision is scripted by
       * handing `randomBytes` an existing label once; the second draw is the real one.
       */
      it('draws a fresh label when the first one is taken', async () => {
        const { orgId, ownerId, projects: all, workspaceId } = await fixture();
        const taken = (await rowsFor(orgId, all[0]!.id)).project!.previewLabel;

        vi.mocked(randomBytes).mockReturnValueOnce(Buffer.from(taken, 'hex') as never);

        const project = await asRequest(orgId, ownerId, () =>
          projects.create({ actorId: ownerId, name: 'Retry', orgId, ownerId, workspaceId }),
        );
        const label = (await rowsFor(orgId, project.id)).project!.previewLabel;

        expect(label).toMatch(/^[0-9a-f]{32}$/);
        expect(label).not.toBe(taken);
      });

      it('refuses an archived workspace and one in another organisation alike', async () => {
        const { orgId, ownerId, workspaceId } = await fixture();
        const other = await fixture();

        await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .update(schema.workspaces)
            .set({ deletedAt: new Date() })
            .where(eq(schema.workspaces.id, workspaceId)),
        );

        for (const target of [workspaceId, other.workspaceId]) {
          await expect(
            asRequest(orgId, ownerId, () =>
              projects.create({ actorId: ownerId, name: 'X', orgId, ownerId, workspaceId: target }),
            ),
          ).rejects.toMatchObject({ type: 'not-found' });
        }
      });
    });

    /** Spec 007 US3. Rename and archive: what each writes, what each refuses. */
    describe('rename and archive', () => {
      async function auditFor(orgId: string, projectId: string) {
        return transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
            .from(schema.auditLog)
            .where(eq(schema.auditLog.target, projectId)),
        );
      }

      async function projectRow(orgId: string, projectId: string) {
        const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({
              deletedAt: schema.projects.deletedAt,
              name: schema.projects.name,
              previewLabel: schema.projects.previewLabel,
            })
            .from(schema.projects)
            .where(eq(schema.projects.id, projectId)),
        );

        return row!;
      }

      it('renames and records project.updated with from and to', async () => {
        const { orgId, ownerId, projects: all, workspaceId } = await fixture();
        const before = await projectRow(orgId, all[0]!.id);

        await asRequest(orgId, ownerId, () =>
          projects.rename({
            actorId: ownerId,
            name: 'Uno',
            orgId,
            projectId: all[0]!.id,
            workspaceId,
          }),
        );

        const after = await projectRow(orgId, all[0]!.id);

        expect(after.name).toBe('Uno');
        expect(after.previewLabel).toBe(before.previewLabel);
        expect(await auditFor(orgId, all[0]!.id)).toContainEqual({
          action: 'project.updated',
          metadata: { from: 'One', to: 'Uno' },
        });
      });

      /** R10: same name, no row written. */
      it('writes nothing when the name does not change', async () => {
        const { orgId, ownerId, projects: all, workspaceId } = await fixture();
        const before = await auditFor(orgId, all[0]!.id);

        await asRequest(orgId, ownerId, () =>
          projects.rename({
            actorId: ownerId,
            name: 'One',
            orgId,
            projectId: all[0]!.id,
            workspaceId,
          }),
        );

        expect(await auditFor(orgId, all[0]!.id)).toEqual(before);
      });

      it('archives: deleted_at set, project.archived appended, project.deleted recorded, holders invalidated', async () => {
        const { orgId, ownerId, projects: all, workspaceId } = await fixture();
        const guestId = await seedUser();
        const invalidate = vi.spyOn(cache, 'invalidate');

        await grant(orgId, all[1]!.id, guestId);

        await asRequest(orgId, ownerId, () =>
          projects.archive({ actorId: ownerId, orgId, projectId: all[1]!.id, workspaceId }),
        );

        expect((await projectRow(orgId, all[1]!.id)).deletedAt).toBeInstanceOf(Date);
        expect(await auditFor(orgId, all[1]!.id)).toContainEqual({
          action: 'project.deleted',
          metadata: { workspaceId },
        });

        const events = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ payload: schema.outbox.payload, type: schema.outbox.type })
            .from(schema.outbox)
            .where(eq(schema.outbox.aggregateId, all[1]!.id)),
        );

        expect(events).toContainEqual({
          payload: { actorId: ownerId, orgId, projectId: all[1]!.id, workspaceId },
          type: 'project.archived',
        });
        expect(invalidate.mock.calls).toEqual(
          expect.arrayContaining([
            [orgId, ownerId],
            [orgId, guestId],
          ]),
        );
        invalidate.mockRestore();
      });

      it.each([
        [
          'rename',
          (entry: { actorId: string; orgId: string; projectId: string; workspaceId: string }) =>
            projects.rename({ ...entry, name: 'X' }),
        ],
        [
          'archive',
          (entry: { actorId: string; orgId: string; projectId: string; workspaceId: string }) =>
            projects.archive(entry),
        ],
      ])(
        '%s answers not-found for an archived project and for one in another workspace',
        async (_label, act) => {
          const { orgId, ownerId, projects: all, workspaceId } = await fixture();

          await asRequest(orgId, ownerId, () =>
            projects.archive({ actorId: ownerId, orgId, projectId: all[2]!.id, workspaceId }),
          );

          await expect(
            asRequest(orgId, ownerId, () =>
              act({ actorId: ownerId, orgId, projectId: all[2]!.id, workspaceId }),
            ),
          ).rejects.toMatchObject({ type: 'not-found' });
          await expect(
            asRequest(orgId, ownerId, () =>
              act({ actorId: ownerId, orgId, projectId: all[0]!.id, workspaceId: randomUUID() }),
            ),
          ).rejects.toMatchObject({ type: 'not-found' });
        },
      );
    });

    /** Spec 027: what a deploy reads — archived rows included, so it can answer `project-archived`. */
    describe('deployTarget', () => {
      it('reads the template, name, preview label and archived flag, archived rows included', async () => {
        const { orgId, ownerId, projects: all, workspaceId } = await fixture();

        await asRequest(orgId, ownerId, () =>
          projects.archive({ actorId: ownerId, orgId, projectId: all[1]!.id, workspaceId }),
        );

        const [live, archived] = await transactions.runInTenantTransaction(orgId, async (tx) => [
          await projects.deployTarget(tx, { orgId, projectId: all[0]!.id }),
          await projects.deployTarget(tx, { orgId, projectId: all[1]!.id }),
        ]);

        expect(live).toMatchObject({ archived: false, name: 'One', template: 'vite-react' });
        expect(live.previewLabel).toMatch(/^[0-9a-f]{32}$/);
        expect(archived).toMatchObject({ archived: true, name: 'Two' });
      });

      it('answers not-found for an id that names nothing in this tenant', async () => {
        const { orgId } = await fixture();
        const other = await fixture();

        await expect(
          transactions.runInTenantTransaction(orgId, (tx) =>
            projects.deployTarget(tx, { orgId, projectId: other.projects[0]!.id }),
          ),
        ).rejects.toMatchObject({ type: 'not-found' });
      });
    });

    /** Spec 017 US3 / R8. Rotation: same generator, same pre-check, and the pre-check spans archived rows. */
    describe('rotatePreviewLabel', () => {
      async function labelOf(orgId: string, projectId: string) {
        const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx
            .select({ previewLabel: schema.projects.previewLabel })
            .from(schema.projects)
            .where(eq(schema.projects.id, projectId)),
        );

        return row!.previewLabel;
      }

      it('writes a fresh label of the same entropy, unique among the tenant, and returns both', async () => {
        const { orgId, projects: all } = await fixture();
        const before = await labelOf(orgId, all[0]!.id);

        const result = await transactions.runInTenantTransaction(orgId, (tx) =>
          projects.rotatePreviewLabel({ orgId, projectId: all[0]!.id }, tx),
        );
        const after = await labelOf(orgId, all[0]!.id);

        expect(result).toEqual({ label: after, previousLabel: before });
        expect(after).toMatch(/^[0-9a-f]{32}$/);
        expect(after).not.toBe(before);

        const labels = await transactions.runInTenantTransaction(orgId, (tx) =>
          tx.select({ previewLabel: schema.projects.previewLabel }).from(schema.projects),
        );

        expect(new Set(labels.map((row) => row.previewLabel)).size).toBe(all.length);
      });

      it('redraws when the first draw is a soft-deleted project label', async () => {
        const { orgId, ownerId, projects: all, workspaceId } = await fixture();
        const dead = await labelOf(orgId, all[1]!.id);

        await asRequest(orgId, ownerId, () =>
          projects.archive({ actorId: ownerId, orgId, projectId: all[1]!.id, workspaceId }),
        );
        vi.mocked(randomBytes).mockReturnValueOnce(Buffer.from(dead, 'hex') as never);

        const { label } = await transactions.runInTenantTransaction(orgId, (tx) =>
          projects.rotatePreviewLabel({ orgId, projectId: all[0]!.id }, tx),
        );

        expect(label).toMatch(/^[0-9a-f]{32}$/);
        expect(label).not.toBe(dead);
        expect(await labelOf(orgId, all[0]!.id)).toBe(label);
      });

      it('answers not-found for an archived project', async () => {
        const { orgId, ownerId, projects: all, workspaceId } = await fixture();

        await asRequest(orgId, ownerId, () =>
          projects.archive({ actorId: ownerId, orgId, projectId: all[2]!.id, workspaceId }),
        );

        await expect(
          transactions.runInTenantTransaction(orgId, (tx) =>
            projects.rotatePreviewLabel({ orgId, projectId: all[2]!.id }, tx),
          ),
        ).rejects.toMatchObject({ type: 'not-found' });
      });
    });
  });
});
