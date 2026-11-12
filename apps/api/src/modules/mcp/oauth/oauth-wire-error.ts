import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';

import { DomainError } from '../../../common/errors/domain-error';

/** RFC 6749 §5.2 and RFC 7591 §3.2.2 error codes this server answers with. */
export type OAuthWireErrorCode =
  | 'invalid_client'
  | 'invalid_client_metadata'
  | 'invalid_grant'
  | 'invalid_redirect_uri'
  | 'invalid_request'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'unsupported_grant_type';

/**
 * A failure on the token, registration or revocation endpoint. Those three are spoken to by OAuth
 * client libraries, which parse `{ error, error_description }` and nothing else — an RFC 9457
 * problem document there would read as an unknown failure. Every other route keeps problem details.
 */
export class OAuthWireError extends Error {
  constructor(
    readonly code: OAuthWireErrorCode,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = 'OAuthWireError';
  }
}

interface WireResponse {
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): WireResponse;
}

/** Bound to the OAuth wire controller only (`@UseFilters`), so the global filter keeps the rest. */
@Catch()
export class OAuthWireErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(OAuthWireErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<WireResponse>();
    const error = toWireError(exception);

    if (error.code === 'server_error') {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    response.setHeader('Cache-Control', 'no-store');
    response.status(error.status).json({
      error: error.code,
      error_description: error.description,
    });
  }
}

function toWireError(exception: unknown): OAuthWireError {
  if (exception instanceof OAuthWireError) return exception;

  // The throttler's refusal: a client library retries on 503 + Retry-After, not on an unknown 429.
  if (exception instanceof HttpException && exception.getStatus() === 429) {
    return new OAuthWireError('temporarily_unavailable', 'Too many requests; retry later.', 429);
  }

  if (exception instanceof DomainError && exception.type === 'payload-too-large') {
    return new OAuthWireError('invalid_request', 'The request body is too large.', 413);
  }

  return new OAuthWireError('server_error', 'The authorization server failed.', 500);
}
