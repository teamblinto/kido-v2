import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import type { Environment } from '../../../config/environment';
import type { TenantTransaction } from '../../../database/database.types';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { AuditService } from '../../audit/audit.service';
import { OutboxWriter } from '../../outbox/outbox-writer';
import { caaIdentifier, observeCaa } from './caa';
import { nextCheckAt } from './check-schedule';
import { CUSTOM_HOSTNAMES, type CustomHostnamePort, EdgeRefused } from './custom-hostname.port';
import { DNS, type DnsPort } from './dns.port';
import { CHALLENGE_PREFIX } from './domain.constants';
import { type Domain, DomainRepository, type DomainSettlement } from './domain.repository';
import { DomainNotices } from './domain-notices';
import { recordRemovalRequested } from './domain-removal';
import {
  type CheckObservations,
  type DomainTransition,
  type EdgeObservation,
  evaluateCheck,
} from './evaluate-check';

/** What one `checkOne` did. */
export type CheckRun =
  /** The row was not due (another check holds its lease), not live, or not found. */
  | { readonly kind: 'not-due' }
  /** The row changed state while it was observed; the other writer's state stands. */
  | { readonly kind: 'moved' }
  | {
      readonly kind: 'settled';
      readonly domain: Domain;
      readonly transition: DomainTransition | null;
    };

/**
 * One domain's check (spec 028 research R6, R7): claim → observe → settle.
 *
 * 1. **Claim**, in a tenant transaction: the row's `next_check_at` moves a lease ahead and
 *    `claimed_at` marks it, so neither a second tick nor a check-now checks it too.
 * 2. **Observe**, with no transaction held: the DNS answers and, once registered, the edge status.
 *    When `evaluateCheck` asks for it, the hostname is registered at the edge here too. A
 *    `removing` row observes nothing: this step deregisters it instead (R10).
 * 3. **Settle**, in a tenant transaction: the state columns, `last_check` and `next_check_at`,
 *    guarded on the state and the claim it read, with the audit row and outbox event of any transition.
 *    They commit together or not at all (FR-027, SC-013).
 *
 * Every time is the injected clock's (R7). A check that throws (an evaluation not yet written for
 * the row's state, a database error) leaves the row under its claim lease, to be tried again when
 * the lease runs out; the sweep logs it and goes on with the rest.
 */
@Injectable()
export class DomainChecker {
  private readonly logger = new Logger(DomainChecker.name);

