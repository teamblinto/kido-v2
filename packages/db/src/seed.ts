import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { migrationDatabaseUrl } from './env';
import { users } from './schema/identity';
import { memberships, orgs, workspaces } from './schema/tenancy';

const { Pool } = pg;

const ORG_NAME = 'Forge Dev';
const ORG_SLUG = 'forge-dev';
const OWNER_EMAIL = 'owner@forge.dev';
const WORKSPACE_NAME = 'Default';

type Transaction = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0];

async function upsertOrg(tx: Transaction): Promise<string> {
  const inserted = await tx
    .insert(orgs)
    .values({ name: ORG_NAME, slug: ORG_SLUG })
    .onConflictDoNothing({ target: orgs.slug })
    .returning({ id: orgs.id });

  const existing =
    inserted[0] ?? (await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.slug, ORG_SLUG)))[0];

  if (!existing) {
    throw new Error('Seed failed: could not resolve the development organisation.');
  }

  return existing.id;
}

async function upsertOwner(tx: Transaction): Promise<string> {
  const inserted = await tx
    .insert(users)
    .values({ email: OWNER_EMAIL, emailVerifiedAt: sql`now()` })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });

  const existing =
    inserted[0] ??
    (await tx.select({ id: users.id }).from(users).where(eq(users.email, OWNER_EMAIL)))[0];

  if (!existing) {
    throw new Error('Seed failed: could not resolve the development owner.');
  }

  return existing.id;
}

/**
 * Reached only from inside the tenant transaction opened below, which is the point: `workspaces`
 * carries FORCE ROW LEVEL SECURITY, so without `app.org_id` this SELECT returns nothing on a second
 * run and the INSERT that follows is refused by WITH CHECK. A green re-run is therefore evidence
 * that the transaction-scoped context reached the database, not just that the seed is idempotent.
 */
async function upsertDefaultWorkspace(tx: Transaction, orgId: string): Promise<string> {
  const existing = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.orgId, orgId), eq(workspaces.name, WORKSPACE_NAME)));

  if (existing[0]) {
    return existing[0].id;
  }

  const inserted = await tx
    .insert(workspaces)
    .values({ name: WORKSPACE_NAME, orgId })
    .returning({ id: workspaces.id });

  if (!inserted[0]) {
    throw new Error('Seed failed: could not create the default workspace.');
  }

  return inserted[0].id;
}

/**
 * Development seed: one org, one owner, one workspace. Re-running it is a no-op.
 *
 * The owner has no `password_hash`. The Argon2id hasher lands with the password module, and a
 * placeholder hash committed here would be a credential in the repository — which the spec's
 * "never" list rules out. The seeded owner becomes usable through the password-reset flow.
 */
async function seed(): Promise<void> {
  const deployEnv = process.env.DEPLOY_ENV ?? 'local';

  if (deployEnv !== 'local') {
    throw new Error(`Refusing to seed: DEPLOY_ENV is "${deployEnv}", not "local".`);
  }

  const pool = new Pool({ connectionString: migrationDatabaseUrl(), max: 1 });
  const db = drizzle(pool);

  try {
    await db.transaction(async (tx) => {
      const orgId = await upsertOrg(tx);

      // Transaction-scoped, never a plain SET (§09). Harmless before the RLS policies land, and
      // required the moment they do — the migrator owns these tables and FORCE ROW LEVEL SECURITY
      // is what makes every policy apply to the owner as well.
      await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

      const userId = await upsertOwner(tx);

      await tx
        .insert(memberships)
        .values({ acceptedAt: sql`now()`, orgId, role: 'owner', userId })
        .onConflictDoNothing({ target: [memberships.orgId, memberships.userId] });

      const workspaceId = await upsertDefaultWorkspace(tx, orgId);

      const owners = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));

      if (owners[0]?.role !== 'owner') {
        throw new Error('Seed failed: the owner membership is missing or has the wrong role.');
      }

      console.info(
        [
          `Seeded org ${ORG_SLUG} (${orgId})`,
          `owner ${OWNER_EMAIL} (${userId}) as ${owners[0].role}`,
          `workspace ${WORKSPACE_NAME} (${workspaceId})`,
        ].join('\n  '),
      );
    });
  } finally {
    await pool.end();
  }
}

seed().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
