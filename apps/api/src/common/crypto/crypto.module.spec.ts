import { randomBytes } from 'node:crypto';

import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import type { Environment } from '../../config/environment';
import { AccountSecretService } from './account-secret';
import { CryptoModule, MissingKekConfigurationError } from './crypto.module';
import { DekService } from './dek.service';
import { EnvKekProvider, EnvKekRefusedError } from './env-kek.provider';
import { KEK_PROVIDER, type KekProvider } from './kek-provider.port';
import { OpenBaoKekProvider } from './openbao-kek.provider';
import { DrizzleOrgDataKeyStore, ORG_DATA_KEY_STORE } from './org-data-key.store';

const MASTER_KEY = randomBytes(32).toString('base64');

const LOCAL_ENV = {
  DEPLOY_ENV: 'local',
  KEK_ENV_MASTER_KEY: MASTER_KEY,
  KEK_PROVIDER: 'env',
  OPENBAO_KEY_NAME: 'forge-kek',
} as const;

/**
 * The real `ConfigModule` is registered globally by `AppModule`, so `CryptoModule` injects
 * `ConfigService` without importing anything. This stands in for it with the same visibility.
 */
function configuring(values: Partial<Environment>) {
  @Global()
  @Module({
    exports: [ConfigService],
    providers: [
      {
        provide: ConfigService,
        useValue: { get: (key: keyof Environment) => values[key] },
      },
    ],
  })
  class FakeConfigModule {}

  return FakeConfigModule;
}

async function compile(values: Partial<Environment>) {
  return Test.createTestingModule({
    imports: [configuring(values), CryptoModule],
  }).compile();
}

describe('CryptoModule', () => {
  it('binds the KEK provider to the env adapter when KEK_PROVIDER is "env"', async () => {
    const moduleRef = await compile(LOCAL_ENV);

    expect(moduleRef.get<KekProvider>(KEK_PROVIDER)).toBeInstanceOf(EnvKekProvider);
  });

  /**
   * The adapter ships but no OpenBao is deployed (ADR 003). Selecting it must still work: an enum
   * value the environment schema accepts and the module refuses to honour would be a lie in the
   * configuration surface, and the deployment that turns it on would discover it at boot.
   */
  it('binds the KEK provider to the OpenBao adapter when KEK_PROVIDER is "openbao"', async () => {
    const moduleRef = await compile({
      DEPLOY_ENV: 'production',
      KEK_PROVIDER: 'openbao',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_KEY_NAME: 'forge-kek',
      OPENBAO_TOKEN: 's.9c1f4b7ae2d38f60',
    });

    expect(moduleRef.get<KekProvider>(KEK_PROVIDER)).toBeInstanceOf(OpenBaoKekProvider);
  });

  it('exposes the DEK service and the data-key store', async () => {
    const moduleRef = await compile(LOCAL_ENV);

    expect(moduleRef.get(DekService)).toBeInstanceOf(DekService);
    expect(moduleRef.get(ORG_DATA_KEY_STORE)).toBeInstanceOf(DrizzleOrgDataKeyStore);
  });

  /**
   * The account-scoped half of the same primitive (ADR 015 makes `users` a root, so the tenant DEK
   * is unreachable for an MFA seed). It is exported for the same reason `DekService` is: a module
   * that cannot resolve it would otherwise be free to write the seed some weaker way.
   */
  it('exposes the account secret service for secrets that belong to a person', async () => {
    const moduleRef = await compile(LOCAL_ENV);

    expect(moduleRef.get(AccountSecretService)).toBeInstanceOf(AccountSecretService);
  });

  it('shares one provider instance, so a KEK is not per-injection state', async () => {
    const moduleRef = await compile(LOCAL_ENV);

    expect(moduleRef.get<KekProvider>(KEK_PROVIDER)).toBe(moduleRef.get<KekProvider>(KEK_PROVIDER));
  });

  /** Secrets, MFA seeds and connector credentials all reach for this; a forgotten import is silent. */
  it('is global, so a consumer resolves the DEK service without importing it', async () => {
    @Injectable()
    class NeedsTheDek {
      constructor(@Inject(DekService) readonly dek: DekService) {}
    }

    @Module({ providers: [NeedsTheDek] })
    class ConsumerModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [configuring(LOCAL_ENV), CryptoModule, ConsumerModule],
    }).compile();

    expect(moduleRef.get(NeedsTheDek, { strict: false }).dek).toBeInstanceOf(DekService);
  });
});

/**
 * §11's requirement, proven where it actually bites: not in a unit test of the provider, but at the
 * moment the application container builds it.
 */
describe('CryptoModule on a real deployment', () => {
  it.each(['staging', 'production'] as const)(
    'fails to build with the env provider when DEPLOY_ENV is %s',
    async (deployEnv) => {
      await expect(compile({ ...LOCAL_ENV, DEPLOY_ENV: deployEnv })).rejects.toThrow(
        EnvKekRefusedError,
      );
    },
  );

  it('builds with the env provider when DEPLOY_ENV is local', async () => {
    await expect(compile(LOCAL_ENV)).resolves.toBeDefined();
  });
});

describe('CryptoModule with incomplete configuration', () => {
  it('refuses the env provider with no master key', async () => {
    await expect(compile({ ...LOCAL_ENV, KEK_ENV_MASTER_KEY: undefined })).rejects.toThrow(
      MissingKekConfigurationError,
    );
  });

  it.each(['OPENBAO_ADDR', 'OPENBAO_TOKEN'] as const)(
    'refuses the OpenBao provider with no %s',
    async (missing) => {
      await expect(
        compile({
          DEPLOY_ENV: 'production',
          KEK_PROVIDER: 'openbao',
          OPENBAO_ADDR: 'https://openbao.internal:8200',
          OPENBAO_KEY_NAME: 'forge-kek',
          OPENBAO_TOKEN: 's.9c1f4b7ae2d38f60',
          [missing]: undefined,
        }),
      ).rejects.toThrow(MissingKekConfigurationError);
    },
  );

  it('names the variable that is missing, and never a value', async () => {
    let caught: unknown;

    try {
      await compile({ ...LOCAL_ENV, KEK_ENV_MASTER_KEY: undefined });
    } catch (error) {
      caught = error;
    }

    expect(`${(caught as Error).message}`).toContain('KEK_ENV_MASTER_KEY');
    expect(`${(caught as Error).message}`).not.toContain(MASTER_KEY);
  });
});
