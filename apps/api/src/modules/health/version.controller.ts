import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { VersionResponse } from '@repo/contracts';

import type { Environment } from '../../config/environment';
import { Public } from '../identity/decorators/public.decorator';
import { VersionResponseDto } from './dto/version.dto';

/**
 * Which build is running, answered from the values baked into the image at build (spec 025 FR-033,
 * research R7).
 *
 * Deliberately not part of `HealthController`. That endpoint is the container's readiness gate —
 * compose and the edge start things on top of it, and its own comment says anything listed there is
 * something the API genuinely cannot serve traffic without. A build digest is not that, and its
 * response type `ApiHealthResponse` is a contract other things read. A separate route touches
 * neither, which is what keeps "no application behaviour changes" true.
 *
 * `@Public()` on purpose: the reader is an on-call engineer correlating an incident to a deploy,
 * possibly before they have a session. The three values say which artifact is running and nothing
 * about who is using it — the ordinary trade a `/version` route makes, recorded rather than assumed.
 */
@Public()
@ApiTags('health')
@Controller({ path: 'version', version: '1' })
export class VersionController {
  private readonly version: VersionResponse;

  constructor(config: ConfigService<Environment, true>) {
    // Read once at construction rather than per request: these are baked into the image and cannot
    // change while the process lives, and a deploy check should not be answered by fresh work.
    this.version = {
      builtAt: config.get('BUILD_AT', { infer: true }),
      commit: config.get('BUILD_COMMIT', { infer: true }),
      digest: config.get('BUILD_DIGEST', { infer: true }),
    };
  }

  /**
   * `GET /api/v1/version`. The confirmation step of a deploy compares `digest` against the digest it
   * was asked to deploy, so this must report the artifact that is actually running (FR-007).
   */
  @Get()
  @ApiOperation({ summary: 'Report the build that is running' })
  @ApiOkResponse({ description: 'The running build.', type: VersionResponseDto })
  read(): VersionResponse {
    return this.version;
  }
}
