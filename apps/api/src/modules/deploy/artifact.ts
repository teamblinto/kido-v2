import { createHash } from 'node:crypto';

import type { ObjectStorePort } from '../../common/object-store/object-store.port';

/**
 * A release as stored in the artifacts bucket (spec 027 research R6, data-model.md § Object
 * storage): each distinct file body once per project under its own hash, and a canonical manifest
 * naming them. The manifest's own sha-256 is the artifact's identity.
 *
 * ```text
 * {org}/{project}/blobs/{fileSha256}              body = file bytes; meta { type }
 * {org}/{project}/asset-index/assets/{path}       body = canonical manifest entry; meta { sha }
 * {org}/{project}/{artifactSha256}/manifest.json  body = canonical manifest; meta { files, bytes }
 * ```
 *
 * The asset index (FR-025, research R11 amendment, ADR 053) maps each `assets/` path any release
 * of the project has held to its manifest entry. The gateway reads it only when the current
 * manifest misses a path under `assets/`, so a page of the previous release loaded just before a
 * switch still gets its hashed chunks. An entry is last-writer-wins; with content-hashed names
 * it is written once and never changes.
 *
 * Blobs sit outside the release folder so the hashed assets two releases share are stored once,
 * which is also why a rollback never finds a missing chunk (FR-025). Byte-identical builds give
 * the same `artifactSha` and upload nothing new.
 */

export interface ArtifactFile {
  readonly path: string;
  readonly body: Buffer;
}

export interface ManifestEntry {
  readonly sha: string;
  readonly size: number;
  readonly type: string;
}

export interface Manifest {
  readonly files: Record<string, ManifestEntry>;
  readonly version: 1;
}

export interface BuiltManifest {
  readonly manifest: Manifest;
  /** The canonical bytes that are stored, and hashed. */
  readonly bytes: Buffer;
  readonly artifactSha: string;
}

export interface UploadResult {
  readonly artifactSha: string;
  readonly fileCount: number;
  readonly totalBytes: number;
}

/**
 * The fixed content-type table: the worker assigns `type` from the extension, and the gateway
 * serves what the manifest says. Anything not here is `application/octet-stream`, which a browser
 * downloads rather than renders.
 */
export const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['htm', 'text/html; charset=utf-8'],
  ['js', 'text/javascript'],
  ['mjs', 'text/javascript'],
  ['css', 'text/css'],
  ['json', 'application/json'],
  ['map', 'application/json'],
  ['webmanifest', 'application/manifest+json'],
  ['txt', 'text/plain; charset=utf-8'],
  ['xml', 'application/xml'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['ico', 'image/x-icon'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['otf', 'font/otf'],
  ['wasm', 'application/wasm'],
  ['pdf', 'application/pdf'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
]);

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** Blob writes in flight at once: enough to hide round-trip latency, few enough to be polite. */
const UPLOAD_CONCURRENCY = 8;

/** The content type for `path`, from its last extension, case-insensitively. */
export function contentTypeFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return DEFAULT_CONTENT_TYPE;
  return CONTENT_TYPES.get(name.slice(dot + 1).toLowerCase()) ?? DEFAULT_CONTENT_TYPE;
}

/** JSON with object keys sorted at every level and no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([left], [right]) => (left < right ? -1 : 1)))
      : inner,
  );
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function blobKey(orgId: string, projectId: string, fileSha: string): string {
  return `${orgId}/${projectId}/blobs/${fileSha}`;
}

/** The asset-index entry for `path`, which must be under `assets/`. */
export function assetIndexKey(orgId: string, projectId: string, path: string): string {
  return `${orgId}/${projectId}/asset-index/${path}`;
}

/** Only these paths are indexed: the gateway serves them `immutable` (contract § 5). */
export function isIndexedAsset(path: string): boolean {
  return path.startsWith('assets/');
}

/** Runs `task` over `items` with at most `UPLOAD_CONCURRENCY` in flight; the first failure stops it. */
async function inPool<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
  const pending = [...items];
  const worker = async (): Promise<void> => {
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      try {
        await task(next);
      } catch (error) {
        pending.length = 0; // the other workers stop at their next pop
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
}

export function manifestKey(orgId: string, projectId: string, artifactSha: string): string {
  return `${orgId}/${projectId}/${artifactSha}/manifest.json`;
}

/** The canonical manifest for `files`, whatever order they come in. */
export function buildManifest(files: readonly ArtifactFile[]): BuiltManifest {
  // No prototype, so a file named `__proto__` is an entry like any other, not a prototype set.
  const entries = Object.create(null) as Record<string, ManifestEntry>;
  for (const file of files) {
    if (Object.hasOwn(entries, file.path))
      throw new Error(`duplicate path in artifact: ${file.path}`);
    entries[file.path] = {
      sha: sha256(file.body),
      size: file.body.length,
      type: contentTypeFor(file.path),
    };
  }
  const manifest: Manifest = { files: entries, version: 1 };
  const bytes = Buffer.from(canonicalJson(manifest), 'utf8');
  return { manifest, bytes, artifactSha: sha256(bytes) };
}

/**
 * Uploads `files` as one artifact (R6, FR-021): the blobs not already stored, then the asset-index
 * entries not already naming the same blob, then the manifest, then a `head` of the manifest to
 * confirm it before go-live. The manifest is never written until every blob and index entry it
 * implies is, so a manifest that exists is always whole, and an index entry never names a blob
 * that was not written.
 */
export async function upload(
  store: ObjectStorePort,
  orgId: string,
  projectId: string,
  files: readonly ArtifactFile[],
): Promise<UploadResult> {
  const { manifest, bytes, artifactSha } = buildManifest(files);
  const totalBytes = files.reduce((sum, file) => sum + file.body.length, 0);
  const result = { artifactSha, fileCount: files.length, totalBytes };
  const key = manifestKey(orgId, projectId, artifactSha);

  // Byte-identical output: the manifest exists, so every blob it names does too. This `head` is
  // also the confirmation.
  if (await store.head(key)) return result;

  const blobs = new Map<string, ArtifactFile>();
  for (const file of files) {
    const { sha } = manifest.files[file.path]!;
    if (!blobs.has(sha)) blobs.set(sha, file);
  }

  await inPool([...blobs], async ([sha, file]) => {
    const at = blobKey(orgId, projectId, sha);
    if (await store.head(at)) return;
    await store.put(at, file.body, { type: manifest.files[file.path]!.type });
  });

  const assets = Object.keys(manifest.files).filter(isIndexedAsset);
  await inPool(assets, async (path) => {
    const entry = manifest.files[path]!;
    const at = assetIndexKey(orgId, projectId, path);
    if ((await store.head(at))?.meta.sha === entry.sha) return;
    await store.put(at, Buffer.from(canonicalJson(entry), 'utf8'), { sha: entry.sha });
  });

  await store.put(key, bytes, { files: String(files.length), bytes: String(totalBytes) });
  if (!(await store.head(key)))
    throw new Error(`the manifest was not found after writing it: ${key}`);

  return result;
}
