import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Checkpoint } from '@repo/db';
import { sql } from 'drizzle-orm';

import { CLOCK, type ClockPort } from '../../common/clock/clock.port';
import {
  OBJECT_STORE,
  type ObjectStorePort,
  ObjectStoreUnconfigured,
} from '../../common/object-store/object-store.port';
import type { Environment } from '../../config/environment';
import type { TenantTransaction } from '../../database/database.types';
import { TenantTransactionRunner } from '../../database/tenant-transaction';
import { classifyHttpStatus, EventConsumer, RetryableFailure } from '../outbox/consumer';
import type { Envelope } from '../outbox/envelope';
import { DaytonaError } from '../sandbox/sandbox.errors';
import type { MutationContext } from '../sandbox/sandbox.port';
import { CheckpointRepository } from './checkpoint.repository';
import { mirrorKey, RepoBundler } from './repo-bundler';

export { BUNDLE_PATH, mirrorKey } from './repo-bundler';

export const REPO_MIRROR_QUEUE = 'repo.mirror';

type MirrorEvent = Envelope<'checkpoint.created'>;

/** What `handle` hands `effect`: the row to mark and the project head the body will carry. */
export interface MirrorJob {
  readonly head: string;
  readonly row: Checkpoint;
}

/**
 * `checkpoint.created` → the repository bundled, downloaded and PUT whole (spec 016 US3, FR-017,
 * research R6). `handle` reads the row and steps aside when it is already mirrored or a later
 * checkpoint of the project is (FR-019): the bundle is `--all`, so the later mirror carries this
 * commit. `effect` drives the sandbox in a tenant scope of its own and the store with no
 * transaction held, then marks the row.
 *
 * Retry (FR-018): the sandbox unreachable or still waking, the store unreachable. Terminal: a git
 * failure, the bundle over `bundleCapBytes`, a store 4xx. Under `local` with no store, one
 * warning and the row stays unmirrored (FR-024); outside `local` the schema refuses that at boot.
 *
 * Invariant: the object's `head` label is the project's head checkpoint at `handle` time, never
 * the event's row. The `--all` body carries at least that commit, so two mirrors of one project
 * in flight together label the same newer sha whichever PUT lands last; a checkpoint committed
 * after `handle` is labelled by its own mirror, which nothing short-circuits. The PUTs of one
 * project land in bundle order: each holds the project's writer lock from bundle to PUT.
 */
@Injectable()
export class RepoMirrorConsumer extends EventConsumer<'checkpoint.created', MirrorJob | undefined> {
  readonly attempts = 8;
  override readonly concurrency = 4;
  readonly name = 'repo-mirror';
  override readonly profile = 'events' as const;
  readonly queue = REPO_MIRROR_QUEUE;
  readonly types = ['checkpoint.created'] as const;

  private readonly logger = new Logger(RepoMirrorConsumer.name);
  private readonly local: boolean;

  constructor(
    @Inject(CheckpointRepository) private readonly repository: CheckpointRepository,
    @Inject(RepoBundler) private readonly bundler: RepoBundler,
    @Inject(OBJECT_STORE) private readonly store: ObjectStorePort,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(CLOCK) private readonly clock: ClockPort,
    config: ConfigService<Environment, true>,
  ) {
    super();
    this.local = config.get('DEPLOY_ENV', { infer: true }) === 'local';
  }

  override jobId(event: MirrorEvent): string {
    return `${event.payload.checkpointId}.mirror`;
  }

  async handle(event: MirrorEvent, tx: TenantTransaction): Promise<MirrorJob | undefined> {
    const { checkpointId, orgId } = event.payload;
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    const row = await this.repository.byId(tx, orgId, checkpointId);

    if (row?.mirroredAt !== null) return undefined;

    if (await this.repository.laterMirroredExists(tx, row)) {
      await this.repository.markMirrored(tx, orgId, row.id, this.clock.now());
      return undefined;
    }

    const head = await this.repository.head(tx, orgId, row.projectId);
    return { head: head?.gitSha ?? row.gitSha, row };
  }

  override async effect(_event: MirrorEvent, job: MirrorJob | undefined): Promise<void> {
    if (job !== undefined) await this.mirror(job);
  }

  /** Bundle, PUT, mark: the event's path, and `RepoMirrorSweep`'s for a head that fell behind. */
  async mirror({ head, row }: MirrorJob): Promise<void> {
    const ref = { orgId: row.orgId, projectId: row.projectId };
    const ctx: MutationContext = { leaseEpoch: 0, operationId: `mirror/${row.id}` };

    try {
      const readiness = await this.transactions.runInTenantTransaction(row.orgId, (tx) =>
        this.bundler.wake(tx, ref, ctx),
      );
      if (!readiness.ready) {
        throw new RetryableFailure('timeout', new Error(`sandbox ${readiness.because}`));
      }

      // The port resolves the sandbox through `TenantContext.tx` (014), so the git steps run in
      // a tenant scope as the executor's tool calls do. The project's writer lock is held from
      // the bundle to the PUT, so a slower job never lands an older bundle over a newer one.
      // ponytail: one pooled connection stays open across ensureReady + bundle + download + PUT
      // (≤ 120 s for the exec), as the executor's dispatch does; 014 caches the resolution if that bites.
      const scope = { orgId: row.orgId, userId: null };
      await this.transactions.runInTenantScope(scope, async (tx) => {
        await this.repository.lockProject(tx, row.projectId);
        const body = await this.bundler.bundle(tx, ref, ctx);
        await this.store.put(mirrorKey(row.orgId, row.projectId), body, { head });
      });
    } catch (error) {
      if (error instanceof ObjectStoreUnconfigured && this.local) {
        this.logger.warn(`checkpoint ${row.id} not mirrored: ${error.message}`);
        return;
      }
      throw retryable(error) ?? error;
    }

    await this.transactions.runInTenantTransaction(row.orgId, (tx) =>
      this.repository.markMirrored(tx, row.orgId, row.id, this.clock.now()),
    );
  }
}

/** The failures worth another attempt; `undefined` for the ones that would only repeat. */
function retryable(error: unknown): RetryableFailure | undefined {
  if (error instanceof RetryableFailure) return error;
  if (error instanceof DaytonaError) {
    return error.retryable
      ? new RetryableFailure(error.kind === 'unreachable' ? 'timeout' : 'upstream-5xx', error)
      : undefined;
  }
  // The S3 SDK marks its errors with `$metadata`: no status is the wire, 429 and 5xx the store.
  if (typeof error === 'object' && error !== null && '$metadata' in error) {
    const status = (error as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode;
    if (status === undefined) return new RetryableFailure('timeout', error);
    if (classifyHttpStatus(status) === 'retryable') {
      return new RetryableFailure(status === 429 ? 'throttled' : 'upstream-5xx', error);
    }
  }
  return undefined;
}
