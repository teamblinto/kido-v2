import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';

import { RUN_PROFILES_TOKEN } from '../../common/run-profiles/run-profiles.constants';
import type { Environment } from '../../config/environment';
import type { RunProfile } from '../../config/run-profiles';
import { HealthReport } from './health-report';

const HEALTH_PATH = '/api/v1/health';

/**
 * A worker's liveness probe (spec 013, research R5): a bare `node:http` listener on `HOST:PORT`
 * that answers `GET /api/v1/health` with the same report the controller serves — `200` or `503`,
 * same JSON body — and an empty `404` to everything else. No router, no guards, no session, no
 * cookie, no CORS: a worker has none of those to offer and FR-011 says it must not.
 *
 * Rejected: `NestFactory.create` with a health-only module — Express and the whole HTTP pipeline
 * in a worker to serve one route. A file touched by a tick plus `find -mmin` in the healthcheck —
 * reports the tick, not the stores. `HEAD` is answered like `GET` (Node drops the body) because
 * GNU `wget --spider` sends `HEAD` first; busybox's sends `GET`.
 *
 * Starts only when `api` is absent: with it, the route is the controller's, on the same port.
 */
@Injectable()
export class LivenessServer implements OnApplicationBootstrap, OnApplicationShutdown {
  server: Server | undefined;

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly report: HealthReport,
    @Inject(RUN_PROFILES_TOKEN) private readonly profiles: ReadonlySet<RunProfile>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.profiles.has('api') || this.server) {
      return;
    }

    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.config.get('PORT'), this.config.get('HOST'), resolve);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    const { server } = this;
    this.server = undefined;

    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method === 'HEAD' ? 'GET' : request.method;

    if (method !== 'GET' || request.url?.split('?')[0] !== HEALTH_PATH) {
      response.writeHead(404).end();

      return;
    }

    let status = 200;
    let body: unknown;

    try {
      body = await this.report.check();
    } catch (error) {
      // Anything but Terminus' 503 is a bug, not a report; an unhandled rejection here would take the
      // worker down for it, and a 500 tells the healthcheck the same thing without that.
      if (!(error instanceof ServiceUnavailableException)) {
        response.writeHead(500).end();

        return;
      }

      status = 503;
      body = error.getResponse();
    }

    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }
}
