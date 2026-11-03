import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { RbacModule } from '../rbac/rbac.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { WebhookDeliveryRepository } from './inbound/inbound-delivery.repository';
import { InboundDeliveryService } from './inbound/inbound-delivery.service';
import { GithubWebhookGuard } from './inbound/verifiers/github.verifier';
import { WebhookController } from './inbound/webhook.controller';
import { WebhookAttemptConsumer } from './outbound/attempt.consumer';
import { DeliveriesController } from './outbound/controllers/deliveries.controller';
import { EndpointsController } from './outbound/controllers/endpoints.controller';
import { DeliveryLogService } from './outbound/delivery-log.service';
import { DESTINATION_POLICY, specialUseDestinationPolicy } from './outbound/destination';
import { EndpointRepository } from './outbound/endpoint.repository';
import { EndpointService } from './outbound/endpoint.service';
import { WebhookFanoutConsumer } from './outbound/fanout.consumer';
import { NodeResolverAdapter } from './outbound/node-resolver.adapter';
import { WebhookNoticeConsumer } from './outbound/notice.consumer';
import { WEBHOOK_RESOLVER } from './outbound/resolver.port';
import { SafeTransport } from './outbound/safe-transport';
import { SendRepository } from './outbound/send.repository';
import { SigningSecrets } from './outbound/signing-secret';
import { WebhookMailConsumer } from './outbound/webhook-mail.consumer';
import { WebhooksMaintenanceConsumer } from './webhooks-maintenance.consumer';

/**
 * Outbound webhooks (spec 029). The destination policy, the pinned resolver and the transport that
 * uses both; the endpoint routes (US1) and the delivery log (US4); the fan-out on `webhook.fanout` and the attempt consumer on
 * `integration.out`. Inbound (US6): spec 026's GitHub receiver, its verifier and the delivery
 * repository, with `InboundDeliveryService` exported so `connectors` never reads the repository.
 * `OutboxModule` for `OutboxWriter`, `RbacModule` and `IdentityModule` for the
 * routes' guard and session. `CLOCK`, `ConfigService`, `DekService`, `AuditService` and the tenant
 * transaction come from their global modules. The hooks-origin middleware is `HooksHostModule`'s,
 * resolved ahead of `CsrfModule` in `AppModule`.
 */
@Module({
  controllers: [DeliveriesController, EndpointsController, WebhookController],
  exports: [InboundDeliveryService, SafeTransport],
  imports: [IdentityModule, OutboxModule, RbacModule, TenancyModule],
  providers: [
    { provide: DESTINATION_POLICY, useValue: specialUseDestinationPolicy },
    { provide: WEBHOOK_RESOLVER, useClass: NodeResolverAdapter },
    DeliveryLogService,
    EndpointRepository,
    EndpointService,
    // Spec 029 US6: spec 026's receiving pipeline, moved unchanged. The verifier is applied with
    // `@UseGuards` on `WebhookController` alone, never as an `APP_GUARD`.
    GithubWebhookGuard,
    InboundDeliveryService,
    SafeTransport,
    SendRepository,
    SigningSecrets,
    WebhookAttemptConsumer,
    WebhookDeliveryRepository,
    WebhookFanoutConsumer,
    WebhookMailConsumer,
    WebhookNoticeConsumer,
    WebhooksMaintenanceConsumer,
  ],
})
export class WebhooksModule {}
