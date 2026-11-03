import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConnectorOpKind, ConnectorOpReason, ConnectorProvider } from '@repo/contracts';
import { type Connection, type ConnectorOperation, schema } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';

import { isOpen } from '../../common/circuit/circuit';
import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import type { Plaintext } from '../../common/crypto/branded';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { EventConsumer, RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { ConnectionService } from './connection.service';
import { OperationRepository } from './operation.repository';
import { type ProviderCategory, ProviderFailure } from './providers/provider';

export const CONNECTOR_OPS_QUEUE = 'connector.ops';

/** `netlify_publish`'s timeout (R11): the sweep leaves a publish running this long. */
export { STALE_PUBLISH_MS } from './operation.repository';

/**
 * A handler's own terminal outcome, in the operation's vocabulary — `site-gone`, `record-conflict`,
 * `zone-not-found` — for what a {@link ProviderFailure} category cannot say. Never retried.
 */
export class OperationFailure extends Error {
  constructor(readonly reason: ConnectorOpReason) {
    super(`Connector operation failed: ${reason}`);
    this.name = 'OperationFailure';
  }
}

export interface OperationContext {
  readonly attempt: number;
  readonly connection: Connection;
  /** The connection's credential, opened for this job; it never leaves the call. */
  readonly credential: Plaintext;
  readonly lastAttempt: boolean;
  readonly operation: ConnectorOperation;
  /** A tenant transaction for the handler's own rows; no transaction is held across a call. */
  readonly inTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>;
}

/**
 * One kind's work. Returning closes the operation `succeeded`; throwing a {@link ProviderFailure}
 * or an {@link OperationFailure} closes or retries it by the table in research R5 / §10.
 */
export interface OperationHandler {
  run(context: OperationContext): Promise<void>;
}

export type OperationHandlers = ReadonlyMap<ConnectorOpKind, OperationHandler>;

/** Empty until each provider's story registers its handlers (`ConnectorsModule`). */
export const CONNECTOR_OP_HANDLERS = Symbol('forge.connectors.opHandlers');

/** The provider a kind writes to, when neither its resource nor its binding names a connection. */
const KIND_PROVIDER: Readonly<Partial<Record<ConnectorOpKind, ConnectorProvider>>> = {
  dns_write: 'cloudflare',
  neon_branch_create: 'neon',
  neon_branch_reset: 'neon',
  netlify_publish: 'netlify',
  resend_key_mint: 'resend',
  supabase_key_fetch: 'supabase',
};

/** Kinds that must run on a connection being removed or awaiting re-authorisation (§ 7). */
const RELEASE_KINDS: ReadonlySet<ConnectorOpKind> = new Set([
  'connection_remove',
  'resource_release',
]);

/** R5: a terminal category's reason on the row. */
const TERMINAL_REASON: Readonly<Partial<Record<ProviderCategory, ConnectorOpReason>>> = {
  conflict: 'provider-refused',
  'not-found': 'not-found',
  'quota-exceeded': 'quota-exceeded',
  validation: 'provider-refused',
};

type OpEvent = Envelope<'connector.op.requested'>;

/** `undefined`: the operation is gone or already settled — nothing for `effect`. */
export type OpJob = { readonly operation: ConnectorOperation } | undefined;

type Settlement =
  | { readonly state: 'succeeded' }
  | { readonly reason: ConnectorOpReason; readonly state: 'failed' };

/**
 * `connector.op.requested` → one provider write (spec 030 R15), on its own queue so a Netlify
 * publish holding a slot for minutes never starves 029's webhook attempts. `handle` marks the row
 * `running` on the base's transaction; `effect` opens the connection's credential in a short
 * tenant transaction, dispatches by `kind`, and settles the row — with no transaction held across
 * the provider call.
 *
 * After every provider call the connection is updated (R5, SC-007): `unauthorized` →
 * `needs_reauth`, `forbidden-scope` → `needs_reauth` with the operation `missing-scope`, a
 * retryable failure → the breaker (five in a row open the circuit), a success → closes it. An open
 * circuit or a `needs_reauth` row is refused from the row, before any call.
 */
@Injectable()
export class ConnectorOpsConsumer extends EventConsumer<'connector.op.requested', OpJob> {
  readonly attempts = 5;
  override readonly concurrency = 8;
  readonly name = 'connector-ops';
  override readonly profile = 'events' as const;
  readonly queue = CONNECTOR_OPS_QUEUE;
  readonly types = ['connector.op.requested'] as const;

  private readonly logger = new Logger(ConnectorOpsConsumer.name);

  constructor(
    @Inject(OperationRepository) private readonly operations: OperationRepository,
    @Inject(ConnectionService) private readonly connections: ConnectionService,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(CLOCK) private readonly clock: ClockPort,
    @Inject(CONNECTOR_OP_HANDLERS) private readonly handlers: OperationHandlers,
  ) {
    super();
  }

  override jobId(event: OpEvent): string {
    return event.payload.operationId;
  }

  async handle(event: OpEvent, tx: TenantTransaction): Promise<OpJob> {
    const { operationId, orgId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    const operation = await this.operations.byId(tx, orgId, operationId);

    // `running` is this job's own earlier attempt: the retry runs `handle` again.
    if (
      operation === undefined ||
      (operation.state !== 'queued' && operation.state !== 'running')
    ) {
      return undefined;
    }

    if (operation.state === 'queued') {
      await this.operations.markRunning(tx, orgId, operation.id, this.clock.now());
    }

    return { operation };
  }

  override async effect(_event: OpEvent, job: OpJob, attempt = 1): Promise<void> {
    if (job === undefined) return;

    const { operation } = job;
    const lastAttempt = attempt >= this.attempts;
    const handler = this.handlers.get(operation.kind);

    if (handler === undefined) {
      this.logger.warn(`operation ${operation.id}: no handler for ${operation.kind}`);
      await this.settle(operation, { reason: 'provider-unavailable', state: 'failed' });

      return;
    }

    const opened = await this.transactions.runInTenantTransaction(operation.orgId, (tx) =>
      this.open(tx, operation),
    );

    if (opened.kind === 'refused') {
      await this.settle(operation, { reason: opened.reason, state: 'failed' });

      return;
    }

    if (opened.kind === 'circuit-open') {
      if (!lastAttempt) throw new RetryableFailure('upstream-5xx');
      await this.settle(operation, { reason: 'provider-unavailable', state: 'failed' });

      return;
    }

    const { connection, credential } = opened;
    let outcome: Settlement;
    let use: 'failure' | 'needs-reauth' | 'success';

    try {
      await handler.run({
        attempt,
        connection,
        credential,
        inTenant: (fn) => this.transactions.runInTenantTransaction(operation.orgId, fn),
        lastAttempt,
        operation,
      });
      outcome = { state: 'succeeded' };
      use = 'success';
    } catch (error) {
      const classified = this.classify(error);

      if (classified === undefined) {
        // Not a provider's answer: a bug or the database. Closed so it is not left `running`.
        this.logger.error(`operation ${operation.id} failed: ${(error as Error).message}`);
        await this.settle(operation, { reason: 'provider-unavailable', state: 'failed' });

        throw error;
      }

      use = classified.use;

      if (classified.retry && !lastAttempt) {
        await this.transactions.runInTenantTransaction(operation.orgId, (tx) =>
          this.connections.recordUse(tx, connection, use),
        );

        throw new RetryableFailure(
          classified.reason === 'rate-limited' ? 'throttled' : 'upstream-5xx',
        );
      }

      outcome = { reason: classified.reason, state: 'failed' };
    }

    await this.settle(operation, outcome, connection, use);
  }

  /** The connection the operation writes through, refused from the row where it must be. */
  private async open(
    tx: TenantTransaction,
    operation: ConnectorOperation,
  ): Promise<
    | { readonly kind: 'circuit-open' }
    | { readonly kind: 'refused'; readonly reason: ConnectorOpReason }
    | { readonly connection: Connection; readonly credential: Plaintext; readonly kind: 'ready' }
  > {
    const connection = await this.connectionFor(tx, operation);

    if (connection === undefined) return { kind: 'refused', reason: 'disconnected' };

    const releasing = RELEASE_KINDS.has(operation.kind);

    if (!releasing && connection.removalRequestedAt !== null) {
      return { kind: 'refused', reason: 'removing' };
    }

    if (!releasing && connection.health === 'needs_reauth') {
      return { kind: 'refused', reason: 'needs-reauth' };
    }

    if (isOpen(connection, this.clock.now())) return { kind: 'circuit-open' };

    return {
      connection,
      credential: await this.connections.openCredential(tx, connection),
      kind: 'ready',
    };
  }

  /** The resource's connection, else the binding's, else the organisation's for the kind's provider. */
  private async connectionFor(
    tx: TenantTransaction,
    operation: ConnectorOperation,
  ): Promise<Connection | undefined> {
    const { orgId } = operation;
    // `connection_remove` names its connection in `external_ref` (the table has no column for it).
    let connectionId: string | null =
      operation.kind === 'connection_remove' ? operation.externalRef : null;

    if (operation.resourceId !== null) {
      const [resource] = await tx
        .select({ connectionId: schema.connectorResources.connectionId })
        .from(schema.connectorResources)
        .where(
          and(
            eq(schema.connectorResources.orgId, orgId),
            eq(schema.connectorResources.id, operation.resourceId),
          ),
        );
      connectionId = resource?.connectionId ?? null;
    }

    if (connectionId === null && operation.bindingId !== null) {
      const [binding] = await tx
        .select({ connectionId: schema.connectorBindings.connectionId })
        .from(schema.connectorBindings)
        .where(
          and(
            eq(schema.connectorBindings.orgId, orgId),
            eq(schema.connectorBindings.id, operation.bindingId),
          ),
        );
      connectionId = binding?.connectionId ?? null;
    }

    const provider = KIND_PROVIDER[operation.kind];
    const [row] = await tx
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.orgId, orgId),
          connectionId !== null
            ? eq(schema.connections.id, connectionId)
            : provider !== undefined
              ? eq(schema.connections.provider, provider)
              : sql`false`,
        ),
      );

    return row;
  }

  /** R5 / §10: what a thrown failure is to the row and to the connection; undefined if not a provider's. */
  private classify(error: unknown):
    | {
        readonly reason: ConnectorOpReason;
        readonly retry: boolean;
        readonly use: 'failure' | 'needs-reauth' | 'success';
      }
    | undefined {
    if (error instanceof OperationFailure) {
      return { reason: error.reason, retry: false, use: 'success' };
    }

    if (!(error instanceof ProviderFailure)) return undefined;

    switch (error.category) {
      case 'unauthorized':
        return { reason: 'needs-reauth', retry: false, use: 'needs-reauth' };
      case 'forbidden-scope':
        return { reason: 'missing-scope', retry: false, use: 'needs-reauth' };
      case 'rate-limited':
        return { reason: 'rate-limited', retry: true, use: 'failure' };
      case 'unavailable':
        return { reason: 'provider-unavailable', retry: true, use: 'failure' };
      default:
        // The provider answered: the credential works, and the refusal is the request's.
        return error.retryable
          ? { reason: 'provider-unavailable', retry: true, use: 'failure' }
          : {
              reason: TERMINAL_REASON[error.category] ?? 'provider-refused',
              retry: false,
              use: 'success',
            };
    }
  }

  /** One tenant transaction: the row closes, and the connection learns what the call proved. */
  private async settle(
    operation: ConnectorOperation,
    outcome: Settlement,
    connection?: Connection,
    use?: 'failure' | 'needs-reauth' | 'success',
  ): Promise<void> {
    await this.transactions.runInTenantTransaction(operation.orgId, async (tx) => {
      if (connection !== undefined && use !== undefined) {
        await this.connections.recordUse(tx, connection, use);
      }

      const closed = await this.operations.markDone(tx, operation.orgId, operation.id, {
        ...outcome,
        finishedAt: this.clock.now(),
      });

      if (!closed) {
        this.logger.warn(`operation ${operation.id} was already closed (the timeout sweep)`);
      }
    });
  }
}
