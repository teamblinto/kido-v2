import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type CompanionAuthEvent,
  type RunStatus,
  SUBSCRIPTION_SIGN_IN_TTL_SECONDS,
  type SubscriptionProvider,
  type SubscriptionStatus,
} from '@repo/contracts';
import type { AgentHomeRow, LocalAgentDeviceRow } from '@repo/db';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import { ConflictError, DomainError, RateLimitedError } from '../../common/errors/domain-error';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { DaytonaAdapter } from '../sandbox/daytona.adapter';
import { DaytonaError } from '../sandbox/sandbox.errors';
import { TemplateVersions } from '../sandbox/template-versions';
import { AgentHomeRepository } from './agent-home.repository';
import { LIVE_RUN_STATUSES, LocalAgentRepository } from './local-agent.repository';
import { type HomeAuth, LocalAgentStore } from './local-agent.store';
import { mintDeviceToken, sha256 } from './secrets';

const PROVIDER: SubscriptionProvider = 'claude';
/** The daemon session the runner lives in; deleting it kills the runner. */
const RUNNER_SESSION = 'baios-runner';
const RUNNER_DIR = '/opt/baios';
/** `.mjs`, so Node runs the ESM bundle as ESM whatever package.json sits above it. */
const RUNNER_PATH = `${RUNNER_DIR}/runner.mjs`;
const TOKEN_PATH = `${RUNNER_DIR}/token`;
const CLAUDE_CONFIG_DIR = '/home/daytona/.claude';
/** Daytona archives a home stopped this long (minutes); the disk, and the sign-in, survive it. */
const ARCHIVE_AFTER_MINUTES = 7 * 24 * 60;
/** An unclaimed agent-home sandbox younger than this may be a provision in flight. */
const ORPHAN_GRACE_MS = 10 * 60_000;
/** Runs that keep a home up: a queued one is about to need it. */
const BUSY_RUN_STATUSES: readonly RunStatus[] = ['queued', ...LIVE_RUN_STATUSES];
/** Per person, fixed windows: enough for a person, too few to churn sandboxes or flood a runner. */
const LIMITS = {
  cancel: { limit: 10, windowSeconds: 600 },
  code: { limit: 10, windowSeconds: 600 },
  connect: { limit: 5, windowSeconds: 3_600 },
} as const;
/** How long a disconnect's note stays on the person's status. */
const NOTE_TTL_SECONDS = 7 * 86_400;
export const AGENT_HOME_LABEL = 'agent-home';

const SIGNED_OUT = 'Sign in again to reconnect your Claude subscription.';
const UNREACHABLE = 'Your cloud workspace could not be reached — try again in a minute.';
const STOP_FAILED = 'Your cloud workspace did not stop cleanly. Connect again to restart it.';
const REVOKE_YOURSELF =
  'Your cloud workspace was deleted, but Claude could not be signed out there first. If you had ' +
  'signed in, you can end that session from your Claude account settings.';

/** Where the companion build leaves its bundle, from `src/` and `dist/` alike (same depth). */
export const DEFAULT_RUNNER_BUNDLE = path.resolve(__dirname, '../../../../companion/dist/main.js');

export const AGENT_HOME_TIMINGS = Symbol('forge.local-agent.agent-home-timings');

export interface AgentHomeTimings {
  /**
   * A run's cap on a home start (design: 120 s): the wait for another start's lock, the create or
   * adopt, the sandbox reaching `started` and the runner's presence, all in one budget.
   */
  readonly onlineMs: number;
  /** Added to `onlineMs` for a connect's start, which runs in the background and may pull the snapshot. */
  readonly sandboxReadyMs: number;
  /** How long to wait for the runner's next status report (after a start, after a logout). */
  readonly reportMs: number;
  /** Disconnect starts an offline home for at most this long, to sign its CLI out. */
  readonly disconnectStartMs: number;
  readonly pollMs: number;
}

export const DEFAULT_AGENT_HOME_TIMINGS: AgentHomeTimings = Object.freeze({
  disconnectStartMs: 45_000,
  onlineMs: 120_000,
  pollMs: 1_000,
  reportMs: 10_000,
  sandboxReadyMs: 300_000,
});

/** What lets a run's executor give up on a home start: its fence signal and its cancel check. */
export interface StartAbort {
  readonly signal: AbortSignal;
  cancelled(): Promise<boolean>;
}

/** Bash single quoting. */
const quote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

/** The verdict, only if it was given since `since` (server time); an older one is not this home's. */
function verdictSince(auth: HomeAuth | undefined, since: Date | null): HomeAuth | undefined {
  return auth !== undefined && (since === null || Date.parse(auth.checkedAt) >= since.getTime())
    ? auth
    : undefined;
}

