import {
  COMPANION_AUTH_SSE_EVENT,
  type CompanionPolicy,
  companionCommandSchema,
  companionStatusReportSchema,
  LOCAL_AGENT_HEARTBEAT_SECONDS,
  LOCAL_AGENT_PROVIDERS,
} from '@repo/contracts';

import { type CompanionConfig, isProviderEnabled } from './config.ts';
import { type ApiClient, DeviceRevokedError } from './http.ts';
import { log } from './log.ts';
import type { ProviderRegistry } from './providers/registry.ts';
import { policyVerdict, type RunManager } from './runs.ts';
import { type SseEvent, SseParser } from './sse.ts';
import { backoffDelay, sleep } from './util.ts';
import { COMPANION_VERSION } from './version.ts';

/**
 * The connection loop (spec 040 § 3 decision 2, § 6): one SSE command stream at a time, resumed
 * with `Last-Event-ID`, torn down when no byte (event or `:heartbeat`) arrives for three heartbeat
 * intervals, and redialled with jittered backoff (1 s → 30 s, reset once a connection is healthy).
 * A 401 stops it for good: the device was revoked or is unknown.
 */

export type SupervisorOutcome = 'revoked' | 'stopped' | 'unauthorized';

export interface SupervisorDeps {
  api: ApiClient;
  config: CompanionConfig;
  /** Hosted runner: `event: auth` frames go here; anywhere else they are ignored. */
  onAuth?: (data: string) => void;
  providers: ProviderRegistry;
  runs: RunManager;
  /** Periodic status report interval; 5 minutes by default. */
  statusIntervalMs?: number;
}

export class Supervisor {
  /** The `Last-Event-ID` for the next connection. */
  lastEventId = '';
  policy: CompanionPolicy | null = null;
  private readonly deps: SupervisorDeps;
  private heartbeatSeconds = LOCAL_AGENT_HEARTBEAT_SECONDS;
  private outcome: SupervisorOutcome | null = null;
  private reporting: Promise<void> | null = null;
  private readonly stopController = new AbortController();

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
  }

  /** Ends the loop (Ctrl+C, or the uplink saw a 401). */
  stop(outcome: SupervisorOutcome = 'stopped'): void {
    this.outcome ??= outcome;
    this.stopController.abort();
  }

  async run(): Promise<SupervisorOutcome> {
    const signal = this.stopController.signal;
    const timer = setInterval(
      () => void this.reportStatus(),
      this.deps.statusIntervalMs ?? 5 * 60_000,
    );
    let attempt = 0;
    try {
      while (!signal.aborted) {
        let healthy = false;
        try {
          healthy = await this.connectOnce();
        } catch (error) {
          if (error instanceof DeviceRevokedError) {
            this.stop('unauthorized');
            break;
          }
          log.warn(
            `Connection to BAIOS failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (signal.aborted) break;
        attempt = healthy ? 1 : attempt + 1;
        const delay = backoffDelay(attempt);
        log.info(`Disconnected from BAIOS; reconnecting in ${Math.ceil(delay / 1_000)} s.`);
        await sleep(delay, signal);
      }
    } finally {
      clearInterval(timer);
    }
    return this.outcome ?? 'stopped';
  }

  /** One connection; resolves true when it got as far as `hello`. */
  private async connectOnce(): Promise<boolean> {
    const controller = new AbortController();
    const onStop = () => controller.abort();
    this.stopController.signal.addEventListener('abort', onStop, { once: true });
    let idle = false;
    let watchdog: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => {
          idle = true;
          controller.abort();
        },
        this.heartbeatSeconds * 3 * 1_000,
      );
    };
    const healthy = { value: false };
    arm();
    try {
      const response = await this.deps.api.connect(this.lastEventId, controller.signal);
      if (!response.body) throw new Error('The command stream has no body.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser(this.lastEventId);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          this.dispatch(event, healthy);
          this.lastEventId = event.id;
          if (controller.signal.aborted) break;
        }
        this.lastEventId = parser.lastEventId;
        arm(); // after dispatch, so a new heartbeatSeconds from `hello` applies at once
      }
    } catch (error) {
      if (error instanceof DeviceRevokedError) throw error;
      if (idle) log.warn('No heartbeat from BAIOS; reconnecting.');
      else if (healthy.value) log.debug(`Command stream ended: ${String(error)}`);
      else if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(watchdog);
      this.stopController.signal.removeEventListener('abort', onStop);
      controller.abort();
    }
    return healthy.value;
  }

  private dispatch(event: SseEvent, healthy: { value: boolean }): void {
    if (event.oversized) {
      log.warn(`Skipped a command larger than the protocol allows (event ${event.id || '?'}).`);
      return;
    }
    if (event.event === COMPANION_AUTH_SSE_EVENT) {
      // Carries a sign-in code: only the hosted handler sees it, and nothing here logs it.
      if (this.deps.onAuth) this.deps.onAuth(event.data);
      else log.debug('Ignoring a sign-in command (not a hosted runner).');
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      log.warn(`Ignoring a malformed command (event ${event.id || '?'}).`);
      return;
    }
    const parsed = companionCommandSchema.safeParse(data);
    if (!parsed.success) {
      log.warn(`Ignoring an unrecognised command (event ${event.id || '?'}).`);
      return;
    }
    const command = parsed.data;
    log.debug(`command ${command.type}`);
    switch (command.type) {
      case 'hello':
        if (!healthy.value) log.info('Connected to BAIOS.');
        healthy.value = true;
        this.policy = command.policy;
        this.heartbeatSeconds = command.heartbeatSeconds;
        if (this.deps.config.deviceId && command.deviceId !== this.deps.config.deviceId) {
          log.warn('BAIOS knows this computer under a different device id than the local config.');
        }
        void this.reportStatus();
        return;
      case 'status.refresh':
        void this.reportStatus();
        return;
      case 'device.revoked':
        log.warn('BAIOS revoked this computer.');
        this.stop('revoked');
        return;
      default:
        this.deps.runs.handle(command);
    }
  }

  /** Probes every CLI and posts what it found; overlapping calls share one report. */
  reportStatus(): Promise<void> {
    this.reporting ??= this.sendStatus().finally(() => (this.reporting = null));
    return this.reporting;
  }

  /** A report whose probe starts now (after a sign-in change), not one already under way. */
  async refreshStatus(): Promise<void> {
    await this.reporting;
    return this.reportStatus();
  }

  private async sendStatus(): Promise<void> {
    const { api, config, providers } = this.deps;
    try {
      // A hosted runner reports only what it offers (Claude); a computer shows what is turned off.
      const ids = LOCAL_AGENT_PROVIDERS.filter(
        (id) => !this.deps.onAuth || isProviderEnabled(config, id),
      );
      const statuses = await Promise.all(ids.map((id) => providers.probe(id)));
      const report = companionStatusReportSchema.parse({
        companionVersion: COMPANION_VERSION,
        providers: statuses.map((status) =>
          isProviderEnabled(config, status.provider)
            ? { ...status, policy: policyVerdict(this.policy, status.provider, status.auth.method) }
            : {
                ...status,
                message: `Turned off on this computer (baios-companion config set ${status.provider}.enabled true).`,
                policy: { allowed: false, reason: 'Turned off on this computer.' },
              },
        ),
        workspaces: config.workspaces.map(({ id, label }) => ({ id, label })),
      });
      await api.post('/local-agent/status', report);
      log.debug('Status reported.');
    } catch (error) {
      if (error instanceof DeviceRevokedError) return this.stop('unauthorized');
      log.warn(
        `Could not report status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
