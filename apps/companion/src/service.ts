import type { CompanionPolicy } from '@repo/contracts';

import type { CompanionConfig } from './config.ts';
import { ClaudeSignIn } from './hosted.ts';
import { ApiClient, DeviceRevokedError } from './http.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { RunManager } from './runs.ts';
import { Supervisor, type SupervisorOutcome } from './supervisor.ts';
import { Uplink, type UplinkOptions } from './uplink.ts';

/** `start` wired up: connection, runs and uplink sharing one config and one API client. */

export interface ServiceOptions {
  /** Hosted runner only: `http:` to a non-loopback server (`BAIOS_ALLOW_INSECURE_HTTP=1`). */
  allowInsecureHttp?: boolean;
  config: CompanionConfig;
  /** The hosted runner (spec 041): sandbox runs only, and sign-in commands. */
  hosted?: boolean;
  interruptGraceMs?: number;
  selfScript: string;
  /** Hosted sign-in timeout; 10 minutes by default. */
  signInTimeoutMs?: number;
  statusIntervalMs?: number;
  token: string;
  uplink?: Pick<UplinkOptions, 'flushMs' | 'maxBatch'>;
}

export interface Service {
  runs: RunManager;
  supervisor: Supervisor;
  uplink: Uplink;
  /** Runs until stopped, then interrupts open runs and flushes what it can. */
  run(): Promise<SupervisorOutcome>;
}

export function createService(options: ServiceOptions): Service {
  const { config } = options;
  if (!config.server) throw new Error('Not paired.');
  const api = new ApiClient(config.server, options.token, options.allowInsecureHttp);
  const providers = new ProviderRegistry(config, options.selfScript, {
    interruptGraceMs: options.interruptGraceMs,
  });
  const uplink = new Uplink(
    (runId, turn, events) =>
      api.post(`/local-agent/runs/${encodeURIComponent(runId)}/events`, { events, turn }),
    { ...options.uplink, onRevoked: () => supervisor.stop('unauthorized') },
  );
  const runs: RunManager = new RunManager({
    config,
    hosted: options.hosted,
    policy: (): CompanionPolicy | null => supervisor.policy,
    providers,
    uplink,
  });
  const signIn = options.hosted
    ? new ClaudeSignIn({
        binary: config.providers.claude.binary,
        post: (event) =>
          api.post('/local-agent/auth', event).catch((error: unknown) => {
            if (error instanceof DeviceRevokedError) supervisor.stop('unauthorized');
            throw error;
          }),
        refreshStatus: () => supervisor.refreshStatus(),
        timeoutMs: options.signInTimeoutMs,
      })
    : null;
  const supervisor: Supervisor = new Supervisor({
    api,
    config,
    onAuth: signIn ? (data) => signIn.handle(data) : undefined,
    providers,
    runs,
    statusIntervalMs: options.statusIntervalMs,
  });
  return {
    async run() {
      const outcome = await supervisor.run();
      signIn?.stop();
      await runs.interruptAll(8_000);
      if (outcome === 'stopped') await uplink.drain(5_000);
      uplink.stop();
      return outcome;
    },
    runs,
    supervisor,
    uplink,
  };
}
