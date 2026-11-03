import { Inject, Injectable } from '@nestjs/common';
import type { FileContentResponse, FileListResponse, WakeResponse } from '@repo/contracts';
import { checkpoints } from '@repo/db';
import { and, desc, eq } from 'drizzle-orm';
import { posix } from 'node:path';

import type { TenantTransaction } from '../../database/database.types';
import { SandboxGuardError } from './sandbox.errors';
import {
  SANDBOX_PORT,
  type MutationContext,
  type SandboxPort,
  type SandboxRef,
} from './sandbox.port';
import { SandboxLifecycleService } from './sandbox-lifecycle';

/** What `git` sniffs: a NUL in the first 8 KiB means bytes, not text (research R2). */
const SNIFF_BYTES = 8192;

/** A member's own read: no lease to fence, the operation named after the route (contract § 3). */
const WAKE_CTX: MutationContext = { leaseEpoch: 0, operationId: 'files/wake' };

/**
 * The base a project with no checkpoint at all is read against (spec 024 § Edge cases).
 *
 * The contract requires `baseCheckpointId` to be a uuid on every renderable read, and a project
 * whose baseline has not been recorded yet has no id to give. The nil uuid is one, and it is the
 * one value that can never be a head: a save carrying it is refused `base-moved`, which is the
 * same answer the save's own no-baseline refusal gives. So the read stays a read — it does not
 * become a 500 because the history has not started — and the save stays impossible until a
 * baseline exists, which is what "a hand edit never roots a history" means.
 */
const NO_BASE = '00000000-0000-0000-0000-000000000000';

/**
 * The read-only file surface of spec 022 (contracts/files.md § 1–3) over the port and the
 * lifecycle. It owns no state and no table: the jail, the caps and the readiness matrix are the
 * collaborators'. What is here is the mapping — the union an unrenderable file is answered with
 * instead of a 413 the web would have to translate, and the readiness flattened for the wire.
 */
@Injectable()
export class FilesService {
  constructor(
    @Inject(SANDBOX_PORT) private readonly port: SandboxPort,
    @Inject(SandboxLifecycleService) private readonly lifecycle: SandboxLifecycleService,
  ) {}

  /** § 1: the port's direct children, name-sorted as it returns them, with the path echoed back. */
  async list(ref: SandboxRef, path: string): Promise<FileListResponse> {
    const entries = await this.port.list(ref, path);
    return { entries: entries.map((entry) => ({ ...entry })), path };
  }

  /**
   * § 2: UTF-8 text under the cap, or why it cannot be shown. Only `file-too-large` is caught —
   * a missing path, a directory and a waking sandbox stay refusals for the filter to answer.
   *
   * Spec 024: a renderable answer also names the project's head checkpoint, the base the save is
   * compared against (research R3). The head is only read once the bytes are known to be
   * renderable — an unrenderable file cannot be saved and has no base to carry.
   */
  async read(tx: TenantTransaction, ref: SandboxRef, path: string): Promise<FileContentResponse> {
    let content: string;
    try {
      content = await this.port.read(ref, path);
    } catch (error) {
      if (error instanceof SandboxGuardError && error.kind === 'file-too-large') {
        return { bytes: await this.size(ref, path), path, reason: 'too-large', renderable: false };
      }
      throw error;
    }

    if (content.slice(0, SNIFF_BYTES).includes('\u0000')) {
      return { bytes: await this.size(ref, path), path, reason: 'binary', renderable: false };
    }
    return {
      baseCheckpointId: await this.head(tx, ref),
      bytes: Buffer.byteLength(content),
      content,
      path,
      renderable: true,
    };
  }

  /** § 3: `ensureReady` at epoch 0, flattened. Idempotent because `ensureReady` is. */
  async wake(tx: TenantTransaction, ref: SandboxRef): Promise<WakeResponse> {
    const readiness = await this.lifecycle.ensureReady(tx, ref, WAKE_CTX);
    return readiness.ready ? { because: null, ready: true } : { ...readiness };
  }

  /**
   * The project's head checkpoint id, on the request's own tenant transaction.
   *
   * Read from the `checkpoints` table through the `@repo/db` schema rather than through
   * `CheckpointService`: `sandbox → checkpoints` is not an edge in the module graph and research
   * R1 decided not to add one for a single id. This is the idiom `CheckpointRepository` already
   * uses in the other direction for `agent_runs` — the constitution forbids another module's
   * repository file, not the shared table. The ordering is the head's definition, `(created_at,
   * id)` descending, exactly as `CheckpointRepository.head` orders it.
   */
  private async head(tx: TenantTransaction, ref: SandboxRef): Promise<string> {
    const [row] = await tx
      .select({ id: checkpoints.id })
      .from(checkpoints)
      .where(and(eq(checkpoints.orgId, ref.orgId), eq(checkpoints.projectId, ref.projectId)))
      .orderBy(desc(checkpoints.createdAt), desc(checkpoints.id))
      .limit(1);

    return row?.id ?? NO_BASE;
  }

  /**
   * The size of a file whose bytes were never read, from a `list` of its parent. Unfindable is
   * `0`: the answer is already "you cannot see this", and a second refusal adds nothing.
   */
  private async size(ref: SandboxRef, path: string): Promise<number> {
    const parent = posix.dirname(path);
    const entries = await this.port.list(ref, parent === '.' ? '' : parent);
    return entries.find((entry) => entry.name === posix.basename(path))?.size ?? 0;
  }
}
