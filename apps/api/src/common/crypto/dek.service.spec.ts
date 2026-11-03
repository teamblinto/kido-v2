import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { TenantTransaction } from '../../database/database.types';
import { fingerprint, plaintext, revealDataEncryptionKey, revealPlaintext } from './branded';
import { DekService, MissingDataKeyError } from './dek.service';
import { EnvKekProvider } from './env-kek.provider';
import { SECRET_ALG, SecretDecryptionError } from './envelope';
import type { KekProvider } from './kek-provider.port';
import type { OrgDataKeyDraft, OrgDataKeyStore, StoredOrgDataKey } from './org-data-key.store';

const ORG = '9f1c4d2e-6b8a-4f70-9c3d-1e5a7b2c8d40';
const OTHER_ORG = 'c2a7f019-4d3b-4a62-8e15-73b904ca6f88';
const SECRET = 'sk-ant-api03-3b7f9c2e1a4d6088';

/** The transaction is opaque to this module; it exists to be handed straight through to the store. */
const TX = {} as TenantTransaction;

function kek(): EnvKekProvider {
  return new EnvKekProvider(randomBytes(32).toString('base64'), 'local');
}

/**
 * An in-memory `OrgDataKeyStore`. A real implementation of the port rather than a mock: the service
 * is asserted through what the store ends up holding, not through which methods were called.
 *
 * `calls` exists for exactly one assertion — that a rotation is O(orgs) — where the *number* of
 * store operations is the property under test.
 */
class FakeStore implements OrgDataKeyStore {
  readonly calls: string[] = [];
  readonly rows = new Map<string, StoredOrgDataKey>();
  readonly transactions: TenantTransaction[] = [];

  currentForOrg(tx: TenantTransaction, orgId: string): Promise<StoredOrgDataKey | undefined> {
    this.record(tx, 'currentForOrg');

    return Promise.resolve([...this.rows.values()].find((row) => row.orgId === orgId));
  }

  forOrgAndId(
    tx: TenantTransaction,
    orgId: string,
    id: string,
  ): Promise<StoredOrgDataKey | undefined> {
    this.record(tx, 'forOrgAndId');
    const row = this.rows.get(id);

    return Promise.resolve(row?.orgId === orgId ? row : undefined);
  }

  insertCurrent(tx: TenantTransaction, row: OrgDataKeyDraft): Promise<StoredOrgDataKey> {
    this.record(tx, 'insertCurrent');

    // The partial unique index makes this an adoption when a concurrent writer got there first.
    const existing = [...this.rows.values()].find((candidate) => candidate.orgId === row.orgId);

    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    const stored: StoredOrgDataKey = { ...row, id: randomUUID() };

    this.rows.set(stored.id, stored);

    return Promise.resolve(stored);
  }

  replaceWrapping(
    tx: TenantTransaction,
    id: string,
    kekId: string,
    wrappedDek: Buffer,
  ): Promise<void> {
    this.record(tx, 'replaceWrapping');
    const row = this.rows.get(id)!;

    this.rows.set(id, { ...row, kekId, wrappedDek });

    return Promise.resolve();
  }

  private record(tx: TenantTransaction, call: string): void {
    this.calls.push(call);
    this.transactions.push(tx);
  }
}

function service(store: OrgDataKeyStore = new FakeStore(), provider: KekProvider = kek()) {
  return { kek: provider, service: new DekService(store, provider), store };
}

describe('DekService.ensureDek', () => {
  it('generates a data key on the first secret write', async () => {
    const { service: dek, store } = service();

    await dek.ensureDek(TX, ORG);

    expect((store as FakeStore).rows.size).toBe(1);
  });

  it('stores the key wrapped, never in the clear', async () => {
    const { service: dek, store } = service();
    const created = await dek.ensureDek(TX, ORG);
    const [row] = [...(store as FakeStore).rows.values()];

    expect(row!.wrappedDek.toString('hex')).not.toContain(
      revealDataEncryptionKey(created.dek).toString('hex'),
    );
  });

  it('records the KEK that produced the wrap, so a rotation knows where to start', async () => {
    const { kek: provider, service: dek, store } = service();

    await dek.ensureDek(TX, ORG);

    expect([...(store as FakeStore).rows.values()][0]!.kekId).toBe(provider.kekId);
  });

  it('records the algorithm the key is used with', async () => {
    const { service: dek, store } = service();

    await dek.ensureDek(TX, ORG);

    expect([...(store as FakeStore).rows.values()][0]!.alg).toBe(SECRET_ALG);
  });

  it('reuses the key on every write after the first', async () => {
    const { service: dek, store } = service();
    const first = await dek.ensureDek(TX, ORG);
    const second = await dek.ensureDek(TX, ORG);

    expect(second.dekId).toBe(first.dekId);
    expect(revealDataEncryptionKey(second.dek)).toEqual(revealDataEncryptionKey(first.dek));
    expect((store as FakeStore).rows.size).toBe(1);
  });

  it('gives each organisation its own key', async () => {
    const { service: dek } = service();
    const mine = await dek.ensureDek(TX, ORG);
    const theirs = await dek.ensureDek(TX, OTHER_ORG);

    expect(revealDataEncryptionKey(mine.dek)).not.toEqual(revealDataEncryptionKey(theirs.dek));
  });

  /**
   * Two first writes can race: the partial unique index on `org_data_keys` lets exactly one insert
   * win, and the loser must adopt the winner's key rather than fail or, far worse, carry on with a
   * key it generated and never stored.
   */
  it('adopts the winner of a concurrent first write', async () => {
    const { service: dek } = service();
    const [first, second] = await Promise.all([dek.ensureDek(TX, ORG), dek.ensureDek(TX, ORG)]);

    expect(second.dekId).toBe(first.dekId);
    expect(revealDataEncryptionKey(second.dek)).toEqual(revealDataEncryptionKey(first.dek));
  });

  it('hands the caller transaction to the store rather than opening its own', async () => {
    const tx = {} as TenantTransaction;
    const { service: dek, store } = service();

    await dek.ensureDek(tx, ORG);

    expect((store as FakeStore).transactions.every((seen) => seen === tx)).toBe(true);
  });
});

