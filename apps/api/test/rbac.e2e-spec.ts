import type { INestApplication } from '@nestjs/common';
import { Controller, Get, Param } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { schema } from '@repo/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { APP_DATABASE } from '../src/database/database.constants';
import type { ForgeDatabase } from '../src/database/database.types';
import { TenantContext } from '../src/database/tenant-context';
import { TenantTransactionRunner } from '../src/database/tenant-transaction';
import {
  BREACHED_PASSWORD_PORT,
  type BreachedPasswordPort,
} from '../src/modules/identity/password/breached-password.port';
import { PasswordHasher } from '../src/modules/identity/password/hasher';
import { RequirePermission } from '../src/modules/rbac/decorators/require-permission.decorator';
import { ResourceOrg } from '../src/modules/rbac/resource-org.resolver';
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
const PASSWORD = 'thermos-quibble-tundra-vellum';

/** `198.31/16`, distinct from the ranges the other e2e suites claim against the same Redis. */
const RUN = randomInt(0, 256);
let issuedAddresses = 0;

function nextClientAddress(): string {
  issuedAddresses += 1;

  const slot = (RUN * 256 + issuedAddresses) % 65_536;

  return `198.31.${Math.floor(slot / 256)}.${slot % 256}`;
}

class ScriptedBreachPort implements BreachedPasswordPort {
  isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * The routes under test.
 *
 * T26 ships the guard, not the API surface — the controllers that will carry `@RequirePermission()`
 * in earnest are T27's and T29's, and the spec puts project and workspace CRUD out of scope
 * entirely. A probe controller is what lets the guard be proved now against the real pipeline:
 * real `SessionGuard`, real CSRF middleware, real tenant interceptor, real Postgres with RLS on.
 *
 * Each handler reports what the request could actually *see*, not merely that it was admitted. That
 * is what makes these tests proofs of §11's layering rather than of the guard alone: the tenant the
 * handler ran in comes from `TenantContext`, which the interceptor set, and the project lookup goes
 * through that transaction, so RLS is the thing that answers it.
 */
@ResourceOrg()
@Controller({ path: 'orgs/:orgId/probe', version: '1' })
class ProbeController {
  constructor(private readonly tenant: TenantContext) {}

  @Get()
  @RequirePermission('org:read')
  read(this: ProbeController): { orgId: string } {
    return { orgId: this.tenant.orgId };
  }

  @Get('settings')
  @RequirePermission('org:settings.update')
  updateSettings(this: ProbeController): { orgId: string } {
    return { orgId: this.tenant.orgId };
  }

  @Get('projects/:projectId')
  @RequirePermission('project:read')
  async readProject(
    this: ProbeController,
    @Param('projectId') projectId: string,
  ): Promise<{ found: boolean; orgId: string }> {
    const rows = await this.tenant.tx
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));

    return { found: rows.length > 0, orgId: this.tenant.orgId };
  }
}

/**
 * The same demand, on a controller that never registered where its organisation comes from. It is
 * otherwise indistinguishable from the one above — same path shape, same `:orgId` segment, same
 * permission — which is the point: the only difference is the missing registration.
 */
@Controller({ path: 'unregistered/orgs/:orgId/probe', version: '1' })
class UnregisteredProbeController {
  @Get()
  @RequirePermission('org:read')
  read(this: void): { reached: true } {
    return { reached: true };
  }
}

interface SignedIn {
  readonly cookie: string;
  readonly userId: string;
}

interface Tenant {
  readonly orgId: string;
  readonly projectId: string;
  readonly workspaceId: string;
}

