import { Inject, Injectable, Logger } from '@nestjs/common';
import { orgs } from '@repo/db';
import { isNull } from 'drizzle-orm';

import { APP_DATABASE } from '../../database/database.constants';
import type { ForgeDatabase } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { CheckpointService } from '../checkpoints/checkpoint.service';
import { EventConsumer, RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import {
  type DeliveryFailure,
  InboundDeliveryService,
} from '../webhooks/inbound/inbound-delivery.service';
import { ConnectionRepository } from './connection.repository';
import { RepoLinkRepository } from './repo-link.repository';
import { SyncRepository } from './sync.repository';

/**
 * Its own queue, and its own consumer (contracts/webhook.md § 5).
 *
 * Separate from `SyncConsumer` because `QueueRegistry` refuses two consumers of one event type on
 * one queue — the lesson spec 018 recorded when its push/pull pair became one dispatching consumer.
 * On the `events` lane: this is database work and one UPDATE, never a sandbox call.
 */
export const CONNECTOR_WEBHOOK_QUEUE = 'connector.webhook';

/** A `push` names a branch with this; anything else — a tag, a note — is not this feature's. */
const BRANCH_PREFIX = 'refs/heads/';

/** GitHub's "this ref no longer exists": forty zeroes where a sha would be. */
const DELETED_SHA = '0'.repeat(40);

/** Set on the error `park` hands back, so the outer catch does not park the same delivery twice. */
const PARKED = Symbol('webhook-delivery-parked');

/** One organisation's link that this delivery names, resolved before anything is written. */
interface Match {
  readonly orgId: string;
  readonly projectIds: readonly string[];
}

/** What the first pass decided, handed to the second. */
interface Plan {
  /** The `after` the links take: `null` for a deleted branch — *unknown*, not *level*. */
  readonly head: string | null;
  readonly matches: readonly Match[];
  readonly repoId: number;
  readonly branch: string;
}

/**
 * The drain for `webhook.received` — the six steps of contracts/webhook.md § 5 (spec 026 US3).
 *
 * The event filter, the ref filter, the in-flight defer, the platform-scoped installation
 * resolution, the per-organisation tenant transaction under the project's writer lock, and the
 * terminal state, in that order and for reasons the contract argues. Never a pull, a push, a
 * sandbox call or a checkpoint (FR-034): the whole effect of a delivery is one column of spec 018's
 * link, set by `(org, repo_id, branch)`.
 *
 * All of it runs in `effect`, not in `handle`. `handle`'s transaction commits with the processed
 * row, and the work here is one read of a **platform** table followed by a transaction *per
 * organisation* — `connections` and `repo_links` are under forced RLS and this process holds no
 * bypass role, so there is no single transaction that could see them all. That is the health
 * sweep's shape, cited by § 5 step 4, and it is why the resolution iterates live organisations
 * rather than selecting across them.
 *
 * The queue is registered by this class being an ordinary provider of `ConnectorsModule` —
 * `QueueRegistry` finds it through `DiscoveryService`, which is why `connectors` imports nothing of
 * `outbox` beyond the base class.
 */
@Injectable()
export class WebhookDeliveryConsumer extends EventConsumer<'webhook.received'> {
  /** The outbox's bounded retries; a delivery that spends them parks as `failed` (FR-029). */
  readonly attempts = 5;
  readonly name = 'webhook-delivery';
  override readonly profile = 'events' as const;
  readonly queue = CONNECTOR_WEBHOOK_QUEUE;
  readonly types = ['webhook.received'] as const;

  private readonly logger = new Logger(WebhookDeliveryConsumer.name);

  constructor(
    @Inject(APP_DATABASE) private readonly db: ForgeDatabase,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(InboundDeliveryService) private readonly deliveries: InboundDeliveryService,
    @Inject(ConnectionRepository) private readonly connections: ConnectionRepository,
    @Inject(RepoLinkRepository) private readonly links: RepoLinkRepository,
    @Inject(SyncRepository) private readonly operations: SyncRepository,
    @Inject(CheckpointService) private readonly checkpoints: CheckpointService,
  ) {
    super();
  }

  handle(_event: Envelope<'webhook.received'>): Promise<void> {
    // Nothing on the base's transaction: see the class comment. The work is `effect`'s.
    return Promise.resolve();
  }

  override async effect(
    event: Envelope<'webhook.received'>,
    _prepared: void,
    attempt = 1,
  ): Promise<void> {
    await this.process(event.payload.deliveryId, attempt);
  }

  /**
   * One delivery, driven by its id. Public so a suite can run it without the queue, as the health
   * sweep is — `attempt` is the outbox's 1-based count, and is what decides parking.
   */
  async process(deliveryId: string, attempt = 1): Promise<void> {
    const delivery = await this.deliveries.byId(deliveryId);

    if (delivery === null) {
      // The retention sweep deleted it, or it never existed. Nothing to retry from: FR-029's whole
      // promise is the record, and there is none.
      this.logger.warn(`delivery ${deliveryId} is gone; nothing to process`);

      return;
    }

    if (delivery.state !== 'received') return;

    try {
      await this.act(
        delivery.id,
        delivery.eventType,
        delivery.installationId,
        delivery.body,
        attempt,
      );
    } catch (error) {
      if (
        error instanceof RetryableFailure ||
        (error as Record<symbol, unknown> | null)?.[PARKED] === true
      ) {
        throw error;
      }

      throw await this.park(delivery.id, attempt, 'processing-failed', error);
    }
  }

  /** Steps 1–6. Throws `RetryableFailure` to defer (step 3); every other throw is a failure. */
  private async act(
    id: string,
    eventType: string,
    installationId: number | null,
    body: Record<string, unknown> | null,
    attempt: number,
  ): Promise<void> {
    // 1. Not `push` → ignored. 2. Not a branch → ignored. Neither is an error: § 2 is explicit that
    // a delivery we do not act on is recorded and dropped, never refused.
    // `''` for a delivery that carries no `ref` at all, which starts with nothing and is ignored
    // on the same line as a tag.
    const ref = readString(body, 'ref') ?? '';

    if (eventType !== 'push' || !ref.startsWith(BRANCH_PREFIX)) {
      return this.deliveries.settle(id, 'ignored', attempt);
    }

    const repoId = readRepoId(body);

    if (installationId === null || repoId === undefined) {
      return this.deliveries.settle(id, 'ignored', attempt);
    }

    const after = readString(body, 'after');
    const branch = ref.slice(BRANCH_PREFIX.length);
    const plan: Plan = {
      branch,
      // A deleted branch clears the column: `remote_head_sha` null reads as *unknown* through
      // `position`, which is the truth — not `level`, which would claim the project matches a
      // branch that is gone.
      head: after === undefined || after === DELETED_SHA ? null : after,
      matches: await this.resolve(installationId, repoId, branch),
      repoId,
    };

    // 4. No connection anywhere holds the installation, or no link names the repository and branch.
    if (plan.matches.length === 0) {
      return this.deliveries.settle(id, 'ignored', attempt);
    }

    // 3. An operation is in flight on a candidate project: defer the whole delivery with the
    // outbox's backoff rather than writing any of it (R14). Checked across every match before the
    // first write, so a deferral never leaves half the organisations advanced.
    if (await this.anyInFlight(plan.matches)) {
      await this.deliveries.settle(id, 'received', attempt, null);

      if (attempt >= this.attempts) {
        throw await this.park(
          id,
          attempt,
          'in-flight',
          new Error('an operation is still in flight'),
        );
      }

      throw new RetryableFailure('throttled');
    }

    // 5. Per organisation, each try/caught: one organisation cannot fail the delivery for the
    // others (SC-013).
    let advanced = 0;

    for (const match of plan.matches) {
      try {
        advanced += await this.advance(match, plan);
      } catch (error) {
        this.logger.warn(`delivery ${id} skipped org ${match.orgId}: ${(error as Error).message}`);
      }
    }

    // 6. Terminal.
    await this.deliveries.settle(id, advanced > 0 ? 'processed' : 'ignored', attempt);
  }

  /**
   * Step 4, the health sweep's pattern: every live organisation whose `github` connection holds
   * this installation *and* whose links name this repository and branch. A tenant transaction per
   * organisation because `connections` is `FORCE ROW LEVEL SECURITY` and nothing here bypasses it.
   */
  private async resolve(installationId: number, repoId: number, branch: string): Promise<Match[]> {
    const tenants = await this.db.select({ id: orgs.id }).from(orgs).where(isNull(orgs.deletedAt));
    const matches: Match[] = [];

    for (const { id: orgId } of tenants) {
      try {
        const found = await this.transactions.runInTenantTransaction(orgId, async (tx) => {
          const connection = await this.connections.byProvider(tx, orgId, 'github');

          if (connection?.installationId !== installationId) return undefined;

          const links = await this.links.forRepoBranch(tx, orgId, repoId, branch);

          if (links.length === 0) return undefined;

          return {
            orgId,
            projectIds: links.map((link) => link.projectId),
          } satisfies Match;
        });

        if (found !== undefined) matches.push(found);
      } catch (error) {
        this.logger.warn(`resolution skipped org ${orgId}: ${(error as Error).message}`);
      }
    }

    return matches;
  }

  /** Step 3's question, asked of every candidate project before any of them is written. */
  private async anyInFlight(matches: readonly Match[]): Promise<boolean> {
    for (const match of matches) {
      const inFlight = await this.transactions.runInTenantTransaction(match.orgId, async (tx) => {
        for (const projectId of match.projectIds) {
          if (await this.operations.inFlightExists(tx, match.orgId, projectId)) return true;
        }

        return false;
      });

      if (inFlight) return true;
    }

    return false;
  }

  /** Step 5 for one organisation: the writer lock, then the one column. */
  private async advance(match: Match, plan: Plan): Promise<number> {
    return this.transactions.runInTenantTransaction(match.orgId, async (tx) => {
      for (const projectId of match.projectIds) {
        // The same lock a pull takes, so the later of the two writers wins (R14, FR-036).
        await this.checkpoints.lockProject(tx, { orgId: match.orgId, projectId });
      }

      return this.links.setRemoteHeadByRepo(tx, match.orgId, plan.repoId, plan.branch, plan.head);
    });
  }

  /**
   * FR-029: the bounded budget spent, the delivery parks as `failed` — visibly, which is what the
   * partial index `webhook_deliveries_failed_idx` and `WebhookDeliveryRepository.failedSince` are
   * for, and the error is returned for the caller to throw so the base dead-letters the job the way
   * every other consumer's terminal failure is dead-lettered. Parked *and* dead-lettered: the row
   * says which delivery, the letter says what the attempts were.
   */
  private async park(
    id: string,
    attempt: number,
    failure: DeliveryFailure,
    cause: unknown,
  ): Promise<Error> {
    if (attempt < this.attempts) {
      await this.deliveries.settle(id, 'received', attempt, null);

      return new RetryableFailure('timeout', cause);
    }

    await this.deliveries.settle(id, 'failed', attempt, failure);

    // The category and the id only — never the body, which is a provider's payload (FR-031).
    this.logger.error(
      `delivery ${id} parked as failed after ${String(attempt)} attempt(s): ${failure}`,
    );

    const error = cause instanceof Error ? cause : new Error(String(cause));

    Object.defineProperty(error, PARKED, { value: true });

    return error;
  }
}

function readString(body: Record<string, unknown> | null, key: string): string | undefined {
  const value = body?.[key];

  return typeof value === 'string' ? value : undefined;
}

function readRepoId(body: Record<string, unknown> | null): number | undefined {
  const repository = body?.repository;

  if (typeof repository !== 'object' || repository === null) return undefined;

  const id = (repository as { id?: unknown }).id;

  return typeof id === 'number' ? id : undefined;
}
