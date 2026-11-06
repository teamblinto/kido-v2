import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ObjectStorePort } from './object-store.port';

const missing = (error: unknown): boolean => (error as { code?: unknown }).code === 'ENOENT';

/**
 * The store on a directory, for a single host with no bucket (`OBJECT_STORE_DIR`): one file per
 * key plus its metadata, each written to a temporary name and renamed, so a crash mid-PUT leaves
 * the previous object whole. The directory must be a persistent volume.
 */
export class FsObjectStore implements ObjectStorePort {
  constructor(private readonly root: string) {}

  /** One flat file per key: the encoding leaves no separator for a key to climb out with. */
  private path(key: string): string {
    return join(this.root, encodeURIComponent(key));
  }

  private async replace(path: string, body: Buffer | string): Promise<void> {
    const temporary = `${path}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, path);
  }

  async put(key: string, body: Buffer, meta: Readonly<Record<string, string>>): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.replace(this.path(key), body);
    await this.replace(`${this.path(key)}.meta`, JSON.stringify(meta));
  }

  async get(key: string): Promise<{ body: Buffer; meta: Record<string, string> } | null> {
    const head = await this.head(key);
    return head === null ? null : { body: await readFile(this.path(key)), meta: head.meta };
  }

  async head(key: string): Promise<{ meta: Record<string, string> } | null> {
    try {
      const raw = await readFile(`${this.path(key)}.meta`, 'utf8');
      return { meta: JSON.parse(raw) as Record<string, string> };
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
    await rm(`${this.path(key)}.meta`, { force: true });
  }
}
