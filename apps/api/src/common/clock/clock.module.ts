import { Global, Module } from '@nestjs/common';

import { CLOCK } from './clock.port';
import { SystemClock } from './system-clock';

/**
 * Binds {@link CLOCK} to the host clock, once, for the whole application.
 *
 * `@Global` for the reason `RedisModule` gives: verification tokens, password reset, sessions,
 * throttling, MFA and idempotency all reach for this, and making every one of them restate the
 * import buys nothing — while forgetting the import has a silent fallback that spec 001 forbids,
 * namely `new Date()`.
 */
@Global()
@Module({
  exports: [CLOCK],
  providers: [{ provide: CLOCK, useClass: SystemClock }],
})
export class ClockModule {}
