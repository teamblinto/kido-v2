import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { RunProfilesModule } from '../../common/run-profiles/run-profiles.module';
import { HealthReport } from './health-report';
import { HealthController } from './health.controller';
import { LivenessServer } from './liveness-server';
import { PostgresHealthIndicator } from './postgres.health';
import { RedisHealthIndicator } from './redis.health';
import { VersionController } from './version.controller';

/**
 * The pool and the two Redis clients arrive from `DatabaseModule` and `RedisModule`, both `@Global`,
 * so this module declares no imports for them. `RunProfilesModule` is `@Global` too, but named here
 * so the module compiles on its own — `health.controller.spec.ts` builds it without `AppModule`.
 */
@Module({
  controllers: [HealthController, VersionController],
  imports: [RunProfilesModule, TerminusModule],
  providers: [HealthReport, LivenessServer, PostgresHealthIndicator, RedisHealthIndicator],
})
export class HealthModule {}
