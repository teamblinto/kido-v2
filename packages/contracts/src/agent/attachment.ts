import { z } from 'zod';

/**
 * Chat attachments (spec 048): a file a person adds to a message so the agent sees it as context.
 *
 * The extension table below is the allowlist. The server never trusts the client's MIME type: it
 * derives the type from the extension and then checks the bytes agree (magic numbers for binary
 * kinds, valid UTF-8 without NUL bytes for text kinds), so a renamed executable is refused.
 *
 * - `image`: sent to the model as an image block (raster only — the providers reject SVG).
 * - `pdf`: sent to the model as a native document block (both providers read PDFs themselves).
 * - `document`: DOCX, its text extracted server-side.
 * - `text`: anything UTF-8 (code, Markdown, CSV, JSON, XML, SVG), inlined as text.
 * - `archive`: ZIP, listed and its small text entries extracted, under bomb limits.
 */
export const ATTACHMENT_KINDS = ['image', 'pdf', 'document', 'text', 'archive'] as const;

export const attachmentKindSchema = z.enum(ATTACHMENT_KINDS);

export type AttachmentKind = z.output<typeof attachmentKindSchema>;

/** At most this many files on one message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Any one file. Uploads stream and are cut off past this, never buffered unbounded. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * An image's own cap. Anthropic's 5 MB image limit applies to the base64 form (4/3 of the bytes),
 * so the raw cap is 3.75 MiB; the client downscales larger rasters before uploading.
 */
export const MAX_IMAGE_ATTACHMENT_BYTES = (15 * 1024 * 1024) / 4;

/** Extracted text kept per file; the full file stays in the workspace for the agent to read. */
export const MAX_EXTRACTED_TEXT_CHARS = 200_000;

interface AttachmentType {
  readonly kind: AttachmentKind;
  readonly mimeType: string;
}

const text = (mimeType: string): AttachmentType => ({ kind: 'text', mimeType });

/** Lower-case extension (no dot) → what the file is. Anything absent is refused. */
export const ATTACHMENT_TYPES: Readonly<Record<string, AttachmentType>> = Object.freeze({
  c: text('text/x-c'),
  cpp: text('text/x-c++'),
  cs: text('text/x-csharp'),
  css: text('text/css'),
  csv: text('text/csv'),
  docx: {
    kind: 'document',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  env: text('text/plain'),
  gif: { kind: 'image', mimeType: 'image/gif' },
  go: text('text/x-go'),
  graphql: text('text/plain'),
  h: text('text/x-c'),
  htm: text('text/html'),
  html: text('text/html'),
  java: text('text/x-java'),
  jpeg: { kind: 'image', mimeType: 'image/jpeg' },
  jpg: { kind: 'image', mimeType: 'image/jpeg' },
  js: text('text/javascript'),
  json: text('application/json'),
  jsx: text('text/javascript'),
  kt: text('text/x-kotlin'),
  log: text('text/plain'),
  md: text('text/markdown'),
  mdx: text('text/markdown'),
  mjs: text('text/javascript'),
  pdf: { kind: 'pdf', mimeType: 'application/pdf' },
  php: text('text/x-php'),
  png: { kind: 'image', mimeType: 'image/png' },
  prisma: text('text/plain'),
  py: text('text/x-python'),
  rb: text('text/x-ruby'),
  rs: text('text/x-rust'),
  scss: text('text/x-scss'),
  sh: text('text/x-shellscript'),
  sql: text('application/sql'),
  svelte: text('text/plain'),
  svg: text('image/svg+xml'),
  swift: text('text/x-swift'),
  toml: text('text/plain'),
  ts: text('text/typescript'),
  tsx: text('text/typescript'),
  txt: text('text/plain'),
  vue: text('text/plain'),
  webp: { kind: 'image', mimeType: 'image/webp' },
  xml: text('application/xml'),
  yaml: text('text/yaml'),
  yml: text('text/yaml'),
  zip: { kind: 'archive', mimeType: 'application/zip' },
});

/** The extension of `name`, lower-cased, or `''`. */
export function attachmentExtension(name: string): string {
  const dot = name.lastIndexOf('.');

  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** What `name` would be stored as, or `null` when its extension is not allowed. */
export function attachmentTypeFor(name: string): AttachmentType | null {
  return ATTACHMENT_TYPES[attachmentExtension(name)] ?? null;
}

/** The byte cap for a file of `kind`. */
export function maxBytesFor(kind: AttachmentKind): number {
  return kind === 'image' ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
}

/** A display file name: no path, no control characters, bounded. */
export const attachmentNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !/[\\/\p{Cc}]/u.test(name), { error: 'A file name has no path or controls.' });

/** `POST …/projects/:projectId/attachments?name=…`, the raw file as the request body. */
export const uploadAttachmentQuerySchema = z.strictObject({ name: attachmentNameSchema });

export type UploadAttachmentQuery = z.output<typeof uploadAttachmentQuerySchema>;

/** One stored attachment, as the wire describes it. The bytes are fetched from `…/content`. */
export const attachmentSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
  kind: attachmentKindSchema,
  mimeType: z.string(),
  name: z.string(),
  sizeBytes: z.number().int().min(0),
});

export type Attachment = z.output<typeof attachmentSchema>;

/** The ids a message carries; distinct, bounded. Each must be an attachment of the same project. */
export const attachmentIdsSchema = z
  .array(z.uuid())
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .refine((ids) => new Set(ids).size === ids.length, { error: 'An attachment is sent once.' });