/**
 * A person's agent home (spec 041 design): the private Daytona sandbox, created from the
 * `agent-home` template, in which their own Claude Code runs under the hosted companion ("runner").
 * Provisioning, start (a fresh device token on every start, the runner bundle uploaded each time,
 * the egress allowlist re-applied), stop and delete; the sign-in commands, delivered live over the
 * runner's command stream and never stored; and the person-facing status, composed from the row,
 * presence, the runner's last `claude auth status` verdict and the sign-in in progress.
 *
 * Never logged: a device token, the one-time code. Never read: the home's `~/.claude`.
 */
@Injectable()
export class AgentHomeService {
  private readonly logger = new Logger(AgentHomeService.name);
  readonly enabled: boolean;
  private readonly serverUrl: string | undefined;
  private readonly insecure: boolean;
  private readonly egress: readonly string[];
  private readonly idleMs: number;
  private readonly unusedMs: number;
  private readonly bundlePath: string;
  private readonly owner: string;
  private readonly lockSeconds: number;
  /** Connects in flight in this process, by person. */
  private readonly connecting = new Map<string, Promise<void>>();
  /** Starts in flight in this process, by home: callers share one (the Redis lock spans processes). */
  private readonly starting = new Map<string, Promise<boolean>>();

  constructor(
    @Inject(AgentHomeRepository) private readonly homes: AgentHomeRepository,
    @Inject(LocalAgentRepository) private readonly devices: LocalAgentRepository,
    @Inject(LocalAgentStore) private readonly store: LocalAgentStore,
    @Inject(DaytonaAdapter) private readonly daytona: DaytonaAdapter,
    @Inject(TemplateVersions) private readonly versions: TemplateVersions,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(AGENT_HOME_TIMINGS) private readonly timings: AgentHomeTimings,
    @Inject(ConfigService) config: ConfigService<Environment, true>,
  ) {
    this.enabled =
      config.get('AGENT_HOME_ENABLED', { infer: true }) &&
      config.get('LOCAL_AGENT_ENABLED', { infer: true });
    this.serverUrl = config.get('AGENT_HOME_SERVER_URL', { infer: true });
    this.insecure = config.get('DEPLOY_ENV', { infer: true }) === 'local';
    this.egress = config.get('AGENT_HOME_EGRESS_ALLOW_CIDRS', { infer: true });
    this.idleMs = config.get('AGENT_HOME_IDLE_MINUTES', { infer: true }) * 60_000;
    this.unusedMs = config.get('AGENT_HOME_UNUSED_DAYS', { infer: true }) * 86_400_000;
    this.bundlePath =
      config.get('AGENT_HOME_RUNNER_BUNDLE', { infer: true }) ?? DEFAULT_RUNNER_BUNDLE;
    this.owner = config.get('SANDBOX_OWNER', { infer: true });
    // Outlives the longest holder: a connect's start.
    this.lockSeconds = Math.ceil((timings.sandboxReadyMs + timings.onlineMs) / 1_000);
  }

  // Person-facing ---------------------------------------------------------------------------------

  async status(userId: string): Promise<SubscriptionStatus> {
    return this.compose(
      userId,
      this.enabled ? await this.homes.forUser(userId, PROVIDER) : undefined,
    );
  }

  /**
   * Whether this person may connect a subscription at all.
   *
   * product: entitlement gate — every signed-in person may today; a plan check goes here.
   */
  canConnectSubscription(_userId: string): boolean {
    return true;
  }

  /**
   * Provisions the home if there is none, starts it, and once the runner is online asks it to begin
   * Anthropic's sign-in — unless this start's verdict is already signed in. Answers at once (202):
   * the slow part runs here in the background and the person polls the status.
   */
  async connect(userId: string): Promise<SubscriptionStatus> {
    this.assertEnabled();

    if (!this.canConnectSubscription(userId)) {
      throw new DomainError(
        'subscription-unavailable',
        'Running Claude Code on your own subscription is not part of your plan.',
      );
    }

    await this.throttle(userId, 'connect');
    const home = await this.homes.findOrCreate(userId, PROVIDER, sha256(mintDeviceToken()));
    await this.store.clearHomeNote(userId);

    if (!this.connecting.has(userId)) {
      const online = home.state !== 'stopping' && (await this.store.online(home.deviceId));

      if (online) {
        // A runner that came up after a start gave up on it: the home is running after all.
        if (home.state !== 'running') {
          await this.homes.update(home.id, { lastError: null, state: 'running' });
        }
      } else {
        await this.homes.update(home.id, {
          lastError: null,
          state: home.daytonaId === null ? 'provisioning' : 'starting',
        });
      }

      const job = (
        online
          ? Promise.resolve(true)
          : this.start(home, this.timings.sandboxReadyMs + this.timings.onlineMs, true)
      )
        .then((up) => (up ? this.requestSignIn(home.deviceId) : undefined))
        .catch((error: unknown) => {
          this.logger.warn(`agent home connect failed: user=${userId} ${describe(error)}`);
        })
        .finally(() => this.connecting.delete(userId));
      this.connecting.set(userId, job);
    }

    return this.status(userId);
  }

