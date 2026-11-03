import type { INestApplication } from '@nestjs/common';
import { schema } from '@repo/db';
import { getTableColumns, inArray, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';

import { APP_DATABASE } from '../../src/database/database.constants';
import type { ForgeDatabase } from '../../src/database/database.types';
import { TenantTransactionRunner } from '../../src/database/tenant-transaction';
import { PasswordHasher } from '../../src/modules/identity/password/hasher';
import { ProjectService } from '../../src/modules/tenancy/services/project.service';
import { unsafe } from './csrf-client';

const LOGIN = '/api/v1/auth/login';
const ORGS = '/api/v1/orgs';

/** Long enough for the zxcvbn floor, and the same for every account here — none of them is secret. */
export const FIXTURE_PASSWORD = 'thermos-quibble-tundra-vellum';

/** A signed-in account, held as a client rather than a token: the suite makes real requests. */
export interface Principal {
  readonly cookie: string;
  readonly email: string;
  readonly userId: string;
}

/**
 * One tenant, seeded through the product's own routes and services rather than by inserting rows.
 *
 * That matters for an isolation suite specifically. Rows written straight into Postgres can be
 * subtly wrong — an `org_id` that does not match the workspace's, a project with no owning grant —
 * and a probe that fails against a malformed tenant proves nothing about a well-formed one.
 */
export interface Tenant {
  /** Unique per tenant and per run, so it is a usable needle in {@link Tenant.secrets}. */
  readonly name: string;
  readonly orgId: string;
  readonly owner: Principal;
  readonly projectId: string;
  /**
   * Every string that must never appear in a response to the *other* tenant. The suite scans
   * response bodies for these, so anything identifying belongs here — an id this list forgets is a
   * leak the gate cannot see.
   */
  readonly secrets: readonly string[];
  readonly slug: string;
  readonly workspaceId: string;
}

export interface TwoTenantWorld {
  /** The tenant whose owner does the probing. Holds no membership, grant or role in {@link beta}. */
  readonly alpha: Tenant;
  /** The tenant being probed. Everything in it is off limits to alpha. */
  readonly beta: Tenant;
  /** A signed-in account with no organisation at all — the weakest principal the API can have. */
  readonly outsider: Principal;
}

/** One tenant-owned table, with the export name the schema knows it by — for legible failures. */
export interface TenantOwnedTable {
  readonly name: string;
  readonly table: PgTable;
}

/**
 * The `@repo/db` tables that carry an `org_id`, discovered from the schema rather than listed.
 *
 * Listing them would decay exactly as a hand-written route array does: a table added later would not
 * be snapshotted, not be swept, and not be missed. Membership of this set is the schema's own
 * definition of "tenant-owned", which is also what the RLS policies key on (§09).
 */
export function tenantOwnedTables(): TenantOwnedTable[] {
  const found: TenantOwnedTable[] = [];

  // `unknown` because `schema` is a union of a dozen precisely-typed tables, and narrowing that
  // union with `is()` asks TypeScript to prove a relationship it has no reason to believe. The
  // widening is safe: `is()` is the runtime check, and nothing below reads a named column.
  for (const [name, value] of Object.entries(schema) as [string, unknown][]) {
    if (is(value, PgTable) && 'orgId' in getTableColumns(value)) {
      found.push({ name, table: value });
    }
  }

  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Two complete, unrelated tenants and an outsider.
 *
 * `app.init()` must have run. Everything is created over HTTP or through the same services the API
 * calls, inside the tenant scope those services expect.
 */
export async function createTwoTenantWorld(app: INestApplication): Promise<TwoTenantWorld> {
  // Sequential. Supertest brings the server up on an ephemeral port on its first request, and three
  // concurrent first requests race that startup into an `ECONNRESET` that looks like a test failure.
  const alpha = await seedTenant(app, 'alpha');
  const beta = await seedTenant(app, 'beta');
  const outsider = await signUpAndIn(app, 'outsider');

  return { alpha, beta, outsider };
}

/** Removes every row the world created, by org and by mailbox. Safe to call twice. */
export async function destroyTwoTenantWorld(
  app: INestApplication,
  world: TwoTenantWorld | undefined,
): Promise<void> {
  if (world === undefined) {
    return;
  }

  const database = app.get<ForgeDatabase>(APP_DATABASE);
  const orgIds = [world.alpha.orgId, world.beta.orgId];
  const emails = [world.alpha.owner.email, world.beta.owner.email, world.outsider.email];

  await database.delete(schema.orgs).where(inArray(schema.orgs.id, orgIds));
  await database.delete(schema.users).where(inArray(schema.users.email, emails));
}

/** A verified account, signed in. Verified because an unverified one is refused before tenancy. */
export async function signUpAndIn(app: INestApplication, label: string): Promise<Principal> {
  const database = app.get<ForgeDatabase>(APP_DATABASE);
  const hasher = app.get(PasswordHasher);
  const email = `t32-${label}-${randomUUID()}@example.test`;

  const [user] = await database
    .insert(schema.users)
    .values({
      email,
      emailVerifiedAt: new Date(),
      passwordHash: await hasher.hash(FIXTURE_PASSWORD),
    })
    .returning({ id: schema.users.id });

  const response = await unsafe(http(app).post(LOGIN))
    .set('X-Forwarded-For', nextClientAddress())
    .send({ email, password: FIXTURE_PASSWORD })
    .expect(200);

  const header = ((response.headers as unknown as Record<string, string[] | undefined>)[
    'set-cookie'
  ] ?? [])[0];

  return { cookie: header!.split(';')[0]!, email, userId: user!.id };
}

export function http(app: INestApplication): request.Agent {
  return request(app.getHttpServer() as Server);
}

/**
 * `198.34/16`, distinct from the ranges the other e2e suites claim against the same Redis.
 *
 * The login throttle is keyed per address, and this suite signs in a handful of accounts; sharing a
 * range with another suite would make the two throttle each other into failures that look like bugs.
 */
const RUN = Math.floor(Math.random() * 256);
let issuedAddresses = 0;

function nextClientAddress(): string {
  issuedAddresses += 1;

  const slot = (RUN * 256 + issuedAddresses) % 65_536;

  return `198.34.${Math.floor(slot / 256)}.${slot % 256}`;
}

async function seedTenant(app: INestApplication, label: string): Promise<Tenant> {
  const transactions = app.get(TenantTransactionRunner);
  const projects = app.get(ProjectService);
  const owner = await signUpAndIn(app, label);
  const name = `Tenant ${label} ${randomUUID()}`;
  const slug = `t32-${label}-${randomUUID().slice(0, 8)}`;

  const created = await unsafe(http(app).post(ORGS), [owner.cookie])
    .send({ name, slug })
    .expect(201);

  const orgId = (created.body as { org: { id: string } }).org.id;

  // The workspace `OrgService.create` makes for a new organisation. Read rather than created, so the
  // fixture stays honest about what signup actually produces.
  const [workspace] = await transactions.runInTenantTransaction(orgId, (tx) =>
    tx.select({ id: schema.workspaces.id }).from(schema.workspaces),
  );

  const project = await transactions.runInTenantScope({ orgId, userId: owner.userId }, () =>
    projects.create({
      actorId: owner.userId,
      name: `Project ${label}`,
      orgId,
      ownerId: owner.userId,
      workspaceId: workspace!.id,
    }),
  );

  return {
    name,
    orgId,
    owner,
    projectId: project.id,
    // The owner's user id is deliberately in here. It is not a tenant id, but it is the one thing a
    // member list discloses, and "who else is in that organisation" is precisely what a cross-tenant
    // read of `/members` would hand over.
    secrets: [orgId, workspace!.id, project.id, owner.userId, owner.email, name, slug],
    slug,
    workspaceId: workspace!.id,
  };
}
