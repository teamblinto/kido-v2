import { Inject, Injectable } from '@nestjs/common';
import { type Attachment, attachmentTypeFor, maxBytesFor } from '@repo/contracts';
import { type AttachmentRow, attachments, runMessageAttachments } from '@repo/db';
import { and, asc, count, eq, inArray, lt, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';

import { CLOCK, type ClockPort } from '../../../common/clock/clock.port';
import { ConflictError, DomainError } from '../../../common/errors/domain-error';
import type { ObjectStorePort } from '../../../common/object-store/object-store.port';
import { BYPASS_DATABASE } from '../../../database/database.constants';
import type { ForgeDatabase, TenantTransaction } from '../../../database/database.types';
import { TenantContext } from '../../../database/tenant-context';
import { TenantTransactionRunner } from '../../../database/tenant-transaction';
import { ProjectService } from '../../tenancy/services/project.service';
import {
  AttachmentNotFoundError,
  AttachmentRejectedError,
  AttachmentTooLargeError,
} from './attachment.errors';
import { inspectAttachment } from './attachment-inspect';
import type { AttachmentReaderPort, StoredAttachment } from './attachment-reader.port';

/** The attachments logical bucket (`objectStoreFor(config, 'attachments')`). */
export const ATTACHMENT_STORE = Symbol('forge.object-store.attachments');

/** Unlinked files one project may hold at once: a curb on uploading without ever sending. */
export const MAX_PENDING_ATTACHMENTS = 100;

/** A file no message references is deleted this long after its upload (spec 048). */
export const PENDING_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** At most this many files per sweep; the next tick takes the rest. */
const SWEEP_BATCH = 500;

const isUuid = (id: string): boolean => z.uuid().safeParse(id).success;

/** Pending: no message carries it. */
const notLinked = sql`not exists (select 1 from ${runMessageAttachments} where ${runMessageAttachments.orgId} = ${attachments.orgId} and ${runMessageAttachments.attachmentId} = ${attachments.id})`;

const STORED_COLUMNS = {
  extractedText: attachments.extractedText,
  id: attachments.id,
  kind: attachments.kind,
  mimeType: attachments.mimeType,
  name: attachments.name,
  objectKey: attachments.objectKey,
  projectId: attachments.projectId,
  sizeBytes: attachments.sizeBytes,
};

const WIRE_COLUMNS = {
  createdAt: attachments.createdAt,
  id: attachments.id,
  kind: attachments.kind,
  mimeType: attachments.mimeType,
  name: attachments.name,
  sizeBytes: attachments.sizeBytes,
};

/**
 * Chat attachments (spec 048): the upload, the link from a message, the download, and the sweep of
 * files never sent. Request-side methods run on the request's tenant transaction; `forMessages`
 * (the agent loop's port) runs on the caller's transaction when it is in one for the same org and
 * opens its own otherwise.
 */
@Injectable()
export class AttachmentService implements AttachmentReaderPort {
  constructor(
    @Inject(TenantContext) private readonly tenant: TenantContext,
    @Inject(TenantTransactionRunner) private readonly transactions: TenantTransactionRunner,
    @Inject(BYPASS_DATABASE) private readonly bypass: ForgeDatabase,
    @Inject(ATTACHMENT_STORE) private readonly store: ObjectStorePort,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(CLOCK) private readonly clock: ClockPort,
  ) {}

  /**
   * Streams the body under the kind's cap, hashing as it goes, then verifies the bytes and stores
   * them. The type comes from the extension, so an unknown one is refused before a byte is read;
   * past the cap the stream is paused (not destroyed, so the 413 still reaches the client) and
   * nothing is stored. The row is inserted before the object is put, so a failed put rolls the
   * row back with the request.
   */
  async upload(
    orgId: string,
    projectId: string,
    userId: string,
    name: string,
    body: Readable,
    declaredLength?: number,
  ): Promise<Attachment> {
    const type = attachmentTypeFor(name);

    if (type === null) throw new AttachmentRejectedError('Files of this type cannot be attached.');

    const maxBytes = maxBytesFor(type.kind);

    if (declaredLength !== undefined && declaredLength > maxBytes) {
      throw new AttachmentTooLargeError(maxBytes);
    }

    // The body is read and verified before any transaction opens: the route owns its transaction
    // (`@OwnsTenantTransaction`), so a slow 25 MiB upload never holds a pooled connection.
    const { bytes, sha256 } = await readCapped(body, maxBytes);
    const inspected = inspectAttachment(name, bytes);

    return this.transactions.runInTenantScope({ orgId, userId }, async () => {
      const tx = this.tenant.tx;

      await this.projects.read(orgId, projectId);
      // Serialises this project's uploads, so two at once cannot both pass the count below.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('attachments-pending:' || ${projectId}::text))`,
      );

      const [pending] = await tx
        .select({ total: count() })
        .from(attachments)
        .where(and(eq(attachments.orgId, orgId), eq(attachments.projectId, projectId), notLinked));

      if ((pending?.total ?? 0) >= MAX_PENDING_ATTACHMENTS) {
        throw new ConflictError(
          `This project already has ${String(MAX_PENDING_ATTACHMENTS)} files waiting to be sent. Send or remove some first.`,
          { reason: 'too-many-pending' },
        );
      }

      const id = randomUUID();
      const objectKey = `attachments/${orgId}/${projectId}/${id}`;
      const [row] = await tx
        .insert(attachments)
        .values({
          ...inspected,
          id,
          name,
          objectKey,
          orgId,
          projectId,
          sha256,
          sizeBytes: bytes.length,
          uploadedBy: userId,
        })
        .returning(WIRE_COLUMNS);

      // Inside the transaction: a failed put rolls the row back.
      await this.store.put(objectKey, bytes, { kind: inspected.kind, sha256 });

      return toWire(row!);
    });
  }

  /**
   * Links `ids` to a message in sent order, on the caller's transaction. Every id must be an
   * attachment of this org's project — RLS hides another org's, the filter another project's —
   * else `attachment-not-found` and the caller's transaction rolls back. The share lock makes a
   * concurrent sweep or delete wait for this transaction, or (when it locked first) this read miss
   * the rows it removed.
   */
  async link(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    messageId: string,
    ids: readonly string[],
  ): Promise<void> {
    if (ids.length === 0) return;

    const found = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.orgId, orgId),
          eq(attachments.projectId, projectId),
          inArray(attachments.id, [...ids]),
        ),
      )
      .for('share');

    if (found.length !== new Set(ids).size) throw new AttachmentNotFoundError();

    try {
      await tx
        .insert(runMessageAttachments)
        .values(
          ids.map((attachmentId, position) => ({ attachmentId, messageId, orgId, position })),
        );
    } catch (error) {
      // Backstop: a file deleted between the read and the insert is still "not found", not a 500.
      if (isForeignKeyViolation(error)) throw new AttachmentNotFoundError();
      throw error;
    }
  }

  /** The port: message id → its attachments in sent order, extracted text included. */
  async forMessages(
    orgId: string,
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly StoredAttachment[]>> {
    if (messageIds.length === 0) return new Map();

    const query = async (tx: TenantTransaction): Promise<Map<string, StoredAttachment[]>> =>
      group(
        await tx
          .select({ ...STORED_COLUMNS, messageId: runMessageAttachments.messageId })
          .from(runMessageAttachments)
          .innerJoin(attachments, linkJoin)
          .where(linkedTo(orgId, messageIds))
          .orderBy(asc(runMessageAttachments.position)),
      );
    const context = this.tenant.get();

    return context?.orgId === orgId
      ? query(context.tx)
      : this.transactions.runInTenantTransaction(orgId, query);
  }

  /** For `GET …/runs/messages`: one query for the page, wire shape, no extracted text. */
  async listForMessages(
    orgId: string,
    messageIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly Attachment[]>> {
    if (messageIds.length === 0) return new Map();

    const rows = await this.tenant.tx
      .select({ ...WIRE_COLUMNS, messageId: runMessageAttachments.messageId })
      .from(runMessageAttachments)
      .innerJoin(attachments, linkJoin)
      .where(linkedTo(orgId, messageIds))
      .orderBy(asc(runMessageAttachments.position));

    return group(rows.map((row) => ({ ...toWire(row), messageId: row.messageId })));
  }

  async bytes(attachment: StoredAttachment): Promise<Buffer> {
    const object = await this.store.get(attachment.objectKey);

    if (object === null) throw new Error(`attachment ${attachment.id} has no object`);

    return object.body;
  }

  /** The download: the row (for its headers) and the bytes. */
  async content(
    orgId: string,
    projectId: string,
    id: string,
  ): Promise<{ attachment: AttachmentRow; body: Buffer }> {
    const attachment = await this.row(this.tenant.tx, orgId, projectId, id);
    const object = await this.store.get(attachment.objectKey);

    if (object === null) throw new AttachmentNotFoundError();

    return { attachment, body: object.body };
  }

  /** Removes a file no message has carried; once sent it is part of the conversation (409). */
  async deletePending(orgId: string, projectId: string, id: string): Promise<void> {
    const tx = this.tenant.tx;
    const attachment = await this.row(tx, orgId, projectId, id, true);
    const [linked] = await tx
      .select({ id: runMessageAttachments.id })
      .from(runMessageAttachments)
      .where(
        and(eq(runMessageAttachments.orgId, orgId), eq(runMessageAttachments.attachmentId, id)),
      )
      .limit(1);

    if (linked !== undefined) {
      throw new ConflictError('This file was sent with a message and stays with it.', {
        reason: 'attachment-sent',
      });
    }

    await tx.delete(attachments).where(and(eq(attachments.orgId, orgId), eq(attachments.id, id)));
    // After commit, so a rolled-back delete never leaves a row without its bytes.
    this.tenant.onCommit(() => this.store.delete(attachment.objectKey));
  }

  /**
   * Deletes files no message references a day after upload. One `forge_bypass` read finds them
   * across tenants (it reads only, as everywhere); each org's are then locked and their rows
   * deleted in that org's own transaction, and their objects deleted once it commits. The lock
   * waits out a link in flight and keeps new ones off; the delete re-checks `notLinked` in its own
   * statement (a fresh snapshot under READ COMMITTED), so a link that committed while the lock
   * waited keeps its file. Row before object, after commit: a rolled-back delete never leaves a
   * row without its bytes (a failed object delete only leaks bytes). Returns how many rows went.
   */
  async sweep(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - PENDING_ATTACHMENT_TTL_MS);
    const candidates = await this.bypass
      .select({ id: attachments.id, orgId: attachments.orgId })
      .from(attachments)
      .where(and(lt(attachments.createdAt, cutoff), notLinked))
      .limit(SWEEP_BATCH);
    const byOrg = new Map<string, string[]>();

    for (const { id, orgId } of candidates) byOrg.set(orgId, [...(byOrg.get(orgId) ?? []), id]);

    let swept = 0;

    for (const [orgId, ids] of byOrg) {
      const keys = await this.transactions.runInTenantTransaction(orgId, async (tx) => {
        const locked = await tx
          .select({ id: attachments.id })
          .from(attachments)
          .where(
            and(
              eq(attachments.orgId, orgId),
              inArray(attachments.id, ids),
              lt(attachments.createdAt, cutoff),
              notLinked,
            ),
          )
          .for('update');

        if (locked.length === 0) return [];

        const deleted = await tx
          .delete(attachments)
          .where(
            and(
              eq(attachments.orgId, orgId),
              inArray(
                attachments.id,
                locked.map((row) => row.id),
              ),
              notLinked,
            ),
          )
          .returning({ objectKey: attachments.objectKey });

        return deleted.map((row) => row.objectKey);
      });

      for (const key of keys) await this.store.delete(key);
      swept += keys.length;
    }

    return swept;
  }

  private async row(
    tx: TenantTransaction,
    orgId: string,
    projectId: string,
    id: string,
    forUpdate = false,
  ): Promise<AttachmentRow> {
    if (!isUuid(id)) throw new AttachmentNotFoundError();

    const query = tx
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.orgId, orgId),
          eq(attachments.projectId, projectId),
          eq(attachments.id, id),
        ),
      );
    const [row] = forUpdate ? await query.for('update') : await query;

    if (row === undefined) throw new AttachmentNotFoundError();

    return row;
  }
}

