import { randomBytes, randomUUID } from 'node:crypto';

import { orgDataKeys, schema, secrets } from '@repo/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { openPool } from '../../../test/support/integration-database';
import type { ForgeDatabase, TenantTransaction } from '../../database/database.types';
import { TenantContext } from '../../database/tenant-context';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { plaintext, revealPlaintext } from './branded';
import { DekService, type SealedSecret } from './dek.service';
import { EnvKekProvider } from './env-kek.provider';
import { SecretDecryptionError } from './envelope';
import { DrizzleOrgDataKeyStore } from './org-data-key.store';

const APP_URL = process.env.DATABASE_URL ?? '';
const BYPASS_URL = process.env.DATABASE_URL_BYPASS_RLS ?? '';

/** Probed once per run by `test/global-setup.ts`, which also owns the CI-must-not-skip rule. */
const reachable = inject('postgresReachable');

const appPool = reachable ? openPool(APP_URL, 4) : undefined;

/** `forge_bypass` holds BYPASSRLS, so it sees what is really in the table, across every tenant. */
const bypassPool = reachable ? openPool(BYPASS_URL, 1) : undefined;

const SECRET = 'sk-ant-api03-3b7f9c2e1a4d6088';

let db: ForgeDatabase;
let runner: TenantTransactionRunner;
let store: DrizzleOrgDataKeyStore;

const createdOrgs: string[] = [];

function kek(): EnvKekProvider {
  return new EnvKekProvider(randomBytes(32).toString('base64'), 'local');
}

/** Fixture writes use raw SQL so setup never depends on the unit under test. */
async function createOrg(): Promise<string> {
  const id = randomUUID();

  await appPool!.query('insert into orgs (id, name, slug) values ($1, $2, $3)', [
    id,
    `crypto ${id}`,
    `crypto-${id}`,
  ]);
  createdOrgs.push(id);

  return id;
}

async function inTenant<T>(orgId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return runner.runInTenantTransaction(orgId, fn);
}

/** Reads `secrets` with BYPASSRLS, so the assertion counts what is in the table, not what a tenant sees. */
async function everySecretRow(
  orgIds: readonly string[],
): Promise<{ ciphertext: Buffer; id: string; orgId: string; updatedAt: string }[]> {
  const { rows } = await bypassPool!.query<{
    ciphertext: Buffer;
    id: string;
    orgId: string;
    updatedAt: string;
  }>(
    `select ciphertext, id, org_id as "orgId", updated_at::text as "updatedAt"
       from secrets where org_id = any($1::uuid[]) order by id`,
    [orgIds],
  );

  return rows;
}

beforeAll(() => {
  if (!reachable) {
    return;
  }

  db = drizzle(appPool!, { schema });
  runner = new TenantTransactionRunner(db, new TenantContext());
  store = new DrizzleOrgDataKeyStore();
});

afterAll(async () => {
  if (reachable && createdOrgs.length > 0) {
    // `orgs` is the tenant root and every table here cascades from it.
    await appPool!.query('delete from orgs where id = any($1::uuid[])', [createdOrgs]);
  }

  await Promise.all([appPool?.end(), bypassPool?.end()]);
});

