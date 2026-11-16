import { randomUUID } from 'node:crypto';

import { schema } from '@repo/db';
import { and, eq, gt, ne } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  type ConnectorsHarness,
  startConnectorsHarness,
} from '../../../test/fixtures/connectors-harness';
import { NotFoundError } from '../../common/errors/domain-error';
import { ImportService, MAX_IMPORT_REPOSITORY_KIB } from './import.service';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn('SKIPPING import.service.spec.ts: Postgres or the session Redis is not reachable');
}

const HEAD = 'a'.repeat(40);
const REPO_ID = 720;

/**
 * Contracts § 1–2 against Postgres: every refusal of an inspect and of a start, each answered in
 * the § 3 reason vocabulary — and each leaving **zero** rows of every kind (FR-007, SC-005). The
 * project is created in the same transaction as the operation, so "refused" and "started" are the
 * only two outcomes there is a name for.
 */
describe('ImportService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and the fixture GitHub', () => {
    let harness: ConnectorsHarness;
    let service: ImportService;

    const seed = (over: Record<string, unknown> = {}) => {
      harness.fixture.repositories.set(REPO_ID, {
        branches: { main: HEAD },
        default_branch: 'main',
        full_name: 'acme/site',
        id: REPO_ID,
        name: 'site',
        owner: { login: 'acme' },
        private: false,
        root: {
          'package.json': JSON.stringify({ dependencies: { react: '19' } }),
          'vite.config.ts': 'export default {}',
        },
        ...over,
      });
    };

    const inspect = (branch?: string) =>
      harness.inTenant((tx) =>
        service.inspect(tx, harness.orgId, {
          repoId: REPO_ID,
          ...(branch === undefined ? {} : { branch }),
        }),
      );

    const start = (over: Record<string, unknown> = {}) =>
      harness.inTenantScope((tx) =>
        service.start(tx, harness.orgId, harness.workspaceId, harness.userId, {
          branch: 'main',
          name: 'Imported',
          repoId: REPO_ID,
          template: 'vite-react',
          ...over,
        }),
      );

    /** Every row an import could leave: an operation, a link, or a project beyond the harness's. */
    async function rows(): Promise<{ links: number; operations: number; projects: number }> {
      return harness.inTenant(async (tx) => ({
        links: (
          await tx.select().from(schema.repoLinks).where(eq(schema.repoLinks.orgId, harness.orgId))
        ).length,
        operations: (
          await tx
            .select()
            .from(schema.syncOperations)
            .where(eq(schema.syncOperations.orgId, harness.orgId))
        ).length,
        projects: (
          await tx
            .select()
            .from(schema.projects)
            .where(
              and(
                eq(schema.projects.orgId, harness.orgId),
                ne(schema.projects.id, harness.projectId),
              ),
            )
        ).length,
      }));
    }

    beforeAll(async () => {
      harness = await startConnectorsHarness();
      service = harness.moduleRef.get(ImportService, { strict: false });
    }, 600_000);

    afterAll(async () => {
      await harness?.close();
    });

    beforeEach(async () => {
      await harness.reset();
      await harness.inTenant(async (tx) => {
        await tx
          .delete(schema.projects)
          .where(
            and(
              eq(schema.projects.orgId, harness.orgId),
              ne(schema.projects.id, harness.projectId),
            ),
          );
      });
    });

    it('inspect without a connection: conflict / not-linked, and nothing is created', async () => {
      seed();

      await expect(inspect()).rejects.toMatchObject({ extensions: { reason: 'not-linked' } });
      expect(await rows()).toEqual({ links: 0, operations: 0, projects: 0 });
    });

    it('inspect on a needs_reauth connection: conflict / needs-reauth, and nothing is created', async () => {
      await harness.connect();
      seed();
      await harness.inTenant((tx) =>
        tx
          .update(schema.connections)
          .set({ health: 'needs_reauth' })
          .where(eq(schema.connections.orgId, harness.orgId)),
      );

      await expect(inspect()).rejects.toMatchObject({ extensions: { reason: 'needs-reauth' } });
      expect(await rows()).toEqual({ links: 0, operations: 0, projects: 0 });
    });

    it('inspect with the circuit open: provider-unavailable with Retry-After, nothing created', async () => {
      await harness.connect();
      seed();
      await harness.inTenant((tx) =>
        tx
          .update(schema.connections)
          .set({ circuitOpenUntil: new Date(Date.now() + 60_000), failureCount: 5 })
          .where(eq(schema.connections.orgId, harness.orgId)),
      );

      await expect(inspect()).rejects.toMatchObject({
        extensions: { reason: 'provider-unavailable' },
      });
      expect(await rows()).toEqual({ links: 0, operations: 0, projects: 0 });
    });

    it('a recognised repository is proposed, with the evidence that proposed it', async () => {
      await harness.connect();
      seed();

      await expect(inspect()).resolves.toMatchObject({
        branch: 'main',
        candidates: [{ evidence: ['vite.config.ts', 'dependency: react'], template: 'vite-react' }],
        empty: false,
        headSha: HEAD,
        outcome: 'proposed',
        repo: { id: REPO_ID, name: 'site', owner: 'acme' },
      });
    });

    it('a branch with no commits inspects as empty: no head, no candidates, no rows', async () => {
      await harness.connect();
      seed({ branches: {} });

      await expect(inspect()).resolves.toMatchObject({
        candidates: [],
        empty: true,
        headSha: null,
        outcome: 'unrecognised',
      });
      expect(await rows()).toEqual({ links: 0, operations: 0, projects: 0 });
    });

    it('start on an empty branch: import-empty-repo, and zero rows of every kind', async () => {
      await harness.connect();
      seed({ branches: {} });

      await expect(start()).rejects.toMatchObject({
        extensions: { reason: 'empty-repo' },
        type: 'import-empty-repo',
      });
      expect(await rows()).toEqual({ links: 0, operations: 0, projects: 0 });
    });

    it('start over the size cap: import-repo-too-large naming the limit, and zero rows', async () => {
      await harness.connect();
      seed({ size: MAX_IMPORT_REPOSITORY_KIB + 1 });

      await expect(start()).rejects.toMatchObject({
        extensions: { limitKib: MAX_IMPORT_REPOSITORY_KIB, reason: 'repo-too-large' },
        type: 'import-repo-too-large',
      });
      expect(await rows()).toEqual({ links: 0, operations: 0, projects: 0 });
    });

    it('start on a branch that is gone: import-branch-not-found, and zero rows', async () => {
      await harness.connect();
      seed();

      await expect(start({ branch: 'release' })).rejects.toMatchObject({
        extensions: { reason: 'branch-not-found' },
        type: 'import-branch-not-found',
      });
      expect(await rows()).toEqual({ links: 0, operations: 0, projects: 0 });
    });

    /**
     * T068: "zero rows of **every** kind" is wider than the three tables an import writes. A
     * refusal that had already created the project would also have left `project.created` on the
     * outbox — which spec 014 turns into a claimed sandbox — and an `import.requested` on the
     * trail. Asserting the queue and the trail is what makes "before any sandbox is created"
     * (FR-008) a property of the code rather than of the order two statements happen to be in.
     */
    it.each([
      ['an empty branch', { branches: {} }, {}],
      ['an oversized repository', { size: MAX_IMPORT_REPOSITORY_KIB + 1 }, {}],
      ['a branch that is gone', {}, { branch: 'release' }],
    ])(
      'a refusal on %s writes nothing to the outbox and nothing to the trail',
      async (_case, over, request) => {
        await harness.connect();
        seed(over);
        const before = new Date();

        await expect(start(request)).rejects.toThrow();

        expect(await rows()).toEqual({ links: 0, operations: 0, projects: 0 });
        expect(await harness.auditActions()).not.toContain('import.requested');
        const queued = await harness.inTenant((tx) =>
          tx
            .select({ type: schema.outbox.type })
            .from(schema.outbox)
            .where(
              and(
                eq(schema.outbox.originOrgId, harness.orgId),
                gt(schema.outbox.createdAt, before),
              ),
            ),
        );
        expect(queued.map((row) => row.type)).not.toContain('sync.requested');
        expect(queued.map((row) => row.type)).not.toContain('project.created');
      },
    );

    it('start without a connection: not-linked, and zero rows', async () => {
      seed();

      await expect(start()).rejects.toMatchObject({ extensions: { reason: 'not-linked' } });
      expect(await rows()).toEqual({ links: 0, operations: 0, projects: 0 });
    });

    it('what passes is one project, one link and one queued import, audited as requested (FR-009)', async () => {
      await harness.connect();
      seed();

      const operation = await start();

      expect(operation).toMatchObject({ commits: 0, kind: 'import', state: 'queued' });
      expect(operation.projectId).toEqual(expect.any(String));
      expect(await rows()).toEqual({ links: 1, operations: 1, projects: 1 });
      expect(await harness.auditActions()).toContain('import.requested');

      const [link] = await harness.inTenant((tx) =>
        tx.select().from(schema.repoLinks).where(eq(schema.repoLinks.orgId, harness.orgId)),
      );
      expect(link).toMatchObject({
        branch: 'main',
        name: 'site',
        owner: 'acme',
        projectId: operation.projectId,
        repoId: REPO_ID,
        state: 'linked',
      });
    });
    it('the requester reads their import even once withdrawn; anyone else, or another workspace, is a 404', async () => {
      await harness.connect();
      seed();
      const started = await start();
      // The failure path's cleanup: the project is soft-deleted, the row stays.
      await harness.inTenantScope((tx) =>
        service.withdraw(tx, {
          actorId: harness.userId,
          branch: 'main',
          finishedAt: new Date(),
          linkId: null,
          operationId: started.id,
          orgId: harness.orgId,
          projectId: started.projectId,
          reason: 'import-checkout-failed',
          repository: 'acme/site',
        }),
      );
      const read = (actor: string, workspace = harness.workspaceId) =>
        harness.inTenant((tx) =>
          service.operation(tx, harness.orgId, workspace, actor, started.id),
        );

      await expect(read(harness.userId)).resolves.toMatchObject({
        reason: 'import-checkout-failed',
        state: 'failed',
      });
      await expect(read(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
      await expect(read(harness.userId, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
      // A malformed id is the same 404, not a database type error.
      await expect(
        harness.inTenant((tx) =>
          service.operation(tx, harness.orgId, harness.workspaceId, harness.userId, 'not-a-uuid'),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Not an import (a push on the same project): nothing to read through this route.
      await harness.inTenant((tx) =>
        tx
          .update(schema.syncOperations)
          .set({ kind: 'push' })
          .where(eq(schema.syncOperations.id, started.id)),
      );
      await expect(read(harness.userId)).rejects.toBeInstanceOf(NotFoundError);
    });

    /**
     * FR-013 and FR-016 together: the user may override a confident proposal, the override is what
     * runs, and the disagreement is *recorded* — never a refusal, never a failed import.
     */
    describe('an override of the proposal (FR-013, FR-016)', () => {
      /** The `import.requested` entry's metadata, which is where the choice and the warning land. */
      const requested = (projectId: string) =>
        harness.inTenant(async (tx) => {
          const rows = await tx
            .select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
            .from(schema.auditLog)
            .where(
              and(eq(schema.auditLog.orgId, harness.orgId), eq(schema.auditLog.target, projectId)),
            );

          return rows.find((row) => row.action === 'import.requested')?.metadata;
        });

      it('a template the repository disagrees with still starts, and is the project’s template', async () => {
        await harness.connect();
        seed(); // vite.config.ts + react: the inspection proposes `vite-react`.

        const operation = await start({ template: 'python' });

        // Not refused and not failed: a queued import exactly as an agreeing choice produces.
        expect(operation).toMatchObject({ kind: 'import', reason: null, state: 'queued' });
        expect(await rows()).toEqual({ links: 1, operations: 1, projects: 1 });

        const [project] = await harness.inTenant((tx) =>
          tx
            .select({ template: schema.projects.template })
            .from(schema.projects)
            .where(eq(schema.projects.id, operation.projectId)),
        );
        // FR-015: the project's template is the chosen one, not the proposed one.
        expect(project?.template).toBe('python');
      });

      it('the disagreement is recorded on the request, as a warning beside the choice', async () => {
        await harness.connect();
        seed();

        const operation = await start({ template: 'python' });

        expect(await requested(operation.projectId)).toMatchObject({
          template: 'python',
          templateMismatch: { chosen: 'python', detected: ['vite-react'] },
        });
      });

      it('an agreeing choice records no mismatch at all', async () => {
        await harness.connect();
        seed();

        const operation = await start({ template: 'vite-react' });

        expect(await requested(operation.projectId)).toMatchObject({
          template: 'vite-react',
          templateMismatch: null,
        });
      });

      it('an unrecognised repository is never a mismatch: there was nothing to disagree with', async () => {
        await harness.connect();
        seed({ root: { 'go.mod': 'module example.com/x' } });

        const operation = await start({ template: 'node-api' });

        expect(await requested(operation.projectId)).toMatchObject({ templateMismatch: null });
      });

      it('the panel reads the mismatch back from the project (contracts § 4)', async () => {
        await harness.connect();
        seed();

        const operation = await start({ template: 'python' });

        await expect(
          harness.inTenant((tx) => service.mismatch(tx, harness.orgId, operation.projectId)),
        ).resolves.toEqual({ chosen: 'python', detected: ['vite-react'] });
      });

      it('the panel reads null when the choice and the repository agree', async () => {
        await harness.connect();
        seed();

        const operation = await start({ template: 'vite-react' });

        await expect(
          harness.inTenant((tx) => service.mismatch(tx, harness.orgId, operation.projectId)),
        ).resolves.toBeNull();
      });

      it('a project with no import link has no mismatch to read', async () => {
        await harness.connect();

        await expect(
          harness.inTenant((tx) => service.mismatch(tx, harness.orgId, harness.projectId)),
        ).resolves.toBeNull();
      });
    });
  });
});
