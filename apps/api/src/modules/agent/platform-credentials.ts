import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment';
import { PLATFORM_PROVIDER } from './agent.constants';
import type { CredentialContext } from './llm-provider.port';

/**
 * The `PLATFORM` credential (research.md R10, FR-017): read once at construction so the key
 * never sits behind a repeated environment lookup, and never logged — `context()` hands back
 * the value or nothing, and nothing else here ever prints it.
 */
@Injectable()
export class PlatformCredentials {
  private readonly credential: CredentialContext | undefined;

  constructor(@Inject(ConfigService) config: ConfigService<Environment, true>) {
    const apiKey = config.get('ANTHROPIC_API_KEY', { infer: true });
    this.credential =
      apiKey === undefined ? undefined : { apiKey, mode: 'PLATFORM', provider: PLATFORM_PROVIDER };
  }

  context(): CredentialContext | undefined {
    return this.credential;
  }
}
