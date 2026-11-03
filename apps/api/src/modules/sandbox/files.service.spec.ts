import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantTransaction } from '../../database/database.types';
import { FilesService } from './files.service';
import { SandboxGuardError } from './sandbox.errors';
import type { FileEntry, MutationContext, SandboxPort, SandboxRef } from './sandbox.port';
import type { SandboxLifecycle, SandboxLifecycleService } from './sandbox-lifecycle';

const orgId = randomUUID();
const projectId = randomUUID();
const ref: SandboxRef = { orgId, projectId };
const tx = {} as TenantTransaction;
const headId = randomUUID();

/** The nil uuid the read answers with when the project has no checkpoint yet (spec 024). */
const NO_BASE = '00000000-0000-0000-0000-000000000000';

/**
 * Enough of a drizzle select to answer `read`'s one query: the head checkpoint's id, on the
 * request's own transaction. Every builder method returns the chain, and awaiting it yields the
 * rows — one row for a project with a history, none for a project without.
 */
function txWithHead(rows: { id: string }[]): {
  select: ReturnType<typeof vi.fn>;
  tx: TenantTransaction;
} {
  const chain = {
    from: () => chain,
    limit: () => Promise.resolve(rows),
    orderBy: () => chain,
    where: () => chain,
  };
  const select = vi.fn(() => chain);

  return { select, tx: { select } as unknown as TenantTransaction };
}

/** A member's own read: no lease to fence, the operation named after the route (contract § 3). */
const WAKE_CTX: MutationContext = { leaseEpoch: 0, operationId: 'files/wake' };

/**
 * The files service (spec 022, contracts/files.md § 1–3) over stubs for the two collaborators it
 * has: `SANDBOX_PORT` for the working tree and `SandboxLifecycleService` for the wake. The jail,
 * the caps and the readiness matrix are the collaborators' own proven business — what is asserted
 * here is the mapping: the union `read` answers with, and the flattening `wake` answers with.
 */
