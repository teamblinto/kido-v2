import { PROBLEM_TYPE_BASE_URI } from '@repo/contracts';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { API, server } from '@/test/server';
import { apiRequest } from './client';
import { ApiProblem, ApiUnreachableError } from './problem';

const bodySchema = z.strictObject({ status: z.string() });

/** A problem document as the API's filter renders one. */
function problem(slug: string, status: number, extra: Record<string, unknown> = {}) {
  return HttpResponse.json(
    {
      detail: 'A sentence about what went wrong.',
      instance: '/api/v1/thing',
      requestId: '01JD0000000000000000000000',
      status,
      title: 'Something',
      type: `${PROBLEM_TYPE_BASE_URI}${slug}`,
      ...extra,
    },
    { status },
  );
}

describe('apiRequest', () => {
  it('parses a success body through the contract schema', async () => {
    server.use(http.get(`${API}/thing`, () => HttpResponse.json({ status: 'ok' })));

    await expect(apiRequest('GET', '/thing', { schema: bodySchema })).resolves.toEqual({
      status: 'ok',
    });
  });

  it('rejects a body the contract does not describe, rather than passing it on', async () => {
    server.use(
      http.get(`${API}/thing`, () => HttpResponse.json({ status: 'ok', token: 'leaked' })),
    );

    // The strict object is the point: a field the contract does not carry fails here, in a test,
    // instead of reaching something that logs or renders it.
    await expect(apiRequest('GET', '/thing', { schema: bodySchema })).rejects.toThrow();
  });

  it('returns nothing for a route with no body, and does not try to parse one', async () => {
    server.use(http.post(`${API}/logout`, () => new HttpResponse(null, { status: 204 })));

    await expect(apiRequest('POST', '/logout')).resolves.toBeUndefined();
  });

  it('throws a problem carrying the slug a caller branches on', async () => {
    server.use(http.post(`${API}/login`, () => problem('unauthorized', 401)));

    const failure = await apiRequest('POST', '/login', { schema: bodySchema }).catch(
      (error: unknown) => error,
    );

    expect(ApiProblem.is(failure, 'unauthorized')).toBe(true);
    expect((failure as ApiProblem).status).toBe(401);
  });

  it('falls back to the status when the body is not a problem document', async () => {
    // What a proxy in front of the API returns. A client that threw a SyntaxError here would
    // replace a message the user can act on with one nobody can.
    server.use(
      http.get(`${API}/thing`, () => new HttpResponse('<html>502</html>', { status: 502 })),
    );

    const failure = await apiRequest('GET', '/thing', { schema: bodySchema }).catch(
      (error: unknown) => error,
    );

    expect(ApiProblem.is(failure)).toBe(true);
    expect((failure as ApiProblem).slug).toBeUndefined();
    expect((failure as ApiProblem).status).toBe(502);
  });

  it('leaves the slug undefined for a type this build does not know', async () => {
    server.use(http.get(`${API}/thing`, () => problem('invented-later', 418)));

    const failure = await apiRequest('GET', '/thing', { schema: bodySchema }).catch(
      (error: unknown) => error,
    );

    // Degrading to the generic branch is the documented contract of `problemTypeSlugFromUri`.
    expect((failure as ApiProblem).slug).toBeUndefined();
  });

  it('reports an unreachable service as its own failure, not as a problem document', async () => {
    server.use(http.get(`${API}/thing`, () => HttpResponse.error()));

    await expect(apiRequest('GET', '/thing', { schema: bodySchema })).rejects.toBeInstanceOf(
      ApiUnreachableError,
    );
  });

  it('propagates an abort as an abort, so a cancelled query is not reported as an outage', async () => {
    server.use(http.get(`${API}/thing`, () => HttpResponse.json({ status: 'ok' })));

    const controller = new AbortController();
    controller.abort();

    await expect(
      apiRequest('GET', '/thing', { schema: bodySchema, signal: controller.signal }),
    ).rejects.not.toBeInstanceOf(ApiUnreachableError);
  });

  describe('CSRF', () => {
    it('echoes the cookie in the header on an unsafe method', async () => {
      document.cookie = 'forge_csrf=a-token; path=/';
      let seen: string | null = null;

      server.use(
        http.post(`${API}/thing`, ({ request }) => {
          seen = request.headers.get('X-CSRF-Token');

          return HttpResponse.json({ status: 'ok' });
        }),
      );

      await apiRequest('POST', '/thing', { body: {}, schema: bodySchema });

      expect(seen).toBe('a-token');
    });

    it('sends no token on a safe method, which the middleware does not check', async () => {
      document.cookie = 'forge_csrf=a-token; path=/';
      let seen: string | null = 'unset';

      server.use(
        http.get(`${API}/thing`, ({ request }) => {
          seen = request.headers.get('X-CSRF-Token');

          return HttpResponse.json({ status: 'ok' });
        }),
      );

      await apiRequest('GET', '/thing', { schema: bodySchema });

      expect(seen).toBeNull();
    });

    it('retries once with the token the rejection issued', async () => {
      // The middleware's own design: it issues a cookie on the very response that refuses a caller
      // who had none, because otherwise the only way to get a token is to already have one.
      let attempts = 0;

      server.use(
        http.post(`${API}/thing`, ({ request }) => {
          attempts += 1;

          if (request.headers.get('X-CSRF-Token') === null) {
            document.cookie = 'forge_csrf=issued-by-the-rejection; path=/';

            return problem('csrf-check-failed', 403);
          }

          return HttpResponse.json({ status: 'ok' });
        }),
      );

      await expect(apiRequest('POST', '/thing', { body: {}, schema: bodySchema })).resolves.toEqual(
        { status: 'ok' },
      );
      expect(attempts).toBe(2);
    });

    it('gives up after one retry rather than looping', async () => {
      let attempts = 0;

      server.use(
        http.post(`${API}/thing`, () => {
          attempts += 1;

          return problem('csrf-check-failed', 403);
        }),
      );

      await expect(
        apiRequest('POST', '/thing', { body: {}, schema: bodySchema }),
      ).rejects.toThrow();
      expect(attempts).toBe(2);
    });

    it('does not retry a different 403, which would resend an applied mutation', async () => {
      let attempts = 0;

      server.use(
        http.post(`${API}/thing`, () => {
          attempts += 1;

          return problem('permission-denied', 403);
        }),
      );

      const failure = await apiRequest('POST', '/thing', { body: {}, schema: bodySchema }).catch(
        (error: unknown) => error,
      );

      expect(ApiProblem.is(failure, 'permission-denied')).toBe(true);
      expect(attempts).toBe(1);
    });
  });

  describe('validation failures', () => {
    it('keys the rejected fields by the last segment of their pointer', async () => {
      server.use(
        http.post(`${API}/signup`, () =>
          problem('validation-failed', 422, {
            errors: [
              {
                code: 'too_small',
                detail: 'Use at least 12 characters.',
                pointer: '/body/password',
              },
              { code: 'invalid_format', detail: 'Enter a valid address.', pointer: '/body/email' },
            ],
          }),
        ),
      );

      const failure = await apiRequest('POST', '/signup', { body: {}, schema: bodySchema }).catch(
        (error: unknown) => error as ApiProblem,
      );

      expect((failure as ApiProblem).fieldErrors()).toEqual({
        email: 'Enter a valid address.',
        password: 'Use at least 12 characters.',
      });
    });
  });
});
