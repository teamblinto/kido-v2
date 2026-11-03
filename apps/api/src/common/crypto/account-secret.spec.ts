import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AccountSecretService, accountRealm } from './account-secret';
import { plaintext, revealPlaintext } from './branded';
import { SecretDecryptionError } from './envelope';
import { EnvKekProvider } from './env-kek.provider';
import { KekUnwrapError, UnknownKekError } from './kek-provider.port';

const MFA_SEED = 'mfa_seed';

function providerFor(masterKey: Buffer = randomBytes(32)): EnvKekProvider {
  return new EnvKekProvider(masterKey.toString('base64'), 'local');
}

function serviceFor(kek: EnvKekProvider = providerFor()): AccountSecretService {
  return new AccountSecretService(kek);
}

/**
 * Corrupt one byte in place, refusing an offset that is not in the buffer.
 *
 * The guard is the point rather than ceremony for the type checker: an offset past the end would
 * leave the ciphertext untouched, and the test would then pass because a *pristine* value failed to
 * open — which is the one way these assertions could go green while proving nothing.
 */
function flipByteAt(buffer: Buffer, index: number): void {
  const byte = buffer[index];

  if (byte === undefined) {
    expect.unreachable(`offset ${index} is outside a ${buffer.length}-byte ciphertext`);
  }

  buffer[index] = byte ^ 0xff;
}

describe('accountRealm', () => {
  /**
   * The AAD subject is namespaced rather than the bare user id, because the envelope's binding
   * field is the same one an organisation's secrets are bound to. A user id and an organisation id
   * are both uuids, so without the prefix a `secrets` row and an MFA seed could — given the same
   * uuid in both tables — share a binding, and the AAD would stop being the thing that keeps them
   * apart.
   */
  it('namespaces the account so it cannot collide with an organisation', () => {
    const id = randomUUID();

    expect(accountRealm(id)).toBe(`user:${id}`);
  });
});

