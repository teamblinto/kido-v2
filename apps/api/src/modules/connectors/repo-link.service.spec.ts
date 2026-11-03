import { repoLinkSchema } from '@repo/contracts';
import { schema } from '@repo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  type ConnectorsHarness,
  startConnectorsHarness,
  USER_ACCOUNT,
} from '../../../test/fixtures/connectors-harness';
import { RepoLinkService } from './repo-link.service';
import { removeConnection } from '../../../test/support/connector-removal';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

if (!postgres || !redis) {
  console.warn(
    'SKIPPING repo-link.service.spec.ts: Postgres or the session Redis is not reachable',
  );
}

const SHA = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);

/**
 * Spec 018 US2/US5 against Postgres and the fixture GitHub: the two `PUT` arms and their refusals
 * (R4, name-taken), the audit pair, the unlink that never reaches GitHub (FR-020), and `position`.
 */
describe('RepoLinkService', () => {
  describe.skipIf(!postgres || !redis)('against Postgres, Redis and the fixture GitHub', () => {
    let harness: ConnectorsHarness;
    let service: RepoLinkService;

    const ref = () => ({ orgId: harness.orgId, projectId: harness.projectId });

    function existingRepository(branches: Record<string, string> = {}) {
      harness.fixture.repositories.set(501, {
        branches,
        default_branch: 'trunk',
        full_name: 'acme/site',
        id: 501,
        name: 'site',
        owner: { login: 'acme' },
        private: false,
      });
    }

    beforeAll(async () => {
      harness = await startConnectorsHarness();
      service = harness.moduleRef.get(RepoLinkService, { strict: false });
      // Ten minutes: the harness waits for the outbox suite lock behind every suite that relays.
    }, 600_000);

    afterAll(() => harness.close());

    beforeEach(() => harness.reset());

    it('read answers null for an unlinked project and not-found for no such project', async () => {
      await expect(harness.inTenant((tx) => service.read(tx, ref()))).resolves.toBeNull();
      await expect(
        harness.inTenant((tx) =>
          service.read(tx, {
            orgId: harness.orgId,
            projectId: '00000000-0000-4000-8000-000000000000',
          }),
        ),
      ).rejects.toMatchObject({ type: 'not-found' });
    });

    it('link refuses without a connection as conflict/not-linked', async () => {
      await expect(
        harness.inTenant((tx) =>
          service.link(tx, ref(), harness.userId, { existing: { repoId: 501 } }),
        ),
      ).rejects.toMatchObject({ extensions: { reason: 'not-linked' }, type: 'conflict' });
    });

    it('link create makes the repository under the org, inserts the row and audits repo-link.created', async () => {
      await harness.connect();

      const link = await harness.inTenant((tx) =>
        service.link(tx, ref(), harness.userId, { create: { name: 'new-site', private: true } }),
      );

      expect(repoLinkSchema.parse(link)).toEqual(link);
      expect(link).toMatchObject({
        branch: 'main',
        position: 'unknown',
        remoteHeadSha: null,
        repository: { fullName: 'acme/new-site', name: 'new-site', owner: 'acme' },
        state: 'linked',
      });
      expect(link.linkedBy.id).toBe(harness.userId);

      const created = harness.fixture.requests.find(
        (request) => request.path === '/orgs/acme/repos',
      );

      expect(created?.body).toEqual({ name: 'new-site', private: true });
      await expect(harness.auditActions()).resolves.toEqual([
        'connector.connected',
        'repo-link.created',
      ]);
    });

    it('link create on a user-account installation is conflict/create-unsupported and never reaches GitHub (R4)', async () => {
      await harness.reset(USER_ACCOUNT);
      await harness.connect();
      harness.fixture.requests.length = 0;

      await expect(
        harness.inTenant((tx) =>
          service.link(tx, ref(), harness.userId, { create: { name: 'x', private: true } }),
        ),
      ).rejects.toMatchObject({ extensions: { reason: 'create-unsupported' }, type: 'conflict' });
      expect(harness.fixture.requests.some((request) => request.path.endsWith('/repos'))).toBe(
        false,
      );
      await expect(harness.inTenant((tx) => service.read(tx, ref()))).resolves.toBeNull();
    });

    it('link create with a taken name is conflict/name-taken', async () => {
      await harness.connect();
      existingRepository();

      await expect(
        harness.inTenant((tx) =>
          service.link(tx, ref(), harness.userId, { create: { name: 'site', private: false } }),
        ),
      ).rejects.toMatchObject({ extensions: { reason: 'name-taken' }, type: 'conflict' });
      await expect(harness.inTenant((tx) => service.read(tx, ref()))).resolves.toBeNull();
    });

    it('link existing resolves owner, name and default branch, records the branch head, and derives position', async () => {
      await harness.connect();
      existingRepository({ trunk: SHA });

      const link = await harness.inTenant((tx) =>
        service.link(tx, ref(), harness.userId, { existing: { repoId: 501 } }),
      );

      expect(link).toMatchObject({
        branch: 'trunk',
        position: 'unknown',
        remoteHeadSha: SHA,
        repository: { fullName: 'acme/site', id: 501, name: 'site', owner: 'acme' },
      });

      // A checkpoint at the remote head: level. A different one: diverged (nothing pushed yet).
      await harness.inTenant((tx) =>
        tx.insert(schema.checkpoints).values({
          files: [],
          gitSha: SHA,
          kind: 'baseline',
          label: 'baseline',
          orgId: harness.orgId,
          projectId: harness.projectId,
        }),
      );
      await expect(harness.inTenant((tx) => service.read(tx, ref()))).resolves.toMatchObject({
        position: 'level',
      });

      await harness.inTenant((tx) =>
        tx
          .update(schema.repoLinks)
          .set({ remoteHeadSha: 'b'.repeat(40) })
          .where(eq(schema.repoLinks.orgId, harness.orgId)),
      );
      await expect(harness.inTenant((tx) => service.read(tx, ref()))).resolves.toMatchObject({
        position: 'diverged',
      });
    });

    it('link existing with a named branch that does not exist yet leaves the remote head null; an unknown repository is not-found', async () => {
      await harness.connect();
      existingRepository();

      const link = await harness.inTenant((tx) =>
        service.link(tx, ref(), harness.userId, { existing: { branch: 'feature', repoId: 501 } }),
      );

      expect(link).toMatchObject({ branch: 'feature', remoteHeadSha: null });

      await harness.inTenant((tx) => service.unlink(tx, ref(), harness.userId));
      await expect(
        harness.inTenant((tx) =>
          service.link(tx, ref(), harness.userId, { existing: { repoId: 999 } }),
        ),
      ).rejects.toMatchObject({ type: 'not-found' });
    });

    it('link on a linked project is a conflict; unlink removes the row, audits repo-link.removed and never touches GitHub', async () => {
      await harness.connect();
      existingRepository();
      await harness.inTenant((tx) =>
        service.link(tx, ref(), harness.userId, { existing: { repoId: 501 } }),
      );

      await expect(
        harness.inTenant((tx) =>
          service.link(tx, ref(), harness.userId, { existing: { repoId: 501 } }),
        ),
      ).rejects.toMatchObject({ type: 'conflict' });

      const before = harness.fixture.requests.length;

      await harness.inTenant((tx) => service.unlink(tx, ref(), harness.userId));

      expect(harness.fixture.requests).toHaveLength(before);
      expect(harness.fixture.repositories.get(501)).toBeDefined();
      await expect(harness.inTenant((tx) => service.read(tx, ref()))).resolves.toBeNull();
      await expect(harness.auditActions()).resolves.toEqual([
        'connector.connected',
        'repo-link.created',
        'repo-link.removed',
      ]);
      await expect(
        harness.inTenant((tx) => service.unlink(tx, ref(), harness.userId)),
      ).rejects.toMatchObject({ type: 'not-found' });
    });

    it('US5: unlink deletes no checkpoint and calls no GitHub endpoint; FR-018: relink at the head is level with the head recorded as pushed', async () => {
      await harness.connect();
      existingRepository({ trunk: HEAD });
      const [head] = await harness.inTenant((tx) =>
        tx
          .insert(schema.checkpoints)
          .values({
            files: [],
            gitSha: HEAD,
            kind: 'baseline',
            label: 'baseline',
            orgId: harness.orgId,
            projectId: harness.projectId,
          })
          .returning({ id: schema.checkpoints.id }),
      );
      await harness.inTenant((tx) =>
        service.link(tx, ref(), harness.userId, { existing: { repoId: 501 } }),
      );
      const checkpoints = () =>
        harness.inTenant((tx) => tx.select({ id: schema.checkpoints.id }).from(schema.checkpoints));
      const before = await checkpoints();
      harness.fixture.requests.length = 0;

      await harness.inTenant((tx) => service.unlink(tx, ref(), harness.userId));

      expect(harness.fixture.requests).toEqual([]);
      await expect(checkpoints()).resolves.toEqual(before);

      const relinked = await harness.inTenant((tx) =>
        service.link(tx, ref(), harness.userId, { existing: { repoId: 501 } }),
      );

      expect(relinked).toMatchObject({ position: 'level', remoteHeadSha: HEAD });
      expect(relinked.lastPushedCheckpointId).toBe(head!.id);
    });

    it('US5: removing the connection marks the link disconnected rather than deleting it', async () => {
      const connection = await harness.connect();
      existingRepository();
      await harness.inTenant((tx) =>
        service.link(tx, ref(), harness.userId, { existing: { repoId: 501 } }),
      );

      await removeConnection(harness.moduleRef, harness.orgId, harness.userId, connection.id);

      await expect(harness.inTenant((tx) => service.read(tx, ref()))).resolves.toMatchObject({
        connectionId: null,
        state: 'disconnected',
      });
    });

    it('a disconnected link is replaced by a new PUT', async () => {
      await harness.connect();
      existingRepository();
      await harness.inTenant((tx) =>
        service.link(tx, ref(), harness.userId, { existing: { repoId: 501 } }),
      );
      await harness.inTenant((tx) =>
        tx
          .update(schema.repoLinks)
          .set({ connectionId: null, state: 'disconnected' })
          .where(eq(schema.repoLinks.orgId, harness.orgId)),
      );
      await expect(harness.inTenant((tx) => service.read(tx, ref()))).resolves.toMatchObject({
        connectionId: null,
        state: 'disconnected',
      });

      const link = await harness.inTenant((tx) =>
        service.link(tx, ref(), harness.userId, { create: { name: 'fresh', private: true } }),
      );

      expect(link).toMatchObject({ repository: { name: 'fresh' }, state: 'linked' });
      expect(link.connectionId).not.toBeNull();
    });
  });
});
