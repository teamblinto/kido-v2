import { Inject, Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import type { RunProfile } from '../../config/run-profiles';
import { RUN_PROFILES_TOKEN } from './run-profiles.constants';
import { RunProfilesModule } from './run-profiles.module';

@Injectable()
class NeedsTheProfiles {
  constructor(@Inject(RUN_PROFILES_TOKEN) readonly profiles: ReadonlySet<RunProfile>) {}
}

@Module({ providers: [NeedsTheProfiles] })
class ConsumerModule {}

/** What the schema would have produced, without the schema: the token is the only seam. */
const stubbedConfig = (): ReturnType<typeof ConfigModule.forRoot> =>
  ConfigModule.forRoot({
    ignoreEnvFile: true,
    isGlobal: true,
    load: [() => ({ RUN_PROFILES: new Set<RunProfile>(['events']) })],
  });

describe('RunProfilesModule', () => {
  it('provides the validated profile set under the token', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [stubbedConfig(), RunProfilesModule],
    }).compile();

    expect(moduleRef.get<ReadonlySet<RunProfile>>(RUN_PROFILES_TOKEN)).toEqual(new Set(['events']));
  });

  /**
   * Global, for the `ClockModule` reason: the relay, the queue workers, the run-control subscriber
   * and the reaper all ask the set, and a module one of them forgets to import is a gate that
   * silently never opens (research R2).
   */
  it('is global, so a module that imports nothing can inject it', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [stubbedConfig(), RunProfilesModule, ConsumerModule],
    }).compile();

    expect(moduleRef.get(NeedsTheProfiles, { strict: false }).profiles).toEqual(
      new Set(['events']),
    );
  });
});
