import {
  bigint,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { runMessages } from './agent';
import { timestamps } from './columns';
import { users } from './identity';
import { orgs, projects } from './tenancy';

/**
 * Chat attachments (spec 048). Two tenant-owned tables:
 *
 * - `attachments`: one uploaded file of one project. The bytes live in the object store under
 *   `object_key`; the row holds what was verified about them and any text extracted from them.
 * - `run_message_attachments`: which message carried which file, in order. A file is a project
 *   blob rather than a message's child so a retry or an edit can send the same file again without
 *   uploading it twice. A file no message references is pending, and the sweep deletes it a day on.
 */
export const attachmentKind = pgEnum('attachment_kind', [
  'image',
  'pdf',
  'document',
  'text',
  'archive',
]);

export const attachments = pgTable(
  'attachments',
  {
    // Null when nothing was extracted (images, PDFs) — the model reads those natively.
    extractedText: text('extracted_text'),
    id: uuid('id').primaryKey().defaultRandom(),
    kind: attachmentKind('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    name: text('name').notNull(),
    objectKey: text('object_key').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (table) => [
    unique('attachments_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      columns: [table.orgId, table.projectId],
      foreignColumns: [projects.orgId, projects.id],
      name: 'attachments_org_id_project_id_fk',
    }).onDelete('cascade'),
    index('attachments_org_id_project_id_created_at_idx').on(
      table.orgId,
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const runMessageAttachments = pgTable(
  'run_message_attachments',
  {
    attachmentId: uuid('attachment_id').notNull(),
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('run_message_attachments_org_id_id_key').on(table.orgId, table.id),
    unique('run_message_attachments_message_attachment_key').on(
      table.orgId,
      table.messageId,
      table.attachmentId,
    ),
    foreignKey({
      columns: [table.orgId, table.messageId],
      foreignColumns: [runMessages.orgId, runMessages.id],
      name: 'run_message_attachments_org_id_message_id_fk',
    }).onDelete('cascade'),
    // No action (checked at statement end), not restrict: a file a message still references is
    // never swept out from under it, yet the organisation cascade, which reaches both tables,
    // cannot fail on the order Postgres walks them (the reason secrets.ts gives).
    foreignKey({
      columns: [table.orgId, table.attachmentId],
      foreignColumns: [attachments.orgId, attachments.id],
      name: 'run_message_attachments_org_id_attachment_id_fk',
    }).onDelete('no action'),
    index('run_message_attachments_org_id_attachment_id_idx').on(table.orgId, table.attachmentId),
  ],
);

export type AttachmentRow = typeof attachments.$inferSelect;
export type NewAttachmentRow = typeof attachments.$inferInsert;
export type RunMessageAttachmentRow = typeof runMessageAttachments.$inferSelect;
