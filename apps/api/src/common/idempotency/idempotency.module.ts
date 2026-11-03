import { Module } from '@nestjs/common';

import { IdempotencyStore } from './idempotency.store';

/** How long a request will wait for the in-flight request holding its key, and how often it looks. */
export interface IdempotencyWaitOptions {
  readonly pollIntervalMs: number;
  readonly waitBudgetMs: number;
}

/** A symbol for the reason `redis.constants.ts` gives: a string token collides silently. */
export const IDEMPOTENCY_WAIT = Symbol('forge.idempotency.wait');

/**
 * Long enough that the ordinary double-click resolves into a replay rather than into a problem
 * document the user has to act on, and short enough that a stuck request does not hold a connection
 * for the whole of its lease. Beyond this the waiter is told to retry, which is a state the client
 * can present — never a second execution.
 */
export const DEFAULT_IDEMPOTENCY_WAIT: IdempotencyWaitOptions = {
  pollIntervalMs: 25,
  waitBudgetMs: 5_000,
};

/**
 * The store and its wait policy. The interceptor itself is bound in `app.module.ts` as an
 * `APP_INTERCEPTOR`, because that is the binding Nest collects application-wide, and a module that
 * quietly registered a global interceptor by being imported would make "what runs on every request?"
 * a question answered in eleven files instead of one.
 */
@Module({
  exports: [IDEMPOTENCY_WAIT, IdempotencyStore],
  providers: [IdempotencyStore, { provide: IDEMPOTENCY_WAIT, useValue: DEFAULT_IDEMPOTENCY_WAIT }],
})
export class IdempotencyModule {}
