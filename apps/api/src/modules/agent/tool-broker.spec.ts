import type { RunConfig, RunConfigInput } from '@repo/contracts';
import { z } from 'zod';

import {
  DaytonaError,
  type DaytonaErrorKind,
  SandboxGuardError,
  type SandboxGuardKind,
} from '../sandbox/sandbox.errors';
import type {
  ContentMatch,
  Edit,
  EditResult,
  ExecResult,
  FileEntry,
  MutationContext,
  PreviewStatus,
  SandboxPort,
  SandboxRef,
} from '../sandbox/sandbox.port';
import { FencedError } from './run-store';
import { ToolBroker } from './tool-broker';
import { TOOLS, type ToolName } from './tools';

const REF: SandboxRef = { orgId: 'org_1', projectId: 'proj_1' };
const CTX: MutationContext = { leaseEpoch: 3, operationId: 'run_1/1' };

const GUARD_KINDS: readonly SandboxGuardKind[] = [
  'path-escape',
  'path-not-found',
  'not-a-file',
  'file-too-large',
  'anchor-not-found',
  'anchor-ambiguous',
  'command-not-allowed',
  'missing-mutation-context',
  'no-sandbox',
];

const DAYTONA_KINDS: readonly DaytonaErrorKind[] = [
  'not-configured',
  'unreachable',
  'unauthorised',
  'sandbox-not-found',
  'sandbox-not-running',
  'upstream',
  'malformed',
];

/** Record-and-answer fake: every method records its call and returns (or throws) the one answer. */
class FakePort implements SandboxPort {
  readonly calls: { method: string; args: unknown[] }[] = [];
  answer: unknown = '';

  private reply<T>(method: string, args: unknown[]): Promise<T> {
    this.calls.push({ args, method });
    if (this.answer instanceof Error) return Promise.reject(this.answer);
    return Promise.resolve(this.answer as T);
  }

  read(ref: SandboxRef, path: string, ctx?: MutationContext): Promise<string> {
    return this.reply('read', [ref, path, ctx]);
  }

  upload(ref: SandboxRef, path: string, body: Buffer, ctx: MutationContext): Promise<void> {
    return this.reply('upload', [ref, path, body, ctx]);
  }

  download(ref: SandboxRef, path: string, ctx: MutationContext): Promise<Buffer> {
    return this.reply('download', [ref, path, ctx]);
  }

  list(ref: SandboxRef, path: string, ctx?: MutationContext): Promise<readonly FileEntry[]> {
    return this.reply('list', [ref, path, ctx]);
  }

  edit(ref: SandboxRef, edit: Edit, ctx: MutationContext): Promise<EditResult> {
    return this.reply('edit', [ref, edit, ctx]);
  }

  exec(ref: SandboxRef, command: string, ctx: MutationContext): Promise<ExecResult> {
    return this.reply('exec', [ref, command, ctx]);
  }

  search(
    ref: SandboxRef,
    query: { readonly text: string; readonly path?: string },
    ctx?: MutationContext,
  ): Promise<readonly ContentMatch[]> {
    return this.reply('search', [ref, query, ctx]);
  }

  find(
    ref: SandboxRef,
    query: { readonly glob: string; readonly path?: string },
    ctx?: MutationContext,
  ): Promise<readonly string[]> {
    return this.reply('find', [ref, query, ctx]);
  }

  previewStatus(ref: SandboxRef, ctx?: MutationContext): Promise<PreviewStatus> {
    return this.reply('previewStatus', [ref, ctx]);
  }

  previewLogs(ref: SandboxRef, ctx?: MutationContext): Promise<string> {
    return this.reply('previewLogs', [ref, ctx]);
  }

  setRunConfig(
    ref: SandboxRef,
    input: RunConfigInput,
    ctx: MutationContext,
    actorId: string | null,
  ): Promise<RunConfig> {
    return this.reply('setRunConfig', [ref, input, ctx, actorId]);
  }
}

const passThrough = <T>(fn: () => Promise<T>): Promise<T> => fn();