  /**
   * The one-time code, to the runner and nowhere else: a live PUBLISH on the device's sign-in
   * channel (never the durable command stream, Postgres, a log or the audit trail).
   */
  async submitCode(userId: string, code: string): Promise<void> {
    this.assertEnabled();
    await this.throttle(userId, 'code');
    const home = await this.homes.forUser(userId, PROVIDER);
    const signIn = home === undefined ? undefined : await this.store.signIn(home.deviceId);

    if (home === undefined || signIn?.phase !== 'url') {
      throw new ConflictError('No Claude sign-in is waiting for a code. Start connecting again.', {
        reason: 'no-sign-in',
      });
    }

    const delivered = await this.store.publishAuth(home.deviceId, {
      code,
      provider: PROVIDER,
      type: 'auth.login.code',
    });

    if (delivered === 0) {
      throw new ConflictError(UNREACHABLE, { reason: 'home-offline' });
    }

    await this.store.setSignIn(
      home.deviceId,
      { phase: 'verifying' },
      SUBSCRIPTION_SIGN_IN_TTL_SECONDS,
    );
  }

  async cancel(userId: string): Promise<void> {
    this.assertEnabled();
    await this.throttle(userId, 'cancel');
    const home = await this.homes.forUser(userId, PROVIDER);

    if (home === undefined) return;

    await this.store.publishAuth(home.deviceId, { provider: PROVIDER, type: 'auth.login.cancel' });
    await this.store.clearSignIn(home.deviceId);
  }

  /**
   * `claude auth logout` in the home — started for it, within `disconnectStartMs`, if it is away —
   * then the sandbox, the device and the row go. Runs still on it are aborted as a revoked device's
   * are. When the logout could not be confirmed, the person's status says how to end the session
   * at Claude themselves.
   */
  async disconnect(userId: string): Promise<void> {
    this.assertEnabled();
    const home = await this.homes.forUser(userId, PROVIDER);

    if (home === undefined) return;

    const signedOut = await this.signOut(home);

    await this.deleteHome(home);

    if (!signedOut) await this.store.setHomeNote(userId, REVOKE_YOURSELF, NOTE_TTL_SECONDS);

    this.logger.log(`agent home deleted: user=${userId} home=${home.id} signedOut=${signedOut}`);
  }

  // Runner-facing ---------------------------------------------------------------------------------

  /** `POST /local-agent/auth` from a home's runner. The URL is fine to keep briefly; no code is. */
  async onAuthEvent(device: LocalAgentDeviceRow, event: CompanionAuthEvent): Promise<void> {
    const ttl = SUBSCRIPTION_SIGN_IN_TTL_SECONDS;

    if (event.type === 'auth.login.url') {
      const expiresAt = new Date(this.now() + ttl * 1_000).toISOString();
      await this.store.setSignIn(device.id, { expiresAt, phase: 'url', url: event.url }, ttl);
      return;
    }

    // Success is the next status report's `authenticated` verdict, not this flag alone.
    await this.store.setSignIn(
      device.id,
      event.ok
        ? { phase: 'verifying' }
        : { message: event.message ?? 'The sign-in did not complete.', phase: 'failed' },
      ttl,
    );
  }

  /** A home's runner reported: one marked `error` by a start that gave up on it is running. */
  async onReport(deviceId: string): Promise<void> {
    await this.homes.recover(deviceId);
  }

  // Runs ------------------------------------------------------------------------------------------

  async isHome(deviceId: string): Promise<boolean> {
    return (await this.homes.byDevice(deviceId)) !== undefined;
  }

