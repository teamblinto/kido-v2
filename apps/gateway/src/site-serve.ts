import { createHash } from 'node:crypto';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { z } from 'zod';

import {
  METHOD_NOT_ALLOWED_PAGE,
  REFUSED_PAGE,
  send,
  SITE_BROKEN_PAGE,
  SITE_UNAVAILABLE_PAGE,
} from './pages.ts';
import { type ObjectStoreTarget, signS3Get } from './sigv4.ts';

/**
 * Serving a deployed site from the artifacts bucket (contracts/site-serving.md § 4–5, research
 * R11). The gateway reads immutable content by hash: the signed site record names an `artifact`
 * (the sha-256 of its manifest), the manifest maps paths to blob hashes, and every response header
 * is generated here from the manifest. Nothing from the object store's response and nothing from
 * the request is passed through, so an object's metadata can never set a cookie or a type.
 *
 * FR-025 (research R11 amendment, ADR 053): when the current manifest misses a path under
 * `assets/`, the project's asset index (`{org}/{project}/asset-index/{path}`, written by the API
 * at upload) is read for it, so the hashed assets of an earlier release stay retrievable after a
 * switch. Entry pages and the SPA fallback come from the current manifest alone.
 */

/** What the signed site record contributes; the verifier and broker live elsewhere (T056). */
export interface SiteTarget {
  readonly artifact: string;
  readonly org: string;
  readonly project: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_PATH_BYTES = 1024;

/** A manifest path per the tar reader's rules (research R5): relative, no `..`, `\` or NUL. */
function isSafePath(path: string): boolean {
  return (
    path.length > 0 &&
    Buffer.byteLength(path) <= MAX_PATH_BYTES &&
    !path.startsWith('/') &&
    !/[\\\0]/.test(path) &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

/**
 * The gateway's loose half of the manifest (data-model § Object storage). `type` is checked to be
 * a header-safe media type rather than against the API's extension table: the table is the
 * writer's to own, and the sha-256 check already ties these bytes to what the worker wrote.
 */
const entryShape = {
  sha: z.string().regex(SHA256_HEX),
  size: z.number().int().nonnegative(),
  type: z.string().regex(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*(; ?charset=[a-z0-9-]+)?$/i),
};

const entrySchema = z.looseObject(entryShape);

export type ManifestEntry = z.output<typeof entrySchema>;

/** The validated manifest. `files` has no prototype: every key, `__proto__` included, is a file. */
export interface SiteManifest {
  readonly files: Readonly<Record<string, ManifestEntry>>;
  readonly version: 1;
}

const manifestShellSchema = z.looseObject({ files: z.unknown(), version: z.literal(1) });

/**
 * The `files` map, walked by hand rather than with `z.record`: a record schema assigns each key to
 * a plain object, where `__proto__` sets the prototype instead of adding the entry. `JSON.parse`
 * made every key an own property; this keeps it one, on an object with no prototype.
 */
function parseFiles(value: unknown): SiteManifest['files'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const files = Object.create(null) as Record<string, ManifestEntry>;
  let count = 0;
  let total = 0;
  for (const [path, raw] of Object.entries(value)) {
    const entry = entrySchema.safeParse(raw);
    if (!isSafePath(path) || !entry.success) return undefined;
    files[path] = entry.data;
    count += 1;
    total += entry.data.size;
  }
  return count <= MAX_FILES && total <= MAX_TOTAL_BYTES ? files : undefined;
}

/** The manifest, or `undefined` when its sha-256 is not `artifact` or it fails validation. */
export function parseManifest(bytes: Buffer, artifact: string): SiteManifest | undefined {
  if (createHash('sha256').update(bytes).digest('hex') !== artifact) return undefined;
  try {
    const parsed = manifestShellSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success) return undefined;
    const files = parseFiles(parsed.data.files);
    return files === undefined ? undefined : { ...parsed.data, files, version: 1 };
  } catch {
    return undefined;
  }
}

/**
 * Request target → manifest key (contract § 5), or `undefined` for the uniform 404: strip the
 * query; percent-decode once, refusing `%2F`, `%5C`, `%00` and any `..` segment; `/` →
 * `index.html`; a trailing `/` → `{path}index.html`; an exact key; no `.` in the last segment →
 * `index.html` (SPA fallback); else nothing.
 */
export function resolveSitePath(url: string, manifest: SiteManifest): string | undefined {
  const request = requestKey(url);
  if (request === undefined) return undefined;
  const { key, last } = request;
  if (Object.hasOwn(manifest.files, key)) return key;
  if (!last.includes('.') && Object.hasOwn(manifest.files, 'index.html')) return 'index.html';
  return undefined;
}

/**
 * The decoded key a request names before any manifest lookup, and its last path segment as
 * requested (`''` for a trailing `/`), or `undefined` when the target is refused.
 */
function requestKey(url: string): { key: string; last: string } | undefined {
  const raw = url.replace(/[?#][\s\S]*$/, '');
  if (!raw.startsWith('/') || /%(2f|5c|00)/i.test(raw) || /[\\\0]/.test(raw)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  const segments = decoded.slice(1).split('/');
  if (/[\\\0]/.test(decoded) || segments.some((s) => s === '..' || s === '.')) return undefined;
  const last = decoded.slice(decoded.lastIndexOf('/') + 1);
  return { key: last === '' ? `${decoded.slice(1)}index.html` : decoded.slice(1), last };
}

/**
 * The path to look up in the asset index after a manifest miss, or `undefined`: only a key under
 * `assets/` that is also a well-formed manifest path (no empty, `.` or `..` segment) qualifies.
 */
function assetIndexPath(url: string): string | undefined {
  const key = requestKey(url)?.key;
  return key !== undefined && key.startsWith('assets/') && isSafePath(key) ? key : undefined;
}

/** Every header a site response carries; generated, never passed through (contract § 5). */
export function siteHeaders(key: string, entry: ManifestEntry): Record<string, string> {
  return {
    'Cache-Control': key.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate',
    'Content-Length': String(entry.size),
    'Content-Type': entry.type,
    ETag: `"${entry.sha}"`,
    'X-Content-Type-Options': 'nosniff',
  };
}

function matchesEtag(ifNoneMatch: string | undefined, sha: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === `"${sha}"`);
}

/** A read from the artifacts bucket. `headers` are the store's and are never forwarded. */
export interface StoreObject {
  readonly body: Readable;
  readonly headers: IncomingHttpHeaders;
}

/** `undefined` = no such key; a rejection = the store is unavailable. */
export interface ArtifactStore {
  get(key: string): Promise<StoreObject | undefined>;
}

/** Parsed manifests by `artifact` (immutable, so never revalidated), least recently used out. */
export function createManifestCache(max = 256) {
  const entries = new Map<string, SiteManifest>();
  return {
    get(artifact: string): SiteManifest | undefined {
      const manifest = entries.get(artifact);
      if (manifest !== undefined) {
        entries.delete(artifact);
        entries.set(artifact, manifest);
      }
      return manifest;
    },
    set(artifact: string, manifest: SiteManifest): void {
      entries.delete(artifact);
      entries.set(artifact, manifest);
      while (entries.size > max) {
        entries.delete(entries.keys().next().value!);
      }
    },
  };
}

export type ManifestCache = ReturnType<typeof createManifestCache>;

/**
 * The most manifest bytes read before giving up. A manifest at the data-model limits (10,000
 * entries, 1,024-byte paths, ~110 bytes of `sha`/`size`/`type` each) is about 11.3 MB, so every
 * valid one fits; anything larger is refused before it is parsed or cached.
 */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** An asset-index entry is one canonical manifest entry (~120 bytes); anything larger is refused. */
export const MAX_ASSET_INDEX_BYTES = 1024;

/**
 * An asset-index entry: exactly `{ sha, size, type }` with the manifest's rules, and `size`
 * within the manifest's total cap. Strict, since it is not tied to a signed artifact by hash.
 */
const assetIndexSchema = z.strictObject({
  ...entryShape,
  size: entryShape.size.max(MAX_TOTAL_BYTES),
});

/** The project's asset-index key for `path` (research R11 amendment). */
export function assetIndexKey(target: SiteTarget, path: string): string {
  return `${target.org}/${target.project}/asset-index/${path}`;
}

export interface SiteServeDeps {
  readonly manifests: ManifestCache;
  /** Defaults to `MAX_MANIFEST_BYTES`. */
  readonly maxManifestBytes?: number;
  readonly store: ArtifactStore;
}

/** The body, or `undefined` as soon as it passes `max` bytes (the stream is destroyed). */
async function readCapped(body: Readable, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += (chunk as Buffer).length;
    if (total > max) {
      body.destroy();
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function loadManifest(target: SiteTarget, deps: SiteServeDeps) {
  const cached = deps.manifests.get(target.artifact);
  if (cached !== undefined) return cached;
  const object = await deps.store.get(
    `${target.org}/${target.project}/${target.artifact}/manifest.json`,
  );
  if (object === undefined) return undefined;
  const bytes = await readCapped(object.body, deps.maxManifestBytes ?? MAX_MANIFEST_BYTES);
  if (bytes === undefined) return undefined;
  const manifest = parseManifest(bytes, target.artifact);
  if (manifest !== undefined) deps.manifests.set(target.artifact, manifest);
  return manifest;
}

/**
 * The index entry for `path`: `undefined` when there is none, `'unavailable'` when it is over the
 * cap or malformed (as a bad manifest is), a rejection when the store is.
 */
async function readAssetIndex(
  target: SiteTarget,
  path: string,
  deps: SiteServeDeps,
): Promise<ManifestEntry | 'unavailable' | undefined> {
  const object = await deps.store.get(assetIndexKey(target, path));
  if (object === undefined) return undefined;
  const bytes = await readCapped(object.body, MAX_ASSET_INDEX_BYTES);
  if (bytes === undefined) return 'unavailable';
  try {
    const parsed = assetIndexSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Answers one request for a resolved site. The caller has already verified the site record; this
 * owns everything after it (contract § 5). It never throws: a failure before the headers is a
 * page, a failure while streaming destroys the response.
 */
export async function serveSite(
  req: IncomingMessage,
  res: ServerResponse,
  target: SiteTarget,
  deps: SiteServeDeps,
): Promise<void> {
  req.resume();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, METHOD_NOT_ALLOWED_PAGE);
    return;
  }
  let manifest: SiteManifest | undefined;
  try {
    manifest = await loadManifest(target, deps);
  } catch {
    manifest = undefined;
  }
  if (manifest === undefined) {
    send(res, SITE_UNAVAILABLE_PAGE);
    return;
  }
  // `url` is always set on a request from `http.Server`; the type allows otherwise.
  const url = req.url ?? '/';
  let key = resolveSitePath(url, manifest);
  let entry: ManifestEntry | undefined = key === undefined ? undefined : manifest.files[key];
  if (key === undefined) {
    key = assetIndexPath(url);
    if (key !== undefined) {
      const found = await readAssetIndex(target, key, deps).catch(() => 'unavailable' as const);
      if (found === 'unavailable') {
        send(res, SITE_UNAVAILABLE_PAGE);
        return;
      }
      entry = found;
    }
  }
  if (key === undefined || entry === undefined) {
    send(res, REFUSED_PAGE);
    return;
  }
  const headers = siteHeaders(key, entry);
  if (matchesEtag(req.headers['if-none-match'], entry.sha)) {
    res.writeHead(304, headers).end();
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, headers).end();
    return;
  }
  let object: StoreObject | undefined;
  try {
    object = await deps.store.get(`${target.org}/${target.project}/blobs/${entry.sha}`);
  } catch {
    send(res, SITE_UNAVAILABLE_PAGE);
    return;
  }
  if (object === undefined) {
    send(res, SITE_BROKEN_PAGE);
    return;
  }
  res.writeHead(200, headers);
  try {
    await pipeline(object.body, res);
  } catch {
    res.destroy();
  }
}

export interface S3ArtifactStoreOptions {
  readonly now?: () => Date;
  /** Connect-and-headers budget per read; the body then streams without one. */
  readonly timeoutMs?: number;
}

/** The read-only artifacts bucket over SigV4 (`sigv4.ts`): `404` → `undefined`, else a throw. */
export function createS3ArtifactStore(
  target: ObjectStoreTarget,
  options: S3ArtifactStoreOptions = {},
): ArtifactStore {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    get(key) {
      const signed = signS3Get(target, key, options.now);
      const url = new URL(signed.url);
      const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
      return new Promise((resolve, reject) => {
        const outgoing = request(url, { headers: signed.headers, method: 'GET' }, (incoming) => {
          outgoing.setTimeout(0);
          const status = incoming.statusCode;
          if (status === 200) {
            resolve({ body: incoming, headers: incoming.headers });
            return;
          }
          incoming.resume();
          // Only `404` is "no such key". AWS S3 answers `403` for a missing key when the read key
          // lacks `s3:ListBucket`, so there a missing blob is a 503 rather than a 502. It stays
          // that way on purpose: reading `403` as missing would hide a wrong or revoked key.
          if (status === 404) resolve(undefined);
          else reject(new Error(`object store answered ${String(status)}`));
        });
        outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error('object store timeout')));
        outgoing.on('error', reject);
        outgoing.end();
      });
    },
  };
}
