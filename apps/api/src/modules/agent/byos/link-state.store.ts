import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';

import { SESSION_REDIS } from '../../../common/redis/redis.constants';
import type { Environment } from '../../../config/environment';
import type { LlmProviderName } from '../llm-provider.port';

/** 32 bytes → 43 base64url characters (contracts § 1). */
const STATE_BYTES = 32;

/** The key one pending link is stored under. The argument is always a digest, never a state. */
export function linkStateKey(stateHash: string): string {
  return `byos:state:${stateHash}`;
}

export interface LinkState {
  readonly userId: string;
  readonly provider: LlmProviderName;
  /** The PKCE verifier (redirect flow); kept for the device flow too, where it is unused. */
  readonly pkce: string;
  /** Device flow only (D3): never returned to the web. */
  readonly deviceCode?: string;
  readonly intervalSeconds?: number;
}

export interface LinkExpectation {
  readonly userId: string;
  /** The session principal's id; stored only as its digest. */
  readonly sessionId: string;
  readonly provider: LlmProviderName;
}

/**
 * The BYOS link flow's state (spec 032 T021), modelled on `connectors/install-state.ts` and not
 * importing it (ADR 043): a hash under a digest key with `OAUTH_STATE_TTL_SECONDS`, spent in one
 * `MULTI HGETALL DEL`. Bound to the person, the session that began the link and the provider — a
 * completion from another session of the same person is refused (FR-008a).
 */
@Injectable()
export class LinkStateStore {
  private readonly ttlSeconds: number;

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.ttlSeconds = config.get('OAUTH_STATE_TTL_SECONDS', { infer: true });
  }

  async issue(
    userId: string,
    sessionId: string,
    provider: LlmProviderName,
    pkceVerifier: string,
    device?: { readonly deviceCode: string; readonly intervalSeconds: number },
  ): Promise<string> {
    const state = randomBytes(STATE_BYTES).toString('base64url');
    await this.store(state, sessionId, { pkce: pkceVerifier, provider, userId, ...device });
    return state;
  }

  /** A device-flow poll that is still pending puts its state back for the next poll. */
  async restore(state: string, sessionId: string, record: LinkState): Promise<void> {
    await this.store(state, sessionId, record);
  }

  /** Single use: deleted in the same round trip that reads it, whether or not it matches. */
  async consume(state: string, expected: LinkExpectation): Promise<LinkState | undefined> {
    const key = linkStateKey(digest(state));
    const [read] = (await this.redis.multi().hgetall(key).del(key).exec()) ?? [];
    const stored = read?.[1] as Partial<Record<string, string>> | undefined;

    if (
      stored?.userId !== expected.userId ||
      stored.sessionHash !== digest(expected.sessionId) ||
      stored.provider !== expected.provider ||
      stored.pkce === undefined
    ) {
      return undefined;
    }

    return {
      pkce: stored.pkce,
      provider: expected.provider,
      userId: stored.userId,
      ...(stored.deviceCode === undefined
        ? {}
        : { deviceCode: stored.deviceCode, intervalSeconds: Number(stored.intervalSeconds ?? 5) }),
    };
  }

  private async store(state: string, sessionId: string, record: LinkState): Promise<void> {
    const key = linkStateKey(digest(state));
    const fields: Record<string, string> = {
      pkce: record.pkce,
      provider: record.provider,
      sessionHash: digest(sessionId),
      userId: record.userId,
    };
    if (record.deviceCode !== undefined) {
      fields.deviceCode = record.deviceCode;
      fields.intervalSeconds = String(record.intervalSeconds ?? 5);
    }
    await this.redis.multi().hset(key, fields).expire(key, this.ttlSeconds).exec();
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
