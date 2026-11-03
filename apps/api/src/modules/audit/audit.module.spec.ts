import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { ClockModule } from '../../common/clock/clock.module';
import { AuditModule } from './audit.module';
import { AuditService } from './audit.service';

@Injectable()
class NeedsTheTrail {
  constructor(readonly audit: AuditService) {}
}

@Module({ providers: [NeedsTheTrail] })
class ConsumerModule {}

describe('AuditModule', () => {
  it('provides an AuditService with the clock injected', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AuditModule, ClockModule],
    }).compile();

    expect(moduleRef.get(AuditService)).toBeInstanceOf(AuditService);
  });

  /**
   * Global, because spec 001's last code-style rule puts a `record()` call inside every mutation
   * worth asking about, and that is most feature modules. This is also what keeps the parallel
   * lanes off each other's module metadata.
   */
  it('is global, so a consumer resolves it without importing anything', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AuditModule, ClockModule, ConsumerModule],
    }).compile();

    expect(moduleRef.get(NeedsTheTrail, { strict: false }).audit).toBeInstanceOf(AuditService);
  });

  /**
   * The clock is not optional. Without it the container has an unresolvable dependency and refuses
   * to build — which is the failure spec 001 wants, rather than a service that quietly falls back
   * to `new Date()`.
   */
  it('refuses to build without a bound clock', async () => {
    await expect(Test.createTestingModule({ imports: [AuditModule] }).compile()).rejects.toThrow();
  });
});
