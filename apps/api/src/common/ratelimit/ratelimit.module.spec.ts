import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { ClockModule } from '../clock/clock.module';
import { RedisModule } from '../redis/redis.module';
import { validateEnvironment } from '../../config/environment';
import { RatelimitModule } from './ratelimit.module';
import { RedisThrottleStorage } from './redis-throttler.storage';

@Injectable()
class NeedsThrottling {
  constructor(readonly storage: RedisThrottleStorage) {}
}

@Module({ imports: [RatelimitModule], providers: [NeedsThrottling] })
class ConsumerModule {}

function compile(...imports: unknown[]) {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, validate: validateEnvironment }),
      ClockModule,
      RedisModule,
      ...(imports as never[]),
    ],
  }).compile();
}

describe('RatelimitModule', () => {
  it('provides the store', async () => {
    const moduleRef = await compile(RatelimitModule);

    expect(moduleRef.get(RedisThrottleStorage)).toBeInstanceOf(RedisThrottleStorage);
  });

  /**
   * Exported, because the endpoints that need a bucket live in other modules — and deliberately
   * not `@Global`, so which of them do is answerable by reading the module graph.
   */
  it('exports it to a module that imports this one', async () => {
    const moduleRef = await compile(ConsumerModule);

    expect(moduleRef.get(NeedsThrottling, { strict: false }).storage).toBeInstanceOf(
      RedisThrottleStorage,
    );
  });

  it('is not global, so reaching it requires importing it', () => {
    expect(Reflect.getMetadata('__module:global__', RatelimitModule)).not.toBe(true);
  });
});
