import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { AppModule } from '../../app.module';
import { WebhookAttemptConsumer } from './outbound/attempt.consumer';
import { DESTINATION_POLICY, type DestinationPolicy } from './outbound/destination';
import { EndpointService } from './outbound/endpoint.service';
import { WebhookFanoutConsumer } from './outbound/fanout.consumer';
import { NodeResolverAdapter } from './outbound/node-resolver.adapter';
import { WEBHOOK_RESOLVER } from './outbound/resolver.port';
import { SafeTransport } from './outbound/safe-transport';

const postgres = inject('postgresReachable');
const redis = inject('redisReachable');

/**
 * The module as the application composes it: since US1 it imports `OutboxModule`, `RbacModule`
 * and `IdentityModule` and reads the global crypto, audit and tenancy providers, so it is
 * resolved from `AppModule` rather than in isolation.
 */
describe('WebhooksModule', () => {
  describe.skipIf(!postgres || !redis)('in the application', () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    }, 60_000);

    afterAll(async () => {
      await moduleRef?.close();
    });

    it('resolves the destination policy, the resolver and the transport', () => {
      expect(moduleRef.get(DESTINATION_POLICY, { strict: false })).toBeDefined();
      expect(moduleRef.get(WEBHOOK_RESOLVER, { strict: false })).toBeInstanceOf(
        NodeResolverAdapter,
      );
      expect(moduleRef.get(SafeTransport, { strict: false })).toBeInstanceOf(SafeTransport);
    });

    it('resolves the endpoint service and both consumers', () => {
      expect(moduleRef.get(EndpointService, { strict: false })).toBeInstanceOf(EndpointService);
      expect(moduleRef.get(WebhookFanoutConsumer, { strict: false })).toBeInstanceOf(
        WebhookFanoutConsumer,
      );
      expect(moduleRef.get(WebhookAttemptConsumer, { strict: false })).toBeInstanceOf(
        WebhookAttemptConsumer,
      );
    });

    it('refuses 127.0.0.1 by default', () => {
      const policy = moduleRef.get<DestinationPolicy>(DESTINATION_POLICY, { strict: false });
      expect(policy.isAllowedAddress('127.0.0.1')).toBe(false);
    });
  });
});
