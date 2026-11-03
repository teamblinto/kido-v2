import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { Environment } from '../../config/environment';
import {
  type ObjectStorePort,
  ObjectStoreUnconfigured,
  UnconfiguredObjectStore,
} from './object-store.port';
import { objectStoreFor, R2ObjectStore } from './r2-object-store';

const KEY = 'forge-repos/org_1/proj_1.git';
const SHA = 'a'.repeat(40);

function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { $metadata: { httpStatusCode: status }, name });
}

function storeWith(send: (command: unknown) => Promise<unknown>) {
  const client = { send: vi.fn(send) };
  return { client, store: new R2ObjectStore(client as never, 'repos') };
}

describe('R2ObjectStore', () => {
  it('put sends PutObject with the body and the metadata beside it', async () => {
    const { client, store } = storeWith(() => Promise.resolve({}));

    await store.put(KEY, Buffer.from('bundle'), { head: SHA });

    const command = client.send.mock.calls[0]?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Body: Buffer.from('bundle'),
      Bucket: 'repos',
      Key: KEY,
      Metadata: { head: SHA },
    });
  });

  it('get returns the body and metadata', async () => {
    const { client, store } = storeWith(() =>
      Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([98, 117])) },
        Metadata: { head: SHA },
      }),
    );

    await expect(store.get(KEY)).resolves.toEqual({ body: Buffer.from('bu'), meta: { head: SHA } });
    expect(client.send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
  });

  it('head returns the metadata alone', async () => {
    const { client, store } = storeWith(() => Promise.resolve({ Metadata: { head: SHA } }));

    await expect(store.head(KEY)).resolves.toEqual({ meta: { head: SHA } });
    expect(client.send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('delete sends DeleteObject for the key', async () => {
    const { client, store } = storeWith(() => Promise.resolve({}));

    await store.delete(KEY);

    const command = client.send.mock.calls[0]?.[0] as DeleteObjectCommand;
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toMatchObject({ Bucket: 'repos', Key: KEY });
  });

  it('maps the SDK 404s (NoSuchKey on get, NotFound on head) to null', async () => {
    const { store: getStore } = storeWith(() => Promise.reject(s3Error('NoSuchKey', 404)));
    const { store: headStore } = storeWith(() => Promise.reject(s3Error('NotFound', 404)));

    await expect(getStore.get(KEY)).resolves.toBeNull();
    await expect(headStore.head(KEY)).resolves.toBeNull();
  });

  it('lets any other failure propagate', async () => {
    const { store } = storeWith(() => Promise.reject(new Error('ECONNRESET')));

    await expect(store.get(KEY)).rejects.toThrow('ECONNRESET');
    await expect(store.head(KEY)).rejects.toThrow('ECONNRESET');
    await expect(store.put(KEY, Buffer.alloc(0), {})).rejects.toThrow('ECONNRESET');
  });
});

describe('UnconfiguredObjectStore', () => {
  it('throws ObjectStoreUnconfigured on every call', async () => {
    const store: ObjectStorePort = new UnconfiguredObjectStore();

    await expect(store.put(KEY, Buffer.alloc(0), {})).rejects.toBeInstanceOf(
      ObjectStoreUnconfigured,
    );
    await expect(store.get(KEY)).rejects.toBeInstanceOf(ObjectStoreUnconfigured);
    await expect(store.head(KEY)).rejects.toBeInstanceOf(ObjectStoreUnconfigured);
    await expect(store.delete(KEY)).rejects.toBeInstanceOf(ObjectStoreUnconfigured);
  });
});

describe('objectStoreFor', () => {
  const CREDENTIALS = {
    OBJECT_STORE_ACCESS_KEY_ID: 'id',
    OBJECT_STORE_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    OBJECT_STORE_SECRET_ACCESS_KEY: 'secret',
  };

  function bucketOf(store: ObjectStorePort): string {
    return (store as unknown as { bucket: string }).bucket;
  }

  it('binds R2 when the four variables are set and the stand-in otherwise', () => {
    const configured = new ConfigService<Environment, true>({
      ...CREDENTIALS,
      OBJECT_STORE_BUCKET_REPOS: 'repos',
    });

    expect(objectStoreFor(configured, 'repos')).toBeInstanceOf(R2ObjectStore);
    expect(objectStoreFor(new ConfigService<Environment, true>({}), 'repos')).toBeInstanceOf(
      UnconfiguredObjectStore,
    );
  });

  it('reads the bucket the caller names: repos or artifacts', () => {
    const configured = new ConfigService<Environment, true>({
      ...CREDENTIALS,
      OBJECT_STORE_BUCKET_ARTIFACTS: 'forge-artifacts',
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
    });

    expect(bucketOf(objectStoreFor(configured, 'repos'))).toBe('forge-repos');
    expect(bucketOf(objectStoreFor(configured, 'artifacts'))).toBe('forge-artifacts');
  });

  it('binds the stand-in when the named bucket alone is missing', () => {
    const reposOnly = new ConfigService<Environment, true>({
      ...CREDENTIALS,
      OBJECT_STORE_BUCKET_REPOS: 'forge-repos',
    });

    expect(objectStoreFor(reposOnly, 'repos')).toBeInstanceOf(R2ObjectStore);
    expect(objectStoreFor(reposOnly, 'artifacts')).toBeInstanceOf(UnconfiguredObjectStore);
  });
});
