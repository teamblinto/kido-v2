import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ERROR_BODY_LIMIT, providerFetch } from './provider-fetch';

describe('providerFetch (spec 030 R4)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      switch (request.url) {
        case '/json':
          response.writeHead(200, { 'content-type': 'application/json' }).end('{"a":1}');
          return;
        case '/empty':
          response.writeHead(204).end();
          return;
        case '/text':
          response.writeHead(200).end('not json');
          return;
        case '/redirect':
          response.writeHead(302, { location: '/json' }).end();
          return;
        case '/slow':
          setTimeout(() => response.writeHead(200).end('{}'), 500);
          return;
        case '/big-error':
          response.writeHead(401).end('x'.repeat(ERROR_BODY_LIMIT * 4));
          return;
        default:
          response.writeHead(429, { 'retry-after': '7' }).end('{"name":"rate_limit_exceeded"}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('parses a 2xx JSON body and answers undefined for a 204', async () => {
    await expect(providerFetch(`${base}/json`, {})).resolves.toMatchObject({
      body: { a: 1 },
      kind: 'ok',
      status: 200,
    });
    await expect(providerFetch(`${base}/empty`, {})).resolves.toMatchObject({
      body: undefined,
      kind: 'ok',
      status: 204,
    });
  });

  it('answers unparseable for a 2xx that is not JSON', async () => {
    await expect(providerFetch(`${base}/text`, {})).resolves.toEqual({
      kind: 'unparseable',
      status: 200,
    });
  });

  it('never follows a redirect', async () => {
    await expect(providerFetch(`${base}/redirect`, {})).resolves.toEqual({ kind: 'unreachable' });
  });

  it('answers unreachable on the timeout and on a refused connection', async () => {
    await expect(providerFetch(`${base}/slow`, {}, { timeoutMs: 50 })).resolves.toEqual({
      kind: 'unreachable',
    });
    await expect(providerFetch('http://127.0.0.1:1/', {})).resolves.toEqual({
      kind: 'unreachable',
    });
  });

  it('leaves a non-2xx body unread unless the caller opts in', async () => {
    const unread = await providerFetch(`${base}/limited`, {});

    expect(unread).toMatchObject({ kind: 'status', status: 429 });
    expect(unread).not.toHaveProperty('errorBody');
    expect(unread.kind === 'status' && unread.headers.get('retry-after')).toBe('7');

    await expect(
      providerFetch(`${base}/limited`, {}, { readErrorBody: true }),
    ).resolves.toMatchObject({ errorBody: '{"name":"rate_limit_exceeded"}', status: 429 });
  });

  it('caps an opted-in error body', async () => {
    const result = await providerFetch(`${base}/big-error`, {}, { readErrorBody: true });

    expect(result.kind === 'status' && result.errorBody?.length).toBe(ERROR_BODY_LIMIT);
  });
});
