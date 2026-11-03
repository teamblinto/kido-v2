import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { ClockModule } from '../../common/clock/clock.module';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { RedisModule } from '../../common/redis/redis.module';
import { RUN_PROFILES_TOKEN } from '../../common/run-profiles/run-profiles.constants';
import { RunProfilesModule } from '../../common/run-profiles/run-profiles.module';
import { validateEnvironment } from '../../config/environment';
import type { RunProfile } from '../../config/run-profiles';
import { DatabaseModule } from '../../database/database.module';
import { MailModule } from '../mail/mail.module';
import { PreviewModule } from '../preview/preview.module';
import { ConnectorsModule } from './connectors.module';
import { ImportController } from './controllers/import.controller';
import { ImportRunner } from './import.runner';
import { ImportService } from './import.service';
import { GITHUB_APP_CLIENT, GithubAppClient } from './github-app.client';
import { IMPORT_RUNNER } from './push.consumer';
import { CONNECTOR_OP_HANDLERS, ConnectorOpsConsumer } from './connector-ops.consumer';
import { OperationRepository } from './operation.repository';
import { OperationService } from './operation.service';
import { PROVIDER_VERIFIERS } from './providers/provider';
import { ResourceRepository } from './resource.repository';
import { plaintext } from '../../common/crypto/branded';
import { RESEND_KEY, startResendFixture } from '../../../test/fixtures/provider-fixtures';
import { installResendState, RESEND_PENDING_DOMAIN } from '../../../test/fixtures/resend-state';
import { RESOURCE_RELEASERS, type ResourceReleasers } from './connection-remove.handler';
import { RESEND_DOMAIN_READER, type ResendDomainReader } from './connector-health.consumer';
import type { OperationHandlers } from './connector-ops.consumer';
import { ResendKeyHandler, ResendKeyReleaser } from './preview-resource.handlers';
import { RESEND_CLIENT, ResendClient } from './providers/resend/resend.client';

/** Read off the module metadata, as `checkpoints.module.spec.ts` does: the declaration is the invariant. */
describe('ConnectorsModule', () => {
  const providers = Reflect.getMetadata('providers', ConnectorsModule) as unknown[];
  const tokens = providers.map((provider) =>
    typeof provider === 'object' && provider !== null && 'provide' in provider
      ? provider.provide
      : provider,
  );

  it('provides and exports the GitHub App client under its token', () => {
    expect(providers).toContainEqual({ provide: GITHUB_APP_CLIENT, useClass: GithubAppClient });
    expect(Reflect.getMetadata('exports', ConnectorsModule)).toContain(GITHUB_APP_CLIENT);
  });

  /**
   * Spec 026 US1: the import's three pieces are declared here, the runner behind its token as the
   * pull's is — `QueueRegistry` refuses a second consumer of one event type on one queue, so an
   * import is an arm of `SyncConsumer` rather than a consumer of its own.
   */
  it('provides the import service and its runner, and mounts the import controller', () => {
    expect(tokens).toContain(ImportService);
    expect(providers).toContainEqual({ provide: IMPORT_RUNNER, useClass: ImportRunner });
    expect(Reflect.getMetadata('controllers', ConnectorsModule)).toContain(ImportController);
  });

  /** R12: the one new module edge, and it is the only reason `TenancyModule` is imported. */
  it('imports TenancyModule, for the project an import creates', () => {
    const imports = Reflect.getMetadata('imports', ConnectorsModule) as { name?: string }[];

    expect(imports.map((entry) => entry.name)).toContain('TenancyModule');
  });

  /** Spec 030 T025: the operations machinery, the two registries, and the edge into `deploy`. */
  it('provides the ops consumer, the operation service, both repositories and both registries', () => {
    for (const token of [
      ConnectorOpsConsumer,
      OperationRepository,
      OperationService,
      ResourceRepository,
      CONNECTOR_OP_HANDLERS,
      PROVIDER_VERIFIERS,
    ]) {
      expect(tokens).toContain(token);
    }

    const imports = Reflect.getMetadata('imports', ConnectorsModule) as { name?: string }[];

    expect(imports.map((entry) => entry.name)).toContain('DeployModule');
  });

  /** Constitution III: the global guard chain is `identity`'s and `rbac`'s; no module re-registers one. */
  it('registers no guard or interceptor of its own', () => {
    expect(tokens).not.toContain(APP_GUARD);
    expect(tokens).not.toContain(APP_INTERCEPTOR);
  });

  /** The graph under the two profiles that host it: the API's routes and the `events` worker. Nothing connects while it is built. */
  it.each<RunProfile>(['api', 'events'])('boots under the %s profile', async (profile) => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          isGlobal: true,
          validate: validateEnvironment,
        }),
        ClockModule,
        RunProfilesModule,
        CryptoModule,
        DatabaseModule,
        MailModule,
        RedisModule,
        // `@Global` for the callback minter the sandbox ops consumer needs.
        PreviewModule,
        ConnectorsModule,
      ],
    })
      .overrideProvider(RUN_PROFILES_TOKEN)
      .useValue(new Set([profile]))
      .compile();

    expect(moduleRef.get(GITHUB_APP_CLIENT)).toBeInstanceOf(GithubAppClient);
  });

  /**
   * Spec 030 US5/US6: the health sweep's pending-domain re-check reads through the real Resend
   * client — not `null` — and the mint and the sending key's release are registered.
   */
  it('wires RESEND_DOMAIN_READER to the Resend client, which reads a domain status', async () => {
    const fixture = await startResendFixture();
    installResendState(fixture);
    const previous = process.env.CONNECTOR_RESEND_API_URL;
    process.env.CONNECTOR_RESEND_API_URL = fixture.url;

    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            ignoreEnvFile: true,
            isGlobal: true,
            validate: validateEnvironment,
          }),
          ClockModule,
          RunProfilesModule,
          CryptoModule,
          DatabaseModule,
          MailModule,
          RedisModule,
          PreviewModule,
          ConnectorsModule,
        ],
      }).compile();

      const reader = moduleRef.get<ResendDomainReader | null>(RESEND_DOMAIN_READER);
      expect(reader).toBeInstanceOf(ResendClient);
      expect(reader).toBe(moduleRef.get(RESEND_CLIENT));
      await expect(
        reader!.domainStatus(plaintext(RESEND_KEY), RESEND_PENDING_DOMAIN),
      ).resolves.toBe('pending');
      expect(fixture.requests.at(-1)!.path).toBe(`/domains/${RESEND_PENDING_DOMAIN}`);

      expect(
        moduleRef.get<OperationHandlers>(CONNECTOR_OP_HANDLERS).get('resend_key_mint'),
      ).toBeInstanceOf(ResendKeyHandler);
      expect(
        moduleRef.get<ResourceReleasers>(RESOURCE_RELEASERS).get('resend_sending_key'),
      ).toBeInstanceOf(ResendKeyReleaser);
      await moduleRef.close();
    } finally {
      process.env.CONNECTOR_RESEND_API_URL = previous;
      await fixture.close();
    }
  });
});
