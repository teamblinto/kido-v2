import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  presenceLocationSchema,
  type PresenceLocation,
  type PresenceResponse,
} from '@repo/contracts';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import { PRESENCE_TTL_SECONDS, presenceKey } from './presence.constants';

/** Who is sending the heartbeat. The email is displayed to the other people on the project. */
export interface PresenceUser {
  readonly email: string;
  readonly userId: string;
}

/** One field's value in the hash. Parsed on the way out: the hash is not trusted to be ours. */
const entrySchema = z.object({
  at: z.iso.datetime(),
  email: z.email(),
  location: presenceLocationSchema,
});

const UNAVAILABLE: PresenceResponse = { available: false, people: [] };

/**
 * Presence (spec 031, research R9): the hash `presence:{orgId}:{projectId}`, one field per user
 * holding `{email, location, at}`, each field with its own `HEXPIRE` of `PRESENCE_TTL_SECONDS`.
 *
 * ## Why `SESSION_REDIS` and not `CACHE_REDIS` / `OrgCache`
 *
 * The cache instance is `allkeys-lru`: under memory pressure it may evict somebody who is plainly
 * there, and `OrgCache` is a read-through cache of Postgres state with an org-prefixed key rule —
 * presence has no Postgres source to rebuild from. The session role is `noeviction`, already holds
 * short-lived per-user state, and a field TTL there is exact.
 *
 * ## Fail open
 *
 * Presence is a courtesy, not a control: nothing is authorised by it. So a Redis error is logged
 * at `warn` and answered `{available: false, people: []}` (FR-030) — the page hides the strip — and
 * never a 5xx that would break the project page over an ornament.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /** Write the caller's field and answer everyone else seen within the TTL. */
  async heartbeat(
    orgId: string,
    projectId: string,
    user: PresenceUser,
    location: PresenceLocation,
  ): Promise<PresenceResponse> {
    const key = presenceKey(orgId, projectId);
    const now = this.clock.now();
    const value = JSON.stringify({ at: now.toISOString(), email: user.email, location });

    try {
      const replies = await this.redis
        .multi()
        .hset(key, user.userId, value)
        .hexpire(key, PRESENCE_TTL_SECONDS, 'FIELDS', 1, user.userId)
        .hgetall(key)
        .exec();

      const failure = replies?.find(([error]) => error !== null)?.[0];

      if (failure || !replies) {
        throw failure ?? new Error('transaction discarded');
      }

      const all = replies[2]?.[1] as Record<string, string>;
      const oldest = now.getTime() - PRESENCE_TTL_SECONDS * 1000;

      return { available: true, people: this.others(all, user.userId, oldest) };
    } catch (error) {
      this.logger.warn(`presence unavailable for ${key}: ${describe(error)}`);

      return UNAVAILABLE;
    }
  }

  /** The caller closed the page. Best effort: the TTL is the guarantee. */
  async leave(orgId: string, projectId: string, userId: string): Promise<void> {
    await this.remove(orgId, projectId, userId);
  }

  /**
   * Drop somebody else's field — the project-grant revoke calls this after its commit so a removed
   * person disappears at once rather than after the TTL (FR-019). Never throws.
   */
  async forget(orgId: string, projectId: string, userId: string): Promise<void> {
    await this.remove(orgId, projectId, userId);
  }

  private async remove(orgId: string, projectId: string, userId: string): Promise<void> {
    const key = presenceKey(orgId, projectId);

    try {
      await this.redis.hdel(key, userId);
    } catch (error) {
      this.logger.warn(`presence delete failed for ${key}: ${describe(error)}`);
    }
  }

  private others(
    all: Record<string, string>,
    callerId: string,
    oldest: number,
  ): PresenceResponse['people'] {
    const people: PresenceResponse['people'] = [];

    for (const [userId, raw] of Object.entries(all)) {
      if (userId === callerId || !z.uuid().safeParse(userId).success) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      const entry = entrySchema.safeParse(parsed);

      // The field TTL is exact on Redis's clock; this filter holds the rule on ours too.
      if (!entry.success || Date.parse(entry.data.at) < oldest) {
        continue;
      }

      people.push({
        email: entry.data.email,
        location: entry.data.location,
        seenAt: entry.data.at,
        userId,
      });
    }

    return people.sort((a, b) => a.email.localeCompare(b.email));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
