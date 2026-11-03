import type { ArgumentsHost } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { MockInstance } from 'vitest';

import {
  ConflictError,
  DomainError,
  NotFoundError,
  RateLimitedError,
  ServiceUnavailableError,
} from './domain-error';
import { problemDetailSchema } from './problem-detail';
import { ProblemDetailsFilter, scrubBodyParserError } from './problem-details.filter';
import { problemTypeUri } from './problem-types';

interface RecordedResponse {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  statusCode: number;
}

interface Fixture {
  host: ArgumentsHost;
  recorded: RecordedResponse;
}

function createHost(request: Record<string, unknown> = { headers: {} }): Fixture {
  const recorded: RecordedResponse = { body: {}, headers: {}, statusCode: 0 };
  const response = {
    json(body: Record<string, unknown>): void {
      recorded.body = body;
    },
    setHeader(name: string, value: string): void {
      recorded.headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      recorded.statusCode = code;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;

  return { host, recorded };
}

describe('ProblemDetailsFilter', () => {
  let filter: ProblemDetailsFilter;
  let loggedErrors: MockInstance<Logger['error']>;

  beforeEach(() => {
    loggedErrors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    filter = new ProblemDetailsFilter();
  });

  describe('response envelope', () => {
    it('always answers with application/problem+json and echoes the correlation id', () => {
      const { host, recorded } = createHost({
        headers: { 'x-request-id': 'req-abc-123' },
        url: '/api/v1/workspaces/42',
      });

      filter.catch(new NotFoundError('No such workspace.'), host);

      expect(recorded.headers['content-type']).toBe('application/problem+json');
      expect(recorded.headers['x-request-id']).toBe('req-abc-123');
      expect(recorded.body.requestId).toBe('req-abc-123');
    });

    it('emits a document that satisfies the problem detail schema', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/workspaces' });

      filter.catch(new ConflictError('Already exists.'), host);

      expect(problemDetailSchema.safeParse(recorded.body).success).toBe(true);
    });

    /**
     * No error document is cacheable, and RFC 9110 §15.6.2 makes several of the statuses this
     * filter emits — 404, 405, 410, 501 among them — *heuristically* cacheable, meaning a shared
     * cache may store one that says nothing on the subject. Each of those is a state the API
     * changes: a row is created, a provider is configured. Without this header, an operator who
     * enables an OAuth provider and redeploys is answered "not implemented" from an intermediary
     * for as long as it cares to keep it.
     */
    it('forbids caching every problem document it writes', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/workspaces/42' });

      filter.catch(new NotFoundError('No such workspace.'), host);

      expect(recorded.headers['cache-control']).toBe('no-store');
    });

    it('uses the request path as instance and drops the query string', () => {
      const { host, recorded } = createHost({
        headers: {},
        originalUrl: '/api/v1/sessions?token=super-secret',
      });

      filter.catch(new ConflictError('Already exists.'), host);

      expect(recorded.body.instance).toBe('/api/v1/sessions');
    });
  });

  describe('correlation id', () => {
    it('falls back to the logger request id when no header is supplied', () => {
      const { host, recorded } = createHost({ headers: {}, id: 7, url: '/api/v1' });

      filter.catch(new ConflictError('Already exists.'), host);

      expect(recorded.body.requestId).toBe('7');
    });

    it('generates one when the inbound header is hostile', () => {
      const { host, recorded } = createHost({
        headers: { 'x-request-id': 'a\r\nSet-Cookie: session=stolen' },
        url: '/api/v1',
      });

      filter.catch(new ConflictError('Already exists.'), host);

      expect(recorded.body.requestId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
      expect(recorded.headers['x-request-id']).not.toContain('\n');
    });

    it('refuses an over-long inbound header rather than echoing it', () => {
      const { host, recorded } = createHost({
        headers: { 'x-request-id': 'a'.repeat(129) },
        url: '/api/v1',
      });

      filter.catch(new ConflictError('Already exists.'), host);

      expect(recorded.body.requestId).not.toBe('a'.repeat(129));
    });
  });

  describe('domain errors', () => {
    it('maps a domain error through the catalogue without a per-error filter', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/workspaces/42' });

      filter.catch(new NotFoundError('No such workspace.'), host);

      expect(recorded.statusCode).toBe(404);
      expect(recorded.body).toMatchObject({
        detail: 'No such workspace.',
        instance: '/api/v1/workspaces/42',
        status: 404,
        title: 'Not Found',
        type: problemTypeUri('not-found'),
      });
    });

    it('sets Retry-After from a ServiceUnavailableError (spec 016 R7)', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/checkpoints/1/diff' });

      filter.catch(new ServiceUnavailableError('The workspace is waking.', 5), host);

      expect(recorded.headers['retry-after']).toBe('5');
      expect(recorded.statusCode).toBe(503);
    });

    it('sets Retry-After from a RateLimitedError', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/sessions' });

      filter.catch(new RateLimitedError('Slow down.', 30), host);

      expect(recorded.headers['retry-after']).toBe('30');
      expect(recorded.statusCode).toBe(429);
      expect(recorded.body.retryAfter).toBe(30);
    });

    /**
     * A 5xx `DomainError` is a catalogued outcome, not an unhandled exception.
     *
     * The distinction is operational rather than cosmetic. `oauth-provider-not-configured` is a 501
     * thrown on every request to a provider an operator deliberately switched off, and
     * `service-unavailable` is what the health route reports when Postgres is down. Logging either
     * at `error` with a stack is how a disabled sign-in button pages somebody overnight — and how
     * the genuinely unhandled fault beside it disappears into the noise.
     */
    it('logs a 5xx domain error as a warning rather than an unhandled exception', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/auth/oauth/google' });
      const warnings = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      filter.catch(new DomainError('service-unavailable', 'Postgres is down.'), host);

      expect(recorded.statusCode).toBe(503);
      expect(loggedErrors).not.toHaveBeenCalled();
      expect(warnings).toHaveBeenCalledOnce();
    });

    /** And a fault nobody predicted still gets the stack, which is what that level is for. */
    it('still logs an unexpected 5xx as an error with its stack', () => {
      const { host } = createHost({ headers: {}, url: '/api/v1/widgets' });

      filter.catch(new Error('something nobody anticipated'), host);

      expect(loggedErrors).toHaveBeenCalledOnce();
    });
  });

  describe('framework exceptions', () => {
    it('maps an HttpException status through the catalogue and keeps its message', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/widgets/1' });

      filter.catch(new NotFoundException('No such widget.'), host);

      expect(recorded.statusCode).toBe(404);
      expect(recorded.body).toMatchObject({
        detail: 'No such widget.',
        type: problemTypeUri('not-found'),
      });
    });

    it('lifts a validation-style message array into an errors extension', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/widgets' });

      filter.catch(new BadRequestException(['name must be a string']), host);

      expect(recorded.statusCode).toBe(400);
      expect(recorded.body.detail).toBe('Bad Request');
      expect(recorded.body.errors).toStrictEqual(['name must be a string']);
      expect(recorded.body.type).toBe(problemTypeUri('bad-request'));
    });

    it('keeps a 4xx message', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/orgs/1' });

      filter.catch(new ForbiddenException('You cannot invite members.'), host);

      expect(recorded.statusCode).toBe(403);
      expect(recorded.body.detail).toBe('You cannot invite members.');
    });

    it('never keeps a 5xx message', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/orgs/1' });

      filter.catch(new InternalServerErrorException('connect ECONNREFUSED 10.0.0.5:5432'), host);

      expect(recorded.statusCode).toBe(500);
      expect(JSON.stringify(recorded.body)).not.toContain('ECONNREFUSED');
    });

    it('degrades an HttpException status the catalogue does not cover to a generic 500', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/brews' });

      filter.catch(new HttpException('I am a teapot', 418), host);

      expect(recorded.statusCode).toBe(500);
      expect(recorded.body.type).toBe(problemTypeUri('internal-server-error'));
      expect(JSON.stringify(recorded.body)).not.toContain('teapot');
    });
  });

  describe('unexpected errors', () => {
    it('answers a generic 500 that leaks no message, stack or driver text', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/workspaces' });
      const exception = new Error(
        'select * from users failed: postgres://forge:hunter2@db:5432/forge',
      );

      filter.catch(exception, host);

      const serialised = JSON.stringify(recorded.body);

      expect(recorded.statusCode).toBe(500);
      expect(recorded.body.stack).toBeUndefined();
      expect(recorded.body.title).toBe('Internal Server Error');
      expect(recorded.body.type).toBe(problemTypeUri('internal-server-error'));
      expect(serialised).not.toContain('hunter2');
      expect(serialised).not.toContain('postgres');
      expect(serialised).not.toContain('select * from users');
      expect(serialised).not.toContain('problem-details.filter');
    });

    it('handles a thrown non-Error without crashing the filter', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1' });

      filter.catch('a bare string with secret=hunter2', host);

      expect(recorded.statusCode).toBe(500);
      expect(JSON.stringify(recorded.body)).not.toContain('hunter2');
    });

    it('logs the original exception server-side with the correlation id', () => {
      const { host } = createHost({
        headers: { 'x-request-id': 'req-xyz' },
        url: '/api/v1/workspaces',
      });

      filter.catch(new Error('boom'), host);

      expect(loggedErrors).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(loggedErrors.mock.calls[0])).toContain('req-xyz');
    });

    it('does not log a client error as a server incident', () => {
      const { host } = createHost({ headers: {}, url: '/api/v1/workspaces/42' });

      filter.catch(new NotFoundError('No such workspace.'), host);

      expect(loggedErrors).not.toHaveBeenCalled();
    });

    it('answers a body-parser refusal with its 4xx and the title, never the quoted body', () => {
      const { host, recorded } = createHost({ headers: {}, url: '/api/v1/me/subscriptions' });
      const malformed = Object.assign(
        new SyntaxError('Unexpected token S in JSON: {"code":SECRET-1'),
        { body: '{"code":SECRET-1', status: 400, type: 'entity.parse.failed' },
      );
      let forwarded: unknown;

      scrubBodyParserError(malformed, {}, {}, (error) => (forwarded = error));
      filter.catch(forwarded, host);

      expect(forwarded).toEqual({ status: 400, type: 'entity.parse.failed' });
      expect(recorded.statusCode).toBe(400);
      expect(recorded.body.detail).toBe('Bad Request');
      expect(JSON.stringify(recorded.body)).not.toContain('SECRET');
      expect(loggedErrors).not.toHaveBeenCalled();

      scrubBodyParserError(new Error('other'), {}, {}, (error) => (forwarded = error));
      expect(forwarded).toBeInstanceOf(Error);
    });
  });
});
