import type { ObjectStorePort } from './object-store.port';

/** An `ObjectStorePort` in a `Map` — the specs' store, and the shape a local fallback takes. */
export class MemoryObjectStore implements ObjectStorePort {
  readonly objects = new Map<string, { body: Buffer; meta: Record<string, string> }>();

  put(key: string, body: Buffer, meta: Readonly<Record<string, string>>): Promise<void> {
    this.objects.set(key, { body: Buffer.from(body), meta: { ...meta } });
    return Promise.resolve();
  }

  get(key: string): Promise<{ body: Buffer; meta: Record<string, string> } | null> {
    const object = this.objects.get(key);
    return Promise.resolve(
      object ? { body: Buffer.from(object.body), meta: { ...object.meta } } : null,
    );
  }

  head(key: string): Promise<{ meta: Record<string, string> } | null> {
    const object = this.objects.get(key);
    return Promise.resolve(object ? { meta: { ...object.meta } } : null);
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }
}