  constructor(
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(DomainRepository) private readonly domains: DomainRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxWriter) private readonly outbox: OutboxWriter,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(DNS) private readonly dns: DnsPort,
    @Inject(CUSTOM_HOSTNAMES) private readonly edge: CustomHostnamePort,
    @Inject(ConfigService) private readonly config: ConfigService<Environment, true>,
    @Inject(DomainNotices) private readonly notices: DomainNotices,
  ) {}

  async checkOne(orgId: string, domainId: string): Promise<CheckRun> {
    const routingTarget = this.config.get('CUSTOM_HOSTNAME_TARGET', { infer: true });
    if (routingTarget === undefined) {
      // No domain is added without the group (`domains-unavailable`); one left over is not
      // claimed, so it is checked as soon as the platform is configured again.
      throw new Error('CUSTOM_HOSTNAME_TARGET is not set; no domain can be checked.');
    }

    const now = this.clock.now();
    const claimed = await this.transactions.runInTenantTransaction(orgId, (tx) =>
      this.domains.claim(tx, domainId, now),
    );
    if (claimed === undefined) return { kind: 'not-due' };

    if (claimed.state === 'removing') return this.deregister(claimed, now);

    const observations = await this.observe(claimed, routingTarget);
    const outcome = evaluateCheck(claimed, observations, now);

    let edgeId: string | undefined;
    let refusal: string | undefined;
    if (outcome.register) {
      try {
        ({ edgeId } = await this.edge.register(claimed.hostname));
      } catch (error) {
        if (error instanceof EdgeRefused) refusal = error.message;
        // Retryable, or the edge not configured: registration is asked again on the next check.
        else this.logger.warn(`domain ${claimed.id}: registration deferred: ${message(error)}`);
      }
    }

    const transition: DomainTransition | null =
      refusal === undefined
        ? outcome.transition
        : // R6: a 4xx at registration does not change on a later check. Nothing was registered,
          // so there is nothing to deregister, and the hostname is released at once.
          { failureReason: 'provider-refused', from: claimed.state, to: 'failed' };

    const settlement: DomainSettlement = {
      changes: edgeId === undefined ? outcome.changes : { ...outcome.changes, edgeId },
      claim: claimed,
      failureReason: transition === null ? claimed.failureReason : transition.failureReason,
      from: claimed.state,
      lastCheck:
        refusal === undefined ? outcome.lastCheck : { ...outcome.lastCheck, edgeMessage: refusal },
      nextCheckAt: outcome.nextCheckAt,
      state: transition === null ? claimed.state : transition.to,
    };

    const settled = await this.transactions.runInTenantTransaction(orgId, async (tx) => {
      const domain = await this.domains.settle(tx, claimed.id, settlement);
      if (domain === undefined) return undefined;

      await this.record(tx, claimed, domain, settlement, transition);
      if (outcome.releaseWarning) await this.notices.append(tx, domain, 'release-warning');
      return domain;
    });

    if (settled === undefined) {
      // A removal moved the row to `removing` between claim and settle, and left this claim's
      // lease alone (`markRemoving`), so no other check can have released the hostname. The row
      // is handed over with what this check registered, and deregistered now (R10).
      const handed = await this.transactions.runInTenantTransaction(orgId, (tx) =>
        this.domains.handOver(tx, claimed.id, claimed.claimedAt!, edgeId ?? null, this.clock.now()),
      );
      if (handed !== undefined) {
        await this.checkOne(orgId, domainId);
        return { kind: 'moved' };
      }
      // Otherwise another claim took the row over when this one's lease ran out. What this check
      // registered is not on the row, so it is taken back here; a failure leaves it to the edge's
      // adoption of the next registration of the same hostname (R9).
      if (edgeId !== undefined) {
        await this.edge.deregister(edgeId).catch((error: unknown) => {
          this.logger.warn(`domain ${claimed.id}: orphan registration kept: ${message(error)}`);
        });
      }
      return { kind: 'moved' };
    }

    // A check-now that arrived while this check was in flight did not cut its lease short, so the
    // row was not claimed twice (`requestCheck`); the settle made it due again, and it is checked
    // again now, well within FR-012's 30 s. The follow-up reads the request, so it asks for none.
    if (
      settled.checkRequestedAt?.getTime() !== claimed.checkRequestedAt?.getTime() &&
      (settled.state === 'pending' || settled.state === 'drifted')
    ) {
      await this.checkOne(orgId, domainId);
    }

    return { domain: settled, kind: 'settled', transition };
  }

  /**
   * A `removing` row's check (research R10): `deregister(edge_id)` with no transaction held, then
   * the settle. The edge's confirmation (a `404` is one: the adapter counts it done) ends the row
   * `failed` when a failure reason rides on it and `removed` otherwise, with `edge_id` cleared,
   * which is what releases the hostname. Any other answer — retryable, a refusal, the edge not
   * configured — keeps it `removing` and holding the hostname, and tries again on the backoff
   * (R7). A row never registered settles at once.
   */
  private async deregister(claimed: Domain, now: Date): Promise<CheckRun> {
    let confirmed = true;
    if (claimed.edgeId !== null) {
      try {
        await this.edge.deregister(claimed.edgeId);
      } catch (error) {
        confirmed = false;
        this.logger.warn(`domain ${claimed.id}: deregistration deferred: ${message(error)}`);
      }
    }

    const transition: DomainTransition | null = confirmed
      ? {
          failureReason: claimed.failureReason,
          from: 'removing',
          to: claimed.failureReason === null ? 'removed' : 'failed',
        }
      : null;
    const settlement: DomainSettlement = {
      changes: confirmed ? { edgeId: null } : {},
      claim: claimed,
      failureReason: claimed.failureReason,
      from: claimed.state,
      // An ended row is never due again; `next_check_at` stays a plain timestamp.
      nextCheckAt: confirmed ? now : nextCheckAt(claimed, 'inconclusive', now),
      state: transition === null ? claimed.state : transition.to,
    };

    const settled = await this.transactions.runInTenantTransaction(claimed.orgId, async (tx) => {
      const domain = await this.domains.settle(tx, claimed.id, settlement);
      if (domain === undefined) return undefined;

      await this.record(tx, claimed, domain, settlement, transition);
      return domain;
    });

    // Nothing moves a `removing` row but this settle, so a second one got here first.
    if (settled === undefined) return { kind: 'moved' };

    return { domain: settled, kind: 'settled', transition };
  }

  /**
   * The I/O of a check, with no transaction held (R7). Every question is asked at once: the CNAME
   * chain, the CAA chain (the hostname and each parent above the top-level label, R5) and, once
   * registered, the edge status. A `pending` row also asks the challenge TXT until ownership is
   * proved, and the SOA for the apex status; an `active` or `drifted` row asks neither (R3, R6).
   */
  private async observe(domain: Domain, routingTarget: string): Promise<CheckObservations> {
    const pending = domain.state === 'pending';
    const [challengeTxt, cnameChain, soaOwner, caa, edge] = await Promise.all([
      // Ownership is proved once (R3); after that the TXT need not stay.
      pending && domain.ownershipVerifiedAt === null
        ? this.dns.resolveTxt(`${CHALLENGE_PREFIX}${domain.hostname}`)
        : undefined,
      this.dns.resolveCnameChain(domain.hostname),
      pending ? this.dns.resolveSoaOwner(domain.hostname) : undefined,
      observeCaa(
        this.dns,
        domain.hostname,
        caaIdentifier(this.config.get('CUSTOM_HOSTNAME_CA', { infer: true })),
      ),
      domain.edgeId === null ? undefined : this.edgeStatus(domain.id, domain.edgeId),
    ]);

    return {
      caa,
      cnameChain,
      routingTarget,
      ...(challengeTxt === undefined ? {} : { challengeTxt }),
      ...(edge === undefined ? {} : { edge }),
      ...(soaOwner === undefined ? {} : { soaOwner }),
    };
  }

  /**
   * `status(edge_id)`, or `unavailable` when the edge did not answer it: a retryable failure, the
   * edge not configured, or a refusal. Each leaves the check inconclusive (R6).
   */
  private async edgeStatus(domainId: string, edgeId: string): Promise<EdgeObservation> {
    try {
      return { kind: 'status', ...(await this.edge.status(edgeId)) };
    } catch (error) {
      this.logger.warn(`domain ${domainId}: edge status unavailable: ${message(error)}`);
      return { kind: 'unavailable' };
    }
  }

  /**
   * The trail of a settle, in its transaction: one audit row and one event per transition
   * (FR-027), and `domain.ownership-verified` (audit only) when ownership was proved or the
   * hostname registered without a state change (data-model § State transitions). The notices of
   * R14 go on the same transaction through `DomainNotices`: `drifted` on `→ drifted`, `failed` on
   * every `→ failed`, and `released` on `→ removed` when the removal was a drift release. `domain` is the row as the
   * claim read it; `settled` is the row the settle wrote.
   */
  private async record(
    tx: TenantTransaction,
    domain: Domain,
    settled: Domain,
    settlement: DomainSettlement,
    transition: DomainTransition | null,
  ): Promise<void> {
    const { hostname, id: domainId, orgId, projectId } = domain;
    const metadata = { hostname, projectId };
    const ids = { domainId, orgId, projectId };
    const { changes } = settlement;

    const newlyVerified =
      changes.ownershipVerifiedAt != null && domain.ownershipVerifiedAt === null;
    const newlyRegistered = changes.edgeId != null && domain.edgeId === null;
    if (newlyVerified || newlyRegistered) {
      await this.audit.record(tx, {
        action: 'domain.ownership-verified',
        actorId: null,
        metadata,
        orgId,
        target: domainId,
      });
    }

    if (transition === null) return;

    switch (transition.to) {
      case 'active': {
        if (transition.from !== 'pending' && transition.from !== 'drifted') break;
        const action = transition.from === 'pending' ? 'domain.activated' : 'domain.recovered';
        await this.audit.record(tx, { action, actorId: null, metadata, orgId, target: domainId });
        await this.outbox.append(tx, { aggregateId: domainId, orgId, payload: ids, type: action });
        return;
      }
      case 'drifted': {
        await this.audit.record(tx, {
          action: 'domain.drifted',
          actorId: null,
          metadata,
          orgId,
          target: domainId,
        });
        await this.outbox.append(tx, {
          aggregateId: domainId,
          orgId,
          payload: ids,
          type: 'domain.drifted',
        });
        await this.notices.append(tx, settled, 'drifted');
        return;
      }
      case 'removing': {
        // The 30-day drift release (R9), a removal like any other by nobody with no reason, or
        // the end of a registered domain's window (US4), with its reason riding on the row.
        if (transition.from !== 'drifted' && transition.from !== 'pending') break;
        await recordRemovalRequested(tx, { audit: this.audit, outbox: this.outbox }, settled, null);
        return;
      }
      case 'failed': {
        const reason = transition.failureReason!;
        await this.audit.record(tx, {
          action: 'domain.failed',
          actorId: null,
          metadata: { ...metadata, reason },
          orgId,
          target: domainId,
        });
        await this.outbox.append(tx, {
          aggregateId: domainId,
          orgId,
          payload: { ...ids, reason },
          type: 'domain.failed',
        });
        // Directly (a window end unregistered, a refused registration) or after deregistration.
        await this.notices.append(tx, settled, 'failed');
        return;
      }
      case 'removed': {
        await this.audit.record(tx, {
          action: 'domain.removed',
          actorId: null,
          metadata,
          orgId,
          target: domainId,
        });
        await this.outbox.append(tx, {
          aggregateId: domainId,
          orgId,
          payload: ids,
          type: 'domain.removed',
        });
        // Only a drift release leaves `release_warned_at` on a `removing` row (evaluateCheck;
        // a member's removal, archive and org deletion clear it in `markRemoving`).
        if (domain.releaseWarnedAt !== null) await this.notices.append(tx, settled, 'released');
        return;
      }
      default:
        break;
    }

    throw new Error(`domain ${domainId}: no trail for ${transition.from} → ${transition.to}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
