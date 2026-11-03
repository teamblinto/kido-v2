import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resolver } from 'node:dns/promises';

import type { Environment } from '../../../config/environment';
import type { WebhookResolution, WebhookResolverPort } from './resolver.port';

/** The whole lookup's bound (R8): A and AAAA together, across every server, within 3 s. */
export const WEBHOOK_RESOLVE_TIMEOUT_MS = 3000;

/** The authoritative "nothing here" codes: NODATA and NXDOMAIN. Everything else is unavailable. */
const EMPTY_CODES: ReadonlySet<string> = new Set(['ENODATA', 'ENOTFOUND']);

type FamilyAnswer = readonly string[] | 'empty' | 'unavailable';

const EMPTY = { kind: 'empty' } as const;
const UNAVAILABLE = { kind: 'unavailable' } as const;

/**
 * `WebhookResolverPort` over `node:dns/promises` `Resolver` pointed at `DNS_RESOLVERS`, so the
 * transport sees what the public internet sees, never the host's split-horizon resolver or
 * `/etc/hosts`. One `Resolver` per server, asked in order, for the reason `NodeDnsAdapter` gives:
 * c-ares answers the first server's SERVFAIL without asking the next.
 */
@Injectable()
export class NodeResolverAdapter implements WebhookResolverPort {
  private readonly resolvers: readonly Resolver[];

  constructor(config: ConfigService<Environment, true>) {
    this.resolvers = config.get('DNS_RESOLVERS', { infer: true }).map((server) => {
      const resolver = new Resolver({ timeout: 1000, tries: 1 });
      resolver.setServers([server]);
      return resolver;
    });
  }

  async resolve(host: string): Promise<WebhookResolution> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<WebhookResolution>((resolve) => {
      timer = setTimeout(() => resolve(UNAVAILABLE), WEBHOOK_RESOLVE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.lookup(host), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async lookup(host: string): Promise<WebhookResolution> {
    const [v4, v6] = await Promise.all([
      this.ask((resolver) => resolver.resolve4(host)),
      this.ask((resolver) => resolver.resolve6(host)),
    ]);
    const addresses = [v4, v6].flatMap((family) => (typeof family === 'string' ? [] : family));
    if (addresses.length > 0) return { addresses, kind: 'answer' };
    if (v4 === 'empty' && v6 === 'empty') return EMPTY;
    return UNAVAILABLE;
  }

  private async ask(query: (resolver: Resolver) => Promise<string[]>): Promise<FamilyAnswer> {
    for (const resolver of this.resolvers) {
      try {
        const result = await query(resolver);
        return result.length === 0 ? 'empty' : result;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (typeof code === 'string' && EMPTY_CODES.has(code)) return 'empty';
      }
    }
    return 'unavailable';
  }
}
