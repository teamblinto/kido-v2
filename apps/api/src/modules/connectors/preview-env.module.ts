import { Global, Module } from '@nestjs/common';

import { PREVIEW_ENV_SOURCE, type PreviewEnvSource } from '../sandbox/sandbox.constants';
import { ConnectorsModule } from './connectors.module';
import { PreviewEnvReader } from './preview-env.source';

/**
 * Spec 030 contracts/preview-env.md § 3: `PREVIEW_ENV_SOURCE`, global so `sandbox` can inject it
 * without importing `connectors` (the edge would be a cycle). Exports only the token.
 */
@Global()
@Module({
  exports: [PREVIEW_ENV_SOURCE],
  imports: [ConnectorsModule],
  providers: [
    PreviewEnvReader,
    {
      inject: [PreviewEnvReader],
      provide: PREVIEW_ENV_SOURCE,
      useFactory: (reader: PreviewEnvReader): PreviewEnvSource => reader.source,
    },
  ],
})
export class PreviewEnvModule {}
