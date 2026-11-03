import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ApiRootResponse } from '@repo/types' with { 'resolution-mode': 'import' };

import { Public } from './modules/identity/decorators/public.decorator';

/**
 * Unauthenticated by declaration. `SessionGuard` is an `APP_GUARD`, so every route is closed until
 * it says otherwise, and service metadata is something an unauthenticated client is meant to read.
 */
@Public()
@ApiTags('system')
@Controller({ version: '1' })
export class AppController {
  @Get()
  @ApiOperation({ summary: 'Return basic API metadata' })
  @ApiOkResponse({ description: 'The API is running.' })
  getRoot(): ApiRootResponse {
    return {
      name: 'api',
      status: 'running',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.1.0',
    };
  }
}
