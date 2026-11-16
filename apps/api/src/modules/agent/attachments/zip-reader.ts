import { inflateRawSync } from 'node:zlib';

/**
 * A minimal ZIP reader for chat attachments (spec 048): enough to list an archive and read a few
 * small entries out of a DOCX or a ZIP, all in memory. A parser dependency was rejected (a new
 * runtime dependency is ask-first), and so was extracting to disk: entries are only ever bytes in a
 * buffer, so there is no path to climb out of (no zip-slip surface).
 *
 * It trusts nothing in the archive. Every offset is checked against the buffer; encrypted entries,
 * ZIP64 and any method but stored and deflate are refused; and the caps below stop a bomb from the
 * declared sizes before anything is inflated, then again from the real output while inflating.
 */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipLimits {
  /** Entries in the central directory. */
  readonly maxEntries: number;
  /** One entry, inflated, when read. */
  readonly maxEntryBytes: number;
  /** Declared size over compressed size, for any entry declared larger than `ratioFloorBytes`. */
  readonly maxRatio: number;
  /** Every entry's declared size, summed. */
  readonly maxTotalBytes: number;
  /** Everything one archive may inflate across all reads. */
  readonly maxTotalReadBytes: number;
  /** A small entry squeezes well and harms nothing, so the ratio applies above this. */
  readonly ratioFloorBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2_000,
  maxEntryBytes: 1024 * 1024,
  maxRatio: 100,
  maxTotalBytes: 256 * 1024 * 1024,
  maxTotalReadBytes: 8 * 1024 * 1024,
  ratioFloorBytes: 64 * 1024,
};

export interface ZipEntry {
  readonly compressedSize: number;
  readonly directory: boolean;
  readonly method: number;
  readonly name: string;
  readonly offset: number;
  readonly size: number;
}

export interface ZipArchive {
  readonly entries: readonly ZipEntry[];
  /** The entry's bytes; throws `ZipError` past a cap or on a corrupt entry. */
  read(entry: ZipEntry): Buffer;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const STORED = 0;
const DEFLATE = 8;

/** Opens `buffer` as a ZIP; throws `ZipError` when it is not one this reader will read. */
export function openZip(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipArchive {
  const eocd = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(eocd + 4);
  const cdDisk = buffer.readUInt16LE(eocd + 6);
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported.');
  }
  if (disk !== 0 || cdDisk !== 0) throw new ZipError('Multi-part archives are not supported.');
  if (count > limits.maxEntries) throw new ZipError('The archive has too many entries.');
  if (cdOffset + cdSize > eocd) throw new ZipError('The archive is corrupt.');

  const entries: ZipEntry[] = [];
  let declared = 0;
  let at = cdOffset;

  for (let index = 0; index < count; index++) {
    if (at + CENTRAL_SIZE > eocd || buffer.readUInt32LE(at) !== CENTRAL) {
      throw new ZipError('The archive is corrupt.');
    }

    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const nameEnd = at + CENTRAL_SIZE + nameLength;

    if (nameEnd + extraLength + commentLength > eocd) throw new ZipError('The archive is corrupt.');
    if ((flags & 0x1) !== 0) throw new ZipError('Encrypted archives are not supported.');
    if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
      throw new ZipError('ZIP64 archives are not supported.');
    }
    if (method !== STORED && method !== DEFLATE) {
      throw new ZipError('The archive uses a compression method that is not supported.');
    }
    if (offset + LOCAL_SIZE > cdOffset) throw new ZipError('The archive is corrupt.');
    if (size > limits.ratioFloorBytes && size / Math.max(compressedSize, 1) > limits.maxRatio) {
      throw new ZipError('The archive expands too far to be read safely.');
    }

    declared += size;
    if (declared > limits.maxTotalBytes) {
      throw new ZipError('The archive expands too far to be read safely.');
    }

    // Bit 11 is UTF-8; otherwise CP437, which latin1 approximates well enough for a listing.
    const name = buffer.toString(
      (flags & 0x800) !== 0 ? 'utf8' : 'latin1',
      at + CENTRAL_SIZE,
      nameEnd,
    );

    entries.push({ compressedSize, directory: name.endsWith('/'), method, name, offset, size });
    at = nameEnd + extraLength + commentLength;
  }

  let inflated = 0;

  return {
    entries,
    read(entry: ZipEntry): Buffer {
      if (entry.size > limits.maxEntryBytes) throw new ZipError('The entry is too large to read.');
      if (inflated + entry.size > limits.maxTotalReadBytes) {
        throw new ZipError('The archive expands too far to be read safely.');
      }
      if (buffer.readUInt32LE(entry.offset) !== LOCAL)
        throw new ZipError('The archive is corrupt.');

      const start =
        entry.offset +
        LOCAL_SIZE +
        buffer.readUInt16LE(entry.offset + 26) +
        buffer.readUInt16LE(entry.offset + 28);
      const end = start + entry.compressedSize;

      if (end > cdOffset) throw new ZipError('The archive is corrupt.');

      const raw = buffer.subarray(start, end);
      let bytes: Buffer;

      if (entry.method === STORED) {
        bytes = raw;
      } else {
        try {
          // One byte past the declared size: inflating more than declared proves the header lied.
          bytes = inflateRawSync(raw, { maxOutputLength: entry.size + 1 });
        } catch {
          throw new ZipError('The archive is corrupt or expands too far.');
        }
      }

      if (bytes.length !== entry.size) throw new ZipError('The archive is corrupt.');
      inflated += bytes.length;

      return bytes;
    },
  };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is the last thing in the file but for a comment of at most 65 535 bytes.
  const floor = Math.max(0, buffer.length - EOCD_SIZE - 0xffff);

  for (let at = buffer.length - EOCD_SIZE; at >= floor; at--) {
    if (buffer.readUInt32LE(at) === EOCD) return at;
  }

  throw new ZipError('The file is not a ZIP archive.');
}
