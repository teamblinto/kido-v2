import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';

import type { ClockPort } from '../../../common/clock/clock.port';
import { FakeResolver } from '../../../../test/support/fake-resolver';
import {
  type FakeReceiver,
  hang,
  redirect,
  respond,
  startFakeReceiver,
  unboundedBody,
} from '../../../../test/support/fake-receiver';
import type { DestinationPolicy } from './destination';
import { RESPONSE_KEEP_BYTES, RESPONSE_READ_LIMIT } from '../webhooks.constants';
import { MAX_KEPT_HEADERS, SafeTransport, type WebhookRequest } from './safe-transport';

const TLS_DIR = join(__dirname, '../../../../test/fixtures/broker-tls');
const TLS = {
  ca: readFileSync(join(TLS_DIR, 'ca.pem')),
  cert: readFileSync(join(TLS_DIR, 'server.pem')),
  key: readFileSync(join(TLS_DIR, 'server.key')),
};

/** Loopback admitted: the E2E substitution research R8 names, never the production policy. */
const loopbackOnly = (...allowed: string[]): DestinationPolicy => ({
  isAllowedAddress: (ip) => allowed.includes(ip),
});

const realClock: ClockPort = { now: () => new Date() };

const REQUEST = (url: string): WebhookRequest => ({
  body: '{"id":"e1","type":"ping"}',
  deliveryId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
  eventType: 'ping',
  signature: 't=1790000000,v1=' + 'a'.repeat(64),
  url,
});

