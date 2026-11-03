import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { applyTestEnvironmentDefaults } from '../../../test/support/test-environment';
import type { RunProfile } from '../../config/run-profiles';
import { RUN_CONTROL_CONNECTION, RunControl } from './run-control';

const reachable = inject('redisReachable');

/** Resolves once `predicate` holds, or throws after a second — Redis pub/sub is fast, not instant. */
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met within 1 s');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Spec 008 research R7: the cancel fast path is one `run:{id}:control` channel per run, one
 * duplicated subscriber per process. Against the queue Redis role, because what is under test is
 * which channel the message crosses and that `close()` gives the connection back.
 */
describe('RunControl', () => {
  describe.skipIf(!reachable)('against the queue Redis role', () => {
    let redis: Redis;
    const controls: RunControl[] = [];

    /** How many subscribers are open, by the connection name `RunControl` gives its duplicate. */
    async function subscribers(): Promise<number> {
      const list = String(await redis.client('LIST'));

      return list.split('\n').filter((line) => line.includes(`name=${RUN_CONTROL_CONNECTION}`))
        .length;
    }

    function control(profiles: readonly RunProfile[] = ['agent']): RunControl {
      const instance = new RunControl(redis, new Set(profiles));

      controls.push(instance);

      return instance;
    }

    beforeAll(() => {
      applyTestEnvironmentDefaults();
      redis = new Redis(process.env.REDIS_QUEUE_URL!, { lazyConnect: true });
    });

    afterEach(async () => {
      await Promise.all(controls.splice(0).map((instance) => instance.close()));
    });

    afterAll(async () => {
      await redis.quit();
    });

    it('publishes a cancel on run:{id}:control and sees it on its own subscriber', async () => {
      const runId = randomUUID();
      const subject = control();
      const witness = redis.duplicate();
      const heard = vi.fn();

      witness.on('pmessage', heard);
      await witness.psubscribe('run:*:control');
      await subject.onApplicationBootstrap();

      expect(subject.seen(runId)).toBe(false);

      await subject.publish(runId, 'cancel');
      // Two connections, two deliveries: neither is ordered against the other.
      await until(() => subject.seen(runId) && heard.mock.calls.length > 0);

      expect(heard).toHaveBeenCalledWith('run:*:control', `run:${runId}:control`, 'cancel');
      await witness.quit();
    });

    it('sees only the runs that were cancelled', async () => {
      const cancelled = randomUUID();
      const other = randomUUID();
      const subject = control();

      await subject.onApplicationBootstrap();
      await subject.publish(cancelled, 'cancel');
      await until(() => subject.seen(cancelled));

      expect(subject.seen(other)).toBe(false);
    });

    it('does not subscribe when the outbox is off: a process that drains no queue holds no run', async () => {
      const runId = randomUUID();
      const subject = control(['api', 'events', 'cron']);

      await subject.onApplicationBootstrap();
      await subject.publish(runId, 'cancel');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(subject.seen(runId)).toBe(false);
    });

    it('holds no subscriber without the agent profile', async () => {
      const subject = control(['api', 'events', 'cron']);
      // A delta, as the release case below: the queue Redis is shared with every suite that boots
      // the app with `agent`, so the absolute count is theirs to change.
      const before = await subscribers();

      await subject.onApplicationBootstrap();

      expect(await subscribers()).toBe(before);
    });

    it('releases the duplicated client on close, and a later cancel is not seen', async () => {
      const runId = randomUUID();
      const subject = control();

      await subject.onApplicationBootstrap();

      const before = await subscribers();

      await subject.close();

      expect(await subscribers()).toBe(before - 1);

      await subject.publish(runId, 'cancel');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(subject.seen(runId)).toBe(false);
    });
  });
});
