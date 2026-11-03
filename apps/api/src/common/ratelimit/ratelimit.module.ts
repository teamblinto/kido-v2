import { Module } from '@nestjs/common';

import { RedisThrottleStorage } from './redis-throttler.storage';

/**
 * The shared rate-limit store, and nothing else.
 *
 * Not `@Global`, unlike the Redis clients it sits on: the endpoints that need a bucket of their own
 * are few and named — login today, password reset and verification resend next — and a store that
 * every module can reach is a store every module will reach, at which point "which limits exist"
 * stops being answerable by reading the module graph.
 *
 * The policies are not providers here. A bucket's burst and ceiling belong to the endpoint being
 * protected, not to the store, and `LoginService` reads its own from the validated environment.
 */
@Module({
  exports: [RedisThrottleStorage],
  providers: [RedisThrottleStorage],
})
export class RatelimitModule {}