  /**
   * The executor's wake-up: a run on a home whose runner is away starts the home and waits for the
   * runner, `onlineMs` at most in all, giving up at once on the run's cancel or fence (the start
   * itself carries on, bounded, for whoever asks next). `last_used_at` is bumped first, so an idle
   * stop deciding meanwhile spares the home. `not-a-home` for a person's own computer.
   */
  async wake(
    deviceId: string,
    abort?: StartAbort,
  ): Promise<'online' | 'failed' | 'cancelled' | 'not-a-home'> {
    // One statement: an idle stop that claimed the home first shows here as `stopping`.
    const home = await this.homes.touchDevice(deviceId, this.clock.now());

    if (home === undefined) return 'not-a-home';

    // A home being stopped still shows its runner for a moment: wait for the stop, then start.
    if (home.state !== 'stopping' && (await this.store.online(deviceId))) {
      if (home.state !== 'running') {
        await this.homes.update(home.id, { lastError: null, state: 'running' });
      }
      return 'online';
    }

    const deadline = this.now() + this.timings.onlineMs;

    return this.within(this.start(home, this.timings.onlineMs, true), deadline, abort);
  }

  /**
   * Run admission, in the create's transaction: the person's home, if it exists and its runner's
   * last verdict — given since the current sandbox was created — is `authenticated` (a stopped home
   * still qualifies: the attempt wakes it).
   */
  async admissible(
    tx: TenantTransaction,
    userId: string,
    provider: SubscriptionProvider,
  ): Promise<AgentHomeRow | undefined> {
    const home = await this.homes.forUserOn(tx, userId, provider);

    if (home === undefined || home.state === 'error') return undefined;

    const auth = verdictSince(await this.store.homeAuth(home.deviceId), home.sandboxCreatedAt);

    return auth?.status === 'authenticated' ? home : undefined;
  }

  async touchDevice(deviceId: string): Promise<void> {
    await this.homes.touchDevice(deviceId, this.clock.now());
  }

  // Lifecycle (cron) ------------------------------------------------------------------------------

  /**
   * Running homes unused past the idle limit, with no queued or live run and no sign-in under way.
   * Under the home's start lock, and claimed by a conditional update (`running`, still unused), so
   * a run that touched the home since the read keeps it running.
   */
  async idleStop(): Promise<number> {
    const cutoff = new Date(this.now() - this.idleMs);
    let stopped = 0;

    for (const home of await this.homes.inStates(['running'])) {
      if ((home.lastUsedAt ?? home.updatedAt) >= cutoff) continue;

      const token = await this.store.lockHomeStart(home.id, this.lockSeconds);

      if (token === undefined) continue;

      try {
        if ((await this.devices.liveRunsOf(home.deviceId, BUSY_RUN_STATUSES)).length > 0) continue;
        if ((await this.store.signIn(home.deviceId)) !== undefined) continue;

        const claimed = await this.homes.claimIdle(home.id, cutoff);

        if (claimed === undefined) continue;

        await this.stop(claimed);
        stopped += 1;
        this.logger.log(`agent home stopped (idle): home=${home.id}`);
      } catch (error) {
        this.logger.warn(`agent home idle stop failed: home=${home.id} ${describe(error)}`);
      } finally {
        await this.store.unlockHomeStart(home.id, token);
      }
    }

    return stopped;
  }

  /**
   * A home whose sandbox vanished is `error` and its verdict forgotten; an agent-home sandbox with no
   * home is deleted; a running home whose applied egress allowlist is not the configured one gets it
   * now — and is stopped (fail closed) if an allowlist is configured and cannot be applied.
   */
  async reconcile(): Promise<{ egress: number; missing: number; orphaned: number }> {
    const listed = await this.daytona.listByLabels({ baios: AGENT_HOME_LABEL, owner: this.owner });
    const byId = new Map(listed.map((dto) => [dto.id, dto]));
    const rows = await this.homes.withSandbox();
    const claimed = new Set(rows.map((row) => row.daytonaId));
    const report = { egress: 0, missing: 0, orphaned: 0 };
    const wanted = this.egress.join(',');

    for (const row of rows) {
      if (byId.has(row.daytonaId!) || (await this.exists(row.daytonaId!))) {
        if (
          row.state === 'running' &&
          ((await this.store.homeEgress(row.deviceId)) ?? '') !== wanted
        ) {
          await this.refreshEgress(row);
          report.egress += 1;
        }
        continue;
      }
      await this.homes.update(row.id, {
        daytonaId: null,
        lastError: 'The cloud workspace was removed. Connect again to recreate it.',
        sandboxCreatedAt: null,
        state: 'error',
      });
      // Its successor is a new sandbox, signed out: nothing of this one's verdict may admit a run.
      await this.store.forgetHome(row.deviceId);
      report.missing += 1;
    }

    for (const dto of listed) {
      if (claimed.has(dto.id) || dto.createdAt === undefined) continue;
      if (new Date(dto.createdAt).getTime() > this.now() - ORPHAN_GRACE_MS) continue;
      await this.daytona.remove(dto.id);
      this.logger.warn(`orphan agent home removed: daytonaId=${dto.id}`);
      report.orphaned += 1;
    }

    return report;
  }

