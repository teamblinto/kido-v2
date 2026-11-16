import {
  ATTACHMENT_TYPES,
  type AttachmentKind,
  attachmentExtension,
  attachmentTypeFor,
  MAX_EXTRACTED_TEXT_CHARS,
} from '@repo/contracts';

import { AttachmentRejectedError } from './attachment.errors';
import {
  DEFAULT_ZIP_LIMITS,
  openZip,
  type ZipArchive,
  ZipError,
  type ZipLimits,
} from './zip-reader';

export interface InspectedAttachment {
  readonly extractedText: string | null;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
}

/**
 * A long document's XML outgrows a ZIP entry's cap. 8 MiB of it is far past the text cap's worth
 * and bounds what the regex passes below cost; its text is still capped after extraction.
 */
const DOCX_LIMITS: ZipLimits = {
  ...DEFAULT_ZIP_LIMITS,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalReadBytes: 8 * 1024 * 1024,
};

/** A text entry inside a ZIP is inlined only up to this size; the agent reads the rest itself. */
const ZIP_TEXT_ENTRY_BYTES = 256 * 1024;

const startsWith = (bytes: Buffer, signature: string, at = 0): boolean =>
  bytes.subarray(at, at + signature.length).equals(Buffer.from(signature, 'latin1'));

/** The leading bytes each binary extension must carry. Client MIME types are never consulted. */
const MAGIC: Readonly<Record<string, (bytes: Buffer) => boolean>> = {
  docx: (bytes) => startsWith(bytes, 'PK\x03\x04'),
  gif: (bytes) => startsWith(bytes, 'GIF87a') || startsWith(bytes, 'GIF89a'),
  jpeg: (bytes) => startsWith(bytes, '\xff\xd8\xff'),
  jpg: (bytes) => startsWith(bytes, '\xff\xd8\xff'),
  pdf: (bytes) => startsWith(bytes, '%PDF-'),
  png: (bytes) => startsWith(bytes, '\x89PNG\r\n\x1a\n'),
  webp: (bytes) => startsWith(bytes, 'RIFF') && startsWith(bytes, 'WEBP', 8),
  // An empty archive is only its end record.
  zip: (bytes) => startsWith(bytes, 'PK\x03\x04') || startsWith(bytes, 'PK\x05\x06'),
};

/**
 * What an upload is, from its name and its bytes (spec 048): the extension picks the type from the
 * allowlist, then the bytes must agree — the magic number for binary kinds, valid UTF-8 without
 * NUL for text — so a renamed executable is refused. Text, DOCX and ZIP carry extracted text,
 * capped at `MAX_EXTRACTED_TEXT_CHARS`; images and PDFs go to the model natively and carry none.
 */
export function inspectAttachment(name: string, bytes: Buffer): InspectedAttachment {
  const type = attachmentTypeFor(name);

  if (type === null) throw new AttachmentRejectedError('Files of this type cannot be attached.');

  const { kind, mimeType } = type;
  const magic = MAGIC[attachmentExtension(name)];

  if (magic !== undefined && !magic(bytes)) {
    throw new AttachmentRejectedError('The file’s contents do not match its type.');
  }

  switch (kind) {
    case 'image':
    case 'pdf':
      return { extractedText: null, kind, mimeType };
    case 'text': {
      const text = decodeText(bytes);

      if (text === null) throw new AttachmentRejectedError('The file is not valid UTF-8 text.');

      return { extractedText: cap(text), kind, mimeType };
    }
    case 'document':
      return { extractedText: docxText(open(bytes, DOCX_LIMITS)), kind, mimeType };
    case 'archive':
      return { extractedText: zipText(open(bytes)), kind, mimeType };
  }
}

/** UTF-8 without NUL, BOM stripped; `null` when it is not. */
function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;

  try {
    // `ignoreBOM: false` (the default) is what strips a leading BOM.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function open(bytes: Buffer, limits?: ZipLimits): ZipArchive {
  try {
    return openZip(bytes, limits);
  } catch (error) {
    throw rejected(error);
  }
}

function rejected(error: unknown): unknown {
  return error instanceof ZipError ? new AttachmentRejectedError(error.message) : error;
}

function docxText(archive: ZipArchive): string {
  const entry = archive.entries.find((candidate) => candidate.name === 'word/document.xml');

  if (entry === undefined) throw new AttachmentRejectedError('The file is not a Word document.');

  let xml: string;

  try {
    xml = archive.read(entry).toString('utf8');
  } catch (error) {
    throw rejected(error);
  }

  const text = xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>|<\/w:p>/g, '\n')
    .replace(/<[^>]*>/g, '');

  return cap(
    withoutControls(decodeEntities(text))
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);

      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }

    return ENTITIES[entity] ?? whole;
  });
}

/** The listing, then the small text entries' contents, all under one cap. */
function zipText(archive: ZipArchive): string {
  const files = archive.entries.filter((entry) => !entry.directory);
  const listing = files.map((entry) => `${safeName(entry.name)} (${String(entry.size)} bytes)`);
  let text = `Archive with ${String(files.length)} file(s):\n${listing.join('\n')}\n`;

  for (const entry of files) {
    if (text.length >= MAX_EXTRACTED_TEXT_CHARS) break;
    if (entry.size > ZIP_TEXT_ENTRY_BYTES) continue;
    if (ATTACHMENT_TYPES[attachmentExtension(entry.name)]?.kind !== 'text') continue;

    let contents: string | null;

    try {
      contents = decodeText(archive.read(entry));
    } catch (error) {
      // Past the archive's read budget: the listing stands, the rest is the agent's to open.
      if (error instanceof ZipError) break;
      throw error;
    }

    if (contents !== null) text += `\n--- ${safeName(entry.name)} ---\n${contents}\n`;
  }

  return cap(withoutControls(text));
}

/** C0 controls but tab, LF and CR: Postgres `text` refuses NUL, and none of them is prose. */
function withoutControls(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching controls is the point
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** A display path: forward slashes, no controls, bounded. Never used to touch a filesystem. */
function safeName(name: string): string {
  return name
    .replace(/\\/g, '/')
    .replace(/\p{Cc}/gu, '')
    .slice(0, 255);
}

function cap(text: string): string {
  return text.length > MAX_EXTRACTED_TEXT_CHARS ? text.slice(0, MAX_EXTRACTED_TEXT_CHARS) : text;
}
