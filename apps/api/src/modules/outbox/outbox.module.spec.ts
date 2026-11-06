import { Test, type TestingModule } from '@nestjs/testing';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
  type MockInstance,
  vi,
} from 'vitest';

import { AppModule } from '../../app.module';
import { RUN_PROFILES_TOKEN } from '../../common/run-profiles/run-profiles.constants';
import type { RunProfile } from '../../config/run-profiles';
import { holdOutboxSuiteLock } from '../../../test/support/outbox-suite-lock';
import { fullJitter } from './backoff';
import { EventConsumer } from './consumer';
import type { Envelope } from './envelope';
import { OutboxWriter } from './outbox-writer';
import { EVENT_CONSUMERS } from './outbox.constants';
import { OutboxModule } from './outbox.module';
import { QueueRegistry } from './queue-registry';
import { OutboxRelay } from './relay';

vi.hoisted(() => {
  // `api` alone by default under test; this suite asserts what bootstrap builds, so it carries
  // every profile (spec 013 R11). It holds the outbox suite lock while up, so its `mail` worker
  // drains no sibling suite's jobs.
  process.env.RUN_PROFILES = 'api,agent,events,cron';
});

/** Both roles: a registered consumer builds queues on the queue Redis role at bootstrap. */
const redis = inject('redisReachable');
const postgres = inject('postgresReachable');

/** The shape of a consumer and nothing more; `handle` is never reached here. */
class StubConsumer extends EventConsumer<'outbox.probe'> {
  readonly attempts = 1;
  readonly name = 'stub';
  readonly queue = 'stub';
  readonly types = ['outbox.probe'] as const;

  handle(_event: Envelope<'outbox.probe'>): Promise<void> {
    return Promise.resolve();
  }
}

