import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import path from 'node:path';

import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Environment, PreviewJwks } from '../../config/environment';
import type { DomainRouteService } from '../deploy/domains/domain-route.service';
import type { SiteRouteService } from '../deploy/site-route.service';
import {
  BrokerListener,
  type BrokerTransport,
  brokerTransportFor,
  type Closeable,
  MtlsBrokerTransport,
  PlainBrokerTransport,
} from './broker-listener';
import type { GrantService } from './grant.service';
import type { RouteBrokerService, RouteResolution } from './route-broker.service';
import { createRouteSigner, domainRecordSchema, siteRecordSchema } from './route-signer';

/** A CA and three leaves it signed: the server, the gateway (`CN=forge-test-gateway`) and a stranger. */
const fixtures = path.join(__dirname, '../../../test/fixtures/broker-tls');
const pem = (name: string) => readFileSync(path.join(fixtures, name), 'utf8');

const LABEL = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SITE_LABEL = 'my-site-x7k2';
const HOSTNAME = 'www.acme.example';

/** A real signer over a throwaway Ed25519 pair, so a site answer can be verified end to end. */
const signing = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string };
  const jwks: PreviewJwks = {
    keys: [{ ...jwk, alg: 'EdDSA', kid: 'k-test', use: 'sig' } as PreviewJwks['keys'][number]],
  };
  return {
    jwks,
    signer: createRouteSigner({
      jwks,
      signingKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      signingKeyId: 'k-test',
    }),
  };
})();

const SITE = {
  artifact: 'f'.repeat(64),
  deployment: '3d1c2b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  org: '0b4f7b7e-1a37-4b8e-9c3d-0f3b8a4d2a11',
  project: '9c2a3c3e-5f6d-4a1b-8e2f-7d6c5b4a3f21',
};

/** The site resolver as the listener sees it: one label is live, everything else is `undefined`. */
function sites() {
  const resolve = vi.fn((label: string) =>
    Promise.resolve(label === SITE_LABEL ? SITE : undefined),
  );
  return { resolve, service: { resolve } as unknown as SiteRouteService };
}

/** The domain resolver as the listener sees it: one hostname is live, everything else is `undefined`. */
function domains() {
  const resolve = vi.fn((hostname: string) =>
    Promise.resolve(hostname === HOSTNAME ? SITE : undefined),
  );
  return { resolve, service: { resolve } as unknown as DomainRouteService };
}

function call(
  make: typeof httpRequest | typeof httpsRequest,
  options: RequestOptions,
  body?: string,
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const request = make({ host: '127.0.0.1', ...options }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ body: Buffer.concat(chunks).toString('utf8'), status: response.statusCode ?? 0 }),
      );
    });
    request.on('error', reject);
    request.end(body);
  });
}

/** The route broker as the listener sees it: one label resolves, everything else is refused. */
function routes(answer: RouteResolution = { kind: 'route', route: 'signed.route.jws' }) {
  const resolve = vi.fn((label: string, _caller?: unknown) =>
    Promise.resolve<RouteResolution>(
      label === LABEL ? answer : { because: 'unknown-label', kind: 'refused' },
    ),
  );
  return { broker: { resolve } as unknown as RouteBrokerService, resolve };
}

/** The grant service as the listener sees it: one code redeems for its host, everything else is refused. */
const grants = () => {
  const redeem = vi.fn((code: string, host: string) =>
    Promise.resolve(code === 'good-code' && host === 'good-host' ? 'signed.grant.jws' : undefined),
  );
  return { redeem, service: { redeem } as unknown as GrantService };
};

const tls = {
  ca: pem('ca.pem'),
  cert: pem('server.pem'),
  clientCns: ['forge-test-gateway'],
  host: '127.0.0.1',
  key: pem('server.key'),
};

const plain = () => new PlainBrokerTransport({ port: 0, secret: 'local-broker-secret' }, 'local');