describe('FilesService', () => {
  let entries: Map<string, readonly FileEntry[]>;
  let files: Map<string, string | Error>;
  let readiness: Awaited<ReturnType<SandboxLifecycle['ensureReady']>>;
  let ensureReady: ReturnType<typeof vi.fn>;
  let service: FilesService;

  beforeEach(() => {
    entries = new Map();
    files = new Map();
    readiness = { ready: true };
    ensureReady = vi.fn(() => Promise.resolve(readiness));

    const port = {
      list: vi.fn((_ref: SandboxRef, path: string) => Promise.resolve(entries.get(path) ?? [])),
      read: vi.fn((_ref: SandboxRef, path: string) => {
        const answer = files.get(path);
        if (answer === undefined) {
          return Promise.reject(new SandboxGuardError('path-not-found', 'No such path.'));
        }
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      }),
    } as unknown as SandboxPort;

    service = new FilesService(port, { ensureReady } as unknown as SandboxLifecycleService);
  });

  describe('list', () => {
    it('maps the port entries through, name-sorted as the port returns them', async () => {
      entries.set('src', [
        { kind: 'directory', name: 'lib', size: 4096 },
        { kind: 'file', name: 'main.ts', size: 12 },
        { kind: 'link', name: 'shortcut', size: 0 },
      ]);

      await expect(service.list(ref, 'src')).resolves.toStrictEqual({
        entries: [
          { kind: 'directory', name: 'lib', size: 4096 },
          { kind: 'file', name: 'main.ts', size: 12 },
          { kind: 'link', name: 'shortcut', size: 0 },
        ],
        path: 'src',
      });
    });

    it('answers the empty root as an empty list, not a refusal', async () => {
      await expect(service.list(ref, '')).resolves.toStrictEqual({ entries: [], path: '' });
    });

    it('lets a guard refusal through untouched', async () => {
      const refusal = new SandboxGuardError('sandbox-not-ready', 'The workspace is waking.', {
        state: 'hibernated',
      });
      entries = new Map();
      const port = {
        list: vi.fn(() => Promise.reject(refusal)),
      } as unknown as SandboxPort;
      service = new FilesService(port, { ensureReady } as unknown as SandboxLifecycleService);

      await expect(service.list(ref, 'src')).rejects.toBe(refusal);
    });
  });

  describe('read', () => {
    let readTx: TenantTransaction;

    beforeEach(() => {
      readTx = txWithHead([{ id: headId }]).tx;
    });

    it('answers renderable text with its byte length', async () => {
      files.set('src/main.ts', 'const a = 1;\n');

      await expect(service.read(readTx, ref, 'src/main.ts')).resolves.toStrictEqual({
        baseCheckpointId: headId,
        bytes: 13,
        content: 'const a = 1;\n',
        path: 'src/main.ts',
        renderable: true,
      });
    });

    it('counts bytes, not characters, for multi-byte text', async () => {
      files.set('note.md', 'héllo');

      await expect(service.read(readTx, ref, 'note.md')).resolves.toStrictEqual({
        baseCheckpointId: headId,
        bytes: 6,
        content: 'héllo',
        path: 'note.md',
        renderable: true,
      });
    });

    it('answers binary when a NUL is in the first 8 KiB, sized from a list of the parent', async () => {
      files.set('src/logo.png', `PNG${'\u0000'}IHDR`);
      entries.set('src', [{ kind: 'file', name: 'logo.png', size: 2048 }]);

      await expect(service.read(readTx, ref, 'src/logo.png')).resolves.toStrictEqual({
        bytes: 2048,
        path: 'src/logo.png',
        reason: 'binary',
        renderable: false,
      });
    });

    it('sizes a binary file at the root from a list of the root', async () => {
      files.set('logo.png', `\u0000`);
      entries.set('', [{ kind: 'file', name: 'logo.png', size: 9 }]);

      await expect(service.read(readTx, ref, 'logo.png')).resolves.toMatchObject({
        bytes: 9,
        reason: 'binary',
        renderable: false,
      });
    });

    it('leaves a NUL past the first 8 KiB unsniffed, so the file stays renderable', async () => {
      const content = `${'a'.repeat(8192)}${'\u0000'}`;
      files.set('big.txt', content);

      await expect(service.read(readTx, ref, 'big.txt')).resolves.toMatchObject({
        renderable: true,
      });
    });

    it("answers too-large on the port's file-too-large, sized from a list of the parent", async () => {
      files.set(
        'src/bundle.js',
        new SandboxGuardError('file-too-large', 'The file is over the cap.'),
      );
      entries.set('src', [{ kind: 'file', name: 'bundle.js', size: 4_194_304 }]);

      await expect(service.read(readTx, ref, 'src/bundle.js')).resolves.toStrictEqual({
        bytes: 4_194_304,
        path: 'src/bundle.js',
        reason: 'too-large',
        renderable: false,
      });
    });

    it('sizes an unlistable file at zero rather than refusing', async () => {
      files.set('gone.bin', new SandboxGuardError('file-too-large', 'The file is over the cap.'));

      await expect(service.read(readTx, ref, 'gone.bin')).resolves.toMatchObject({
        bytes: 0,
        reason: 'too-large',
      });
    });

    it('names the project head as the base a save will be compared against', async () => {
      files.set('src/main.ts', 'const a = 1;\n');

      await expect(service.read(readTx, ref, 'src/main.ts')).resolves.toMatchObject({
        baseCheckpointId: headId,
        renderable: true,
      });
    });

    it('answers the nil uuid as the base when the project has no checkpoint yet', async () => {
      files.set('src/main.ts', 'const a = 1;\n');

      await expect(service.read(txWithHead([]).tx, ref, 'src/main.ts')).resolves.toMatchObject({
        baseCheckpointId: NO_BASE,
        renderable: true,
      });
    });

    it('reads no head for an unrenderable file — it has no base because it cannot be saved', async () => {
      files.set('src/logo.png', `PNG${'\u0000'}IHDR`);
      entries.set('src', [{ kind: 'file', name: 'logo.png', size: 2048 }]);
      const quiet = txWithHead([{ id: headId }]);

      await expect(service.read(quiet.tx, ref, 'src/logo.png')).resolves.not.toHaveProperty(
        'baseCheckpointId',
      );
      expect(quiet.select).not.toHaveBeenCalled();
    });

    it('lets a sandbox-not-ready guard error through untouched', async () => {
      const refusal = new SandboxGuardError('sandbox-not-ready', 'The workspace is waking.', {
        state: 'hibernated',
      });
      files.set('src/main.ts', refusal);

      await expect(service.read(readTx, ref, 'src/main.ts')).rejects.toBe(refusal);
    });

    it('lets every other guard error through untouched', async () => {
      const refusal = new SandboxGuardError('not-a-file', 'That is a directory.');
      files.set('src', refusal);

      await expect(service.read(readTx, ref, 'src')).rejects.toBe(refusal);
    });
  });

  describe('wake', () => {
    it("flattens ensureReady's ready answer with a null because", async () => {
      readiness = { ready: true };

      await expect(service.wake(tx, ref)).resolves.toStrictEqual({ because: null, ready: true });
      expect(ensureReady).toHaveBeenCalledWith(tx, ref, WAKE_CTX);
    });

    it('flattens the not-ready answer with its reason', async () => {
      readiness = { because: 'resuming', ready: false };

      await expect(service.wake(tx, ref)).resolves.toStrictEqual({
        because: 'resuming',
        ready: false,
      });
    });

    it('lets a no-sandbox guard error through untouched', async () => {
      const refusal = new SandboxGuardError('no-sandbox', 'No sandbox for this project.');
      ensureReady.mockRejectedValue(refusal);

      await expect(service.wake(tx, ref)).rejects.toBe(refusal);
    });
  });
});
