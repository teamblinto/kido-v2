import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { createHash } from 'node:crypto';

import { CLOCK, type ClockPort } from '../../src/common/clock/clock.port';
import { SESSION_REDIS } from '../../src/common/redis/redis.constants';
import { sessionKey } from '../../src/modules/identity/services/session.service';

/**
 * Stamps a signed-in session as stepped up now — what `POST /auth/mfa/step-up` writes after a
 * correct second factor (`session.service.ts`). Suites whose subject is a `@StepUp()` route, not the
 * second factor itself, use it instead of enrolling a TOTP secret; `mfa.e2e-spec.ts` proves the
 * real step-up path. `cookie` is the `name=value` pair a suite sends.
 */
export async function stepUp(app: INestApplication, cookie: string): Promise<void> {
  const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  const hash = createHash('sha256').update(token).digest('hex');
  const redis = app.get<Redis>(SESSION_REDIS);
  const now = app.get<ClockPort>(CLOCK).now();

  await redis.hset(sessionKey(hash), { steppedUpAt: now.toISOString() });
}
