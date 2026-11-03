import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment';
import type { RunProfile } from '../../config/run-profiles';
import { RUN_PROFILES_TOKEN } from './run-profiles.constants';

/**
 * Binds {@link RUN_PROFILES_TOKEN} to the profile set the environment schema validated, once, for
 * the whole application (spec 013, research R2).
 *
 * The gated actors — the relay, the queue workers, the run-control subscriber, the reaper, the
 * liveness listener — inject this token and never `ConfigService`: the environment is validated
 * once per process, so a suite that boots two contexts with different profiles can only tell them
 * apart by `overrideProvider(RUN_PROFILES_TOKEN)`. `@Global` for the `ClockModule` reason.
 */
@Global()
@Module({
  exports: [RUN_PROFILES_TOKEN],
  providers: [
    {
      inject: [ConfigService],
      provide: RUN_PROFILES_TOKEN,
      useFactory: (config: ConfigService<Environment, true>): ReadonlySet<RunProfile> =>
        config.get('RUN_PROFILES', { infer: true }),
    },
  ],
})
export class RunProfilesModule {}
