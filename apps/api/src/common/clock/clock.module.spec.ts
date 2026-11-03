import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { ClockModule } from './clock.module';
import { CLOCK, type ClockPort } from './clock.port';
import { SystemClock } from './system-clock';

@Injectable()
class NeedsTheClock {
  constructor(@Inject(CLOCK) readonly clock: ClockPort) {}
}

@Module({ providers: [NeedsTheClock] })
class ConsumerModule {}

describe('ClockModule', () => {
  it('binds CLOCK to the system clock', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ClockModule] }).compile();

    expect(moduleRef.get<ClockPort>(CLOCK)).toBeInstanceOf(SystemClock);
  });

  /**
   * Global, because from T12 onwards every service that touches expiry, throttling or TOTP drift
   * injects it. A port that a dozen modules have to remember to import is a port that one of them
   * will forget, and the fallback for forgetting is `new Date()`.
   */
  it('is global, so a consumer resolves it without importing anything', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClockModule, ConsumerModule],
    }).compile();

    expect(moduleRef.get(NeedsTheClock, { strict: false }).clock).toBeInstanceOf(SystemClock);
  });

  it('shares one instance, so time is not per-injection state', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ClockModule] }).compile();

    expect(moduleRef.get<ClockPort>(CLOCK)).toBe(moduleRef.get<ClockPort>(CLOCK));
  });
});
