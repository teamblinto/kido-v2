import type { ServerResponse } from 'node:http';

import {
  COULD_NOT_WAKE_PAGE,
  METHOD_NOT_ALLOWED_PAGE,
  NOT_SERVING_PAGE,
  type Page,
  REFUSED_PAGE,
  send,
  SITE_BROKEN_PAGE,
  SITE_UNAVAILABLE_PAGE,
  WAKING_PAGE,
} from './pages.ts';

// A project/org/sandbox/label identifier, if one ever leaked into a template, would look like one
// of these: a uuid, a hex label (20-64 chars), or the word "sandbox"/"project"/"org" itself.
const IDENTIFIER_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-|\b[0-9a-f]{20,64}\b|\bsandbox\b|\bproject\b|\borg\b/i;

const PAGES: Record<string, Page> = {
  COULD_NOT_WAKE_PAGE,
  METHOD_NOT_ALLOWED_PAGE,
  NOT_SERVING_PAGE,
  REFUSED_PAGE,
  SITE_BROKEN_PAGE,
  SITE_UNAVAILABLE_PAGE,
  WAKING_PAGE,
};

interface FakeResponse {
  headers?: Record<string, string>;
  status?: number;
  written?: string;
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

function fakeResponse(): FakeResponse {
  const res: FakeResponse = {
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(body) {
      res.written = body;
    },
  };
  return res;
}

function asServerResponse(res: FakeResponse): ServerResponse {
  return res as unknown as ServerResponse;
}

describe('page templates', () => {
  it.each(Object.entries(PAGES))(
    '%s renders with no project/org/sandbox identifier',
    (_name, page) => {
      expect(page.body).not.toMatch(IDENTIFIER_PATTERN);
    },
  );

  it('REFUSED_PAGE is a 404', () => {
    expect(REFUSED_PAGE.status).toBe(404);
  });

  it('NOT_SERVING_PAGE is a 503 with no Retry-After', () => {
    expect(NOT_SERVING_PAGE.status).toBe(503);
    expect(NOT_SERVING_PAGE.headers?.['Retry-After']).toBeUndefined();
  });

  it('WAKING_PAGE is a 202 with Retry-After: 2 (contract § 4, research R12)', () => {
    expect(WAKING_PAGE.status).toBe(202);
    expect(WAKING_PAGE.headers).toEqual({ 'Retry-After': '2' });
  });

  it('only WAKING_PAGE reloads itself; the terminal and refusal pages do not', () => {
    expect(WAKING_PAGE.body).toContain('<meta http-equiv="refresh" content="2">');
    for (const page of [REFUSED_PAGE, NOT_SERVING_PAGE, COULD_NOT_WAKE_PAGE]) {
      expect(page.body).not.toContain('http-equiv="refresh"');
    }
  });

  it('COULD_NOT_WAKE_PAGE is a distinct body from WAKING_PAGE and NOT_SERVING_PAGE', () => {
    expect(COULD_NOT_WAKE_PAGE.body).not.toBe(WAKING_PAGE.body);
    expect(COULD_NOT_WAKE_PAGE.body).not.toBe(NOT_SERVING_PAGE.body);
  });
});

describe('send', () => {
  it('writes status, Content-Type, Cache-Control and the body', () => {
    const res = fakeResponse();

    send(asServerResponse(res), REFUSED_PAGE);

    expect(res.status).toBe(404);
    expect(res.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    expect(res.written).toBe(REFUSED_PAGE.body);
  });

  it('merges a page-specific header (Retry-After) alongside the standard ones', () => {
    const res = fakeResponse();

    send(asServerResponse(res), WAKING_PAGE);

    expect(res.status).toBe(202);
    expect(res.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '2',
    });
  });
});
