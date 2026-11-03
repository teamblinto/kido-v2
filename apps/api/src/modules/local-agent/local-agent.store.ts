import { Inject, Injectable } from '@nestjs/common';
import type {
  CompanionAuthCommand,
  CompanionCommand,
  CompanionRunEvent,
  CompanionStatusReport,
} from '@repo/contracts';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

import { STREAM_REDIS } from '../../common/redis/redis.constants';
import {
  COMMAND_STREAM_MAXLEN,
  HOME_AUTH_TTL_SECONDS,
  keys,
  LOCAL_AGENT_TIMINGS,
  type LocalAgentTimings,
  RUN_STREAM_MAXLEN,
  STATUS_TTL_SECONDS,
  STREAM_TTL_SECONDS,
} from './local-agent.constants';

export interface RunCursor {
  readonly events: string;
  readonly control: string;
}

/** Why a run must end now, whatever the device says: its device was revoked, or it overspent. */
export type RunAbortReason = 'revoked' | 'over-budget';

export interface RunRead {
  readonly events: { id: string; event: CompanionRunEvent }[];
  readonly aborts: { id: string; reason: RunAbortReason }[];
}

/** The turn the executor is running, and since when (ms). */
export interface ActiveTurn {
  readonly turn: number;
  readonly startedAt: number;
}

/** What an append did: how many events were new, or why none were taken. */
export type AppendResult =
  | { readonly kind: 'appended'; readonly accepted: number }
  | { readonly kind: 'not-active' }
  | { readonly kind: 'over-budget' };

/** A blocking reader over one turn's event stream and the run's control stream. */
export interface RunReader {
  read(runId: string, turn: number, cursor: RunCursor, blockMs: number): Promise<RunRead>;
  close(): void;
}

/** What the executor needs of Redis — a seam the spec drives with an in-memory fake. */
export interface RunChannel {
  online(deviceId: string): Promise<boolean>;
  publish(deviceId: string, command: CompanionCommand): Promise<void>;
  status(deviceId: string): Promise<CompanionStatusReport | undefined>;
  /**
   * A fresh turn: the previous turn's control entries and cursor are dropped, and `turn`
   * becomes the one the uplink accepts. Called before `run.start` goes out.
   */
  beginTurn(runId: string, turn: number, startedAt: number): Promise<void>;
  /** A re-claimed attempt: the turn is marked active again, keeping when it started. */
  markTurn(runId: string, turn: number, startedAt: number): Promise<void>;
  activeTurn(runId: string): Promise<ActiveTurn | undefined>;
  /** The turn ended: the uplink refuses its events from now on. */
  endTurn(runId: string): Promise<void>;
  reader(): RunReader;
  cursor(runId: string): Promise<RunCursor>;
  saveCursor(runId: string, cursor: RunCursor): Promise<void>;
}

/** Where a home's sign-in stands (spec 041). Never the code: only that one was sent. */
export interface SignIn {
  readonly phase: 'requested' | 'url' | 'verifying' | 'failed';
  readonly url?: string;
  /** ISO; when the URL stops being offered. */
  readonly expiresAt?: string;
  readonly message?: string | null;
}

/** A home's last `claude auth status` verdict: no account identifiers, only the plan's name. */
export interface HomeAuth {
  readonly status: 'authenticated' | 'unauthenticated' | 'unknown';
  readonly plan: string | null;
  readonly checkedAt: string;
}

const START: RunCursor = Object.freeze({ control: '0-0', events: '0-0' });