function broker(allowed: readonly ToolName[], port = new FakePort()) {
  return { broker: new ToolBroker(TOOLS, new Set(allowed), port, REF), port };
}

describe('ToolBroker', () => {
  describe('definitions', () => {
    it('definitions lists exactly the allowed tools in a fixed order', () => {
      // Allowed in the "wrong" order: the output follows TOOLS' order, not the set's.
      const { broker: b } = broker(['find', 'fs_edit', 'fs_read']);
      expect(b.definitions().map((d) => d.name)).toEqual(['fs_read', 'fs_edit', 'find']);
    });

    it('definitions equals z.toJSONSchema of each input', () => {
      const { broker: b } = broker(TOOLS.map((t) => t.name));
      for (const definition of b.definitions()) {
        const spec = TOOLS.find((t) => t.name === definition.name);
        expect(spec).toBeDefined();
        expect(definition.description).toBe(spec?.description);
        expect(definition.inputSchema).toEqual(z.toJSONSchema(spec!.input));
      }
    });

    it('definitions is byte-identical on every call', () => {
      const { broker: b } = broker(['fs_read', 'exec']);
      const first = b.definitions();
      const second = b.definitions();
      expect(second).toBe(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });
  });

  describe('handle', () => {
    it('refuses a tool outside the allowlist without calling the port', async () => {
      const { broker: b, port } = broker(['fs_read']);
      await expect(
        b.handle({ input: { command: 'ls' }, name: 'exec' }, CTX, passThrough),
      ).resolves.toEqual({
        detail: 'tool exec is not available in this run',
        kind: 'not-allowed',
        ok: false,
      });
      await expect(b.handle({ input: {}, name: 'rm_rf' }, CTX, passThrough)).resolves.toEqual({
        detail: 'tool rm_rf is not available in this run',
        kind: 'not-allowed',
        ok: false,
      });
      expect(port.calls).toEqual([]);
    });

    it.each([
      ['missing field', 'fs_read', {}],
      ['extra field', 'fs_read', { extra: 1, path: 'a.ts' }],
      ['wrong type', 'exec', { command: 42 }],
      ['a truncated object', 'fs_edit', { path: 'a.ts', search: 'x' }],
    ] as const)(
      'refuses an input that fails the schema before the port (%s)',
      async (_label, name, input) => {
        const { broker: b, port } = broker(TOOLS.map((t) => t.name));
        const result = await b.handle({ input, name }, CTX, passThrough);
        expect(result).toMatchObject({ kind: 'invalid-input', ok: false });
        expect(result.ok === false && result.detail.length > 0).toBe(true);
        expect(port.calls).toEqual([]);
      },
    );

    it.each(GUARD_KINDS)(
      'maps every SandboxGuardError kind to ok:false with that kind (%s)',
      async (kind) => {
        const port = new FakePort();
        port.answer = new SandboxGuardError(kind, `refused: ${kind}`);
        const { broker: b } = broker(['fs_read'], port);
        await expect(
          b.handle({ input: { path: 'a.ts' }, name: 'fs_read' }, CTX, passThrough),
        ).resolves.toEqual({ detail: `refused: ${kind}`, kind, ok: false });
        expect(port.calls).toHaveLength(1);
      },
    );

    it.each(DAYTONA_KINDS)(
      'maps every DaytonaError kind to ok:false with that kind (%s)',
      async (kind) => {
        const port = new FakePort();
        port.answer = new DaytonaError(kind, `wire: ${kind}`);
        const { broker: b } = broker(['exec'], port);
        await expect(
          b.handle({ input: { command: 'ls' }, name: 'exec' }, CTX, passThrough),
        ).resolves.toEqual({ detail: `wire: ${kind}`, kind, ok: false });
        expect(port.calls).toHaveLength(1);
      },
    );

    it('rethrows FencedError from run', async () => {
      const { broker: b, port } = broker(['fs_read']);
      const fenced = new FencedError('run_1', 'heartbeat', 3);
      const run = <T>(_fn: () => Promise<T>): Promise<T> => Promise.reject(fenced);
      await expect(b.handle({ input: { path: 'a.ts' }, name: 'fs_read' }, CTX, run)).rejects.toBe(
        fenced,
      );
      expect(port.calls).toEqual([]);
    });

    it('rethrows an unknown error', async () => {
      const port = new FakePort();
      const boom = new TypeError('bug');
      port.answer = boom;
      const { broker: b } = broker(['fs_read'], port);
      await expect(
        b.handle({ input: { path: 'a.ts' }, name: 'fs_read' }, CTX, passThrough),
      ).rejects.toBe(boom);
    });

    it('answers ok with output and patch on success', async () => {
      const port = new FakePort();
      const diff = '--- a/x\n+++ b/x\n@@\n-a\n+b\n';
      port.answer = { bytes: 1, diff } satisfies EditResult;
      const { broker: b } = broker(['fs_edit'], port);
      const input = { content: 'b', path: 'x' };
      const ran: unknown[] = [];
      const run = async <T>(fn: () => Promise<T>): Promise<T> => {
        ran.push('dispatch');
        return fn();
      };
      await expect(b.handle({ input, name: 'fs_edit' }, CTX, run)).resolves.toEqual({
        ok: true,
        output: diff,
        patch: { diff, path: 'x' },
      });
      expect(ran).toEqual(['dispatch']);
      expect(port.calls).toEqual([{ args: [REF, input, CTX], method: 'edit' }]);

      port.answer = 'text';
      const { broker: reader } = broker(['fs_read'], port);
      await expect(
        reader.handle({ input: { path: 'a.ts' }, name: 'fs_read' }, CTX, passThrough),
      ).resolves.toEqual({ ok: true, output: 'text' });
    });
  });

  /** Spec 023 FR-022: the seventh tool is brokered like the other six, and refused like them. */
  describe('preview_status (023)', () => {
    it('refuses it as not-allowed when it is outside the run profile, without calling the port', async () => {
      const { broker: b, port } = broker(['fs_read', 'find']);

      await expect(
        b.handle({ input: {}, name: 'preview_status' }, CTX, passThrough),
      ).resolves.toEqual({
        detail: 'tool preview_status is not available in this run',
        kind: 'not-allowed',
        ok: false,
      });
      expect(b.definitions().map((d) => d.name)).not.toContain('preview_status');
      expect(port.calls).toEqual([]);
    });

    it('refuses it at the fence when the lease is lost, before the port is reached', async () => {
      const { broker: b, port } = broker(['preview_status']);
      const fenced = new FencedError('run_1', 'heartbeat', 3);
      const run = <T>(_fn: () => Promise<T>): Promise<T> => Promise.reject(fenced);

      await expect(b.handle({ input: {}, name: 'preview_status' }, CTX, run)).rejects.toBe(fenced);
      expect(port.calls).toEqual([]);
    });

    it('answers ok through the fence when the run allows it', async () => {
      const port = new FakePort();
      port.answer = { observed: null, port: 3000 } satisfies PreviewStatus;
      const { broker: b } = broker(['preview_status'], port);

      await expect(
        b.handle({ input: {}, name: 'preview_status' }, CTX, passThrough),
      ).resolves.toEqual({ ok: true, output: 'port 3000: not observed yet' });
      expect(port.calls).toEqual([{ args: [REF, CTX], method: 'previewStatus' }]);
    });
  });

  it('cannot be widened after construction', async () => {
    const allowed = new Set<ToolName>(['fs_read']);
    const { broker: b, port } = broker([...allowed]);
    allowed.add('exec');

    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.getOwnPropertyNames(ToolBroker.prototype).sort()).toEqual([
      'constructor',
      'definitions',
      'handle',
    ]);
    expect(b.definitions().map((d) => d.name)).toEqual(['fs_read']);
    await expect(
      b.handle({ input: { command: 'ls' }, name: 'exec' }, CTX, passThrough),
    ).resolves.toMatchObject({ kind: 'not-allowed', ok: false });
    expect(port.calls).toEqual([]);
  });
});
