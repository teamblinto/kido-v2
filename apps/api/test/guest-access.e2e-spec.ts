import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PROJECT_GRANT_REVOKED,
  PROJECT_GRANTED,
  orgListResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
} from '@repo/contracts';
import { schema } from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
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
import { PasswordHasher } from '../src/modules/identity/password/hasher';
import { ProjectService } from '../src/modules/tenancy/services/project.service';
import { unsafe } from './support/csrf-client';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SWAGGER_ENABLED = 'false';
  process.env.ARGON2_MEMORY_KIB = '8192';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.ARGON2_TIME_COST = '1';
  process.env.LOGIN_THROTTLE_ACCOUNT_BURST = '100';
  process.env.LOGIN_THROTTLE_IP_BURST = '4000';
});

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

const LOGIN = '/api/v1/auth/login';
const ORGS = '/api/v1/orgs';
const PASSWORD = 'thermos-quibble-tundra-vellum';

/** `198.33/16`, distinct from the ranges the other e2e suites claim against the same Redis. */
const RUN = randomInt(0, 256);
let issuedAddresses = 0;

function nextClientAddress(): string {
  issuedAddresses += 1;

  const slot = (RUN * 256 + issuedAddresses) % 65_536;

  return `198.33.${Math.floor(slot / 256)}.${slot % 256}`;
}

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

interface Client {
  readonly cookie: string;
  readonly userId: string;
}

interface Tenant {
  readonly orgId: string;
  /** Three projects. The guest is granted the middle one and nothing else. */
  readonly projectIds: string[];
  readonly workspaceId: string;
}