const linkJoin = and(
  eq(attachments.orgId, runMessageAttachments.orgId),
  eq(attachments.id, runMessageAttachments.attachmentId),
);

function linkedTo(orgId: string, messageIds: readonly string[]): ReturnType<typeof and> {
  return and(
    eq(runMessageAttachments.orgId, orgId),
    inArray(runMessageAttachments.messageId, [...messageIds]),
  );
}

function group<T extends { messageId: string }>(
  rows: readonly T[],
): Map<string, Omit<T, 'messageId'>[]> {
  const byMessage = new Map<string, Omit<T, 'messageId'>[]>();

  for (const { messageId, ...attachment } of rows) {
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), attachment]);
  }

  return byMessage;
}

/** Postgres's `foreign_key_violation`; drizzle wraps the driver error, so walk a few `cause`s. */
function isForeignKeyViolation(error: unknown): boolean {
  for (
    let cause = error, depth = 0;
    typeof cause === 'object' && cause !== null && depth < 5;
    depth++
  ) {
    if ((cause as { code?: unknown }).code === '23503') return true;
    cause = (cause as { cause?: unknown }).cause;
  }

  return false;
}

function toWire(row: {
  createdAt: Date;
  id: string;
  kind: Attachment['kind'];
  mimeType: string;
  name: string;
  sizeBytes: number;
}): Attachment {
  return {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    name: row.name,
    sizeBytes: row.sizeBytes,
  };
}

/**
 * The body, at most `maxBytes`, and its SHA-256. Past the cap it stops listening and pauses the
 * stream rather than destroying it: destroying a request kills the socket before the problem
 * response can be written. The controller marks the response `Connection: close`, so Node closes
 * the connection after the 413 instead of draining the rest.
 */
export function readCapped(
  body: Readable,
  maxBytes: number,
): Promise<{ bytes: Buffer; sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let size = 0;

    const stop = (): void => {
      body.off('data', onData).off('end', onEnd).off('error', onError).off('close', onClose);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;

      if (size > maxBytes) {
        stop();
        body.pause();
        reject(new AttachmentTooLargeError(maxBytes));

        return;
      }

      hash.update(chunk);
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      stop();
      resolve({ bytes: Buffer.concat(chunks, size), sha256: hash.digest('hex') });
    };
    const onError = (error: Error): void => {
      stop();
      reject(error);
    };
    const onClose = (): void => {
      stop();
      reject(new DomainError('bad-request', 'The upload was interrupted.'));
    };

    body.on('data', onData).once('end', onEnd).once('error', onError).once('close', onClose);
  });
}
