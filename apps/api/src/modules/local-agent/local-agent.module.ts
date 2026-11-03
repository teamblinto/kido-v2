import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AgentModule } from '../agent/agent.module';
import type { Environment } from '../../config/environment';
import { RbacModule } from '../rbac/rbac.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { AgentHomeRepository } from './agent-home.repository';
import { AgentHomeScheduler } from './agent-home.scheduler';
import {
  AGENT_HOME_TIMINGS,
  AgentHomeService,
  DEFAULT_AGENT_HOME_TIMINGS,
} from './agent-home.service';
import { CommandStream } from './command-stream';
import { CompanionController } from './controllers/companion.controller';
import { SubscriptionController } from './controllers/subscription.controller';
import { DeviceService } from './device.service';
import { DEFAULT_LOCAL_AGENT_TIMINGS, LOCAL_AGENT_TIMINGS } from './local-agent.constants';
import { LocalAgentExecutor } from './local-agent.executor';
import { DeviceTokenGuard, LocalAgentEnabledGuard } from './local-agent.guards';
import { LocalAgentRepository } from './local-agent.repository';
import { LocalAgentStore } from './local-agent.store';

/**
 * The cloud subscription agent (spec 041) on the runner bridge from spec 040: a person's agent
 * home (`AgentHomeService`, a private Daytona sandbox through `SandboxModule`'s exported adapter
 * and template versions), `SubscriptionController` (`/me/subscriptions`), `AgentHomeScheduler`
 * (idle stop and reconcile, `cron` only), the hosted runner's command stream and uplink
 * (`CompanionController`), and `LocalAgentExecutor`, which registers itself with `agent`'s
 * `RunExecutorRegistry` at init when `LOCAL_AGENT_ENABLED`. Every process loads it, as every
 * module; the run profiles gate who listens (`api`) and who claims runs (`agent`).
 * `LOCAL_AGENT_TIMINGS` is a provider so a suite can shorten every interval at once; the turn
 * ceiling comes from `LOCAL_AGENT_MAX_RUN_SECONDS`. The person's own paired computers (spec 040's
 * pairing, device list and approvals) are retired; the `local-agent` names are the wire's.
 */
@Module({
  controllers: [CompanionController, SubscriptionController],
  imports: [AgentModule, RbacModule, SandboxModule],
  providers: [
    {
      inject: [ConfigService],
      provide: LOCAL_AGENT_TIMINGS,
      useFactory: (config: ConfigService<Environment, true>) => ({
        ...DEFAULT_LOCAL_AGENT_TIMINGS,
        maxRunMs: config.get('LOCAL_AGENT_MAX_RUN_SECONDS', { infer: true }) * 1_000,
      }),
    },
    { provide: AGENT_HOME_TIMINGS, useValue: DEFAULT_AGENT_HOME_TIMINGS },
    AgentHomeRepository,
    AgentHomeScheduler,
    AgentHomeService,
    CommandStream,
    DeviceService,
    DeviceTokenGuard,
    LocalAgentEnabledGuard,
    LocalAgentExecutor,
    LocalAgentRepository,
    LocalAgentStore,
  ],
})
export class LocalAgentModule {}