describe('AccountSecretService', () => {
  const userId = randomUUID();

  it('opens what it sealed', async () => {
    const service = serviceFor();
    const sealed = await service.seal({ purpose: MFA_SEED, userId }, plaintext('JBSWY3DPEHPK3PXP'));

    const opened = await service.open({ purpose: MFA_SEED, userId }, sealed);

    expect(revealPlaintext(opened).toString('utf8')).toBe('JBSWY3DPEHPK3PXP');
  });

  /**
   * The whole reason the seed is sealed rather than encoded. The column is a database disclosure
   * away from an attacker's hands, and what they must not find in it is the seed.
   */
  it('leaves nothing recognisable in the ciphertext', async () => {
    const sealed = await serviceFor().seal(
      { purpose: MFA_SEED, userId },
      plaintext('JBSWY3DPEHPK3PXP'),
    );

    expect(sealed.toString('utf8')).not.toContain('JBSWY3DPEHPK3PXP');
    expect(sealed.toString('base64')).not.toContain('JBSWY3DPEHPK3PXP');
  });

  /** A fresh data key per secret, so two accounts' seeds share no key and no IV stream. */
  it('produces different bytes for the same secret twice', async () => {
    const service = serviceFor();
    const first = await service.seal({ purpose: MFA_SEED, userId }, plaintext('JBSWY3DPEHPK3PXP'));
    const second = await service.seal({ purpose: MFA_SEED, userId }, plaintext('JBSWY3DPEHPK3PXP'));

    expect(first.equals(second)).toBe(false);
  });

  /**
   * The property the AAD exists for, at the account level: a `mfa_secret_enc` value copied onto
   * another user's row does not decrypt. Without it, "take over an account" would be one `update`
   * statement — and an attacker who can write one row can usually write two.
   *
   * It fails at the KEK rather than at the body, because the realm is bound into *both* layers and
   * the wrap is opened first. That is the stronger of the two orders: the relocated row is refused
   * before its data key is ever reconstructed, so no part of the seal is attempted under a key an
   * attacker chose the binding for.
   */
  it('refuses a ciphertext moved onto another account', async () => {
    const service = serviceFor();
    const sealed = await service.seal({ purpose: MFA_SEED, userId }, plaintext('JBSWY3DPEHPK3PXP'));

    await expect(service.open({ purpose: MFA_SEED, userId: randomUUID() }, sealed)).rejects.toThrow(
      KekUnwrapError,
    );
  });

  /** The other half of the binding: a seed re-labelled as some other kind of secret is a forgery. */
  it('refuses a ciphertext read back under another purpose', async () => {
    const service = serviceFor();
    const sealed = await service.seal({ purpose: MFA_SEED, userId }, plaintext('JBSWY3DPEHPK3PXP'));

    await expect(service.open({ purpose: 'byok_credential', userId }, sealed)).rejects.toThrow(
      SecretDecryptionError,
    );
  });

  it('refuses a ciphertext whose body was altered', async () => {
    const service = serviceFor();
    const sealed = await service.seal({ purpose: MFA_SEED, userId }, plaintext('JBSWY3DPEHPK3PXP'));

    flipByteAt(sealed, sealed.length - 1);

    await expect(service.open({ purpose: MFA_SEED, userId }, sealed)).rejects.toThrow(
      SecretDecryptionError,
    );
  });

  /**
   * The wrapped data key travels inside the same column, so it is as forgeable as the body and has
   * to be as authenticated. Flipping a byte of it must fail at the KEK rather than produce a key
   * that opens something.
   */
  it('refuses a ciphertext whose wrapped data key was altered', async () => {
    const service = serviceFor();
    const sealed = await service.seal({ purpose: MFA_SEED, userId }, plaintext('JBSWY3DPEHPK3PXP'));

    // Past the version byte and the kek id, inside the wrap. Located by decoding the header the
    // same way the reader does rather than by a magic offset, so the test does not silently start
    // flipping a different field when the layout changes.
    const kekIdLength = sealed.readUInt16BE(1);

    flipByteAt(sealed, 1 + 2 + kekIdLength + 2);

    await expect(service.open({ purpose: MFA_SEED, userId }, sealed)).rejects.toThrow(
      KekUnwrapError,
    );
  });

  /**
   * A column truncated by a bad migration, a short write or a `substring` in a repair script. The
   * reader must refuse it rather than slicing a plausible-looking header out of whatever is there.
   */
  it('refuses a truncated ciphertext rather than reading past its end', async () => {
    const service = serviceFor();
    const sealed = await service.seal({ purpose: MFA_SEED, userId }, plaintext('JBSWY3DPEHPK3PXP'));

    for (const length of [0, 1, 3, Math.floor(sealed.length / 2), sealed.length - 1]) {
      await expect(
        service.open({ purpose: MFA_SEED, userId }, sealed.subarray(0, length)),
      ).rejects.toThrow();
    }
  });

  it('refuses a ciphertext claiming a layout version it does not know', async () => {
    const service = serviceFor();
    const sealed = await service.seal({ purpose: MFA_SEED, userId }, plaintext('JBSWY3DPEHPK3PXP'));

    sealed[0] = 0x7f;

    await expect(service.open({ purpose: MFA_SEED, userId }, sealed)).rejects.toThrow(
      SecretDecryptionError,
    );
  });

  /**
   * The kek id travels with the bytes for the same reason `org_data_keys.kek_id` does: a process
   * holding the new master key has to be able to tell "wrapped under the retired one" from
   * "corrupt", because only one of those is an operational fact somebody can act on.
   */
  it('reports a wrap made under a master key this process does not hold', async () => {
    const sealed = await serviceFor(providerFor()).seal(
      { purpose: MFA_SEED, userId },
      plaintext('JBSWY3DPEHPK3PXP'),
    );

    await expect(
      serviceFor(providerFor()).open({ purpose: MFA_SEED, userId }, sealed),
    ).rejects.toThrow(UnknownKekError);
  });
});
