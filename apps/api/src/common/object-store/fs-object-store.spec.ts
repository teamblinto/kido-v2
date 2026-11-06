import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsObjectStore } from './fs-object-store';

describe('FsObjectStore', () => {
  let root: string;
  let store: FsObjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-store-'));
    store = new FsObjectStore(join(root, 'not-yet-there'));
  });

  afterEach(() => rm(root, { force: true, recursive: true }));

  it('answers null for a key it has never held', async () => {
    expect(await store.get('org/project.git')).toBeNull();
    expect(await store.head('org/project.git')).toBeNull();
  });

  it('returns what was put, and a second put replaces it whole', async () => {
    await store.put('org/project.git', Buffer.from('one'), { head: 'a' });
    await store.put('org/project.git', Buffer.from('two'), { head: 'b' });

    const object = await store.get('org/project.git');

    expect(object?.body.toString()).toBe('two');
    expect(object?.meta).toEqual({ head: 'b' });
    expect(await store.head('org/project.git')).toEqual({ meta: { head: 'b' } });
  });

  it('keeps a key inside its root, and delete leaves nothing behind', async () => {
    await store.put('../../escape', Buffer.from('x'), {});

    expect(await readdir(root)).toEqual(['not-yet-there']);

    await store.delete('../../escape');
    await store.delete('../../escape');

    expect(await readdir(join(root, 'not-yet-there'))).toEqual([]);
  });
});
