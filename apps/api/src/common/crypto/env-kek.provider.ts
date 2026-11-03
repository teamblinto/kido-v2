import { createHash } from 'node:crypto';

import type { Environment } from '../../config/environment';
import {
  type DataEncryptionKey,
  dataEncryptionKey,
  plaintext,
  revealDataEncryptionKey,
  revealPlaintext,
} from './branded';
import { open, seal } from './envelope';
import {
  KEK_WRAP_PURPOSE,
  type KekBinding,
  type KekProvider,
  KekUnwrapError,
  UnknownKekError,
  type WrappedDek,
} from './kek-provider.port';

/**
 * Domain-separates the id from any other hash of the same bytes, so a `kek_id` in our database
 * cannot be matched against a digest of the same key computed by anything else.
 */
const KEK_ID_DOMAIN = 'forge.kek.id.v1';

/** 64 bits. Enough to tell two master keys apart, far too few to attack a 256-bit key through. */
const KEK_ID_HEX_CHARS = 16;

export class EnvKekRefusedError extends Error {
  constructor(deployEnv: string) {
    // The variable and its value, never the key: this message is a boot log line.
    super(
      `The env KEK provider holds the master key in plaintext and is local-only, but DEPLOY_ENV is ${JSON.stringify(deployEnv)}. Set KEK_PROVIDER=openbao on a real deployment (ADR 003, ADR 009).`,
    );
    this.name = 'EnvKekRefusedError';
  }
}

/**
 * The development key-encryption key: a 32-byte master key read from `KEK_ENV_MASTER_KEY`.
 *
 * It exists so the envelope primitive can be built, tested and run locally without deploying
 * OpenBao — which spec 001 puts out of scope — and it is the reason `KekProvider` is a port at all
 * (ADR 003).
 *
 * ## Why the constructor refuses
 *
 * §11 forbids this provider in production, and the environment schema already rejects
 * `KEK_PROVIDER=env` on a real deployment. This check is the second one, deliberately: the schema
 * guards the configured path, and a provider constructed directly — by a test helper, a script, a
 * future module that builds one by hand — reaches none of it. A master key in a process
 * environment is exactly the thing that must not be one refactor away from production, so the
 * object refuses to exist rather than trusting its caller to have been configured correctly.
 *
 * It keys on `DEPLOY_ENV`, not `NODE_ENV` (ADR 009). The local compose stack runs a production
 * *build* — `pnpm deploy --prod`, no `pino-pretty` in the runner image — and must still boot;
 * a staging deployment that never configured OpenBao must not.
 */
export class EnvKekProvider implements KekProvider {
  readonly kekId: string;

  private readonly masterKey: DataEncryptionKey;

  constructor(masterKeyBase64: string, deployEnv: Environment['DEPLOY_ENV']) {
    if (deployEnv !== 'local') {
      throw new EnvKekRefusedError(deployEnv);
    }

    // Throws `InvalidDataEncryptionKeyError` on anything that is not 32 bytes — including base64
    // that decodes to nothing, which is what a truncated or quoted value in a `.env` produces.
    this.masterKey = dataEncryptionKey(Buffer.from(masterKeyBase64, 'base64'));
    this.kekId = `env:${createHash('sha256')
      .update(KEK_ID_DOMAIN)
      .update(revealDataEncryptionKey(this.masterKey))
      .digest('hex')
      .slice(0, KEK_ID_HEX_CHARS)}`;
  }

  /**
   * Settled immediately, and deliberately not written as an `async` method.
   *
   * The port is asynchronous because the adapter that matters is a network call. This one is local,
   * so there is nothing to await — but a refusal still has to arrive as a *rejected promise* rather
   * than a synchronous throw, or a caller that only catches rejections would see this adapter and
   * the OpenBao one behave differently.
   */
  unwrap(wrapped: WrappedDek, binding: KekBinding): Promise<DataEncryptionKey> {
    // Before the decrypt, so "wrapped under the retired key" is reported as itself rather than as
    // an authentication failure a rotation would have to interpret.
    if (wrapped.kekId !== this.kekId) {
      return Promise.reject(new UnknownKekError(wrapped.kekId));
    }

    try {
      return Promise.resolve(
        dataEncryptionKey(
          revealPlaintext(
            open(this.masterKey, wrapped.ciphertext, {
              orgId: binding.orgId,
              purpose: KEK_WRAP_PURPOSE,
            }),
          ),
        ),
      );
    } catch {
      // `SecretDecryptionError` already says nothing; re-stated as the KEK layer's own failure so a
      // caller can tell which of the two envelopes refused it.
      return Promise.reject(new KekUnwrapError());
    }
  }

  wrap(dek: DataEncryptionKey, binding: KekBinding): Promise<WrappedDek> {
    return Promise.resolve({
      ciphertext: seal(this.masterKey, plaintext(revealDataEncryptionKey(dek)), {
        orgId: binding.orgId,
        purpose: KEK_WRAP_PURPOSE,
      }),
      kekId: this.kekId,
    });
  }
}
