import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { EventConsumer, RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { GRANT_TTL_SECONDS, revokedLabelKey } from './preview.constants';
import { PreviewRotationConsumer } from './preview-rotation.consumer';
import { SANDBOX_OPS_QUEUE } from '../sandbox/sandbox.constants';

function rotated(previousLabel: string): Envelope<'project.preview-label.rotated'> {
  return {
    aggregate: 'project',
    aggregateId: 'a1000000-0000-4000-8000-000000000001',
    eventId: 'e1000000-0000-4000-8000-000000000001',
    occurredAt: '2026-09-18T10:00:00.000Z',
    orgId: 'o1000000-0000-4000-8000-000000000001',
    payload: {
      orgId: 'o1000000-0000-4000-8000-000000000001',
      previousLabel,
      projectId: 'p1000000-0000-4000-8000-000000000001',
    },
    traceId: null,
    type: 'project.preview-label.rotated',
  };
}

/**
 * Spec 017 US3, research R14: `project.preview-label.rotated` → a `pv:revoked:<label>` marker in
 * `SESSION_REDIS` with the grant TTL, so the auth broker refuses to mint against the old label
 * while a grant already handed out still dies by its own `aud` binding. No DB work — `handle`
 * only carries the label to `effect`, which runs with no transaction held (as `maintenance.consumer`
 * does for its callables).
 */
describe('PreviewRotationConsumer', () => {
  let redis: { set: ReturnType<typeof vi.fn> };
  let consumer: PreviewRotationConsumer;

  beforeEach(() => {
    redis = { set: vi.fn(() => Promise.resolve('OK')) };
    consumer = new PreviewRotationConsumer(redis as unknown as Redis);
  });

  /** Shares `sandbox.ops`, as `SandboxProjectConsumer` already does for another `project.*` type — no new queue. */
  it('is an EventConsumer on the sandbox ops queue for the events profile, concurrency 16', () => {
    expect(consumer).toBeInstanceOf(EventConsumer);
    expect(consumer).toMatchObject({
      concurrency: 16,
      name: 'preview-rotation',
      profile: 'events',
      queue: SANDBOX_OPS_QUEUE,
      types: ['project.preview-label.rotated'],
    });
  });

  it('writes the revoked marker for the previous label with the grant TTL', async () => {
    const event = rotated('swift-otter-42');

    await consumer.effect(event, await consumer.handle(event));

    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      revokedLabelKey('swift-otter-42'),
      '1',
      'EX',
      GRANT_TTL_SECONDS,
    );
    expect(GRANT_TTL_SECONDS).toBe(600);
  });

  it('classifies a Redis error as retryable, so the marker is written on a later attempt', async () => {
    const cause = new Error('ECONNRESET');
    redis.set.mockRejectedValueOnce(cause);
    const event = rotated('old-label');

    const failure: unknown = await consumer
      .effect(event, await consumer.handle(event))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RetryableFailure);
    expect(failure).toMatchObject({ cause, reason: 'timeout' });
  });

  it('touches no label but the one that was just rotated away', async () => {
    const event = rotated('old-label');

    await consumer.effect(event, await consumer.handle(event));

    expect(redis.set).not.toHaveBeenCalledWith(
      revokedLabelKey('some-other-label'),
      expect.anything(),
    );
  });
});
