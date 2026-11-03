import type { NestMiddleware } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { INBOUND_PATHS } from '../../../common/csrf/inbound-paths';
import { DomainError } from '../../../common/errors/domain-error';
import type { Environment } from '../../../config/environment';

interface HostBearingRequest {
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  readonly method: string;
  readonly originalUrl?: string;
  readonly url?: string;
}

const INBOUND: ReadonlySet<string> = new Set(INBOUND_PATHS);

/**
 * The hooks origin (spec 029 US6, contracts/hooks-origin.md § API).
 *
 * | Host        | inbound path | result                                      |
 * | ----------- | ------------ | ------------------------------------------- |
 * | HOOKS_HOST  | yes          | pass                                        |
 * | HOOKS_HOST  | no           | 404, before any guard runs                  |
 * | other       | yes          | pass while `WEBHOOK_LEGACY_ADDRESS`, else 404 |
 * | other       | no           | pass                                        |
 *
 * The refusal is the error an unknown route produces — Nest's `Cannot <METHOD> <url>` as a
 * `not-found` problem — so a probe cannot tell a refused host from a missing path.
 */
@Injectable()
export class HooksHostMiddleware implements NestMiddleware {
  private readonly hooksHost: string;
  private readonly legacyAddress: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    this.hooksHost = normaliseHost(config.get('HOOKS_HOST', { infer: true }) ?? '');
    this.legacyAddress = config.get('WEBHOOK_LEGACY_ADDRESS', { infer: true }) !== false;
  }

  use(request: HostBearingRequest, _response: unknown, next: (error?: unknown) => void): void {
    const url = request.originalUrl ?? request.url ?? '/';
    const inbound = INBOUND.has(pathOf(url));
    const onHooksHost = this.hooksHost !== '' && hostOf(request) === this.hooksHost;

    if (onHooksHost ? inbound : !inbound || this.legacyAddress) {
      next();

      return;
    }

    throw new DomainError('not-found', `Cannot ${request.method} ${url}`);
  }
}

function hostOf(request: HostBearingRequest): string {
  const header = request.headers?.host;
  const value = Array.isArray(header) ? header[0] : header;

  return value === undefined ? '' : normaliseHost(value);
}

/** Lowercased, port stripped. A bracketed IPv6 literal keeps its brackets. */
function normaliseHost(host: string): string {
  const trimmed = host.trim().toLowerCase();

  return trimmed.startsWith('[')
    ? trimmed.slice(0, trimmed.indexOf(']') + 1)
    : trimmed.replace(/:\d*$/, '');
}

function pathOf(url: string): string {
  const query = url.indexOf('?');

  return query === -1 ? url : url.slice(0, query);
}