describe('SafeTransport', () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function receiver(host = '127.0.0.1', port?: number): Promise<FakeReceiver> {
    const started = await startFakeReceiver({ host, port });
    closers.push(() => started.close());
    return started;
  }

  function transport(
    resolver: FakeResolver,
    policy: DestinationPolicy = loopbackOnly('127.0.0.1'),
    options: { ca?: Buffer; timeoutMs?: number } = {},
  ) {
    return new SafeTransport(resolver, policy, realClock, options);
  }

  it('connects only to the pinned address: a server on a second loopback address gets nothing', async () => {
    const pinned = await receiver('127.0.0.1');
    const other = await receiver('127.0.0.2', pinned.port);
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1']]);

    const result = await transport(resolver).send(
      REQUEST(pinned.url('/hook', { host: 'hooks.test' })),
    );

    expect(result).toMatchObject({ address: '127.0.0.1', error: null, status: 200 });
    expect(pinned.requests('/hook')).toHaveLength(1);
    expect(pinned.requests('/hook')[0]!.headers.host).toBe(`hooks.test:${pinned.port}`);
    expect(other.all).toHaveLength(0);
    expect(resolver.asked).toEqual(['hooks.test']);
  });

  it('sends the servername and verifies the certificate against the CA passed in', async () => {
    const servernames: (string | false | null)[] = [];
    const server: HttpsServer = createHttpsServer({ cert: TLS.cert, key: TLS.key }, (_, res) => {
      res.writeHead(204).end();
    });
    server.on('secureConnection', (socket: TLSSocket) => servernames.push(socket.servername));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const resolver = new FakeResolver().set('localhost', [['127.0.0.1']]);

    const trusted = await transport(resolver, undefined, { ca: TLS.ca }).send(
      REQUEST(`https://localhost:${port}/hook`),
    );
    expect(trusted).toMatchObject({ error: null, status: 204 });
    expect(servernames).toEqual(['localhost']);

    const untrusted = await transport(resolver).send(REQUEST(`https://localhost:${port}/hook`));
    expect(untrusted).toMatchObject({ error: 'tls-failed', status: null });
  });

  it('does not follow a 302 and reports its status', async () => {
    const target = await receiver();
    target.script('/hook', redirect(target.url('/elsewhere')));
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1']]);

    const result = await transport(resolver).send(
      REQUEST(target.url('/hook', { host: 'hooks.test' })),
    );

    expect(result).toMatchObject({ error: null, status: 302 });
    expect(result.headers.location).toBe(target.url('/elsewhere'));
    expect(target.requests('/elsewhere')).toHaveLength(0);
  });

  it('a server that never answers ends at the deadline as timeout', async () => {
    const target = await receiver();
    target.script('/hook', hang());
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1']]);

    const started = Date.now();
    const result = await transport(resolver, undefined, { timeoutMs: 300 }).send(
      REQUEST(target.url('/hook', { host: 'hooks.test' })),
    );

    expect(result).toMatchObject({ address: '127.0.0.1', error: 'timeout', status: null });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.durationMs).toBeGreaterThanOrEqual(250);
  });

  it('a body over 64 KB ends as response-too-large with the socket destroyed, keeping 4 KB', async () => {
    const target = await receiver();
    target.script('/hook', unboundedBody());
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1']]);

    const result = await transport(resolver).send(
      REQUEST(target.url('/hook', { host: 'hooks.test' })),
    );

    expect(RESPONSE_READ_LIMIT).toBe(64 * 1024);
    expect(result).toMatchObject({ error: 'response-too-large', status: 200 });
    expect(result.body).toBe('x'.repeat(RESPONSE_KEEP_BYTES));
  });

  it('keeps only the first 4 KB of a body within the limit', async () => {
    const target = await receiver();
    target.script('/hook', respond(200, { body: 'y'.repeat(10_000) }));
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1']]);

    const result = await transport(resolver).send(
      REQUEST(target.url('/hook', { host: 'hooks.test' })),
    );

    expect(RESPONSE_KEEP_BYTES).toBe(4096);
    expect(result).toMatchObject({ body: 'y'.repeat(4096), error: null, status: 200 });
  });

  it('caps headers at 32 of 1 KB each and drops set-cookie', async () => {
    const target = await receiver();
    const headers: Record<string, string | string[]> = { 'set-cookie': ['a=1', 'b=2'] };
    for (let index = 0; index < 40; index += 1) headers[`x-h${index}`] = 'v';
    headers['x-long'] = 'z'.repeat(3000);
    target.script('/hook', respond(200, { headers }));
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1']]);

    const result = await transport(resolver).send(
      REQUEST(target.url('/hook', { host: 'hooks.test' })),
    );

    expect(MAX_KEPT_HEADERS).toBe(32);
    expect(Object.keys(result.headers)).toHaveLength(32);
    expect(result.headers['set-cookie']).toBeUndefined();
    for (const value of Object.values(result.headers))
      expect(value.length).toBeLessThanOrEqual(1024);
  });

  it('sends only the contract header set and the exact body', async () => {
    const target = await receiver();
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1']]);
    const request = REQUEST(target.url('/hook?a=1', { host: 'hooks.test' }));

    await transport(resolver).send(request);

    const [received] = target.requests('/hook');
    expect(received!.method).toBe('POST');
    expect(received!.path).toBe('/hook?a=1');
    expect(received!.body.toString('utf8')).toBe(request.body);
    expect(Object.keys(received!.headers).sort()).toEqual([
      'connection',
      'content-length',
      'content-type',
      'forge-delivery-id',
      'forge-event-id',
      'forge-event-type',
      'forge-signature',
      'host',
      'user-agent',
    ]);
    expect(received!.headers).toMatchObject({
      'content-type': 'application/json',
      'forge-delivery-id': request.deliveryId,
      'forge-event-id': request.eventId,
      'forge-event-type': 'ping',
      'forge-signature': request.signature,
      'user-agent': 'Forge-Webhooks/1',
    });
  });

  it('returns destination-refused with no connection when every address is refused', async () => {
    const target = await receiver();
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1', '10.0.0.1']]);

    const result = await transport(resolver, loopbackOnly()).send(
      REQUEST(target.url('/hook', { host: 'hooks.test' })),
    );

    expect(result).toMatchObject({ address: null, error: 'destination-refused', status: null });
    expect(target.all).toHaveLength(0);
  });

  it('refuses a literal IP host the policy refuses, without asking the resolver', async () => {
    const target = await receiver();
    const resolver = new FakeResolver();

    const result = await transport(resolver, loopbackOnly()).send(REQUEST(target.url('/hook')));

    expect(result).toMatchObject({ error: 'destination-refused' });
    expect(resolver.asked).toEqual([]);
    expect(target.all).toHaveLength(0);
  });

  it('connects to the allowed address among a mix of allowed and refused', async () => {
    const target = await receiver('127.0.0.1');
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.2', '127.0.0.1']]);

    const result = await transport(resolver, loopbackOnly('127.0.0.1')).send(
      REQUEST(target.url('/hook', { host: 'hooks.test' })),
    );

    expect(result).toMatchObject({ address: '127.0.0.1', error: null, status: 200 });
    expect(target.all).toHaveLength(1);
  });

  it('checks every attempt after resolution, so a rebinding host is refused', async () => {
    const target = await receiver('127.0.0.1');
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1'], ['127.0.0.9']]);
    const safe = transport(resolver, loopbackOnly('127.0.0.1'));
    const url = target.url('/hook', { host: 'hooks.test' });

    expect(await safe.send(REQUEST(url))).toMatchObject({ error: null, status: 200 });
    expect(await safe.send(REQUEST(url))).toMatchObject({ error: 'destination-refused' });
    expect(target.all).toHaveLength(1);
  });

  it('empty or unavailable DNS is dns-failed', async () => {
    const resolver = new FakeResolver().unavailable('down.test');

    expect(await transport(resolver).send(REQUEST('http://none.test/hook'))).toMatchObject({
      address: null,
      error: 'dns-failed',
    });
    expect(await transport(resolver).send(REQUEST('http://down.test/hook'))).toMatchObject({
      error: 'dns-failed',
    });
  });

  it('a refused connection is connection-failed', async () => {
    const target = await receiver('127.0.0.1');
    const port = target.port;
    await target.close();
    closers.length = 0;
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1']]);

    const result = await transport(resolver).send(REQUEST(`http://hooks.test:${port}/hook`));

    expect(result).toMatchObject({
      address: '127.0.0.1',
      error: 'connection-failed',
      status: null,
    });
  });

  it('measures the duration with the injected clock', async () => {
    const target = await receiver();
    const resolver = new FakeResolver().set('hooks.test', [['127.0.0.1']]);
    let now = 1_000;
    const clock: ClockPort = { now: () => new Date((now += 25)) };

    const result = await new SafeTransport(resolver, loopbackOnly('127.0.0.1'), clock, {}).send(
      REQUEST(target.url('/hook', { host: 'hooks.test' })),
    );

    expect(result.durationMs).toBe(25);
  });
});