describe('BrokerListener', () => {
  const open: Closeable[] = [];

  beforeAll(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const closeable of open.splice(0)) await closeable.close();
  });

  /** The listener over the transport on a free port (`0`), the way `main.ts` binds it; answers the port. */
  async function serve(
    transport: BrokerTransport,
    broker = routes().broker,
    grant = grants().service,
    site = sites().service,
    domain = domains().service,
  ): Promise<number> {
    const listener = new BrokerListener(transport, broker, grant, site, signing.signer, domain);
    await listener.listen();
    await listener.listen(); // idempotent: a second call binds nothing more
    const closeable = {
      address: listener.address ?? '',
      close: () => listener.onApplicationShutdown(),
      port: listener.port ?? 0,
    };
    open.push(closeable);
    return closeable.port;
  }

  describe('over mTLS', () => {
    const asClient = (name: 'gateway' | 'stranger', port: number, options: RequestOptions) =>
      call(httpsRequest, {
        ca: tls.ca,
        cert: pem(`${name}.pem`),
        key: pem(`${name}.key`),
        port,
        servername: 'localhost',
        ...options,
      });

    it('answers the gateway certificate the allowlist names with the signed route', async () => {
      const port = await serve(new MtlsBrokerTransport({ ...tls, port: 0 }));

      await expect(
        asClient('gateway', port, { method: 'GET', path: `/broker/routes/${LABEL}` }),
      ).resolves.toEqual({ body: JSON.stringify({ route: 'signed.route.jws' }), status: 200 });
    });

    it('refuses a CA-signed certificate whose CN is not in the allowlist, with the same empty 404', async () => {
      const { broker, resolve } = routes();
      const port = await serve(new MtlsBrokerTransport({ ...tls, port: 0 }), broker);

      await expect(
        asClient('stranger', port, { method: 'GET', path: `/broker/routes/${LABEL}` }),
      ).resolves.toEqual({ body: '{}', status: 404 });
      // The allowlist is the whole difference: the same stranger is admitted once it is named.
      const wider = await serve(
        new MtlsBrokerTransport({
          ...tls,
          clientCns: ['forge-test-gateway', 'someone-else'],
          port: 0,
        }),
      );
      await expect(
        asClient('stranger', wider, { method: 'GET', path: `/broker/routes/${LABEL}` }),
      ).resolves.toMatchObject({ status: 200 });
      expect(resolve).not.toHaveBeenCalled();
    });

    it('answers a site to the gateway and the same empty 404 to a stranger', async () => {
      const site = sites();
      const port = await serve(
        new MtlsBrokerTransport({ ...tls, port: 0 }),
        routes().broker,
        grants().service,
        site.service,
      );

      const answered = await asClient('gateway', port, {
        method: 'GET',
        path: `/broker/sites/${SITE_LABEL}`,
      });
      expect(answered.status).toBe(200);
      await expect(
        asClient('stranger', port, { method: 'GET', path: `/broker/sites/${SITE_LABEL}` }),
      ).resolves.toEqual({ body: '{}', status: 404 });
      expect(site.resolve).toHaveBeenCalledTimes(1);
    });

    it('answers a domain to the gateway and the same empty 404 to a stranger', async () => {
      const domain = domains();
      const port = await serve(
        new MtlsBrokerTransport({ ...tls, port: 0 }),
        routes().broker,
        grants().service,
        sites().service,
        domain.service,
      );

      const answered = await asClient('gateway', port, {
        method: 'GET',
        path: `/broker/domains/${HOSTNAME}`,
      });
      expect(answered.status).toBe(200);
      expect(Object.keys(JSON.parse(answered.body) as object)).toEqual(['domain']);
      await expect(
        asClient('stranger', port, { method: 'GET', path: `/broker/domains/${HOSTNAME}` }),
      ).resolves.toEqual({ body: '{}', status: 404 });
      expect(domain.resolve).toHaveBeenCalledTimes(1);
    });

    it('never completes a handshake with a peer that presents no certificate', async () => {
      const port = await serve(new MtlsBrokerTransport({ ...tls, port: 0 }));

      await expect(
        call(httpsRequest, { ca: tls.ca, method: 'GET', path: `/broker/routes/${LABEL}`, port }),
      ).rejects.toThrow();
    });
  });

  describe('over the plain transport', () => {
    const asGateway = (port: number, options: RequestOptions, body?: string) =>
      call(
        httpRequest,
        { headers: { 'x-broker-secret': 'local-broker-secret' }, port, ...options },
        body,
      );

    it('is a boot error outside local, before anything listens', () => {
      expect(
        () => new PlainBrokerTransport({ port: 0, secret: 'local-broker-secret' }, 'production'),
      ).toThrow(/local-only/);
      expect(() =>
        brokerTransportFor(config({ BROKER_TRANSPORT: 'plain', DEPLOY_ENV: 'staging' })),
      ).toThrow(/local-only/);
    });

    it('binds loopback whatever HOST says, and logs a refused label only by its prefix', async () => {
      const transport = brokerTransportFor(
        config({ BROKER_TRANSPORT: 'plain', DEPLOY_ENV: 'local', HOST: '0.0.0.0' }),
      );
      const listener = new BrokerListener(
        transport,
        routes().broker,
        grants().service,
        sites().service,
        signing.signer,
        domains().service,
      );
      await listener.listen();
      open.push({ address: '', close: () => listener.onApplicationShutdown(), port: 0 });
      expect(listener.address).toBe('127.0.0.1');

      const logged = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await asGateway(listener.port ?? 0, {
        method: 'GET',
        path: `/broker/routes/${'c'.repeat(32)}`,
      });
      const line = String(logged.mock.calls[0]?.[0]);
      expect(line).toContain(`label=${'c'.repeat(8)}`);
      expect(line).not.toContain('c'.repeat(9));
    });

    it('serves the route to the shared secret and refuses a wrong or missing one identically', async () => {
      const { broker, resolve } = routes();
      const port = await serve(plain(), broker);

      await expect(
        asGateway(port, { method: 'GET', path: `/broker/routes/${LABEL}` }),
      ).resolves.toEqual({ body: JSON.stringify({ route: 'signed.route.jws' }), status: 200 });

      for (const headers of [{}, { 'x-broker-secret': 'local-broker-secre' }]) {
        await expect(
          call(httpRequest, { headers, method: 'GET', path: `/broker/routes/${LABEL}`, port }),
        ).resolves.toEqual({ body: '{}', status: 404 });
      }
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it('answers GET /broker/sites/:label with a signed site record that verifies as one', async () => {
      const site = sites();
      const port = await serve(plain(), routes().broker, grants().service, site.service);

      const answered = await asGateway(port, {
        method: 'GET',
        path: `/broker/sites/${SITE_LABEL}`,
      });
      expect(answered.status).toBe(200);
      const body = JSON.parse(answered.body) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['site']);
      const { payload, protectedHeader } = await jwtVerify(
        String(body.site),
        createLocalJWKSet(signing.jwks),
        { algorithms: ['EdDSA'] },
      );
      expect(protectedHeader.kid).toBe('k-test');
      expect(siteRecordSchema.parse(payload)).toEqual({
        ...SITE,
        exp: payload.exp,
        iat: payload.iat,
        kind: 'site',
        label: SITE_LABEL,
      });
      expect(payload.exp).toBe((payload.iat ?? 0) + 30);
      expect(site.resolve).toHaveBeenCalledWith(SITE_LABEL);
    });

    it('answers 404 {} for a site that does not resolve, another method, and a peer without the secret', async () => {
      const site = sites();
      const port = await serve(plain(), routes().broker, grants().service, site.service);

      for (const [method, path] of [
        ['GET', '/broker/sites/unknown-site'],
        ['GET', '/broker/sites'],
        ['GET', `/broker/sites/${SITE_LABEL}/extra`],
        ['POST', `/broker/sites/${SITE_LABEL}`],
        ['DELETE', `/broker/sites/${SITE_LABEL}`],
      ] as const) {
        await expect(asGateway(port, { method, path })).resolves.toEqual({
          body: '{}',
          status: 404,
        });
      }
      for (const headers of [{}, { 'x-broker-secret': 'wrong-broker-secret' }]) {
        await expect(
          call(httpRequest, { headers, method: 'GET', path: `/broker/sites/${SITE_LABEL}`, port }),
        ).resolves.toEqual({ body: '{}', status: 404 });
      }
      expect(site.resolve.mock.calls.map(([label]) => label)).toEqual(['unknown-site']);
    });

    it('answers GET /broker/domains/:hostname with a signed domain record that verifies as one', async () => {
      const domain = domains();
      const port = await serve(
        plain(),
        routes().broker,
        grants().service,
        sites().service,
        domain.service,
      );

      const answered = await asGateway(port, {
        method: 'GET',
        path: `/broker/domains/${HOSTNAME}`,
      });
      expect(answered.status).toBe(200);
      const body = JSON.parse(answered.body) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(['domain']);
      const { payload, protectedHeader } = await jwtVerify(
        String(body.domain),
        createLocalJWKSet(signing.jwks),
        { algorithms: ['EdDSA'] },
      );
      expect(protectedHeader.kid).toBe('k-test');
      expect(domainRecordSchema.parse(payload)).toEqual({
        ...SITE,
        exp: payload.exp,
        hostname: HOSTNAME,
        iat: payload.iat,
        kind: 'domain',
      });
      expect(payload.exp).toBe((payload.iat ?? 0) + 30);
      expect(domain.resolve).toHaveBeenCalledWith(HOSTNAME);
    });

    it('answers 404 {} for a domain that does not resolve, another method, and a peer without the secret', async () => {
      const domain = domains();
      const port = await serve(
        plain(),
        routes().broker,
        grants().service,
        sites().service,
        domain.service,
      );

      for (const [method, path] of [
        ['GET', '/broker/domains/unknown.acme.example'],
        ['GET', '/broker/domains'],
        ['GET', `/broker/domains/${HOSTNAME}/extra`],
        ['POST', `/broker/domains/${HOSTNAME}`],
        ['DELETE', `/broker/domains/${HOSTNAME}`],
      ] as const) {
        await expect(asGateway(port, { method, path })).resolves.toEqual({
          body: '{}',
          status: 404,
        });
      }
      for (const headers of [{}, { 'x-broker-secret': 'wrong-broker-secret' }]) {
        await expect(
          call(httpRequest, { headers, method: 'GET', path: `/broker/domains/${HOSTNAME}`, port }),
        ).resolves.toEqual({ body: '{}', status: 404 });
      }
      expect(domain.resolve.mock.calls.map(([hostname]) => hostname)).toEqual([
        'unknown.acme.example',
      ]);
    });

    it('answers 202 { waking: true } when the resolver triggered a resume', async () => {
      const port = await serve(plain(), routes({ because: 'resuming', kind: 'refused' }).broker);

      await expect(
        asGateway(port, { method: 'GET', path: `/broker/routes/${LABEL}` }),
      ).resolves.toEqual({ body: JSON.stringify({ waking: true }), status: 202 });
    });

    it('answers 401 {} when the wake was unauthorised, and hands the resolver the visitor headers', async () => {
      const { broker, resolve } = routes({ because: 'unauthorised', kind: 'refused' });
      const port = await serve(plain(), broker);

      await expect(
        asGateway(port, {
          headers: {
            'x-broker-secret': 'local-broker-secret',
            'x-preview-grant': 'grant.jws',
            'x-preview-host': `${LABEL}-5173.h`,
          },
          method: 'GET',
          path: `/broker/routes/${LABEL}`,
        }),
      ).resolves.toEqual({ body: '{}', status: 401 });
      expect(resolve).toHaveBeenCalledWith(LABEL, {
        grant: 'grant.jws',
        host: `${LABEL}-5173.h`,
      });

      await asGateway(port, { method: 'GET', path: `/broker/routes/${LABEL}` });
      expect(resolve).toHaveBeenLastCalledWith(LABEL, { grant: undefined, host: undefined });
    });

    it('redeems a grant for the gateway and answers it under `grant`', async () => {
      const { redeem, service } = grants();
      const port = await serve(plain(), routes().broker, service);

      await expect(
        asGateway(
          port,
          { method: 'POST', path: '/broker/grants' },
          JSON.stringify({ code: 'good-code', host: 'good-host' }),
        ),
      ).resolves.toEqual({ body: JSON.stringify({ grant: 'signed.grant.jws' }), status: 200 });
      expect(redeem).toHaveBeenCalledWith('good-code', 'good-host');
    });

    it('answers every refusal, a refused or malformed grant and an unknown path with 404 {} and no reason', async () => {
      const port = await serve(plain(), routes({ because: 'never-run', kind: 'refused' }).broker);

      for (const [method, path, body] of [
        ['GET', `/broker/routes/${LABEL}`, undefined],
        ['GET', '/broker/routes/unknown', undefined],
        ['POST', '/broker/grants', '{"code":"c","host":"h"}'],
        ['POST', '/broker/grants', '{"code":"good-code"}'],
        ['POST', '/broker/grants', 'not json'],
        ['GET', '/broker/grants', undefined],
        ['GET', '/broker/routes', undefined],
        ['GET', '/api/v1/health', undefined],
        ['DELETE', `/broker/routes/${LABEL}`, undefined],
      ] as const) {
        await expect(asGateway(port, { method, path }, body)).resolves.toEqual({
          body: '{}',
          status: 404,
        });
      }
    });

    it('picks the plain transport for local and the mTLS one when the environment says so', () => {
      expect(
        brokerTransportFor(config({ BROKER_TRANSPORT: 'plain', DEPLOY_ENV: 'local' })),
      ).toBeInstanceOf(PlainBrokerTransport);
      expect(
        brokerTransportFor(
          config({
            BROKER_CLIENT_CNS: ['forge-gateway'],
            BROKER_TLS_CA: 'ca',
            BROKER_TLS_CERT: 'cert',
            BROKER_TLS_KEY: 'key',
            BROKER_TRANSPORT: 'mtls',
            DEPLOY_ENV: 'production',
          }),
        ),
      ).toBeInstanceOf(MtlsBrokerTransport);
    });
  });
});

function config(values: Partial<Environment>): ConfigService<Environment, true> {
  const env: Partial<Environment> = {
    BROKER_PORT: 0,
    BROKER_SHARED_SECRET: 'local-broker-secret',
    HOST: '127.0.0.1',
    ...values,
  };
  return { get: (key: keyof Environment) => env[key] } as unknown as ConfigService<
    Environment,
    true
  >;
}
