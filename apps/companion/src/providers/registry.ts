import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
  type LocalAgentProviderStatus,
} from '@repo/contracts';

import type { CompanionConfig } from '../config.ts';
import { scrub } from '../log.ts';
import { redactPaths, truncate } from '../util.ts';
import { createClaudeAdapter } from './claude/index.ts';
import { createCodexAdapter } from './codex/index.ts';
import type { AdapterContext, ProviderAdapter, ProviderProbe } from './types.ts';

const redactHome = redactPaths(null, Infinity);

/** Adding a CLI: a folder beside `claude/` and `codex/`, plus one entry here. */
const FACTORIES: Record<LocalAgentProvider, (ctx: AdapterContext) => ProviderAdapter> = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
};

export type ProbedStatus = Omit<LocalAgentProviderStatus, 'policy'>;

/** The adapters plus a probe cache, so a run start re-checks auth at most once a minute. */
export class ProviderRegistry {
  readonly adapters: Record<LocalAgentProvider, ProviderAdapter>;
  private readonly cache = new Map<LocalAgentProvider, { at: number; status: ProbedStatus }>();
  private readonly inFlight = new Map<LocalAgentProvider, Promise<ProbedStatus>>();

  constructor(
    config: CompanionConfig,
    selfScript: string,
    extra: Pick<AdapterContext, 'interruptGraceMs' | 'toolCallTimeoutMs'> = {},
  ) {
    const entries = LOCAL_AGENT_PROVIDERS.map((id) => {
      const settings = config.providers[id];
      const ctx: AdapterContext = {
        ...extra,
        binary: settings.binary,
        selfScript,
        settingSources: settings.settingSources,
      };
      return [id, FACTORIES[id](ctx)] as const;
    });
    this.adapters = Object.fromEntries(entries) as Record<LocalAgentProvider, ProviderAdapter>;
  }

  /** A probe already running is shared, so a burst of run starts spawns each CLI once. */
  probe(provider: LocalAgentProvider, maxAgeMs = 0): Promise<ProbedStatus> {
    const cached = this.cache.get(provider);
    if (cached && Date.now() - cached.at <= maxAgeMs) return Promise.resolve(cached.status);
    let running = this.inFlight.get(provider);
    if (!running) {
      running = this.probeNow(provider).finally(() => this.inFlight.delete(provider));
      this.inFlight.set(provider, running);
    }
    return running;
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

  probeAll(maxAgeMs = 0): Promise<ProbedStatus[]> {
    return Promise.all(LOCAL_AGENT_PROVIDERS.map((provider) => this.probe(provider, maxAgeMs)));
  }
}