describe('OutboxModule', () => {
  let moduleRef: TestingModule | undefined;
  let suiteLock: { release: () => Promise<void> } | undefined;

  // Ten minutes: the wait for the lock is behind every other suite that relays.
  beforeAll(async () => {
    if (postgres && redis) {
      suiteLock = await holdOutboxSuiteLock(process.env.DATABASE_URL ?? '');
    }
  }, 600_000);

  afterAll(async () => {
    await suiteLock?.release();
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  /**
   * Spec 006 (research R6): shipped code registers its consumers as ordinary providers of their
   * modules and the registry discovers them — the two mail consumers on `mail`, and since spec 008
   * the run consumer on `agent.run`, since spec 014 the ops consumer on `sandbox.ops` and the
   * maintenance consumer on `maintenance`, and since spec 016 the mirror consumer on `repo.mirror`, and since spec 018 the health and push consumers on `connector.health` and `connector.sync`, and since spec 044 the auto-sync consumer on `connector.autosync`, and since spec 020 the provider-key health consumer on `byok.health`, and since spec 032 the linked-account health consumer on `byos.health`, and since spec 027 the build consumer on `build.deploy` (`agent` profile) the archive consumer on `deploy.lifecycle` and the stuck-deployment sweep on `deploy.sweep` (both `events` profile), and since spec 028 the domain check consumer on `domain.check` and the due-domain sweep on `domain.sweep` (both `events` profile), and since spec 029 the webhook fan-out on `webhook.fanout` the attempt consumer on `integration.out`, the pause notices on `webhook.notice` and the redelivery sweep on `webhook.sweep` (all `events` profile), and since spec 031 the line consumer on `agent.line` (`agent` profile) — each queue with its DLQ and one worker. Resolved from the
   * application root so the assertion sees everything the root composes — a further queue
   * appearing here is a review point, not a surprise.
   */
  it.skipIf(!redis)(
    'builds exactly the mail, agent.run, byok.health, byos.health, agent.line, repo.mirror, repo.mirror-sweep, maintenance, sandbox.ops, connector.health, connector.autosync, connector.sync, connector.webhook, build.deploy, deploy.lifecycle, deploy.sweep, domain.check, domain.sweep, integration.out, webhook.fanout, webhook.notice and webhook.sweep queues and their DLQs in shipped code',
    async () => {
      const start = vi.spyOn(OutboxRelay.prototype, 'start');
      moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

      await moduleRef.init();

      const registry = moduleRef.get(QueueRegistry, { strict: false });

      expect([...registry.queues.keys()]).toEqual([
        'mail',
        'mail.dlq',
        'agent.run',
        'agent.run.dlq',
        'byok.health',
        'byok.health.dlq',
        'byos.health',
        'byos.health.dlq',
        'agent.line',
        'agent.line.dlq',
        'repo.mirror',
        'repo.mirror.dlq',
        'repo.mirror-sweep',
        'repo.mirror-sweep.dlq',
        'maintenance',
        'maintenance.dlq',
        'sandbox.ops',
        'sandbox.ops.dlq',
        'build.deploy',
        'build.deploy.dlq',
        'deploy.lifecycle',
        'deploy.lifecycle.dlq',
        'deploy.sweep',
        'deploy.sweep.dlq',
        'domain.check',
        'domain.check.dlq',
        'domain.sweep',
        'domain.sweep.dlq',
        'connector.autosync',
        'connector.autosync.dlq',
        'connector.health',
        'connector.health.dlq',
        'connector.ops',
        'connector.ops.dlq',
        'connector.sync',
        'connector.sync.dlq',
        'connector.webhook',
        'connector.webhook.dlq',
        'integration.out',
        'integration.out.dlq',
        'webhook.fanout',
        'webhook.fanout.dlq',
        'webhook.notice',
        'webhook.notice.dlq',
        'webhook.sweep',
        'webhook.sweep.dlq',
      ]);
      expect(registry.workers.map((worker) => worker.name)).toEqual([
        'mail',
        'agent.run',
        'byok.health',
        'byos.health',
        'agent.line',
        'repo.mirror',
        'repo.mirror-sweep',
        'maintenance',
        'sandbox.ops',
        'build.deploy',
        'deploy.lifecycle',
        'deploy.sweep',
        'domain.check',
        'domain.sweep',
        'connector.autosync',
        'connector.health',
        'connector.ops',
        'connector.sync',
        'connector.webhook',
        'integration.out',
        'webhook.fanout',
        'webhook.notice',
        'webhook.sweep',
      ]);
      expect(start).toHaveBeenCalledWith(registry.publish);
    },
  );

  /** The one thing a producer module imports (006 onwards); nothing else leaves the module. */
  it('exports the writer, so a producer that imports the module can inject it', async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(OutboxWriter, { strict: false })).toBeInstanceOf(OutboxWriter);
    expect(Reflect.getMetadata('exports', OutboxModule) as unknown[]).toEqual([OutboxWriter]);
  });

  /** Read off the metadata, as `rbac.module.spec.ts` does: the declaration is the invariant. */
  it('is imported by the application root', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];

    expect(imports).toContain(OutboxModule);
  });

  /**
   * Spec 013 (research R2, R3): the profile set says which queues this process drains and whether
   * it relays. Overridden per case through the token, because the environment is validated once
   * per process. Queues and DLQs exist wherever a worker profile boots the module, so the relay
   * in the `events` process can publish to `agent.run` without draining it.
   */
  describe.skipIf(!redis)('gated on the profile set', () => {
    async function boot(profiles: readonly RunProfile[]): Promise<{
      registry: QueueRegistry;
      start: MockInstance<OutboxRelay['start']>;
    }> {
      const start = vi.spyOn(OutboxRelay.prototype, 'start');
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(RUN_PROFILES_TOKEN)
        .useValue(new Set(profiles))
        .compile();

      await moduleRef.init();

      return { registry: moduleRef.get(QueueRegistry, { strict: false }), start };
    }

    it('builds nothing and starts no relay with only the api profile', async () => {
      const { registry, start } = await boot(['api']);

      expect([...registry.queues.keys()]).toEqual([]);
      expect(registry.workers).toEqual([]);
      expect(start).not.toHaveBeenCalled();
    });

    it('builds the agent worker and no relay with the agent profile', async () => {
      const { registry, start } = await boot(['agent']);

      expect([...registry.queues.keys()]).toEqual([
        'mail',
        'mail.dlq',
        'agent.run',
        'agent.run.dlq',
        'byok.health',
        'byok.health.dlq',
        'byos.health',
        'byos.health.dlq',
        'agent.line',
        'agent.line.dlq',
        'repo.mirror',
        'repo.mirror.dlq',
        'repo.mirror-sweep',
        'repo.mirror-sweep.dlq',
        'maintenance',
        'maintenance.dlq',
        'sandbox.ops',
        'sandbox.ops.dlq',
        'build.deploy',
        'build.deploy.dlq',
        'deploy.lifecycle',
        'deploy.lifecycle.dlq',
        'deploy.sweep',
        'deploy.sweep.dlq',
        'domain.check',
        'domain.check.dlq',
        'domain.sweep',
        'domain.sweep.dlq',
        'connector.autosync',
        'connector.autosync.dlq',
        'connector.health',
        'connector.health.dlq',
        'connector.ops',
        'connector.ops.dlq',
        'connector.sync',
        'connector.sync.dlq',
        'connector.webhook',
        'connector.webhook.dlq',
        'integration.out',
        'integration.out.dlq',
        'webhook.fanout',
        'webhook.fanout.dlq',
        'webhook.notice',
        'webhook.notice.dlq',
        'webhook.sweep',
        'webhook.sweep.dlq',
      ]);
      expect(registry.workers.map((worker) => worker.name)).toEqual([
        'agent.run',
        'agent.line',
        'build.deploy',
      ]);
      expect(start).not.toHaveBeenCalled();
    });

    it('builds the mail worker and starts the relay with the events profile', async () => {
      const { registry, start } = await boot(['events']);

      expect([...registry.queues.keys()]).toEqual([
        'mail',
        'mail.dlq',
        'agent.run',
        'agent.run.dlq',
        'byok.health',
        'byok.health.dlq',
        'byos.health',
        'byos.health.dlq',
        'agent.line',
        'agent.line.dlq',
        'repo.mirror',
        'repo.mirror.dlq',
        'repo.mirror-sweep',
        'repo.mirror-sweep.dlq',
        'maintenance',
        'maintenance.dlq',
        'sandbox.ops',
        'sandbox.ops.dlq',
        'build.deploy',
        'build.deploy.dlq',
        'deploy.lifecycle',
        'deploy.lifecycle.dlq',
        'deploy.sweep',
        'deploy.sweep.dlq',
        'domain.check',
        'domain.check.dlq',
        'domain.sweep',
        'domain.sweep.dlq',
        'connector.autosync',
        'connector.autosync.dlq',
        'connector.health',
        'connector.health.dlq',
        'connector.ops',
        'connector.ops.dlq',
        'connector.sync',
        'connector.sync.dlq',
        'connector.webhook',
        'connector.webhook.dlq',
        'integration.out',
        'integration.out.dlq',
        'webhook.fanout',
        'webhook.fanout.dlq',
        'webhook.notice',
        'webhook.notice.dlq',
        'webhook.sweep',
        'webhook.sweep.dlq',
      ]);
      expect(registry.workers.map((worker) => worker.name)).toEqual([
        'mail',
        'byok.health',
        'byos.health',
        'repo.mirror',
        'sandbox.ops',
        'deploy.lifecycle',
        'deploy.sweep',
        'domain.check',
        'domain.sweep',
        'connector.autosync',
        'connector.health',
        'connector.ops',
        'connector.sync',
        'connector.webhook',
        'integration.out',
        'webhook.fanout',
        'webhook.notice',
        'webhook.sweep',
      ]);
      expect(start).toHaveBeenCalledWith(registry.publish);
    });
  });

  describe.skipIf(!redis)('with a consumer provided', () => {
    /** The contract's table of what exists per registered queue name: `q`, `q.dlq`, one worker. */
    it('builds one queue, one dlq and one worker per consumer queue when a consumer is provided', async () => {
      const start = vi.spyOn(OutboxRelay.prototype, 'start');
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EVENT_CONSUMERS)
        .useValue([new StubConsumer()])
        .compile();

      await moduleRef.init();

      const registry = moduleRef.get(QueueRegistry, { strict: false });

      // The injected list is read before the discovered consumers, so `stub` comes first and the
      // shipped `mail` queue follows it.
      expect([...registry.queues.keys()]).toEqual([
        'stub',
        'stub.dlq',
        'mail',
        'mail.dlq',
        'agent.run',
        'agent.run.dlq',
        'byok.health',
        'byok.health.dlq',
        'byos.health',
        'byos.health.dlq',
        'agent.line',
        'agent.line.dlq',
        'repo.mirror',
        'repo.mirror.dlq',
        'repo.mirror-sweep',
        'repo.mirror-sweep.dlq',
        'maintenance',
        'maintenance.dlq',
        'sandbox.ops',
        'sandbox.ops.dlq',
        'build.deploy',
        'build.deploy.dlq',
        'deploy.lifecycle',
        'deploy.lifecycle.dlq',
        'deploy.sweep',
        'deploy.sweep.dlq',
        'domain.check',
        'domain.check.dlq',
        'domain.sweep',
        'domain.sweep.dlq',
        'connector.autosync',
        'connector.autosync.dlq',
        'connector.health',
        'connector.health.dlq',
        'connector.ops',
        'connector.ops.dlq',
        'connector.sync',
        'connector.sync.dlq',
        'connector.webhook',
        'connector.webhook.dlq',
        'integration.out',
        'integration.out.dlq',
        'webhook.fanout',
        'webhook.fanout.dlq',
        'webhook.notice',
        'webhook.notice.dlq',
        'webhook.sweep',
        'webhook.sweep.dlq',
      ]);
      expect(registry.workers.map((worker) => worker.name)).toEqual([
        'stub',
        'mail',
        'agent.run',
        'byok.health',
        'byos.health',
        'agent.line',
        'repo.mirror',
        'repo.mirror-sweep',
        'maintenance',
        'sandbox.ops',
        'build.deploy',
        'deploy.lifecycle',
        'deploy.sweep',
        'domain.check',
        'domain.sweep',
        'connector.autosync',
        'connector.health',
        'connector.ops',
        'connector.sync',
        'connector.webhook',
        'integration.out',
        'webhook.fanout',
        'webhook.notice',
        'webhook.sweep',
      ]);
      expect(start).toHaveBeenCalledWith(registry.publish);
    });

    /** FR-018: the strategy behind `backoff: { type: 'full-jitter' }` is ours, on every worker. */
    it('installs the full-jitter strategy on every worker', async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EVENT_CONSUMERS)
        .useValue([new StubConsumer()])
        .compile();

      await moduleRef.init();

      const registry = moduleRef.get(QueueRegistry, { strict: false });

      expect(registry.workers).not.toHaveLength(0);
      for (const worker of registry.workers) {
        expect(worker.opts.settings?.backoffStrategy).toBe(fullJitter);
      }
    });

    /** R7: the DLQ is written by a `failed` listener on the worker, so every worker carries one. */
    it('attaches the dead-letter listener to every worker', async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EVENT_CONSUMERS)
        .useValue([new StubConsumer()])
        .compile();

      await moduleRef.init();

      const registry = moduleRef.get(QueueRegistry, { strict: false });

      expect(registry.workers).not.toHaveLength(0);
      for (const worker of registry.workers) {
        expect(worker.listenerCount('failed')).toBe(1);
      }
    });
  });
});
