import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { Environment } from '../../config/environment';
import { PlatformCredentials } from './platform-credentials';

function configWith(values: Record<string, unknown>): ConfigService<Environment, true> {
  return new ConfigService(values) as unknown as ConfigService<Environment, true>;
}

describe('PlatformCredentials', () => {
  it('answers PLATFORM on the anthropic provider with the key when set', () => {
    const config = configWith({ ANTHROPIC_API_KEY: 'sk-ant-test' });

    const credentials = new PlatformCredentials(config);

    expect(credentials.context()).toEqual({
      apiKey: 'sk-ant-test',
      mode: 'PLATFORM',
      provider: 'anthropic',
    });
  });

  it('answers undefined when unset', () => {
    const config = configWith({});

    const credentials = new PlatformCredentials(config);

    expect(credentials.context()).toBeUndefined();
  });
});
