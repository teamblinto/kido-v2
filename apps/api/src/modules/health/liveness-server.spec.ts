import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { HealthCheckResult } from '@nestjs/terminus';
import { afterEach, describe, expect, it } from 'vitest';

import type { Environment } from '../../config/environment';
import type { RunProfile } from '../../config/run-profiles';
import type { HealthReport } from './health-report';
import { LivenessServer } from './liveness-server';

const OK: HealthCheckResult = {
  details: { postgres: { status: 'up' } },
  error: {},
  info: { postgres: { status: 'up' } },
  status: 'ok',
};
const DOWN: HealthCheckResult = {
  details: { postgres: { status: 'down' } },
  error: { postgres: { status: 'down' } },
  info: {},
  status: 'error',
};

describe('LivenessServer', () => {
  let server: LivenessServer | undefined;

  function boot(profiles: readonly RunProfile[], report: HealthCheckResult): LivenessServer {
    const config = {
      get: (key: string) => ({ HOST: '127.0.0.1', PORT: 0 })[key],
    } as unknown as ConfigService<Environment, true>;
    const health = {
      check: () =>
        report.status === 'ok'
          ? Promise.resolve(report)
          : Promise.reject(new ServiceUnavailableException(report)),
    } as unknown as HealthReport;

    server = new LivenessServer(config, health, new Set(profiles));

    return server;
  }

  async function get(path: string): Promise<Response> {
    await server?.onApplicationBootstrap();
    const address = server?.server?.address();

    if (!address || typeof address === 'string') {
      throw new Error('not listening');
    }

    return fetch(`http://127.0.0.1:${address.port}${path}`);
  }

  afterEach(async () => {
    await server?.onApplicationShutdown();
    server = undefined;
  });

  it('answers the health path on the configured port with the report', async () => {
    boot(['agent'], OK);

    const response = await get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toEqual(OK);
  });

  it('answers 503 with the report when an indicator is down', async () => {
    boot(['agent'], DOWN);

    const response = await get('/api/v1/health');

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual(DOWN);
  });

  it('answers 404 to any other path and sets no cookie', async () => {
    boot(['agent'], OK);

    const response = await get('/api/v1/runs');

    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect([...response.headers.keys()].filter((h) => h.startsWith('access-control-'))).toEqual([]);
    await expect(response.text()).resolves.toBe('');
  });

  it('does not listen when the api profile is present', async () => {
    const liveness = boot(['api', 'agent'], OK);

    await liveness.onApplicationBootstrap();

    expect(liveness.server).toBeUndefined();
  });
});
