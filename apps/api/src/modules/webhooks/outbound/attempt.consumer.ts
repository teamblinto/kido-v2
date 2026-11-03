import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { isOpen } from '../../../common/circuit/circuit';
import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { type Plaintext, revealPlaintext } from '../../../common/crypto/branded';
import type { TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import { EventConsumer, RetryableFailure } from '../../outbox/consumer';
import type { Envelope } from '../../outbox/envelope';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { INTEGRATION_OUT_QUEUE } from '../webhooks.constants';
import { type AttemptClass, classifyAttempt } from './classify';
import { EndpointRepository } from './endpoint.repository';
import { SafeTransport } from './safe-transport';
import { nextAttemptAt } from './schedule';
import { SendRepository, type SettleResult } from './send.repository';
import { signPayload } from './signature';
import { SigningSecrets } from './signing-secret';

/** What `handle` claimed and `effect` sends. Held in memory only; the secrets never leave it. */
export interface AttemptPlan {
  /** Scheduled attempts made before this one. */
  readonly attempts: number;
  readonly body: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  /** The anchor of the 24 h window; null before the first attempt. */
  readonly firstAttemptAt: Date | null;
  /** A replay (research R11): one attempt outside the schedule, never retried. */
  readonly manual: boolean;
  readonly orgId: string;
  readonly secrets: readonly Plaintext[];
  readonly sendId: string;
  readonly url: string;
}

type AttemptDue = Envelope<'webhook.attempt-due'>;

/** What `handle` returns when the org is at its in-flight bound and the send was moved 5 s on. */
export const DEFERRED = 'deferred' as const;

/**
 * How often a deferred job is retried by the lane's backoff (2 s base, doubling, full jitter)
 * before the redelivery sweep takes the send over. Nothing else in this consumer throws a
 * `RetryableFailure`: an attempt's own failures are classified into the row, never retried here.
 */
export const DEFER_RETRIES = 5;

/** How long an endpoint must have been failing before a send that gives up pauses it (FR-022). */
const PAUSE_AFTER_MS = 24 * 3_600_000;

/**
 * One attempt of one send (spec 029 research R6), on `integration.out`, one job per attempt:
 *
 * 1. `handle`, on the base's transaction with the org set as the tenant: claim the send (a 30 s
 *    lease; a send that is not `pending`, or that another attempt holds, is left alone; one past
 *    the org's `IN_FLIGHT_PER_ORG` live leases is deferred 5 s), load the endpoint and open its
 *    live secrets. A send whose endpoint is no longer enabled becomes `not_sent`; one whose
 *    endpoint's circuit is open is released to the circuit's close. Neither consumes an attempt.
 * 2. `effect`, with no transaction held: sign with a fresh `t`, then `SafeTransport` resolves
 *    through `WEBHOOK_RESOLVER`, checks every address against the policy and connects pinned.
 *    Each resolver outcome maps through `classifyAttempt` (US2): `unavailable` or `empty` is the
 *    retryable `dns-failed`; every address refused is the terminal `destination-refused`, with the
 *    attempt's `address` null and no byte sent; otherwise the first allowed address is pinned.
 * 3. Settle in a new tenant transaction (US3): the attempt row; `succeeded`, `failed` on a terminal
 *    failure, or `pending` at the schedule's next time (`failed` once it is exhausted); the
 *    endpoint's circuit and `failing_since`. A send that ends `failed` while the endpoint has been
 *    failing for 24 h pauses the endpoint in the same transaction (research R9): its other pending
 *    sends become `not_sent`, `webhook.endpoint-paused` is appended and the pause is audited with
 *    no actor.
 *
 * The schedule lives in the row, not in Redis. BullMQ's retries serve one purpose only: a claim
 * deferred by the org's in-flight bound comes back after the lane's backoff (`DEFER_RETRIES`).
 */
@Injectable()
export class WebhookAttemptConsumer extends EventConsumer<
  'webhook.attempt-due',
  AttemptPlan | typeof DEFERRED | null
> {
  readonly attempts = DEFER_RETRIES + 1;
  override readonly concurrency = 32;
  readonly name = 'webhook-attempt';
  override readonly profile = 'events' as const;
  readonly queue = INTEGRATION_OUT_QUEUE;
  readonly types = ['webhook.attempt-due'] as const;

  constructor(
    @Inject(SendRepository) private readonly sends: SendRepository,
    @Inject(EndpointRepository) private readonly endpoints: EndpointRepository,
    @Inject(SigningSecrets) private readonly secrets: SigningSecrets,
    @Inject(SafeTransport) private readonly transport: SafeTransport,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    super();
  }

  async handle(
    event: AttemptDue,
    tx: TenantTransaction,
  ): Promise<AttemptPlan | typeof DEFERRED | null> {
    const { orgId, sendId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);

    const now = this.clock.now();
    const claim = await this.sends.claim(tx, orgId, sendId, now);
    if (claim.kind === 'deferred') return DEFERRED;
    if (claim.kind !== 'claimed') return null;
    const { send } = claim;

    const endpoint = await this.endpoints.byId(tx, orgId, send.endpointId);
    if (endpoint === undefined) return null;
    if (endpoint.state !== 'enabled' || send.body === null) {
      await this.sends.markNotSent(tx, orgId, sendId, now);
      await this.dispatchNext(tx, orgId, now);
      return null;
    }
    if (isOpen(endpoint, now)) {
      await this.sends.release(tx, orgId, sendId, endpoint.circuitOpenUntil!, now);
      await this.dispatchNext(tx, orgId, now);
      return null;
    }

    return {
      attempts: send.attempts,
      body: send.body,
      endpointId: endpoint.id,
      eventId: send.eventId,
      eventType: send.eventType,
      firstAttemptAt: send.firstAttemptAt,
      manual: event.payload.manual === true,
      orgId,
      secrets: await this.secrets.openLive(tx, endpoint, now),
      sendId,
      url: endpoint.url,
    };
  }

  override async effect(
    _event: AttemptDue,
    plan: AttemptPlan | typeof DEFERRED | null,
    attempt = 1,
  ): Promise<void> {
    if (plan === null) return;
    // Fairness (research R9): the job comes back after BullMQ's jittered backoff rather than
    // waiting a whole sweep period; on the last try the row's `next_attempt_at` is left to the
    // sweep. The send's own attempts are untouched either way.
    if (plan === DEFERRED) {
      if (attempt <= DEFER_RETRIES) throw new RetryableFailure('throttled');
      return;
    }

    const attemptedAt = this.clock.now();
    const signature = signPayload(
      plan.secrets.map((secret) => revealPlaintext(secret).toString('utf8')),
      Math.floor(attemptedAt.getTime() / 1000),
      plan.body,
    );
    const result = await this.transport.send({
      body: plan.body,
      deliveryId: plan.sendId,
      eventId: plan.eventId,
      eventType: plan.eventType,
      signature,
      url: plan.url,
    });
    const settledAt = this.clock.now();
    const verdict = classifyAttempt(result, settledAt);
    const responded = result.status !== null;

    await this.transactions.runInTenantTransaction(plan.orgId, async (tx) => {
      // The endpoint row first, as a delete takes it before cascading to the send: the same order
      // on both sides, so a settle racing a delete waits instead of deadlocking. A deleted
      // endpoint took the send with it, and there is nothing left to record.
      if ((await this.endpoints.lock(tx, plan.orgId, plan.endpointId)) === undefined) return;
      await this.sends.insertAttempt(tx, {
        address: result.address,
        attemptedAt,
        durationMs: result.durationMs,
        failure: verdict.failure,
        manual: plan.manual,
        orgId: plan.orgId,
        responseBody: responded ? result.body : null,
        responseHeaders: responded ? result.headers : null,
        sendId: plan.sendId,
        status: result.status,
      });
      const outcome = this.outcome(plan, verdict, attemptedAt, settledAt);
      await this.sends.settle(tx, plan.orgId, plan.sendId, outcome);

      if (verdict.kind === 'success') {
        await this.endpoints.recordSuccess(tx, plan.orgId, plan.endpointId, settledAt);
        await this.dispatchNext(tx, plan.orgId, settledAt);
        return;
      }

      const endpoint = await this.endpoints.recordFailure(
        tx,
        plan.orgId,
        plan.endpointId,
        settledAt,
        verdict.kind === 'retryable',
      );
      // A replay that fails is the member's own test of the receiver, not the schedule giving up:
      // it never pauses the endpoint.
      if (
        !plan.manual &&
        outcome.state === 'failed' &&
        endpoint?.failingSince != null &&
        endpoint.failingSince.getTime() <= settledAt.getTime() - PAUSE_AFTER_MS
      ) {
        await this.pause(tx, plan.orgId, plan.endpointId, settledAt);
      }
      await this.dispatchNext(tx, plan.orgId, settledAt);
    });
  }

  /** The send's next state: the schedule decides a retryable failure of a scheduled attempt (R7). */
  private outcome(
    plan: AttemptPlan,
    verdict: AttemptClass,
    attemptedAt: Date,
    now: Date,
  ): SettleResult {
    const base = { failure: verdict.failure, manual: plan.manual, now };
    if (verdict.kind === 'success') return { ...base, state: 'succeeded' };
    // A manual attempt is outside the schedule (research R11): a failure of it is final.
    if (verdict.kind === 'terminal' || plan.manual) return { ...base, state: 'failed' };

    const next = nextAttemptAt({
      attempt: plan.attempts + 1,
      firstAttemptAt: plan.firstAttemptAt ?? attemptedAt,
      now,
      retryAfterMs: verdict.retryAfterMs,
    });
    return next === null
      ? { ...base, state: 'failed' }
      : { ...base, nextAttemptAt: next, state: 'pending' };
  }

  /**
   * The chain (research R9): a finished attempt hands its place to the org's oldest due send with
   * no job, which fan-out left past `DISPATCH_PER_ORG`. Claimed one lease ahead, as the sweep does,
   * so neither dispatches it twice. The org's dispatch lock is the last lock the transaction takes,
   * as in fan-out, and the pick skips rows another transaction holds: no lock cycle can form.
   */
  private async dispatchNext(tx: TenantTransaction, orgId: string, now: Date): Promise<void> {
    await this.sends.lockDispatch(tx, orgId);
    const next = await this.sends.claimDue(
      tx,
      orgId,
      await this.sends.nextDue(tx, orgId, now, 1),
      now,
    );
    for (const sendId of next) {
      await this.outbox.append(tx, {
        aggregateId: sendId,
        orgId,
        payload: { orgId, sendId },
        type: 'webhook.attempt-due',
      });
    }
  }

  /** The pause (research R9), on the settling transaction. */
  private async pause(
    tx: TenantTransaction,
    orgId: string,
    endpointId: string,
    now: Date,
  ): Promise<void> {
    const paused = await this.endpoints.pause(tx, orgId, endpointId, now);
    if (paused === undefined) return;

    await this.sends.moveEndpointPendingToNotSent(tx, orgId, endpointId, now);
    await this.outbox.append(tx, {
      aggregateId: endpointId,
      orgId,
      payload: { endpointId, orgId },
      type: 'webhook.endpoint-paused',
    });
    await this.audit.record(tx, {
      action: 'webhook.endpoint-paused',
      actorId: null,
      orgId,
      target: endpointId,
    });
  }
}
