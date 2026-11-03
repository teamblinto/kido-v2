import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment';
import { AccountSecretService } from './account-secret';
import { DekService } from './dek.service';
import { EnvKekProvider } from './env-kek.provider';
import { KEK_PROVIDER, type KekProvider } from './kek-provider.port';
import { OpenBaoKekProvider } from './openbao-kek.provider';
import { DrizzleOrgDataKeyStore, ORG_DATA_KEY_STORE } from './org-data-key.store';

export class MissingKekConfigurationError extends Error {
  constructor(variable: keyof Environment, provider: string) {
    // The variable's name, never its value: this is a boot log line.
    super(`${variable} is required when KEK_PROVIDER is ${JSON.stringify(provider)}.`);
    this.name = 'MissingKekConfigurationError';
  }
}

/**
 * Chooses the adapter §11 allows for this deployment.
 *
 * The environment schema already enforces both of these rules — `KEK_PROVIDER=env` is rejected off
 * `local`, and each provider's variables are required when it is selected. They are enforced again
 * here for the reason `EnvKekProvider`'s constructor gives: the schema guards the configured path,
 * and a container built by a test, a script or a future module reaches none of it. Neither check is
 * the other's fallback.
 */
export function kekProviderFor(config: ConfigService<Environment, true>): KekProvider {
  const provider = config.get('KEK_PROVIDER', { infer: true });

  if (provider === 'openbao') {
    const addr = config.get('OPENBAO_ADDR', { infer: true });
    const token = config.get('OPENBAO_TOKEN', { infer: true });

    if (addr === undefined) {
      throw new MissingKekConfigurationError('OPENBAO_ADDR', provider);
    }

    if (token === undefined) {
      throw new MissingKekConfigurationError('OPENBAO_TOKEN', provider);
    }

    return new OpenBaoKekProvider({
      addr,
      keyName: config.get('OPENBAO_KEY_NAME', { infer: true }),
      token,
    });
  }

  const masterKey = config.get('KEK_ENV_MASTER_KEY', { infer: true });

  if (masterKey === undefined) {
    throw new MissingKekConfigurationError('KEK_ENV_MASTER_KEY', provider);
  }

  // Refuses to construct off `local` (ADR 009), which is what makes this a boot failure rather than
  // a runtime one — the container cannot finish building.
  return new EnvKekProvider(masterKey, config.get('DEPLOY_ENV', { infer: true }));
}

/**
 * Envelope encryption for tenant secrets (§05, ADR 003).
 *
 * `@Global` for the reason `ClockModule` gives. BYOK keys, BYOS credential sets, connector
 * credentials and MFA seeds all seal through this, and a module that forgets the import fails at
 * injection rather than falling back to something weaker — but the list of importers is long enough
 * that restating it everywhere buys nothing.
 *
 * The KEK provider is bound once, at boot. That is deliberate: choosing it per call would make the
 * refusal in `EnvKekProvider`'s constructor a per-request error rather than a deployment that does
 * not start.
 */
@Global()
@Module({
  exports: [AccountSecretService, DekService, KEK_PROVIDER, ORG_DATA_KEY_STORE],
  providers: [
    AccountSecretService,
    DekService,
    { provide: ORG_DATA_KEY_STORE, useClass: DrizzleOrgDataKeyStore },
    { inject: [ConfigService], provide: KEK_PROVIDER, useFactory: kekProviderFor },
  ],
})
export class CryptoModule {}