describe.skipIf(!reachable)('DrizzleOrgDataKeyStore', () => {
  it('writes a key that reads back byte for byte', async () => {
    const orgId = await createOrg();
    const wrappedDek = randomBytes(61);

    const inserted = await inTenant(orgId, (tx) =>
      store.insertCurrent(tx, {
        alg: 'AES-256-GCM',
        kekId: 'env:aaaaaaaaaaaaaaaa',
        orgId,
        wrappedDek,
      }),
    );
    const read = await inTenant(orgId, (tx) => store.currentForOrg(tx, orgId));

    // `bytea`, not base64 in a text column: what went in is what comes out.
    expect(read!.wrappedDek.equals(wrappedDek)).toBe(true);
    expect(read!.id).toBe(inserted.id);
    expect(read!.kekId).toBe('env:aaaaaaaaaaaaaaaa');
  });

  it('answers with nothing for an organisation that has never written a secret', async () => {
    const orgId = await createOrg();

    expect(await inTenant(orgId, (tx) => store.currentForOrg(tx, orgId))).toBeUndefined();
  });

  /**
   * The §09 property at this table: the policy, not the predicate in our query, is what stops the
   * read. A store that forgot its `org_id` clause would still see nothing here.
   */
  it('cannot see another tenant key, even by id', async () => {
    const mine = await createOrg();
    const theirs = await createOrg();

    const key = await inTenant(theirs, (tx) =>
      store.insertCurrent(tx, {
        alg: 'AES-256-GCM',
        kekId: 'env:bbbbbbbbbbbbbbbb',
        orgId: theirs,
        wrappedDek: randomBytes(61),
      }),
    );

    expect(await inTenant(mine, (tx) => store.forOrgAndId(tx, theirs, key.id))).toBeUndefined();
    expect(await inTenant(mine, (tx) => store.currentForOrg(tx, mine))).toBeUndefined();
  });

  /**
   * The partial unique index turns the second insert into an adoption rather than a 23505. Two
   * first secret writes for one organisation really can arrive together, and the loser has to end
   * up on the winner's key — rolling back to retry would also roll back the secret it was writing.
   */
  it('adopts the existing key when the current-key index is already taken', async () => {
    const orgId = await createOrg();
    const draft = {
      alg: 'AES-256-GCM',
      kekId: 'env:cccccccccccccccc',
      orgId,
      wrappedDek: randomBytes(61),
    };

    const winner = await inTenant(orgId, (tx) => store.insertCurrent(tx, draft));
    const loser = await inTenant(orgId, (tx) =>
      store.insertCurrent(tx, {
        ...draft,
        kekId: 'env:dddddddddddddddd',
        wrappedDek: randomBytes(61),
      }),
    );

    expect(loser.id).toBe(winner.id);
    expect(loser.kekId).toBe('env:cccccccccccccccc');

    const { rows } = await bypassPool!.query<{ count: string }>(
      'select count(*) as count from org_data_keys where org_id = $1',
      [orgId],
    );

    expect(rows[0]!.count).toBe('1');
  });

  it('replaces the wrapping in place, keeping the id a secret row points at', async () => {
    const orgId = await createOrg();
    const key = await inTenant(orgId, (tx) =>
      store.insertCurrent(tx, {
        alg: 'AES-256-GCM',
        kekId: 'env:eeeeeeeeeeeeeeee',
        orgId,
        wrappedDek: randomBytes(61),
      }),
    );
    const rewrapped = randomBytes(61);

    await inTenant(orgId, (tx) =>
      store.replaceWrapping(tx, key.id, 'env:ffffffffffffffff', rewrapped),
    );
    const read = await inTenant(orgId, (tx) => store.currentForOrg(tx, orgId));

    expect(read!.id).toBe(key.id);
    expect(read!.kekId).toBe('env:ffffffffffffffff');
    expect(read!.wrappedDek.equals(rewrapped)).toBe(true);
  });

  /**
   * The loser of the race must not keep the key it generated, and must not overwrite the winner's
   * wrapping with it either — the winner's `wrapped_dek` is the one every secret written so far
   * was sealed against.
   */
  it('leaves the winner wrapping intact when the loser adopts it', async () => {
    const orgId = await createOrg();
    const winner = await inTenant(orgId, (tx) =>
      store.insertCurrent(tx, {
        alg: 'AES-256-GCM',
        kekId: 'env:1111111111111111',
        orgId,
        wrappedDek: randomBytes(61),
      }),
    );

    const loser = await inTenant(orgId, (tx) =>
      store.insertCurrent(tx, {
        alg: 'AES-256-GCM',
        kekId: 'env:2222222222222222',
        orgId,
        wrappedDek: randomBytes(61),
      }),
    );

    expect(loser.wrappedDek.equals(winner.wrappedDek)).toBe(true);
    expect(loser.kekId).toBe(winner.kekId);
  });

  /** A secret names its key by id, and after a data-key rotation that key is no longer the current one. */
  it('finds a retired key by id', async () => {
    const orgId = await createOrg();
    const key = await inTenant(orgId, (tx) =>
      store.insertCurrent(tx, {
        alg: 'AES-256-GCM',
        kekId: 'env:0123456789abcdef',
        orgId,
        wrappedDek: randomBytes(61),
      }),
    );

    await inTenant(orgId, (tx) =>
      tx.update(orgDataKeys).set({ rotatedAt: new Date() }).where(eq(orgDataKeys.id, key.id)),
    );

    expect(await inTenant(orgId, (tx) => store.currentForOrg(tx, orgId))).toBeUndefined();
    expect((await inTenant(orgId, (tx) => store.forOrgAndId(tx, orgId, key.id)))!.id).toBe(key.id);
  });
});

