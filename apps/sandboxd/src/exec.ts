import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

import { HttpError } from './http.ts';

export const MAX_UPLOAD = 64 << 20;
export const MAX_JSON = 1 << 20;
export const SESSION_ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** Exit codes the guard script uses so the caller can tell 404 from 400 without parsing text. */
export const NOT_FOUND = 44;
export const WRONG_KIND = 45;

/** Absolute, NUL-free, bounded: the only shape of path that reaches the container. */
export function absPath(raw: string | null | undefined): string {
  if (!raw || raw.length > 4096 || raw.includes('\0') || !raw.startsWith('/')) {
    throw new HttpError(400, 'path must be an absolute path');
  }
  return raw;
}

export function sessionId(raw: string | undefined): string {
  if (raw === undefined || !SESSION_ID.test(raw)) throw new HttpError(400, 'invalid sessionId');
  return raw;
}

/**
 * argv that checks `p` (`-e` exists, `-d` directory, `-f` regular file) and then execs `argv`.
 * The path is only ever a positional parameter, never part of the script text.
 */
export function guarded(mode: '-e' | '-d' | '-f', p: string, argv: string[]): string[] {
  const script = `m=$1; p=$2; shift 2; test -e "$p" || exit ${NOT_FOUND}; test "$m" "$p" || exit ${WRONG_KIND}; exec "$@"`;
  return ['sh', '-c', script, 'sh', mode, p, ...argv];
}

async function* capped(req: IncomingMessage, max: number, hit: () => void) {
  let n = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > max) {
      hit();
      throw new HttpError(413, 'body too large');
    }
    yield c;
  }
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of capped(req, MAX_JSON, () => undefined)) chunks.push(c);
  try {
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid JSON body');
}

/** The `file` part of a multipart body, with the size cap enforced while reading. */
export async function readUpload(req: IncomingMessage): Promise<Buffer> {
  let tooBig = false;
  const body = Readable.toWeb(
    Readable.from(capped(req, MAX_UPLOAD + (1 << 20), () => (tooBig = true))),
  );
  let file: FormDataEntryValue | null;
  try {
    const form = await new Request('http://sandboxd/', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? '' },
      body: body as unknown as ReadableStream,
      duplex: 'half',
    } as RequestInit).formData();
    file = form.get('file');
  } catch {
    if (tooBig) throw new HttpError(413, 'body too large');
    throw new HttpError(400, 'invalid multipart body');
  }
  if (!(file instanceof Blob)) throw new HttpError(400, 'missing form field: file');
  if (file.size > MAX_UPLOAD) throw new HttpError(413, 'file too large');
  return Buffer.from(await file.arrayBuffer());
}
