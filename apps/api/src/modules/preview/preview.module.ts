import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment';
import { AuditModule } from '../audit/audit.module';
import { DeployModule } from '../deploy/deploy.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RbacModule } from '../rbac/rbac.module';
import { SANDBOX_CALLBACK_MINTER } from '../sandbox/sandbox.constants';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { BrokerListener, brokerTransportFor } from './broker-listener';
import { PreviewAuthorizeController, PreviewController } from './controllers/preview.controller';
import { SandboxCallbackController } from './controllers/sandbox-callback.controller';
import { GrantService } from './grant.service';
import { BROKER_TRANSPORT, PREVIEW_DOMAIN, ROUTE_SIGNER } from './preview.constants';
import { PreviewRotationConsumer } from './preview-rotation.consumer';
import { RouteBrokerService } from './route-broker.service';
import { createRouteSigner } from './route-signer';
import { SandboxCallbackGuard } from './sandbox-callback.guard';
import { createSandboxCallbackSigner } from './sandbox-callback.token';

/**
 * Preview routing on the control-plane side (spec 017, contract § 9): the route broker the
 * gateway asks, the listener it asks over, and the signer that makes an answer verifiable.
 * `SandboxModule` for the catalogue's `devPort` and the adapter's `previewOrigin`, `TenancyModule`
 * for the resolved project, `OutboxModule` for the rotation event this module will consume, and
 * `AuditModule` for the actions the later tasks record, `RbacModule` for the `project:read` a
 * private preview's grant turns on, `DeployModule` for the `SiteRouteService` the broker's
 * `GET /broker/sites/:label` resolves through (spec 027). No `tenancy → preview` edge: rotation
 * publishes an event and this module hears it, so the graph has no cycle. `PreviewController`
 * serves the product-origin read; the broker paths are served by `BrokerListener`, off the Nest
 * pipeline (research R4). `SandboxCallbackController` is the one `@Public()` route, admitted by
 * the module-scoped `SandboxCallbackGuard` — never an `APP_GUARD` (plan, Constitution III).
 *
 * `@Global()` for one export, `SANDBOX_CALLBACK_MINTER`: the sandbox ops consumer mints the
 * callback token (R11) with the signer that lives here, and `sandbox → preview` is not an edge in
 * the graph — so the binding travels the way `AuditService` does, rather than the sandbox module
 * importing this one. Nothing else is exported.
 */
@Global()
@Module({
  controllers: [PreviewAuthorizeController, PreviewController, SandboxCallbackController],
  exports: [SANDBOX_CALLBACK_MINTER],
  imports: [AuditModule, DeployModule, OutboxModule, RbacModule, SandboxModule, TenancyModule],
  providers: [
    { inject: [ConfigService], provide: BROKER_TRANSPORT, useFactory: brokerTransportFor },
    {
      inject: [ConfigService],
      provide: PREVIEW_DOMAIN,
      useFactory: (config: ConfigService<Environment, true>): string =>
        config.get('PREVIEW_DOMAIN', { infer: true }),
    },
    {
      inject: [ConfigService],
      provide: ROUTE_SIGNER,
      useFactory: (config: ConfigService<Environment, true>) =>
        createRouteSigner({
          jwks: config.get('PREVIEW_PUBLIC_JWKS', { infer: true }),
          signingKey: config.get('PREVIEW_SIGNING_KEY', { infer: true }),
          signingKeyId: config.get('PREVIEW_SIGNING_KEY_ID', { infer: true }),
        }),
    },
    {
      inject: [ConfigService],
      provide: SANDBOX_CALLBACK_MINTER,
      useFactory: (config: ConfigService<Environment, true>) =>
        createSandboxCallbackSigner({
          signingKey: config.get('PREVIEW_SIGNING_KEY', { infer: true }),
          signingKeyId: config.get('PREVIEW_SIGNING_KEY_ID', { infer: true }),
        }),
    },
    BrokerListener,
    GrantService,
    PreviewRotationConsumer,
    RouteBrokerService,
    SandboxCallbackGuard,
  ],
})
export class PreviewModule {}
