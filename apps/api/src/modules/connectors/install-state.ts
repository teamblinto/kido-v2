import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConnectorProvider } from '@repo/contracts';
import { Redis } from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

import { SESSION_REDIS } from '../../common/redis/redis.constants';
import type { Environment } from '../../config/environment';

/** 32 bytes, the sign-in flow's budget: far past guessing, short enough for a URL. */
const STATE_BYTES = 32;

/** The Redis key one pending install is stored under. The argument is always a digest, never a state. */
export function installStateKey(stateHash: string): string {
  return `cn:state:${stateHash}`;
}

export interface InstallState {
  readonly orgId: string;
  /** Spec 030: the PKCE verifier of an OAuth install (Supabase); absent for GitHub's. */
  readonly pkce?: string;
  /** Spec 030: which provider's install issued the state; it is refused for any other. */
  readonly provider: ConnectorProvider;
  readonly userId: string;
}

/** Who may spend a state: the organisation, user and provider it was issued for. */
export type InstallExpectation = Pick<InstallState, 'orgId' | 'provider' | 'userId'>;

/**
 * Research R8: the install flow's state, kept the way `oauth.service.ts` keeps the sign-in flow's —
 * a hash under a digest key, `HSET` + `EXPIRE` for `OAUTH_STATE_TTL_SECONDS`, spent in one
 * `MULTI HGETALL DEL`. The sign-in helpers are private to their service, so this is a copy of the
 * idiom rather than an import; Redis holds the raw state nowhere.
 */
@Injectable()
export class InstallStateStore {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    config: ConfigService<Environment, true>,
  ) {
    this.ttlSeconds = config.get('OAUTH_STATE_TTL_SECONDS', { infer: true });
  }

  async issue(
    orgId: string,
    userId: string,
    options: { readonly pkce?: string; readonly provider?: ConnectorProvider } = {},
  ): Promise<string> {
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const key = installStateKey(digest(state));
    const record: Record<string, string> = {
      orgId,
      provider: options.provider ?? 'github',
      userId,
    };
    if (options.pkce !== undefined) record.pkce = options.pkce;

    await this.redis.multi().hset(key, record).expire(key, this.ttlSeconds).exec();

    return state;
  }

  /**
   * Single use: the record is deleted in the same round trip that reads it, whether or not it is
   * the caller's. A state issued for another organisation, user or provider answers undefined.
   */
  async consume(state: string, expected: InstallExpectation): Promise<InstallState | undefined> {
    const key = installStateKey(digest(state));
    const [read] = (await this.redis.multi().hgetall(key).del(key).exec()) ?? [];
    const stored = read?.[1] as Partial<Record<keyof InstallState, string>> | undefined;

    if (
      stored?.orgId !== expected.orgId ||
      stored.userId !== expected.userId ||
      stored.provider !== expected.provider
    ) {
      return undefined;
    }

    return {
      orgId: stored.orgId,
      provider: expected.provider,
      userId: stored.userId,
      ...(typeof stored.pkce === 'string' ? { pkce: stored.pkce } : {}),
    };
  }
}

function digest(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}
