import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../../../app.module';
import { CLOCK } from '../../../common/clock/clock.port';
import { FakeClock } from '../../../common/clock/fake-clock';
import { APP_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { TokenService } from '../../identity/services/token.service';
import { InMemoryMailer } from '../../mail/in-memory.mailer';
import { MAILER, type MailMessage } from '../../mail/mailer.port';
import type { Envelope } from '../../outbox/envelope';
import { OrgService } from './org.service';
import { ProjectInvitationMailConsumer } from './project-invitation-mail.consumer';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const START = '2026-09-23T10:00:00.000Z';
const DAY = 24 * 60 * 60 * 1_000;

/** Spec 031 (contracts/sharing.md § 7), modelled on `invitation-mail.consumer.spec.ts`. */
describe('ProjectInvitationMailConsumer', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let moduleRef: TestingModule;
    let consumer: ProjectInvitationMailConsumer;
    let database: ForgeDatabase;
    let orgs: OrgService;
    let tokens: TokenService;
    let transactions: TenantTransactionRunner;
    let clock: FakeClock;
    const userIds: string[] = [];
    const orgIds: string[] = [];

    async function seed(
      state: { acceptedAt?: Date; revokedAt?: Date } = {},
    ): Promise<{ email: string; id: string; inviter: string; orgId: string; tokenHash: string }> {
      const inviter = `t031m-${randomUUID()}@example.test`;
      const [owner] = await database
        .insert(schema.users)
        .values({ email: inviter, emailVerifiedAt: clock.now(), passwordHash: 'x' })
        .returning({ id: schema.users.id });

      userIds.push(owner!.id);

      const org = await orgs.create(owner!.id, {
        name: 'Project mail fixture',
        slug: `t031m-${randomUUID().slice(0, 8)}`,
      });

      orgIds.push(org.id);

      const email = `t031m-${randomUUID()}@example.test`;
      const tokenHash = tokens.issue(60).tokenHash;
      const id = await transactions.runInTenantTransaction(org.id, async (tx) => {
        const [workspace] = await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .limit(1);
        const [project] = await tx
          .insert(schema.projects)
          .values({
            name: 'Launch site',
            orgId: org.id,
            previewLabel: `t031m-${randomUUID().slice(0, 12)}`,
            workspaceId: workspace!.id,
          })
          .returning({ id: schema.projects.id });
        const [row] = await tx
          .insert(schema.projectInvitations)
          .values({
            acceptedAt: state.acceptedAt ?? null,
            email,
            expiresAt: new Date(Date.parse(START) + 7 * DAY),
            invitedBy: owner!.id,
            orgId: org.id,
            projectId: project!.id,
            revokedAt: state.revokedAt ?? null,
            role: 'editor',
            tokenHash,
          })
          .returning({ id: schema.projectInvitations.id });

        return row!.id;
      });

      return { email, id, inviter, orgId: org.id, tokenHash };
    }

    function envelope(orgId: string, invitationId: string) {
      return {
        aggregate: 'project-invitation',
        aggregateId: invitationId,
        eventId: randomUUID(),
        occurredAt: clock.now().toISOString(),
        orgId,
        payload: { invitationId, orgId },
        traceId: null,
        type: 'mail.project-invitation',
      } satisfies Envelope<'mail.project-invitation'>;
    }

    async function handle(
      event: Envelope<'mail.project-invitation'>,
    ): Promise<MailMessage | undefined> {
      return database.transaction((tx) => consumer.handle(event, tx));
    }

    async function hashOf(orgId: string, id: string): Promise<string | undefined> {
      const [row] = await transactions.runInTenantTransaction(orgId, (tx) =>
        tx
          .select({ tokenHash: schema.projectInvitations.tokenHash })
          .from(schema.projectInvitations)
          .where(eq(schema.projectInvitations.id, id)),
      );

      return row?.tokenHash;
    }

    beforeAll(async () => {
      clock = new FakeClock(START);

      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(MAILER)
        .useValue(new InMemoryMailer())
        .compile();
      await moduleRef.init();

      consumer = moduleRef.get(ProjectInvitationMailConsumer, { strict: false });
      database = moduleRef.get<ForgeDatabase>(APP_DATABASE);
      orgs = moduleRef.get(OrgService);
      tokens = moduleRef.get(TokenService, { strict: false });
      transactions = moduleRef.get(TenantTransactionRunner);
    }, 60_000);

    beforeEach(() => {
      clock.set(START);
    });

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      if (userIds.length > 0) {
        await database.delete(schema.users).where(inArray(schema.users.id, userIds));
      }

      await moduleRef?.close();
    });

    it('re-mints the token and renders the project invitation for an open row', async () => {
      const invitation = await seed();

      const message = await handle(envelope(invitation.orgId, invitation.id));
      const token = /project-invitations\/accept\/([A-Za-z0-9_-]+)/.exec(message?.text ?? '')?.[1];

      expect(message?.template).toBe('project-invitation');
      expect(message?.to).toBe(invitation.email);
      expect(message?.text).toContain('Launch site');
      expect(message?.text).toContain(invitation.inviter);
      expect(message?.text).toContain('editor');
      expect(token).toBeDefined();
      expect(await hashOf(invitation.orgId, invitation.id)).toBe(tokens.fingerprint(token!));
    });

    it.each([
      ['withdrawn', { revokedAt: new Date(START) }],
      ['accepted', { acceptedAt: new Date(START) }],
    ])('sends nothing for a %s row', async (_state, state) => {
      const invitation = await seed(state);

      expect(await handle(envelope(invitation.orgId, invitation.id))).toBeUndefined();
      expect(await hashOf(invitation.orgId, invitation.id)).toBe(invitation.tokenHash);
    });
  });
});