describe('DekService.currentDek', () => {
  it('returns the key an earlier write created', async () => {
    const { service: dek } = service();
    const created = await dek.ensureDek(TX, ORG);

    expect(revealDataEncryptionKey((await dek.currentDek(TX, ORG)).dek)).toEqual(
      revealDataEncryptionKey(created.dek),
    );
  });

  /** A read must never create one: a decrypt against a fresh key would fail confusingly instead. */
  it('refuses when the organisation has never written a secret', async () => {
    const { service: dek, store } = service();

    await expect(dek.currentDek(TX, ORG)).rejects.toThrow(MissingDataKeyError);
    expect((store as FakeStore).rows.size).toBe(0);
  });

  it('does not see another organisation key', async () => {
    const { service: dek } = service();

    await dek.ensureDek(TX, OTHER_ORG);

    await expect(dek.currentDek(TX, ORG)).rejects.toThrow(MissingDataKeyError);
  });
});

describe('DekService.sealSecret', () => {
  it('produces everything a secrets row needs and nothing it does not', async () => {
    const { service: dek } = service();
    const sealed = await dek.sealSecret(TX, ORG, 'anthropic_api_key', plaintext(SECRET));

    expect(Object.keys(sealed).sort()).toEqual(['alg', 'ciphertext', 'dekId', 'fingerprint']);
    expect(sealed.alg).toBe(SECRET_ALG);
    expect(sealed.fingerprint).toBe(fingerprint(plaintext(SECRET)));
  });

  it('generates the data key on that first write', async () => {
    const { service: dek, store } = service();

    await dek.sealSecret(TX, ORG, 'anthropic_api_key', plaintext(SECRET));

    expect((store as FakeStore).rows.size).toBe(1);
  });

  it('does not leave the secret anywhere in the row it returns', async () => {
    const { service: dek } = service();
    const sealed = await dek.sealSecret(TX, ORG, 'anthropic_api_key', plaintext(SECRET));

    expect(sealed.ciphertext.toString('utf8')).not.toContain(SECRET);
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
  });
});

describe('DekService.openSecret', () => {
  it('returns the secret that was sealed', async () => {
    const { service: dek } = service();
    const sealed = await dek.sealSecret(TX, ORG, 'anthropic_api_key', plaintext(SECRET));

    const opened = await dek.openSecret(TX, ORG, 'anthropic_api_key', sealed);

    expect(revealPlaintext(opened).toString('utf8')).toBe(SECRET);
  });

  /**
   * The end-to-end statement of the §05 property, through the service the application will actually
   * call rather than through `envelope.ts` directly.
   */
  it('refuses a ciphertext relocated into another organisation', async () => {
    const { service: dek } = service();
    const sealed = await dek.sealSecret(TX, ORG, 'anthropic_api_key', plaintext(SECRET));
    const theirs = await dek.ensureDek(TX, OTHER_ORG);

    await expect(
      dek.openSecret(TX, OTHER_ORG, 'anthropic_api_key', {
        ciphertext: sealed.ciphertext,
        dekId: theirs.dekId,
      }),
    ).rejects.toThrow(SecretDecryptionError);
  });

  it('refuses a ciphertext read back under another purpose', async () => {
    const { service: dek } = service();
    const sealed = await dek.sealSecret(TX, ORG, 'anthropic_api_key', plaintext(SECRET));

    await expect(dek.openSecret(TX, ORG, 'openai_api_key', sealed)).rejects.toThrow(
      SecretDecryptionError,
    );
  });

  /**
   * `secrets.dek_id` is resolved rather than assumed to be the current key, so a row written before
   * a data-key rotation still opens afterwards.
   */
  it('opens under the key the row names, not whichever key is current', async () => {
    const { service: dek, store } = service();
    const sealed = await dek.sealSecret(TX, ORG, 'anthropic_api_key', plaintext(SECRET));

    expect((store as FakeStore).calls).toContain('insertCurrent');

    const opened = await dek.openSecret(TX, ORG, 'anthropic_api_key', sealed);

    expect(revealPlaintext(opened).toString('utf8')).toBe(SECRET);
    expect((store as FakeStore).calls).toContain('forOrgAndId');
  });

  it('refuses when the row names a data key this organisation does not own', async () => {
    const { service: dek } = service();
    const sealed = await dek.sealSecret(TX, ORG, 'anthropic_api_key', plaintext(SECRET));

    await expect(
      dek.openSecret(TX, OTHER_ORG, 'anthropic_api_key', {
        ciphertext: sealed.ciphertext,
        dekId: sealed.dekId,
      }),
    ).rejects.toThrow(MissingDataKeyError);
  });
});

