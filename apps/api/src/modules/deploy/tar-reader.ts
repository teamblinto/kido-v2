/**
 * A strict ustar reader for the build output (spec 027 research R5).
 *
 * The build sandbox runs `tar -cf /tmp/forge-out.tar -C <output> .` and the worker downloads that
 * one file and reads it here. The archive was produced by code that ran the user's build, so it is
 * untrusted input, and this reader is the boundary:
 *
 * - only regular files (`'0'`, `'\0'`) are kept; directories (`'5'`) are skipped; every other
 *   entry — symbolic and hard links, devices, FIFOs, anything unknown — is **dropped** and
 *   counted, never followed or created;
 * - `pax` (`'x'`) and GNU long-name (`'L'`) headers are honoured for the path of the next entry
 *   only; global pax (`'g'`) and GNU long-link (`'K'`) headers are consumed and ignored;
 * - every kept path is normalised (leading `./` stripped) and refused if it is absolute, empty,
 *   longer than 1024 bytes, or has an empty, `.` or `..` segment, a backslash or a NUL; a
 *   duplicate path is refused;
 * - the file and byte caps are enforced from each header **before** its body is read, so an
 *   oversized archive fails `output-too-large` without being walked to the end;
 * - a truncated archive, a bad checksum, a header without ustar magic or a malformed number is
 *   `malformed`; an archive with no regular file in it is `no-output`.
 *
 * `node:` builtins only (there are none needed beyond `Buffer`).
 *
 * Rejected alternatives:
 * - _Per-file `list` + `download` from the sandbox._ Up to 10,000 round trips per deploy, which
 *   does not fit SC-002's budget; one archive is one download.
 * - _A tar dependency._ A new runtime dependency is ask-first, and the general-purpose extractors
 *   honour links and write to disk — the classic escape. None is as strict as a reader that knows
 *   two type flags and returns bytes in memory.
 * - _Commit the output and ship it back as a `git bundle`_ (the checkpoint precedent). Reading it
 *   back needs `git` on the worker, and a bundle can carry symlinks just the same.
 */

const BLOCK = 512;
/** A `pax` or GNU long-name body larger than this is not a path; refuse it rather than parse it. */
const MAX_META_BYTES = 64 * 1024;
/** The manifest's path limit (data-model.md § Object storage). */
export const MAX_PATH_BYTES = 1024;

export interface TarLimits {
  /** The most regular files the archive may hold (10,000). */
  readonly maxFiles: number;
  /** The most bytes the regular files may hold in total (100 MiB). */
  readonly maxBytes: number;
}

export interface TarFile {
  readonly path: string;
  readonly body: Buffer;
}

export interface TarContents {
  readonly files: TarFile[];
  /** Links, devices, FIFOs and unknown entries that were dropped; reported in the log tail. */
  readonly dropped: number;
  readonly totalBytes: number;
}

export type TarRefusal = 'malformed' | 'no-output' | 'output-too-large';

/** Why the archive was not accepted. `no-output` and `output-too-large` are failure reasons as-is. */
export class TarRefused extends Error {
  constructor(
    readonly reason: TarRefusal,
    detail: string,
  ) {
    super(detail);
    this.name = 'TarRefused';
  }
}

function malformed(detail: string): TarRefused {
  return new TarRefused('malformed', detail);
}

/** Reads `archive` whole, keeping regular files only. Throws `TarRefused` on anything else. */
export function readTar(archive: Buffer, limits: TarLimits): TarContents {
  const files: TarFile[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let totalBytes = 0;
  let longName: string | null = null;
  let offset = 0;

  if (archive.length === 0) throw new TarRefused('no-output', 'the build output archive is empty');

  for (;;) {
    if (offset + BLOCK > archive.length)
      throw malformed('truncated archive: no end-of-archive block');
    const block = archive.subarray(offset, offset + BLOCK);
    offset += BLOCK;

    if (isZero(block)) {
      if (longName !== null) throw malformed('dangling long-name header at end of archive');
      break;
    }

    verifyHeader(block);
    const type = String.fromCharCode(block[156]!);
    const size = readSize(block);
    const isFile = type === '0' || type === '\0';

    if (isFile) {
      if (files.length + 1 > limits.maxFiles) {
        throw new TarRefused('output-too-large', `more than ${limits.maxFiles} files`);
      }
      if (totalBytes + size > limits.maxBytes) {
        throw new TarRefused('output-too-large', `more than ${limits.maxBytes} bytes`);
      }
    } else if (isMeta(type) && size > MAX_META_BYTES) {
      throw malformed(`a '${type}' header of ${size} bytes`);
    }

    const end = offset + size;
    if (end > archive.length) throw malformed('truncated archive: an entry runs past the end');
    const body = archive.subarray(offset, end);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      longName = paxPath(body) ?? longName;
      continue;
    }
    if (type === 'L') {
      longName = cString(body);
      continue;
    }
    if (type === 'g' || type === 'K') continue;

    const name = longName ?? ustarName(block);
    longName = null;

    if (type === '5') continue;
    if (!isFile) {
      dropped += 1;
      continue;
    }

    const path = normalisePath(name);
    if (seen.has(path)) throw malformed(`duplicate path in archive: ${path}`);
    seen.add(path);
    files.push({ path, body: Buffer.from(body) });
    totalBytes += size;
  }

  if (files.length === 0) throw new TarRefused('no-output', 'the build output has no files');
  return { files, dropped, totalBytes };
}

