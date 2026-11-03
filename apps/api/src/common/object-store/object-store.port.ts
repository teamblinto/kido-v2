/**
 * Why this lives in `common/` (spec 027 research R7): two modules now need an object store over
 * two buckets. `checkpoints` mirrors each project's repository into the repos bucket, and
 * `deploy` writes built site artifacts into the artifacts bucket. The port, the R2 adapter and
 * the in-memory stand-in are infrastructure with no domain in them, so they sit below the
 * modules, and each module binds its own instance with `objectStoreFor(config, bucket)`.
 *
 * Rejected: exporting `OBJECT_STORE` from `checkpoints` for `deploy` to import. That would make
 * `deploy` depend on `checkpoints`' provider (and its bucket) for plumbing, not domain, and one
 * token cannot name two buckets. Rejected too: a second, deploy-only adapter, which would be a
 * copy of this one differing in the bucket name alone.
 *
 * The store itself (contracts/checkpoints.md § 7, research R8): one object per key, PUT whole,
 * with string metadata beside it. `CheckpointsModule` binds the repos bucket under
 * `OBJECT_STORE`.
 */
export const OBJECT_STORE = Symbol('forge.object-store');

export interface ObjectStorePort {
  put(key: string, body: Buffer, meta: Readonly<Record<string, string>>): Promise<void>;
  get(key: string): Promise<{ body: Buffer; meta: Record<string, string> } | null>;
  head(key: string): Promise<{ meta: Record<string, string> } | null>;
  delete(key: string): Promise<void>;
}

/** The store is not configured (§ 7, FR-024): the mirror consumer warns and skips under `local`. */
export class ObjectStoreUnconfigured extends Error {
  constructor() {
    super('the object store is not configured: set the four OBJECT_STORE_* variables');
    this.name = 'ObjectStoreUnconfigured';
  }
}

/** Bound under `DEPLOY_ENV=local` without the `OBJECT_STORE_*` variables; every call throws. */
export class UnconfiguredObjectStore implements ObjectStorePort {
  put(): Promise<void> {
    return Promise.reject(new ObjectStoreUnconfigured());
  }

  get(): Promise<never> {
    return Promise.reject(new ObjectStoreUnconfigured());
  }

  head(): Promise<never> {
    return Promise.reject(new ObjectStoreUnconfigured());
  }

  delete(): Promise<void> {
    return Promise.reject(new ObjectStoreUnconfigured());
  }
}