  /**
   * Homes not signed in — never, or no longer — and unused for `AGENT_HOME_UNUSED_DAYS`, with no run
   * and no sign-in under way: the device is revoked, the sandbox and the row deleted.
   */
  async sweepUnused(): Promise<number> {
    let removed = 0;

    for (const home of await this.homes.unusedSince(new Date(this.now() - this.unusedMs))) {
      const auth = verdictSince(await this.store.homeAuth(home.deviceId), home.sandboxCreatedAt);

      if (auth?.status === 'authenticated') continue;
      if ((await this.store.signIn(home.deviceId)) !== undefined) continue;
      if ((await this.devices.liveRunsOf(home.deviceId, BUSY_RUN_STATUSES)).length > 0) continue;

      const token = await this.store.lockHomeStart(home.id, this.lockSeconds);

      if (token === undefined) continue;

      try {
        await this.deleteHome(home);
        removed += 1;
        this.logger.log(`unused agent home deleted: home=${home.id}`);
      } catch (error) {
        this.logger.warn(`unused agent home not deleted: home=${home.id} ${describe(error)}`);
      } finally {
        await this.store.unlockHomeStart(home.id, token);
      }
    }

    return removed;
  }

  /**
   * Superseded `agent-home` snapshots, as `PoolRefill` retires a project template's: the current
   * version and the one before it stay (homes created from it may still be starting); each older
   * `ready` one has its snapshot removed, then its row retired. A refusal leaves it for next time.
   */
  async retireTemplates(): Promise<number> {
    const older = (await this.versions.retirable(AGENT_HOME_LABEL))
      .sort((a, b) => (b.readyAt?.getTime() ?? 0) - (a.readyAt?.getTime() ?? 0))
      .slice(1);
    let retired = 0;

    for (const version of older) {
      try {
        await this.daytona.removeSnapshot(version.snapshot);
      } catch (error) {
        if (!(error instanceof DaytonaError)) throw error;
        this.logger.warn(`agent-home snapshot ${version.snapshot} not removed (${error.kind})`);
        continue;
      }
      await this.versions.retire(version, this.clock.now());
      retired += 1;
    }

    return retired;
  }

