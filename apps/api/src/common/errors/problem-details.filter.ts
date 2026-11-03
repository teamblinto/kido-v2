import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { DomainError, RateLimitedError, ServiceUnavailableError } from './domain-error';
import { createProblemDetail, type ProblemDetail } from './problem-detail';
import { FALLBACK_PROBLEM_TYPE, PROBLEM_TYPES, problemTypeForStatus } from './problem-types';

const GENERIC_DETAIL = 'An unexpected error occurred while processing the request.';
const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const REQUEST_ID_HEADER = 'X-Request-Id';

/** An inbound correlation id is attacker-controlled, so it is only echoed when it is inert. */
const requestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

interface ProblemContext {
  instance: string;
  requestId: string;
}

interface ProblemRequest {
  readonly headers?: Record<string, unknown>;
  readonly id?: unknown;
  readonly originalUrl?: unknown;
  readonly url?: unknown;
}

/**
 * The subset of the platform response this filter needs. Declared structurally so the filter does
 * not take a dependency on the Express typings.
 */
interface ProblemResponse {
  json(body: ProblemDetail): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): ProblemResponse;
}

/**
 * The one place a thrown error becomes an HTTP body. Controllers never build an error response:
 * they throw a `DomainError` (or let a framework exception escape) and this maps it through the
 * frozen `problem-types` catalogue into an RFC 9457 document.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ProblemRequest>();
    const response = http.getResponse<ProblemResponse>();
    const context: ProblemContext = {
      instance: resolveInstance(request),
      requestId: resolveRequestId(request),
    };
    const problem = toProblemDetail(exception, context);

    if (problem.status >= 500) {
      // A `DomainError` is a *catalogued* outcome: something the code anticipated, named and chose
      // to answer with. Some of those are 5xx — a health check reporting Postgres down, a provider
      // that will not complete a token exchange, an OAuth provider this deployment deliberately
      // left unconfigured — and none of them is an unhandled exception. Logging them as one at
      // `error`, with a stack, is how a switched-off sign-in button pages somebody at three in the
      // morning, and how the genuinely unhandled fault beside it becomes invisible in the noise.
      //
      // So the two are separated by *kind* rather than by status. The service that threw a domain
      // error has already logged whatever context it had; this line only records that a request
      // ended in one. Anything else at 5xx is a fault nobody predicted, and gets the stack.
      if (exception instanceof DomainError) {
        this.logger.warn(
          `Request refused with ${problem.type} on ${context.instance} ` +
            `[requestId=${context.requestId}]`,
        );
      } else {
        this.logger.error(
          `Unhandled exception on ${context.instance} [requestId=${context.requestId}]`,
          describeForLog(exception),
        );
      }
    }

    response.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
    // RFC 9110 §15.6.2 makes 404, 405, 410, 414, 451 and 501 *heuristically* cacheable — a shared
    // cache is entitled to store one that carries no `Cache-Control` at all and serve it to the
    // next caller for as long as it likes. Every one of those is a state this API changes: a row is
    // created, a provider is configured, a route is added. `oauth-provider-not-configured` is the
    // sharpest case — an operator sets `GITHUB_OAUTH_CLIENT_ID`, redeploys, and the edge keeps
    // answering "not implemented" for a resource nobody thinks to purge. No error document is worth
    // caching and every one carries a `requestId` that is a lie the moment it is replayed, so this
    // is set for all of them rather than for the statuses that happen to need it today.
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(REQUEST_ID_HEADER, context.requestId);

    if (exception instanceof RateLimitedError || exception instanceof ServiceUnavailableError) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    response.status(problem.status).json(problem);
  }
}

function toProblemDetail(exception: unknown, context: ProblemContext): ProblemDetail {
  if (exception instanceof DomainError) {
    return createProblemDetail({
      detail: exception.detail,
      extensions: exception.extensions,
      instance: context.instance,
      requestId: context.requestId,
      type: exception.type,
    });
  }

  if (exception instanceof HttpException) {
    return fromHttpException(exception, context);
  }

  // `body-parser` refuses an oversized body with a plain `Error` carrying `status: 413` and
  // `type: 'entity.too.large'` — not an `HttpException`, so without this arm the parser's refusal
  // reaches the caller as a 500 and reads as a fault of ours rather than a limit of ours. The
  // webhook endpoint is where that first mattered (spec 026 FR-024: a body over the limit is
  // refused before any signature is computed), but the mapping was always wrong, on every route.
  //
  // Every other refusal of the parser's is the client's too — malformed JSON (`entity.parse.failed`)
  // above all — and is a 4xx of the same shape. Its message and `body` carry fragments of what was
  // sent (a one-time code, a password), so only the catalogue title is answered, and as a 4xx it is
  // never logged. `scrubBodyParserError` gets it here as itself: Nest would otherwise turn the
  // malformed-JSON `SyntaxError` into a `BadRequestException` whose detail is that message.
  const parser = bodyParserStatus(exception);

  if (parser !== undefined) {
    const slug = problemTypeForStatus(parser) ?? 'bad-request';

    return createProblemDetail({
      detail: PROBLEM_TYPES[slug].title,
      instance: context.instance,
      requestId: context.requestId,
      type: slug,
    });
  }

  return genericProblem(context);
}

/**
 * The 4xx status of an error `body-parser` / `raw-body` throws (`entity.too.large`,
 * `entity.parse.failed`, `encoding.unsupported`, …): an `http-errors` object with a dotted `type`
 * and an exposed 4xx `status`. Matched structurally: it is not a class this application can import.
 */
function bodyParserStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;

  const { status, type } = exception as { status?: unknown; type?: unknown };

  return typeof type === 'string' &&
    /^[a-z]+(\.[a-z]+)+$/.test(type) &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
    ? status
    : undefined;
}

/**
 * Express error middleware, registered right after the body parser (`bootstrap.ts`): a parser
 * refusal goes on as `{ status, type }` alone — no message, no `body` — so neither the response
 * nor a log line can carry the fragment of the request body the parser quoted.
 */
export function scrubBodyParserError(
  error: unknown,
  _request: unknown,
  _response: unknown,
  next: (error: unknown) => void,
): void {
  const status = bodyParserStatus(error);

  next(status === undefined ? error : { status, type: (error as { type: string }).type });
}

function fromHttpException(exception: HttpException, context: ProblemContext): ProblemDetail {
  const slug = problemTypeForStatus(exception.getStatus());

  if (slug === undefined) {
    return genericProblem(context);
  }

  const definition = PROBLEM_TYPES[slug];

  // A 5xx message is server-side text; only the class of failure is safe to hand to the client.
  if (definition.status >= 500) {
    return createProblemDetail({
      detail: definition.title,
      instance: context.instance,
      requestId: context.requestId,
      type: slug,
    });
  }

  const { detail, extensions } = describeHttpException(exception, definition.title);

  return createProblemDetail({
    detail,
    extensions,
    instance: context.instance,
    requestId: context.requestId,
    type: slug,
  });
}

function genericProblem(context: ProblemContext): ProblemDetail {
  return createProblemDetail({
    detail: GENERIC_DETAIL,
    instance: context.instance,
    requestId: context.requestId,
    type: FALLBACK_PROBLEM_TYPE,
  });
}

interface HttpExceptionDescription {
  detail: string;
  extensions: Record<string, unknown>;
}

function describeHttpException(
  exception: HttpException,
  fallbackDetail: string,
): HttpExceptionDescription {
  const payload: unknown = exception.getResponse();

  if (typeof payload === 'string' && payload.length > 0) {
    return { detail: payload, extensions: {} };
  }

  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const message: unknown = payload.message;

    if (typeof message === 'string' && message.length > 0) {
      return { detail: message, extensions: {} };
    }

    if (Array.isArray(message)) {
      const entries = message.filter((entry): entry is string => typeof entry === 'string');

      if (entries.length > 0) {
        return { detail: fallbackDetail, extensions: { errors: entries } };
      }
    }
  }

  return { detail: fallbackDetail, extensions: {} };
}

function describeForLog(exception: unknown): string {
  if (exception instanceof Error) {
    return exception.stack ?? `${exception.name}: ${exception.message}`;
  }

  return typeof exception === 'string' ? exception : `Non-error thrown (${typeof exception})`;
}

function resolveInstance(request: ProblemRequest): string {
  const raw = typeof request.originalUrl === 'string' ? request.originalUrl : request.url;

  if (typeof raw !== 'string') {
    return '/';
  }

  const [path] = raw.split('?');

  return path === undefined || path.length === 0 ? '/' : path;
}

function resolveRequestId(request: ProblemRequest): string {
  const candidates: unknown[] = [request.headers?.['x-request-id'], request.id];

  for (const candidate of candidates) {
    const parsed = requestIdSchema.safeParse(
      typeof candidate === 'number' ? String(candidate) : candidate,
    );

    if (parsed.success) {
      return parsed.data;
    }
  }

  return randomUUID();
}