/**
 * §05: "Rotating the KEK rewraps DEKs only, an O(number of orgs) operation rather than O(number of
 * secrets)." The store port is the structural half of that proof — it cannot reach `secrets` at all
 * — and these are the behavioural half.
 */
describe('DekService.rewrapDataKey', () => {
  /**
   * `purposes` seals more secrets *before* the rotation, through the service holding the retiring
   * KEK — which is the only one that can read the row at that point. It is what the cost assertion
   * varies.
   */
  async function rotated(purposes: readonly string[] = []) {
    const retiring = kek();
    const store = new FakeStore();
    const before = new DekService(store, retiring);

    await before.ensureDek(TX, ORG);
    const sealed = await before.sealSecret(TX, ORG, 'anthropic_api_key', plaintext(SECRET));

    for (const purpose of purposes) {
      await before.sealSecret(TX, ORG, purpose, plaintext(SECRET));
    }

    const incoming = kek();
    const after = new DekService(store, incoming);

    return { after, incoming, retiring, sealed, store };
  }

  it('rewraps the data key under the incoming KEK', async () => {
    const { after, incoming, retiring } = await rotated();
    const outcome = await after.rewrapDataKey(TX, ORG, retiring);

    expect(outcome.rewrapped).toBe(true);
    expect(outcome.from).toBe(retiring.kekId);
    expect(outcome.to).toBe(incoming.kekId);
  });

  it('leaves the data key itself unchanged, so every existing ciphertext still opens', async () => {
    const { after, retiring, sealed } = await rotated();

    await after.rewrapDataKey(TX, ORG, retiring);

    expect(
      revealPlaintext(await after.openSecret(TX, ORG, 'anthropic_api_key', sealed)).toString(
        'utf8',
      ),
    ).toBe(SECRET);
  });

  it('writes the incoming KEK id onto the row', async () => {
    const { after, incoming, retiring, store } = await rotated();

    await after.rewrapDataKey(TX, ORG, retiring);

    expect([...store.rows.values()][0]!.kekId).toBe(incoming.kekId);
  });

  it('replaces the wrapped bytes', async () => {
    const { after, retiring, store } = await rotated();
    const before = [...store.rows.values()][0]!.wrappedDek.toString('hex');

    await after.rewrapDataKey(TX, ORG, retiring);

    expect([...store.rows.values()][0]!.wrappedDek.toString('hex')).not.toBe(before);
  });

  /**
   * The cost claim, measured. One organisation costs one read and one write however many secrets it
   * owns — so the whole rotation is O(orgs). A rotation that touched ciphertexts would have to read
   * them, and this store cannot.
   */
  it('costs one read and one write per organisation, whatever the secret count', async () => {
    const { after, retiring, store } = await rotated([
      'openai_api_key',
      'byos_credential_set',
      'connector_credential',
    ]);

    store.calls.length = 0;
    await after.rewrapDataKey(TX, ORG, retiring);

    expect(store.calls).toEqual(['currentForOrg', 'replaceWrapping']);
  });

  /** Rotations are re-run after a partial failure, so reaching an already-rotated org is normal. */
  it('is idempotent: a second pass over the same organisation does nothing', async () => {
    const { after, retiring, store } = await rotated();

    await after.rewrapDataKey(TX, ORG, retiring);
    store.calls.length = 0;

    const outcome = await after.rewrapDataKey(TX, ORG, retiring);

    expect(outcome.rewrapped).toBe(false);
    expect(store.calls).toEqual(['currentForOrg']);
  });

  it('refuses an organisation that has no data key to rewrap', async () => {
    const { service: dek } = service();

    await expect(dek.rewrapDataKey(TX, ORG, kek())).rejects.toThrow(MissingDataKeyError);
  });
});

describe('MissingDataKeyError', () => {
  it('names the organisation, which is not a secret, and nothing else', async () => {
    const { service: dek } = service();
    let caught: unknown;

    try {
      await dek.currentDek(TX, ORG);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MissingDataKeyError);
    expect((caught as Error).message).toContain(ORG);
  });
});
