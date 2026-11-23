import { join } from 'node:path';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';

import type { Environment } from '../../config/environment';
import { FsObjectStore } from './fs-object-store';
import { type ObjectStorePort, UnconfiguredObjectStore } from './object-store.port';

/** The SDK's 404s: `NoSuchKey` from GetObject, `NotFound` from HeadObject. */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404 || error.name === 'NoSuchKey' || error.name === 'NotFound';
}

/**
 * `ObjectStorePort` over Cloudflare R2 through `@aws-sdk/client-s3` (research R8): `region:
 * 'auto'` and path-style are R2's two quirks. Metadata rides as `x-amz-meta-*` — `{ head: sha }`
 * is what the mirror consumer compares against.
 */
export class R2ObjectStore implements ObjectStorePort {
  constructor(
    private readonly client: Pick<S3Client, 'send'>,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Buffer, meta: Readonly<Record<string, string>>): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Body: body, Bucket: this.bucket, Key: key, Metadata: { ...meta } }),
    );
  }

  async get(key: string): Promise<{ body: Buffer; meta: Record<string, string> } | null> {
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const bytes = (await output.Body?.transformToByteArray()) ?? new Uint8Array();
      return { body: Buffer.from(bytes), meta: { ...output.Metadata } };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async head(key: string): Promise<{ meta: Record<string, string> } | null> {
    try {
      const output = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { meta: { ...output.Metadata } };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/**
 * The two buckets the one set of credentials reaches (spec 027 R7), plus `attachments` (spec 048):
 * a logical bucket over the artifacts bucket, its keys prefixed `attachments/`. A bucket of its own
 * was rejected — it would add a required production variable for no isolation gain.
 */
export type ObjectStoreBucket = 'repos' | 'artifacts' | 'attachments';

const BUCKET_VARIABLE = {
  artifacts: 'OBJECT_STORE_BUCKET_ARTIFACTS',
  attachments: 'OBJECT_STORE_BUCKET_ARTIFACTS',
  repos: 'OBJECT_STORE_BUCKET_REPOS',
} as const satisfies Record<ObjectStoreBucket, keyof Environment>;

/**
 * An object-store factory (contracts § 7): R2 over the named bucket when the credentials and
 * that bucket are set, the throwing stand-in otherwise. The environment schema already refuses
 * "otherwise" outside `local` (FR-024) and keeps the variables all-or-none, so reaching the
 * stand-in here means a local developer without a bucket.
 */
export function objectStoreFor(
  config: ConfigService<Environment, true>,
  bucketName: ObjectStoreBucket,
): ObjectStorePort {
  const endpoint = config.get('OBJECT_STORE_ENDPOINT', { infer: true });
  const accessKeyId = config.get('OBJECT_STORE_ACCESS_KEY_ID', { infer: true });
  const secretAccessKey = config.get('OBJECT_STORE_SECRET_ACCESS_KEY', { infer: true });
  const bucket = config.get(BUCKET_VARIABLE[bucketName], { infer: true });

  if (
    endpoint === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    bucket === undefined
  ) {
    // A single host with no bucket keeps every store on its persistent directory. Artifacts get a
    // subdirectory of their own, so a release's blobs never share a namespace with the mirrors.
    // The gateway serves platform-hosted sites over S3 only, so such a host has no `SITE_DOMAIN`
    // serving; what reads artifacts there is the worker's Netlify publish (`ReleaseReader`).
    const dir = config.get('OBJECT_STORE_DIR', { infer: true });

    if (dir === undefined) return new UnconfiguredObjectStore();

    return new FsObjectStore(bucketName === 'artifacts' ? join(dir, 'artifacts') : dir);
  }

  return new R2ObjectStore(
    new S3Client({
      credentials: { accessKeyId, secretAccessKey },
      endpoint,
      forcePathStyle: true,
      region: 'auto',
    }),
    bucket,
  );
}