describe.skipIf(!reachable)('a secret through the whole envelope, against real rows', () => {
  async function writeSecret(
    dek: DekService,
    orgId: string,
    purpose: string,
  ): Promise<SealedSecret & { id: string }> {
    return inTenant(orgId, async (tx) => {
      const sealed = await dek.sealSecret(tx, orgId, purpose, plaintext(SECRET));
      const [row] = await tx
        .insert(secrets)
        .values({ ...sealed, orgId, purpose })
        .returning({ id: secrets.id });

      return { ...sealed, id: row!.id };
    });
  }

  it('round-trips through the database', async () => {
    const dek = new DekService(store, kek());
    const orgId = await createOrg();
    const written = await writeSecret(dek, orgId, 'anthropic_api_key');

    const opened = await inTenant(orgId, async (tx) => {
      const [row] = await tx
        .select({ ciphertext: secrets.ciphertext, dekId: secrets.dekId, purpose: secrets.purpose })
        .from(secrets)
        .where(eq(secrets.id, written.id));

      return dek.openSecret(tx, orgId, row!.purpose, row!);
    });

    expect(revealPlaintext(opened).toString('utf8')).toBe(SECRET);
  });

  /**
   * §05's headline property, performed rather than argued: the exact `ciphertext` bytes of one
   * tenant's row are copied into a row this tenant owns — same table, valid foreign keys, the
   * tenant's own data key — and the read fails.
   */
  it('refuses a ciphertext lifted into another tenant row', async () => {
    const dek = new DekService(store, kek());
    const victim = await createOrg();
    const attacker = await createOrg();

    const stolen = await writeSecret(dek, victim, 'anthropic_api_key');
    const mine = await inTenant(attacker, (tx) => dek.ensureDek(tx, attacker));

    const relocated = await inTenant(attacker, async (tx) => {
      const [row] = await tx
        .insert(secrets)
        .values({
          alg: stolen.alg,
          ciphertext: stolen.ciphertext,
          dekId: mine.dekId,
          fingerprint: stolen.fingerprint,
          orgId: attacker,
          purpose: 'anthropic_api_key',
        })
        .returning({ ciphertext: secrets.ciphertext, dekId: secrets.dekId });

      return row!;
    });

    // The row exists, and holds the victim's bytes exactly.
    expect(relocated.ciphertext.equals(stolen.ciphertext)).toBe(true);

    await expect(
      inTenant(attacker, (tx) => dek.openSecret(tx, attacker, 'anthropic_api_key', relocated)),
    ).rejects.toThrow(SecretDecryptionError);
  });

  it('refuses the same row read back under another purpose', async () => {
    const dek = new DekService(store, kek());
    const orgId = await createOrg();
    const written = await writeSecret(dek, orgId, 'anthropic_api_key');

    await expect(
      inTenant(orgId, (tx) => dek.openSecret(tx, orgId, 'openai_api_key', written)),
    ).rejects.toThrow(SecretDecryptionError);
  });
});

