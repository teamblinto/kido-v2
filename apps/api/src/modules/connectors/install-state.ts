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

/** Spec 044: the repository a personal account asked for, and the project it is for. */
export interface RepoCreateIntent {
  readonly name: string;
  readonly private: boolean;
  readonly projectId: string;
}

export interface InstallState {
  readonly orgId: string;
  /** Spec 030: the PKCE verifier of an OAuth install (Supabase); absent for GitHub's. */
  readonly pkce?: string;
  /** Spec 030: which provider's install issued the state; it is refused for any other. */
  readonly provider: ConnectorProvider;
  /** Spec 044: present on a personal-account create's state, absent on an install's. */
  readonly repoCreate?: RepoCreateIntent;
  readonly userId: string;
}

/**
 * Who may spend a state: the organisation, user and provider it was issued for, and the project
 * of a personal-account create. Naming no project refuses a create's state, so one issued under
 * `project:files.write` can never finish an install, which needs `org:connectors.manage`.
 */
export type InstallExpectation = Pick<InstallState, 'orgId' | 'provider' | 'userId'> & {
  readonly projectId?: string;
};

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
    options: {
      readonly pkce?: string;
      readonly provider?: ConnectorProvider;
      readonly repoCreate?: RepoCreateIntent;
    } = {},
  ): Promise<string> {
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const key = installStateKey(digest(state));
    const record: Record<string, string> = {
      orgId,
      provider: options.provider ?? 'github',
      userId,
    };
    if (options.pkce !== undefined) record.pkce = options.pkce;
    if (options.repoCreate !== undefined) {
      record.projectId = options.repoCreate.projectId;
      record.repoName = options.repoCreate.name;
      record.repoPrivate = String(options.repoCreate.private);
    }

    await this.redis.multi().hset(key, record).expire(key, this.ttlSeconds).exec();

    return state;
  }

  /**
   * Single use: the record is deleted in the same round trip that reads it, whether or not it is
   * the caller's. A state issued for another organisation, user, provider or project answers
   * undefined.
   */
  async consume(state: string, expected: InstallExpectation): Promise<InstallState | undefined> {
    const key = installStateKey(digest(state));
    const [read] = (await this.redis.multi().hgetall(key).del(key).exec()) ?? [];
    const stored = read?.[1] as Record<string, string | undefined> | undefined;

    if (
      stored?.orgId !== expected.orgId ||
      stored.userId !== expected.userId ||
      stored.provider !== expected.provider ||
      stored.projectId !== expected.projectId
    ) {
      return undefined;
    }

    return {
      orgId: stored.orgId,
      provider: expected.provider,
      userId: stored.userId,
      ...(typeof stored.pkce === 'string' ? { pkce: stored.pkce } : {}),
      ...(stored.projectId !== undefined && stored.repoName !== undefined
        ? {
            repoCreate: {
              name: stored.repoName,
              private: stored.repoPrivate === 'true',
              projectId: stored.projectId,
            },
          }
        : {}),
    };
  }
}

function digest(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}
