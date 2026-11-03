import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { IDEMPOTENCY_KEY_HEADER, idempotencyKeySchema } from '@repo/contracts';
import type { Observable } from 'rxjs';
import { firstValueFrom, from } from 'rxjs';

import { AUTHENTICATED_USER } from '../../modules/identity/services/session.service';
import {
  IdempotencyKeyInFlightError,
  IdempotencyKeyMalformedError,
  IdempotencyKeyReusedError,
} from './idempotency.errors';
import { fingerprintRequest } from './idempotency.fingerprint';
import { IDEMPOTENCY_WAIT, type IdempotencyWaitOptions } from './idempotency.module';
import type { IdempotencyLease, IdempotencyRecord } from './idempotency.store';
import { IdempotencyStore } from './idempotency.store';

/**
 * The methods §14 calls "unsafe", and the only ones with an effect worth suppressing. A `GET` has
 * nothing to replay, and recording one would turn this into an unasked-for read cache with a 24 h
 * TTL that no route opted into.
 */
const UNSAFE_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

/** Node lower-cases inbound header names; the contract publishes the canonical spelling. */
const HEADER = IDEMPOTENCY_KEY_HEADER.toLowerCase();

/** The namespace a request with no principal gets. Not a uuid, so it cannot collide with one. */
const ANONYMOUS = 'anon';

/** Only the parts of the platform request this interceptor reads, so it takes no Express typing. */
interface IdempotentRequest {
  readonly body?: unknown;
  readonly headers?: Record<string, unknown>;
  readonly method?: unknown;
  readonly originalUrl?: unknown;
  readonly url?: unknown;
}

interface StatusBearingResponse {
  status?: (code: number) => unknown;
  readonly statusCode?: unknown;
}

/**
 * §14's `Idempotency-Key`, for every unsafe route at once.
 *
 * Registered as an `APP_INTERCEPTOR`, so a route accepts the header by existing rather than by
 * remembering to opt in — the same argument `SessionGuard` makes for being the default. A per-route
 * decorator fails silently in the direction that matters: the endpoint that forgot it is the one
 * that charges the card twice, and nothing about it looks wrong in review.
 *
 * Three answers, and the third is the one that is usually missing:
 *
 * A repeat of a request that finished replays its recorded response. A repeat that carries a
 * *different* body gets a 409 with its own slug, because that combination is a client bug and
 * serving the first response would hide it behind a success. And a repeat that arrives while the
 * first is **still running** waits for it, then replays — or, if the first outlasts the budget,
 * gets a retryable problem. It is never executed. Two clicks race far more often than one client
 * retries, and a design that only handles the sequential retry answers the rarer case.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly store: IdempotencyStore,
    @Inject(IDEMPOTENCY_WAIT) private readonly wait: IdempotencyWaitOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return from(this.handle(context, next));
  }

  private async handle(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    if (context.getType() !== 'http') {
      return firstValueFrom(next.handle());
    }

    const http = context.switchToHttp();
    const request = http.getRequest<IdempotentRequest>();
    const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
    const header = request.headers?.[HEADER];

    // The header is optional by design: §14 says every unsafe endpoint *accepts* a key, not that it
    // requires one, and requiring it globally would reject every request written before this task.
    if (!UNSAFE_METHODS.has(method) || header === undefined) {
      return firstValueFrom(next.handle());
    }

    const slot = {
      fingerprint: fingerprintRequest({
        body: request.body,
        method,
        target: resolveTarget(request),
      }),
      key: parseKey(header),
      namespace: resolveNamespace(request),
    };

    for (let waited = 0; ; waited += this.wait.pollIntervalMs) {
      const outcome = await this.store.begin(slot);

      if (outcome.outcome === 'acquired') {
        return this.execute(outcome.lease, http, next);
      }

      if (outcome.outcome === 'mismatch') {
        throw new IdempotencyKeyReusedError();
      }

      if (outcome.outcome === 'replay') {
        return replay(http, outcome.record);
      }

      if (waited >= this.wait.waitBudgetMs) {
        throw new IdempotencyKeyInFlightError(this.wait.waitBudgetMs / 1_000);
      }

      // Polling rather than a keyspace subscription: the waiter is a request holding a connection,
      // and the wait is bounded in milliseconds, so a second Redis client per waiting request would
      // cost more than the `GET` it replaces.
      await delay(this.wait.pollIntervalMs);
    }
  }

  private async execute(
    lease: IdempotencyLease,
    http: ReturnType<ExecutionContext['switchToHttp']>,
    next: CallHandler,
  ): Promise<unknown> {
    let result: unknown;

    try {
      result = await firstValueFrom(next.handle());
    } catch (error) {
      await this.forgive('release', () => this.store.release(lease));

      throw error;
    }

    await this.forgive('complete', () =>
      this.store.complete(lease, { body: result, status: statusOf(http.getResponse()) }),
    );

    return result;
  }

  /**
   * Redis failing *after* the handler has run must not fail the request.
   *
   * The mutation already happened. Turning a bookkeeping failure into a 500 would hand the client
   * an error for work that succeeded, and the retry it makes would be the second execution this
   * whole interceptor exists to prevent. The cost of swallowing it is a lost record — a later retry
   * executes again — which is strictly better than guaranteeing one now.
   */
  private async forgive(operation: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.logger.warn(
        `Failed to ${operation} an idempotency record; the request itself was unaffected. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * The principal the key belongs to.
 *
 * Without it every client shares one namespace, and a caller who learned another caller's key — and
 * could reproduce the request that goes with it — would be handed that caller's response. The guard
 * has already run by the time an interceptor is reached, so the principal is on the request if the
 * route has one; a public route namespaces to {@link ANONYMOUS}, where the key is all the identity
 * there is.
 */
function resolveNamespace(request: IdempotentRequest): string {
  const principal = (request as Record<PropertyKey, unknown>)[AUTHENTICATED_USER];

  if (typeof principal !== 'object' || principal === null) {
    return ANONYMOUS;
  }

  const userId: unknown = (principal as { userId?: unknown }).userId;

  return typeof userId === 'string' && /^[0-9a-f-]{36}$/i.test(userId) ? userId : ANONYMOUS;
}

/** Path *and* query: `?force=true` is part of which request this is, so it belongs in the hash. */
function resolveTarget(request: IdempotentRequest): string {
  if (typeof request.originalUrl === 'string') {
    return request.originalUrl;
  }

  return typeof request.url === 'string' ? request.url : '/';
}

/**
 * Two values under one header name is not a key with a preference, it is a request that does not
 * say which slot it means — so it is rejected rather than resolved by picking the first.
 */
function parseKey(raw: unknown): string {
  const values: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  const distinct = new Set(values);
  const parsed = idempotencyKeySchema.safeParse(distinct.size === 1 ? values[0] : undefined);

  if (!parsed.success) {
    throw new IdempotencyKeyMalformedError();
  }

  return parsed.data;
}

function replay(
  http: ReturnType<ExecutionContext['switchToHttp']>,
  record: IdempotencyRecord,
): unknown {
  const response = http.getResponse<StatusBearingResponse>();

  response.status?.(record.status);

  return record.body;
}

function statusOf(response: StatusBearingResponse): number {
  return typeof response.statusCode === 'number' ? response.statusCode : 200;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
