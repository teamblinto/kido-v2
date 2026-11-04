import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
  type LocalAgentProviderStatus,
} from '@repo/contracts';

import { scrub } from '../log.ts';
import { redactPaths, truncate } from '../util.ts';
import { createClaudeAdapter } from './claude/index.ts';
import type {
  AdapterContext,
  ProviderAdapter,
  ProviderProbe,
  SubscriptionDetails,
} from './types.ts';

const redactHome = redactPaths(Infinity);

const FACTORIES: Record<LocalAgentProvider, (ctx: AdapterContext) => ProviderAdapter> = {
  claude: createClaudeAdapter,
};

export type ProbedStatus = Omit<LocalAgentProviderStatus, 'policy'>;

/** The adapters plus a probe cache, so a run start re-checks auth at most once a minute. */
export class ProviderRegistry {
  readonly adapters: Record<LocalAgentProvider, ProviderAdapter>;
  private readonly cache = new Map<LocalAgentProvider, { at: number; status: ProbedStatus }>();
  private readonly inFlight = new Map<LocalAgentProvider, Promise<ProbedStatus>>();
  private readonly detailing = new Map<LocalAgentProvider, Promise<SubscriptionDetails | null>>();

  constructor(
    selfScript: string,
    extra: Pick<AdapterContext, 'binary' | 'interruptGraceMs' | 'toolCallTimeoutMs'> = {},
  ) {
    const entries = LOCAL_AGENT_PROVIDERS.map(
      (id) => [id, FACTORIES[id]({ ...extra, selfScript })] as const,
    );
    this.adapters = Object.fromEntries(entries) as Record<LocalAgentProvider, ProviderAdapter>;
  }

  /** A probe already running is shared, so a burst of run starts spawns each CLI once. */
  probe(provider: LocalAgentProvider, maxAgeMs = 0): Promise<ProbedStatus> {
    const cached = this.cache.get(provider);
    // Strictly younger: with the default 0, a status cached in this same millisecond is not "fresh".
    if (cached && Date.now() - cached.at < maxAgeMs) return Promise.resolve(cached.status);
    let running = this.inFlight.get(provider);
    if (!running) {
      running = this.probeNow(provider).finally(() => this.inFlight.delete(provider));
      this.inFlight.set(provider, running);
    }
    return running;
  }

  /**
   * A fresh probe and, when the CLI is signed in, its own models and limits. A details probe that
   * fails leaves them out (the server keeps the last ones it heard); it never fails the report.
   * One details probe per provider at a time: overlapping callers share it.
   */
  async report(provider: LocalAgentProvider): Promise<ProbedStatus> {
    const status = await this.probe(provider);
    const adapter = this.adapters[provider];
    if (status.auth.status !== 'authenticated' || !adapter.details) return status;
    let running = this.detailing.get(provider);
    if (!running) {
      running = adapter
        .details()
        .catch(() => null)
        .finally(() => this.detailing.delete(provider));
      this.detailing.set(provider, running);
    }
    const details = await running;
    if (!details) return status;
    return {
      ...status,
      auth: {
        ...status.auth,
        plan: status.auth.plan ?? (status.auth.method === 'subscription' ? details.plan : null),
      },
      models: details.models,
      ...(details.usage ? { usage: details.usage } : {}),
    };
  }

  private async probeNow(provider: LocalAgentProvider): Promise<ProbedStatus> {
    let probe: ProviderProbe;
    try {
      probe = await this.adapters[provider].probe();
    } catch (error) {
      probe = {
        auth: { method: null, plan: null, status: 'unknown' },
        installed: false,
        message: truncate(`Probe failed: ${redactHome(scrub(String(error)))}`, 500),
        models: [],
        version: null,
      };
    }
    const status: ProbedStatus = { ...probe, checkedAt: new Date().toISOString(), provider };
    this.cache.set(provider, { at: Date.now(), status });
    return status;
  }
}
