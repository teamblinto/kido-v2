import { MAX_IMAGE_ATTACHMENT_BYTES } from '@repo/contracts';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeClock } from '../../../common/clock/fake-clock';
import { MemoryObjectStore } from '../../../common/object-store/memory-object-store';
import type { TenantContext } from '../../../database/tenant-context';
import type { ProjectService } from '../../tenancy/services/project.service';
import {
  AttachmentNotFoundError,
  AttachmentRejectedError,
  AttachmentTooLargeError,
} from './attachment.errors';
import { AttachmentService, MAX_PENDING_ATTACHMENTS } from './attachment.service';

const START = '2026-11-16T10:00:00.000Z';
const ORG = 'e1000000-0000-4000-8000-000000000001';
const PROJECT = 'e1000000-0000-4000-8000-000000000002';
const USER = 'e1000000-0000-4000-8000-000000000003';

/** A body of `total` bytes in 64 KiB chunks, counting what was pulled from it. */
function body(total: number, first = Buffer.alloc(0)): Readable & { pulled: number } {
  let sent = 0;
  const stream = new Readable({
    read(): void {
      if (sent >= total) {
        this.push(null);
        return;
      }
      const chunk = sent === 0 && first.length > 0 ? first : Buffer.alloc(64 * 1024);
      sent += chunk.length;
      stream.pulled = sent;
      this.push(chunk);
    },
  }) as Readable & { pulled: number };
  stream.pulled = 0;
  return stream;
}

describe('AttachmentService.upload', () => {
  let store: MemoryObjectStore;
  let insert: ReturnType<typeof vi.fn>;
  let pending: number;
  let service: AttachmentService;
  let calls: string[];

  beforeEach(() => {
    store = new MemoryObjectStore();
    pending = 0;
    calls = [];
    insert = vi.fn(() => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => Promise.resolve([{ ...values, createdAt: new Date(START) }]),
      }),
    }));
    const tx = {
      execute: vi.fn(() => {
        calls.push('lock');
        return Promise.resolve({ rows: [] });
      }),
      insert,
      select: () => ({
        from: () => ({
          where: () => {
            calls.push('count');
            return Promise.resolve([{ total: pending }]);
          },
        }),
      }),
    };
    service = new AttachmentService(
      { tx } as unknown as TenantContext,
      { runInTenantScope: (_scope: unknown, fn: () => Promise<unknown>) => fn() } as never,
      {} as never,
      store,
      { read: vi.fn(() => Promise.resolve({})) } as unknown as ProjectService,
      new FakeClock(START),
    );
  });

  /** SC-2. */
  it('cuts an upload off past its cap and stores nothing', async () => {
    const png = body(20 * 1024 * 1024, Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'));

    await expect(service.upload(ORG, PROJECT, USER, 'big.png', png)).rejects.toBeInstanceOf(
      AttachmentTooLargeError,
    );
    expect(png.pulled).toBeLessThan(MAX_IMAGE_ATTACHMENT_BYTES + 512 * 1024);
    expect(png.isPaused()).toBe(true);
    expect(store.objects.size).toBe(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses a declared length past the cap without reading the body', async () => {
    const png = body(1024);

    await expect(
      service.upload(ORG, PROJECT, USER, 'big.png', png, MAX_IMAGE_ATTACHMENT_BYTES + 1),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(png.pulled).toBe(0);
  });

  it('refuses an extension off the allowlist before reading the body', async () => {
    const exe = body(1024);

    await expect(service.upload(ORG, PROJECT, USER, 'setup.exe', exe)).rejects.toBeInstanceOf(
      AttachmentRejectedError,
    );
    expect(exe.pulled).toBe(0);
  });

  it('refuses past the pending cap, storing nothing', async () => {
    pending = MAX_PENDING_ATTACHMENTS;

    await expect(
      service.upload(ORG, PROJECT, USER, 'a.txt', Readable.from([Buffer.from('hi')])),
    ).rejects.toMatchObject({ extensions: { reason: 'too-many-pending' } });
    expect(store.objects.size).toBe(0);
    // The project's advisory lock is taken before counting, so concurrent uploads count in turn.
    expect(calls).toEqual(['lock', 'count']);
  });

  it('stores a verified file under its tenant key with its hash, and answers the wire shape', async () => {
    const bytes = Buffer.from('# Notes\n');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const attachment = await service.upload(ORG, PROJECT, USER, 'notes.md', Readable.from([bytes]));

    expect(attachment).toEqual({
      createdAt: START,
      id: expect.any(String) as string,
      kind: 'text',
      mimeType: 'text/markdown',
      name: 'notes.md',
      sizeBytes: bytes.length,
    });
    expect(store.objects.get(`attachments/${ORG}/${PROJECT}/${attachment.id}`)).toEqual({
      body: bytes,
      meta: { kind: 'text', sha256 },
    });
  });
});

describe('AttachmentService.link', () => {
  const ID = 'e1000000-0000-4000-8000-0000000000a1';

  function linking(insertError?: Error): {
    forCalls: string[];
    service: AttachmentService;
    tx: unknown;
  } {
    const forCalls: string[] = [];
    const tx = {
      insert: () => ({
        values: () => (insertError === undefined ? Promise.resolve() : Promise.reject(insertError)),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            for: (strength: string) => {
              forCalls.push(strength);
              return Promise.resolve([{ id: ID }]);
            },
          }),
        }),
      }),
    };
    const service = new AttachmentService(
      {} as never,
      {} as never,
      {} as never,
      new MemoryObjectStore(),
      {} as never,
      new FakeClock(START),
    );
    return { forCalls, service, tx };
  }

  it('share-locks the files it links', async () => {
    const { forCalls, service, tx } = linking();

    await service.link(tx as never, ORG, PROJECT, 'm1', [ID]);

    expect(forCalls).toEqual(['share']);
  });

  it('answers attachment-not-found when the insert hits a foreign key violation', async () => {
    const { service, tx } = linking(new Error('wrapped', { cause: { code: '23503' } }));

    await expect(service.link(tx as never, ORG, PROJECT, 'm1', [ID])).rejects.toBeInstanceOf(
      AttachmentNotFoundError,
    );
  });
});

