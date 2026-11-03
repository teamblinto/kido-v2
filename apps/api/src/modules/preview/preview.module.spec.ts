import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { AuditModule } from '../audit/audit.module';
import { DeployModule } from '../deploy/deploy.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RbacModule } from '../rbac/rbac.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BrokerListener } from './broker-listener';
import { PreviewAuthorizeController, PreviewController } from './controllers/preview.controller';
import { SandboxCallbackController } from './controllers/sandbox-callback.controller';
import { GrantService } from './grant.service';
import { SANDBOX_CALLBACK_MINTER } from '../sandbox/sandbox.constants';
import { BROKER_TRANSPORT, PREVIEW_DOMAIN, ROUTE_SIGNER } from './preview.constants';
import { PreviewModule } from './preview.module';
import { RouteBrokerService } from './route-broker.service';

/** Read off the module metadata, as `checkpoints.module.spec.ts` does: the declaration is the invariant. */
describe('PreviewModule', () => {
  const providers = Reflect.getMetadata('providers', PreviewModule) as unknown[];
  const tokens = providers.map((provider) =>
    typeof provider === 'object' && provider !== null && 'provide' in provider
      ? provider.provide
      : provider,
  );

  it('imports sandbox, tenancy, outbox, audit, rbac and deploy — the edges in the graph (contract § 9, 027 R1)', () => {
    expect(Reflect.getMetadata('imports', PreviewModule)).toEqual([
      AuditModule,
      DeployModule,
      OutboxModule,
      RbacModule,
      SandboxModule,
      TenancyModule,
    ]);
  });

  it('binds the signer, transport and domain under their symbols beside the broker, grants and listener', () => {
    expect(tokens).toEqual(
      expect.arrayContaining([
        BROKER_TRANSPORT,
        PREVIEW_DOMAIN,
        ROUTE_SIGNER,
        BrokerListener,
        GrantService,
        RouteBrokerService,
      ]),
    );
  });

  /** Spec 017 R11: the sandbox ops consumer mints the callback token through this one global export, since `sandbox → preview` is no edge. */
  it('is global for exactly one export, the callback minter the sandbox module injects', () => {
    expect(Reflect.getMetadata('__module:global__', PreviewModule)).toBe(true);
    expect(Reflect.getMetadata('exports', PreviewModule)).toEqual([SANDBOX_CALLBACK_MINTER]);
    expect(tokens).toContain(SANDBOX_CALLBACK_MINTER);
  });

  /** Constitution III: the product-origin controllers and the callback route, no guard of the module's own — the broker paths never touch the Nest pipeline (research R4). */
  it('registers the preview controllers and no guard or interceptor', () => {
    expect(Reflect.getMetadata('controllers', PreviewModule)).toEqual([
      PreviewAuthorizeController,
      PreviewController,
      SandboxCallbackController,
    ]);
    expect(tokens).not.toContain(APP_GUARD);
    expect(tokens).not.toContain(APP_INTERCEPTOR);
  });
});