  // Internals -------------------------------------------------------------------------------------

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new DomainError(
        'subscription-unavailable',
        'Running Claude Code on your own subscription is not available on this deployment.',
      );
    }
  }

  private async throttle(userId: string, action: keyof typeof LIMITS): Promise<void> {
    const { limit, windowSeconds } = LIMITS[action];
    const { count, retryAfter } = await this.store.countHit(action, userId, windowSeconds);

    if (count > limit) {
      throw new RateLimitedError(
        'Too many tries with your Claude subscription just now. Wait a little and try again.',
        retryAfter,
      );
    }
  }

  /**
   * `auth.login.start`, unless the runner says it is signed in — in a verdict given since this
   * start (one from before it may predate a sign-out); the runner's first report is waited for.
   */
  private async requestSignIn(deviceId: string): Promise<void> {
    const home = await this.homes.byDevice(deviceId);

    if (home === undefined) return;

    const since = home.startedAt ?? home.sandboxCreatedAt;
    const deadline = this.now() + this.timings.reportMs;
    let auth = verdictSince(await this.store.homeAuth(deviceId), since);

    while (auth === undefined && this.now() < deadline) {
      await sleep(this.timings.pollMs);
      auth = verdictSince(await this.store.homeAuth(deviceId), since);
    }

    if (auth?.status === 'authenticated') return;

    await this.store.setSignIn(deviceId, { phase: 'requested' }, SUBSCRIPTION_SIGN_IN_TTL_SECONDS);
    const delivered = await this.store.publishAuth(deviceId, {
      provider: PROVIDER,
      type: 'auth.login.start',
    });

    if (delivered === 0) {
      await this.store.setSignIn(
        deviceId,
        { message: UNREACHABLE, phase: 'failed' },
        SUBSCRIPTION_SIGN_IN_TTL_SECONDS,
      );
    }
  }

  /** `claude auth logout` in the home, started (bounded) if it is away: whether it was confirmed. */
  private async signOut(home: AgentHomeRow): Promise<boolean> {
    const online =
      (home.state !== 'stopping' && (await this.store.online(home.deviceId))) ||
      (home.daytonaId !== null &&
        (await this.within(
          this.start(home, this.timings.disconnectStartMs, false),
          this.now() + this.timings.disconnectStartMs,
        )) === 'online');

    if (!online) return false;

    const sent = this.clock.now();
    const delivered = await this.store.publishAuth(home.deviceId, {
      provider: PROVIDER,
      type: 'auth.logout',
    });

    if (delivered === 0) return false;

    const deadline = this.now() + this.timings.reportMs;

    for (;;) {
      const auth = verdictSince(await this.store.homeAuth(home.deviceId), sent);
      if (auth !== undefined && auth.status !== 'authenticated') return true;
      if (this.now() >= deadline) return false;
      await sleep(this.timings.pollMs);
    }
  }

  /** The sandbox, the device (revoked), the row and every key; runs on it are aborted. */
  private async deleteHome(home: AgentHomeRow): Promise<void> {
    if (home.daytonaId !== null) await this.daytona.remove(home.daytonaId);

    await this.homes.remove(home, this.clock.now());
    await this.store.forgetHome(home.deviceId);

    for (const run of await this.devices.liveRunsOf(home.deviceId)) {
      await this.store.abortRun(run.runId, 'revoked');
    }
  }

  /** One start of this home at a time in this process, within `budgetMs`: true once online. */
  private start(home: AgentHomeRow, budgetMs: number, provision: boolean): Promise<boolean> {
    let job = this.starting.get(home.id);

    if (job === undefined) {
      job = this.ensureRunning(home, this.now() + budgetMs, provision)
        .then(
          () => true,
          (error: unknown) => {
            this.logger.warn(`agent home start failed: home=${home.id} ${describe(error)}`);
            return false;
          },
        )
        .finally(() => this.starting.delete(home.id));
      this.starting.set(home.id, job);
    }

    return job;
  }

  /** Waits for `job` until `deadline`, or a cancel (`cancelled`) or a fence (throws its reason). */
  private async within(
    job: Promise<boolean>,
    deadline: number,
    abort?: StartAbort,
  ): Promise<'online' | 'failed' | 'cancelled'> {
    let settled: boolean | undefined;
    void job.then((up) => (settled = up));

    for (;;) {
      if (settled !== undefined) return settled ? 'online' : 'failed';
      if (abort?.signal.aborted === true) throw abort.signal.reason as Error;
      if (abort !== undefined && (await abort.cancelled())) return 'cancelled';
      if (this.now() >= deadline) return 'failed';
      await Promise.race([job, sleep(this.timings.pollMs)]);
    }
  }

  /**
   * Provision if needed (and allowed), start the sandbox, apply the egress allowlist, hand the
   * runner a fresh token and bundle, start it, and wait for its presence — all by `deadline`. One
   * start (or stop) per home across processes: a caller that finds the lock held waits for that
   * holder's runner, or for the lock, within the same deadline.
   */
  private async ensureRunning(
    home: AgentHomeRow,
    deadline: number,
    provision: boolean,
  ): Promise<void> {
    let token: string | undefined;

    for (;;) {
      token = await this.store.lockHomeStart(home.id, this.lockSeconds);
      if (token !== undefined) break;
      const current = await this.homes.byDevice(home.deviceId);
      if (current === undefined) throw new Error('the home was deleted');
      if (current.state !== 'stopping' && (await this.store.online(home.deviceId))) return;
      if (this.now() >= deadline) throw new Error('another start or stop held the home too long');
      await sleep(this.timings.pollMs);
    }

    try {
      const current = await this.homes.byDevice(home.deviceId);

      if (current === undefined) throw new Error('the home was deleted');

      // The holder we waited for brought it up.
      if (await this.store.online(home.deviceId)) {
        if (current.state !== 'running') {
          await this.homes.update(home.id, { lastError: null, state: 'running' });
        }
        return;
      }

      await this.homes.update(home.id, { startedAt: this.clock.now() });
      const daytonaId = await this.sandboxStarted(current, deadline, provision);
      await this.homes.update(home.id, { state: 'starting' });
      await this.applyEgress(current.deviceId, daytonaId);
      await this.startRunner(current, daytonaId);

      if (!(await this.waitOnline(home.deviceId, deadline))) {
        throw new Error('the runner did not come online in time');
      }

      await this.homes.update(home.id, {
        lastError: null,
        lastUsedAt: this.clock.now(),
        state: 'running',
      });
      this.logger.log(`agent home running: home=${home.id} daytonaId=${daytonaId}`);
    } catch (error) {
      await this.homes.update(home.id, { lastError: UNREACHABLE, state: 'error' });
      throw error;
    } finally {
      await this.store.unlockHomeStart(home.id, token);
    }
  }

  /** The home's sandbox in `started` by `deadline`: created from the current version if missing. */
  private async sandboxStarted(
    home: AgentHomeRow,
    deadline: number,
    provision: boolean,
  ): Promise<string> {
    let daytonaId = home.daytonaId;
    let state = daytonaId === null ? undefined : await this.stateOf(daytonaId);

    if (daytonaId === null || state === undefined) {
      if (!provision) throw new Error('the sandbox is gone');

      const version = await this.versions.current(AGENT_HOME_LABEL);

      if (version === null) {
        throw new DomainError(
          'subscription-unavailable',
          'The cloud workspace image is not published on this deployment yet.',
        );
      }

      await this.homes.update(home.id, { state: 'provisioning' });
      // A new sandbox's CLI is signed out: the old one's verdict must not admit a run or skip sign-in.
      await this.store.forgetHomeAuth(home.deviceId);
      const labels = {
        baios: AGENT_HOME_LABEL,
        owner: this.owner,
        provider: PROVIDER,
        userId: home.userId,
      };
      let created: { id: string; state: string };
      try {
        created = await this.daytona.create({
          autoArchiveInterval: ARCHIVE_AFTER_MINUTES,
          labels,
          snapshot: version.snapshot,
        });
      } catch (error) {
        // A first create from a new snapshot can outlast the request timeout while Daytona still
        // creates it: adopt the person's sandbox if it appeared, rather than leave an orphan.
        if (!(error instanceof DaytonaError) || !error.retryable) throw error;
        let adopted: { id: string; state: string } | undefined;
        while (adopted === undefined && this.now() < deadline) {
          [adopted] = await this.daytona.listByLabels(labels);
          if (adopted === undefined) await sleep(this.timings.pollMs);
        }
        if (adopted === undefined) throw error;
        created = adopted;
      }
      daytonaId = created.id;
      state = created.state;
      await this.homes.update(home.id, { daytonaId, sandboxCreatedAt: this.clock.now() });
    }

    while (state !== 'started') {
      if (state === 'stopped' || state === 'archived') await this.daytona.start(daytonaId);
      if (state === 'error' || state === 'build_failed' || state === undefined) {
        throw new Error(`the sandbox is ${state ?? 'gone'}`);
      }
      if (this.now() >= deadline) throw new Error(`the sandbox stayed ${state}`);
      await sleep(this.timings.pollMs);
      state = await this.stateOf(daytonaId);
    }

    return daytonaId;
  }

  /**
   * The configured egress allowlist onto the sandbox, on every start (idempotent) and when the
   * configuration changed under a running home. A failure throws: with an allowlist configured, a
   * home it cannot be applied to never runs (fail closed).
   */
  private async applyEgress(deviceId: string, daytonaId: string): Promise<void> {
    const wanted = this.egress.join(',');

    // Never restricted and none wanted: nothing to send (local Daytona).
    if (wanted === '' && ((await this.store.homeEgress(deviceId)) ?? '') === '') return;

    await this.daytona.setNetwork(daytonaId, { allowList: this.egress, blockAll: false });
    await this.store.setHomeEgress(deviceId, wanted);
  }

  private async refreshEgress(home: AgentHomeRow): Promise<void> {
    try {
      await this.applyEgress(home.deviceId, home.daytonaId!);
    } catch (error) {
      this.logger.warn(`agent home egress not applied: home=${home.id} ${describe(error)}`);
      if (this.egress.length > 0) await this.stop(home);
    }
  }

  /** A fresh token (the previous one stops working), the bundle, and the runner in its session. */
  private async startRunner(home: AgentHomeRow, daytonaId: string): Promise<void> {
    if (this.serverUrl === undefined) throw new Error('AGENT_HOME_SERVER_URL is not set');

    const bundle = await readFile(this.bundlePath);
    const token = mintDeviceToken();

    await this.homes.rotateToken(home.deviceId, sha256(token));
    await this.daytona.upload(daytonaId, RUNNER_PATH, bundle);
    await this.daytona.upload(daytonaId, TOKEN_PATH, Buffer.from(token));
    const chmod = await this.daytona.execute(daytonaId, {
      command: `chmod 600 ${TOKEN_PATH}`,
      cwd: RUNNER_DIR,
      timeoutSeconds: 10,
    });

    if (chmod.timedOut || chmod.exitCode !== 0) throw new Error('could not protect the token file');

    const env = [
      `BAIOS_SERVER_URL=${quote(this.serverUrl)}`,
      `BAIOS_TOKEN_FILE=${TOKEN_PATH}`,
      ...(this.insecure ? ['BAIOS_ALLOW_INSECURE_HTTP=1'] : []),
      `CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR}`,
      'DISABLE_AUTOUPDATER=1',
      'PATH="$HOME/.local/bin:$PATH"',
    ];

    await this.daytona.startSession(
      daytonaId,
      RUNNER_SESSION,
      `cd ${RUNNER_DIR} && env ${env.join(' ')} node ${RUNNER_PATH} start --hosted >> ${RUNNER_DIR}/runner.log 2>&1`,
    );
  }

  /** Runner session, then sandbox; a sandbox Daytona would not stop leaves the home `error`. */
  private async stop(home: AgentHomeRow): Promise<void> {
    await this.homes.update(home.id, { state: 'stopping' });

    if (home.daytonaId !== null) {
      await this.daytona.stopSession(home.daytonaId, RUNNER_SESSION).catch(() => undefined);
      try {
        await this.daytona.stop(home.daytonaId);
      } catch (error) {
        await this.homes.update(home.id, { lastError: STOP_FAILED, state: 'error' });
        throw error;
      }
    }

    await this.store.forget(home.deviceId);
    await this.homes.update(home.id, { state: 'stopped' });
  }

  private async waitOnline(deviceId: string, deadline: number): Promise<boolean> {
    for (;;) {
      if (await this.store.online(deviceId)) return true;
      if (this.now() >= deadline) return false;
      await sleep(this.timings.pollMs);
    }
  }

  /** `undefined` when Daytona no longer has it. */
  private async stateOf(daytonaId: string): Promise<string | undefined> {
    try {
      return (await this.daytona.describe(daytonaId)).state;
    } catch (error) {
      if (error instanceof DaytonaError && error.kind === 'sandbox-not-found') return undefined;
      throw error;
    }
  }

  private async exists(daytonaId: string): Promise<boolean> {
    return (await this.stateOf(daytonaId)) !== undefined;
  }

  private now(): number {
    return this.clock.now().getTime();
  }

  /** The person's status, from the row, the runner's verdict and the sign-in under way. */
  private async compose(
    userId: string,
    home: AgentHomeRow | undefined,
  ): Promise<SubscriptionStatus> {
    const now = this.clock.now();
    const base = {
      message: null,
      plan: null,
      provider: PROVIDER,
      signIn: null,
      updatedAt: (home?.updatedAt ?? now).toISOString(),
    } as const;

    if (!this.enabled) {
      return {
        ...base,
        message: 'Not available on this deployment.',
        state: 'disconnected',
      };
    }

    if (home === undefined) {
      return {
        ...base,
        message: (await this.store.homeNote(userId)) ?? null,
        state: 'disconnected',
      };
    }

    const [auth, signIn] = await Promise.all([
      this.store.homeAuth(home.deviceId),
      this.store.signIn(home.deviceId),
    ]);

    return composeStatus({
      auth: verdictSince(auth, home.sandboxCreatedAt),
      base,
      home,
      now,
      signIn,
    });
  }
}