function isMeta(type: string): boolean {
  return type === 'x' || type === 'g' || type === 'L' || type === 'K';
}

function isZero(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/** Checksum and magic. The checksum is the unsigned byte sum with its own field read as spaces. */
function verifyHeader(block: Buffer): void {
  const magic = block.toString('latin1', 257, 265);
  if (magic !== 'ustar\u000000' && magic !== 'ustar  \0') {
    throw malformed('not a ustar header (bad magic)');
  }
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  if (readOctal(block, 148, 8, 'checksum') !== sum) throw malformed('bad header checksum');
}

/** The size field. A base-256 size (high bit set) is ≥ 8 GiB, so it is over the cap by definition. */
function readSize(block: Buffer): number {
  if ((block[124]! & 0x80) !== 0) {
    throw new TarRefused('output-too-large', 'an entry larger than 8 GiB');
  }
  return readOctal(block, 124, 12, 'size');
}

function readOctal(block: Buffer, start: number, length: number, what: string): number {
  const text = block
    .toString('latin1', start, start + length)
    .replace(/[\0 ]+$/, '')
    .replace(/^ +/, '');
  if (!/^[0-7]*$/.test(text)) throw malformed(`the ${what} field is not octal`);
  return text === '' ? 0 : parseInt(text, 8);
}

/** A NUL-terminated field, as UTF-8. */
function cString(bytes: Buffer): string {
  const nul = bytes.indexOf(0);
  return bytes.toString('utf8', 0, nul === -1 ? bytes.length : nul);
}

/** The name, joined to the POSIX prefix field when the magic says the prefix field is one. */
function ustarName(block: Buffer): string {
  const name = cString(block.subarray(0, 100));
  if (block.toString('latin1', 257, 263) !== 'ustar\0') return name;
  const prefix = cString(block.subarray(345, 500));
  return prefix === '' ? name : `${prefix}/${name}`;
}

/** The `path` record of a pax extended header, or `null` when it has none. */
function paxPath(body: Buffer): string | null {
  let path: string | null = null;
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const digits = space === -1 ? '' : body.toString('latin1', offset, space);
    if (!/^[1-9][0-9]*$/.test(digits)) throw malformed('malformed pax record length');
    const end = offset + Number(digits);
    if (end > body.length || body[end - 1] !== 0x0a) throw malformed('malformed pax record');
    const record = body.toString('utf8', space + 1, end - 1);
    const equals = record.indexOf('=');
    if (equals === -1) throw malformed('malformed pax record: no key');
    if (record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    offset = end;
  }
  return path;
}

/**
 * The reader's path rules, shared with the manifest (data-model.md): relative, at most 1024 bytes,
 * no empty, `.` or `..` segment, no backslash, no NUL. Leading `./` is stripped first.
 */
export function normalisePath(raw: string): string {
  const path = raw.replace(/^(\.\/)+/, '');
  const refuse = (why: string): TarRefused =>
    malformed(`refused path ${JSON.stringify(raw)}: ${why}`);
  if (path === '') throw refuse('empty');
  if (path.startsWith('/')) throw refuse('absolute');
  if (path.includes('\\')) throw refuse('backslash');
  if (path.includes('\0')) throw refuse('NUL');
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) throw refuse('too long');
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw refuse(`segment "${segment}"`);
  }
  return path;
}