describe('RequirePermission and resource-derived tenancy (e2e)', () => {
  describe.skipIf(!postgres || !redis)('against Postgres and both Redis roles', () => {
    let app: INestApplication;
    let database: ForgeDatabase;
    let hasher: PasswordHasher;
    let transactions: TenantTransactionRunner;
    const orgIds: string[] = [];
    const mailboxes = new Set<string>();

    function http(): request.Agent {
      return request(app.getHttpServer() as Server);
    }

    /** An organisation with one workspace and one project in it. */
    async function seedTenant(name: string): Promise<Tenant> {
      const [org] = await database
        .insert(schema.orgs)
        .values({ name, slug: `t26-${randomUUID()}` })
        .returning({ id: schema.orgs.id });

      const orgId = org!.id;

      orgIds.push(orgId);

      return transactions.runInTenantTransaction(orgId, async (tx) => {
        const [workspace] = await tx
          .insert(schema.workspaces)
          .values({ name: `${name} workspace`, orgId })
          .returning({ id: schema.workspaces.id });

        const [project] = await tx
          .insert(schema.projects)
          .values({
            name: `${name} project`,
            orgId,
            previewLabel: `t26-${randomUUID()}`,
            workspaceId: workspace!.id,
          })
          .returning({ id: schema.projects.id });

        return { orgId, projectId: project!.id, workspaceId: workspace!.id };
      });
    }

    /**
     * A second project in an existing organisation. Inside a tenant transaction, because it has to
     * be: `projects` carries `WITH CHECK (org_id = app.org_id)`, so an insert issued outside one is
     * refused by the database with 42501 rather than landing under no tenant.
     */
    async function seedProject(tenant: Tenant, name: string): Promise<string> {
      return transactions.runInTenantTransaction(tenant.orgId, async (tx) => {
        const [project] = await tx
          .insert(schema.projects)
          .values({
            name,
            orgId: tenant.orgId,
            previewLabel: `t26-${randomUUID()}`,
            workspaceId: tenant.workspaceId,
          })
          .returning({ id: schema.projects.id });

        return project!.id;
      });
    }

    async function seedUser(): Promise<string> {
      const email = `t26-${randomUUID()}@example.test`;

      mailboxes.add(email);

      const [user] = await database
        .insert(schema.users)
        .values({ email, emailVerifiedAt: new Date(), passwordHash: await hasher.hash(PASSWORD) })
        .returning({ id: schema.users.id });

      return user!.id;
    }

    async function addMember(
      orgId: string,
      userId: string,
      role: 'owner' | 'admin' | 'member' | 'billing',
    ): Promise<void> {
      await transactions.runInTenantTransaction(orgId, async (tx) => {
        await tx.insert(schema.memberships).values({ acceptedAt: new Date(), orgId, role, userId });
      });
    }

    async function grantProject(
      orgId: string,
      projectId: string,
      userId: string,
      role: 'owner' | 'editor' | 'commenter' | 'viewer',
    ): Promise<void> {
      await transactions.runInTenantTransaction(orgId, async (tx) => {
        await tx.insert(schema.projectGrants).values({ orgId, projectId, role, userId });
      });
    }

    async function signIn(userId: string): Promise<SignedIn> {
      const [user] = await database
        .select({ email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, userId));

      const response = await unsafe(http().post(LOGIN))
        .set('X-Forwarded-For', nextClientAddress())
        .send({ email: user!.email, password: PASSWORD })
        .expect(200);

      const header = ((response.headers as unknown as Record<string, string[] | undefined>)[
        'set-cookie'
      ] ?? [])[0];

      return { cookie: header!.split(';')[0]!, userId };
    }

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [ProbeController, UnregisteredProbeController],
        imports: [AppModule],
      })
        .overrideProvider(BREACHED_PASSWORD_PORT)
        .useClass(ScriptedBreachPort)
        .compile();

      app = moduleRef.createNestApplication();
      configureApplication(app);
      await app.init();

      database = app.get<ForgeDatabase>(APP_DATABASE);
      hasher = app.get(PasswordHasher);
      transactions = app.get(TenantTransactionRunner);
    }, 60_000);

    afterAll(async () => {
      if (mailboxes.size > 0) {
        await database.delete(schema.users).where(inArray(schema.users.email, [...mailboxes]));
      }

      if (orgIds.length > 0) {
        await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
      }

      await app?.close();
    });

    /**
     * ## The forged-header proof
     *
     * This is the property the whole design exists to guarantee, and it has two halves. Neither is
     * sufficient alone: the first shows the header cannot *redirect* a request the caller is
     * entitled to make, and the second shows it cannot *authorise* one they are not.
     */
    describe('a forged X-Org-Id header', () => {
      it('does not redirect a permitted request to the organisation it names', async () => {
        const mine = await seedTenant('mine');
        const theirs = await seedTenant('theirs');
        const userId = await seedUser();

        await addMember(mine.orgId, userId, 'owner');

        const caller = await signIn(userId);

        const response = await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .set('X-Org-Id', theirs.orgId)
          .set('X-Organization-Id', theirs.orgId)
          .expect(200);

        // The tenant the handler actually ran in — read from `TenantContext`, which the interceptor
        // set from the same derivation the guard used. The header named the other organisation and
        // moved nothing.
        expect(response.body).toEqual({ orgId: mine.orgId });
      });

      /**
       * The dangerous half. The caller is an owner — of their *own* organisation — and asks for a
       * resource in one they have never been a member of, with the header claiming the organisation
       * where their ownership is real. A server that resolved permissions against the header would
       * answer 200 here.
       */
      it('does not carry the caller’s permissions into an organisation they do not belong to', async () => {
        const mine = await seedTenant('mine');
        const theirs = await seedTenant('theirs');
        const userId = await seedUser();

        await addMember(mine.orgId, userId, 'owner');

        const caller = await signIn(userId);

        const response = await http()
          .get(`/api/v1/orgs/${theirs.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .set('X-Org-Id', mine.orgId)
          .expect(403);

        expect(response.body).toMatchObject({
          status: 403,
          type: 'https://forge.dev/problems/permission-denied',
        });
      });

      /**
       * And it is refused identically to the same request sent without any header at all. If the two
       * differed in any member, the difference would be a signal that the header had been read —
       * which is exactly what a client must not be able to detect.
       */
      it('is answered exactly as the same request with no header', async () => {
        const mine = await seedTenant('mine');
        const theirs = await seedTenant('theirs');
        const userId = await seedUser();

        await addMember(mine.orgId, userId, 'owner');

        const caller = await signIn(userId);
        const path = `/api/v1/orgs/${theirs.orgId}/probe`;

        const forged = await http()
          .get(path)
          .set('Cookie', caller.cookie)
          .set('X-Org-Id', mine.orgId)
          .expect(403);
        const plain = await http().get(path).set('Cookie', caller.cookie).expect(403);

        expect(withoutCorrelation(forged)).toEqual(withoutCorrelation(plain));
      });
    });

    /**
     * ## The fail-closed proof
     *
     * The caller is an owner of the organisation in the path, holds `org:read` there, and presents a
     * perfectly good session. The only thing absent is the route's own registration of where its
     * organisation comes from — and that alone is enough to refuse.
     */
    describe('a route that registered no resource→org resolver', () => {
      it('denies an owner who holds the very permission it demands', async () => {
        const mine = await seedTenant('mine');
        const userId = await seedUser();

        await addMember(mine.orgId, userId, 'owner');

        const caller = await signIn(userId);

        // The control: the identical demand on the registered controller admits this caller, so the
        // denial below is the missing registration and nothing else about the fixture.
        await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .expect(200);

        const response = await http()
          .get(`/api/v1/unregistered/orgs/${mine.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .expect(403);

        expect(response.body).toMatchObject({
          type: 'https://forge.dev/problems/permission-denied',
        });
      });

      it('denies it with a header naming the organisation too, which is the fallback that must not exist', async () => {
        const mine = await seedTenant('mine');
        const userId = await seedUser();

        await addMember(mine.orgId, userId, 'owner');

        const caller = await signIn(userId);

        await http()
          .get(`/api/v1/unregistered/orgs/${mine.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .set('X-Org-Id', mine.orgId)
          .expect(403);
      });
    });

    describe('the org scope', () => {
      it('admits a member for a permission their role holds', async () => {
        const mine = await seedTenant('mine');
        const userId = await seedUser();

        await addMember(mine.orgId, userId, 'member');

        const caller = await signIn(userId);

        await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .expect(200);
      });

      /** Criterion 11's wrong-role case, at the org scope: `member` does not change settings. */
      it('refuses a member for a permission only an owner or admin holds', async () => {
        const mine = await seedTenant('mine');
        const userId = await seedUser();

        await addMember(mine.orgId, userId, 'member');

        const caller = await signIn(userId);

        const response = await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe/settings`)
          .set('Cookie', caller.cookie)
          .expect(403);

        expect(response.body).toMatchObject({
          type: 'https://forge.dev/problems/permission-denied',
        });
      });

      it('refuses a stranger to the organisation', async () => {
        const theirs = await seedTenant('theirs');
        const caller = await signIn(await seedUser());

        await http()
          .get(`/api/v1/orgs/${theirs.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .expect(403);
      });

      /**
       * An organisation that does not exist is refused exactly as one the caller may not see. A 404
       * here would confirm which uuids name real tenants to anybody willing to walk them.
       */
      it('answers a non-existent organisation as it answers one the caller may not see', async () => {
        const theirs = await seedTenant('theirs');
        const caller = await signIn(await seedUser());

        const unknown = await http()
          .get(`/api/v1/orgs/${randomUUID()}/probe`)
          .set('Cookie', caller.cookie)
          .expect(403);
        const forbidden = await http()
          .get(`/api/v1/orgs/${theirs.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .expect(403);

        expect(withoutCorrelation(unknown)).toEqual(withoutCorrelation(forbidden));
      });

      it('refuses a caller with no session before it considers permissions at all', async () => {
        const mine = await seedTenant('mine');

        await http().get(`/api/v1/orgs/${mine.orgId}/probe`).expect(401);
      });
    });

    /**
     * ## The three layers, on one request
     *
     * §11: "a guard on the route, an explicit check inside the service for anything the guard cannot
     * express, and RLS underneath both." These assert the first and the third — the second is a
     * service-level concern and arrives with T27's services.
     */
    describe('the project scope', () => {
      it('admits a guest for the project they hold a grant on', async () => {
        const mine = await seedTenant('mine');
        const userId = await seedUser();

        await grantProject(mine.orgId, mine.projectId, userId, 'viewer');

        const caller = await signIn(userId);

        const response = await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe/projects/${mine.projectId}`)
          .set('Cookie', caller.cookie)
          .expect(200);

        expect(response.body).toEqual({ found: true, orgId: mine.orgId });
      });

      /**
       * The reason resolved entries carry their resource (T24's `scoped()`). One grant, two projects
       * in the same organisation: the ungranted one is refused even though the caller holds
       * `project:read` in that very tenant.
       */
      it('refuses a project in the same organisation that the grant does not name', async () => {
        const mine = await seedTenant('mine');
        const granted = mine.projectId;
        const other = await seedProject(mine, 'ungranted');
        const userId = await seedUser();

        await grantProject(mine.orgId, granted, userId, 'viewer');

        const caller = await signIn(userId);

        await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe/projects/${granted}`)
          .set('Cookie', caller.cookie)
          .expect(200);

        await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe/projects/${other}`)
          .set('Cookie', caller.cookie)
          .expect(403);
      });

      /**
       * **The layer underneath, and why the guard's job is smaller than it looks.**
       *
       * The obvious attack on a resource-derived org is to hold a grant in an organisation you
       * belong to and point it at a resource in one you do not. The first assertion shows that row
       * cannot be written: `project_grants` carries a composite `(org_id, project_id)` foreign key
       * (§09), so a grant filed under `mine` naming a project of `theirs` has no parent to reference
       * and the database refuses it. Not hidden — refused. "Composite keys make the bad row
       * unrepresentable", as §09 puts it, and that is the property the guard's correctness rests on.
       *
       * With the cross-tenant grant unrepresentable, the remaining shape of the attack is the plain
       * one, and the guard answers it: the entry resolved for `mine` is `project:read@{mine}`, the
       * path asks for `theirs`, and the sets do not meet.
       */
      it('cannot be pointed at another tenant’s project, at either layer', async () => {
        const mine = await seedTenant('mine');
        const theirs = await seedTenant('theirs');
        const userId = await seedUser();

        // A grant in `mine`, on a project id that belongs to `theirs`. Nothing stops the row being
        // written — `project_grants` is filed under `mine`, and its composite foreign key is
        // satisfied only if the project is `mine`'s too, so this insert is refused by the database.
        // That refusal is itself the §09 property, so it is asserted rather than worked around.
        await expect(
          grantProject(mine.orgId, theirs.projectId, userId, 'viewer'),
        ).rejects.toThrow();

        // With the cross-tenant grant unrepresentable, the reachable case is the ordinary one: the
        // caller may read their own project, and asking for the other tenant's under their own
        // organisation's path is refused by the guard before RLS is consulted.
        await grantProject(mine.orgId, mine.projectId, userId, 'viewer');

        const caller = await signIn(userId);

        await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe/projects/${theirs.projectId}`)
          .set('Cookie', caller.cookie)
          .expect(403);
      });

      /**
       * A guest holds a project grant and no membership, so the org scope is not narrowed for them —
       * it is never entered (T24). The org-scoped route is therefore refused for the very
       * organisation whose project they can read, which is §11's "no visibility into the
       * organisation" as the guard sees it. T30 carries the rest of that property.
       */
      it('gives a guest no org-scoped permission in the organisation that holds their project', async () => {
        const mine = await seedTenant('mine');
        const userId = await seedUser();

        await grantProject(mine.orgId, mine.projectId, userId, 'viewer');

        const caller = await signIn(userId);

        await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe/projects/${mine.projectId}`)
          .set('Cookie', caller.cookie)
          .expect(200);

        await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .expect(403);
      });

      /** An org member is not implicitly anything in a project — §11's scopes compose, none cascades. */
      it('refuses an org owner who holds no grant on the project', async () => {
        const mine = await seedTenant('mine');
        const userId = await seedUser();

        await addMember(mine.orgId, userId, 'owner');

        const caller = await signIn(userId);

        await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .expect(200);

        await http()
          .get(`/api/v1/orgs/${mine.orgId}/probe/projects/${mine.projectId}`)
          .set('Cookie', caller.cookie)
          .expect(403);
      });
    });

    describe('the denial', () => {
      it('is a valid RFC 9457 document with the catalogued slug and title', async () => {
        const theirs = await seedTenant('theirs');
        const caller = await signIn(await seedUser());

        const response = await http()
          .get(`/api/v1/orgs/${theirs.orgId}/probe`)
          .set('Cookie', caller.cookie)
          .expect(403);

        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.body).toMatchObject({
          status: 403,
          title: 'Permission Denied',
          type: 'https://forge.dev/problems/permission-denied',
        });
        expect(response.body).toHaveProperty('requestId');
      });

      /** It names no resource: not the organisation, not the permission that would have worked. */
      it('discloses neither the permission demanded nor the organisation refused', async () => {
        const theirs = await seedTenant('theirs');
        const caller = await signIn(await seedUser());

        const response = await http()
          .get(`/api/v1/orgs/${theirs.orgId}/probe/settings`)
          .set('Cookie', caller.cookie)
          .expect(403);

        const { detail } = response.body as { detail: string };

        expect(detail).not.toContain(theirs.orgId);
        // The permission is absent from the *whole* document, not merely from the sentence: an
        // extension member carrying it would leak exactly as much. `instance` is exempted only
        // because it is the path the caller themselves sent.
        expect(response.text).not.toContain('org:settings.update');
      });
    });

    /**
     * The guard is not an authentication mechanism and does not become one. A route with no
     * `@RequirePermission()` is left to `SessionGuard`, which is what keeps every account-scoped
     * identity route reachable with no organisation in existence at all.
     */
    describe('a route that demands no permission', () => {
      it('is untouched by the guard', async () => {
        const caller = await signIn(await seedUser());

        await http().get('/api/v1/auth/sessions').set('Cookie', caller.cookie).expect(200);
      });
    });

    /**
     * A tenant-owned row written under the wrong organisation is refused by the database, not merely
     * hidden. This is the `WITH CHECK` half of the `tenant_isolation` policy, and it is asserted here
     * because the guard's correctness rests on `project_grants.org_id` meaning what it says.
     */
    describe('the tenant a row is filed under', () => {
      it('cannot be one the transaction is not scoped to', async () => {
        const mine = await seedTenant('mine');
        const theirs = await seedTenant('theirs');
        const userId = await seedUser();

        await expect(
          transactions.runInTenantTransaction(mine.orgId, async (tx) => {
            await tx
              .insert(schema.memberships)
              .values({ acceptedAt: new Date(), orgId: theirs.orgId, role: 'owner', userId });
          }),
        ).rejects.toThrow();

        const rows = await transactions.runInTenantTransaction(theirs.orgId, async (tx) =>
          tx
            .select({ id: schema.memberships.id })
            .from(schema.memberships)
            .where(
              and(
                eq(schema.memberships.orgId, theirs.orgId),
                eq(schema.memberships.userId, userId),
              ),
            ),
        );

        expect(rows).toEqual([]);
      });
    });
  });
});

/**
 * A problem document without the two members that are *supposed* to differ between two requests:
 * `requestId` is minted per request and `instance` is the path.
 */
function withoutCorrelation(response: request.Response): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(response.body as Record<string, unknown>).filter(
      ([member]) => member !== 'requestId' && member !== 'instance',
    ),
  );
}