describe('Guest access through project grants (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let hasher: PasswordHasher;
    let transactions: TenantTransactionRunner;
    let projects: ProjectService;
    const orgIds: string[] = [];
    const mailboxes = new Set<string>();

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    async function signUpAndIn(): Promise<Client> {
      const email = `t30-${randomUUID()}@example.test`;

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

      return { cookie: header!.split(';')[0]!, userId: user!.id };
    }

    /** An organisation with three projects, created through the product's own routes and services. */
    async function seedTenant(owner: Client): Promise<Tenant> {
      const created = await unsafe(http().post(ORGS), [owner.cookie])
        .send({ name: 'Acme', slug: `t30-${randomUUID().slice(0, 8)}` })
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

          for (const name of ['Alpha', 'Beta', 'Gamma']) {
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

      return { orgId, projectIds, workspaceId: workspace!.id };
    }

    function grantPath(tenant: Tenant, projectId: string, guest: Client): string {
      return `${ORGS}/${tenant.orgId}/projects/${projectId}/grants/${guest.userId}`;
    }

    async function grant(
      owner: Client,
      tenant: Tenant,
      projectId: string,
      guest: Client,
      role = 'viewer',
    ): Promise<void> {
      await unsafe(http().put(grantPath(tenant, projectId, guest)), [owner.cookie])
        .send({ role })
        .expect(200);
    }

    /**
     * Every org-level route the API exposes, as a guest would have to try them.
     *
     * The list is written out rather than derived, because it is the *claim*: "a guest sees no
     * org-level resource of any kind" is only as strong as the enumeration behind it, and a list
     * derived from the router would grow silently and prove whatever it happened to contain.
     * A route added later that a guest can reach has to be added here deliberately.
     */
    function orgLevelRoutes(orgId: string, tenant?: Tenant): { name: string; path: string }[] {
      return [
        { name: 'the organisation itself', path: `${ORGS}/${orgId}` },
        { name: 'the member list', path: `${ORGS}/${orgId}/members` },
        { name: 'the workspace list', path: `${ORGS}/${orgId}/workspaces` },
        {
          name: 'a workspace by id',
          path: `${ORGS}/${orgId}/workspaces/${tenant?.workspaceId ?? randomUUID()}`,
        },
      ];
    }

    beforeAll(async () => {
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
    }, 60_000);

    afterAll(async () => {
      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      if (mailboxes.size > 0) {
        await database.delete(schema.users).where(inArray(schema.users.email, [...mailboxes]));
      }

      await app?.close();
    });

    describe('what a grant buys', () => {
      it('lets the guest read the project they were granted', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);

        await grant(owner, tenant, tenant.projectIds[1]!, guest);

        const response = await http()
          .get(`${ORGS}/${tenant.orgId}/projects/${tenant.projectIds[1]!}`)
          .set('Cookie', guest.cookie)
          .expect(200);

        expect(projectResponseSchema.parse(response.body).project).toMatchObject({
          id: tenant.projectIds[1]!,
          name: 'Beta',
        });
      });

      /**
       * And nothing more. The project a guest may read carries no workspace id, because a workspace
       * id is organisation structure — it would tell them a container exists and that two granted
       * projects share one. `projectSummarySchema` is `strictObject`, so this parse is the assertion.
       */
      it('tells them nothing about where the project sits in the organisation', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);

        await grant(owner, tenant, tenant.projectIds[1]!, guest);

        const response = await http()
          .get(`${ORGS}/${tenant.orgId}/projects/${tenant.projectIds[1]!}`)
          .set('Cookie', guest.cookie)
          .expect(200);

        const project = projectResponseSchema.parse(response.body).project;

        expect(Object.keys(project).sort()).toEqual(['createdAt', 'id', 'name', 'permissions']);
        // `permissions` (spec 022 T004) is the one member that could smuggle placement out, because
        // the held set it is built from is resource-qualified. `projectPermissions()` keeps only the
        // entries suffixed `@{this project id}` — the id the guest already typed into the URL — and
        // strips that suffix, so every value is an unqualified permission string. A workspace- or
        // org-qualified entry ends in a different id and is filtered out, never re-labelled. The
        // delimiter assertion is the gate: if a qualified entry ever survives, it fails here.
        expect(project.permissions).not.toHaveLength(0);
        for (const permission of project.permissions) {
          expect(permission).not.toContain('@');
        }
        expect(response.text).not.toContain(tenant.workspaceId);
        expect(response.text).not.toContain(tenant.orgId);
      });
    });

    /**
     * ## The listing excludes, it does not refuse
     *
     * Three projects, one grant. The other two are *absent*, not present-and-forbidden and not
     * counted. A per-item `403` would tell the guest exactly how many projects they cannot see,
     * which is a measure of the organisation handed to somebody §11 gives no visibility into it.
     */
    describe('the project listing', () => {
      it('contains the granted project and no trace of the others', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);

        await grant(owner, tenant, tenant.projectIds[1]!, guest);

        const response = await http()
          .get(`${ORGS}/${tenant.orgId}/projects`)
          .set('Cookie', guest.cookie)
          .expect(200);

        const listed = projectListResponseSchema.parse(response.body).projects;

        expect(listed.map((project) => project.name)).toEqual(['Beta']);
        expect(response.text).not.toContain(tenant.projectIds[0]!);
        expect(response.text).not.toContain(tenant.projectIds[2]!);
      });

      it('is a 200 with a list, never a page of refusals', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);

        await grant(owner, tenant, tenant.projectIds[0]!, guest);
        await grant(owner, tenant, tenant.projectIds[2]!, guest);

        const response = await http()
          .get(`${ORGS}/${tenant.orgId}/projects`)
          .set('Cookie', guest.cookie)
          .expect(200);

        // Sorted: seedTenant creates all three in one transaction, so they share `created_at` and
        // the listing orders them by random uuid, not by name.
        const names = projectListResponseSchema.parse(response.body).projects.map((p) => p.name);
        expect(names.sort()).toEqual(['Alpha', 'Gamma']);
      });

      /**
       * The organisation-does-not-exist case, and the one that matters most. A guest with no grant
       * here gets the same empty list as they would for a uuid that names nothing — so the listing
       * is not "an empty org listing that confirms the org exists".
       */
      it('answers an organisation the guest has no grant in exactly as one that does not exist', async () => {
        const owner = await signUpAndIn();
        const stranger = await signUpAndIn();
        const tenant = await seedTenant(owner);

        const real = await http()
          .get(`${ORGS}/${tenant.orgId}/projects`)
          .set('Cookie', stranger.cookie)
          .expect(200);
        const imaginary = await http()
          .get(`${ORGS}/${randomUUID()}/projects`)
          .set('Cookie', stranger.cookie)
          .expect(200);

        expect(real.body).toEqual({ projects: [] });
        expect(real.body).toEqual(imaginary.body);
      });

      /** A guest of one organisation learns nothing about another they were never granted. */
      it('does not leak one organisation’s projects into another’s listing', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const mine = await seedTenant(owner);
        const theirs = await seedTenant(await signUpAndIn());

        await grant(owner, mine, mine.projectIds[0]!, guest);

        const response = await http()
          .get(`${ORGS}/${theirs.orgId}/projects`)
          .set('Cookie', guest.cookie)
          .expect(200);

        expect(response.body).toEqual({ projects: [] });
      });
    });

    /**
     * ## The proof: a guest sees no org-level resource of any kind
     *
     * The guest here holds a *live, working* grant in this very organisation — proved first, so the
     * refusals below cannot be somebody who simply has no access at all. §11: "an external
     * collaborator with access to named projects only and **no visibility into the organisation**."
     */
    describe('a guest with a working grant', () => {
      it('is refused every org-level route in the organisation they can see a project in', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);

        await grant(owner, tenant, tenant.projectIds[1]!, guest);

        // The grant works. Everything below is therefore about the organisation, not about access.
        await http()
          .get(`${ORGS}/${tenant.orgId}/projects/${tenant.projectIds[1]!}`)
          .set('Cookie', guest.cookie)
          .expect(200);

        for (const route of orgLevelRoutes(tenant.orgId, tenant)) {
          const response = await http().get(route.path).set('Cookie', guest.cookie);

          expect(response.status, `${route.name} was not refused`).toBe(403);
          expect(response.body, route.name).toMatchObject({
            type: 'https://forge.dev/problems/permission-denied',
          });
        }
      });

      /**
       * And the refusals confirm nothing. Each is compared, member by member, against the same route
       * on an organisation that does not exist — so a guest cannot use a `403` to establish that the
       * organisation, the workspace or the member list is real. That is "not a filtered org view".
       */
      it('is refused in a way that does not confirm the organisation exists', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);
        const imaginary = randomUUID();

        await grant(owner, tenant, tenant.projectIds[1]!, guest);

        const real = orgLevelRoutes(tenant.orgId, tenant);
        const fake = orgLevelRoutes(imaginary);

        for (const [index, route] of real.entries()) {
          const refused = await http().get(route.path).set('Cookie', guest.cookie).expect(403);
          const unknown = await http()
            .get(fake[index]!.path)
            .set('Cookie', guest.cookie)
            .expect(403);

          expect(withoutCorrelation(refused), route.name).toEqual(withoutCorrelation(unknown));
        }
      });

      /**
       * The refusal names nothing either. Not the organisation, not the workspace, not the project
       * they *can* see — a problem document that echoed an id back would be a confirmation channel
       * of its own.
       */
      it('is refused without any organisation identifier in the body', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);

        await grant(owner, tenant, tenant.projectIds[1]!, guest);

        const response = await http()
          .get(`${ORGS}/${tenant.orgId}/members`)
          .set('Cookie', guest.cookie)
          .expect(403);

        const { detail, title } = response.body as { detail: string; title: string };

        expect(`${detail} ${title}`).not.toContain(tenant.orgId);
        expect(`${detail} ${title}`).not.toContain(tenant.workspaceId);
        expect(response.text).not.toContain(tenant.projectIds[0]!);
      });

      it('cannot read a project in the same organisation it was not granted', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);

        await grant(owner, tenant, tenant.projectIds[1]!, guest);

        const refused = await http()
          .get(`${ORGS}/${tenant.orgId}/projects/${tenant.projectIds[0]!}`)
          .set('Cookie', guest.cookie)
          .expect(403);
        const unknown = await http()
          .get(`${ORGS}/${tenant.orgId}/projects/${randomUUID()}`)
          .set('Cookie', guest.cookie)
          .expect(403);

        // The two are the same, so walking uuids reveals no project.
        expect(withoutCorrelation(refused)).toEqual(withoutCorrelation(unknown));
      });

      /** A viewer's grant is a viewer's grant: it does not carry the right to share the project on. */
      it('cannot share the project onward', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const other = await signUpAndIn();
        const tenant = await seedTenant(owner);

        await grant(owner, tenant, tenant.projectIds[1]!, guest);

        await unsafe(http().put(grantPath(tenant, tenant.projectIds[1]!, other)), [guest.cookie])
          .send({ role: 'viewer' })
          .expect(403);
      });
    });

    describe('the grant lifecycle', () => {
      it('is idempotent: the same grant twice is not a conflict', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);
        const path = grantPath(tenant, tenant.projectIds[0]!, guest);

        const first = await unsafe(http().put(path), [owner.cookie])
          .send({ role: 'viewer' })
          .expect(200);
        const second = await unsafe(http().put(path), [owner.cookie])
          .send({ role: 'viewer' })
          .expect(200);

        expect(first.body).toEqual({ role: 'viewer', status: PROJECT_GRANTED });
        expect(second.body).toEqual(first.body);
      });

      it('changes the role in place when the same grant is re-sent with a different one', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);
        const path = grantPath(tenant, tenant.projectIds[0]!, guest);

        await unsafe(http().put(path), [owner.cookie]).send({ role: 'viewer' }).expect(200);
        await unsafe(http().put(path), [owner.cookie]).send({ role: 'owner' }).expect(200);

        // The guest's row only. Every project also carries its creator's `owner` grant, which is
        // how a member holds a project role at all (§11's scopes do not cascade), so an unscoped
        // count here would be counting those too.
        const rows = await transactions.runInTenantTransaction(tenant.orgId, (tx) =>
          tx
            .select({ role: schema.projectGrants.role })
            .from(schema.projectGrants)
            .where(eq(schema.projectGrants.userId, guest.userId)),
        );

        expect(rows).toEqual([{ role: 'owner' }]);
      });

      /**
       * The invalidation, seen from outside: the guest's access ends on their very next request, not
       * when the backstop TTL runs out. Their set is warmed by a successful read first, so a cache
       * left to expire would still be answering `200` here.
       */
      it('ends the guest’s access on their next request when revoked', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);
        const projectId = tenant.projectIds[1]!;

        await grant(owner, tenant, projectId, guest);
        await http()
          .get(`${ORGS}/${tenant.orgId}/projects/${projectId}`)
          .set('Cookie', guest.cookie)
          .expect(200);

        const revoked = await unsafe(http().delete(grantPath(tenant, projectId, guest)), [
          owner.cookie,
        ]).expect(200);

        expect(revoked.body).toEqual({ status: PROJECT_GRANT_REVOKED });

        await http()
          .get(`${ORGS}/${tenant.orgId}/projects/${projectId}`)
          .set('Cookie', guest.cookie)
          .expect(403);
        const listing = await http()
          .get(`${ORGS}/${tenant.orgId}/projects`)
          .set('Cookie', guest.cookie)
          .expect(200);

        expect(listing.body).toEqual({ projects: [] });
      });

      /**
       * A revoked grant is not a member removal. §11 revokes sessions wholesale "on password reset
       * or member removal"; signing somebody out of their whole account because one project was
       * unshared would be a denial of service, and the account may be a full member elsewhere.
       */
      it('leaves the guest signed in after a revocation', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);
        const projectId = tenant.projectIds[1]!;

        await grant(owner, tenant, projectId, guest);
        await unsafe(http().delete(grantPath(tenant, projectId, guest)), [owner.cookie]).expect(
          200,
        );

        await http().get('/api/v1/auth/sessions').set('Cookie', guest.cookie).expect(200);
      });

      it('answers a revocation of a grant that does not exist with a 404', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);

        await unsafe(http().delete(grantPath(tenant, tenant.projectIds[0]!, guest)), [
          owner.cookie,
        ]).expect(404);
      });

      /** §11 gives sharing externally to the project owner alone; an org owner is not one by default. */
      it('refuses a caller who does not hold project:share.external on that project', async () => {
        const owner = await signUpAndIn();
        const editor = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);
        const projectId = tenant.projectIds[0]!;

        await unsafe(http().put(grantPath(tenant, projectId, editor)), [owner.cookie])
          .send({ role: 'editor' })
          .expect(200);

        await unsafe(http().put(grantPath(tenant, projectId, guest)), [editor.cookie])
          .send({ role: 'viewer' })
          .expect(403);
      });

      it('writes the grant and the revocation to the audit trail', async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);
        const projectId = tenant.projectIds[0]!;

        await grant(owner, tenant, projectId, guest);
        await unsafe(http().delete(grantPath(tenant, projectId, guest)), [owner.cookie]).expect(
          200,
        );

        const entries = await transactions.runInTenantTransaction(tenant.orgId, (tx) =>
          tx.select({ action: schema.auditLog.action }).from(schema.auditLog),
        );
        const actions = entries.map((entry) => entry.action);

        expect(actions).toContain('project-grant.granted');
        expect(actions).toContain('project-grant.revoked');
      });
    });

    /** Spec 031 FR-035: a guest's home is what was shared with them, and nothing else. */
    describe('a guest home (spec 031)', () => {
      it("a guest's home lists only the orgs and projects shared with them", async () => {
        const owner = await signUpAndIn();
        const guest = await signUpAndIn();
        const tenant = await seedTenant(owner);
        const elsewhere = await seedTenant(owner);

        await grant(owner, tenant, tenant.projectIds[1]!, guest);

        const orgs = await http().get(ORGS).set('Cookie', guest.cookie).expect(200);

        expect(orgListResponseSchema.parse(orgs.body).orgs).toEqual([
          expect.objectContaining({ access: 'guest', id: tenant.orgId, role: null }),
        ]);
        expect(orgs.text).not.toContain(elsewhere.orgId);

        const listed = await http()
          .get(`${ORGS}/${tenant.orgId}/projects`)
          .set('Cookie', guest.cookie)
          .expect(200);

        expect(
          projectListResponseSchema.parse(listed.body).projects.map((project) => project.name),
        ).toEqual(['Beta']);
      });
    });

    /**
     * A member is not a guest, and the same listing serves both — the exclusion is the resolved
     * permission set, so nothing about it is guest-specific. Asserted so that "guests see less"
     * cannot quietly become "everybody sees less".
     */
    describe('an ordinary member', () => {
      it('still sees the projects their workspace role reaches', async () => {
        const owner = await signUpAndIn();
        const tenant = await seedTenant(owner);

        const response = await http()
          .get(`${ORGS}/${tenant.orgId}/projects`)
          .set('Cookie', owner.cookie)
          .expect(200);

        expect(
          projectListResponseSchema
            .parse(response.body)
            .projects.map((project) => project.name)
            .sort(),
        ).toEqual(['Alpha', 'Beta', 'Gamma']);
      });

      it('and can still read the organisation itself', async () => {
        const owner = await signUpAndIn();
        const tenant = await seedTenant(owner);

        for (const route of orgLevelRoutes(tenant.orgId, tenant)) {
          await http().get(route.path).set('Cookie', owner.cookie).expect(200);
        }
      });
    });
  });
});

function withoutCorrelation(response: request.Response): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(response.body as Record<string, unknown>).filter(
      ([member]) => member !== 'requestId' && member !== 'instance',
    ),
  );
}