/**
 * §05: "Rotating the KEK rewraps DEKs only, an O(number of orgs) operation rather than O(number of
 * secrets)." Three organisations, four secrets each — twelve ciphertexts that a rotation must not
 * read, rewrite or invalidate.
 */
describe.skipIf(!reachable)('rotating the KEK', () => {
  const PURPOSES = ['anthropic_api_key', 'openai_api_key', 'byos_credential_set', 'mfa_seed'];

  it('rewraps one row per organisation and leaves every secret untouched', async () => {
    const retiring = kek();
    const before = new DekService(store, retiring);
    const orgIds = [await createOrg(), await createOrg(), await createOrg()];

    for (const orgId of orgIds) {
      await inTenant(orgId, async (tx) => {
        for (const purpose of PURPOSES) {
          const sealed = await before.sealSecret(tx, orgId, purpose, plaintext(SECRET));

          await tx.insert(secrets).values({ ...sealed, orgId, purpose });
        }
      });
    }

    const secretsBefore = await everySecretRow(orgIds);
    const wrapsBefore = await wrappedKeys(orgIds);

    expect(secretsBefore).toHaveLength(orgIds.length * PURPOSES.length);

    const incoming = kek();
    const after = new DekService(store, incoming);
    const outcomes = [];

    for (const orgId of orgIds) {
      outcomes.push(await inTenant(orgId, (tx) => after.rewrapDataKey(tx, orgId, retiring)));
    }

    // One rewrap per organisation, and nothing skipped.
    expect(outcomes.map((outcome) => outcome.rewrapped)).toEqual([true, true, true]);
    expect(new Set(outcomes.map((outcome) => outcome.to))).toEqual(new Set([incoming.kekId]));

    const wrapsAfter = await wrappedKeys(orgIds);

    // Every data key now sits under the incoming KEK, wrapped differently…
    expect(wrapsAfter.map((row) => row.kekId)).toEqual(orgIds.map(() => incoming.kekId));
    expect(wrapsBefore.map((row) => row.wrappedDek.toString('hex'))).not.toEqual(
      wrapsAfter.map((row) => row.wrappedDek.toString('hex')),
    );
    // …under the same row ids, so no `secrets.dek_id` had to move.
    expect(wrapsAfter.map((row) => row.id)).toEqual(wrapsBefore.map((row) => row.id));

    // The cost claim, measured against the table: not one ciphertext byte and not one `updated_at`
    // changed. A rotation that were O(secrets) could not leave this untouched.
    expect(await everySecretRow(orgIds)).toEqual(secretsBefore);

    // And every one of them still opens, under the new KEK, without having been re-encrypted.
    for (const orgId of orgIds) {
      await inTenant(orgId, async (tx) => {
        const rows = await tx
          .select({
            ciphertext: secrets.ciphertext,
            dekId: secrets.dekId,
            purpose: secrets.purpose,
          })
          .from(secrets)
          .where(eq(secrets.orgId, orgId));

        expect(rows).toHaveLength(PURPOSES.length);

        for (const row of rows) {
          const opened = await after.openSecret(tx, orgId, row.purpose, row);

          expect(revealPlaintext(opened).toString('utf8')).toBe(SECRET);
        }
      });
    }

    // Re-running the rotation is a no-op, which is what makes it safe to resume after a failure.
    for (const orgId of orgIds) {
      const outcome = await inTenant(orgId, (tx) => after.rewrapDataKey(tx, orgId, retiring));

      expect(outcome.rewrapped).toBe(false);
    }

    expect(await everySecretRow(orgIds)).toEqual(secretsBefore);
  });

  async function wrappedKeys(
    orgIds: readonly string[],
  ): Promise<{ id: string; kekId: string; wrappedDek: Buffer }[]> {
    const rows = await Promise.all(
      orgIds.map(async (orgId) => (await inTenant(orgId, (tx) => store.currentForOrg(tx, orgId)))!),
    );

    return rows.map((row) => ({ id: row.id, kekId: row.kekId, wrappedDek: row.wrappedDek }));
  }
});
