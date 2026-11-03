import { Inject, Injectable } from '@nestjs/common';

import {
  OBJECT_STORE,
  type ObjectStorePort,
  ObjectStoreUnconfigured,
} from '../../common/object-store/object-store.port';
import type { TenantTransaction } from '../../database/database.types';
import { RetryableFailure } from '../outbox/consumer';
import {
  type MutationContext,
  SANDBOX_PORT,
  type SandboxPort,
  type SandboxRef,
} from '../sandbox/sandbox.port';
import { SANDBOX_LIFECYCLE, type SandboxLifecycle } from '../sandbox/sandbox-lifecycle';
import { CheckpointRepository } from './checkpoint.repository';
import { gitBundle } from './git-commands';

/** Where the bundle lands inside the sandbox: under `.git`, so git never sees it (research R6). */
export const BUNDLE_PATH = '.git/forge-mirror.bundle';

/** The one object per project in the `forge-repos` bucket (data-model § Object store). */
export const mirrorKey = (orgId: string, projectId: string): string => `${orgId}/${projectId}.git`;

export interface RepoBundle {
  readonly body: Buffer;
  readonly head: string;
}

/**
 * The repository as a `--all` bundle (018 research R5): from the mirror when its `head` label is
 * the project's head checkpoint, else bundled in the sandbox — the mirror consumer's own steps.
 * Both must run inside `runInTenantScope` under the project's writer lock: the port resolves the
 * sandbox through `TenantContext.tx`.
 */
@Injectable()
export class RepoBundler {
  constructor(
    @Inject(CheckpointRepository) private readonly repository: CheckpointRepository,
    @Inject(SANDBOX_PORT) private readonly port: SandboxPort,
    @Inject(SANDBOX_LIFECYCLE) private readonly lifecycle: SandboxLifecycle,
    @Inject(OBJECT_STORE) private readonly store: ObjectStorePort,
  ) {}

  /** The bundle at the project's head; an unconfigured store is "not current". */
  async current(tx: TenantTransaction, ref: SandboxRef, ctx: MutationContext): Promise<RepoBundle> {
    const head = await this.repository.head(tx, ref.orgId, ref.projectId);
    if (head === null) throw new Error('The project has no checkpoint to bundle.');

    const mirror = await this.store.get(mirrorKey(ref.orgId, ref.projectId)).catch((error) => {
      if (error instanceof ObjectStoreUnconfigured) return null;
      throw error;
    });
    if (mirror?.meta.head === head.gitSha) return { body: mirror.body, head: head.gitSha };

    return { body: await this.bundle(tx, ref, ctx), head: head.gitSha };
  }

  /** `ensureReady` (→ retry while waking) + `git bundle create --all` + download. */
  async bundle(tx: TenantTransaction, ref: SandboxRef, ctx: MutationContext): Promise<Buffer> {
    const readiness = await this.lifecycle.ensureReady(tx, ref, ctx);
    if (!readiness.ready) {
      throw new RetryableFailure('timeout', new Error(`sandbox ${readiness.because}`));
    }

    const bundle = await this.port.exec(ref, gitBundle(), ctx);
    if (bundle.timedOut || bundle.exitCode !== 0) {
      throw new Error(`\`${gitBundle()}\` failed: ${bundle.output.trim()}`);
    }

    return this.port.download(ref, BUNDLE_PATH, ctx);
  }
}