describe('AttachmentService.sweep', () => {
  it('deletes only rows still unlinked on re-check, and their objects only after commit', async () => {
    const store = new MemoryObjectStore();
    await store.put('k-gone', Buffer.from('a'), {});
    await store.put('k-linked', Buffer.from('b'), {});
    const order: string[] = [];
    const deleteObject = store.delete.bind(store);
    vi.spyOn(store, 'delete').mockImplementation((key: string) => {
      order.push(`object ${key}`);
      return deleteObject(key);
    });
    const tx = {
      delete: () => ({
        where: () => ({
          // The re-check: 'linked' gained a link while the lock waited, so only 'gone' goes.
          returning: () => {
            order.push('rows');
            return Promise.resolve([{ objectKey: 'k-gone' }]);
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ for: () => Promise.resolve([{ id: 'gone' }, { id: 'linked' }]) }),
        }),
      }),
    };
    const bypass = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                { id: 'gone', orgId: ORG },
                { id: 'linked', orgId: ORG },
              ]),
          }),
        }),
      }),
    };
    const transactions = {
      runInTenantTransaction: async (_org: string, fn: (t: unknown) => Promise<unknown>) => {
        const result = await fn(tx);
        order.push('commit');
        return result;
      },
    };
    const service = new AttachmentService(
      {} as never,
      transactions as never,
      bypass as never,
      store,
      {} as never,
      new FakeClock(START),
    );

    await expect(service.sweep()).resolves.toBe(1);
    expect(order).toEqual(['rows', 'commit', 'object k-gone']);
    expect([...store.objects.keys()]).toEqual(['k-linked']);
  });
});
