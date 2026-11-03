import type { CompanionPolicy } from '@repo/contracts';

import { ClaudeSignIn } from './hosted.ts';
import { ApiClient, DeviceRevokedError } from './http.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { RunManager } from './runs.ts';
import { Supervisor, type SupervisorOutcome } from './supervisor.ts';
import { Uplink, type UplinkOptions } from './uplink.ts';

/** `start --hosted` wired up: connection, runs, sign-in and uplink sharing one API client. */

export interface ServiceOptions {
  /** `http:` to a non-loopback server (`BAIOS_ALLOW_INSECURE_HTTP=1`). */
  allowInsecureHttp?: boolean;
  /** Config override for the Claude Code binary (tests); PATH lookup otherwise. */
  claudeBinary?: string;
  interruptGraceMs?: number;
  /** Runs at once; a further `run.start` is refused rather than queued. Default 2. */
  maxConcurrentRuns?: number;
  selfScript: string;
  server: string;
  /** Where conversation session ids are kept; `sessionsDir()` by default. */
  sessionsDir?: string;
  /** Sign-in timeout; 10 minutes by default. */
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
  const api = new ApiClient(options.server, options.token, options.allowInsecureHttp);
  const providers = new ProviderRegistry(options.selfScript, {
    binary: options.claudeBinary,
    interruptGraceMs: options.interruptGraceMs,
  });
  const uplink = new Uplink(
    (runId, turn, events) =>
      api.post(`/local-agent/runs/${encodeURIComponent(runId)}/events`, { events, turn }),
    { ...options.uplink, onRevoked: () => supervisor.stop('unauthorized') },
  );
  const runs: RunManager = new RunManager({
    maxConcurrentRuns: options.maxConcurrentRuns ?? 2,
    policy: (): CompanionPolicy | null => supervisor.policy,
    providers,
    sessionsDir: options.sessionsDir,
    uplink,
  });
  const signIn = new ClaudeSignIn({
    binary: options.claudeBinary,
    post: (event) =>
      api.post('/local-agent/auth', event).catch((error: unknown) => {
        if (error instanceof DeviceRevokedError) supervisor.stop('unauthorized');
        throw error;
      }),
    refreshStatus: () => supervisor.refreshStatus(),
    timeoutMs: options.signInTimeoutMs,
  });
  const supervisor: Supervisor = new Supervisor({
    api,
    onAuth: (data) => signIn.handle(data),
    providers,
    runs,
    statusIntervalMs: options.statusIntervalMs,
  });
  return {
    async run() {
      const outcome = await supervisor.run();
      signIn.stop();
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
