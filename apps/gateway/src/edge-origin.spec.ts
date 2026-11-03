import * as crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEdgeOriginCheck, EDGE_ORIGIN_HEADER, takeEdgeHeader } from './edge-origin.ts';

vi.mock('node:crypto', { spy: true });

const SECRET = 'edge-origin-secret-0123456789abcdef';

/** The two views Node keeps of a request's headers; both must lose the edge header. */
function fakeRequest(headers: [string, string][]): IncomingMessage {
  const parsed: Record<string, string> = {};
  for (const [name, value] of headers) {
    parsed[name.toLowerCase()] = value;
  }
  return { headers: parsed, rawHeaders: headers.flat() } as unknown as IncomingMessage;
}

function assertGone(req: IncomingMessage): void {
  expect(req.headers[EDGE_ORIGIN_HEADER]).toBeUndefined();
  expect(Object.keys(req.headers)).not.toContain(EDGE_ORIGIN_HEADER);
  expect(req.rawHeaders.map((v) => v.toLowerCase())).not.toContain(EDGE_ORIGIN_HEADER);
  expect(req.rawHeaders.join('\n')).not.toContain(SECRET);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('createEdgeOriginCheck (contracts/domain-serving.md § 1)', () => {
  const fromEdge = createEdgeOriginCheck(SECRET);

  it('refuses to build a check for an empty secret', () => {
    expect(() => createEdgeOriginCheck('')).toThrow();
  });

  it('names the header X-Forge-Edge', () => {
    expect(EDGE_ORIGIN_HEADER).toBe('x-forge-edge');
  });

  it('refuses a request with no header', () => {
    const req = fakeRequest([['Host', 'www.acme.example']]);

    expect(fromEdge(req)).toBe(false);
    assertGone(req);
    expect(req.headers.host).toBe('www.acme.example');
  });

  it('refuses a wrong header of the same length, and removes it', () => {
    const wrong = `${SECRET.slice(0, -1)}x`;
    const req = fakeRequest([
      ['Host', 'www.acme.example'],
      ['X-Forge-Edge', wrong],
    ]);

    expect(fromEdge(req)).toBe(false);
    assertGone(req);
    expect(req.rawHeaders).toEqual(['Host', 'www.acme.example']);
  });

  it('refuses a header of a different length without throwing', () => {
    for (const value of ['', 'short', `${SECRET}${SECRET}`]) {
      const req = fakeRequest([['x-forge-edge', value]]);

      expect(fromEdge(req)).toBe(false);
      assertGone(req);
    }
  });

  it('accepts the correct header, and removes it all the same', () => {
    const req = fakeRequest([
      ['Host', 'www.acme.example'],
      ['X-Forge-Edge', SECRET],
      ['Accept', '*/*'],
    ]);

    expect(fromEdge(req)).toBe(true);
    assertGone(req);
    expect(req.rawHeaders).toEqual(['Host', 'www.acme.example', 'Accept', '*/*']);
  });

  it('refuses a secret sent twice (Node joins the values)', () => {
    const req = fakeRequest([['X-Forge-Edge', SECRET]]);
    req.headers[EDGE_ORIGIN_HEADER] = `${SECRET}, ${SECRET}`;
    req.rawHeaders.push('x-forge-edge', SECRET);

    expect(fromEdge(req)).toBe(false);
    assertGone(req);
  });

  it('compares SHA-256 digests with timingSafeEqual, never the raw strings', () => {
    fromEdge(fakeRequest([['X-Forge-Edge', 'short']]));

    expect(crypto.timingSafeEqual).toHaveBeenCalledOnce();
    const [a, b] = vi.mocked(crypto.timingSafeEqual).mock.calls[0]!;
    expect((a as Buffer).length).toBe(32);
    expect((b as Buffer).length).toBe(32);
    expect(Buffer.from(b as Buffer)).toEqual(crypto.createHash('sha256').update(SECRET).digest());
  });

  it('compares even when the header is missing, so absence costs the same', () => {
    fromEdge(fakeRequest([]));

    expect(crypto.timingSafeEqual).toHaveBeenCalledOnce();
  });
});

describe('takeEdgeHeader', () => {
  it('returns the value and removes the header from both views of the request', () => {
    const req = fakeRequest([
      ['X-Forge-Edge', 'v'],
      ['Host', 'h'],
    ]);

    expect(takeEdgeHeader(req)).toBe('v');
    expect(req.headers[EDGE_ORIGIN_HEADER]).toBeUndefined();
    expect(req.rawHeaders).toEqual(['Host', 'h']);
    expect(takeEdgeHeader(req)).toBeUndefined();
  });
});
