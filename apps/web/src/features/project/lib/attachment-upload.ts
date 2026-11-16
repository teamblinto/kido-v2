import {
  type Attachment,
  type AttachmentKind,
  MAX_IMAGE_ATTACHMENT_BYTES,
  attachmentSchema,
  attachmentTypeFor,
  maxBytesFor,
} from '@repo/contracts';

import { apiUrl, csrfHeader } from '@/lib/api/client';
import { ApiProblem, ApiUnreachableError, readProblem } from '@/lib/api/problem';
import { attachmentUploadPath } from '../api';

/** A file refused before any request: the reason is the sentence the chip shows. */
export class AttachmentRefusal extends Error {
  override name = 'AttachmentRefusal';
}

/** `12 KB`, `3.4 MB`: what a chip says about a size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The long edge a raster image is scaled down to before it is sent. */
const MAX_IMAGE_EDGE = 2048;

async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Blob | null> {
  // OffscreenCanvas keeps the main thread's canvas out of it where the browser has one.
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);

    return canvas.convertToBlob({ quality, type: 'image/webp' });
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height);

  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/webp', quality);
  });
}

/** Re-encode a raster image under the image cap and the long-edge limit, or `undefined` if it fits. */
async function downscale(file: File): Promise<File | undefined> {
  // No decoder (jsdom, very old browsers): the size check after this decides.
  if (typeof createImageBitmap !== 'function') return undefined;

  let bitmap: ImageBitmap;

  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Undecodable here; the server checks the bytes itself.
    return undefined;
  }

  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);

    if (file.size <= MAX_IMAGE_ATTACHMENT_BYTES && longEdge <= MAX_IMAGE_EDGE) return undefined;

    let scale = Math.min(1, MAX_IMAGE_EDGE / longEdge);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const quality = attempt % 2 === 0 ? 0.85 : 0.7;
      const blob = await encode(
        bitmap,
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)),
        quality,
      );

      if (blob !== null && blob.size <= MAX_IMAGE_ATTACHMENT_BYTES) {
        // A browser that cannot write WebP hands back PNG; name the file for what it holds.
        const extension =
          blob.type === 'image/webp' ? 'webp' : blob.type === 'image/jpeg' ? 'jpg' : 'png';
        const base = file.name.replace(/\.[^.]+$/, '');

        return new File([blob], `${base}.${extension}`, { type: blob.type });
      }

      if (attempt % 2 === 1) scale *= 0.75;
    }

    return undefined;
  } finally {
    bitmap.close();
  }
}

/**
 * The file as it will be uploaded: its kind from the extension allowlist, a large raster image
 * scaled down, and anything still past its cap refused — all before a request is made.
 */
export async function prepareAttachmentFile(
  file: File,
): Promise<{ readonly file: File; readonly kind: AttachmentKind }> {
  const type = attachmentTypeFor(file.name);

  if (type === null) {
    throw new AttachmentRefusal("This file type isn't supported.");
  }

  const cap = maxBytesFor(type.kind);
  const isRaster = type.kind === 'image' && type.mimeType !== 'image/gif';
  const prepared = isRaster ? ((await downscale(file)) ?? file) : file;

  if (prepared.size > cap) {
    throw new AttachmentRefusal(
      type.mimeType === 'image/gif'
        ? `GIFs can be at most ${formatBytes(cap)}.`
        : `This file is larger than ${formatBytes(cap)}.`,
    );
  }

  return { file: prepared, kind: type.kind };
}

export interface UploadOptions {
  readonly onProgress?: (fraction: number) => void;
  readonly signal?: AbortSignal;
}

/** One XHR attempt: `fetch` reports no upload progress, so this is the one call not on `apiRequest`. */
function send(url: string, file: File, options: UploadOptions): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    // Same reason as `apiRequest`'s `credentials: 'include'`: the session is a cookie.
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    // Always octet-stream: the app-wide JSON parser would consume a `.json` file's body (spec 048).
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    for (const [name, value] of Object.entries(csrfHeader())) xhr.setRequestHeader(name, value);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0)
        options.onProgress?.(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      resolve(xhr);
    });
    xhr.addEventListener('error', () => {
      reject(new ApiUnreachableError(undefined));
    });
    xhr.addEventListener('abort', () => {
      reject(new DOMException('The upload was cancelled.', 'AbortError'));
    });
    options.signal?.addEventListener('abort', () => {
      xhr.abort();
    });
    xhr.send(file);
  });
}

const problemOf = async (xhr: XMLHttpRequest): Promise<ApiProblem> =>
  new ApiProblem(xhr.status, await readProblem(new Response(xhr.responseText)));

/**
 * Upload a file to a project (spec 048): the raw file as the body, its name in the query. Resolves
 * with the stored `Attachment`; a refusal is an `ApiProblem` whose sentence comes from `MESSAGES`.
 * A `csrf-check-failed` is retried once, as `apiRequest` does.
 */
export async function uploadAttachment(
  orgId: string,
  projectId: string,
  file: File,
  options: UploadOptions = {},
): Promise<Attachment> {
  const url = apiUrl(attachmentUploadPath(orgId, projectId, file.name));
  let xhr = await send(url, file, options);

  if (xhr.status === 403) {
    const problem = await problemOf(xhr);

    if (problem.slug !== 'csrf-check-failed') throw problem;

    xhr = await send(url, file, options);
  }

  if (xhr.status < 200 || xhr.status >= 300) throw await problemOf(xhr);

  return attachmentSchema.parse(JSON.parse(xhr.responseText));
}
