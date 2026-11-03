import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { SESSION_REDIS } from '../../common/redis/redis.constants';
import { EventConsumer, RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { SANDBOX_OPS_QUEUE } from '../sandbox/sandbox.constants';
import { GRANT_TTL_SECONDS, revokedLabelKey } from './preview.constants';

type RotatedEvent = Envelope<'project.preview-label.rotated'>;

/**
 * `project.preview-label.rotated` (spec 017 US3, research R14) → a `pv:revoked:<label>` marker in
 * `SESSION_REDIS` with the grant TTL. A grant already in a browser dies by its `aud` binding, not
 * by this marker; the marker is only what stops the auth broker minting a *new* one against the
 * label just retired. No DB work, so `handle` does nothing but carry the label forward — `effect`
 * runs with no transaction held, as `maintenance.consumer.ts`'s callables do. Shares `sandbox.ops`,
 * as `SandboxProjectConsumer` already does for another `project.*` type on the `events` profile
 * (plan § Storage: no new queue); concurrency matches it so the shared worker keeps 16.
 */
@Injectable()
export class PreviewRotationConsumer extends EventConsumer<
  'project.preview-label.rotated',
  string
> {
  readonly attempts = 5;
  override readonly concurrency = 16;
  readonly name = 'preview-rotation';
  override readonly profile = 'events' as const;
  readonly queue = SANDBOX_OPS_QUEUE;
  readonly types = ['project.preview-label.rotated'] as const;

  constructor(@Inject(SESSION_REDIS) private readonly redis: Redis) {
    super();
  }

  handle(event: RotatedEvent): Promise<string> {
    return Promise.resolve(event.payload.previousLabel);
  }

  override async effect(_event: RotatedEvent, previousLabel: string): Promise<void> {
    try {
      await this.redis.set(revokedLabelKey(previousLabel), '1', 'EX', GRANT_TTL_SECONDS);
    } catch (error) {
      // A Redis that is down or busy is the upstream's condition for a while, not a bad event: the
      // marker is what stops a fresh grant on the old label, so the attempt is retried, not
      // dead-lettered (as `SandboxOpsConsumer` classifies an unreachable provider).
      throw new RetryableFailure('timeout', error);
    }
  }
}
