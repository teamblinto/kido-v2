import { describe, expect, it } from 'vitest';

import { MemoryObjectStore } from './memory-object-store';

describe('MemoryObjectStore', () => {
  it('put stores body and meta; head answers the meta, get both; a miss is null', async () => {
    const store = new MemoryObjectStore();
    expect(await store.head('repos/p')).toBeNull();
    expect(await store.get('repos/p')).toBeNull();

    await store.put('repos/p', Buffer.from('bundle'), { head: 'a'.repeat(40) });
    expect(await store.head('repos/p')).toEqual({ meta: { head: 'a'.repeat(40) } });
    const got = await store.get('repos/p');
    expect(got?.body.toString()).toBe('bundle');
    expect(got?.meta).toEqual({ head: 'a'.repeat(40) });
  });

  it('a later put replaces the object; delete removes it', async () => {
    const store = new MemoryObjectStore();
    await store.put('k', Buffer.from('one'), { head: '1' });
    await store.put('k', Buffer.from('two'), { head: '2' });
    expect((await store.get('k'))?.body.toString()).toBe('two');
    await store.delete('k');
    expect(await store.head('k')).toBeNull();
  });
});