/** Pure, for the unit tests: the status the person sees (design.md § Person-facing API). */
export function composeStatus(input: {
  auth: Awaited<ReturnType<LocalAgentStore['homeAuth']>>;
  home: Pick<AgentHomeRow, 'lastError' | 'state'>;
  now: Date;
  signIn: Awaited<ReturnType<LocalAgentStore['signIn']>>;
  base: Omit<SubscriptionStatus, 'state'>;
}): SubscriptionStatus {
  const { auth, base, home, now, signIn } = input;
  const connected = auth?.status === 'authenticated';
  const plan = connected ? auth.plan : null;

  if (home.state === 'error') {
    return { ...base, message: home.lastError ?? UNREACHABLE, state: 'error' };
  }

  if (
    signIn?.phase === 'url' &&
    signIn.url !== undefined &&
    signIn.expiresAt !== undefined &&
    Date.parse(signIn.expiresAt) > now.getTime()
  ) {
    return {
      ...base,
      signIn: { expiresAt: signIn.expiresAt, url: signIn.url },
      state: 'awaiting-sign-in',
    };
  }

  if (signIn?.phase === 'verifying') {
    return connected ? { ...base, plan, state: 'connected' } : { ...base, state: 'verifying' };
  }

  if (home.state === 'provisioning') return { ...base, state: 'provisioning' };
  if (home.state === 'starting' || signIn?.phase === 'requested') {
    return { ...base, state: 'starting' };
  }
  if (connected) return { ...base, plan, state: 'connected' };
  if (signIn?.phase === 'failed') {
    return { ...base, message: signIn.message ?? SIGNED_OUT, state: 'signed-out' };
  }

  // Never the runner's own message: it names a companion command the person cannot run here.
  return { ...base, message: SIGNED_OUT, state: 'signed-out' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An error for a log line: its class and message, which never carry a token or a code. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
