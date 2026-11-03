import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HealthCheck } from '@nestjs/terminus';
import type { ApiHealthResponse } from '@repo/types' with { 'resolution-mode': 'import' };

import { DomainError } from '../../common/errors/domain-error';
import { Public } from '../identity/decorators/public.decorator';
import { HealthReport } from './health-report';

/**
 * Unauthenticated by declaration, and it has to be: `SessionGuard` is an `APP_GUARD`, and a
 * readiness probe that needs a session would fail on a container that has just started — which is
 * every container, every deploy. It would also make the gate depend on the session Redis being
 * reachable, which is one of the things it exists to report on.
 */
@Public()
@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly report: HealthReport) {}

  /**
   * This is the container's readiness gate, not a status page: compose gives the api service this
   * endpoint as its healthcheck and starts `web` only once it passes, so anything listed here is
   * something the api genuinely cannot serve traffic without. A `down` indicator means a 503, which
   * means the container is not healthy, which means nothing downstream starts on top of it.
   */
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Check service health and its dependencies' })
  @ApiOkResponse({ description: 'Every indicator is up.' })
  @ApiServiceUnavailableResponse({ description: 'At least one indicator is down.' })
  async check(): Promise<ApiHealthResponse> {
    try {
      return await this.report.check();
    } catch (error) {
      throw asProblem(error);
    }
  }
}

/**
 * Terminus signals failure with a `ServiceUnavailableException` whose body is the health report, and
 * `ProblemDetailsFilter` replaces the body of any 5xx it did not raise itself with a generic one —
 * correctly, because server-side text is not safe to hand a client. Left alone, the two rules
 * combine to serve a 503 that says nothing, and "which dependency is missing" is the only thing this
 * response is for.
 *
 * So the report is re-raised as a `DomainError`, whose extensions the filter does carry through, with
 * one status per indicator and nothing else. The driver message stays out: it names hosts, ports and
 * sometimes users, and Terminus has already logged the whole thing server-side, which is where an
 * operator should be reading it.
 */
function asProblem(error: unknown): unknown {
  if (!(error instanceof ServiceUnavailableException)) {
    return error;
  }

  const report = error.getResponse() as ApiHealthResponse;
  const indicators = Object.fromEntries(
    Object.entries(report.details).map(([name, result]) => [name, result.status]),
  );
  const down = Object.keys(indicators).filter((name) => indicators[name] === 'down');

  return new DomainError(
    'service-unavailable',
    `the api cannot serve traffic: ${down.join(', ')} ${down.length === 1 ? 'is' : 'are'} down`,
    { indicators },
  );
}