/** Refresh the presence key only while this connection still holds it (newer wins). */
const REFRESH = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2]) and 1 else return 0 end`;
/** Sets a field only on a hash that exists, so nothing is re-created without its TTL (-1 if gone). */
export const HSET_IF_EXISTS = `if redis.call('exists', KEYS[1]) == 1 then
  return redis.call('hset', KEYS[1], ARGV[1], ARGV[2]) else return -1 end`;
/** `HSETNX` likewise: 1 set, 0 already set, -1 the hash is gone. */
export const HSETNX_IF_EXISTS = `if redis.call('exists', KEYS[1]) == 1 then
  return redis.call('hsetnx', KEYS[1], ARGV[1], ARGV[2]) else return -1 end`;
/** Release it only if it is still ours. */
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Everything ephemeral the bridge holds, on the stream Redis instance (spec 040 § 5): presence,
 * the latest status report, the per-device command stream, and per run the companion's events
 * (per turn) and aborts, the active turn and the executor's cursor. All of it
 * is rebuilt by the companion reconnecting and re-reporting; the run's record is Postgres.
 */
@Injectable()
export class LocalAgentStore implements RunChannel {
  constructor(
    @Inject(STREAM_REDIS) private readonly redis: Redis,
    @Inject(LOCAL_AGENT_TIMINGS) private readonly timings: LocalAgentTimings,
  ) {}

  /** A dedicated connection for a blocking `XREAD`, which monopolises the one it runs on. */
  duplicate(): Redis {
    return this.redis.duplicate();
  }

  // Presence ------------------------------------------------------------------------------------

  async claimPresence(deviceId: string, connection: string): Promise<void> {
    await this.redis.set(
      keys.presence(deviceId),
      connection,
      'EX',
      this.timings.presenceTtlSeconds,
    );
  }

  /** `false` once a newer connection holds the device, or the device was revoked. */
  async refreshPresence(deviceId: string, connection: string): Promise<boolean> {
    const refreshed = await this.redis.eval(
      REFRESH,
      1,
      keys.presence(deviceId),
      connection,
      String(this.timings.presenceTtlSeconds),
    );
    await this.redis.expire(keys.status(deviceId), STATUS_TTL_SECONDS);

    return refreshed === 1;
  }

  async releasePresence(deviceId: string, connection: string): Promise<void> {
    await this.redis.eval(RELEASE, 1, keys.presence(deviceId), connection);
  }

  async online(deviceId: string): Promise<boolean> {
    return (await this.redis.exists(keys.presence(deviceId))) === 1;
  }

  // Status --------------------------------------------------------------------------------------

  async saveStatus(deviceId: string, report: CompanionStatusReport): Promise<void> {
    await this.redis.set(keys.status(deviceId), JSON.stringify(report), 'EX', STATUS_TTL_SECONDS);
  }

  async status(deviceId: string): Promise<CompanionStatusReport | undefined> {
    const raw = await this.redis.get(keys.status(deviceId));

    return raw === null ? undefined : (JSON.parse(raw) as CompanionStatusReport);
  }

  /** Revocation: the device is offline and unreported from now on. */
  async forget(deviceId: string): Promise<void> {
    await this.redis.del(keys.presence(deviceId), keys.status(deviceId));
  }

  // Agent homes (spec 041) ---------------------------------------------------------------------

  /**
   * A sign-in command, live: PUBLISH to the device's channel, which only its open command stream
   * subscribes to. Nothing is stored, so the one-time code is in Redis memory for the instant of
   * delivery and nowhere after. Answers how many connections received it (0: the runner is away).
   */
  publishAuth(deviceId: string, command: CompanionAuthCommand): Promise<number> {
    return this.redis.publish(keys.auth(deviceId), JSON.stringify(command));
  }

  async setSignIn(deviceId: string, signIn: SignIn, ttlSeconds: number): Promise<void> {
    await this.redis.set(keys.signIn(deviceId), JSON.stringify(signIn), 'EX', ttlSeconds);
  }

  async signIn(deviceId: string): Promise<SignIn | undefined> {
    const raw = await this.redis.get(keys.signIn(deviceId));

    return raw === null ? undefined : (JSON.parse(raw) as SignIn);
  }

  async clearSignIn(deviceId: string): Promise<void> {
    await this.redis.del(keys.signIn(deviceId));
  }

  async saveHomeAuth(deviceId: string, auth: HomeAuth): Promise<void> {
    await this.redis.set(
      keys.homeAuth(deviceId),
      JSON.stringify(auth),
      'EX',
      HOME_AUTH_TTL_SECONDS,
    );
  }

  async homeAuth(deviceId: string): Promise<HomeAuth | undefined> {
    const raw = await this.redis.get(keys.homeAuth(deviceId));

    return raw === null ? undefined : (JSON.parse(raw) as HomeAuth);
  }

  /** A new sandbox's verdict is its runner's to give: the previous sandbox's is dropped. */
  async forgetHomeAuth(deviceId: string): Promise<void> {
    await this.redis.del(keys.homeAuth(deviceId));
  }

  /**
   * The cross-process lock on a home's start and stop: the holder's token while this caller holds
   * it, else `undefined`. Released with the token, so a holder that outlived its TTL never frees a
   * lock someone else has taken since.
   */
  async lockHomeStart(homeId: string, ttlSeconds: number): Promise<string | undefined> {
    const token = randomUUID();
    const taken = await this.redis.set(keys.homeStart(homeId), token, 'EX', ttlSeconds, 'NX');

    return taken === 'OK' ? token : undefined;
  }

  async unlockHomeStart(homeId: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE, 1, keys.homeStart(homeId), token);
  }

  /** The egress allowlist last applied to the home's sandbox, comma-joined ('' = open). */
  async homeEgress(deviceId: string): Promise<string | undefined> {
    return (await this.redis.get(keys.homeEgress(deviceId))) ?? undefined;
  }

  async setHomeEgress(deviceId: string, applied: string): Promise<void> {
    await this.redis.set(keys.homeEgress(deviceId), applied, 'EX', HOME_AUTH_TTL_SECONDS);
  }

  /** One hit on a person's fixed-window counter: the count so far, and the seconds it has left. */
  async countHit(
    action: string,
    userId: string,
    windowSeconds: number,
  ): Promise<{ count: number; retryAfter: number }> {
    const key = keys.homeThrottle(action, userId);
    const replies = await this.redis
      .multi()
      .set(key, '0', 'EX', windowSeconds, 'NX')
      .incr(key)
      .ttl(key)
      .exec();

    return { count: Number(replies?.[1]?.[1]), retryAfter: Number(replies?.[2]?.[1]) };
  }

  async setHomeNote(userId: string, message: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(keys.homeNote(userId), message, 'EX', ttlSeconds);
  }

  async homeNote(userId: string): Promise<string | undefined> {
    return (await this.redis.get(keys.homeNote(userId))) ?? undefined;
  }

  async clearHomeNote(userId: string): Promise<void> {
    await this.redis.del(keys.homeNote(userId));
  }

  /** A home's device is gone for good: presence, report, sign-in, verdict and applied egress. */
  async forgetHome(deviceId: string): Promise<void> {
    await this.redis.del(
      keys.presence(deviceId),
      keys.status(deviceId),
      keys.signIn(deviceId),
      keys.homeAuth(deviceId),
      keys.homeEgress(deviceId),
    );
  }

  // Commands ------------------------------------------------------------------------------------

  async publish(deviceId: string, command: CompanionCommand): Promise<void> {
    const key = keys.commands(deviceId);

    await this.redis
      .multi()
      .xadd(key, 'MAXLEN', '~', COMMAND_STREAM_MAXLEN, '*', 'command', JSON.stringify(command))
      .expire(key, STREAM_TTL_SECONDS)
      .exec();
  }

  /** The command stream's last entry id, so a fresh connection starts after it. */
  async lastCommandId(deviceId: string): Promise<string> {
    const [last] = await this.redis.xrevrange(keys.commands(deviceId), '+', '-', 'COUNT', 1);

    return last?.[0] ?? '0-0';
  }

  // Run streams ---------------------------------------------------------------------------------

  /**
   * Appends a batch of turn `turn` under entry id `<seq>-0`, only while that turn is the active one
   * and its byte budget lasts. Redis refuses an id at or below the stream's top, so a retried batch
   * — or the overlap of two — is dropped entry by entry, atomically per entry, with no
   * read-then-write race. Answers how many were new.
   */
  async appendRunEvents(
    runId: string,
    turn: number,
    events: readonly CompanionRunEvent[],
  ): Promise<AppendResult> {
    if ((await this.activeTurn(runId))?.turn !== turn) return { kind: 'not-active' };

    const ordered = orderedBySeq(events);
    const bytes = ordered.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
    const budget = keys.runBytes(runId, turn);
    const spent = await this.redis
      .multi()
      .incrby(budget, bytes)
      .expire(budget, STREAM_TTL_SECONDS)
      .exec();

    if (Number(spent?.[0]?.[1]) > this.timings.runEventBudgetBytes) return { kind: 'over-budget' };

    const key = keys.runEvents(runId, turn);
    const pipeline = this.redis.pipeline();

    for (const event of ordered) {
      pipeline.xadd(
        key,
        'MAXLEN',
        '~',
        RUN_STREAM_MAXLEN,
        `${String(event.seq)}-0`,
        'event',
        JSON.stringify(event),
      );
    }

    pipeline.expire(key, STREAM_TTL_SECONDS);

    const results = (await pipeline.exec()) ?? [];
    let accepted = 0;

    for (const [error] of results.slice(0, -1)) {
      if (error === null) {
        accepted += 1;
      } else if (!/equal or smaller/i.test(error.message)) {
        throw error;
      }
    }

    return { accepted, kind: 'appended' };
  }

  /** Tells the executor to end the run now: it interrupts the device and fails the run. */
  async abortRun(runId: string, reason: RunAbortReason): Promise<void> {
    const key = keys.runControl(runId);

    await this.redis.multi().xadd(key, '*', 'abort', reason).expire(key, STREAM_TTL_SECONDS).exec();
  }

  async beginTurn(runId: string, turn: number, startedAt: number): Promise<void> {
    const marker = keys.runTurn(runId);

    await this.redis
      .multi()
      .del(
        keys.runEvents(runId, turn),
        keys.runBytes(runId, turn),
        keys.runControl(runId),
        keys.runCursor(runId),
      )
      .hset(marker, { startedAt: String(startedAt), turn: String(turn) })
      .expire(marker, STREAM_TTL_SECONDS)
      .exec();
  }

  async markTurn(runId: string, turn: number, startedAt: number): Promise<void> {
    const marker = keys.runTurn(runId);

    await this.redis
      .multi()
      .hset(marker, { startedAt: String(startedAt), turn: String(turn) })
      .expire(marker, STREAM_TTL_SECONDS)
      .exec();
  }

  async activeTurn(runId: string): Promise<ActiveTurn | undefined> {
    const stored = await this.redis.hgetall(keys.runTurn(runId));

    return stored.turn === undefined
      ? undefined
      : { startedAt: Number(stored.startedAt), turn: Number(stored.turn) };
  }

  async endTurn(runId: string): Promise<void> {
    await this.redis.del(keys.runTurn(runId));
  }

  /** A run over with no attempt to clean up after it: its turn, control and cursor. */
  async clearRun(runId: string): Promise<void> {
    await this.redis.del(keys.runTurn(runId), keys.runControl(runId), keys.runCursor(runId));
  }

  reader(): RunReader {
    const client = this.duplicate();

    return {
      close: () => client.disconnect(),
      read: async (runId, turn, cursor, blockMs) => {
        const events = keys.runEvents(runId, turn);
        const reply = await client.xread(
          'COUNT',
          256,
          'BLOCK',
          blockMs,
          'STREAMS',
          events,
          keys.runControl(runId),
          cursor.events,
          cursor.control,
        );
        const read: RunRead = { aborts: [], events: [] };

        for (const [key, entries] of reply ?? []) {
          for (const [id, [field, raw = 'null']] of entries) {
            if (key === events) {
              read.events.push({ event: JSON.parse(raw) as CompanionRunEvent, id });
            } else if (field === 'abort') {
              read.aborts.push({ id, reason: raw as RunAbortReason });
            }
          }
        }

        return read;
      },
    };
  }

  async cursor(runId: string): Promise<RunCursor> {
    const stored = await this.redis.hgetall(keys.runCursor(runId));

    return { control: stored.control ?? START.control, events: stored.events ?? START.events };
  }

  async saveCursor(runId: string, cursor: RunCursor): Promise<void> {
    const key = keys.runCursor(runId);

    await this.redis
      .multi()
      .hset(key, { control: cursor.control, events: cursor.events })
      .expire(key, STREAM_TTL_SECONDS)
      .exec();
  }
}

/** Ascending and unique by `seq`: an unordered batch would otherwise refuse its own later half. */
export function orderedBySeq(events: readonly CompanionRunEvent[]): CompanionRunEvent[] {
  const bySeq = new Map<number, CompanionRunEvent>();

  for (const event of events) {
    if (!bySeq.has(event.seq)) bySeq.set(event.seq, event);
  }

  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}
