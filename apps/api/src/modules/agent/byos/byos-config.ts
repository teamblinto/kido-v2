import type { LlmProviderName } from '../llm-provider.port';

/**
 * One provider's `BYOS_<P>_*` set (spec 032 R13), read in one place. `environment.ts` already
 * validates the set as all-or-none, so a present `CLIENT_ID` means a complete core set.
 */
export interface ByosClientConfig {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authorizeUrl?: string;
  readonly tokenUrl: string;
  readonly revokeUrl?: string;
  readonly deviceUrl?: string;
  readonly apiBaseUrl: string;
  readonly scopes: readonly string[];
}

/** `read` is a lookup of the validated environment by key (`ConfigService.get` in the app). */
export function byosClientConfig(
  read: (key: string) => string | undefined,
  provider: LlmProviderName,
): ByosClientConfig | undefined {
  const prefix = provider === 'anthropic' ? 'BYOS_ANTHROPIC' : 'BYOS_OPENAI';
  const value = (name: string): string | undefined => read(`${prefix}_${name}`);
  const clientId = value('CLIENT_ID');
  const tokenUrl = value('TOKEN_URL');
  const apiBaseUrl = value('API_BASE_URL');
  const scopes = value('SCOPES');
  const authorizeUrl = value('AUTHORIZE_URL');
  const deviceUrl = value('DEVICE_URL');

  if (
    clientId === undefined ||
    tokenUrl === undefined ||
    apiBaseUrl === undefined ||
    scopes === undefined ||
    (authorizeUrl === undefined && deviceUrl === undefined)
  ) {
    return undefined;
  }

  return {
    apiBaseUrl,
    authorizeUrl,
    clientId,
    clientSecret: value('CLIENT_SECRET'),
    deviceUrl,
    revokeUrl: value('REVOKE_URL'),
    scopes: scopes.split(/\s+/).filter((scope) => scope !== ''),
    tokenUrl,
  };
}
